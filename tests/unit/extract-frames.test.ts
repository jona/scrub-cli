import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/utils/helpers.js", () => ({
  commandExists: vi.fn(),
  runCommand: vi.fn(),
}));

import { extractFrames } from "../../src/infrastructure/node/extract-frames.js";
import { commandExists } from "../../src/utils/helpers.js";

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
