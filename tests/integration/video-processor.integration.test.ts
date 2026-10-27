import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeCliFixture,
  FIRST_VIDEO,
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

describe("local CLI YouTube integration", () => {
  it("preserves command help and processes a single video through actual native adapters", async () => {
    const f = await fixture();
    const help = await f.run(["--help"]);
    expect(help.exitCode, help.stderr).toBe(0);
    for (const command of [
      "youtube",
      "file",
      "download",
      "prepare",
      "transcribe",
      "extract-frames",
      "prompt",
      "render",
      "doctor",
      "transcribers",
    ])
      expect(help.stdout).toContain(command);
    const result = await f.run([
      "youtube",
      `https://youtu.be/${FIRST_VIDEO}`,
      "--max-frames",
      "2",
    ]);
    expect(result.timedOut, result.stdout + result.stderr).toBe(false);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const dir = join(f.output, "first-video");
    for (const artifact of [
      "source/audio.wav",
      "source/video.mp4",
      "source/metadata.json",
      "transcription/transcript.json",
      "transcription/transcript.txt",
      "prompt/summary.prompt.md",
      "prompt/summary.schema.json",
      "frames/frames.json",
      "manifest.json",
      "stats.json",
    ])
      await access(join(dir, artifact));
    expect(await readJson(join(dir, "source/metadata.json"))).toMatchObject({
      contentId: FIRST_VIDEO,
      title: "First Video",
    });
    expect(
      await readFile(join(dir, "prompt/summary.prompt.md"), "utf8")
    ).toContain(`Transcript fixture audio ${FIRST_VIDEO}`);
    expect(
      await readJson(join(dir, "prompt/summary.schema.json"))
    ).toMatchObject({ title: "ScrubSummary" });
    expect(await readJson(join(dir, "frames/frames.json"))).toMatchObject([
      { timestamp: 5, path: "frames/frame_001.png" },
      { timestamp: 12, path: "frames/frame_002.png" },
    ]);
    expect(await readJson(join(f.output, "index.json"))).toMatchObject({
      media: { [FIRST_VIDEO]: { outputPath: "first-video" } },
    });
    expect(await readJson(join(dir, "stats.json"))).toMatchObject({
      totalTime: expect.any(Number),
      transcriptionTime: expect.any(Number),
    });

    // Reprocessing must remove stale generated assets while preserving harness output.
    await mkdir(join(dir, "inference"));
    await writeFile(join(dir, "inference/user.json"), "user-owned inference");
    const refreshed = await f.run([
      "youtube",
      FIRST_VIDEO,
      "--no-visuals",
      "--no-skip-existing",
    ]);
    expect(refreshed.exitCode, refreshed.stdout + refreshed.stderr).toBe(0);
    for (const stale of [
      "source/video.mp4",
      "frames/frame_001.png",
      "frames/frames.json",
    ]) {
      await expect(access(join(dir, stale))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(await readFile(join(dir, "inference/user.json"), "utf8")).toBe(
      "user-owned inference"
    );
    expect(await readJson(join(dir, "manifest.json"))).toMatchObject({
      artifacts: { source: { video: false }, frames: { count: 0 } },
    });
  });
  it("honors -o and --no-visuals and reuses completed work in a later CLI process", async () => {
    const f = await fixture();
    const output = join(f.root, "custom output");
    const args = ["youtube", FIRST_VIDEO, "-o", output, "--no-visuals"];
    const first = await f.run(args);
    expect(first.timedOut, first.stdout + first.stderr).toBe(false);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(
      await readJson(join(output, "first-video/manifest.json"))
    ).toMatchObject({
      artifacts: { source: { video: false }, frames: { count: 0 } },
    });
    const before = (await f.calls()).filter(
      (call) => call.tool === "whisper"
    ).length;
    const second = await f.run(args);
    expect(second.exitCode, second.stdout + second.stderr).toBe(0);
    expect(
      (await f.calls()).filter((call) => call.tool === "whisper")
    ).toHaveLength(before);
    expect(second.stdout).toMatch(/Skipped:\s*1/);
  });
});
