import { describe, expect, it } from "vitest";
import {
  createPromptArtifact,
  createRenderedArtifact,
  MAX_INPUT_BYTES,
} from "../../src/core/artifacts.js";
import {
  PipelineError,
  serializePipelineError,
  throwIfAborted,
} from "../../src/core/errors.js";
import {
  parseYouTubeSource,
  canonicalizeYouTubeVideo,
  extractVideoId,
  extractPlaylistId,
} from "../../src/core/source.js";

function modelResponse() {
  return {
    tldr: "Actors keep document state.",
    overview: "A short introduction to durable jobs.",
    thesisAndClaims: {
      thesis: "Use durable jobs",
      keyClaims: [{ claim: "State persists" }],
    },
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
    confidence: { level: "high", reasoning: "A working example" },
    sections: [],
    keyTakeaways: ["Use a document key"],
    codeSnippets: [
      { code: "const document = client.scrub.getOrCreate([key]);" },
    ],
    references: [],
  };
}

describe("Prompt artifacts", () => {
  it("generates the existing prompt and output schema from in-memory content", () => {
    const artifact = createPromptArtifact({
      metadata: { title: "Actor notes", source: "Workshop", duration: 61 },
      content: "[0:00] A job record stores each document.",
      visuals: [
        { timestamp: 30, description: "Actor diagram", visualType: "diagram" },
      ],
    });

    expect(artifact.metadata).toEqual({
      contentId: "unknown",
      title: "Actor notes",
      description: "",
      duration: 61,
      thumbnailUrl: "",
      source: "Workshop",
      uploadDate: "",
      url: "",
    });
    expect(artifact.prompt).toContain("- Duration: 1:01");
    expect(artifact.prompt).toContain(
      "[0:00] A job record stores each document."
    );
    expect(artifact.prompt).toContain("[0:30] (diagram)");
    expect(artifact.schema.required).toContain("sections");
  });

  it.each([
    { metadata: { title: "" }, content: "notes" },
    { metadata: { title: "Notes", duration: -1 }, content: "notes" },
    { metadata: { title: "Notes" }, content: "  " },
    {
      metadata: { title: "Notes" },
      content: "notes",
      metadataPath: "/etc/passwd",
    },
    {
      metadata: { title: "Notes" },
      content: "notes",
      visuals: [{ timestamp: -1, description: "", visualType: "slide" }],
    },
  ])("rejects malformed or filesystem-oriented inputs: %j", (input) => {
    expect(() => createPromptArtifact(input)).toThrow();
  });

  it("limits total encoded bytes, including multibyte content", () => {
    const content = "💡".repeat(70_000);
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(
      MAX_INPUT_BYTES
    );
    expect(() =>
      createPromptArtifact({ metadata: { title: "Notes" }, content })
    ).toThrow("Input exceeds");
  });
  it("rejects oversized raw input before validating nested collections", () => {
    const input = {
      metadata: { title: "Notes" },
      content: "notes",
      visuals: Array.from({ length: 30_000 }, () => ({ invalid: true })),
    };
    expect(() => createPromptArtifact(input)).toThrow("Input exceeds");
    expect(() => createRenderedArtifact(input)).toThrow("Input exceeds");
  });

  it.each([undefined, null, [], "notes", 42])(
    "rejects a non-object action argument: %j",
    (input) => {
      expect(() => createPromptArtifact(input)).toThrow(
        "Input must be an object"
      );
      expect(() => createRenderedArtifact(input)).toThrow(
        "Input must be an object"
      );
    }
  );
});

