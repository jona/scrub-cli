import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVideoPipeline } from "../../src/application/pipeline.js";
import { resolveSettings } from "../../src/application/settings.js";
import {
  readArtifactBytes,
  readArtifactJson,
  resultArtifacts,
} from "../../src/application/artifact-io.js";
import type { StructuredModelGateway } from "../../src/application/model.js";
import { formatStructuredModelPrompt } from "../../src/application/model.js";
import {
  buildSummaryPrompt,
  SUMMARY_SCHEMA,
} from "../../src/core/summary-template.js";
import type {
  ArtifactRef,
  ArtifactStorage,
  MediaSource,
  OperationContext,
  PipelineEvent,
} from "../../src/application/contracts.js";
import { PipelineError, throwIfAborted } from "../../src/core/errors.js";
import { MemoryArtifactStorage } from "../helpers/memory/ArtifactStorage.js";
import { MemoryRunRepository } from "../helpers/memory/RunRepository.js";
import { FilesystemArtifactStorage } from "../../src/infrastructure/node/FilesystemArtifactStorage.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function fixture(storage: ArtifactStorage, id = "dQw4w9WgXcQ") {
  const source: MediaSource = {
    kind: "youtube",
    url: `https://youtu.be/${id}`,
  };
  const runs = new MemoryRunRepository();
  const settings = resolveSettings();
  const controller = new AbortController();
  const events: PipelineEvent[] = [];
  let clock = 1_700_000_000_000;
  const context: OperationContext = {
    runId: id,
    attemptId: "attempt-1",
    signal: controller.signal,
    now: () => clock++,
    emit: (event) => {
      events.push(event);
    },
  };
  const media = {
    acquire: vi.fn(
      async (
        _source: MediaSource,
        _settings: unknown,
        operation: OperationContext
      ) => {
        throwIfAborted(operation.signal);
        return {
          metadata: {
            contentId: id,
            title: `Notes ${id}`,
            description: "",
            duration: 30,
            thumbnailUrl: "",
            source: "YouTube",
            uploadDate: "2026-01-01",
            url: `https://www.youtube.com/watch?v=${id}`,
          },
          audio: await storage.put(
            "source/audio",
            new Uint8Array([1, 2, 3]),
            "audio/wav"
          ),
          video: await storage.put(
            "source/video",
            new Uint8Array([4, 5, 6]),
            "video/mp4"
          ),
        };
      }
    ),
    extractFrames: vi.fn(
      async (
        _video: ArtifactRef,
        _settings: unknown,
        operation: OperationContext
      ) => {
        throwIfAborted(operation.signal);
        return [
          {
            timestamp: 5,
            artifact: await storage.put(
              "frames/image",
              new Uint8Array([7, 8, 9]),
              "image/png"
            ),
          },
        ];
      }
    ),
  };
  const transcriber = {
    transcribe: vi.fn(
      async (
        _request: unknown,
        _settings: unknown,
        operation: OperationContext
      ) => {
        throwIfAborted(operation.signal);
        return {
          segments: [{ start: 0, end: 5, text: `Hello ${id}` }],
          fullText: `Hello ${id}`,
          language: "en",
          duration: 30,
          source: "test-provider",
        };
      }
    ),
  };
  const dependencies = { artifacts: storage, runs, media, transcriber };
  const run = () => runVideoPipeline(source, settings, dependencies, context);
  return {
    source,
    settings,
    controller,
    context,
    events,
    dependencies,
    runs,
    media,
    transcriber,
    run,
  };
}

/** Simulate evicted blobs; a successful republish restores their visibility. */
function controllableStorage(base: ArtifactStorage) {
  const missing = new Set<string>();
  let failKind: string | null = null;
  const storage: ArtifactStorage = {
    put: async (kind, data, mediaType) => {
      if (kind === failKind)
        throw new PipelineError(
          "storage_error",
          "Injected publication failure",
          { retryable: true }
        );
      const ref = await base.put(kind, data, mediaType);
      missing.delete(ref.id);
      return ref;
    },
    has: async (ref) => !missing.has(ref.id) && (await base.has(ref)),
    read: async function* (ref) {
      if (missing.has(ref.id))
        throw new PipelineError("artifact_missing", "Evicted artifact");
      yield* base.read(ref);
    },
    readRange: (ref, offset, length) => base.readRange(ref, offset, length),
  };
  return {
    storage,
    missing,
    failPublication: (kind: string | null) => {
      failKind = kind;
    },
  };
}

