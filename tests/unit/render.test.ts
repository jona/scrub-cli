import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { MediaMetadata, SummaryResult } from "../../src/types/index.js";

vi.mock("../../src/infrastructure/Config.js", () => ({
  config: {
    getOutput: vi.fn(() => ({
      directory: "./out",
      includeFullTranscript: false,
    })),
  },
}));

import { renderSummaryFile } from "../../src/infrastructure/node/render.js";

let dir: string;

function minimalSummary(): SummaryResult {
  return {
    title: "Title From Summary",
    tldr: "tldr text",
    overview: "overview text",
    thesisAndClaims: { thesis: "t", keyClaims: [] },
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
    difficulty: { level: "beginner", prerequisites: [], targetAudience: "" },
    reusabilityPrompts: {},
    confidence: { level: "high", reasoning: "" },
    sections: [],
    keyTakeaways: [],
    codeSnippets: [],
    references: [],
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "scrub-render-"));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(minimalSummary()));

  const meta: MediaMetadata = {
    contentId: "abc",
    title: "Title From Metadata",
    description: "",
    duration: 0,
    thumbnailUrl: "",
    source: "YouTube",
    uploadDate: "2026-01-01",
    url: "https://youtu.be/abc",
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("renderSummaryFile", () => {
  it("renders markdown, defaulting the title from the summary itself", () => {
    const md = renderSummaryFile(join(dir, "summary.json"));
    expect(md).toContain("# Title From Summary");
    expect(md).toContain("> tldr text");
  });

  it("prefers metadata.json for the header when provided", () => {
    const md = renderSummaryFile(join(dir, "summary.json"), {
      metadataPath: join(dir, "metadata.json"),
    });
    expect(md).toContain("# Title From Metadata");
    expect(md).toContain("https://youtu.be/abc");
  });

  it("throws a clear error when the summary file is missing", () => {
    expect(() => renderSummaryFile(join(dir, "missing.json"))).toThrow(
      "Summary file not found"
    );
  });
});
