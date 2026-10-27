import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JobSnapshot,
  SourceCatalog,
} from "../../src/application/contracts.js";
import type { StructuredModelGateway } from "../../src/application/model.js";
import { PipelineError, throwIfAborted } from "../../src/core/errors.js";
import { parseYouTubeSource } from "../../src/core/source.js";
import {
  LocalJobRuntime,
  type LocalJobRuntimeOptions,
} from "../../src/infrastructure/node/jobs/LocalJobRuntime.js";
import { LocalDatabase } from "../../src/infrastructure/node/jobs/LocalDatabase.js";
import {
  LocalRunRepository,
  LocalVideoRepository,
} from "../../src/infrastructure/node/jobs/LocalRepositories.js";
import { resolveSettings } from "../../src/application/settings.js";

const first = "dQw4w9WgXcQ";
const second = "aaaaaaaaaaa";
const source = { url: `https://youtu.be/${first}` };
const roots: string[] = [];
const runtimes: LocalJobRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "scrub-local-jobs-"));
  roots.push(path);
  return path;
}
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean
): Promise<T> {
  const end = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > end)
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await delay(10);
  }
}
const finished = (value: JobSnapshot | null) =>
  !!value &&
  ["completed", "failed", "cancelled", "completed_with_errors"].includes(
    value.status
  );
function summary() {
  return {
    tldr: "Durable fixture results",
    overview: "A persisted full processing result.",
    thesisAndClaims: { thesis: "Persist work", keyClaims: [] },
    actionableInsights: [],
    concepts: [],
    mentalModels: [],
    structureMap: [],
    openQuestions: [],
    notableQuotes: [],
    biasAnalysis: {
      perspective: "Fixture",
      possibleBiases: [],
      blindSpots: [],
    },
    knowledgeGraph: {
      topics: [],
      people: [],
      tools: [],
      technologies: [],
      relationships: [],
    },
    difficulty: {
      level: "beginner",
      prerequisites: [],
      targetAudience: "Developers",
    },
    reusabilityPrompts: {},
    confidence: { level: "high", reasoning: "Fixture" },
    sections: [],
    keyTakeaways: [],
    codeSnippets: [],
    references: [],
  };
}
function fixture(
  dataRoot: string,
  overrides: Partial<LocalJobRuntimeOptions> = {}
) {
  const model = vi.fn(
    async (request: Parameters<StructuredModelGateway["generate"]>[0]) => ({
      value:
        request.schemaName === "ScrubFrameAnalysis"
          ? {
              description: "Fixture diagram",
              extractedText: "save()",
              visualType: "diagram",
            }
          : summary(),
      provider: request.selection.provider,
      model: request.selection.model,
    })
  );
  const models: StructuredModelGateway = {
    supports: () => true,
    generate: model,
  };
  const catalog: SourceCatalog = {
    enumerate: async (url) => {
      const parsed = parseYouTubeSource(url);
      const ids = parsed.playlistId
        ? [first, second, first]
        : [parsed.videoId!];
      return {
        metadata: {
          playlistId: parsed.playlistId ?? first,
          title: "Fixture",
          channel: "Fixture",
          videoCount: ids.length,
        },
        entries: (async function* () {
          for (const [position, id] of ids.entries())
            yield {
              contentId: id,
              title: id,
              url: `https://youtu.be/${id}`,
              position,
            };
        })(),
      };
    },
  };
  const acquired = vi.fn();
  const transcribed = vi.fn();
  const options: LocalJobRuntimeOptions = {
    dataRoot,
    native: { stagingRoot: join(dataRoot, "scratch") },
    inferenceDefaults: {
      mode: "full",
      summary: { provider: "fixture", model: "summary" },
      vision: { provider: "fixture", model: "vision" },
    },
    models,
    catalog,
    pollMs: 10,
    retryMs: 10,
    ownershipMs: 1_000,
    pipelineDependencies: (initialization, defaults) => ({
      ...defaults,
      media: {
        acquire: async (_source, _settings, context) => {
          throwIfAborted(context.signal);
          acquired(initialization.videoId);
          return {
            metadata: {
              contentId: initialization.videoId,
              title: initialization.videoId,
              description: "Fixture",
              duration: 30,
              thumbnailUrl: "",
              source: "YouTube",
              uploadDate: "2026-01-01",
              url: `https://youtu.be/${initialization.videoId}`,
            },
            audio: await defaults.artifacts.put(
              "source/audio",
              new Uint8Array([1, 2]),
              "audio/wav"
            ),
            video: await defaults.artifacts.put(
              "source/video",
              new Uint8Array([3, 4]),
              "video/mp4"
            ),
          };
        },
        extractFrames: async () => [
          {
            timestamp: 1,
            artifact: await defaults.artifacts.put(
              "frames/image",
              new Uint8Array([5, 6]),
              "image/png"
            ),
          },
        ],
      },
      transcriber: {
        transcribe: async (_request, _settings, context) => {
          throwIfAborted(context.signal);
          transcribed(initialization.videoId);
          return {
            fullText: "Persist fixture work",
            segments: [{ start: 0, end: 5, text: "Persist fixture work" }],
            language: "en",
            duration: 30,
            source: "fixture",
          };
        },
      },
    }),
    ...overrides,
  };
  const runtime = new LocalJobRuntime(options);
  runtimes.push(runtime);
  runtime.start();
  return { runtime, model, acquired, transcribed, options };
}