describe("Rendered artifacts", () => {
  it("uses the caller's explicit rendering context", () => {
    const artifact = createRenderedArtifact(
      { metadata: { title: "Actor notes" }, summary: modelResponse() },
      {
        generatedAt: "2026-10-26T13:00:00.000Z",
      }
    );
    expect(artifact.markdown).toContain("on 2026-10-26T13:00:00.000Z");
  });
  it("accepts model-schema JSON without title or snippet timestamps", () => {
    const artifact = createRenderedArtifact({
      metadata: { title: "Actor notes", url: "https://example.com/notes" },
      summary: modelResponse(),
    });

    expect(artifact.markdown).toContain("# Actor notes");
    expect(artifact.markdown).toContain("> Actors keep document state.");
    expect(artifact.markdown).toContain("Code at 0:00");
    expect(artifact.markdown).toContain(
      "const document = client.scrub.getOrCreate([key]);"
    );
  });

  it("rejects missing nested summary fields before rendering", () => {
    expect(() =>
      createRenderedArtifact({
        metadata: { title: "Actor notes" },
        summary: { ...modelResponse(), knowledgeGraph: { topics: [] } },
      })
    ).toThrow();
  });

  it("rejects invalid enum values and section ranges", () => {
    expect(() =>
      createRenderedArtifact({
        metadata: { title: "Actor notes" },
        summary: {
          ...modelResponse(),
          confidence: { level: "certain", reasoning: "" },
        },
      })
    ).toThrow();
    expect(() =>
      createRenderedArtifact({
        metadata: { title: "Actor notes" },
        summary: {
          ...modelResponse(),
          sections: [
            { title: "Intro", startTime: 10, endTime: 2, content: "notes" },
          ],
        },
      })
    ).toThrow("endTime must");
  });

  it("does not mutate model data when supplying renderer defaults", () => {
    const summary = modelResponse();
    const before = structuredClone(summary);
    createRenderedArtifact({ metadata: { title: "Actor notes" }, summary });
    expect(summary).toEqual(before);
    expect(summary.codeSnippets[0]).not.toHaveProperty("timestamp");
  });
});

describe("Portable source identities", () => {
  const id = "dQw4w9WgXcQ";

  it.each([
    id,
    `https://youtu.be/${id}?t=30`,
    `https://www.youtube.com/watch?v=${id}&feature=shared`,
    `https://m.youtube.com/shorts/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ])("normalizes a valid source: %s", (input) => {
    expect(parseYouTubeSource(input)).toEqual({
      kind: "video",
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  });

  it("retains playlist membership while supporting explicit single-video extraction", () => {
    const input = `https://www.youtube.com/watch?v=${id}&list=PL_example123&index=2`;
    expect(parseYouTubeSource(input)).toEqual({
      kind: "playlist",
      videoId: id,
      playlistId: "PL_example123",
      url: "https://www.youtube.com/playlist?list=PL_example123",
    });
    expect(canonicalizeYouTubeVideo(input)).toBe(
      `https://www.youtube.com/watch?v=${id}`
    );
    expect(extractVideoId(input)).toBe(id);
    expect(extractPlaylistId(input)).toBe("PL_example123");
    expect(
      extractVideoId("https://www.youtube.com/playlist?list=PL_example123")
    ).toBeNull();
  });

  it.each([
    `https://evil.example/youtube.com/watch?v=${id}`,
    `https://youtube.com.evil.example/watch?v=${id}`,
    `https://user:password@youtube.com/watch?v=${id}`,
    `https://youtube.com:9999/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&v=aaaaaaaaaaa`,
    'https://youtube.com/watch?v=x";echo hacked',
    "file:///tmp/youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/playlist?list=bad%20value",
  ])("rejects an unsafe or ambiguous source: %s", (input) => {
    expect(() => parseYouTubeSource(input)).toThrow(PipelineError);
    expect(extractVideoId(input)).toBeNull();
  });
});

describe("Portable pipeline failures", () => {
  it("retains causes locally while serializing stable failure data", () => {
    const cause = new Error("Provider diagnostics");
    const error = new PipelineError("timeout", "Transcription timed out", {
      stage: "transcribe",
      retryable: true,
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(serializePipelineError(error)).toEqual({
      code: "timeout",
      message: "Transcription timed out",
      stage: "transcribe",
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain("Provider diagnostics");
  });

  it("turns cancellation into a nonretryable domain failure", () => {
    expect(() => throwIfAborted({ aborted: false })).not.toThrow();
    try {
      throwIfAborted({ aborted: true, reason: "User cancelled" }, "download");
      throw new Error("Expected cancellation");
    } catch (error) {
      expect(serializePipelineError(error)).toEqual({
        code: "cancelled",
        message: "Processing cancelled",
        stage: "download",
        retryable: false,
      });
    }
  });
});
