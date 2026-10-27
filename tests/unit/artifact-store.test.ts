import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ArtifactStore } from "../../src/infrastructure/filesystem/ArtifactStore.js";
import type { SceneFrame } from "../../src/types/index.js";

let root: string;
let store: ArtifactStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "scrub-store-"));
  store = new ArtifactStore({ outputDirectory: root });
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
});

describe("ArtifactStore deterministic writers", () => {
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
