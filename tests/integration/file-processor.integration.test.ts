import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MediaMetadata, SceneFrame } from "../../src/types/index.js";
import type { TranscriptionResult } from "../../src/transcription/ITranscriber.js";

const mockMetadata: MediaMetadata = {
  contentId: "file123",
  title: "recording",
  description: "",
  duration: 60,
  thumbnailUrl: "",
  source: "Local File",
  uploadDate: "2026-01-01",
  url: "/abs/recording.mp4",
};

const mockTranscript: TranscriptionResult = {
  segments: [{ start: 0, end: 10, text: "Hello from a local file." }],
  fullText: "Hello from a local file.",
  language: "en",
  duration: 60,
  source: "local-whisper",
};

const mockPromptResult = {
  prompt: "ASSEMBLED PROMPT",
  schema: { type: "object", title: "ScrubSummary" },
  metadata: mockMetadata,
};

vi.mock("../../src/core/prepare.js", () => ({
  prepare: vi.fn(),
  generateContentId: vi.fn(),
  getLocalFileType: vi.fn(),
}));

vi.mock("../../src/core/transcribe.js", () => ({
  transcribe: vi.fn(),
  getTranscriberDiagnostics: vi.fn(),
}));

vi.mock("../../src/core/download.js", () => ({
  isFfmpegAvailable: vi.fn(),
}));

vi.mock("../../src/core/extract-frames.js", () => ({
  extractFrames: vi.fn(),
}));

vi.mock("../../src/core/prompt.js", () => ({
  buildPromptArtifacts: vi.fn(),
}));

vi.mock("../../src/services/ArtifactStore.js", () => ({
  artifactStore: {
    ensureVideoDirectories: vi.fn(),
    getSourceDir: vi.fn(),
    getFramesDir: vi.fn(),
    getArtifactPath: vi.fn(),
    saveMetadata: vi.fn(),
    loadTranscription: vi.fn(),
    saveTranscription: vi.fn(),
    saveFramesManifest: vi.fn(),
    savePrompt: vi.fn(),
    finalizeArtifacts: vi.fn(),
  },
}));

vi.mock("../../src/infrastructure/Config.js", () => ({
  config: {
    getVisual: vi.fn(),
    getOutput: vi.fn(),
    getApiKey: vi.fn(),
  },
}));

import { processFile } from "../../src/orchestrators/file.js";
import {
  prepare,
  generateContentId,
  getLocalFileType,
} from "../../src/core/prepare.js";
import { transcribe } from "../../src/core/transcribe.js";
import { extractFrames } from "../../src/core/extract-frames.js";
import { buildPromptArtifacts } from "../../src/core/prompt.js";
import { artifactStore } from "../../src/services/ArtifactStore.js";
import { config } from "../../src/infrastructure/Config.js";

function resetMocks(): void {
  vi.clearAllMocks();

  vi.mocked(config.getVisual).mockReturnValue({
    enabled: true,
    sceneThreshold: 0.4,
    maxFrames: 20,
  });
  vi.mocked(config.getOutput).mockReturnValue({
    directory: "./output",
    includeFullTranscript: false,
  });

  vi.mocked(getLocalFileType).mockReturnValue("mp4");
  vi.mocked(generateContentId).mockReturnValue("file123");
  vi.mocked(prepare).mockResolvedValue({
    metadata: mockMetadata,
    audioPath: "/tmp/audio.wav",
    videoPath: "/tmp/video.mp4",
    cacheDir: "/tmp/cache",
  });

  vi.mocked(transcribe).mockResolvedValue(mockTranscript);
  vi.mocked(extractFrames).mockResolvedValue([]);
  vi.mocked(buildPromptArtifacts).mockReturnValue(mockPromptResult);

  vi.mocked(artifactStore.getSourceDir).mockReturnValue("/tmp/source");
  vi.mocked(artifactStore.getFramesDir).mockReturnValue("/tmp/frames");
  vi.mocked(artifactStore.getArtifactPath).mockImplementation(
    (contentId: string, type: string) => `/tmp/${contentId}/${type}`
  );
  vi.mocked(artifactStore.loadTranscription).mockReturnValue(null);
  vi.mocked(artifactStore.savePrompt).mockReturnValue(
    "/tmp/file123/summary.prompt.md"
  );
}

describe("File Orchestrator Integration", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("processes an .mp4 through prepare, transcribe, extract-frames, and prompt", async () => {
    const frames: SceneFrame[] = [
      { timestamp: 5, framePath: "/tmp/frames/frame_001.png" },
    ];
    vi.mocked(extractFrames).mockResolvedValueOnce(frames);

    const result = await processFile("/abs/recording.mp4", {});

    expect(result.metadata).toEqual(mockMetadata);
    expect(result.transcript).toEqual(mockTranscript);
    expect(result.frames).toEqual(frames);
    expect(result.promptPath).toBe("/tmp/file123/summary.prompt.md");
    expect(result.outputPath).toBe("/tmp/file123/summary.prompt.md");

    expect(prepare).toHaveBeenCalledWith(
      "/abs/recording.mp4",
      expect.objectContaining({ outputDir: "/tmp/source", skipVideo: false })
    );
    expect(transcribe).toHaveBeenCalled();
    expect(extractFrames).toHaveBeenCalledWith(
      "/tmp/video.mp4",
      expect.objectContaining({ outputDir: "/tmp/frames" })
    );
    expect(artifactStore.saveFramesManifest).toHaveBeenCalledWith(
      "file123",
      frames
    );
    expect(buildPromptArtifacts).toHaveBeenCalledWith(
      "/tmp/file123/transcription/json",
      expect.objectContaining({ metadataPath: "/tmp/file123/source/metadata" })
    );
    expect(artifactStore.savePrompt).toHaveBeenCalledWith(
      "file123",
      mockPromptResult.prompt,
      mockPromptResult.schema
    );
  });

  it("skips frame extraction for .mp3 (audio only)", async () => {
    vi.mocked(getLocalFileType).mockReturnValue("mp3");

    await processFile("/abs/podcast.mp3", {});

    expect(extractFrames).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(
      "/abs/podcast.mp3",
      expect.objectContaining({ skipVideo: true })
    );
    // prompt is still assembled for audio-only input
    expect(artifactStore.savePrompt).toHaveBeenCalled();
  });

  it("rejects unsupported file types", async () => {
    vi.mocked(getLocalFileType).mockReturnValue(null);

    await expect(processFile("/abs/notes.pdf", {})).rejects.toThrow(
      "Unsupported file type"
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("reuses a cached transcript when present and no override is given", async () => {
    vi.mocked(artifactStore.loadTranscription).mockReturnValueOnce(
      mockTranscript
    );

    await processFile("/abs/recording.mp4", {});

    expect(transcribe).not.toHaveBeenCalled();
    expect(artifactStore.saveTranscription).not.toHaveBeenCalled();
  });
});