function fullSummary() {
  return {
    tldr: "Checkpointed processing produces a reusable artifact.",
    overview: "A source-grounded explanation of durable processing.",
    thesisAndClaims: {
      thesis: "Persist completed work",
      keyClaims: [{ claim: "Resume completed steps", evidence: "The example" }],
    },
    actionableInsights: [{ action: "Persist stage artifacts" }],
    concepts: [
      { concept: "Checkpoint", definition: "A completed durable step" },
    ],
    mentalModels: [],
    structureMap: [],
    openQuestions: [],
    notableQuotes: [],
    biasAnalysis: {
      perspective: "Practical",
      possibleBiases: [],
      blindSpots: [],
    },
    knowledgeGraph: {
      topics: ["Durability"],
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
    confidence: { level: "high", reasoning: "Direct source evidence" },
    sections: [
      {
        title: "Durable steps",
        startTime: 0,
        endTime: 30,
        content: "Persist the result.",
      },
    ],
    keyTakeaways: ["Resume completed work"],
    codeSnippets: [],
    references: [],
  };
}

function fullPipelineFixture() {
  const controlled = controllableStorage(new MemoryArtifactStorage());
  const f = fixture(controlled.storage);
  f.settings.inference = resolveSettings({
    inference: {
      mode: "full",
      summary: { provider: "openai", model: "allowed-summary" },
      vision: { provider: "anthropic", model: "allowed-vision" },
      includeFullTranscript: true,
    },
  }).inference;
  const generate = vi.fn<StructuredModelGateway["generate"]>(
    async (request) => ({
      value:
        request.schemaName === "ScrubFrameAnalysis"
          ? {
              description: "A state diagram",
              extractedText: `frame bytes ${Array.from(request.images![0].data).join(",")}`,
              visualType: "diagram",
            }
          : request.schemaName === "ScrubSourceNotes"
            ? {
                notes: request.prompt.includes("Changed transcript")
                  ? "Changed transcript evidence"
                  : request.prompt.includes("frame bytes 42")
                    ? "Changed visual evidence"
                    : "Original source evidence",
              }
            : fullSummary(),
      provider: request.selection.provider,
      model: request.selection.model,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  const models: StructuredModelGateway = { supports: () => true, generate };
  const dependencies = { ...f.dependencies, models };
  const durableCalls: number[] = [];
  const update = f.runs.update.bind(f.runs);
  vi.spyOn(f.runs, "update").mockImplementation(async (change) => {
    const record = await update(change);
    durableCalls.push(record.checkpoints.inference?.calls ?? 0);
    return record;
  });
  return {
    ...f,
    ...controlled,
    models,
    generate,
    durableCalls,
    run: () => runVideoPipeline(f.source, f.settings, dependencies, f.context),
  };
}

for (const provider of ["memory", "filesystem"] as const) {
  describe(`video pipeline using ${provider} artifacts`, () => {
    async function storage(): Promise<ArtifactStorage> {
      if (provider === "memory") return new MemoryArtifactStorage();
      const directory = await mkdtemp(join(tmpdir(), "scrub-pipeline-"));
      directories.push(directory);
      return new FilesystemArtifactStorage(directory);
    }

    it("publishes retrievable artifacts and completes only after all stages", async () => {
      const artifacts = await storage();
      const f = fixture(artifacts);
      const result = await f.run();
      expect(f.media.acquire).toHaveBeenCalledOnce();
      expect(f.transcriber.transcribe).toHaveBeenCalledOnce();
      expect(f.media.extractFrames).toHaveBeenCalledOnce();
      expect(result.frames).toHaveLength(1);
      expect(
        await readArtifactJson(artifacts, result.metadataArtifact)
      ).toMatchObject({ title: "Notes dQw4w9WgXcQ" });
      expect(
        new TextDecoder().decode(
          await readArtifactBytes(artifacts, result.prompt)
        )
      ).toContain("[0:00] Hello dQw4w9WgXcQ");
      expect(await readArtifactJson(artifacts, result.schema)).toMatchObject({
        title: "ScrubSummary",
      });
      expect(await f.runs.get()).toMatchObject({
        status: "completed",
        progress: 100,
        result: { prompt: result.prompt },
      });
      expect(f.events.map((event) => event.stage)).toEqual([
        "download",
        "transcribe",
        "extract-frames",
        "prompt",
        "completed",
      ]);
      expect(await f.run()).toEqual(result);
      expect(f.media.acquire).toHaveBeenCalledOnce();
    });

    it("resumes after a transient failure without repeating a completed acquire checkpoint", async () => {
      const f = fixture(await storage());
      f.transcriber.transcribe.mockRejectedValueOnce(
        new PipelineError("timeout", "Try again", { retryable: true })
      );
      await expect(f.run()).rejects.toMatchObject({ code: "timeout" });
      expect(await f.runs.get()).toMatchObject({
        status: "failed",
        failure: { retryable: true },
        checkpoints: { acquire: {} },
      });
      await f.run();
      expect(f.media.acquire).toHaveBeenCalledOnce();
      expect(f.transcriber.transcribe).toHaveBeenCalledTimes(2);
      expect(f.media.extractFrames).toHaveBeenCalledOnce();
      expect(await f.runs.get()).toMatchObject({
        status: "completed",
        attempts: 2,
      });
    });

    it("keeps committed completion when the progress observer disconnects", async () => {
      const f = fixture(await storage());
      f.context.emit = (event) => {
        if (event.stage === "completed")
          throw new Error("Observer disconnected");
      };
      const result = await f.run();
      expect(await f.runs.get()).toMatchObject({ status: "completed", result });
      expect(await f.run()).toEqual(result);
    });

    it("uses full text when the transcription provider has no timed segments", async () => {
      const artifacts = await storage();
      const f = fixture(artifacts);
      f.transcriber.transcribe.mockResolvedValueOnce({
        fullText: "Untimed spoken words",
        segments: [],
        language: "en",
        duration: 30,
        source: "test-provider",
      });
      const result = await f.run();
      expect(
        new TextDecoder().decode(
          await readArtifactBytes(artifacts, result.prompt)
        )
      ).toContain("Untimed spoken words");
    });

    it("permits source video under its own limit when larger than generated artifact limits", async () => {
      const artifacts = await storage();
      const f = fixture(artifacts);
      f.settings.limits.maxArtifactBytes = 64 * 1024;
      const acquire = f.media.acquire.getMockImplementation()!;
      f.media.acquire.mockImplementationOnce(async (...args) => ({
        ...(await acquire(...args)),
        video: await artifacts.put(
          "source/video",
          new Uint8Array(128 * 1024),
          "video/mp4"
        ),
      }));
      const result = await f.run();
      expect(result.video?.size).toBe(128 * 1024);
      expect(await f.run()).toEqual(result);
    });

    it("does not mark failed publication complete and preserves all completed checkpoints on retry", async () => {
      const controlled = controllableStorage(await storage());
      const f = fixture(controlled.storage);
      controlled.failPublication("prompt/schema");
      await expect(f.run()).rejects.toMatchObject({ code: "storage_error" });
      const failed = await f.runs.get();
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toBeUndefined();
      expect(failed?.checkpoints.frames?.frames).toHaveLength(1);
      controlled.failPublication(null);
      await f.run();
      expect(f.media.acquire).toHaveBeenCalledOnce();
      expect(f.transcriber.transcribe).toHaveBeenCalledOnce();
      expect(f.media.extractFrames).toHaveBeenCalledOnce();
    });

    it("invalidates a completed cache when an artifact is missing and repairs its stage", async () => {
      const controlled = controllableStorage(await storage());
      const f = fixture(controlled.storage);
      const result = await f.run();
      controlled.missing.add(result.transcript.id);
      const repaired = await f.run();
      expect(f.media.acquire).toHaveBeenCalledOnce();
      expect(f.transcriber.transcribe).toHaveBeenCalledTimes(2);
      expect(f.media.extractFrames).toHaveBeenCalledOnce();
      expect(await controlled.storage.has(repaired.transcript)).toBe(true);
    });

    it("rebuilds downstream checkpoints when repaired acquisition returns changed media", async () => {
      const controlled = controllableStorage(await storage());
      const f = fixture(controlled.storage);
      const first = await f.run();
      controlled.missing.add(first.audio.id);
      const acquire = f.media.acquire.getMockImplementation()!;
      f.media.acquire.mockImplementationOnce(async (...args) => ({
        ...(await acquire(...args)),
        audio: await controlled.storage.put(
          "source/audio",
          new Uint8Array([99]),
          "audio/wav"
        ),
        video: await controlled.storage.put(
          "source/video",
          new Uint8Array([98]),
          "video/mp4"
        ),
      }));
      f.transcriber.transcribe.mockResolvedValueOnce({
        fullText: "Changed audio",
        segments: [],
        language: "en",
        duration: 30,
        source: "test-provider",
      });
      const repaired = await f.run();
      expect(f.transcriber.transcribe).toHaveBeenCalledTimes(2);
      expect(f.media.extractFrames).toHaveBeenCalledTimes(2);
      expect(
        new TextDecoder().decode(
          await readArtifactBytes(controlled.storage, repaired.prompt)
        )
      ).toContain("Changed audio");
    });

    it("invalidates cached outputs when processing settings change", async () => {
      const f = fixture(await storage());
      const first = await f.run();
      f.settings.transcription.language = "es";
      const second = await f.run();
      expect(first.cacheKey).not.toBe(second.cacheKey);
      expect(f.media.acquire).toHaveBeenCalledTimes(2);
      expect(f.transcriber.transcribe).toHaveBeenCalledTimes(2);
    });

    it("never publishes completion when a required output disappears before commit", async () => {
      const controlled = controllableStorage(await storage());
      const put = controlled.storage.put;
      controlled.storage.put = async (...args) => {
        const ref = await put(...args);
        if (ref.kind === "prompt/schema") controlled.missing.add(ref.id);
        return ref;
      };
      const f = fixture(controlled.storage);
      await expect(f.run()).rejects.toMatchObject({ code: "artifact_missing" });
      expect(await f.runs.get()).toMatchObject({
        status: "failed",
        failure: { retryable: true },
      });
      expect((await f.runs.get())?.result).toBeUndefined();
      expect(f.events.some((event) => event.stage === "completed")).toBe(false);
    });

    it("keeps concurrent jobs isolated while they share artifact storage", async () => {
      const shared = await storage();
      const a = fixture(shared);
      const b = fixture(shared, "aaaaaaaaaaa");
      const [first, second] = await Promise.all([a.run(), b.run()]);
      expect(first.metadata.contentId).toBe("dQw4w9WgXcQ");
      expect(second.metadata.contentId).toBe("aaaaaaaaaaa");
      expect((await a.runs.get())?.result?.metadata.contentId).toBe(
        first.metadata.contentId
      );
      expect((await b.runs.get())?.result?.metadata.contentId).toBe(
        second.metadata.contentId
      );
      expect(
        new TextDecoder().decode(await readArtifactBytes(shared, first.prompt))
      ).not.toContain("Hello aaaaaaaaaaa");
    });

    it("cancels without falling through to downstream work", async () => {
      const f = fixture(await storage());
      const acquire = f.media.acquire.getMockImplementation()!;
      f.media.acquire.mockImplementationOnce(async (...args) => {
        const prepared = await acquire(...args);
        f.controller.abort("User cancelled");
        return prepared;
      });
      await expect(f.run()).rejects.toMatchObject({ code: "cancelled" });
      expect(f.transcriber.transcribe).not.toHaveBeenCalled();
      expect(f.media.extractFrames).not.toHaveBeenCalled();
      expect(await f.runs.get()).toMatchObject({
        status: "cancelled",
        failure: { retryable: false },
      });
    });

    it.each(["unavailable", "timeout"] as const)(
      "preserves retryable %s interruption and resumes completed checkpoints",
      async (code) => {
        const f = fixture(await storage());
        const reason = new PipelineError(
          code,
          "Host interrupted this attempt",
          {
            retryable: true,
          }
        );
        f.transcriber.transcribe.mockImplementationOnce(async () => {
          f.controller.abort(reason);
          // Process adapters can report a generic cancellation even though
          // the host reason distinguishes shutdown/deadline from a user stop.
          throw new PipelineError("cancelled", "Native process stopped");
        });
        await expect(f.run()).rejects.toMatchObject({ code, retryable: true });
        expect(await f.runs.get()).toMatchObject({
          status: "failed",
          cancelRequested: false,
          failure: { code, retryable: true },
          checkpoints: { acquire: {} },
        });
        expect(f.media.extractFrames).not.toHaveBeenCalled();
        f.context.signal = new AbortController().signal;
        await f.run();
        expect(f.media.acquire).toHaveBeenCalledTimes(1);
        expect(f.transcriber.transcribe).toHaveBeenCalledTimes(2);
        expect(await f.runs.get()).toMatchObject({
          status: "completed",
          attempts: 2,
        });
      }
    );

    it("gives a durable user cancellation precedence over a retryable host interruption", async () => {
      const f = fixture(await storage());
      f.transcriber.transcribe.mockImplementationOnce(async () => {
        await f.runs.update((current) => ({
          ...current!,
          cancelRequested: true,
        }));
        f.controller.abort(
          new PipelineError("unavailable", "Host stopping", { retryable: true })
        );
        throw new PipelineError("cancelled", "Native process stopped");
      });
      await expect(f.run()).rejects.toMatchObject({
        code: "cancelled",
        retryable: false,
      });
      expect(await f.runs.get()).toMatchObject({
        status: "cancelled",
        cancelRequested: true,
        failure: { code: "cancelled", retryable: false },
        checkpoints: { acquire: {} },
      });
      expect(f.media.extractFrames).not.toHaveBeenCalled();
    });

    it("enforces media duration and transcript limits before completion", async () => {
      const duration = fixture(await storage());
      duration.settings.limits.maxDurationSeconds = 1;
      await expect(duration.run()).rejects.toMatchObject({
        code: "resource_limit",
      });
      expect(duration.transcriber.transcribe).not.toHaveBeenCalled();
      const transcript = fixture(await storage());
      transcript.settings.limits.maxTranscriptCharacters = 1;
      await expect(transcript.run()).rejects.toMatchObject({
        code: "invalid_transcript",
      });
      expect((await transcript.runs.get())?.status).toBe("failed");
    });

    it("enforces the artifact byte limit even when the storage adapter allows larger blobs", async () => {
      const f = fixture(await storage());
      f.settings.limits.maxArtifactBytes = 10;
      await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
      expect((await f.runs.get())?.status).toBe("failed");
    });
  });
}

describe("full video pipeline integration", () => {
  it("publishes all full-mode artifacts and returns a completed cache without more paid calls", async () => {
    const f = fullPipelineFixture();
    const result = await f.run();
    expect(result.mode).toBe("full");
    expect(result.inference).toBeDefined();
    expect(
      await Promise.all(
        resultArtifacts(result).map((ref) => f.storage.has(ref))
      )
    ).toEqual(resultArtifacts(result).map(() => true));
    expect(
      await readArtifactJson(f.storage, result.inference!.summary)
    ).toMatchObject({
      tldr: fullSummary().tldr,
    });
    expect(
      await readArtifactJson(f.storage, result.inference!.visualAnalysis)
    ).toEqual([
      {
        description: "A state diagram",
        extractedText: "frame bytes 7,8,9",
        visualType: "diagram",
        timestamp: 5,
      },
    ]);
    expect(
      new TextDecoder().decode(
        await readArtifactBytes(f.storage, result.inference!.markdown)
      )
    ).toContain("# Notes dQw4w9WgXcQ");
    expect(await readArtifactJson(f.storage, result.schema)).toMatchObject({
      title: "ScrubSummary",
    });
    expect(
      await readArtifactJson(f.storage, result.inference!.modelUsage)
    ).toMatchObject({ calls: 2 });
    expect(
      f.generate.mock.calls.map(([request]) => request.schemaName)
    ).toEqual(["ScrubFrameAnalysis", "ScrubSummary"]);
    expect(f.generate.mock.calls[0][0].images).toEqual([
      { data: new Uint8Array([7, 8, 9]), mediaType: "image/png" },
    ]);
    expect(await f.runs.get()).toMatchObject({
      status: "completed",
      result,
      checkpoints: { inference: { calls: 2 } },
    });
    expect(f.events.map((event) => event.stage)).toEqual([
      "download",
      "transcribe",
      "extract-frames",
      "vision",
      "summarize",
      "render",
      "completed",
    ]);
    expect(await f.run()).toEqual(result);
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.media.acquire).toHaveBeenCalledOnce();
    expect(f.transcriber.transcribe).toHaveBeenCalledOnce();
    expect(f.media.extractFrames).toHaveBeenCalledOnce();
  });

  it("retries a transient summary failure without repeating paid vision or native stages", async () => {
    const f = fullPipelineFixture();
    const generate = f.generate.getMockImplementation()!;
    let failSummary = true;
    f.generate.mockImplementation(async (...args) => {
      if (args[0].schemaName === "ScrubSummary" && failSummary) {
        failSummary = false;
        throw new PipelineError(
          "rate_limited",
          "Provider is temporarily unavailable",
          { retryable: true }
        );
      }
      return generate(...args);
    });
    await expect(f.run()).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    const failed = await f.runs.get();
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 1,
      failure: { code: "rate_limited", retryable: true },
      checkpoints: {
        acquire: {},
        transcribe: {},
        frames: {},
        inference: { calls: 2 },
      },
    });
    expect(failed?.result).toBeUndefined();
    expect(Object.keys(failed!.checkpoints.inference!.steps)).toHaveLength(1);
    expect(f.events.some((event) => event.stage === "completed")).toBe(false);
    const result = await f.run();
    expect(
      f.generate.mock.calls.map(([request]) => request.schemaName)
    ).toEqual(["ScrubFrameAnalysis", "ScrubSummary", "ScrubSummary"]);
    expect(f.media.acquire).toHaveBeenCalledOnce();
    expect(f.transcriber.transcribe).toHaveBeenCalledOnce();
    expect(f.media.extractFrames).toHaveBeenCalledOnce();
    expect(await f.runs.get()).toMatchObject({
      status: "completed",
      attempts: 2,
    });
    expect(
      await readArtifactJson(f.storage, result.inference!.modelUsage)
    ).toMatchObject({ calls: 3 });
  });

  it("fails full-mode preflight before media work and persists the failed run when no models are configured", async () => {
    const f = fullPipelineFixture();
    await expect(
      runVideoPipeline(f.source, f.settings, f.dependencies, f.context)
    ).rejects.toMatchObject({
      code: "capability_unavailable",
      retryable: false,
    });
    expect(f.media.acquire).not.toHaveBeenCalled();
    expect(f.transcriber.transcribe).not.toHaveBeenCalled();
    expect(f.media.extractFrames).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(await f.runs.get()).toMatchObject({
      status: "failed",
      failure: { code: "capability_unavailable", retryable: false },
      checkpoints: {},
    });
    expect((await f.runs.get())?.result).toBeUndefined();
  });

  it("repairs missing rendered markdown from durable model outputs without paying again", async () => {
    const f = fullPipelineFixture();
    const original = await f.run();
    f.missing.add(original.inference!.markdown.id);
    const repaired = await f.run();
    expect(repaired.inference!.markdown.id).not.toBe(
      original.inference!.markdown.id
    );
    expect(repaired.inference!.summary).toEqual(original.inference!.summary);
    expect(await f.storage.has(repaired.inference!.markdown)).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.media.acquire).toHaveBeenCalledOnce();
    expect(f.transcriber.transcribe).toHaveBeenCalledOnce();
    expect(f.media.extractFrames).toHaveBeenCalledOnce();
    expect(await f.runs.get()).toMatchObject({
      status: "completed",
      checkpoints: { inference: { calls: 2 } },
    });
  });

  for (const changedStage of ["transcript", "frames"] as const) {
    it(`invalidates old summary and source notes after changed ${changedStage} repair without resetting chargeable calls`, async () => {
      const f = fullPipelineFixture();
      f.settings.inference!.limits.chunkCharacters = 2000;
      f.settings.inference!.limits.maxSummaryInputCharacters =
        formatStructuredModelPrompt({
          prompt: buildSummaryPrompt(
            {
              contentId: "dQw4w9WgXcQ",
              title: "Notes dQw4w9WgXcQ",
              description: "",
              duration: 30,
              thumbnailUrl: "",
              source: "YouTube",
              uploadDate: "2026-01-01",
              url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            },
            "",
            [],
            { consolidatedVisuals: true }
          ),
          schema: SUMMARY_SCHEMA,
        }).length + 2256;
      f.transcriber.transcribe.mockResolvedValue({
        fullText: "Original transcript evidence. ".repeat(200),
        segments: [],
        language: "en",
        duration: 30,
        source: "test-provider",
      });
      const original = await f.run();
      const previousCalls = f.generate.mock.calls.length;
      expect(
        f.generate.mock.calls.some(
          ([request]) => request.schemaName === "ScrubSourceNotes"
        )
      ).toBe(true);
      if (changedStage === "transcript") {
        f.missing.add(original.transcript.id);
        f.transcriber.transcribe.mockResolvedValueOnce({
          fullText: "Changed transcript evidence. ".repeat(200),
          segments: [],
          language: "en",
          duration: 30,
          source: "test-provider",
        });
      } else {
        f.missing.add(original.frames[0].artifact.id);
        f.media.extractFrames.mockResolvedValueOnce([
          {
            timestamp: 5,
            artifact: await f.storage.put(
              "frames/image",
              new Uint8Array([42]),
              "image/png"
            ),
          },
        ]);
      }
      const repaired = await f.run();
      const newRequests = f.generate.mock.calls
        .slice(previousCalls)
        .map(([request]) => request);
      expect(
        newRequests.some((request) => request.schemaName === "ScrubSourceNotes")
      ).toBe(true);
      expect(
        newRequests.filter((request) => request.schemaName === "ScrubSummary")
      ).toHaveLength(1);
      expect(
        newRequests.some(
          (request) =>
            request.schemaName === "ScrubSourceNotes" &&
            request.prompt.includes(
              changedStage === "transcript"
                ? "Changed transcript"
                : "frame bytes 42"
            )
        )
      ).toBe(true);
      expect(
        newRequests.find((request) => request.schemaName === "ScrubSummary")!
          .prompt
      ).toContain(
        changedStage === "transcript"
          ? "Changed transcript evidence"
          : "Changed visual evidence"
      );
      expect(repaired.inference!.summary.id).not.toBe(
        original.inference!.summary.id
      );
      const record = (await f.runs.get())!;
      expect(record.status).toBe("completed");
      expect(record.checkpoints.inference!.calls).toBe(
        f.generate.mock.calls.length
      );
      for (let index = 1; index < f.durableCalls.length; index++)
        expect(f.durableCalls[index]).toBeGreaterThanOrEqual(
          f.durableCalls[index - 1]
        );
      expect(f.media.acquire).toHaveBeenCalledOnce();
      expect(f.transcriber.transcribe).toHaveBeenCalledTimes(
        changedStage === "transcript" ? 2 : 1
      );
      expect(f.media.extractFrames).toHaveBeenCalledTimes(
        changedStage === "frames" ? 2 : 1
      );
    });
  }

  it("preserves pending frame repair budgets while changed transcription invalidates dependent inference", async () => {
    const f = fullPipelineFixture();
    const original = await f.run();
    const completed = (await f.runs.get())!;
    const visionKey = Object.keys(completed.checkpoints.inference!.steps).find(
      (key) => key.startsWith("vision:")
    )!;
    const visionArtifact =
      completed.checkpoints.inference!.steps[visionKey].artifact;
    const visionPending = {
      outputTokens: f.settings.inference!.limits.maxVisionOutputTokens,
      outputRetries: 0,
      repairAttempts: f.settings.inference!.limits.repairAttempts,
    };
    await f.runs.update((record) => ({
      ...record!,
      checkpoints: {
        ...record!.checkpoints,
        inference: {
          ...record!.checkpoints.inference!,
          pending: {
            [visionKey]: visionPending,
            "chunk:0": { ...visionPending, exhausted: "invalid_output" },
            "reduce:0:0": { ...visionPending, exhausted: "output_limit" },
            "summary:final": { ...visionPending, exhausted: "output_limit" },
          },
        },
      },
    }));
    f.missing.add(original.transcript.id);
    f.missing.add(visionArtifact.id);
    f.transcriber.transcribe.mockResolvedValueOnce({
      fullText: "Changed transcript evidence.",
      segments: [],
      language: "en",
      duration: 30,
      source: "test-provider",
    });
    f.generate.mockRejectedValueOnce(
      new PipelineError("invalid_model_output", "Invalid frame response")
    );
    const paidCalls = f.generate.mock.calls.length;
    await expect(f.run()).rejects.toMatchObject({
      code: "invalid_model_output",
    });
    expect(f.generate).toHaveBeenCalledTimes(paidCalls + 1);
    expect(f.generate.mock.calls.at(-1)![0].schemaName).toBe(
      "ScrubFrameAnalysis"
    );
    const failed = (await f.runs.get())!;
    expect(failed.checkpoints.inference!.calls).toBe(paidCalls + 1);
    expect(failed.checkpoints.inference!.pending).toEqual({
      [visionKey]: { ...visionPending, exhausted: "invalid_output" },
    });
    expect(
      failed.checkpoints.inference!.steps["summary:final"]
    ).toBeUndefined();
    expect(f.transcriber.transcribe).toHaveBeenCalledTimes(2);
    expect(f.media.extractFrames).toHaveBeenCalledOnce();
    expect(f.media.acquire).toHaveBeenCalledOnce();
  });

  it("preserves the model budget when changed acquisition invalidates completed inference", async () => {
    const f = fullPipelineFixture();
    f.settings.inference!.limits.maxModelCalls = 3;
    const original = await f.run();
    f.missing.add(original.audio.id);
    const acquire = f.media.acquire.getMockImplementation()!;
    f.media.acquire.mockImplementationOnce(async (...args) => ({
      ...(await acquire(...args)),
      audio: await f.storage.put(
        "source/audio",
        new Uint8Array([88]),
        "audio/wav"
      ),
      video: await f.storage.put(
        "source/video",
        new Uint8Array([89]),
        "video/mp4"
      ),
    }));
    await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(f.generate.mock.calls[2][0].schemaName).toBe("ScrubFrameAnalysis");
    const record = (await f.runs.get())!;
    expect(record).toMatchObject({
      status: "failed",
      checkpoints: { inference: { calls: 3 } },
    });
    expect(record.result).toBeUndefined();
    expect(
      f.events.filter((event) => event.stage === "completed")
    ).toHaveLength(1);
    for (let index = 1; index < f.durableCalls.length; index++)
      expect(f.durableCalls[index]).toBeGreaterThanOrEqual(
        f.durableCalls[index - 1]
      );
  });

  it("never publishes completion when a one-call budget is consumed by vision, including retry", async () => {
    const f = fullPipelineFixture();
    f.settings.inference!.limits.maxModelCalls = 1;
    await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
    await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.generate.mock.calls[0][0].schemaName).toBe("ScrubFrameAnalysis");
    const record = (await f.runs.get())!;
    expect(record).toMatchObject({
      status: "failed",
      attempts: 2,
      checkpoints: { inference: { calls: 1 } },
    });
    expect(record.result).toBeUndefined();
    expect(record.checkpoints.inference!.steps).not.toHaveProperty(
      "summary:final"
    );
    expect(f.events.some((event) => event.stage === "completed")).toBe(false);
    expect(f.media.acquire).toHaveBeenCalledOnce();
    expect(f.transcriber.transcribe).toHaveBeenCalledOnce();
    expect(f.media.extractFrames).toHaveBeenCalledOnce();
  });
});

