import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeCliFixture,
  readJson,
} from "../helpers/native-cli-fixture.js";
const fixtures: Awaited<ReturnType<typeof createNativeCliFixture>>[] = [];
async function fixture() {
  const value = await createNativeCliFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()));
});

function summary() {
  return {
    title: "Model response",
    tldr: "Portable media produces artifacts.",
    overview: "A fixture summary.",
    thesisAndClaims: { thesis: "Keep the pipeline reusable", keyClaims: [] },
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
    confidence: { level: "high", reasoning: "Fixture" },
    sections: [],
    keyTakeaways: [],
    codeSnippets: [],
    references: [],
  };
}

describe("local CLI file and artifact integration", () => {
  it("projects a local MP4 into the legacy layout and source metadata identity", async () => {
    const f = await fixture();
    const input = await f.file("meeting recording.mp4");
    const result = await f.run(["file", input]);
    expect(result.timedOut, result.stdout + result.stderr).toBe(false);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const dir = join(f.output, "meeting-recording");
    const id = `local-${createHash("sha256").update(input).digest("hex").slice(0, 11)}`;
    expect(await readJson(join(dir, "source/metadata.json"))).toMatchObject({
      contentId: id,
      title: "meeting recording",
      source: "Local File",
      url: `file://${input}`,
    });
    expect(
      await readFile(join(dir, "transcription/transcript.txt"), "utf8")
    ).toContain("fixture local media");
    await access(join(dir, "source/video.mp4"));
    expect(await readJson(join(dir, "frames/frames.json"))).toHaveLength(2);
    expect(await readJson(join(f.output, "index.json"))).toMatchObject({
      media: { [id]: { outputPath: "meeting-recording" } },
    });
    expect(
      (await f.calls()).filter((call) => call.tool === "yt-dlp")
    ).toHaveLength(0);
  });

  it("skips visuals for MP3 and respects an explicit output directory", async () => {
    const f = await fixture();
    const input = await f.file("podcast.mp3");
    const output = join(f.root, "audio output");
    const result = await f.run(["file", input, "--output-dir", output]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const dir = join(output, "podcast");
    expect(await readJson(join(dir, "manifest.json"))).toMatchObject({
      artifacts: { frames: { count: 0 }, source: { video: false } },
    });
    await access(join(dir, "prompt/summary.prompt.md"));
    expect(
      (await f.calls()).some(
        (call) => call.tool === "ffmpeg" && call.args.includes("-filter:v")
      )
    ).toBe(false);
  });

  it("preserves prompt/render primitives and configured full transcript rendering", async () => {
    const f = await fixture();
    await f.includeTranscript(true);
    const transcript = await f.file(
      "transcript.json",
      JSON.stringify({
        segments: [
          { start: 0, end: 5, text: "A complete fixture transcript." },
        ],
        fullText: "A complete fixture transcript.",
        language: "en",
        duration: 5,
        source: "local-whisper",
      })
    );
    const metadata = await f.file(
      "metadata.json",
      JSON.stringify({
        contentId: "notes",
        title: "Artifact round trip",
        description: "",
        duration: 5,
        thumbnailUrl: "",
        source: "File",
        uploadDate: "2026-01-01",
        url: "https://example.com/notes",
      })
    );
    const prompt = join(f.root, "prompt.md");
    const schema = join(f.root, "schema.json");
    const prompted = await f.run([
      "prompt",
      transcript,
      "-o",
      prompt,
      "--schema",
      schema,
      "--metadata",
      metadata,
    ]);
    expect(prompted.exitCode, prompted.stderr).toBe(0);
    expect(await readFile(prompt, "utf8")).toContain(
      "[0:00] A complete fixture transcript."
    );
    expect(await readJson(schema)).toMatchObject({ title: "ScrubSummary" });
    const response = await f.file("summary.json", JSON.stringify(summary()));
    const markdown = join(f.root, "summary.md");
    const rendered = await f.run([
      "render",
      response,
      "-o",
      markdown,
      "--metadata",
      metadata,
      "--transcript",
      transcript,
    ]);
    expect(rendered.exitCode, rendered.stderr).toBe(0);
    const text = await readFile(markdown, "utf8");
    expect(text).toContain("# Artifact round trip");
    expect(text).toContain("## Full Transcript");
    expect(text).toContain("A complete fixture transcript.");
    expect(text).not.toContain("on 1970-01-01T00:00:00.000Z");
  });

  it("rejects unsupported local files before media execution", async () => {
    const f = await fixture();
    const input = await f.file("notes.pdf");
    const result = await f.run(["file", input]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain("Unsupported file type");
    expect(
      (await f.calls()).some(
        (call) => call.tool === "ffprobe" || call.tool === "ffmpeg"
      )
    ).toBe(false);
  });

  it("requires configured models for --summarize before media processing", async () => {
    const f = await fixture();
    const input = await f.file("meeting.mp4");
    const result = await f.run(["file", input, "--summarize"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toContain(
      "configured model credentials"
    );
    expect(
      (await f.calls()).some((call) =>
        ["ffprobe", "ffmpeg", "whisper", "yt-dlp"].includes(call.tool)
      )
    ).toBe(false);
  });

  it.each(["mp4", "mp3"])(
    "projects full %s inference artifacts and reuses paid steps through the shared local adapter",
    async (extension) => {
      const f = await fixture();
      const input = await f.file(`knowledge recording.${extension}`);
      const pipeline = fileURLToPath(
        new URL("../../src/infrastructure/node/cli/file.ts", import.meta.url)
      );
      const modelSummary = summary();
      const script = await f.file(
        "full-pipeline.mjs",
        `
      import { processFile } from ${JSON.stringify(pipeline)};
      let calls = 0;
      const summary = ${JSON.stringify(modelSummary)};
      delete summary.title;
      const models = {
        supports(selection) { return ${extension === "mp4"} || selection.model === "summary"; },
        async generate(request) {
          calls++;
          const value = request.schemaName === "ScrubFrameAnalysis"
            ? {description:"A fixture diagram",extractedText:"fixture OCR",visualType:"diagram"}
            : summary;
          return {value,provider:request.selection.provider,model:request.selection.model,usage:{inputTokens:10,outputTokens:10}};
        },
      };
      const options = {models,inference:{mode:"full",summary:{provider:"fixture",model:"summary"},vision:{provider:"fixture",model:"vision"}}};
      const first = await processFile(${JSON.stringify(input)}, options);
      if (!first.summaryPath || first.outputPath !== first.summaryPath) throw new Error("Missing primary summary output");
      const before = calls;
      const second = await processFile(${JSON.stringify(input)}, options);
      if (!second.reused || calls !== before) throw new Error("Completed inference was repeated");
      console.log(first.summaryPath);
    `
      );
      const result = await f.run([], 12_000, script);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      const directory = join(f.output, "knowledge-recording");
      const visuals = await readJson<
        Array<{ timestamp: number; extractedText: string }>
      >(join(directory, "inference/visual_analysis.json"));
      expect(visuals.map((value) => value.timestamp)).toEqual(
        extension === "mp4" ? [5, 12] : []
      );
      expect(
        visuals.every((value) => value.extractedText === "fixture OCR")
      ).toBe(true);
      const structuredSummary = await readJson(
        join(directory, "inference/summary.json")
      );
      expect(structuredSummary).toMatchObject({ tldr: modelSummary.tldr });
      expect(structuredSummary).not.toHaveProperty("title");
      expect(
        await readJson(join(directory, "source/metadata.json"))
      ).toMatchObject({ title: "knowledge recording" });
      expect(
        await readFile(join(directory, "output/summary.md"), "utf8")
      ).toContain("# knowledge recording");
      expect(
        await readJson(join(directory, "inference/model_usage.json"))
      ).toMatchObject({ calls: extension === "mp4" ? 3 : 1 });
      const finalPrompt = await readFile(
        join(directory, "prompt/summary.prompt.md"),
        "utf8"
      );
      if (extension === "mp4") expect(finalPrompt).toContain("fixture OCR");
      else expect(finalPrompt).toContain("No visual analysis available.");
    }
  );
});
