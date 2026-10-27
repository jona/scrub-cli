import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "../../src/infrastructure/Config.js";
import { ArtifactStore } from "../../src/infrastructure/filesystem/ArtifactStore.js";
import type { SummaryResult, SceneFrame } from "../../src/types/index.js";

let root: string;
let store: ArtifactStore;

function minimalSummary(): SummaryResult {
  return {
    title: "t",
    tldr: "",
    overview: "",
    thesisAndClaims: { thesis: "", keyClaims: [] },
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
  root = mkdtempSync(join(tmpdir(), "scrub-store-"));
  config.setOutputDir(root);
  store = new ArtifactStore();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ArtifactStore directory creation", () => {
  it("creates only the dirs the deterministic pipeline writes — not inference/ or output/", () => {
    store.ensureVideoDirectories("v1", "My Test Video");
    const base = join(root, "my-test-video");
    expect(readdirSync(base).sort()).toEqual([
      "frames",
      "prompt",
      "source",
      "transcription",
    ]);
  });

  it("creates inference/ lazily, only when something is written there", () => {
    store.ensureVideoDirectories("v2", "Lazy Inference");
    const base = join(root, "lazy-inference");
    expect(existsSync(join(base, "inference"))).toBe(false);

    store.saveSummary("v2", minimalSummary());
    expect(existsSync(join(base, "inference", "summary.json"))).toBe(true);
  });
});

describe("ArtifactStore deterministic writers", () => {
  it("savePrompt writes both the prompt and the schema and returns the prompt path", () => {
    const promptPath = store.savePrompt("v3", "PROMPT BODY", {
      type: "object",
    });
    const base = store.getVideoDir("v3");

    expect(promptPath).toBe(join(base, "prompt", "summary.prompt.md"));
    expect(readFileSync(promptPath, "utf-8")).toBe("PROMPT BODY");

    const schemaPath = join(base, "prompt", "summary.schema.json");
    expect(JSON.parse(readFileSync(schemaPath, "utf-8"))).toEqual({
      type: "object",
    });
  });

  it("saveFramesManifest records timestamps with paths relative to the video dir", () => {
    const base = join(root, "frames-vid");
    store.ensureVideoDirectories("v4", "Frames Vid");
    const frames: SceneFrame[] = [
      { timestamp: 1.5, framePath: join(base, "frames", "frame_001.png") },
      { timestamp: 9, framePath: join(base, "frames", "frame_002.png") },
    ];
    const manifestPath = store.saveFramesManifest("v4", frames);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    expect(manifest).toHaveLength(2);
    expect(manifest[0]).toMatchObject({
      timestamp: 1.5,
      path: join("frames", "frame_001.png"),
    });
  });
});

describe("ArtifactStore.getArtifactPath", () => {
  it("maps artifact types to the expected on-disk locations", () => {
    expect(store.getArtifactPath("v1", "prompt/summary")).toMatch(
      /prompt\/summary\.prompt\.md$/
    );
    expect(store.getArtifactPath("v1", "prompt/schema")).toMatch(
      /prompt\/summary\.schema\.json$/
    );
    expect(store.getArtifactPath("v1", "frames/json")).toMatch(
      /frames\/frames\.json$/
    );
    expect(store.getArtifactPath("v1", "transcription/json")).toMatch(
      /transcription\/transcript\.json$/
    );
  });
});
