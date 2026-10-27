import type { VideoJobStatus } from "../../src/application/jobs/model.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RawAccess } from "rivetkit/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JobVideo,
  RunRecord,
  VideoResult,
} from "../../src/application/contracts.js";
import { resolveSettings } from "../../src/application/settings.js";
import { PipelineError } from "../../src/core/errors.js";
import {
  BLOB_CHUNK_BYTES,
  migrateJobDatabase,
  SqliteArtifactStorage,
  SqliteDocuments,
  SqliteRunRepository,
} from "../../src/infrastructure/rivet/storage.js";

const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(),
  entries: [] as { id: string; title: string; url: string; position: number }[],
}));
vi.mock("../../src/application/pipeline.js", () => ({
  runVideoPipeline: mocks.pipeline,
}));
vi.mock("../../src/infrastructure/node/NodeMediaProcessor.js", () => ({
  NodeMediaProcessor: class {},
}));
vi.mock("../../src/infrastructure/node/NodeTranscriber.js", () => ({
  NodeTranscriber: class {},
}));
vi.mock("../../src/infrastructure/node/NodeSourceCatalog.js", () => ({
  NodeSourceCatalog: class {
    async enumerate(
      input: string,
      _maximum: number,
      context: { signal: AbortSignal }
    ) {
      if (context.signal.aborted)
        throw new PipelineError("cancelled", "Enumeration stopped");
      return {
        metadata: {},
        entries: (async function* () {
          const entries = mocks.entries.length
            ? mocks.entries
            : input.includes("watch?v=")
              ? [{ id: "aaaaaaaaaaa", title: "Video", url: input, position: 1 }]
              : [];
          for (const entry of entries) yield entry;
        })(),
      };
    }
  },
}));

import {
  acquireExecution,
  configureRivetJobs,
  configureRivetInference,
  configureRivetSubmissionPolicy,
  enumerateRequest,
  jobDatabase,
  reconcileRequest,
  runVideoActor,
  scrubAdmission,
  scrubRequest,
  scrubVideo,
  type JobActorClient,
  type RequestContext,
  type VideoContext,
} from "../../src/infrastructure/rivet/jobs.js";
import { RivetJobGateway } from "../../src/infrastructure/rivet/JobGateway.js";
import { RunnerAdmission } from "../../src/infrastructure/runtime/RunnerAdmission.js";

const cleanup: (() => void)[] = [];
beforeEach(() => configureRivetInference({ defaults: { mode: "preprocess" } }));
afterEach(() => {
  vi.useRealTimers();
  mocks.pipeline.mockReset();
  mocks.entries = [];
  configureRivetJobs({ stagingRoot: "/tmp/scrub-test" });
  configureRivetSubmissionPolicy({});
  for (const remove of cleanup.splice(0).reverse()) remove();
});

/** Actual SQLite with a transaction gate, matching the Rivet RawAccess contract. */
function sqlite(path = ":memory:"): RawAccess {
  const database = new DatabaseSync(path);
  let closed = false;
  let tail = Promise.resolve();
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const execute: RawAccess["execute"] = async (query, ...args) =>
    database.prepare(query).all(...(args as SQLInputValue[])) as never;
  const transactionClient: RawAccess = {
    execute,
    transaction: async (callback) => callback(transactionClient),
    close: async () => undefined,
  };
  const result: RawAccess = {
    execute: (query, ...args) => exclusive(() => execute(query, ...args)),
    transaction: (callback) =>
      exclusive(async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = await callback(transactionClient);
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }),
    close: async () => {
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  };
  cleanup.push(() => {
    if (!closed) {
      database.close();
      closed = true;
    }
  });
  return result;
}

async function actorDatabase(path?: string): Promise<RawAccess> {
  const database = sqlite(path);
  await jobDatabase.onMigrate(database);
  return database;
}

const settings = () =>
  resolveSettings({ limits: { maxAttempts: 2, stageTimeoutMs: 1_000 } });
const videoId = "aaaaaaaaaaa";
const source = {
  kind: "youtube" as const,
  url: `https://www.youtube.com/watch?v=${videoId}`,
};
function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    revision: 1,
    status: "running",
    source,
    settings: settings(),
    cacheKey: "cache",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stage: "download",
    progress: 10,
    attempts: 1,
    cancelRequested: false,
    checkpoints: {},
    ...overrides,
  };
}

async function contexts() {
  const admissionDb = await actorDatabase();
  const actions = scrubAdmission.config.actions;
  const admission = {
    acquire: vi.fn((owner: string, capacity?: number) =>
      actions.acquire({ db: admissionDb }, owner, capacity)
    ),
    renew: vi.fn((owner: string, token: number) =>
      actions.renew({ db: admissionDb }, owner, token)
    ),
    validate: vi.fn((owner: string, token: number) =>
      actions.validate({ db: admissionDb }, owner, token)
    ),
    release: vi.fn((owner: string, token: number) =>
      actions.release({ db: admissionDb }, owner, token)
    ),
  };
  const statuses = new Map<string, VideoJobStatus>();
  const initialized: string[] = [];
  const cancelled: string[] = [];
  const client = {
    scrubAdmission: { getOrCreate: () => admission, get: () => admission },
    scrubVideo: {
      getOrCreate: (keys: string[]) => ({
        initialize: async () => {
          initialized.push(keys[1]);
          const status: VideoJobStatus = {
            status: "queued",
            stage: "queued",
            progress: 0,
            attempts: 0,
          };
          statuses.set(keys[1], status);
          return status;
        },
        getStatus: async () => statuses.get(keys[1]) ?? null,
        getResult: async () =>
          ({ metadata: { title: keys[1] } }) as VideoResult,
        cancel: async () => {
          cancelled.push(keys[1]);
          const status: VideoJobStatus = {
            status: "cancelled",
            stage: "cancelled",
            progress: 0,
            attempts: 1,
          };
          statuses.set(keys[1], status);
          return status;
        },
        retry: async () => {
          const status: VideoJobStatus = {
            status: "queued",
            stage: "queued",
            progress: 0,
            attempts: 0,
          };
          statuses.set(keys[1], status);
          return status;
        },
      }),
    },
  } as unknown as JobActorClient;
  const wakes: (number | null)[] = [];
  const scheduled: string[] = [];
  const common = {
    key: ["request", videoId],
    actorId: "actor",
    abortSignal: new AbortController().signal,
    client: () => client,
    run: {
      setWakeAt: async (at: number | null) => {
        wakes.push(at);
      },
    },
    schedule: {
      after: async (_delay: number, action: string) => {
        scheduled.push(action);
        return "scheduled";
      },
    },
    keepAwake: async <T>(promise: Promise<T>) => promise,
  };
  const video: VideoContext = {
    ...common,
    db: await actorDatabase(),
    vars: { active: false, controller: null },
  };
  const request: RequestContext = {
    ...common,
    key: ["request"],
    db: await actorDatabase(),
    vars: { active: false, ticking: false, controller: null },
  };
  return {
    video,
    request,
    admissionDb,
    admission,
    statuses,
    initialized,
    cancelled,
    wakes,
    scheduled,
  };
}

