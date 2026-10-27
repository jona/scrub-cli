import { describe, expect, it, vi } from "vitest";
import {
  runModelInference,
  splitInferenceText,
  type InferenceOperation,
} from "../../src/application/inference.js";
import {
  readArtifactBytes,
  readArtifactJson,
} from "../../src/application/artifact-io.js";
import {
  resolveInferenceSettings,
  type ModelInferenceCheckpoint,
  type StructuredModelGateway,
  type StructuredModelRequest,
} from "../../src/application/model.js";
import type {
  ArtifactRef,
  ArtifactStorage,
  OperationContext,
} from "../../src/application/contracts.js";
import { MemoryArtifactStorage } from "../../src/infrastructure/memory/ArtifactStorage.js";
import { PipelineError } from "../../src/core/errors.js";
import { SUMMARY_SCHEMA } from "../../src/core/summary-template.js";
import type { SummaryResult, VisualAnalysis } from "../../src/core/models.js";

function summary() {
  return {
    tldr: "Document state survives restarts.",
    overview: "A short explanation of durable document processing.",
    thesisAndClaims: {
      thesis: "Keep durable state",
      keyClaims: [
        { claim: "Record completed work", evidence: "The demonstration" },
      ],
    },
    actionableInsights: [{ action: "Persist completed steps" }],
    concepts: [
      { concept: "Checkpoint", definition: "A durable completed step" },
    ],
    mentalModels: [],
    structureMap: [],
    openQuestions: [],
    notableQuotes: [
      {
        quote: "Save the result",
        significance: "Avoid repeating work",
        timestamp: 5,
      },
    ],
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
    confidence: { level: "high", reasoning: "Direct demonstration" },
    sections: [
      {
        title: "Durable state",
        startTime: 0,
        endTime: 30,
        content: "Persist document artifacts.",
        codeSnippets: [{ code: "save(result)", language: "ts", timestamp: 5 }],
      },
    ],
    keyTakeaways: ["Persist completed work"],
    codeSnippets: [],
    references: [],
  };
}
const vision = () => ({
  description: "A diagram of durable document state",
  extractedText: "save(result)",
  visualType: "diagram",
});

