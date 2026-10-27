import { createHash, randomUUID } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type DatabaseProvider, type RawAccess } from "rivetkit/db";
import type {
  JobSnapshot,
  JobSubmission,
  JobVideo,
  OperationContext,
  PipelineSettings,
  ResourceLimits,
  VideoResult,
} from "../../application/contracts.js";
import { resolveSettings } from "../../application/settings.js";
import { RequestService } from "../../application/jobs/RequestService.js";
import { RequestCoordinator } from "../../application/jobs/RequestCoordinator.js";
import { VideoJobService } from "../../application/jobs/VideoJobService.js";
import {
  SubmissionPolicy,
  canonicalJobValue,
} from "../../application/jobs/submission.js";
import type {
  JobRequestRecord,
  VideoInitialization,
  VideoJobStatus,
} from "../../application/jobs/model.js";
import type {
  RequestRuntime,
  VideoJobControl,
  VideoRuntime,
} from "../../application/jobs/ports.js";
import {
  RivetRequestRepository,
  RivetVideoRepository,
} from "./JobRepositories.js";
import {
  assertInferenceReady,
  resolveInferenceSettings,
  type InferenceSettingsInput,
  type StructuredModelGateway,
} from "../../application/model.js";
import { PipelineError, asPipelineError } from "../../core/errors.js";
import { NodeMediaProcessor } from "../node/NodeMediaProcessor.js";
import { NodeTranscriber } from "../node/NodeTranscriber.js";
import { NodeSourceCatalog } from "../node/NodeSourceCatalog.js";
import type { NativeRuntimeOptions } from "../node/runtime.js";
import {
  RunnerAdmission,
  type RuntimeConcurrencyPolicy,
} from "../runtime/RunnerAdmission.js";
import {
  migrateJobDatabase,
  SqliteArtifactStorage,
  SqliteDocuments,
  SqliteRunRepository,
} from "./storage.js";

const LEASE_MS = 45_000;
const LEASE_MARGIN_MS = 2_000;
const POLL_MS = 2_000;
const RETRY_MS = 5_000;
export const MAX_RANGE_BYTES = 128 * 1024;
let nativeOptions: NativeRuntimeOptions = { stagingRoot: "/tmp/scrub" };
let concurrencyPolicy: RuntimeConcurrencyPolicy = {
  requestDefault: 1,
  runnerLimit: 2,
};
let runnerAdmission = new RunnerAdmission(concurrencyPolicy.runnerLimit);
let resourceCeilings: Partial<ResourceLimits> | undefined;
export function configureRivetSubmissionPolicy(configuration: {
  resourceCeilings?: Partial<ResourceLimits>;
}): void {
  const next =
    configuration.resourceCeilings === undefined
      ? undefined
      : resolveSettings({ limits: configuration.resourceCeilings }).limits;
  if (runnerAdmission.activeCount > 0)
    throw new Error(
      "Cannot reconfigure Rivet submission policy while native work is active"
    );
  resourceCeilings = next;
}
interface RivetInferenceConfiguration {
  defaults: InferenceSettingsInput;
  models?: StructuredModelGateway;
  resolveModels?: (
    context: Pick<RuntimeContext, "client" | "abortSignal">
  ) => Promise<StructuredModelGateway>;
}
let inferenceConfiguration: RivetInferenceConfiguration | undefined;

function configuredInference(): RivetInferenceConfiguration {
  if (!inferenceConfiguration)
    throw new PipelineError(
      "capability_unavailable",
      "Rivet inference policy must be configured by its deployment"
    );
  return inferenceConfiguration;
}

/** Public defaults may be persisted; models and credential loaders remain in memory. */
export function configureRivetInference(
  configuration: RivetInferenceConfiguration
): void {
  const defaults = resolveInferenceSettings(configuration.defaults)!;
  inferenceConfiguration = { ...configuration, defaults };
}

