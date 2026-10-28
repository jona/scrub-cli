import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawAccess } from "rivetkit/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureRivetDiagnostics,
  createRivetNativeDiagnostics,
  readRivetDiagnostics,
} from "../../src/infrastructure/rivet/diagnostics.js";
import { createCredentialProof } from "../../src/infrastructure/rivet/credentials.js";
import {
  configureRivetJobs,
  configureRivetInference,
  jobDatabase,
  scrubRequest,
  scrubVideo,
  runVideoActor,
  type RequestContext,
  type VideoContext,
} from "../../src/infrastructure/rivet/jobs.js";
import {
  SqliteDocuments,
  SqliteArtifactStorage,
} from "../../src/infrastructure/rivet/storage.js";
import type { NativeCommandDiagnostic } from "../../src/infrastructure/node/diagnostics.js";
import {
  queueNativeCommandDiagnostic,
  flushNativeCommandDiagnostics,
} from "../../src/infrastructure/node/diagnostics.js";
import { NodeMediaProcessor } from "../../src/infrastructure/node/NodeMediaProcessor.js";
import { resolveSettings } from "../../src/application/settings.js";
import { VideoJobService } from "../../src/application/jobs/VideoJobService.js";
import { asPipelineError } from "../../src/core/errors.js";
import type { NativeRuntimeOptions } from "../../src/infrastructure/node/runtime.js";

const bootstrap = "fixture-bootstrap-server-secret";
const providerKey = "fixture-provider-server-secret";
const key = ["request_fixture", "R0ckdFjUF5U"];
const removals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  configureRivetDiagnostics(undefined);
  configureRivetJobs({ stagingRoot: "/tmp/scrub" });
  for (const remove of removals.splice(0).reverse()) await remove();
});

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  removals.push(() => sqlite.close());
  let tail = Promise.resolve();
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
  const execute: RawAccess["execute"] = async (sql, ...args) =>
    sqlite.prepare(sql).all(...(args as SQLInputValue[])) as never;
  const transactionClient: RawAccess = {
    execute,
    transaction: async (work) => work(transactionClient),
    close: async () => {},
  };
  const timeouts: Array<number | undefined> = [];
  const access: RawAccess = {
    execute: (...args) => exclusive(() => execute(...args)),
    transaction: (work, options) =>
      exclusive(async () => {
        timeouts.push(options?.timeout);
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const value = await work(transactionClient);
          sqlite.exec("COMMIT");
          return value;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      }),
    close: async () => {},
  };
  await jobDatabase.onMigrate(access);
  return { access, timeouts };
}
const event = (
  overrides: Partial<NativeCommandDiagnostic> = {}
): NativeCommandDiagnostic => ({
  version: 1,
  event: "native_command_failed",
  tool: "yt-dlp",
  operation: "metadata",
  sourceId: key[1],
  timestamp: new Date().toISOString(),
  elapsedMs: 125,
  exitCode: 1,
  errorCode: "nonzero_exit",
  stderr: "Extractor returned an error",
  stderrTruncated: false,
  ...overrides,
});
const attempt = {
  runId: `${key[0]}/${key[1]}`,
  attemptId: "lease_attempt_fixture",
};

