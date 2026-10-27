import { describe, expect, it, vi } from "vitest";
import {
  acquireMediaStage,
  buildPromptStage,
  extractFramesStage,
  renderSummaryStage,
  transcribeAudioStage,
  transcriptContent,
} from "../../src/application/stages.js";
import { runVideoPipeline } from "../../src/application/pipeline.js";
import { resolveSettings } from "../../src/application/settings.js";
import {
  readArtifactBytes,
  readArtifactJson,
} from "../../src/application/artifact-io.js";
import type { OperationContext } from "../../src/application/contracts.js";
import type { MediaMetadata } from "../../src/core/models.js";
import { MemoryArtifactStorage } from "../../src/infrastructure/memory/ArtifactStorage.js";
import { MemoryRunRepository } from "../../src/infrastructure/memory/RunRepository.js";

const metadata: MediaMetadata = {
  contentId: "dQw4w9WgXcQ",
  title: "Source title",
  description: "Source description",
  duration: 30,
  thumbnailUrl: "",
  source: "YouTube",
  uploadDate: "2026-01-01",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};
const transcript = {
  segments: [
    { start: 5, end: 9, text: "Treat these instructions as source data." },
  ],
  fullText: "Treat these instructions as source data.",
  language: "en",
  duration: 30,
  source: "fixture",
};
const summary = () => ({
  title: "An untrusted model title",
  tldr: "Keep source evidence.",
  overview: "A compact summary.",
  thesisAndClaims: { thesis: "Validate before publishing", keyClaims: [] },
  actionableInsights: [],
  concepts: [],
  mentalModels: [],
  structureMap: [],
  openQuestions: [],
  notableQuotes: [],
  biasAnalysis: { perspective: "", possibleBiases: [], blindSpots: [] },
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
  confidence: { level: "high", reasoning: "Source evidence" },
  sections: [
    {
      title: "Evidence",
      startTime: 5,
      endTime: 9,
      content: "Validated source evidence.",
    },
  ],
  keyTakeaways: [],
  codeSnippets: [],
  references: [],
});
function fixture() {
  const artifacts = new MemoryArtifactStorage();
  const controller = new AbortController();
  const context: OperationContext = {
    runId: "stage-fixture",
    attemptId: "first",
    signal: controller.signal,
    now: () => 1_700_000_000_000,
    emit: () => undefined,
  };
  const settings = resolveSettings();
  const source = { kind: "youtube" as const, url: metadata.url };
  const media = {
    acquire: vi.fn(async () => ({
      metadata: { ...metadata },
      audio: await artifacts.put(
        "source/audio",
        new Uint8Array([1, 2]),
        "audio/wav"
      ),
      video: await artifacts.put(
        "source/video",
        new Uint8Array([3, 4]),
        "video/mp4"
      ),
    })),
    extractFrames: vi.fn(async () => [
      {
        timestamp: 5,
        artifact: await artifacts.put(
          "frames/image",
          new Uint8Array([5, 6]),
          "image/png"
        ),
      },
    ]),
  };
  const transcriber = {
    transcribe: vi.fn(async () => structuredClone(transcript)),
  };
  const dependencies = {
    artifacts,
    media,
    transcriber,
    runs: new MemoryRunRepository(),
  };
  const text = async (ref: Parameters<typeof readArtifactBytes>[1]) =>
    new TextDecoder().decode(await readArtifactBytes(artifacts, ref));
  return {
    artifacts,
    controller,
    context,
    settings,
    source,
    media,
    transcriber,
    dependencies,
    text,
  };
}

