import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/utils/helpers.js", () => ({
  commandExists: vi.fn(),
  runCommand: vi.fn(),
}));

import {
  extractFrames,
  type ExtractFramesOptions,
} from "../../src/infrastructure/node/extract-frames.js";
import { commandExists, runCommand } from "../../src/utils/helpers.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(
  duration: number,
  timestamps: number[],
  options: Partial<Omit<ExtractFramesOptions, "outputDir" | "runtime">> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "scrub-frame-timeline-"));
  directories.push(directory);
  const input = join(directory, "video.mp4");
  await writeFile(input, "video");
  const execute = vi.fn<typeof runCommand>(async (command, args) => {
    if (command === "ffprobe")
      return { code: 0, stdout: String(duration), stderr: "" };
    if (args.includes("-filter:v"))
      return {
        code: 0,
        stdout: "",
        stderr: timestamps
          .map((timestamp) => `pts_time:${timestamp}\n`)
          .join(""),
      };
    await writeFile(args.at(-1)!, "PNG");
    return { code: 0, stdout: "", stderr: "" };
  });
  const frames = await extractFrames(input, {
    outputDir: join(directory, "frames"),
    runtime: { stagingRoot: directory, runCommand: execute },
    ...options,
  });
  return {
    frames,
    seeks: execute.mock.calls
      .filter(([, args]) => args.includes("-vframes"))
      .map(([, args]) => args[args.indexOf("-ss") + 1]),
  };
}

describe("extractFrames guard clauses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when ffmpeg is not installed", async () => {
    vi.mocked(commandExists).mockResolvedValue(false);

    await expect(
      extractFrames("/some/video.mp4", { outputDir: "/tmp/frames-x" })
    ).rejects.toThrow("ffmpeg is not installed");
  });

  it("rejects when the video file does not exist", async () => {
    vi.mocked(commandExists).mockResolvedValue(true);

    await expect(
      extractFrames("/definitely/not/here.mp4", { outputDir: "/tmp/frames-x" })
    ).rejects.toThrow("Video file not found");
  });
});

describe("source timeline frame sampling", () => {
  it("discards the fractional container tail without changing valid scene timestamps", async () => {
    const valid = [44.669625, 78.536792, 106.314542, 123.998875, 154.863042];
    const { frames, seeks } = await fixture(167.299773, [...valid, 167.167], {
      sourceDurationSeconds: 167,
      maxFrames: 20,
    });
    expect(frames.map((frame) => frame.timestamp)).toEqual(valid);
    expect(seeks).toEqual(valid.map((timestamp) => timestamp.toFixed(3)));
    expect(seeks).not.toContain("167.167");
  });

  it("removes out-of-timeline scenes before deciding whether periodic sampling is needed", async () => {
    const { frames } = await fixture(167.299773, [110, 120, 130], {
      sourceDurationSeconds: 100,
      maxFrames: 4,
    });
    expect(frames.map((frame) => frame.timestamp)).toEqual([50]);
  });

  it("places a required representative frame inside a short declared timeline", async () => {
    const { frames, seeks } = await fixture(0.9, [0.6, 0.8], {
      sourceDurationSeconds: 0.5,
      ensureFrame: true,
    });
    expect(frames.map((frame) => frame.timestamp)).toEqual([0.25]);
    expect(seeks).toEqual(["0.250"]);
  });

  it("also respects the shorter probed timeline", async () => {
    const { frames } = await fixture(20, [2, 8, 25], {
      sourceDurationSeconds: 30,
    });
    expect(frames.map((frame) => frame.timestamp)).toEqual([2, 8]);
  });

  it.each([undefined, 0])(
    "uses the probe when the source duration is unknown: %s",
    async (sourceDurationSeconds) => {
      const { frames } = await fixture(20.5, [2, 8, 20.25], {
        sourceDurationSeconds,
      });
      expect(frames.map((frame) => frame.timestamp)).toEqual([2, 8, 20.25]);
    }
  );

  it("checks the actual media duration against resource limits before applying the source bound", async () => {
    await expect(
      fixture(167.299773, [], {
        sourceDurationSeconds: 167,
        maxDurationSeconds: 167,
      })
    ).rejects.toMatchObject({ code: "resource_limit" });
  });

  it.each([-1, NaN, Infinity])(
    "rejects invalid declared source durations: %s",
    async (sourceDurationSeconds) => {
      await expect(
        fixture(20, [], { sourceDurationSeconds })
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  );
});
