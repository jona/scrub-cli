import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type {
  ArtifactRef,
  JobGateway,
  JobSubmission,
  OperationContext,
  PipelineDependencies,
  PipelineSettings,
  SourceCatalog,
} from "../../../application/contracts.js";
import type {
  InferenceSettingsInput,
  StructuredModelGateway,
} from "../../../application/model.js";
import { assertInferenceReady } from "../../../application/model.js";
import { resolveSettings } from "../../../application/settings.js";
import { resultArtifacts } from "../../../application/artifact-io.js";
import { RequestCoordinator } from "../../../application/jobs/RequestCoordinator.js";
import { RequestService } from "../../../application/jobs/RequestService.js";
import { VideoJobService } from "../../../application/jobs/VideoJobService.js";
import {
  canonicalJobValue,
  SubmissionPolicy,
} from "../../../application/jobs/submission.js";
import type {
  VideoInitialization,
  VideoJobKey,
  WakeReason,
} from "../../../application/jobs/model.js";
import type {
  RequestRuntime,
  VideoJobControl,
  VideoRuntime,
} from "../../../application/jobs/ports.js";
import { PipelineError } from "../../../core/errors.js";
import { RunnerAdmission } from "../../runtime/RunnerAdmission.js";
import { FilesystemArtifactStorage } from "../FilesystemArtifactStorage.js";
import { NodeMediaProcessor } from "../NodeMediaProcessor.js";
import { NodeSourceCatalog } from "../NodeSourceCatalog.js";
import { NodeTranscriber } from "../NodeTranscriber.js";
import type { NativeRuntimeOptions } from "../runtime.js";
import {
  LocalDatabase,
  type LocalWake,
  type LocalWorkKind,
} from "./LocalDatabase.js";
import {
  LocalRequestRepository,
  LocalRunRepository,
  LocalVideoRepository,
} from "./LocalRepositories.js";

export interface LocalJobRuntimeOptions {
  dataRoot: string;
  native: NativeRuntimeOptions;
  models?: StructuredModelGateway;
  inferenceDefaults: InferenceSettingsInput;
  requestDefault?: number;
  runnerLimit?: number;
  globalLimit?: number;
  resourceCeilings?: Partial<PipelineSettings["limits"]>;
  catalog?: SourceCatalog;
  /** Explicit adapter injection for embedded hosts and deterministic runtime tests. */
  pipelineDependencies?(
    initialization: VideoInitialization,
    defaults: PipelineDependencies
  ): PipelineDependencies;
  pollMs?: number;
  retryMs?: number;
  ownershipMs?: number;
}

type ActiveWork = { controller: AbortController; promise: Promise<void> };
const keyOf = (key: VideoJobKey) =>
  JSON.stringify([key.requestId, key.videoId]);
const parseKey = (scope: string): VideoJobKey => {
  const value: unknown = JSON.parse(scope);
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((part) => typeof part !== "string" || !part)
  )
    throw new PipelineError("storage_error", "Invalid local video identity");
  return { requestId: value[0] as string, videoId: value[1] as string };
};

/** Durable background execution for one local data root, independent of interface. */
export class LocalJobRuntime {
  readonly jobs: JobGateway;
  readonly signal: AbortSignal;
  readonly database: LocalDatabase;
  private readonly shutdown = new AbortController();
  private readonly active = new Map<string, ActiveWork>();
  private readonly requestLocks = new Map<string, Promise<unknown>>();
  private readonly artifactRoot: string;
  private readonly admission: RunnerAdmission;
  private readonly policy: SubmissionPolicy;
  private readonly catalog: SourceCatalog;
  private readonly environment = {
    now: Date.now,
    fingerprint: (value: unknown) =>
      createHash("sha256").update(canonicalJobValue(value)).digest("hex"),
  };
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pumping = false;
  private closing?: Promise<void>;
  private readonly ownershipMs: number;
  private readonly retryMs: number;

