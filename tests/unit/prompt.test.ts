import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildPromptArtifacts } from "../../src/core/prompt.js";
import type { MediaMetadata } from "../../src/types/index.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "scrub-prompt-"));

  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({
      segments: [
        { start: 0, end: 8, text: "Welcome to the talk." },
        { start: 8, end: 20, text: "Today we cover hooks." },
      ],
      fullText: "Welcome to the talk. Today we cover hooks.",
      language: "en",
      duration: 20,
      source: "youtube-captions",
    })
  );

  const meta: MediaMetadata = {
    contentId: "abc",
    title: "Real Title From Metadata",
    description: "desc",
    duration: 20,
    thumbnailUrl: "",
    source: "YouTube",
    uploadDate: "2026-01-01",
    url: "https://youtu.be/abc",
  };
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));

  writeFileSync(join(dir, "notes.txt"), "just some plain text notes");

  writeFileSync(
    join(dir, "visual_analysis.json"),
    JSON.stringify([
      {
        timestamp: 30,
        description: "Slide titled Hooks",
        extractedText: "useState",
        visualType: "slide",
      },
    ])
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildPromptArtifacts", () => {
  it("formats a JSON transcript into timestamped content with default metadata", () => {
    const { prompt, schema, metadata } = buildPromptArtifacts(
      join(dir, "transcript.json")
    );

    expect(prompt).toContain("[0:00] Welcome to the talk.");
    expect(prompt).toContain("[0:08] Today we cover hooks.");
    expect(prompt).toContain("## CONTENT");
    // No metadata file → title falls back to the file's basename
    expect(metadata.title).toBe("transcript");
    expect(schema.title).toBe("ScrubSummary");
    expect(schema.required).toHaveLength(18);
  });

  it("uses supplied metadata.json when provided", () => {
    const { prompt, metadata } = buildPromptArtifacts(
      join(dir, "transcript.json"),
      { metadataPath: join(dir, "metadata.json") }
    );
    expect(metadata.title).toBe("Real Title From Metadata");
    expect(prompt).toContain("- Title: Real Title From Metadata");
  });

  it("passes plain .txt content through verbatim (no timestamp formatting)", () => {
    const { prompt } = buildPromptArtifacts(join(dir, "notes.txt"));
    expect(prompt).toContain("## CONTENT\njust some plain text notes");
    expect(prompt).not.toContain("[0:00]");
  });

  it("folds in visual analysis when a visuals path is given", () => {
    const { prompt } = buildPromptArtifacts(join(dir, "transcript.json"), {
      visualsPath: join(dir, "visual_analysis.json"),
    });
    expect(prompt).toContain("[0:30] (slide)");
    expect(prompt).toContain("Description: Slide titled Hooks");
    expect(prompt).not.toContain("No visual analysis available.");
  });

  it("throws a clear error when the input file is missing", () => {
    expect(() => buildPromptArtifacts(join(dir, "nope.json"))).toThrow(
      "File not found"
    );
  });
});