async function modelsFor(
  context: Pick<RuntimeContext, "client" | "abortSignal">,
  settings: PipelineSettings,
  preflight = true
): Promise<StructuredModelGateway | undefined> {
  if (settings.inference?.mode !== "full") return undefined;
  context.abortSignal.throwIfAborted();
  const configuration = configuredInference();
  const models = configuration.resolveModels
    ? await configuration.resolveModels(context)
    : configuration.models;
  context.abortSignal.throwIfAborted();
  if (preflight)
    assertInferenceReady(settings.inference, models, settings.skipVisuals);
  return models;
}

/** Deployment composition supplies host capabilities and secrets before start. */
export function configureRivetJobs(
  options: NativeRuntimeOptions,
  concurrency: Partial<RuntimeConcurrencyPolicy> = {},
  admission?: RunnerAdmission
): void {
  const policy: RuntimeConcurrencyPolicy = {
    requestDefault: concurrency.requestDefault ?? 1,
    runnerLimit: concurrency.runnerLimit ?? 2,
    ...(concurrency.globalLimit === undefined
      ? {}
      : { globalLimit: concurrency.globalLimit }),
  };
  if (
    !Number.isSafeInteger(policy.requestDefault) ||
    policy.requestDefault < 1 ||
    policy.requestDefault > 16
  )
    throw new RangeError(
      "Request concurrency must be an integer between 1 and 16"
    );
  if (
    policy.globalLimit !== undefined &&
    (!Number.isSafeInteger(policy.globalLimit) ||
      policy.globalLimit < 1 ||
      policy.globalLimit > 1024)
  )
    throw new RangeError(
      "Global concurrency must be an integer between 1 and 1024"
    );
  const controller = admission ?? new RunnerAdmission(policy.runnerLimit);
  if (controller.limit !== policy.runnerLimit)
    throw new RangeError(
      "Injected runner admission limit does not match deployment policy"
    );
  if (runnerAdmission.activeCount > 0 || controller.activeCount > 0)
    throw new Error(
      "Cannot reconfigure Rivet jobs while native work is active"
    );
  nativeOptions = { ...options };
  concurrencyPolicy = policy;
  runnerAdmission = controller;
}

export const jobDatabase: DatabaseProvider<RawAccess> = db({
  onMigrate: async (database) => {
    await migrateJobDatabase(database);
    await database.execute(
      "CREATE TABLE IF NOT EXISTS members (position INTEGER PRIMARY KEY, video_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL)"
    );
    await database.execute(
      "CREATE TABLE IF NOT EXISTS admission_leases (owner TEXT PRIMARY KEY, token INTEGER NOT NULL UNIQUE, expires_at INTEGER NOT NULL)"
    );
    await database.execute(
      "CREATE INDEX IF NOT EXISTS admission_expiration ON admission_leases (expires_at)"
    );
  },
});

export interface DatabaseContext {
  db: RawAccess;
}
export interface RuntimeContext extends DatabaseContext {
  key: string[];
  actorId: string;
  abortSignal: AbortSignal;
  client(): unknown;
  run: { setWakeAt(timestamp: number | null): Promise<void> };
  schedule: {
    after(
      duration: number,
      action: string,
      ...args: unknown[]
    ): Promise<string>;
  };
  keepAwake<T>(work: Promise<T>): Promise<T>;
}
export interface VideoContext extends RuntimeContext {
  vars: { active: boolean; controller: AbortController | null };
}
export interface RequestContext extends RuntimeContext {
  vars: {
    active: boolean;
    ticking: boolean;
    controller: AbortController | null;
  };
}