describe("durable actor artifact storage", () => {
  it("publishes multi-MiB media through metadata indirection without rewriting or bulk-deleting chunks", async () => {
    const database = await actorDatabase();
    const mutations: string[] = [];
    const observe = (sql: string, args: unknown[]) => {
      if (!/^(INSERT|UPDATE|DELETE)/i.test(sql)) return;
      mutations.push(sql);
      expect(sql).not.toMatch(/^UPDATE artifact_chunks/i);
      if (/^DELETE FROM artifact_chunks/i.test(sql))
        expect(sql).toContain("position = ?");
      for (const value of args)
        if (value instanceof Uint8Array)
          expect(value.byteLength).toBeLessThanOrEqual(BLOB_CHUNK_BYTES);
    };
    const tracked: RawAccess = {
      ...database,
      execute: async (sql, ...args) => {
        observe(sql, args);
        return database.execute(sql, ...args);
      },
      transaction: async (callback, options) =>
        database.transaction(
          (tx) =>
            callback({
              ...tx,
              execute: async (sql, ...args) => {
                observe(sql, args);
                return tx.execute(sql, ...args);
              },
            }),
          options
        ),
    };
    const storage = new SqliteArtifactStorage(tracked);
    const bytes = new Uint8Array(4 * 1024 * 1024 + 3).fill(71);
    const first = await storage.put("source/video", bytes, "video/mp4");
    const published = await database.execute<{ chunk_id: string }>(
      "SELECT chunk_id FROM artifacts WHERE id = ?",
      first.id
    );
    expect(published[0].chunk_id).toMatch(/^pending_/);
    expect(published[0].chunk_id).not.toBe(first.id);
    expect((await storage.put("source/video", bytes, "video/mp4")).id).toBe(
      first.id
    );
    expect(
      await database.execute("SELECT COUNT(*) AS count FROM artifact_chunks")
    ).toEqual([{ count: 17 }]);
    await expect(
      storage.put(
        "failed",
        (async function* () {
          yield bytes;
          throw new Error("interrupted");
        })(),
        "video/mp4"
      )
    ).rejects.toThrow("interrupted");
    expect(
      mutations.filter((sql) => sql.startsWith("DELETE FROM artifact_chunks"))
        .length
    ).toBe(33);
    expect(await storage.has(first)).toBe(true);
  });

  it("migrates legacy chunk identities and enforces distinct source/artifact limits", async () => {
    const database = sqlite();
    await database.execute(
      "CREATE TABLE artifacts (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)"
    );
    await database.execute(
      "CREATE TABLE artifact_chunks (artifact_id TEXT, position INTEGER, bytes BLOB, PRIMARY KEY (artifact_id, position))"
    );
    const ref = {
      id: "legacy",
      kind: "text",
      mediaType: "text/plain",
      size: 2,
    };
    await database.execute(
      "INSERT INTO artifacts (id, metadata) VALUES (?, ?)",
      ref.id,
      JSON.stringify(ref)
    );
    await database.execute(
      "INSERT INTO artifact_chunks (artifact_id, position, bytes) VALUES (?, ?, ?)",
      ref.id,
      0,
      new Uint8Array([4, 5])
    );
    await migrateJobDatabase(database);
    const storage = new SqliteArtifactStorage(database, 10, 30);
    expect(await storage.readRange(ref, 0, 2)).toEqual(new Uint8Array([4, 5]));
    expect(
      await storage.put("source/video", new Uint8Array(20), "video/mp4")
    ).toMatchObject({ size: 20 });
    await expect(
      storage.put("source/audio", new Uint8Array(20), "audio/wav")
    ).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("publishes bounded chunks, reads ranges across boundaries, and survives reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scrub-rivet-storage-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "job.sqlite");
    const database = await actorDatabase(path);
    const storage = new SqliteArtifactStorage(database);
    const bytes = Uint8Array.from(
      { length: BLOB_CHUNK_BYTES * 2 + 71 },
      (_, index) => index % 251
    );
    const ref = await storage.put(
      "source/video",
      (async function* () {
        yield bytes.subarray(0, 13);
        yield bytes.subarray(13);
      })(),
      "video/mp4"
    );
    expect(ref.id).not.toContain(directory);
    expect(
      await database.execute(
        "SELECT MAX(length(bytes)) AS maximum, COUNT(*) AS count FROM artifact_chunks"
      )
    ).toEqual([{ maximum: BLOB_CHUNK_BYTES, count: 3 }]);
    expect(await storage.readRange(ref, BLOB_CHUNK_BYTES - 3, 9)).toEqual(
      bytes.subarray(BLOB_CHUNK_BYTES - 3, BLOB_CHUNK_BYTES + 6)
    );
    expect((await storage.put("source/video", bytes, "video/mp4")).id).toBe(
      ref.id
    );
    expect(
      await database.execute("SELECT COUNT(*) AS count FROM artifact_chunks")
    ).toEqual([{ count: 3 }]);
    await database.close();
    const reopened = new SqliteArtifactStorage(await actorDatabase(path));
    const output = new Uint8Array(bytes.length);
    let offset = 0;
    for await (const chunk of reopened.read(ref)) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    expect(output).toEqual(bytes);
  });

  it("does not publish failed streams or oversized blobs and cleans interrupted writes", async () => {
    const database = await actorDatabase();
    const storage = new SqliteArtifactStorage(database, BLOB_CHUNK_BYTES + 1);
    await expect(
      storage.put(
        "audio",
        (async function* () {
          yield new Uint8Array(BLOB_CHUNK_BYTES);
          throw new Error("stream failed");
        })(),
        "audio/wav"
      )
    ).rejects.toThrow("stream failed");
    await expect(
      storage.put("audio", new Uint8Array(BLOB_CHUNK_BYTES + 2), "audio/wav")
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(
      await database.execute("SELECT COUNT(*) AS count FROM artifacts")
    ).toEqual([{ count: 0 }]);
    expect(
      await database.execute("SELECT COUNT(*) AS count FROM artifact_chunks")
    ).toEqual([{ count: 0 }]);
    await database.execute(
      "INSERT INTO artifact_chunks (artifact_id, position, bytes) VALUES (?, ?, ?)",
      "interrupted",
      0,
      new Uint8Array([1])
    );
    await storage.removeUnpublished();
    expect(
      await database.execute("SELECT COUNT(*) AS count FROM artifact_chunks")
    ).toEqual([{ count: 0 }]);
  });

  it("detects missing chunks and rejects invalid ranges", async () => {
    const database = await actorDatabase();
    const storage = new SqliteArtifactStorage(database);
    const ref = await storage.put(
      "text",
      new Uint8Array([1, 2, 3]),
      "text/plain"
    );
    await expect(storage.readRange(ref, -1, 3)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      storage.readRange(ref, 0, BLOB_CHUNK_BYTES + 1)
    ).rejects.toMatchObject({ code: "invalid_input" });
    await database.execute(
      "DELETE FROM artifact_chunks WHERE artifact_id = (SELECT chunk_id FROM artifacts WHERE id = ?)",
      ref.id
    );
    expect(await storage.has(ref)).toBe(false);
    await expect(storage.readRange(ref, 0, 1)).rejects.toMatchObject({
      code: "storage_error",
    });
    const repaired = await storage.put(
      "text",
      new Uint8Array([1, 2, 3]),
      "text/plain"
    );
    expect(repaired.id).toBe(ref.id);
    expect(await storage.has(ref)).toBe(true);
    expect(await storage.readRange(ref, 0, 3)).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });
});

describe("durable run updates", () => {
  it("serializes concurrent changes, rolls back failures, and fences old attempts", async () => {
    const database = await actorDatabase();
    const documents = new SqliteDocuments(database);
    await documents.update<string>("attempt", () => "first");
    const repository = new SqliteRunRepository(database, {
      token: "first",
      assertOwnership: async () => undefined,
    });
    await repository.update(() => record());
    await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.update((current) => ({
          ...current!,
          revision: current!.revision + 1,
        }))
      )
    );
    expect((await repository.get())?.revision).toBe(11);
    await expect(
      repository.update(() => {
        throw new Error("not committed");
      })
    ).rejects.toThrow("not committed");
    expect((await repository.get())?.revision).toBe(11);
    await documents.update<string>("attempt", () => "second");
    await expect(
      repository.update((current) => ({ ...current!, revision: 99 }))
    ).rejects.toMatchObject({ code: "unavailable" });
    expect((await repository.get())?.revision).toBe(11);
  });

  it("retains a concurrent cancellation and rejects completing a cancelled run", async () => {
    const database = await actorDatabase();
    const repository = new SqliteRunRepository(database);
    await repository.update(() =>
      record({ cancelRequested: true, status: "cancelled" })
    );
    const next = await repository.update((current) => ({
      ...current!,
      cancelRequested: false,
      revision: 2,
    }));
    expect(next.cancelRequested).toBe(true);
    await expect(
      repository.update((current) => ({ ...current!, status: "completed" }))
    ).rejects.toMatchObject({ code: "cancelled" });
    expect((await repository.get())?.status).toBe("cancelled");
  });

  it("applies a pre-initialization cancellation marker to the first worker checkpoint", async () => {
    const database = await actorDatabase();
    await new SqliteDocuments(database).update("cancelRequested", () => true);
    const repository = new SqliteRunRepository(database);
    await expect(
      repository.update(() => record({ status: "completed" }))
    ).rejects.toMatchObject({ code: "cancelled" });
    const checkpoint = await repository.update(() => record());
    expect(checkpoint.cancelRequested).toBe(true);
  });
});