describe("memory adapter contracts", () => {
  it("copies bytes across storage boundaries and rejects oversized streamed writes", async () => {
    const storage = new MemoryArtifactStorage(4);
    const bytes = new Uint8Array([1, 2]);
    const ref = await storage.put("test", bytes, "application/octet-stream");
    bytes[0] = 99;
    expect(await storage.readRange(ref, 0, 2)).toEqual(new Uint8Array([1, 2]));
    const read = await storage.readRange(ref, 0, 2);
    read[0] = 99;
    expect(await storage.readRange(ref, 0, 2)).toEqual(new Uint8Array([1, 2]));
    async function* tooLarge() {
      yield new Uint8Array(3);
      yield new Uint8Array(3);
    }
    await expect(
      storage.put("test", tooLarge(), "application/octet-stream")
    ).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("serializes run transitions and recovers after a rejected change", async () => {
    const f = fixture(new MemoryArtifactStorage());
    await f.run();
    const before = (await f.runs.get())!.revision;
    await expect(
      f.runs.update(() => {
        throw new Error("Rejected transition");
      })
    ).rejects.toThrow();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        f.runs.update((current) => ({
          ...current!,
          revision: current!.revision + 1,
        }))
      )
    );
    expect((await f.runs.get())?.revision).toBe(before + 5);
  });
});