export interface AdmissionGrant {
  granted: boolean;
  token: number;
  expiresAt: number;
}
interface AdmissionRecord {
  owner: string | null;
  token: number;
  expiresAt: number;
  version?: 2;
  nextToken?: number;
}
interface VideoHandle {
  initialize(input: VideoInitialization): Promise<VideoJobStatus>;
  getStatus(): Promise<VideoJobStatus | null>;
  getResult(): Promise<VideoResult | null>;
  cancel(): Promise<VideoJobStatus>;
  retry(): Promise<VideoJobStatus>;
  readArtifact(
    id: string,
    offset: number,
    length: number
  ): Promise<{ data: string; mediaType: string; size: number }>;
}
interface RequestHandle {
  start(input: JobSubmission): Promise<JobSnapshot>;
  getStatus(): Promise<JobSnapshot | null>;
  getResults(
    offset: number,
    limit: number
  ): Promise<{ items: JobVideo[]; total: number }>;
  cancel(): Promise<JobSnapshot>;
  retry(): Promise<JobSnapshot>;
  hasVideo(id: string): Promise<boolean>;
}
interface AdmissionHandle {
  acquire(owner: string, capacity?: number): Promise<AdmissionGrant>;
  renew(owner: string, token: number): Promise<boolean>;
  validate(owner: string, token: number): Promise<boolean>;
  release(owner: string, token: number): Promise<void>;
}
interface Accessor<T> {
  getOrCreate(key: string[]): T;
  get(key: string[]): T;
}
export interface JobActorClient {
  scrubRequest: Accessor<RequestHandle>;
  scrubVideo: Accessor<VideoHandle>;
  scrubAdmission: Accessor<AdmissionHandle>;
}

const clientFor = (context: RuntimeContext) =>
  context.client() as JobActorClient;
const admissionFor = (context: RuntimeContext) =>
  clientFor(context).scrubAdmission.getOrCreate(["pool"]);
const videoFor = (
  context: RuntimeContext,
  requestId: string,
  videoId: string
) => clientFor(context).scrubVideo.getOrCreate([requestId, videoId]);
const terminal = (status: string) =>
  [
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
    "skipped",
  ].includes(status);

async function expose<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const failure = asPipelineError(error);
    throw new UserError(failure.message, {
      code: failure.code,
      metadata: failure.toJSON(),
    });
  }
}

/** Import a legacy singleton without dropping its live owner during rollout. */
async function admissionTransaction<T>(
  context: DatabaseContext,
  apply: (
    database: RawAccess,
    counter: number,
    now: number
  ) => Promise<{ result: T; counter: number }>
): Promise<T> {
  return context.db.transaction(
    async (database) => {
      const now = Date.now();
      const rows = await database.execute<{ value: string }>(
        "SELECT value FROM documents WHERE key = ?",
        "admission"
      );
      const previous = rows[0]
        ? (JSON.parse(rows[0].value) as AdmissionRecord)
        : null;
      const maximum = await database.execute<{ maximum: number }>(
        "SELECT COALESCE(MAX(token), 0) AS maximum FROM admission_leases"
      );
      const counter = Math.max(
        previous?.nextToken ?? previous?.token ?? 0,
        maximum[0].maximum
      );
      if (
        previous &&
        previous.version !== 2 &&
        previous.owner &&
        previous.expiresAt > now
      ) {
        await database.execute(
          "DELETE FROM admission_leases WHERE token = ? AND expires_at <= ?",
          previous.token,
          now
        );
        await database.execute(
          "INSERT INTO admission_leases (owner, token, expires_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at",
          previous.owner,
          previous.token,
          previous.expiresAt
        );
      }
      // Cleanup stays bounded even after a large deployment has expired its leases.
      await database.execute(
        "DELETE FROM admission_leases WHERE owner IN (SELECT owner FROM admission_leases WHERE expires_at <= ? LIMIT 128)",
        now
      );
      const output = await apply(database, counter, now);
      const live = await database.execute<{ maximum: number }>(
        "SELECT COALESCE(MAX(expires_at), 0) AS maximum FROM admission_leases WHERE expires_at > ?",
        now
      );
      // Older code sees an occupied sentinel, so rollback cannot overwrite live
      // multi-lease ownership. Its workers abort on failed renewal and drain.
      const guard: AdmissionRecord = {
        version: 2,
        nextToken: output.counter,
        owner: live[0].maximum > now ? "__scrub_semaphore_v2__" : null,
        token: output.counter,
        expiresAt: live[0].maximum,
      };
      await database.execute(
        "INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        "admission",
        JSON.stringify(guard)
      );
      return output.result;
    },
    { name: "scrub.admission" }
  );
}