describe("persistent standalone job runtime", () => {
  it("runs full playlist work, deduplicates membership, pages results, and restricts artifact ownership", async () => {
    const f = fixture(await root());
    const accepted = await f.runtime.jobs.submit(
      {
        url: "https://www.youtube.com/playlist?list=PL_fixture123",
        concurrency: 2,
      },
      "playlist"
    );
    expect(accepted.status).toBe("queued");
    const complete = await until(
      () => f.runtime.jobs.get(accepted.id),
      finished
    );
    expect(complete).toMatchObject({
      status: "completed",
      total: 2,
      completed: 2,
    });
    expect(f.acquired).toHaveBeenCalledTimes(2);
    expect(f.model).toHaveBeenCalledTimes(4);
    const page = await f.runtime.jobs.results(accepted.id, 1, 1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    const markdown = item.result!.inference!.markdown;
    const block = await f.runtime.jobs.artifact(
      accepted.id,
      item.videoId,
      markdown.id,
      0,
      16
    );
    expect(block.bytes.length).toBe(16);
    expect(block.mediaType).toContain("markdown");
    await expect(
      f.runtime.jobs.artifact(accepted.id, "bbbbbbbbbbb", markdown.id, 0, 16)
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await f.runtime.jobs.get("missing")).toBeNull();
  });

  it("reopens completed results without model credentials and keeps idempotency defaults stable", async () => {
    const directory = await root();
    const firstRuntime = fixture(directory);
    const job = await firstRuntime.runtime.jobs.submit(source, "same");
    await until(() => firstRuntime.runtime.jobs.get(job.id), finished);
    await firstRuntime.runtime.close();
    const next = fixture(directory, { models: undefined, requestDefault: 4 });
    const replay = await next.runtime.jobs.submit(source, "same");
    expect(replay.id).toBe(job.id);
    expect(replay.status).toBe("completed");
    expect(
      (await next.runtime.jobs.results(job.id, 0, 1)).items[0].result?.inference
        ?.markdown
    ).toBeDefined();
    await expect(
      next.runtime.jobs.submit({ ...source, concurrency: 2 }, "same")
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(next.acquired).not.toHaveBeenCalled();
  });

  it("recovers interrupted work from checkpoints instead of turning host shutdown into cancellation", async () => {
    const directory = await root();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let base!: LocalJobRuntimeOptions;
    const setup = fixture(directory);
    base = setup.options;
    await setup.runtime.close();
    const paused = fixture(directory, {
      pipelineDependencies: (initialization, defaults) => {
        const deps = base.pipelineDependencies!(initialization, defaults);
        return {
          ...deps,
          transcriber: {
            transcribe: async (_input, _settings, operation) => {
              entered();
              await new Promise<void>((_resolve, reject) =>
                operation.signal.addEventListener(
                  "abort",
                  () => reject(operation.signal.reason),
                  { once: true }
                )
              );
              throw new Error("unreachable");
            },
          },
        };
      },
    });
    const job = await paused.runtime.jobs.submit(source, "recover");
    await started;
    await paused.runtime.close();
    const next = fixture(directory);
    const recovered = await until(
      () => next.runtime.jobs.get(job.id),
      finished
    );
    expect(recovered?.status).toBe("completed");
    expect(next.acquired).not.toHaveBeenCalled();
    expect(next.transcribed).toHaveBeenCalledOnce();
    const bytes = await readFile(join(directory, "jobs.sqlite"));
    expect(bytes.includes(Buffer.from('cancelRequested":true'))).toBe(false);
  });

  it("durably cancels active work and retries it only after cleanup", async () => {
    const directory = await root();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let block = true;
    const setup = fixture(directory);
    const base = setup.options;
    await setup.runtime.close();
    const f = fixture(directory, {
      pipelineDependencies: (initialization, defaults) => {
        const deps = base.pipelineDependencies!(initialization, defaults);
        return {
          ...deps,
          transcriber: {
            transcribe: async (input, settings, operation) => {
              if (block) {
                entered();
                await new Promise<void>((_resolve, reject) =>
                  operation.signal.addEventListener(
                    "abort",
                    () => reject(operation.signal.reason),
                    { once: true }
                  )
                );
              }
              return deps.transcriber.transcribe(input, settings, operation);
            },
          },
        };
      },
    });
    const job = await f.runtime.jobs.submit(source);
    await started;
    expect((await f.runtime.jobs.cancel(job.id)).status).toBe("cancelled");
    await delay(30);
    block = false;
    await f.runtime.jobs.retry(job.id);
    expect(
      (await until(() => f.runtime.jobs.get(job.id), finished))?.status
    ).toBe("completed");
  });

  it("rejects simultaneous runtime ownership and recovers the commit-before-enqueue gap", async () => {
    const directory = await root();
    const f = fixture(directory);
    expect(() => new LocalJobRuntime(f.options)).toThrow(/active runtime/);
    const job = await f.runtime.jobs.submit(source);
    await f.runtime.close();
    const db = new LocalDatabase(join(directory, "jobs.sqlite"));
    db.acquire("repair-test", 1_000);
    db.write(() => {
      db.sql.prepare("DELETE FROM local_wakeups").run();
    });
    db.close();
    const next = fixture(directory);
    expect(
      (await until(() => next.runtime.jobs.get(job.id), finished))?.status
    ).toBe("completed");
  });

  it("fences an expired runtime and stale per-attempt checkpoint writers", async () => {
    const directory = await root();
    const file = join(directory, "fences.sqlite");
    const old = new LocalDatabase(file);
    old.acquire("old", 1);
    await delay(5);
    const current = new LocalDatabase(file);
    current.acquire("new", 1_000);
    expect(() => old.update("a", "b", () => ({}))).toThrow(/ownership/);
    current.update("video", "attempt", () => "new");
    const stale = new LocalRunRepository(current, "video", "old");
    await expect(
      stale.update(() => {
        throw new Error("must not run");
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    old.close();
    current.close();
  });

  it("enforces deployment resource ceilings and preflights full mode before creating work", async () => {
    const f = fixture(await root(), { models: undefined });
    await expect(f.runtime.jobs.submit(source)).rejects.toMatchObject({
      code: "capability_unavailable",
    });
    expect(f.acquired).not.toHaveBeenCalled();
    await expect(
      f.runtime.jobs.submit({
        ...source,
        settings: { limits: { maxSourceBytes: 1_000_000_000 } },
      })
    ).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("keeps saved artifact reads available after new-write ceilings are lowered", async () => {
    const directory = await root();
    const firstRuntime = fixture(directory);
    const job = await firstRuntime.runtime.jobs.submit(source);
    await until(() => firstRuntime.runtime.jobs.get(job.id), finished);
    const item = (await firstRuntime.runtime.jobs.results(job.id, 0, 1))
      .items[0];
    const ref = item.result!.inference!.markdown;
    await firstRuntime.runtime.close();
    const next = fixture(directory, {
      resourceCeilings: { maxSourceBytes: 1, maxArtifactBytes: 1 },
      models: undefined,
    });
    expect(
      (await next.runtime.jobs.artifact(job.id, item.videoId, ref.id, 0, 16))
        .bytes
    ).toHaveLength(16);
  });

  it("durably reports a newly blocked child instead of polling an accepted request forever", async () => {
    const directory = await root();
    const setup = fixture(directory);
    await setup.runtime.close();
    const accepting = new LocalJobRuntime(setup.options);
    runtimes.push(accepting);
    const job = await accepting.jobs.submit(source);
    await accepting.close();
    const next = fixture(directory, {
      resourceCeilings: { maxSourceBytes: 1 },
    });
    expect(
      (await until(() => next.runtime.jobs.get(job.id), finished))?.status
    ).toBe("failed");
    expect(
      (await next.runtime.jobs.results(job.id, 0, 1)).items[0].failure?.code
    ).toBe("resource_limit");
    expect(next.acquired).not.toHaveBeenCalled();
  });

  it("does not leak data-root ownership when configuration is rejected", async () => {
    const directory = await root();
    const setup = fixture(directory);
    await setup.runtime.close();
    expect(
      () =>
        new LocalJobRuntime({
          ...setup.options,
          inferenceDefaults: { mode: "full", limits: { maxModelCalls: 0 } },
        })
    ).toThrow();
    const next = fixture(directory);
    expect((await next.runtime.jobs.submit(source)).status).toBe("queued");
  });

  it("quarantines a corrupt job while independent jobs continue processing", async () => {
    const f = fixture(await root());
    const bad = await f.runtime.jobs.submit(source);
    f.runtime.database.write(() =>
      f.runtime.database.sql
        .prepare(
          "UPDATE local_documents SET value = ? WHERE scope = ? AND name = 'request'"
        )
        .run("{broken", bad.id)
    );
    const good = await f.runtime.jobs.submit({
      url: `https://youtu.be/${second}`,
    });
    expect(
      (await until(() => f.runtime.jobs.get(good.id), finished))?.status
    ).toBe("completed");
    await expect(f.runtime.jobs.get(bad.id)).rejects.toMatchObject({
      code: "storage_error",
    });
    expect(
      (
        f.runtime.database.sql
          .prepare(
            "SELECT COUNT(*) AS count FROM local_quarantine WHERE scope = ?"
          )
          .get(bad.id) as { count: number }
      ).count
    ).toBeGreaterThan(0);
  });

  it("holds native capacity until cancellation cleanup finishes across requests", async () => {
    const directory = await root();
    const setup = fixture(directory);
    const base = setup.options;
    await setup.runtime.close();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cleaning!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      cleaning = resolve;
    });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired: string[] = [];
    const f = fixture(directory, {
      runnerLimit: 1,
      pipelineDependencies: (initialization, defaults) => {
        const deps = base.pipelineDependencies!(initialization, defaults);
        return {
          ...deps,
          media: {
            ...deps.media,
            acquire: async (...args) => {
              acquired.push(initialization.videoId);
              return deps.media.acquire(...args);
            },
          },
          transcriber: {
            transcribe: async (input, settings, operation) => {
              if (initialization.videoId === first) {
                entered();
                await new Promise<void>((_resolve, reject) =>
                  operation.signal.addEventListener(
                    "abort",
                    () => {
                      cleaning();
                      void cleanup.then(() => reject(operation.signal.reason));
                    },
                    { once: true }
                  )
                );
              }
              return deps.transcriber.transcribe(input, settings, operation);
            },
          },
        };
      },
    });
    const one = await f.runtime.jobs.submit(source);
    await started;
    await f.runtime.jobs.cancel(one.id);
    await cleanupStarted;
    let two!: JobSnapshot;
    try {
      two = await f.runtime.jobs.submit({ url: `https://youtu.be/${second}` });
      await delay(50);
      expect(acquired).toEqual([first]);
    } finally {
      release();
    }
    expect(
      (await until(() => f.runtime.jobs.get(two.id), finished))?.status
    ).toBe("completed");
    expect(acquired).toEqual([first, second]);
  });

  it("does not starve reconciliation behind a backlog of capacity-blocked native work", async () => {
    const db = new LocalDatabase(join(await root(), "fair.sqlite"));
    db.acquire("fairness", 10_000);
    try {
      for (let index = 0; index < 101; index++)
        db.wake("video", String(index), Date.now() - 100);
      db.wake("request", "coordinator", Date.now());
      expect(db.due(10)).toHaveLength(10);
      expect(
        db
          .due(10)
          .some(
            (work) => work.kind === "request" && work.scope === "coordinator"
          )
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("persists pre-initialization cancellation and fences a first-run checkpoint", async () => {
    const db = new LocalDatabase(join(await root(), "cancel.sqlite"));
    db.acquire("cancel", 10_000);
    try {
      const repository = new LocalVideoRepository(db, "video");
      await repository.updateCancellation(true, (current) => current);
      const initialization = {
        requestId: "request",
        videoId: first,
        source: { kind: "youtube" as const, url: source.url },
        settings: resolveSettings(),
      };
      expect(await repository.initialize(initialization)).toBeNull();
      expect(await repository.getInitialization()).toBeNull();
      expect(await repository.getCancellationRequested()).toBe(true);
      await repository.updateCancellation(false, (current) => current);
      expect(await repository.initialize(initialization)).toEqual(
        initialization
      );
      await repository.updateCancellation(true, (current) => current);
      await repository.runs.update(() => ({
        revision: 1,
        status: "running",
        source: initialization.source,
        settings: initialization.settings,
        cacheKey: "fixture",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stage: "queued",
        progress: 0,
        attempts: 1,
        cancelRequested: false,
        checkpoints: {},
      }));
      expect((await repository.runs.get())?.cancelRequested).toBe(true);
      await expect(
        repository.runs.update((current) => ({
          ...current!,
          status: "completed",
        }))
      ).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      db.close();
    }
  });
});
