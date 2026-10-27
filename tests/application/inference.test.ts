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
  formatStructuredModelPrompt,
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
import { MemoryArtifactStorage } from "../helpers/memory/ArtifactStorage.js";
import { resolveSettings } from "../../src/application/settings.js";
import { ModelOutputLimitError, PipelineError } from "../../src/core/errors.js";
import {
  buildSummaryPrompt,
  SUMMARY_SCHEMA,
} from "../../src/core/summary-template.js";
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

function useSmallSourceBudget(
  operation: Omit<InferenceOperation, "checkpoint">,
  characters = 2000
) {
  operation.settings.limits.chunkCharacters = characters;
  operation.settings.limits.maxSummaryInputCharacters =
    formatStructuredModelPrompt({
      prompt: buildSummaryPrompt(operation.metadata, "", [], {
        consolidatedVisuals: operation.frames.length > 0,
      }),
      schema: SUMMARY_SCHEMA,
    }).length +
    characters +
    256;
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
    expect(f.checkpoint()).toMatchObject({ calls: 1, steps: {} });
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

  it("grows truncated summaries only within the request ceiling and reuses the completed result", async () => {
    const f = await fixture();
    f.operation.frames = [];
    Object.assign(f.operation.settings.limits, {
      initialOutputTokens: 1024,
      maxOutputTokens: 4096,
      outputTokenRetries: 2,
    });
    f.generate.mockImplementation(async (request) => {
      if (request.maxOutputTokens < 4096) throw new ModelOutputLimitError();
      return {
        value: summary(),
        provider: "openai",
        model: request.selection.model,
      };
    });
    const result = await f.run();
    expect(
      f.generate.mock.calls.map(([request]) => request.maxOutputTokens)
    ).toEqual([1024, 2048, 4096]);
    expect(f.checkpoint().calls).toBe(3);
    expect(f.checkpoint().pending).toBeUndefined();
    f.generate.mockClear();
    expect((await f.run()).inference.summary).toEqual(result.inference.summary);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("resumes at the saved larger allowance after interruption before the next paid call", async () => {
    const f = await fixture();
    f.operation.frames = [];
    Object.assign(f.operation.settings.limits, {
      initialOutputTokens: 1024,
      maxOutputTokens: 4096,
      outputTokenRetries: 2,
    });
    f.generate
      .mockRejectedValueOnce(new ModelOutputLimitError())
      .mockImplementation(async (request) => ({
        value: summary(),
        provider: "openai",
        model: request.selection.model,
      }));
    vi.mocked(f.operation.announce).mockImplementation(
      async (_stage, _progress, message) => {
        if (message.startsWith("Increasing model output"))
          throw new PipelineError(
            "unavailable",
            "Simulated interrupted runner",
            { retryable: true }
          );
      }
    );
    await expect(f.run()).rejects.toMatchObject({ code: "unavailable" });
    expect(f.checkpoint().pending?.["summary:final"]).toMatchObject({
      outputTokens: 2048,
      outputRetries: 1,
    });
    expect(f.checkpoint().calls).toBe(1);
    vi.mocked(f.operation.announce).mockResolvedValue(undefined);
    await f.run();
    expect(
      f.generate.mock.calls.map(([request]) => request.maxOutputTokens)
    ).toEqual([1024, 2048]);
    expect(f.checkpoint().calls).toBe(2);
  });

  it.each([
    { ceiling: 2048, retries: 4, expected: [1024, 2048] },
    { ceiling: 8192, retries: 1, expected: [1024, 2048] },
    { ceiling: 8192, retries: 0, expected: [1024] },
  ])(
    "persists exhausted growth budgets across restarts: $ceiling / $retries",
    async ({ ceiling, retries, expected }) => {
      const f = await fixture();
      f.operation.frames = [];
      Object.assign(f.operation.settings.limits, {
        initialOutputTokens: 1024,
        maxOutputTokens: ceiling,
        outputTokenRetries: retries,
      });
      f.generate.mockRejectedValue(new ModelOutputLimitError());
      await expect(f.run()).rejects.toBeInstanceOf(ModelOutputLimitError);
      expect(
        f.generate.mock.calls.map(([request]) => request.maxOutputTokens)
      ).toEqual(expected);
      expect(f.checkpoint().pending?.["summary:final"].exhausted).toBe(
        "output_limit"
      );
      f.generate.mockClear();
      await expect(f.run()).rejects.toBeInstanceOf(ModelOutputLimitError);
      expect(f.generate).not.toHaveBeenCalled();
    }
  );

  it("counts both token recovery and schema repair against the durable paid-call budget", async () => {
    const f = await fixture();
    f.operation.frames = [];
    Object.assign(f.operation.settings.limits, {
      initialOutputTokens: 1024,
      maxOutputTokens: 4096,
      maxModelCalls: 3,
    });
    f.generate
      .mockRejectedValueOnce(new ModelOutputLimitError())
      .mockResolvedValueOnce({
        value: {},
        provider: "openai",
        model: "gpt-6-luna",
      })
      .mockResolvedValueOnce({
        value: summary(),
        provider: "openai",
        model: "gpt-6-luna",
      });
    await f.run();
    expect(
      f.generate.mock.calls.map(([request]) => request.maxOutputTokens)
    ).toEqual([1024, 2048, 2048]);
    expect(f.generate.mock.calls[2][0].prompt).toContain(
      "previous response failed validation"
    );
    expect(f.checkpoint().calls).toBe(3);

    const limited = await fixture();
    limited.operation.frames = [];
    limited.operation.settings.limits.maxModelCalls = 1;
    limited.generate.mockRejectedValue(new ModelOutputLimitError());
    await expect(limited.run()).rejects.toMatchObject({
      code: "resource_limit",
    });
    await expect(limited.run()).rejects.toMatchObject({
      code: "resource_limit",
    });
    expect(limited.generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    "resource_limit",
    "model_refused",
    "rate_limited",
    "timeout",
  ] as const)(
    "does not grow the token allowance for an unrelated %s failure",
    async (code) => {
      const f = await fixture();
      f.operation.frames = [];
      f.generate.mockRejectedValue(new PipelineError(code, "Fixture failure"));
      await expect(f.run()).rejects.toMatchObject({ code });
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.checkpoint().pending?.["summary:final"].outputRetries).toBe(0);
    }
  );

  it("does not reset exhausted schema repair attempts on a restarted runner", async () => {
    const f = await fixture();
    f.operation.frames = [];
    f.generate.mockResolvedValue({
      value: {},
      provider: "openai",
      model: "gpt-6-luna",
    });
    await expect(f.run()).rejects.toMatchObject({
      code: "invalid_model_output",
    });
    expect(f.generate).toHaveBeenCalledTimes(2);
    f.generate.mockClear();
    await expect(f.run()).rejects.toMatchObject({
      code: "invalid_model_output",
    });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("rejects an impossible summary input policy before any paid frame or summary call", async () => {
    const f = await fixture();
    f.operation.settings.limits.maxSummaryInputCharacters = 100;
    await expect(f.run()).rejects.toMatchObject({
      code: "invalid_input",
      stage: "summary",
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.operation.save).not.toHaveBeenCalled();
  });

  it("compresses oversized valid notes without truncating them and bounds the actual summary prompt including repairs", async () => {
    const f = await fixture();
    f.operation.frames = [];
    useSmallSourceBudget(f.operation);
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: "RAW_SOURCE_".repeat(600),
      segments: [],
    };
    const source = `TRANSCRIPT\n${f.operation.transcript.fullText}\n\nVISUAL EVIDENCE\n`;
    const maps = splitInferenceText(source, 2000).length;
    const oversized = "NOTES_BEGIN_" + "z".repeat(12_903) + "_NOTES_END";
    let noteCalls = 0;
    let finalCalls = 0;
    f.generate.mockImplementation(async (request) => ({
      value:
        request.schemaName === "ScrubSourceNotes"
          ? {
              notes:
                ++noteCalls <= maps
                  ? oversized
                  : "Compressed grounded notes with source timestamps.",
            }
          : ++finalCalls === 1
            ? {}
            : summary(),
      provider: "openai",
      model: request.selection.model,
    }));
    await f.run();
    const notes = f.generate.mock.calls
      .map(([request]) => request)
      .filter((request) => request.schemaName === "ScrubSourceNotes");
    const payload = (request: StructuredModelRequest) =>
      request.prompt.match(/<source_data>\n([\s\S]*)\n<\/source_data>/)![1];
    expect(notes.slice(0, maps).map(payload).join("")).toBe(source);
    const combinedNotes = Array.from({ length: maps }, () => oversized).join(
      "\n\n"
    );
    const groups = splitInferenceText(combinedNotes, 2000);
    expect(
      notes
        .slice(maps, maps + groups.length)
        .map(payload)
        .join("")
    ).toBe(combinedNotes);
    const finals = f.generate.mock.calls
      .map(([request]) => request)
      .filter((request) => request.schemaName === "ScrubSummary");
    expect(finals).toHaveLength(2);
    expect(
      finals.every(
        (request) =>
          formatStructuredModelPrompt(request).length <=
          f.operation.settings.limits.maxSummaryInputCharacters
      )
    ).toBe(true);
    expect(finals[0].prompt).toContain("Compressed grounded notes");
    expect(
      await readArtifactJson(
        f.storage,
        f.checkpoint().steps["chunk:0"].artifact
      )
    ).toEqual({ notes: oversized });
    f.generate.mockClear();
    await f.run();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("stops nonconverging note compression with no truncated final artifact", async () => {
    const f = await fixture();
    f.operation.frames = [];
    useSmallSourceBudget(f.operation);
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: "source".repeat(1000),
      segments: [],
    };
    f.generate.mockResolvedValue({
      value: { notes: "expanding".repeat(500) },
      provider: "openai",
      model: "gpt-6-luna",
    });
    await expect(f.run()).rejects.toMatchObject({
      code: "resource_limit",
      message: expect.stringContaining("did not converge"),
    });
    expect(f.checkpoint().calls).toBeLessThan(
      f.operation.settings.limits.maxModelCalls
    );
    expect(
      f.generate.mock.calls.every(
        ([request]) => request.schemaName === "ScrubSourceNotes"
      )
    ).toBe(true);
    expect(f.published.some(({ kind }) => kind === "output/summary")).toBe(
      false
    );
  });

  it("makes no higher-budget model call when persisting the increased allowance fails", async () => {
    const f = await fixture();
    f.operation.frames = [];
    f.generate.mockRejectedValue(new ModelOutputLimitError());
    const persist = f.operation.save;
    f.operation.save = vi.fn(async (value) => {
      if (value.pending?.["summary:final"].outputRetries)
        throw new PipelineError("storage_error", "Checkpoint unavailable", {
          retryable: true,
        });
      await persist(value);
    });
    await expect(f.run()).rejects.toMatchObject({ code: "storage_error" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.checkpoint().calls).toBe(1);
    expect(f.checkpoint().pending?.["summary:final"].outputRetries).toBe(0);
  });

  it("preserves the old spending ceiling when executing legacy saved settings", async () => {
    const f = await fixture();
    f.operation.frames = [];
    const legacy = JSON.parse(JSON.stringify(f.operation.settings));
    for (const key of [
      "initialOutputTokens",
      "initialSourceNoteOutputTokens",
      "outputTokenRetries",
      "sourceNoteTargetCharacters",
      "maxSummaryInputCharacters",
    ])
      delete legacy.limits[key];
    legacy.limits.maxOutputTokens = 8192;
    f.operation.settings = legacy;
    f.generate.mockRejectedValue(new ModelOutputLimitError());
    await expect(f.run()).rejects.toBeInstanceOf(ModelOutputLimitError);
    expect(
      f.generate.mock.calls.map(([request]) => request.maxOutputTokens)
    ).toEqual([8192]);
    f.generate.mockClear();
    await expect(f.run()).rejects.toBeInstanceOf(ModelOutputLimitError);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("recovers truncated source-note generation within the same ceiling and call budget", async () => {
    const f = await fixture();
    f.operation.frames = [];
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: "source".repeat(20_000),
      segments: [],
    };
    let notes = 0;
    f.generate.mockImplementation(async (request) => {
      if (request.schemaName === "ScrubSourceNotes" && ++notes === 1)
        throw new ModelOutputLimitError();
      return {
        value:
          request.schemaName === "ScrubSourceNotes"
            ? { notes: "Grounded notes with timestamps." }
            : summary(),
        provider: "openai",
        model: request.selection.model,
      };
    });
    await f.run();
    const noteCalls = f.generate.mock.calls
      .map(([request]) => request)
      .filter((request) => request.schemaName === "ScrubSourceNotes");
    expect(noteCalls[0].maxOutputTokens).toBe(8192);
    expect(noteCalls[1].maxOutputTokens).toBe(16384);
    expect(
      noteCalls.every(
        (request) =>
          request.maxOutputTokens <= f.operation.settings.limits.maxOutputTokens
      )
    ).toBe(true);
    expect(f.checkpoint().calls).toBe(f.generate.mock.calls.length);
    expect(f.checkpoint().pending).toBeUndefined();
  });

  it("reuses large valid notes under the supplied artifact byte policy", async () => {
    const f = await fixture();
    f.operation.frames = [];
    Object.assign(f.operation.settings.limits, {
      chunkCharacters: 200_000,
      maxSummaryInputCharacters: 512_000,
    });
    f.operation.processingSettings = {
      limits: {
        ...resolveSettings().limits,
        maxArtifactBytes: 4 * 1024 * 1024,
      },
    };
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: "source".repeat(100_000),
      segments: [],
    };
    let noteCalls = 0;
    f.generate.mockImplementation(async (request) => ({
      value:
        request.schemaName === "ScrubSourceNotes"
          ? {
              notes:
                ++noteCalls === 1
                  ? "Large notes ".padEnd(3 * 1024 * 1024, "x")
                  : "Compressed grounded notes.",
            }
          : summary(),
      provider: "openai",
      model: request.selection.model,
    }));
    const original = await f.run();
    expect(f.checkpoint().steps["chunk:0"].artifact.size).toBeGreaterThan(
      2 * 1024 * 1024
    );
    f.generate.mockClear();
    expect((await f.run()).inference.summary).toEqual(
      original.inference.summary
    );
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("enforces the same artifact byte policy before saving an oversized note", async () => {
    const f = await fixture();
    f.operation.frames = [];
    useSmallSourceBudget(f.operation);
    f.operation.processingSettings = {
      limits: { ...resolveSettings().limits, maxArtifactBytes: 1024 },
    };
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: "source".repeat(1000),
      segments: [],
    };
    f.generate.mockResolvedValue({
      value: { notes: "x".repeat(2000) },
      provider: "openai",
      model: "gpt-6-luna",
    });
    await expect(f.run()).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.checkpoint().steps["chunk:0"]).toBeUndefined();
    expect(
      f.published.some(({ kind }) => kind === "inference/source-notes")
    ).toBe(false);
  });

  it("regenerates downstream summaries when one cached note changes while reusing valid sibling notes", async () => {
    const f = await fixture();
    f.operation.frames = [];
    useSmallSourceBudget(f.operation);
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: "original".repeat(1000),
      segments: [],
    };
    f.generate.mockImplementation(async (request) => ({
      value:
        request.schemaName === "ScrubSourceNotes"
          ? { notes: "Original grounded notes" }
          : summary(),
      provider: "openai",
      model: request.selection.model,
    }));
    const original = await f.run();
    const sibling = f.checkpoint().steps["chunk:1"].artifact;
    f.missing.add(f.checkpoint().steps["chunk:0"].artifact.id);
    f.generate.mockClear().mockImplementation(async (request) => ({
      value:
        request.schemaName === "ScrubSourceNotes"
          ? { notes: "Regenerated evidence changed" }
          : summary(),
      provider: "openai",
      model: request.selection.model,
    }));
    const changed = await f.run();
    expect(
      f.generate.mock.calls.map(([request]) => request.schemaName)
    ).toEqual(["ScrubSourceNotes", "ScrubSummary"]);
    expect(f.generate.mock.calls[1][0].prompt).toContain(
      "Regenerated evidence changed"
    );
    expect(f.checkpoint().steps["chunk:1"].artifact).toEqual(sibling);
    expect(changed.inference.summary.id).not.toEqual(
      original.inference.summary.id
    );
  });

  it("feeds every long-transcript character and visual evidence into bounded map/reduce calls", async () => {
    const f = await fixture();
    useSmallSourceBudget(f.operation);
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
    expect(
      noteCalls.every((call) =>
        call.prompt.includes("Aim for at most 1000 characters.")
      )
    ).toBe(true);
    const final = f.generate.mock.calls
      .map((call) => call[0])
      .find((call) => call.schemaName === "ScrubSummary")!;
    expect(final.prompt).toContain("NOTE_");
    expect(await f.storage.has(output.inference.markdown)).toBe(true);
  });

  it("accepts valid notes above the old hard cutoff without omitting source chunks", async () => {
    const f = await fixture();
    f.operation.frames = [];
    const original = `BEGIN_SOURCE_${"x".repeat(100_000)}_END_SOURCE`;
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: original,
      segments: [],
    };
    f.generate.mockImplementation(async (request) => ({
      value:
        request.schemaName === "ScrubSourceNotes"
          ? { notes: "Boundary notes.".padEnd(12_903, "x") }
          : summary(),
      provider: request.selection.provider,
      model: request.selection.model,
    }));
    const output = await f.run();
    const notes = f.generate.mock.calls
      .map(([request]) => request)
      .filter((request) => request.schemaName === "ScrubSourceNotes");
    expect(notes).toHaveLength(3);
    for (const request of notes) {
      expect(request.prompt).toContain("Aim for at most 9000 characters.");
      expect(request.schema).toMatchObject({
        properties: { notes: { type: "string", minLength: 1 } },
      });
      expect((request.schema.properties as any).notes).not.toHaveProperty(
        "maxLength"
      );
      expect(request.maxOutputTokens).toBe(8192);
    }
    expect(
      notes
        .map(
          (request) =>
            request.prompt.match(
              /<source_data>\n([\s\S]*)\n<\/source_data>/
            )![1]
        )
        .join("")
    ).toContain(original);
    const stored = await readArtifactJson<{ notes: string }>(
      f.storage,
      f.checkpoint().steps["chunk:0"].artifact
    );
    expect(stored.notes.length).toBe(12_903);
    expect(f.checkpoint().calls).toBe(4);
    expect(await f.storage.has(output.inference.markdown)).toBe(true);
  });

  it("repairs malformed source notes with safe constraint feedback and reuses completed paid notes", async () => {
    const f = await fixture();
    f.operation.frames = [];
    useSmallSourceBudget(f.operation);
    const sourceMarker = "PRIVATE_SOURCE_SENTINEL";
    const modelMarker = "PRIVATE_MODEL_SENTINEL";
    const keyMarker = "PRIVATE_UNEXPECTED_KEY";
    f.operation.transcript = {
      ...f.operation.transcript,
      fullText: sourceMarker + "x".repeat(5000),
      segments: [],
    };
    let notes = 0;
    f.generate.mockImplementation(async (request) => ({
      value:
        request.schemaName === "ScrubSourceNotes"
          ? ++notes === 1
            ? {
                notes: modelMarker.padEnd(667, "x"),
                [keyMarker]: modelMarker,
              }
            : { notes: "Grounded source notes." }
          : summary(),
      provider: request.selection.provider,
      model: request.selection.model,
    }));
    const first = await f.run();
    const noteCalls = f.generate.mock.calls
      .map(([request]) => request)
      .filter((request) => request.schemaName === "ScrubSourceNotes");
    const feedback = noteCalls[1].prompt.split("\nValidator feedback: ")[1];
    expect(noteCalls[1].prompt).toContain(
      "previous response failed validation"
    );
    expect(feedback).toContain("1 unexpected field(s); allowed field: notes");
    expect(feedback.length).toBeLessThanOrEqual(512);
    for (const marker of [sourceMarker, modelMarker, keyMarker])
      expect(feedback).not.toContain(marker);
    expect(f.checkpoint().calls).toBe(f.generate.mock.calls.length);
    expect(
      await readArtifactJson(
        f.storage,
        f.checkpoint().steps["chunk:0"].artifact
      )
    ).toEqual({ notes: "Grounded source notes." });
    expect(
      f.published.filter(({ kind }) => kind === "inference/source-notes")
    ).toHaveLength(noteCalls.length - 1);
    const charged = f.checkpoint().calls;
    f.generate.mockClear();
    const resumed = await f.run();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.checkpoint().calls).toBe(charged);
    expect(resumed.inference.summary).toEqual(first.inference.summary);
  });

  it.each([
    {
      value: { notes: 42, PRIVATE_UNEXPECTED_KEY: "PRIVATE_MODEL_SENTINEL" },
      diagnostic: "notes must be a string; received number",
    },
    {
      value: { notes: "   " },
      diagnostic:
        "notes must contain at least 1 non-whitespace character; trimmed length 0",
    },
    {
      value: {
        notes: "Valid notes",
        PRIVATE_UNEXPECTED_KEY: "PRIVATE_MODEL_SENTINEL",
      },
      diagnostic:
        "response contains 1 unexpected field(s); allowed field: notes",
    },
    {
      value: ["PRIVATE_MODEL_SENTINEL"],
      diagnostic: "response must be an object; received array",
    },
    {
      value: "PRIVATE_MODEL_SENTINEL",
      diagnostic: "response must be an object; received string",
    },
  ])(
    "reports bounded source-note constraints without exposing input values: $diagnostic",
    async ({ value, diagnostic }) => {
      const f = await fixture();
      f.operation.frames = [];
      useSmallSourceBudget(f.operation);
      f.operation.settings.limits.repairAttempts = 0;
      f.operation.transcript = {
        ...f.operation.transcript,
        fullText: "PRIVATE_SOURCE_SENTINEL" + "x".repeat(3000),
        segments: [],
      };
      f.generate.mockImplementation(async (request) => ({
        value,
        provider: request.selection.provider,
        model: request.selection.model,
      }));
      const failure = await f.run().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PipelineError);
      const error = failure as PipelineError;
      expect(error.toJSON()).toMatchObject({
        code: "invalid_model_output",
        stage: "summary",
        retryable: true,
      });
      expect(error.message).toContain(diagnostic);
      expect(error.message.length).toBeLessThanOrEqual(600);
      expect(error.cause).toBeUndefined();
      for (const marker of [
        "PRIVATE_MODEL_SENTINEL",
        "PRIVATE_SOURCE_SENTINEL",
        "PRIVATE_UNEXPECTED_KEY",
      ])
        expect(JSON.stringify(error)).not.toContain(marker);
      expect(f.checkpoint()).toMatchObject({ calls: 1, steps: {} });
      expect(
        f.published.some(({ kind }) => kind === "inference/source-notes")
      ).toBe(false);
    }
  );

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