async function fixture() {
  const base = new MemoryArtifactStorage();
  const missing = new Set<string>();
  const corrupt = new Map<string, Uint8Array>();
  const unreadable = new Set<string>();
  const temporaryReadFailure = new Set<string>();
  const published: { kind: string; ref: ArtifactRef }[] = [];
  const storage: ArtifactStorage = {
    async put(kind, data, mediaType) {
      const ref = await base.put(kind, data, mediaType);
      published.push({ kind, ref });
      return ref;
    },
    has: async (ref) => !missing.has(ref.id) && base.has(ref),
    read: async function* (ref) {
      if (missing.has(ref.id))
        throw new PipelineError("artifact_missing", "Missing cached artifact");
      if (unreadable.has(ref.id))
        throw new PipelineError("storage_error", "Cached artifact is corrupt");
      if (temporaryReadFailure.has(ref.id))
        throw new PipelineError(
          "storage_error",
          "Temporary cached-artifact read failure",
          { retryable: true }
        );
      if (corrupt.has(ref.id)) yield corrupt.get(ref.id)!;
      else yield* base.read(ref);
    },
    readRange: (ref, offset, length) => base.readRange(ref, offset, length),
  };
  const frame = await storage.put(
    "frames/image",
    new Uint8Array([7, 8, 9]),
    "image/png"
  );
  const controller = new AbortController();
  let checkpoint: ModelInferenceCheckpoint | undefined;
  const saved: ModelInferenceCheckpoint[] = [];
  let clock = Date.parse("2026-10-26T12:00:00.000Z");
  const context: OperationContext = {
    runId: "video",
    attemptId: "attempt-1",
    signal: controller.signal,
    now: () => clock++,
    emit: () => undefined,
  };
  const generate = vi.fn<StructuredModelGateway["generate"]>(
    async (request) => ({
      value: request.schemaName === "ScrubFrameAnalysis" ? vision() : summary(),
      provider: request.selection.provider,
      model: request.selection.model,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  const models: StructuredModelGateway = { supports: () => true, generate };
  const operation: Omit<InferenceOperation, "checkpoint"> = {
    settings: resolveInferenceSettings({
      mode: "full",
      summary: { provider: "openai", model: "gpt-6-luna" },
      vision: { provider: "anthropic", model: "claude-sonnet-5-5" },
      includeFullTranscript: true,
    })!,
    artifacts: storage,
    models,
    metadata: {
      contentId: "aaaaaaaaaaa",
      title: "Document notes",
      description: "A worked example",
      duration: 120,
      thumbnailUrl: "",
      source: "YouTube",
      uploadDate: "2026-01-01",
      url: "https://youtu.be/aaaaaaaaaaa",
    },
    transcript: {
      fullText: "Save the result",
      segments: [{ start: 0, end: 5, text: "Save the result" }],
      language: "en",
      duration: 120,
      source: "test",
    },
    frames: [{ timestamp: 5, artifact: frame }],
    context,
    save: vi.fn(async (value) => {
      checkpoint = structuredClone(value);
      saved.push(structuredClone(value));
    }),
    announce: vi.fn(async () => undefined),
  };
  return {
    operation,
    storage,
    missing,
    corrupt,
    unreadable,
    temporaryReadFailure,
    published,
    controller,
    generate,
    saved,
    checkpoint: () => checkpoint!,
    run: () => runModelInference({ ...operation, checkpoint }),
    resetCheckpoint: (value: ModelInferenceCheckpoint) => {
      checkpoint = structuredClone(value);
    },
  };
}

describe("full model inference", () => {
  it("analyzes actual frame bytes with host timestamps, then publishes summary, schema, markdown, and usage", async () => {
    const f = await fixture();
    f.generate.mockImplementation(async (request) => {
      expect(f.checkpoint().calls).toBe(f.generate.mock.calls.length);
      return {
        value:
          request.schemaName === "ScrubFrameAnalysis" ? vision() : summary(),
        provider: request.selection.provider,
        model: request.selection.model,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const result = await f.run();
    expect(f.generate).toHaveBeenCalledTimes(2);
    const [visualRequest, summaryRequest] = f.generate.mock.calls.map(
      (call) => call[0]
    );
    expect(visualRequest.selection.provider).toBe("anthropic");
    expect(visualRequest.images).toEqual([
      { data: new Uint8Array([7, 8, 9]), mediaType: "image/png" },
    ]);
    expect(visualRequest.system).toContain("untrusted");
    expect(summaryRequest.selection.provider).toBe("openai");
    expect(summaryRequest.prompt).toContain("save(result)");
    expect(summaryRequest.prompt).toContain("[0:05]");
    const visuals = await readArtifactJson<VisualAnalysis[]>(
      f.storage,
      result.inference.visualAnalysis
    );
    expect(visuals).toEqual([{ ...vision(), timestamp: 5 }]);
    const completed = await readArtifactJson<SummaryResult>(
      f.storage,
      result.inference.summary
    );
    expect(completed.tldr).toBe(summary().tldr);
    expect(completed).not.toHaveProperty("title");
    expect(await readArtifactJson(f.storage, result.schema)).toEqual(
      SUMMARY_SCHEMA
    );
    const markdown = new TextDecoder().decode(
      await readArtifactBytes(f.storage, result.inference.markdown)
    );
    expect(markdown).toContain("# Document notes");
    expect(markdown).toContain("## Full Transcript");
    expect(markdown).toContain("2026-10-26");
    expect(
      await readArtifactJson(f.storage, result.inference.modelUsage)
    ).toMatchObject({
      calls: 2,
      tokenUsageScope: "validated_responses_only",
      steps: expect.arrayContaining([
        expect.objectContaining({
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
        expect.objectContaining({ provider: "openai", model: "gpt-6-luna" }),
      ]),
    });
  });

  it("reuses completed paid steps after restart and does not spend another model call", async () => {
    const f = await fixture();
    const first = await f.run();
    const checkpoint = structuredClone(f.checkpoint());
    f.generate.mockClear();
    f.resetCheckpoint(checkpoint);
    const repeated = await f.run();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.checkpoint().calls).toBe(2);
    expect(repeated.inference.summary).toEqual(first.inference.summary);
    expect(
      new TextDecoder().decode(
        await readArtifactBytes(f.storage, repeated.inference.markdown)
      )
    ).toContain("Document notes");
  });

  it("repairs invalid summary JSON only within the configured repair budget", async () => {
    const f = await fixture();
    f.generate.mockImplementation(async (request) => ({
      value:
        request.schemaName === "ScrubFrameAnalysis"
          ? vision()
          : f.generate.mock.calls.filter(
                (call) => call[0].schemaName === "ScrubSummary"
              ).length === 1
            ? { invalid: true }
            : summary(),
      provider: request.selection.provider,
      model: request.selection.model,
    }));
    await f.run();
    const summaryCalls = f.generate.mock.calls.filter(
      (call) => call[0].schemaName === "ScrubSummary"
    );
    expect(summaryCalls).toHaveLength(2);
    expect(summaryCalls[1][0].prompt).toContain(
      "previous response failed validation"
    );
    expect(f.checkpoint().calls).toBe(3);

    const exhausted = await fixture();
    exhausted.generate.mockImplementation(async (request) => ({
      value: request.schemaName === "ScrubFrameAnalysis" ? vision() : {},
      provider: request.selection.provider,
      model: request.selection.model,
    }));
    await expect(exhausted.run()).rejects.toMatchObject({
      code: "invalid_model_output",
    });
    expect(
      exhausted.generate.mock.calls.filter(
        (call) => call[0].schemaName === "ScrubSummary"
      )
    ).toHaveLength(2);
    expect(
      exhausted.published.some((item) => item.kind === "output/summary")
    ).toBe(false);
    expect(exhausted.checkpoint().steps["summary:final"]).toBeUndefined();
  });

  it("preserves retryable provider failures, checkpoints successful vision, and publishes no completion", async () => {
    const f = await fixture();
    f.generate.mockImplementation(async (request) => {
      if (request.schemaName === "ScrubSummary")
        throw new PipelineError("rate_limited", "Try later", {
          retryable: true,
        });
      return {
        value: vision(),
        provider: request.selection.provider,
        model: request.selection.model,
      };
    });
    await expect(f.run()).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(f.checkpoint().calls).toBe(2);
    expect(f.checkpoint().steps["summary:final"]).toBeUndefined();
    expect(f.published.some((item) => item.kind === "output/summary")).toBe(
      false
    );
    f.generate.mockClear().mockImplementation(async (request) => ({
      value: summary(),
      provider: request.selection.provider,
      model: request.selection.model,
    }));
    await f.run();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls[0][0].schemaName).toBe("ScrubSummary");
    expect(f.checkpoint().calls).toBe(3);
  });

  it("cancels between paid calls without recording or publishing the returned value", async () => {
    const f = await fixture();
    f.generate.mockImplementationOnce(async (request) => {
      f.controller.abort();
      return {
        value: vision(),
        provider: request.selection.provider,
        model: request.selection.model,
      };
    });
    await expect(f.run()).rejects.toMatchObject({ code: "cancelled" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.checkpoint()).toEqual({ calls: 1, steps: {} });
    expect(
      f.published.some(
        (item) =>
          item.kind === "inference/vision-frame" ||
          item.kind === "output/summary"
      )
    ).toBe(false);
  });

  it("honors the durable total call budget across a failed attempt and restart", async () => {
    const f = await fixture();
    f.operation.settings.limits.maxModelCalls = 1;
    await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.checkpoint().calls).toBe(1);
    await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.checkpoint().calls).toBe(1);
  });

  it("feeds every long-transcript character and visual evidence into bounded map/reduce calls", async () => {
    const f = await fixture();
    f.operation.settings.limits.chunkCharacters = 2000;
    const original = `BEGIN_SOURCE_${"x".repeat(16_000)}_END_SOURCE`;
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: original,
      segments: [],
    };
    f.generate.mockImplementation(async (request) => {
      const value =
        request.schemaName === "ScrubFrameAnalysis"
          ? vision()
          : request.schemaName === "ScrubSourceNotes"
            ? {
                notes:
                  `NOTE_${f.generate.mock.calls.length}:` + "z".repeat(630),
              }
            : summary();
      return {
        value,
        provider: request.selection.provider,
        model: request.selection.model,
      };
    });
    const output = await f.run();
    const noteCalls = f.generate.mock.calls
      .map((call) => call[0])
      .filter((call) => call.schemaName === "ScrubSourceNotes");
    const payload = (request: StructuredModelRequest) =>
      request.prompt.match(/<source_data>\n([\s\S]*)\n<\/source_data>/)![1];
    const maps = noteCalls.filter((call) => !payload(call).includes("NOTE_"));
    expect(maps.map(payload).join("")).toContain(original);
    expect(maps.map(payload).join("")).toContain("save(result)");
    expect(noteCalls.some((call) => payload(call).includes("NOTE_"))).toBe(
      true
    );
    expect(noteCalls.every((call) => payload(call).length <= 2000)).toBe(true);
    const final = f.generate.mock.calls
      .map((call) => call[0])
      .find((call) => call.schemaName === "ScrubSummary")!;
    expect(final.prompt).toContain("NOTE_");
    expect(await f.storage.has(output.inference.markdown)).toBe(true);
  });

  it("rejects source-out-of-range summary timestamps and does not publish final markdown", async () => {
    const f = await fixture();
    f.operation.settings.limits.repairAttempts = 0;
    const invalid = summary();
    invalid.sections[0].endTime = 121;
    f.generate.mockImplementation(async (request) => ({
      value: request.schemaName === "ScrubFrameAnalysis" ? vision() : invalid,
      provider: request.selection.provider,
      model: request.selection.model,
    }));
    await expect(f.run()).rejects.toMatchObject({
      code: "invalid_model_output",
      stage: "summary",
    });
    expect(f.checkpoint().steps["summary:final"]).toBeUndefined();
    expect(f.published.some((item) => item.kind === "output/summary")).toBe(
      false
    );
  });

  it("regenerates a missing summary artifact without redoing valid paid vision", async () => {
    const f = await fixture();
    const result = await f.run();
    f.missing.add(result.inference.summary.id);
    f.generate.mockClear();
    const regenerated = await f.run();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls[0][0].schemaName).toBe("ScrubSummary");
    expect(regenerated.inference.summary.id).not.toBe(
      result.inference.summary.id
    );
  });

  it("regenerates corrupt cached vision with the original image attached", async () => {
    const f = await fixture();
    await f.run();
    const visionStep = Object.entries(f.checkpoint().steps).find(([key]) =>
      key.startsWith("vision:")
    )![1];
    f.corrupt.set(
      visionStep.artifact.id,
      new TextEncoder().encode('{"description":12}')
    );
    f.generate.mockClear().mockImplementation(async (request) => {
      if (
        request.schemaName === "ScrubFrameAnalysis" &&
        !request.images?.length
      )
        throw new PipelineError("invalid_input", "Missing original image");
      return {
        value:
          request.schemaName === "ScrubFrameAnalysis" ? vision() : summary(),
        provider: request.selection.provider,
        model: request.selection.model,
      };
    });
    const result = await f.run();
    expect(f.generate.mock.calls[0][0].images?.[0].data).toEqual(
      new Uint8Array([7, 8, 9])
    );
    expect(
      await readArtifactJson(f.storage, result.inference.visualAnalysis)
    ).toEqual([{ ...vision(), timestamp: 5 }]);
  });

  it("regenerates a cached inference artifact that becomes unreadable after its existence check", async () => {
    const f = await fixture();
    const result = await f.run();
    f.unreadable.add(result.inference.summary.id);
    f.generate.mockClear();
    const regenerated = await f.run();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(regenerated.inference.summary.id).not.toBe(
      result.inference.summary.id
    );
  });

  it("propagates retryable cache IO without spending another paid call", async () => {
    const f = await fixture();
    const result = await f.run();
    f.temporaryReadFailure.add(result.inference.summary.id);
    f.generate.mockClear();
    await expect(f.run()).rejects.toMatchObject({
      code: "storage_error",
      retryable: true,
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.checkpoint().calls).toBe(2);
  });

  it("bounds frame bytes before making a paid vision request", async () => {
    const f = await fixture();
    f.operation.settings.limits.maxImageBytes = 2;
    await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.operation.save).not.toHaveBeenCalled();
  });

  it("rejects a pre-cancelled restart even when every paid step is already cached", async () => {
    const f = await fixture();
    await f.run();
    f.generate.mockClear();
    f.controller.abort();
    await expect(f.run()).rejects.toMatchObject({ code: "cancelled" });
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe("inference text splitting", () => {
  it("preserves all text and surrogate pairs at chunk boundaries", () => {
    const original = `a😀b\n${"x".repeat(40)}😀END`;
    const chunks = splitInferenceText(original, 4);
    expect(chunks.join("")).toBe(original);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
    expect(
      chunks.every(
        (chunk) =>
          !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)
      )
    ).toBe(true);
  });
});