describe("protected Rivet native diagnostic journal", () => {
  it("authenticates every read before database access, including actor binding and expiry", async () => {
    configureRivetDiagnostics(bootstrap);
    const execute = vi.fn();
    const context = {
      db: { execute, transaction: vi.fn() } as unknown as RawAccess,
      key,
    };
    const actions = scrubVideo.config.actions!;
    const invalid = [
      undefined,
      {},
      createCredentialProof("incorrect-secret", key),
      createCredentialProof(bootstrap, [key[0], "anotherVideo"]),
      createCredentialProof(bootstrap, key, Date.now() - 20_001),
    ];
    for (const proof of invalid)
      await expect(
        actions.getDiagnostics(context as VideoContext, proof)
      ).rejects.toMatchObject({ code: "credential_access_denied" });
    expect(execute).not.toHaveBeenCalled();
    configureRivetDiagnostics(undefined);
    await expect(
      actions.getDiagnostics(
        context as VideoContext,
        createCredentialProof(bootstrap, key)
      )
    ).rejects.toMatchObject({ code: "credential_access_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([0, 6, 1.5, NaN, Infinity])(
    "rejects an invalid protected page limit: %s",
    async (limit) => {
      configureRivetDiagnostics(bootstrap);
      const execute = vi.fn();
      await expect(
        readRivetDiagnostics(
          { db: { execute } as unknown as RawAccess, key },
          createCredentialProof(bootstrap, key),
          limit
        )
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("persists only sanitized bounded events and serves the newest bounded page", async () => {
    configureRivetDiagnostics(bootstrap);
    const { access, timeouts } = await database();
    const emit = vi.fn(async () => {});
    const diagnostic = createRivetNativeDiagnostics(
      access,
      { redactValues: () => [providerKey], emit },
      attempt
    );
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        diagnostic.emit!(
          event({
            elapsedMs: index,
            stderr: `${bootstrap}\n${providerKey}\n${'"'.repeat(20_000)}`,
          })
        )
      )
    );
    const proof = createCredentialProof(bootstrap, key);
    const page = await scrubVideo.config.actions!.getDiagnostics(
      { db: access, key } as VideoContext,
      proof,
      5
    );
    expect(page).toMatchObject({ retained: 20, dropped: 5 });
    expect(page.events).toHaveLength(5);
    expect(page.events.map((item) => item.elapsedMs)).toEqual([
      24, 23, 22, 21, 20,
    ]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    const stored = await new SqliteDocuments(access).get(
      "native-command-diagnostics"
    );
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(
      256 * 1024
    );
    for (const item of (stored as { events: NativeCommandDiagnostic[] })
      .events) {
      expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(
        12 * 1024
      );
      expect(Buffer.byteLength(item.stderr)).toBeLessThanOrEqual(8 * 1024);
      expect(item).toMatchObject(attempt);
      expect(item.stderrTruncated).toBe(true);
    }
    for (const serialized of [
      JSON.stringify(stored),
      JSON.stringify(page),
      JSON.stringify(emit.mock.calls),
    ]) {
      expect(serialized).not.toContain(bootstrap);
      expect(serialized).not.toContain(providerKey);
    }
    expect(emit).toHaveBeenCalledTimes(25);
    expect(timeouts.filter((timeout) => timeout === 1500)).toHaveLength(25);
    const defaultPage = await readRivetDiagnostics(
      { db: access, key },
      createCredentialProof(bootstrap, key)
    );
    expect(defaultPage.events).toHaveLength(3);
    expect(defaultPage.retained).toBe(20);
  });

  it("re-sanitizes existing rows at protected reads without rewriting the journal", async () => {
    configureRivetDiagnostics(bootstrap);
    const { access } = await database();
    const documents = new SqliteDocuments(access);
    await documents.update("native-command-diagnostics", () => ({
      version: 1,
      events: [event({ stderr: `Existing diagnostic ${providerKey}` })],
      dropped: 0,
    }));
    const page = await readRivetDiagnostics(
      { db: access, key },
      createCredentialProof(bootstrap, key),
      3,
      () => [providerKey]
    );
    expect(page.retained).toBe(1);
    expect(JSON.stringify(page)).not.toContain(providerKey);
    expect(
      JSON.stringify(await documents.get("native-command-diagnostics"))
    ).toContain(providerKey);
    const native = createCredentialProof(bootstrap, key);
    expect(
      (
        await readRivetDiagnostics(
          { db: access, key },
          { ...native, expiresAt: BigInt(native.expiresAt) },
          1,
          () => [providerKey]
        )
      ).events
    ).toHaveLength(1);
  });

  it("drops invalid records and isolates outer-sink mutation from durable data", async () => {
    configureRivetDiagnostics(bootstrap);
    const { access } = await database();
    const diagnostics = createRivetNativeDiagnostics(
      access,
      {
        emit: (value) => {
          value.stderr = providerKey;
        },
      },
      attempt
    );
    await diagnostics.emit!(event());
    await diagnostics.emit!({
      ...event(),
      version: 2,
    } as unknown as NativeCommandDiagnostic);
    const page = await readRivetDiagnostics(
      { db: access, key },
      createCredentialProof(bootstrap, key)
    );
    expect(page).toMatchObject({ retained: 1, dropped: 1 });
    expect(page.events[0].stderr).toBe("Extractor returned an error");
    expect(JSON.stringify(page)).not.toContain(providerKey);
  });

  it("preserves the native termination signal when given a full pipeline operation context", async () => {
    configureRivetDiagnostics(bootstrap);
    const { access } = await database();
    const emit = vi.fn();
    const operation = {
      ...attempt,
      signal: new AbortController().signal,
      now: Date.now,
      emit: () => {},
    };
    await createRivetNativeDiagnostics(access, { emit }, operation).emit!(
      event({ signal: "SIGTERM", errorCode: "timeout" })
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", ...attempt })
    );
    const page = await readRivetDiagnostics(
      { db: access, key },
      createCredentialProof(bootstrap, key)
    );
    expect(page.events[0]).toMatchObject({ signal: "SIGTERM", ...attempt });
    expect(page.events[0]).not.toHaveProperty("now");
    expect(page.events[0]).not.toHaveProperty("emit");
  });

  it("keeps either diagnostic sink working when the other throws", async () => {
    configureRivetDiagnostics(bootstrap);
    const { access } = await database();
    const diagnostics = createRivetNativeDiagnostics(
      access,
      {
        emit: () => {
          throw new Error(providerKey);
        },
      },
      attempt
    );
    await expect(diagnostics.emit!(event())).resolves.toBeUndefined();
    expect(
      (
        await readRivetDiagnostics(
          { db: access, key },
          createCredentialProof(bootstrap, key)
        )
      ).retained
    ).toBe(1);
    const emit = vi.fn();
    const unavailable = {
      execute: vi.fn(),
      transaction: async () => {
        throw new Error(bootstrap);
      },
    } as unknown as RawAccess;
    await expect(
      createRivetNativeDiagnostics(unavailable, { emit }, attempt).emit!(
        event()
      )
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledOnce();
  });

  it("bounds hung sinks independently and consumes late failures", async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    const unavailable = {
      execute: vi.fn(),
      transaction: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    } as unknown as RawAccess;
    const diagnostics = createRivetNativeDiagnostics(
      unavailable,
      { emit: () => new Promise<void>(() => {}) },
      attempt
    );
    let finished = false;
    const pending = Promise.resolve(diagnostics.emit!(event())).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(finished).toBe(true);
    rejectLate(new Error(providerKey));
    await Promise.resolve();
  });

  it("fails closed when redaction or a protected journal read is unavailable", async () => {
    configureRivetDiagnostics(bootstrap);
    const { access } = await database();
    const emit = vi.fn();
    await createRivetNativeDiagnostics(
      access,
      {
        redactValues: () => {
          throw new Error(providerKey);
        },
        emit,
      },
      attempt
    ).emit!(event({ stderr: providerKey }));
    expect(emit).not.toHaveBeenCalled();
    expect(
      (
        await readRivetDiagnostics(
          { db: access, key },
          createCredentialProof(bootstrap, key)
        )
      ).retained
    ).toBe(0);
    const unavailable = {
      execute: async () => {
        throw new Error(providerKey);
      },
    } as unknown as RawAccess;
    await expect(
      readRivetDiagnostics(
        { db: unavailable, key },
        createCredentialProof(bootstrap, key)
      )
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Diagnostic journal is unavailable",
    });
  });

  it("bounds a hung protected journal read without returning an empty-success response", async () => {
    vi.useFakeTimers();
    configureRivetDiagnostics(bootstrap);
    const unavailable = {
      execute: () => new Promise(() => {}),
    } as unknown as RawAccess;
    const pending = readRivetDiagnostics(
      { db: unavailable, key },
      createCredentialProof(bootstrap, key)
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "unavailable",
      message: "Diagnostic journal is unavailable",
    });
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
  });

  it("keeps public status/results free of private diagnostic detail", async () => {
    configureRivetDiagnostics(bootstrap);
    configureRivetInference({ defaults: { mode: "preprocess" } });
    const { access } = await database();
    await createRivetNativeDiagnostics(access, undefined, attempt).emit!(
      event({ stderr: "PRIVATE_NATIVE_DIAGNOSTIC_MARKER" })
    );
    const failure = {
      code: "unavailable",
      message: "Unable to read source metadata",
      stage: "download",
      retryable: true,
    };
    const documents = new SqliteDocuments(access);
    await documents.update("video", () => ({
      requestId: key[0],
      videoId: key[1],
      settings: resolveSettings(),
      source: {
        kind: "youtube",
        url: `https://www.youtube.com/watch?v=${key[1]}`,
      },
    }));
    await documents.update("run", () => ({
      status: "failed",
      stage: "download",
      progress: 5,
      attempts: 3,
      failure,
    }));
    const status = await scrubVideo.config.actions!.getStatus({
      db: access,
      key,
      actorId: "fixture-actor",
    } as VideoContext);
    expect(status).toMatchObject({ status: "failed", failure });
    expect(
      await scrubVideo.config.actions!.getResult({
        db: access,
        key,
      } as VideoContext)
    ).toBeNull();
    await documents.update("request", () => ({ id: key[0] }));
    await access.execute(
      "INSERT INTO members VALUES (0, ?, ?, 'failed', 1, ?)",
      key[1],
      "Fixture video",
      JSON.stringify({
        videoId: key[1],
        title: "Fixture video",
        position: 0,
        status: "failed",
        failure,
      })
    );
    const results = await scrubRequest.config.actions!.getResults(
      { db: access, key: [key[0]] } as RequestContext,
      0,
      1
    );
    expect(results.items[0].failure).toEqual(failure);
    expect(JSON.stringify({ status, results })).not.toContain(
      "PRIVATE_NATIVE_DIAGNOSTIC_MARKER"
    );
    expect(JSON.stringify({ status, results })).not.toContain("stderr");
    expect(JSON.stringify({ status, results })).not.toContain("cause");
  });

  it("preserves the actual native failure when both logging sinks fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "scrub-diagnostic-failure-"));
    removals.push(() => rm(root, { recursive: true, force: true }));
    const { access } = await database();
    const badJournal = {
      execute: vi.fn(),
      transaction: async () => {
        throw new Error(bootstrap);
      },
    } as unknown as RawAccess;
    const diagnostics = createRivetNativeDiagnostics(
      badJournal,
      {
        emit: () => {
          throw new Error(providerKey);
        },
      },
      attempt
    );
    const media = new NodeMediaProcessor(new SqliteArtifactStorage(access), {
      stagingRoot: root,
      runCommand: async () => ({
        code: 1,
        stdout: "",
        stderr: "Native source fetch failed",
      }),
      diagnostics,
    });
    await expect(
      media.acquire(
        { kind: "youtube", url: `https://www.youtube.com/watch?v=${key[1]}` },
        resolveSettings({ skipVisuals: true }),
        {
          runId: attempt.runId,
          attemptId: attempt.attemptId,
          signal: new AbortController().signal,
          now: Date.now,
          emit: () => {},
        }
      )
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Unable to read source metadata",
    });
    await flushNativeCommandDiagnostics(diagnostics);
  });

  it("keeps a short native deadline from reclassifying a completed failure while diagnostics are pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "scrub-pending-diagnostics-"));
    removals.push(() => rm(root, { recursive: true, force: true }));
    const { access } = await database();
    const diagnostics = createRivetNativeDiagnostics(
      access,
      { emit: () => new Promise<void>(() => {}) },
      attempt
    );
    const media = new NodeMediaProcessor(new SqliteArtifactStorage(access), {
      stagingRoot: root,
      runCommand: async () => ({
        code: 0,
        stdout: "invalid",
        stderr: "Malformed metadata response",
      }),
      diagnostics,
    });
    const error = await media
      .acquire(
        { kind: "youtube", url: `https://www.youtube.com/watch?v=${key[1]}` },
        resolveSettings({ limits: { stageTimeoutMs: 50 } }),
        {
          ...attempt,
          signal: new AbortController().signal,
          now: Date.now,
          emit: () => {},
        }
      )
      .catch((error) => error);
    expect(asPipelineError(error)).toMatchObject({
      code: "processing_failed",
      retryable: false,
    });
    await flushNativeCommandDiagnostics(diagnostics);
  });

  it("drains an actor attempt only after failure persistence and after clearing its deadline", async () => {
    vi.useFakeTimers();
    configureRivetInference({ defaults: { mode: "preprocess" } });
    configureRivetJobs({
      stagingRoot: "/tmp/unused",
      diagnostics: { emit: () => new Promise<void>(() => {}) },
    });
    const { access } = await database();
    const settings = resolveSettings({ limits: { stageTimeoutMs: 50 } });
    const initialization = {
      requestId: key[0],
      videoId: key[1],
      settings,
      source: {
        kind: "youtube" as const,
        url: `https://www.youtube.com/watch?v=${key[1]}`,
      },
    };
    const documents = new SqliteDocuments(access);
    await documents.update("video", () => initialization);
    let attemptSignal: AbortSignal | undefined;
    vi.spyOn(VideoJobService.prototype, "execute").mockImplementation(
      async (dependencies, operation) => {
        attemptSignal = operation.signal;
        const mediaRuntime = (
          dependencies.media as unknown as { runtime: NativeRuntimeOptions }
        ).runtime;
        queueNativeCommandDiagnostic(event(), mediaRuntime.diagnostics);
        await dependencies.runs.update(() => ({
          revision: 1,
          status: "failed",
          source: initialization.source,
          settings,
          cacheKey: "fixture",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          stage: "download",
          progress: 5,
          attempts: 1,
          cancelRequested: false,
          checkpoints: {},
          failure: {
            code: "processing_failed",
            message: "Original completed failure",
            stage: "download",
            retryable: false,
          },
        }));
      }
    );
    const context: VideoContext = {
      db: access,
      key,
      actorId: "actor-diagnostic-attempt",
      abortSignal: new AbortController().signal,
      vars: { active: false, controller: null },
      client: () => {
        throw new Error("No remote client expected");
      },
      run: { setWakeAt: vi.fn(async () => {}) },
      schedule: { after: vi.fn(async () => "wake") },
      keepAwake: (work) => work,
    };
    let finished = false;
    const pending = runVideoActor(context).then(() => {
      finished = true;
    });
    await vi.waitFor(async () =>
      expect((await documents.get<{ status: string }>("run"))?.status).toBe(
        "failed"
      )
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(false);
    expect(context.vars.active).toBe(true);
    expect(attemptSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(context.vars.active).toBe(false);
    expect(context.vars.controller).toBeNull();
    expect(
      (
        await documents.get<{ failure: { code: string; retryable: boolean } }>(
          "run"
        )
      )?.failure
    ).toMatchObject({ code: "processing_failed", retryable: false });
  });
});