  constructor(private readonly options: LocalJobRuntimeOptions) {
    this.signal = this.shutdown.signal;
    this.ownershipMs = options.ownershipMs ?? 15_000;
    this.retryMs = options.retryMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.ownershipMs) ||
      this.ownershipMs < 300 ||
      this.ownershipMs > 300_000
    )
      throw new PipelineError(
        "invalid_input",
        "Invalid local runtime ownership duration"
      );
    const runnerLimit = new RunnerAdmission(options.runnerLimit ?? 2).limit;
    if (
      options.globalLimit !== undefined &&
      (!Number.isSafeInteger(options.globalLimit) ||
        options.globalLimit < 1 ||
        options.globalLimit > 1024)
    )
      throw new PipelineError(
        "invalid_input",
        "Invalid global concurrency limit"
      );
    for (const [name, value, minimum, maximum] of [
      ["poll interval", options.pollMs ?? 100, 5, 60_000],
      ["retry interval", this.retryMs, 1, 300_000],
      ["request concurrency", options.requestDefault ?? 1, 1, 16],
    ] as const)
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new PipelineError("invalid_input", `Invalid local ${name}`);
    resolveSettings({ limits: options.resourceCeilings });
    this.admission = new RunnerAdmission(
      Math.min(runnerLimit, options.globalLimit ?? runnerLimit)
    );
    this.artifactRoot = join(resolve(options.dataRoot), "artifacts");
    this.catalog = options.catalog ?? new NodeSourceCatalog(options.native);
    this.policy = new SubmissionPolicy({
      requestDefault: options.requestDefault ?? 1,
      inferenceDefaults: options.inferenceDefaults,
      resourceCeilings: options.resourceCeilings,
      assertReady: async (settings) =>
        assertInferenceReady(
          settings.inference,
          options.models,
          settings.skipVisuals
        ),
    });
    this.database = new LocalDatabase(
      join(resolve(options.dataRoot), "jobs.sqlite")
    );
    try {
      this.database.acquire(randomUUID(), this.ownershipMs);
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.jobs = {
      submit: (input, idempotencyKey) => this.submit(input, idempotencyKey),
      get: (id) => this.request(id).service.getStatus(),
      results: (id, offset, limit) =>
        this.request(id).service.getResults(offset, limit),
      cancel: (id) =>
        this.serialize(id, () => this.request(id).service.cancel()),
      retry: (id) => this.serialize(id, () => this.request(id).service.retry()),
      artifact: (id, video, artifact, offset, length) =>
        this.readArtifact(
          { requestId: id, videoId: video },
          artifact,
          offset,
          length
        ),
    };
  }

  start(): void {
    if (this.timer || this.signal.aborted) return;
    this.database.recoverPending();
    this.heartbeat = setInterval(
      () => {
        try {
          this.database.renew(this.ownershipMs);
        } catch {
          this.revoke();
        }
      },
      Math.max(50, Math.floor(this.ownershipMs / 3))
    );
    this.timer = setInterval(
      () => void this.pump(),
      this.options.pollMs ?? 100
    );
    void this.pump();
  }

  private async submit(input: JobSubmission, idempotencyKey?: string) {
    this.database.assertOwned();
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 200)
    )
      throw new PipelineError(
        "invalid_input",
        "Idempotency key must contain 1 to 200 characters"
      );
    const id = idempotencyKey
      ? `request_${createHash("sha256").update(idempotencyKey).digest("hex")}`
      : `request_${randomUUID()}`;
    return this.serialize(id, () => this.request(id).service.start(id, input));
  }

  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.requestLocks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.requestLocks.set(id, next);
    void next
      .finally(() => {
        if (this.requestLocks.get(id) === next) this.requestLocks.delete(id);
      })
      .catch(() => {});
    return next;
  }

  private workId(kind: LocalWorkKind, scope: string) {
    return `${kind}:${scope}`;
  }
  private wake(
    kind: LocalWorkKind,
    scope: string,
    reason: WakeReason | "poll",
    attempt = 1
  ) {
    const delay =
      reason === "retry"
        ? this.retryMs * Math.max(1, attempt)
        : reason === "recovery"
          ? this.ownershipMs
          : reason === "poll"
            ? Math.max(20, this.options.pollMs ?? 100)
            : 0;
    this.database.wake(
      kind,
      scope,
      reason === "stop" ? null : Date.now() + delay
    );
    return Promise.resolve();
  }

  private request(id: string) {
    const repository = new LocalRequestRepository(this.database, id);
    const runtime: RequestRuntime = {
      scheduleReconcile: (reason) => this.wake("request", id, reason),
      wakeEnumeration: (reason, attempt) =>
        this.wake("enumeration", id, reason, attempt),
      isEnumerationActive: () =>
        this.active.has(this.workId("enumeration", id)),
      abortEnumeration: () =>
        this.active.get(this.workId("enumeration", id))?.controller.abort(),
    };
    const options = {
      repository,
      runtime,
      videos: this.videos,
      environment: this.environment,
      policy: this.policy,
    };
    return {
      service: new RequestService(options),
      coordinator: new RequestCoordinator(options),
    };
  }

  private video(key: VideoJobKey) {
    const scope = keyOf(key);
    const repository = new LocalVideoRepository(this.database, scope);
    const runtime: VideoRuntime = {
      wake: (reason, attempt) => this.wake("video", scope, reason, attempt),
      isActive: () => this.active.has(this.workId("video", scope)),
      abort: () =>
        this.active.get(this.workId("video", scope))?.controller.abort(),
    };
    return {
      repository,
      service: new VideoJobService({
        repository,
        runtime,
        environment: this.environment,
        policy: this.policy,
      }),
    };
  }

  private readonly videos: VideoJobControl = {
    initialize: (key, input) => this.video(key).service.initialize(input),
    getStatus: (key) => this.video(key).service.getStatus(),
    getResult: (key) => this.video(key).service.getResult(),
    cancel: (key) => this.video(key).service.cancel(),
    retry: (key) => this.video(key).service.retry(),
    readArtifact: (key, id, offset, length) =>
      this.readArtifact(key, id, offset, length),
  };

  private async readArtifact(
    key: VideoJobKey,
    id: string,
    offset: number,
    length: number
  ) {
    if (!(await this.request(key.requestId).service.hasVideo(key.videoId)))
      throw new PipelineError(
        "not_found",
        "Video does not belong to this request"
      );
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 128 * 1024
    )
      throw new PipelineError("invalid_input", "Invalid artifact range");
    const run = await this.video(key).repository.runs.get();
    const refs: ArtifactRef[] = run?.result ? resultArtifacts(run.result) : [];
    if (run?.checkpoints.acquire)
      refs.push(
        run.checkpoints.acquire.audio,
        ...(run.checkpoints.acquire.video
          ? [run.checkpoints.acquire.video]
          : [])
      );
    if (run?.checkpoints.transcribe)
      refs.push(
        run.checkpoints.transcribe.transcript,
        run.checkpoints.transcribe.text
      );
    if (run?.checkpoints.frames)
      refs.push(
        ...run.checkpoints.frames.frames.map((frame) => frame.artifact),
        ...(run.checkpoints.frames.manifest
          ? [run.checkpoints.frames.manifest]
          : [])
      );
    if (run?.checkpoints.inference)
      refs.push(
        ...Object.values(run.checkpoints.inference.steps).map(
          (step) => step.artifact
        )
      );
    const ref = refs.find((candidate) => candidate.id === id);
    if (!ref)
      throw new PipelineError(
        "not_found",
        "Artifact does not belong to this video"
      );
    return {
      bytes: await new FilesystemArtifactStorage(this.artifactRoot, {
        maxArtifactBytes: Math.max(1, ref.size),
      }).readRange(ref, offset, length),
      mediaType: ref.mediaType,
      size: ref.size,
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.signal.aborted) return;
    this.pumping = true;
    try {
      this.database.assertOwned();
      for (const work of this.database.due()) {
        const id = this.workId(work.kind, work.scope);
        if (this.active.has(id)) continue;
        const slot =
          work.kind === "request" ? undefined : this.admission.tryAcquire(id);
        if (slot === null) continue;
        const generation = this.database.claim(
          work,
          Date.now() + this.ownershipMs
        );
        if (generation === null) {
          slot?.release();
          continue;
        }
        const controller = new AbortController();
        const active: ActiveWork = { controller, promise: Promise.resolve() };
        this.active.set(id, active);
        active.promise = this.execute(work, controller)
          .then(() => this.database.finish(work, generation))
          .catch((error) => {
            if (this.signal.aborted) return;
            if (
              error instanceof PipelineError &&
              error.code === "storage_error"
            )
              this.database.quarantine(work);
            else
              this.database.wake(
                work.kind,
                work.scope,
                Date.now() + this.retryMs
              );
          })
          .finally(() => {
            slot?.release();
            this.active.delete(id);
          });
        void active.promise.catch(() => this.revoke());
      }
    } catch {
      this.revoke();
    } finally {
      this.pumping = false;
    }
  }

  private async execute(
    work: LocalWake,
    controller: AbortController
  ): Promise<void> {
    if (work.kind === "request") {
      await this.serialize(work.scope, async () => {
        const snapshot = await this.request(work.scope).coordinator.reconcile();
        if (
          !snapshot ||
          [
            "completed",
            "completed_with_errors",
            "failed",
            "cancelled",
          ].includes(snapshot.status)
        )
          this.database.wake("request", work.scope, null);
      });
      return;
    }
    const operation: OperationContext = {
      runId: work.scope,
      attemptId: randomUUID(),
      signal: controller.signal,
      now: Date.now,
      emit: () => {},
    };
    if (work.kind === "enumeration") {
      await this.request(work.scope).coordinator.enumerate(
        this.catalog,
        operation
      );
      return;
    }
    const key = parseKey(work.scope);
    const { service } = this.video(key);
    const initialization = await service.prepareAttempt();
    if (!initialization) return;
    this.database.update(work.scope, "attempt", () => operation.attemptId);
    const artifacts = new FilesystemArtifactStorage(this.artifactRoot, {
      maxArtifactBytes: Math.max(
        initialization.settings.limits.maxSourceBytes,
        initialization.settings.limits.maxArtifactBytes
      ),
    });
    const dependencies: PipelineDependencies = {
      artifacts,
      runs: new LocalRunRepository(
        this.database,
        work.scope,
        operation.attemptId
      ),
      media: new NodeMediaProcessor(artifacts, this.options.native),
      transcriber: new NodeTranscriber(artifacts, this.options.native),
      models: this.options.models,
    };
    const timeout = setTimeout(
      () =>
        controller.abort(
          new PipelineError(
            "timeout",
            "Video attempt exceeded its time budget",
            { retryable: true }
          )
        ),
      Math.min(initialization.settings.limits.stageTimeoutMs * 5, 2_147_483_647)
    );
    try {
      await service.execute(
        this.options.pipelineDependencies?.(initialization, dependencies) ??
          dependencies,
        operation
      );
    } finally {
      clearTimeout(timeout);
    }
    await this.wake("request", key.requestId, "immediate");
  }

  private revoke(): void {
    if (!this.signal.aborted)
      this.shutdown.abort(
        new PipelineError("unavailable", "Local runtime ownership was lost", {
          retryable: true,
        })
      );
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const active of this.active.values())
      active.controller.abort(this.signal.reason);
  }

  close(): Promise<void> {
    return (this.closing ??= Promise.resolve().then(async () => {
      this.revoke();
      await Promise.allSettled(
        [...this.active.values()].map((active) => active.promise)
      );
      await Promise.allSettled([...this.requestLocks.values()]);
      this.database.close();
    }));
  }
}