/** Optional cluster-wide leased semaphore; runner-local admission works independently. */
export const scrubAdmission = actor({
  db: jobDatabase,
  actions: {
    acquire: async (
      context: DatabaseContext,
      owner: string,
      capacity = 1
    ): Promise<AdmissionGrant> => {
      if (
        typeof owner !== "string" ||
        owner.length < 1 ||
        owner.length > 200 ||
        !Number.isSafeInteger(capacity) ||
        capacity < 1 ||
        capacity > 1024
      )
        throw new UserError("Invalid semaphore owner or capacity", {
          code: "invalid_input",
        });
      return admissionTransaction<AdmissionGrant>(
        context,
        async (database, counter, now) => {
          const own = await database.execute<{
            token: number;
            expires_at: number;
          }>(
            "SELECT token, expires_at FROM admission_leases WHERE owner = ? AND expires_at > ?",
            owner,
            now
          );
          if (own[0]) {
            await database.execute(
              "UPDATE admission_leases SET expires_at = ? WHERE owner = ? AND token = ?",
              now + LEASE_MS,
              owner,
              own[0].token
            );
            return {
              result: {
                granted: true,
                token: own[0].token,
                expiresAt: now + LEASE_MS,
              },
              counter,
            };
          }
          const live = await database.execute<{
            count: number;
            minimum: number;
          }>(
            "SELECT COUNT(*) AS count, COALESCE(MIN(expires_at), 0) AS minimum FROM admission_leases WHERE expires_at > ?",
            now
          );
          if (live[0].count >= capacity)
            return {
              result: {
                granted: false,
                token: counter,
                expiresAt: live[0].minimum,
              },
              counter,
            };
          const token = counter + 1;
          await database.execute(
            "INSERT INTO admission_leases (owner, token, expires_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at",
            owner,
            token,
            now + LEASE_MS
          );
          return {
            result: { granted: true, token, expiresAt: now + LEASE_MS },
            counter: token,
          };
        }
      );
    },
    renew: async (
      context: DatabaseContext,
      owner: string,
      token: number
    ): Promise<boolean> =>
      admissionTransaction(context, async (database, counter, now) => {
        const rows = await database.execute(
          "SELECT owner FROM admission_leases WHERE owner = ? AND token = ? AND expires_at > ?",
          owner,
          token,
          now
        );
        if (rows.length)
          await database.execute(
            "UPDATE admission_leases SET expires_at = ? WHERE owner = ? AND token = ?",
            now + LEASE_MS,
            owner,
            token
          );
        return { result: rows.length > 0, counter };
      }),
    validate: async (
      context: DatabaseContext,
      owner: string,
      token: number
    ): Promise<boolean> =>
      admissionTransaction(context, async (database, counter, now) => ({
        result:
          (
            await database.execute(
              "SELECT owner FROM admission_leases WHERE owner = ? AND token = ? AND expires_at > ?",
              owner,
              token,
              now
            )
          ).length > 0,
        counter,
      })),
    release: async (
      context: DatabaseContext,
      owner: string,
      token: number
    ): Promise<void> =>
      admissionTransaction(context, async (database, counter) => {
        await database.execute(
          "DELETE FROM admission_leases WHERE owner = ? AND token = ?",
          owner,
          token
        );
        return { result: undefined, counter };
      }),
  },
});