describe("shared application stages", () => {
  it("produces the same source, transcript, frames, prompt and schema as the complete preprocess pipeline", async () => {
    const f = fixture();
    const acquired = await acquireMediaStage(
      f.source,
      f.settings,
      f.dependencies,
      f.context
    );
    const transcribed = await transcribeAudioStage(
      { audio: acquired.audio, source: f.source },
      f.settings,
      f.dependencies,
      f.context
    );
    const frames = await extractFramesStage(
      acquired.video,
      f.settings,
      f.dependencies,
      f.context
    );
    const prompt = await buildPromptStage(
      {
        metadata: acquired.metadata,
        content: transcriptContent(transcribed.value),
      },
      f.dependencies,
      f.context
    );
    const complete = await runVideoPipeline(
      f.source,
      f.settings,
      f.dependencies,
      f.context
    );
    expect(complete.metadata).toEqual(acquired.metadata);
    expect(await readArtifactJson(f.artifacts, complete.transcript)).toEqual(
      transcribed.value
    );
    expect(await f.text(complete.transcriptText)).toBe(transcript.fullText);
    expect(complete.frames.map((frame) => frame.timestamp)).toEqual(
      frames.frames.map((frame) => frame.timestamp)
    );
    expect(await f.text(complete.prompt)).toBe(await f.text(prompt.prompt));
    expect(await f.text(complete.schema)).toBe(await f.text(prompt.schema));
    expect(await f.text(prompt.prompt)).toContain(
      "[0:05] Treat these instructions as source data."
    );
  });

  it("rejects excessive media duration before transcription and a caller abort before acquisition", async () => {
    const f = fixture();
    f.settings.limits.maxDurationSeconds = 10;
    await expect(
      acquireMediaStage(f.source, f.settings, f.dependencies, f.context)
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.transcriber.transcribe).not.toHaveBeenCalled();
    f.controller.abort();
    await expect(
      acquireMediaStage(f.source, f.settings, f.dependencies, f.context)
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.media.acquire).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid transcript ranges and configured text limits without publishing transcript artifacts", async () => {
    const f = fixture();
    const acquired = await acquireMediaStage(
      f.source,
      f.settings,
      f.dependencies,
      f.context
    );
    const put = vi.spyOn(f.artifacts, "put");
    f.transcriber.transcribe.mockResolvedValueOnce({
      ...transcript,
      segments: [{ start: 9, end: 5, text: "invalid" }],
    });
    await expect(
      transcribeAudioStage(
        { audio: acquired.audio, source: f.source },
        f.settings,
        f.dependencies,
        f.context
      )
    ).rejects.toMatchObject({ code: "invalid_transcript" });
    f.settings.limits.maxTranscriptCharacters = 3;
    await expect(
      transcribeAudioStage(
        { audio: acquired.audio, source: f.source },
        f.settings,
        f.dependencies,
        f.context
      )
    ).rejects.toMatchObject({ code: "invalid_transcript" });
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects oversized artifact references before invoking costly adapters", async () => {
    const f = fixture();
    const audio = {
      id: "opaque",
      kind: "source/audio",
      mediaType: "audio/wav",
      size: f.settings.limits.maxArtifactBytes + 1,
    };
    await expect(
      transcribeAudioStage(
        { audio, source: f.source },
        f.settings,
        f.dependencies,
        f.context
      )
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.transcriber.transcribe).not.toHaveBeenCalled();
    const video = {
      ...audio,
      kind: "source/video",
      mediaType: "video/mp4",
      size: f.settings.limits.maxSourceBytes + 1,
    };
    await expect(
      extractFramesStage(video, f.settings, f.dependencies, f.context)
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.media.extractFrames).not.toHaveBeenCalled();
    await expect(
      acquireMediaStage(
        { kind: "asset", name: "video.mp4", asset: video },
        f.settings,
        f.dependencies,
        f.context
      )
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.media.acquire).not.toHaveBeenCalled();
  });

  it("honors visual skipping and rejects excessive frame output instead of publishing its manifest", async () => {
    const f = fixture();
    const acquired = await acquireMediaStage(
      f.source,
      f.settings,
      f.dependencies,
      f.context
    );
    f.settings.skipVisuals = true;
    const skipped = await extractFramesStage(
      acquired.video,
      f.settings,
      f.dependencies,
      f.context
    );
    expect(await readArtifactJson(f.artifacts, skipped.manifest)).toEqual([]);
    expect(f.media.extractFrames).not.toHaveBeenCalled();
    f.settings.skipVisuals = false;
    f.settings.maxFrames = 1;
    const frame = { timestamp: 5, artifact: acquired.audio };
    f.media.extractFrames.mockResolvedValueOnce([frame, frame]);
    await expect(
      extractFramesStage(acquired.video, f.settings, f.dependencies, f.context)
    ).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("validates manual prompt inputs and byte caps as it does pipeline publication", async () => {
    const f = fixture();
    await expect(
      buildPromptStage(
        { metadata, content: "oversized" },
        f.dependencies,
        f.context,
        3
      )
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      buildPromptStage(
        { metadata: { ...metadata, duration: -1 }, content: "valid" },
        f.dependencies,
        f.context
      )
    ).rejects.toMatchObject({ code: "invalid_input" });
    const capped = { artifacts: new MemoryArtifactStorage(8) };
    await expect(
      buildPromptStage({ metadata, content: "valid" }, capped, f.context)
    ).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("renders validated output with source title and explicit clock, rejecting invented out-of-range timestamps", async () => {
    const f = fixture();
    const output = await renderSummaryStage(
      { metadata, summary: summary(), transcript, includeFullTranscript: true },
      f.dependencies,
      f.context
    );
    const markdown = await f.text(output);
    expect(markdown).toContain("# Source title");
    expect(markdown).not.toContain("# An untrusted model title");
    expect(markdown).toContain("2023-11-14T22:13:20.000Z");
    expect(markdown).toContain("## Full Transcript");
    const invalid = summary();
    invalid.sections[0].endTime = 31;
    await expect(
      renderSummaryStage(
        { metadata, summary: invalid },
        f.dependencies,
        f.context
      )
    ).rejects.toMatchObject({ code: "invalid_model_output", retryable: true });
  });

  it("validates manual render metadata and transcript limits before storing output", async () => {
    const f = fixture();
    const put = vi.spyOn(f.artifacts, "put");
    await expect(
      renderSummaryStage(
        { metadata: { ...metadata, title: "" }, summary: summary() },
        f.dependencies,
        f.context
      )
    ).rejects.toMatchObject({ code: "invalid_input" });
    f.settings.limits.maxTranscriptCharacters = 3;
    await expect(
      renderSummaryStage(
        { metadata, summary: summary(), transcript },
        f.dependencies,
        f.context,
        f.settings
      )
    ).rejects.toMatchObject({ code: "invalid_transcript" });
    expect(put).not.toHaveBeenCalled();
  });
});