describe("Rivet job lifecycle", () => {
  it("persists cancellation before initialization and starts only after explicit retry", async () => {
    const { video } = await contexts();
    expect(await scrubVideo.config.actions.cancel(video)).toMatchObject({
      status: "cancelled",
    });
    expect(
      await scrubVideo.config.actions.initialize(video, {
        requestId: "request",
        videoId,
        source,
        settings: settings(),
      })
    ).toMatchObject({ status: "cancelled" });
    expect(await new SqliteDocuments(video.db).get("video")).toBeNull();
    expect(await scrubVideo.config.actions.retry(video)).toMatchObject({
      status: "queued",
    });
    expect(await scrubVideo.config.actions.retry(video)).toMatchObject({
      status: "queued",
    });
    expect(
      await scrubVideo.config.actions.initialize(video, {
        requestId: "request",
        videoId,
        source,
        settings: settings(),
      })
    ).toMatchObject({ status: "queued" });
    expect(await new SqliteDocuments(video.db).get("video")).not.toBeNull();
  });

  it("does not retroactively cancel a completed child", async () => {
    const { video } = await contexts();
    await scrubVideo.config.actions.initialize(video, {
      requestId: "request",
      videoId,
      source,
      settings: settings(),
    });
    await new SqliteRunRepository(video.db).update(() =>
      record({
        status: "completed",
        stage: "completed",
        progress: 100,
      })
    );
    expect(await scrubVideo.config.actions.cancel(video)).toMatchObject({
      status: "completed",
    });
    expect(await new SqliteRunRepository(video.db).get()).toMatchObject({
      status: "completed",
      cancelRequested: false,
    });
  });

  it("admits multiple global holders, retries idempotently, and drains before shrinking capacity", async () => {
    const { admission } = await contexts();
    const first = await admission.acquire("first", 2);
    const second = await admission.acquire("second", 2);
    expect(first.granted && second.granted).toBe(true);
    expect((await admission.acquire("third", 2)).granted).toBe(false);
    expect((await admission.acquire("first", 1)).token).toBe(first.token);
    await admission.release("first", first.token);
    expect((await admission.acquire("third", 1)).granted).toBe(false);
    await admission.release("second", second.token);
    const third = await admission.acquire("third", 1);
    expect(third.granted).toBe(true);
    expect(third.token).toBeGreaterThan(second.token);
    await admission.release("first", first.token);
    expect(await admission.validate("third", third.token)).toBe(true);
  });

  it("migrates an active singleton lease without losing its token or opening an extra slot", async () => {
    const { admissionDb, admission } = await contexts();
    await new SqliteDocuments(admissionDb).update("admission", () => ({
      owner: "old-worker",
      token: 7,
      expiresAt: Date.now() + 30_000,
    }));
    expect((await admission.acquire("new-worker", 1)).granted).toBe(false);
    expect(await admission.validate("old-worker", 7)).toBe(true);
    const next = await admission.acquire("new-worker", 2);
    expect(next).toMatchObject({ granted: true, token: 8 });
    expect(await admission.renew("old-worker", 7)).toBe(true);
    expect(
      await new SqliteDocuments(admissionDb).get("admission")
    ).toMatchObject({ version: 2, token: 8, owner: "__scrub_semaphore_v2__" });
    await admission.release("old-worker", 7);
    expect(await admission.validate("new-worker", 8)).toBe(true);
  });

  it.each([0, -1, 1.5, 1025, Number.NaN])(
    "rejects invalid global capacity %s",
    async (capacity) => {
      const { admission } = await contexts();
      await expect(admission.acquire("owner", capacity)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  );

  it("shares the optional global cap across separate runner controllers", async () => {
    const { video, admission } = await contexts();
    const firstRunner = new RunnerAdmission(1),
      secondRunner = new RunnerAdmission(2);
    const first = await acquireExecution(video, "first", firstRunner, {
      runnerLimit: 1,
      requestDefault: 1,
      globalLimit: 2,
    });
    const second = await acquireExecution(video, "second", secondRunner, {
      runnerLimit: 2,
      requestDefault: 1,
      globalLimit: 2,
    });
    expect(first && second).toBeTruthy();
    try {
      expect(
        await acquireExecution(video, "third", secondRunner, {
          runnerLimit: 2,
          requestDefault: 1,
          globalLimit: 2,
        })
      ).toBeNull();
      expect(secondRunner.activeCount).toBe(1);
      expect(admission.acquire).toHaveBeenCalledWith("third", 2);
      await first!.release();
      const third = await acquireExecution(video, "third", secondRunner, {
        runnerLimit: 2,
        requestDefault: 1,
        globalLimit: 2,
      });
      expect(third).not.toBeNull();
      await third!.release();
    } finally {
      await first?.release();
      await second?.release();
    }
    expect(firstRunner.activeCount + secondRunner.activeCount).toBe(0);
  });

  it("makes zero global SDK calls when disabled, and local denial stays local", async () => {
    const { video, admission } = await contexts();
    const runner = new RunnerAdmission(1);
    const first = await acquireExecution(video, "first", runner, {
      runnerLimit: 1,
      requestDefault: 1,
    });
    try {
      expect(
        await acquireExecution(video, "second", runner, {
          runnerLimit: 1,
          requestDefault: 1,
          globalLimit: 2,
        })
      ).toBeNull();
      expect(admission.acquire).not.toHaveBeenCalled();
      expect(await first!.validate()).toBe(true);
      expect(await first!.renew()).toBe(true);
    } finally {
      await first?.release();
    }
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(admission.renew).not.toHaveBeenCalled();
    expect(admission.validate).not.toHaveBeenCalled();
    expect(admission.release).not.toHaveBeenCalled();
  });

  it("releases local capacity if the optional global RPC throws", async () => {
    const { video, admission } = await contexts();
    const runner = new RunnerAdmission(1);
    admission.acquire.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(
      acquireExecution(video, "owner", runner, {
        runnerLimit: 1,
        requestDefault: 1,
        globalLimit: 1,
      })
    ).rejects.toThrow("RPC unavailable");
    expect(runner.activeCount).toBe(0);
    const next = await acquireExecution(video, "next", runner, {
      runnerLimit: 1,
      requestDefault: 1,
    });
    expect(next).not.toBeNull();
    await next!.release();
  });

  it("applies deployment request defaults while preserving explicit request concurrency", async () => {
    configureRivetJobs(
      { stagingRoot: "/tmp/scrub-test" },
      { requestDefault: 3, runnerLimit: 2 }
    );
    const first = await contexts();
    mocks.entries = [
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
      "ccccccccccc",
      "ddddddddddd",
    ].map((id, index) => ({
      id,
      title: id,
      url: `https://youtu.be/${id}`,
      position: index + 1,
    }));
    await scrubRequest.config.actions.start(first.request, {
      url: "https://youtube.com/playlist?list=PL123",
    });
    await enumerateRequest(first.request);
    await reconcileRequest(first.request);
    expect(first.initialized).toHaveLength(3);
    const second = await contexts();
    await scrubRequest.config.actions.start(second.request, {
      url: "https://youtube.com/playlist?list=PL123",
      concurrency: 2,
    });
    await enumerateRequest(second.request);
    await reconcileRequest(second.request);
    expect(second.initialized).toHaveLength(2);
    expect(first.admission.acquire).not.toHaveBeenCalled();
    expect(second.admission.acquire).not.toHaveBeenCalled();
  });

  it("rejects invalid configuration and refuses to reset active runner permits", async () => {
    const runner = new RunnerAdmission(2);
    configureRivetJobs(
      { stagingRoot: "/tmp/scrub-test" },
      { requestDefault: 3, runnerLimit: 2 },
      runner
    );
    expect(() =>
      configureRivetJobs({ stagingRoot: "/tmp/invalid" }, { globalLimit: 1025 })
    ).toThrow(RangeError);
    expect(() =>
      configureRivetJobs(
        { stagingRoot: "/tmp/invalid" },
        { runnerLimit: 1 },
        runner
      )
    ).toThrow(/does not match/);
    const lease = runner.tryAcquire("active")!;
    try {
      expect(() => configureRivetJobs({ stagingRoot: "/tmp/new" })).toThrow(
        /active/
      );
      expect(lease.isActive()).toBe(true);
    } finally {
      lease.release();
    }
    const { request, initialized } = await contexts();
    mocks.entries = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map(
      (id, index) => ({
        id,
        title: id,
        url: `https://youtu.be/${id}`,
        position: index + 1,
      })
    );
    await scrubRequest.config.actions.start(request, {
      url: "https://youtube.com/playlist?list=PL123",
    });
    await enumerateRequest(request);
    await reconcileRequest(request);
    expect(initialized).toHaveLength(3);
  });

  it.each(["cancel", "shutdown"] as const)(
    "retains local capacity until %s cleanup finishes",
    async (mode) => {
      const runner = new RunnerAdmission(1);
      configureRivetJobs(
        { stagingRoot: "/tmp/scrub-test" },
        { runnerLimit: 1 },
        runner
      );
      const first = await contexts(),
        second = await contexts();
      const shutdown = new AbortController();
      first.video.abortSignal = shutdown.signal;
      await scrubVideo.config.actions.initialize(first.video, {
        source,
        settings: settings(),
        requestId: "request",
        videoId,
      });
      await scrubVideo.config.actions.initialize(second.video, {
        source,
        settings: settings(),
        requestId: "request",
        videoId,
      });
      let finish!: () => void;
      mocks.pipeline.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      const running = runVideoActor(first.video);
      try {
        await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(1));
        if (mode === "cancel")
          await scrubVideo.config.actions.cancel(first.video);
        else shutdown.abort();
        await runVideoActor(second.video);
        expect(runner.activeCount).toBe(1);
        expect(mocks.pipeline).toHaveBeenCalledTimes(1);
        expect(await new SqliteRunRepository(second.video.db).get()).toBeNull();
        expect(second.admission.acquire).not.toHaveBeenCalled();
      } finally {
        finish?.();
        await running;
      }
      expect(runner.activeCount).toBe(0);
    }
  );

  it("runs two video jobs locally with global admission disabled and defers a third without an attempt", async () => {
    const runner = new RunnerAdmission(2);
    configureRivetJobs(
      { stagingRoot: "/tmp/scrub-test" },
      { runnerLimit: 2 },
      runner
    );
    const fixtures = await Promise.all([contexts(), contexts(), contexts()]);
    for (const { video } of fixtures)
      await scrubVideo.config.actions.initialize(video, {
        source,
        settings: settings(),
        requestId: "request",
        videoId,
      });
    const drains: (() => void)[] = [];
    mocks.pipeline.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          drains.push(resolve);
        })
    );
    const running = fixtures.map((fixture) => runVideoActor(fixture.video));
    try {
      await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(2));
      expect(runner.activeCount).toBe(2);
      expect(
        fixtures.every(
          (fixture) => fixture.admission.acquire.mock.calls.length === 0
        )
      ).toBe(true);
      expect(
        (
          await Promise.all(
            fixtures.map((fixture) =>
              new SqliteRunRepository(fixture.video.db).get()
            )
          )
        ).every((value) => value === null)
      ).toBe(true);
    } finally {
      drains.forEach((drain) => drain());
      await Promise.all(running);
    }
    expect(runner.activeCount).toBe(0);
  });

  it("aborts at the conservative global deadline when a renewal stalls without freeing native cleanup capacity", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "performance",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const runner = new RunnerAdmission(1);
    configureRivetJobs(
      { stagingRoot: "/tmp/scrub-test" },
      { runnerLimit: 1, globalLimit: 1 },
      runner
    );
    const { video, admission } = await contexts();
    await scrubVideo.config.actions.initialize(video, {
      source,
      settings: resolveSettings({ limits: { stageTimeoutMs: 60_000 } }),
      requestId: "request",
      videoId,
    });
    admission.renew.mockImplementation(
      () => new Promise<boolean>(() => undefined)
    );
    let finish!: () => void;
    let signal!: AbortSignal;
    let cleanupAt: number | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    mocks.pipeline.mockImplementationOnce(
      (_source, _settings, _dependencies, operation) => {
        signal = operation.signal;
        return new Promise<void>((resolve) => {
          finish = () => {
            cleanupAt = performance.now();
            resolve();
          };
          // Model a process that ignores SIGTERM until the 1s SIGKILL grace ends.
          signal.addEventListener(
            "abort",
            () => {
              cleanupTimer = setTimeout(finish, 1_000);
            },
            { once: true }
          );
        });
      }
    );
    const running = runVideoActor(video);
    try {
      await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(1));
      const started = performance.now();
      await vi.advanceTimersByTimeAsync(43_000);
      expect(admission.renew).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(true);
      expect(runner.activeCount).toBe(1);
      expect(cleanupAt).toBeUndefined();
      expect((await admission.acquire("replacement", 1)).granted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cleanupAt).toBeLessThanOrEqual(started + 44_000);
      expect(runner.activeCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await admission.acquire("replacement", 1)).granted).toBe(true);
      expect(cleanupAt).toBeLessThan(performance.now());
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (cleanupAt === undefined) finish?.();
      await running;
    }
    expect(runner.activeCount).toBe(0);
  });

  it("fails closed on a checkpoint lease RPC error without persisting a nonretryable failure", async () => {
    const runner = new RunnerAdmission(1);
    configureRivetJobs(
      { stagingRoot: "/tmp/scrub-test" },
      { runnerLimit: 1, globalLimit: 1 },
      runner
    );
    const { video, admission } = await contexts();
    await scrubVideo.config.actions.initialize(video, {
      source,
      settings: settings(),
      requestId: "request",
      videoId,
    });
    // Preserve the normal first check, then inject a transient coordination fault.
    admission.validate.mockReset();
    admission.validate
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("coordination unavailable"))
      .mockResolvedValue(true);
    const failures: unknown[] = [];
    mocks.pipeline.mockImplementationOnce(
      async (_source, _settings, dependencies) => {
        await dependencies.runs.update(() => record());
        await dependencies.runs
          .update((current: RunRecord) => ({
            ...current,
            stage: "transcribe",
          }))
          .catch((error: unknown) => {
            failures.push(error);
          });
        await dependencies.runs
          .update((current: RunRecord) => ({
            ...current,
            status: "failed",
            failure: {
              code: "processing_failed",
              message: "incorrect classification",
              retryable: false,
            },
          }))
          .catch((error: unknown) => {
            failures.push(error);
          });
      }
    );
    await runVideoActor(video);
    expect(failures).toHaveLength(2);
    for (const failure of failures)
      expect(failure).toMatchObject({ code: "unavailable", retryable: true });
    expect((await new SqliteRunRepository(video.db).get())?.status).toBe(
      "running"
    );
    expect(runner.activeCount).toBe(0);
  });

  it("admits one worker globally and fences an expired holder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { admission } = await contexts();
    const first = await admission.acquire("first");
    expect(first.granted).toBe(true);
    expect((await admission.acquire("second")).granted).toBe(false);
    vi.setSystemTime(Date.now() + 46_000);
    const second = await admission.acquire("second");
    expect(second.granted).toBe(true);
    expect(second.token).toBeGreaterThan(first.token);
    expect(await admission.validate("first", first.token)).toBe(false);
    await admission.release("first", first.token);
    expect(await admission.validate("second", second.token)).toBe(true);
  });

  it("initializes idempotently and rejects a different submission for the same key", async () => {
    const { request } = await contexts();
    const first = await scrubRequest.config.actions.start(request, {
      url: source.url,
      concurrency: 2,
    });
    const repeated = await scrubRequest.config.actions.start(request, {
      concurrency: 2,
      url: source.url,
    });
    expect(repeated.id).toBe(first.id);
    expect(repeated.createdAt).toBe(first.createdAt);
    await expect(
      scrubRequest.config.actions.start(request, { url: "bbbbbbbbbbb" })
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("freezes bounded membership, limits scheduled children, and aggregates partial failure", async () => {
    const { request, statuses, initialized } = await contexts();
    mocks.entries = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map(
      (id, index) => ({
        id,
        title: id,
        url: `https://youtu.be/${id}`,
        position: index + 1,
      })
    );
    await scrubRequest.config.actions.start(request, {
      url: "https://youtube.com/playlist?list=PL123",
      maxVideos: 2,
      concurrency: 2,
    });
    await enumerateRequest(request);
    await reconcileRequest(request);
    expect(initialized).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    statuses.set("aaaaaaaaaaa", {
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 1,
    });
    statuses.set("bbbbbbbbbbb", {
      status: "failed",
      stage: "transcribe",
      progress: 35,
      attempts: 2,
      failure: {
        code: "processing_failed",
        message: "No transcript",
        retryable: false,
      },
    });
    const snapshot = await reconcileRequest(request);
    expect(snapshot).toMatchObject({
      status: "completed_with_errors",
      total: 2,
      completed: 1,
      failed: 1,
    });
    const page = await scrubRequest.config.actions.getResults(request, 0, 10);
    expect(page.total).toBe(2);
    expect(page.items[0].result?.metadata.title).toBe("aaaaaaaaaaa");
    expect(page.items[1].failure?.message).toBe("No transcript");
  });

  it("keeps scheduled reconciliation alive when a child RPC outlasts the next poll", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { request, statuses, initialized } = await contexts();
    const pending: { at: number; action: string }[] = [];
    request.schedule.after = async (delay, action) => {
      pending.push({ at: Date.now() + delay, action });
      pending.sort((left, right) => left.at - right.at);
      return "scheduled";
    };
    // Deliver only the actor's own durable schedule, without status polling or
    // another client waking it. The harness permits overlapping action delivery.
    const deliverNext = () => {
      const scheduled = pending.shift();
      expect(scheduled).toBeDefined();
      expect(scheduled!.action).toBe("tick");
      vi.setSystemTime(Math.max(Date.now(), scheduled!.at));
      return scrubRequest.config.actions.tick(request);
    };
    mocks.entries = [
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
      "ccccccccccc",
      "ddddddddddd",
    ].map((id, position) => ({
      id,
      title: id,
      url: `https://youtu.be/${id}`,
      position,
    }));
    const original = request.client() as JobActorClient;
    let blockNext = false;
    let entered!: () => void;
    let release!: () => void;
    const childEntered = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    const childReleased = new Promise<void>((resolveReleased) => {
      release = resolveReleased;
    });
    request.client = () => ({
      ...original,
      scrubVideo: {
        ...original.scrubVideo,
        getOrCreate: (key: string[]) => ({
          ...original.scrubVideo.getOrCreate(key),
          getStatus: async () => {
            if (blockNext && key[1] === "aaaaaaaaaaa") {
              blockNext = false;
              entered();
              await childReleased;
            }
            return statuses.get(key[1]) ?? null;
          },
        }),
      },
    });
    await scrubRequest.config.actions.start(request, {
      url: "https://youtube.com/playlist?list=PL123",
      concurrency: 2,
    });
    await enumerateRequest(request);
    await deliverNext();
    expect(initialized).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);

    blockNext = true;
    const slowReconciliation = deliverNext();
    await childEntered;
    expect(request.vars.ticking).toBe(true);
    // Both startup schedules have exactly one successor at the two-second poll.
    expect(pending).toHaveLength(2);
    while (pending[0]?.at <= startedAt + 2_000) await deliverNext();
    expect(pending).toHaveLength(2);
    expect(
      pending.every((scheduled) => scheduled.at === startedAt + 4_000)
    ).toBe(true);

    vi.setSystemTime(startedAt + 3_000);
    release();
    await slowReconciliation;
    for (const id of initialized)
      statuses.set(id, {
        status: "completed",
        stage: "completed",
        progress: 100,
        attempts: 1,
      });
    // Its surviving scheduled successor observes completion and dispatches the
    // remaining pair. Nothing outside the actor invokes reconciliation here.
    await deliverNext();
    expect(initialized).toEqual([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
      "ccccccccccc",
      "ddddddddddd",
    ]);
    expect(pending).toHaveLength(2);
    expect(
      await request.db.execute<{ status: string; count: number }>(
        "SELECT status, COUNT(*) AS count FROM members GROUP BY status ORDER BY status"
      )
    ).toEqual([
      { status: "completed", count: 2 },
      { status: "queued", count: 2 },
    ]);
  });

  it("does not extend a busy tick chain for terminal or missing requests", async () => {
    const { request, scheduled } = await contexts();
    request.vars.ticking = true;
    expect(await scrubRequest.config.actions.tick(request)).toBeNull();
    expect(scheduled).toEqual([]);
    request.vars.ticking = false;
    await scrubRequest.config.actions.start(request, { url: source.url });
    await scrubRequest.config.actions.cancel(request);
    scheduled.length = 0;
    request.vars.ticking = true;
    expect(await scrubRequest.config.actions.tick(request)).toMatchObject({
      status: "cancelled",
    });
    expect(scheduled).toEqual([]);
    expect(request.vars.ticking).toBe(true);
  });

  it("requires durable rearming acknowledgment without clearing another tick's ownership", async () => {
    const { request } = await contexts();
    await scrubRequest.config.actions.start(request, { url: source.url });
    request.vars.ticking = true;
    const failure = new Error("Schedule persistence unavailable");
    request.schedule.after = vi.fn(async () => {
      throw failure;
    });
    await expect(scrubRequest.config.actions.tick(request)).rejects.toBe(
      failure
    );
    expect(request.schedule.after).toHaveBeenCalledOnce();
    expect(request.vars.ticking).toBe(true);
  });

  it("persists SDK policy rejection metadata as a failed unstarted member", async () => {
    const { request } = await contexts();
    const client = request.client();
    const initialize = vi.fn(async () => {
      throw {
        code: "resource_limit",
        message: "Untrusted transport diagnostics",
        metadata: { code: "resource_limit", retryable: false },
      };
    });
    request.client = () => ({
      ...client,
      scrubVideo: {
        ...client.scrubVideo,
        getOrCreate: (key) => ({
          ...client.scrubVideo.getOrCreate(key),
          initialize,
        }),
      },
    });
    await scrubRequest.config.actions.start(request, { url: source.url });
    await enumerateRequest(request);
    expect(await reconcileRequest(request)).toMatchObject({
      status: "failed",
      total: 1,
      failed: 1,
    });
    const [row] = await request.db.execute<{
      started: number;
      details: string;
    }>("SELECT started, details FROM members");
    expect(row.started).toBe(0);
    expect(JSON.parse(row.details)).toMatchObject({
      failure: {
        code: "resource_limit",
        message: "Accepted video settings exceed current server policy",
        retryable: false,
        stage: "initialize",
      },
    });
    expect(row.details).not.toContain("Untrusted transport diagnostics");
    await reconcileRequest(request);
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("keeps an SDK initialize error with uncertain retryability pending", async () => {
    const { request } = await contexts();
    const client = request.client();
    const failure = { code: "resource_limit", message: "Reply was lost" };
    request.client = () => ({
      ...client,
      scrubVideo: {
        ...client.scrubVideo,
        getOrCreate: (key) => ({
          ...client.scrubVideo.getOrCreate(key),
          initialize: async () => {
            throw failure;
          },
        }),
      },
    });
    await scrubRequest.config.actions.start(request, { url: source.url });
    await enumerateRequest(request);
    await expect(reconcileRequest(request)).rejects.toBe(failure);
    expect(await scrubRequest.config.actions.getStatus(request)).toMatchObject({
      status: "running",
      total: 1,
      failed: 0,
    });
    const [row] = await request.db.execute<{ started: number; status: string }>(
      "SELECT started, status FROM members"
    );
    expect(row).toEqual({ started: 1, status: "queued" });
  });

  it("cancels before enumeration durably and only resets cancellation on explicit retry", async () => {
    const { request } = await contexts();
    await scrubRequest.config.actions.start(request, { url: source.url });
    expect(await scrubRequest.config.actions.cancel(request)).toMatchObject({
      status: "cancelled",
    });
    await enumerateRequest({
      ...request,
      vars: { active: false, ticking: false, controller: null },
    });
    expect(await scrubRequest.config.actions.getStatus(request)).toMatchObject({
      status: "cancelled",
      total: 0,
    });
    expect(await scrubRequest.config.actions.retry(request)).toMatchObject({
      status: "queued",
    });
    await enumerateRequest(request);
    expect(await scrubRequest.config.actions.getStatus(request)).toMatchObject({
      total: 1,
      status: "running",
    });
  });

  it("does not clear cancellation while an older reconciliation is still awaiting a child", async () => {
    const { request } = await contexts();
    await scrubRequest.config.actions.start(request, { url: source.url });
    await scrubRequest.config.actions.cancel(request);
    request.vars.ticking = true;
    await expect(
      scrubRequest.config.actions.retry(request)
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(await scrubRequest.config.actions.getStatus(request)).toMatchObject({
      status: "cancelled",
    });
    request.vars.ticking = false;
    expect(await scrubRequest.config.actions.retry(request)).toMatchObject({
      status: "queued",
    });
  });

  it("requeues enumeration interrupted by runner shutdown and recovers without a user retry", async () => {
    const { request, wakes } = await contexts();
    await scrubRequest.config.actions.start(request, { url: source.url });
    const shutdown = new AbortController();
    shutdown.abort();
    await enumerateRequest({ ...request, abortSignal: shutdown.signal });
    expect(await scrubRequest.config.actions.getStatus(request)).toMatchObject({
      status: "queued",
      failure: { code: "unavailable", retryable: true },
    });
    expect(wakes.at(-1)).toBeGreaterThan(Date.now());
    await enumerateRequest({
      ...request,
      vars: { active: false, ticking: false, controller: null },
    });
    const recovered = await scrubRequest.config.actions.getStatus(request);
    expect(recovered).toMatchObject({ status: "running", total: 1 });
    expect(recovered).not.toHaveProperty("failure");
  });

  it("cancels active and pending children when continueOnError is false", async () => {
    const { request, statuses, cancelled } = await contexts();
    mocks.entries = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map(
      (id, index) => ({
        id,
        title: id,
        url: `https://youtu.be/${id}`,
        position: index + 1,
      })
    );
    await scrubRequest.config.actions.start(request, {
      url: "https://youtube.com/playlist?list=PL123",
      concurrency: 2,
      continueOnError: false,
    });
    await enumerateRequest(request);
    await reconcileRequest(request);
    statuses.set("aaaaaaaaaaa", {
      status: "failed",
      stage: "download",
      progress: 10,
      attempts: 1,
      failure: {
        code: "invalid_source",
        message: "Unavailable",
        retryable: false,
      },
    });
    await reconcileRequest(request);
    expect(cancelled).toContain("bbbbbbbbbbb");
    const page = await scrubRequest.config.actions.getResults(request, 0, 10);
    expect(
      page.items.find((item) => item.videoId === "ccccccccccc")?.status
    ).toBe("cancelled");
  });

  it("recovers persisted checkpoints after an interrupted worker and fences its old repository", async () => {
    const { video, wakes } = await contexts();
    await scrubVideo.config.actions.initialize(video, {
      source,
      settings: settings(),
      requestId: "request",
      videoId,
    });
    let oldRepository: SqliteRunRepository | undefined;
    mocks.pipeline.mockImplementationOnce(
      async (_source, _settings, dependencies) => {
        oldRepository = dependencies.runs;
        await dependencies.runs.update(() =>
          record({
            checkpoints: {
              frames: {
                frames: [],
                manifest: {
                  id: "frames",
                  kind: "frames/json",
                  mediaType: "application/json",
                  size: 2,
                },
              },
            },
          })
        );
        throw new Error("runner interrupted");
      }
    );
    await runVideoActor(video);
    expect(wakes.at(-1)).toBeGreaterThan(Date.now());
    mocks.pipeline.mockImplementationOnce(
      async (_source, _settings, dependencies) => {
        expect(
          (await dependencies.runs.get()).checkpoints.frames.manifest.id
        ).toBe("frames");
        await dependencies.runs.update((current: RunRecord) => ({
          ...current,
          revision: 2,
          attempts: 2,
          status: "completed",
        }));
      }
    );
    await runVideoActor({
      ...video,
      vars: { active: false, controller: null },
    });
    expect((await new SqliteRunRepository(video.db).get())?.status).toBe(
      "completed"
    );
    await expect(
      oldRepository!.update((current) => ({ ...current!, revision: 99 }))
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not exceed the persisted retry budget and schedules retryable failures", async () => {
    const { video, wakes } = await contexts();
    await scrubVideo.config.actions.initialize(video, {
      source,
      settings: settings(),
      requestId: "request",
      videoId,
    });
    mocks.pipeline.mockImplementationOnce(
      async (_source, _settings, dependencies) => {
        await dependencies.runs.update(() =>
          record({
            status: "failed",
            failure: { code: "timeout", message: "Retry", retryable: true },
          })
        );
        throw new PipelineError("timeout", "Retry", { retryable: true });
      }
    );
    await runVideoActor(video);
    expect(await scrubVideo.config.actions.getStatus(video)).toMatchObject({
      status: "queued",
      stage: "retry_wait",
    });
    expect(wakes.at(-1)).toBeGreaterThan(Date.now());
    await new SqliteDocuments(video.db).update<RunRecord>("run", (current) => ({
      ...current!,
      status: "running",
      attempts: 2,
    }));
    await runVideoActor({
      ...video,
      vars: { active: false, controller: null },
    });
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
    expect(await scrubVideo.config.actions.getStatus(video)).toMatchObject({
      status: "failed",
      attempts: 2,
      failure: { code: "attempt_limit" },
    });
    expect(wakes.at(-1)).toBeNull();
  });
});

describe("Rivet inference composition", () => {
  it("applies lower runtime resource defaults and rejects explicit raises before creating a request", async () => {
    configureRivetSubmissionPolicy({
      resourceCeilings: { maxSourceBytes: 1024, maxAttempts: 2 },
    });
    const { request } = await contexts();
    await scrubRequest.config.actions.start(request, { url: source.url });
    expect(await new SqliteDocuments(request.db).get("request")).toMatchObject({
      settings: { limits: { maxSourceBytes: 1024, maxAttempts: 2 } },
    });
    const other = await contexts();
    await expect(
      scrubRequest.config.actions.start(other.request, {
        url: source.url,
        settings: { limits: { maxSourceBytes: 1025 } },
      })
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(
      await new SqliteDocuments(other.request.db).get("request")
    ).toBeNull();
  });
  const full = {
    mode: "full" as const,
    summary: { provider: "openai", model: "gpt-6-luna" },
    vision: { provider: "openai", model: "gpt-6-luna" },
    limits: { maxModelCalls: 10 },
  };
  const models = {
    supports: (selection: { provider: string; model: string }) =>
      selection.provider === "openai" && selection.model === "gpt-6-luna",
    generate: vi.fn(),
  };

  it("fails new full requests before persisting or scheduling media when credentials are missing", async () => {
    configureRivetInference({ defaults: full });
    const { request, scheduled } = await contexts();
    await expect(
      scrubRequest.config.actions.start(request, { url: source.url })
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await new SqliteDocuments(request.db).get("request")).toBeNull();
    expect(scheduled).toEqual([]);
    expect(mocks.pipeline).not.toHaveBeenCalled();
  });

  it("merges partial full selections, enforces model allowlists and request ceilings", async () => {
    configureRivetInference({ defaults: full, models });
    const { request } = await contexts();
    await scrubRequest.config.actions.start(request, {
      url: source.url,
      settings: { inference: { mode: "full", limits: { maxModelCalls: 5 } } },
    });
    const saved = await new SqliteDocuments(request.db).get<{
      settings: { inference: unknown };
    }>("request");
    expect(saved?.settings.inference).toMatchObject({
      mode: "full",
      summary: full.summary,
      vision: full.vision,
      limits: { maxModelCalls: 5 },
    });
    for (const inference of [
      { summary: { provider: "anthropic", model: "claude-sonnet-5-5" } },
      { limits: { maxModelCalls: 11 } },
      { limits: null },
      { apiKey: "must-never-be-persisted" },
      { baseURL: "https://example.invalid" },
    ]) {
      const other = await contexts();
      await expect(
        scrubRequest.config.actions.start(other.request, {
          url: source.url,
          settings: { inference: inference as never },
        })
      ).rejects.toThrow();
      expect(
        await new SqliteDocuments(other.request.db).get("request")
      ).toBeNull();
    }
  });

  it("preserves stored defaults and supports completed reads with credentials removed", async () => {
    const resolveModels = vi.fn(async () => models);
    configureRivetInference({ defaults: full, resolveModels });
    const { request } = await contexts();
    await scrubRequest.config.actions.start(request, {
      url: source.url,
      settings: { inference: { mode: "full" } },
    });
    const before = await new SqliteDocuments(request.db).get("request");
    expect(resolveModels).toHaveBeenCalledTimes(1);
    configureRivetInference({
      defaults: {
        ...full,
        summary: { provider: "anthropic", model: "claude-sonnet-5-5" },
        limits: { maxModelCalls: 1 },
      },
    });
    await scrubRequest.config.actions.start(request, {
      url: source.url,
      settings: { inference: { mode: "full" } },
    });
    expect(await new SqliteDocuments(request.db).get("request")).toEqual(
      before
    );
    await expect(
      scrubRequest.config.actions.getStatus(request)
    ).resolves.not.toBeNull();
    expect(resolveModels).toHaveBeenCalledTimes(1);
  });

  it("allows explicit preprocess requests without reading provider credentials", async () => {
    const resolveModels = vi.fn(async () => {
      throw new Error("credential resolution must not run");
    });
    configureRivetInference({ defaults: full, resolveModels });
    const { request } = await contexts();
    await scrubRequest.config.actions.start(request, {
      url: source.url,
      settings: { inference: { mode: "preprocess" } },
    });
    expect(resolveModels).not.toHaveBeenCalled();
    expect(await new SqliteDocuments(request.db).get("request")).toMatchObject({
      settings: { inference: { mode: "preprocess" } },
    });
  });

  it("passes a freshly resolved server-only model gateway into the shared worker", async () => {
    const resolveModels = vi.fn(async () => models);
    configureRivetInference({ defaults: full, resolveModels });
    const { video } = await contexts();
    await scrubVideo.config.actions.initialize(video, {
      source,
      settings: settings(),
      requestId: "request",
      videoId,
    });
    await runVideoActor(video);
    expect(resolveModels).toHaveBeenCalledTimes(2);
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
    expect(mocks.pipeline.mock.calls[0][2].models).toBe(models);
    expect(mocks.pipeline.mock.calls[0][1].inference.mode).toBe("full");
  });
});

describe("server-only Rivet job gateway", () => {
  it.each([
    ["capability_unavailable", false],
    ["model_authentication_failed", false],
    ["model_refused", false],
    ["invalid_model_output", true],
  ])(
    "preserves safe %s errors and retry policy across the SDK boundary",
    async (code, retryable) => {
      const body = "test-only-sensitive-provider-error-body";
      const start = vi.fn().mockRejectedValue({
        code: "user_error",
        message: body,
        metadata: { code, retryable, stage: "summary" },
      });
      const client = {
        scrubRequest: { getOrCreate: () => ({ start }) },
      } as unknown as JobActorClient;
      const gateway = new RivetJobGateway(
        { endpoint: "https://example.invalid", token: "test-only" },
        client
      );
      const failure = await gateway
        .submit({ url: source.url })
        .catch((error) => error);
      expect(failure).toBeInstanceOf(PipelineError);
      expect(failure).toMatchObject({ code, retryable, stage: "summary" });
      expect(failure.cause).toBeUndefined();
      expect(JSON.stringify(failure)).not.toContain(body);
      if (code === "capability_unavailable")
        expect(failure.message).toContain("configure credentials");
      start.mockRejectedValueOnce({
        code,
        message: body,
        metadata: { stage: body },
      });
      const direct = await gateway
        .submit({ url: source.url })
        .catch((error) => error);
      expect(direct.code).toBe(code);
      expect(direct.retryable).toBe(false);
      expect(direct.stage).toBeUndefined();
      expect(JSON.stringify(direct)).not.toContain(body);
    }
  );

  it.each([
    null,
    { code: 123 },
    { code: "unexpected", message: "test-only-sensitive-error" },
  ])(
    "turns malformed or unknown SDK errors into safe retryable unavailability",
    async (error) => {
      const start = vi.fn().mockRejectedValue(error);
      const client = {
        scrubRequest: { getOrCreate: () => ({ start }) },
      } as unknown as JobActorClient;
      const gateway = new RivetJobGateway(
        { endpoint: "https://example.invalid", token: "test-only" },
        client
      );
      await expect(gateway.submit({ url: source.url })).rejects.toMatchObject({
        code: "unavailable",
        retryable: true,
        message: "Rivet job service is unavailable",
      });
    }
  );

  it("uses deterministic idempotent request keys and enforces artifact membership", async () => {
    const start = vi.fn(async () => ({ id: "id", status: "queued" }));
    const getOrCreate = vi.fn(() => ({ start }));
    const hasVideo = vi.fn(async () => false);
    const readArtifact = vi.fn();
    const client = {
      scrubRequest: { getOrCreate, get: () => ({ hasVideo }) },
      scrubVideo: { get: () => ({ readArtifact }) },
    } as unknown as JobActorClient;
    const gateway = new RivetJobGateway(
      { endpoint: "https://example.invalid", token: "test-only" },
      client
    );
    await gateway.submit({ url: source.url }, "same-key");
    await gateway.submit({ url: source.url }, "same-key");
    expect(getOrCreate.mock.calls[0]).toEqual(getOrCreate.mock.calls[1]);
    await expect(
      gateway.artifact("request", videoId, "artifact", 0, 1)
    ).rejects.toMatchObject({ code: "not_found" });
    expect(readArtifact).not.toHaveBeenCalled();
  });
});