interface ExecutionLease {
  token: string;
  isExpired(): boolean;
  validate(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export async function acquireExecution(
  context: RuntimeContext,
  owner: string,
  admission: RunnerAdmission = runnerAdmission,
  policy: RuntimeConcurrencyPolicy = concurrencyPolicy
): Promise<ExecutionLease | null> {
  const local = admission.tryAcquire(owner);
  if (!local) return null;
  const globalLimit = policy.globalLimit;
  let global: AdmissionHandle | undefined;
  let grant: AdmissionGrant | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  try {
    if (globalLimit !== undefined) {
      global = admissionFor(context);
      const sentAt = performance.now();
      grant = await global.acquire(owner, globalLimit);
      if (!grant.granted) {
        local.release();
        return null;
      }
      deadline = sentAt + LEASE_MS - LEASE_MARGIN_MS;
      if (performance.now() >= deadline) {
        local.release();
        await global.release(owner, grant.token).catch(() => undefined);
        return null;
      }
    }
    const isExpired = () => !local.isActive() || performance.now() >= deadline;
    return {
      token: `${owner}:local:${local.token}${grant ? `:global:${grant.token}` : ""}`,
      isExpired,
      validate: async () =>
        !isExpired() &&
        (!global || (await global.validate(owner, grant!.token))) &&
        !isExpired(),
      renew: async () => {
        if (isExpired()) return false;
        if (!global) return true;
        const sentAt = performance.now();
        if (!(await global.renew(owner, grant!.token))) return false;
        // Anchor to RPC send time, never to its potentially delayed response.
        deadline = sentAt + LEASE_MS - LEASE_MARGIN_MS;
        return !isExpired();
      },
      release: async () => {
        local.release();
        if (global && grant)
          await global.release(owner, grant.token).catch(() => undefined);
      },
    };
  } catch (error) {
    local.release();
    throw error;
  }
}

function maintainExecution(
  lease: ExecutionLease,
  controller: AbortController,
  onRenew: () => Promise<void>
): () => void {
  let pending = false;
  let stopped = false;
  const abort = () =>
    controller.abort(
      new PipelineError(
        "unavailable",
        "The execution lease expired or could not be renewed",
        { retryable: true }
      )
    );
  const watchdog = setInterval(() => {
    if (!controller.signal.aborted && lease.isExpired()) abort();
  }, 250);
  const heartbeat = setInterval(() => {
    if (stopped || pending || controller.signal.aborted) return;
    if (lease.isExpired()) {
      abort();
      return;
    }
    pending = true;
    void lease
      .renew()
      .then(async (renewed) => {
        if (stopped || controller.signal.aborted) return;
        if (!renewed) abort();
        else await onRenew();
      })
      .catch(() => {
        if (!stopped && !controller.signal.aborted) abort();
      })
      .finally(() => {
        pending = false;
      });
  }, 10_000);
  return () => {
    stopped = true;
    clearInterval(watchdog);
    clearInterval(heartbeat);
  };
}

function submissionPolicy(context: RuntimeContext): SubmissionPolicy {
  return new SubmissionPolicy({
    requestDefault: concurrencyPolicy.requestDefault,
    resourceCeilings,
    inferenceDefaults: configuredInference().defaults,
    assertReady: async (settings) => {
      await modelsFor(context, settings);
    },
  });
}
const environment = {
  now: Date.now,
  fingerprint: (value: unknown) =>
    createHash("sha256").update(canonicalJobValue(value)).digest("hex"),
};
function videoRuntime(context: VideoContext): VideoRuntime {
  return {
    wake: (reason, attempt = 1) =>
      context.run.setWakeAt(
        reason === "stop"
          ? null
          : Date.now() +
              (reason === "immediate"
                ? 0
                : reason === "retry"
                  ? RETRY_MS * attempt
                  : LEASE_MS + RETRY_MS)
      ),
    isActive: () => context.vars.active,
    abort: () =>
      context.vars.controller?.abort(
        new PipelineError("cancelled", "Processing was cancelled")
      ),
  };
}
function videoService(context: VideoContext): VideoJobService {
  return new VideoJobService({
    repository: new RivetVideoRepository(context.db),
    runtime: videoRuntime(context),
    policy: submissionPolicy(context),
    environment,
  });
}
async function videoStatus(
  context: VideoContext
): Promise<VideoJobStatus | null> {
  const status = await videoService(context).getStatus();
  return status ? { ...status, actorId: context.actorId } : null;
}
async function abortVideo(context: VideoContext): Promise<VideoJobStatus> {
  return {
    ...(await videoService(context).cancel()),
    actorId: context.actorId,
  };
}
async function retryVideo(context: VideoContext): Promise<VideoJobStatus> {
  return { ...(await videoService(context).retry()), actorId: context.actorId };
}

/** Scheduled wake plus durable run records recover work after a runner restarts. */
export async function runVideoActor(context: VideoContext): Promise<void> {
  if (context.vars.active) return;
  context.vars.active = true;
  let stopMaintenance: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let lease: ExecutionLease | null = null;
  let owner = "";
  const controller = new AbortController();
  context.vars.controller = controller;
  const abort = () => controller.abort(context.abortSignal.reason);
  context.abortSignal.addEventListener("abort", abort, { once: true });
  if (context.abortSignal.aborted) abort();
  try {
    const documents = new SqliteDocuments(context.db);
    const service = videoService(context);
    const initialization = await service.prepareAttempt();
    if (!initialization) return;
    // This deadline survives process failure. Renewal during work is only a liveness optimization.
    await context.run.setWakeAt(Date.now() + LEASE_MS + RETRY_MS);
    owner = `${context.actorId}:${randomUUID()}`;
    lease = await acquireExecution(context, owner);
    if (!lease) {
      await context.run.setWakeAt(Date.now() + RETRY_MS);
      return;
    }
    const token = lease.token;
    await documents.update<string>("attempt", () => token);
    const assertOwnership = async () => {
      let owned = false;
      try {
        owned = !controller.signal.aborted && (await lease!.validate());
      } catch {
        /* Coordination errors revoke ownership. */
      }
      if (!owned) {
        controller.abort();
        throw new PipelineError("unavailable", "The execution lease was lost", {
          retryable: true,
        });
      }
    };
    stopMaintenance = maintainExecution(lease, controller, async () => {
      await context.run.setWakeAt(Date.now() + LEASE_MS + RETRY_MS);
    });
    const budget = initialization.settings.limits.stageTimeoutMs * 5;
    timeout = setTimeout(
      () =>
        controller.abort(
          new PipelineError(
            "timeout",
            "Video attempt exceeded its time budget",
            { retryable: true }
          )
        ),
      Math.min(budget, 2_147_483_647)
    );
    const artifacts = new SqliteArtifactStorage(
      context.db,
      initialization.settings.limits.maxArtifactBytes,
      initialization.settings.limits.maxSourceBytes
    );
    const runs = new SqliteRunRepository(context.db, {
      token,
      assertOwnership,
    });
    const operation: OperationContext = {
      runId: `${initialization.requestId}/${initialization.videoId}`,
      attemptId: token,
      signal: controller.signal,
      now: Date.now,
      emit: () => undefined,
    };
    await service.execute(
      {
        artifacts,
        runs,
        media: new NodeMediaProcessor(artifacts, nativeOptions),
        transcriber: new NodeTranscriber(artifacts, nativeOptions),
      },
      operation,
      () =>
        modelsFor(
          { client: () => context.client(), abortSignal: controller.signal },
          initialization.settings,
          false
        )
    );
  } finally {
    stopMaintenance?.();
    if (timeout) clearTimeout(timeout);
    context.abortSignal.removeEventListener("abort", abort);
    if (lease) await lease.release();
    context.vars.active = false;
    context.vars.controller = null;
  }
}

export const scrubVideo = actor({
  db: jobDatabase,
  createVars: () => ({
    active: false,
    controller: null as AbortController | null,
  }),
  onWake: async (context: VideoContext) => {
    await new SqliteArtifactStorage(context.db).removeUnpublished();
  },
  run: (context: VideoContext) => context.keepAwake(runVideoActor(context)),
  actions: {
    initialize: (
      context: VideoContext,
      input: VideoInitialization
    ): Promise<VideoJobStatus> =>
      expose(
        (async () => {
          return {
            ...(await videoService(context).initialize(input)),
            actorId: context.actorId,
          };
        })()
      ),
    getStatus: (context: VideoContext): Promise<VideoJobStatus | null> =>
      videoStatus(context),
    getResult: async (context: VideoContext): Promise<VideoResult | null> =>
      (await new SqliteRunRepository(context.db).get())?.result ?? null,
    cancel: (context: VideoContext): Promise<VideoJobStatus> =>
      expose(abortVideo(context)),
    retry: (context: VideoContext): Promise<VideoJobStatus> =>
      expose(retryVideo(context)),
    readArtifact: (
      context: VideoContext,
      id: string,
      offset: number,
      length: number
    ): Promise<{ data: string; mediaType: string; size: number }> =>
      expose(
        (async () => {
          if (
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > MAX_RANGE_BYTES
          )
            throw new PipelineError(
              "invalid_input",
              "Artifact action range exceeds 128 KiB"
            );
          const storage = new SqliteArtifactStorage(context.db);
          const ref = await storage.lookup(id);
          if (!ref)
            throw new PipelineError(
              "not_found",
              "Artifact does not exist in this video job"
            );
          const bytes = await storage.readRange(ref, offset, length);
          return {
            data: Buffer.from(bytes).toString("base64"),
            mediaType: ref.mediaType,
            size: ref.size,
          };
        })()
      ),
  },
});

function requestRuntime(context: RequestContext): RequestRuntime {
  return {
    scheduleReconcile: (reason) =>
      context.schedule
        .after(reason === "immediate" ? 0 : POLL_MS, "tick")
        .then(() => undefined),
    wakeEnumeration: (reason) =>
      context.run.setWakeAt(
        reason === "stop"
          ? null
          : Date.now() +
              (reason === "immediate"
                ? 0
                : reason === "retry"
                  ? RETRY_MS
                  : LEASE_MS + RETRY_MS)
      ),
    isEnumerationActive: () => context.vars.active,
    abortEnumeration: () =>
      context.vars.controller?.abort(
        new PipelineError("cancelled", "Playlist enumeration was cancelled")
      ),
  };
}
function videoControl(context: RequestContext): VideoJobControl {
  const handle = (key: { requestId: string; videoId: string }) =>
    videoFor(context, key.requestId, key.videoId);
  return {
    initialize: async (key, input) => {
      try {
        return await handle(key).initialize(input);
      } catch (error) {
        if (error instanceof PipelineError) throw error;
        const detail = (error && typeof error === "object" ? error : {}) as {
          code?: unknown;
          metadata?: { code?: unknown; retryable?: unknown };
        };
        const code = detail.metadata?.code ?? detail.code;
        const messages = {
          invalid_input: "Video settings are invalid",
          invalid_source: "Video source is invalid",
          resource_limit:
            "Accepted video settings exceed current server policy",
          capability_unavailable: "Required server capability is unavailable",
          model_authentication_failed: "Model provider authentication failed",
        } as const;
        if (
          detail.metadata?.retryable === false &&
          typeof code === "string" &&
          Object.hasOwn(messages, code)
        ) {
          const failure = code as keyof typeof messages;
          throw new PipelineError(failure, messages[failure], {
            stage: "initialize",
          });
        }
        throw error;
      }
    },
    getStatus: (key) => handle(key).getStatus(),
    getResult: (key) => handle(key).getResult(),
    cancel: (key) => handle(key).cancel(),
    retry: (key) => handle(key).retry(),
    readArtifact: async (key, id, offset, length) => {
      const value = await handle(key).readArtifact(id, offset, length);
      return {
        bytes: new Uint8Array(Buffer.from(value.data, "base64")),
        mediaType: value.mediaType,
        size: value.size,
      };
    },
  };
}
function requestOptions(context: RequestContext) {
  return {
    repository: new RivetRequestRepository(context.db),
    videos: videoControl(context),
    runtime: requestRuntime(context),
    environment,
  };
}
function requestService(context: RequestContext): RequestService {
  return new RequestService({
    ...requestOptions(context),
    policy: submissionPolicy(context),
    resultLimits: { items: 20, bytes: 512 * 1024 },
  });
}
export async function enumerateRequest(context: RequestContext): Promise<void> {
  if (context.vars.active) return;
  context.vars.active = true;
  let grant: ExecutionLease | null = null;
  let stopMaintenance: (() => void) | undefined;
  const controller = new AbortController();
  context.vars.controller = controller;
  const abort = () => controller.abort(context.abortSignal.reason);
  context.abortSignal.addEventListener("abort", abort, { once: true });
  if (context.abortSignal.aborted) abort();
  try {
    const request = await new RivetRequestRepository(context.db).get();
    if (
      !request ||
      request.enumerated ||
      request.cancelRequested ||
      terminal(request.status)
    )
      return;
    await context.run.setWakeAt(Date.now() + LEASE_MS + RETRY_MS);
    const owner = `catalog:${context.actorId}:${randomUUID()}`;
    grant = await acquireExecution(context, owner);
    if (!grant) {
      await context.run.setWakeAt(Date.now() + RETRY_MS);
      return;
    }
    stopMaintenance = maintainExecution(grant, controller, () =>
      context.run.setWakeAt(Date.now() + LEASE_MS + RETRY_MS)
    );
    await new RequestCoordinator(requestOptions(context)).enumerate(
      new NodeSourceCatalog({
        ...nativeOptions,
        stageTimeoutMs: request.settings.limits.stageTimeoutMs,
      }),
      {
        runId: request.id,
        attemptId: owner,
        signal: controller.signal,
        now: Date.now,
        emit: () => undefined,
      }
    );
  } finally {
    stopMaintenance?.();
    context.abortSignal.removeEventListener("abort", abort);
    if (grant) await grant.release();
    context.vars.active = false;
    context.vars.controller = null;
  }
}
export async function reconcileRequest(
  context: RequestContext
): Promise<JobSnapshot | null> {
  const coordinator = new RequestCoordinator(requestOptions(context));
  if (context.vars.ticking) return coordinator.snapshot();
  context.vars.ticking = true;
  try {
    return await coordinator.reconcile();
  } finally {
    context.vars.ticking = false;
  }
}
export const scrubRequest = actor({
  db: jobDatabase,
  createVars: () => ({
    active: false,
    ticking: false,
    controller: null as AbortController | null,
  }),
  onWake: async (context: RequestContext) => {
    const request = await new SqliteDocuments(context.db).get<JobRequestRecord>(
      "request"
    );
    if (request && !terminal(request.status))
      await context.schedule.after(0, "tick");
  },
  run: (context: RequestContext) =>
    context.keepAwake(enumerateRequest(context)),
  actions: {
    start: (
      context: RequestContext,
      input: JobSubmission
    ): Promise<JobSnapshot> =>
      expose(requestService(context).start(context.key[0], input)),
    getStatus: (context: RequestContext): Promise<JobSnapshot | null> =>
      requestService(context).getStatus(),
    tick: (context: RequestContext): Promise<JobSnapshot | null> =>
      reconcileRequest(context),
    hasVideo: (context: RequestContext, videoId: string): Promise<boolean> =>
      requestService(context).hasVideo(videoId),
    getResults: (
      context: RequestContext,
      offset: number,
      limit: number
    ): Promise<{ items: JobVideo[]; total: number }> =>
      expose(requestService(context).getResults(offset, limit)),
    cancel: (context: RequestContext): Promise<JobSnapshot> =>
      expose(requestService(context).cancel()),
    retry: (context: RequestContext): Promise<JobSnapshot> =>
      expose(
        (async () => {
          if (context.vars.ticking)
            throw new PipelineError(
              "invalid_state",
              "Wait for request reconciliation to stop before retrying"
            );
          return requestService(context).retry();
        })()
      ),
  },
});
