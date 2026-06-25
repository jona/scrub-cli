import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MediaMetadata, SceneFrame } from "../../src/types/index.js";
import type { TranscriptionResult } from "../../src/transcription/ITranscriber.js";

const MOCK_VIDEO_ID = "56kq0VTkU4k";
const MOCK_URL = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

const mockMetadata: MediaMetadata = {
  contentId: MOCK_VIDEO_ID,
  title: "Test Video: Introduction to TypeScript",
  description: "A comprehensive introduction to TypeScript.",
  duration: 600,
  thumbnailUrl: `https://i.ytimg.com/vi/${MOCK_VIDEO_ID}/maxresdefault.jpg`,
  source: "Test Channel",
  uploadDate: "2024-01-15",
  url: MOCK_URL,
};

const mockTranscript: TranscriptionResult = {
  segments: [
    {
      start: 0,
      end: 10,
      text: "Welcome to this TypeScript tutorial.",
      confidence: 0.95,
    },
    {
      start: 10,
      end: 25,
      text: "TypeScript is a superset of JavaScript.",
      confidence: 0.92,
    },
  ],
  fullText:
    "Welcome to this TypeScript tutorial. TypeScript is a superset of JavaScript.",
  language: "en",
  duration: 600,
  source: "youtube-captions",
};

const mockPromptResult = {
  prompt: "## METADATA\n- Title: Test Video: Introduction to TypeScript\n...",
  schema: { type: "object", title: "ScrubSummary" },
  metadata: mockMetadata,
};

vi.mock("../../src/core/download.js", () => ({
  fetchYouTubeMetadata: vi.fn(),
  download: vi.fn(),
  isYtDlpAvailable: vi.fn(),
  isFfmpegAvailable: vi.fn(),
}));

vi.mock("../../src/core/transcribe.js", () => ({
  transcribe: vi.fn(),
  getTranscriberDiagnostics: vi.fn(),
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
    hasVideo: vi.fn(),
  },
}));

vi.mock("../../src/services/PlaylistExtractor.js", () => ({
  playlistExtractor: {
    extract: vi.fn(),
  },
}));

vi.mock("../../src/infrastructure/Config.js", () => ({
  config: {
    getApiKey: vi.fn(),
    getVisual: vi.fn(),
    getOutput: vi.fn(),
  },
}));

import {
  processYouTube,
  checkYouTubePrerequisites,
  getDiagnostics,
} from "../../src/orchestrators/youtube.js";
import {
  download,
  fetchYouTubeMetadata,
  isFfmpegAvailable,
  isYtDlpAvailable,
} from "../../src/core/download.js";
import {
  getTranscriberDiagnostics,
  transcribe,
} from "../../src/core/transcribe.js";
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

  vi.mocked(fetchYouTubeMetadata).mockResolvedValue(mockMetadata);
  vi.mocked(download).mockResolvedValue({
    metadata: mockMetadata,
    audioPath: "/tmp/test-audio.wav",
    videoPath: "/tmp/test-video.mp4",
    cacheDir: "/tmp/test-cache",
  });
  vi.mocked(isYtDlpAvailable).mockResolvedValue(true);
  vi.mocked(isFfmpegAvailable).mockResolvedValue(true);

  vi.mocked(transcribe).mockResolvedValue(mockTranscript);
  vi.mocked(getTranscriberDiagnostics).mockResolvedValue([
    {
      source: "youtube-captions",
      name: "YouTube Captions",
      available: true,
      requiresApiKey: false,
    },
  ]);

  vi.mocked(extractFrames).mockResolvedValue([]);
  vi.mocked(buildPromptArtifacts).mockReturnValue(mockPromptResult);

  vi.mocked(artifactStore.getSourceDir).mockReturnValue("/tmp/source");
  vi.mocked(artifactStore.getFramesDir).mockReturnValue("/tmp/frames");
  vi.mocked(artifactStore.getArtifactPath).mockImplementation(
    (contentId: string, type: string) => `/tmp/${contentId}/${type}.json`
  );
  vi.mocked(artifactStore.loadTranscription).mockReturnValue(null);
  vi.mocked(artifactStore.savePrompt).mockReturnValue(
    "/tmp/output/summary.prompt.md"
  );
  vi.mocked(artifactStore.hasVideo).mockReturnValue(false);
}

describe("YouTube Orchestrator Integration", () => {
  beforeEach(() => {
    resetMocks();
  });

  describe("processYouTube()", () => {
    it("processes a video through the download, transcribe, and prompt pipeline", async () => {
      const result = await processYouTube(MOCK_URL, { skipVisuals: true });

      expect(result.metadata).toEqual(mockMetadata);
      expect(result.transcript).toEqual(mockTranscript);
      expect(result.frames).toEqual([]);
      expect(result.promptPath).toBe("/tmp/output/summary.prompt.md");
      expect(result.outputPath).toBe("/tmp/output/summary.prompt.md");
      expect(result.stats.totalTime).toBeGreaterThanOrEqual(0);

      expect(fetchYouTubeMetadata).toHaveBeenCalledWith(MOCK_URL);
      expect(download).toHaveBeenCalledWith(
        MOCK_URL,
        expect.objectContaining({
          outputDir: "/tmp/source",
          skipVideo: true,
          metadata: mockMetadata,
        })
      );
      expect(transcribe).toHaveBeenCalledWith(
        "/tmp/test-audio.wav",
        expect.objectContaining({ youtubeUrl: MOCK_URL })
      );
      expect(buildPromptArtifacts).toHaveBeenCalledWith(
        `/tmp/${MOCK_VIDEO_ID}/transcription/json.json`,
        expect.objectContaining({
          metadataPath: `/tmp/${MOCK_VIDEO_ID}/source/metadata.json`,
        })
      );
      expect(artifactStore.saveMetadata).toHaveBeenCalledWith(
        MOCK_VIDEO_ID,
        mockMetadata
      );
      expect(artifactStore.saveTranscription).toHaveBeenCalledWith(
        MOCK_VIDEO_ID,
        mockTranscript
      );
      expect(artifactStore.savePrompt).toHaveBeenCalledWith(
        MOCK_VIDEO_ID,
        mockPromptResult.prompt,
        mockPromptResult.schema
      );
      expect(artifactStore.finalizeArtifacts).toHaveBeenCalledWith(
        MOCK_VIDEO_ID,
        mockMetadata,
        "youtube-captions",
        expect.objectContaining({ totalTime: expect.any(Number) }),
        undefined
      );
    });

    it("uses cached transcription when no transcriber override is provided", async () => {
      vi.mocked(artifactStore.loadTranscription).mockReturnValueOnce(
        mockTranscript
      );

      await processYouTube(MOCK_URL, { skipVisuals: true });

      expect(artifactStore.loadTranscription).toHaveBeenCalledWith(
        MOCK_VIDEO_ID
      );
      expect(transcribe).not.toHaveBeenCalled();
      expect(artifactStore.saveTranscription).not.toHaveBeenCalled();
    });

    it("extracts key frames when enabled and a video is downloaded", async () => {
      const frames: SceneFrame[] = [
        { timestamp: 12, framePath: "/tmp/frames/frame_001.png" },
      ];
      vi.mocked(extractFrames).mockResolvedValueOnce(frames);

      const result = await processYouTube(MOCK_URL);

      expect(result.frames).toEqual(frames);
      expect(download).toHaveBeenCalledWith(
        MOCK_URL,
        expect.objectContaining({ skipVideo: false })
      );
      expect(extractFrames).toHaveBeenCalledWith(
        "/tmp/test-video.mp4",
        expect.objectContaining({
          outputDir: "/tmp/frames",
          threshold: undefined,
          maxFrames: undefined,
        })
      );
      expect(artifactStore.saveFramesManifest).toHaveBeenCalledWith(
        MOCK_VIDEO_ID,
        frames
      );
    });

    it("emits progress for the major pipeline stages", async () => {
      const stages: string[] = [];

      await processYouTube(MOCK_URL, {
        skipVisuals: true,
        onProgress: (progress) => stages.push(progress.stage),
      });

      expect(stages).toEqual(
        expect.arrayContaining(["download", "transcribe", "prompt"])
      );
    });

    it("rejects invalid YouTube URLs before running the pipeline", async () => {
      await expect(processYouTube("https://example.com/video")).rejects.toThrow(
        "Invalid YouTube URL"
      );

      expect(fetchYouTubeMetadata).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    });

    it("adds video context when a pipeline step fails", async () => {
      vi.mocked(download).mockRejectedValueOnce(new Error("Network error"));

      await expect(processYouTube(MOCK_URL)).rejects.toThrow(
        `Failed to process video ${MOCK_VIDEO_ID}: Network error`
      );
    });
  });

  describe("checkYouTubePrerequisites()", () => {
    it("reports ready when required tools are available", async () => {
      const result = await checkYouTubePrerequisites();

      expect(result).toEqual({ ready: true, missing: [], warnings: [] });
    });

    it("reports missing required dependencies", async () => {
      vi.mocked(isYtDlpAvailable).mockResolvedValueOnce(false);
      vi.mocked(isFfmpegAvailable).mockResolvedValueOnce(false);

      const result = await checkYouTubePrerequisites();

      expect(result.ready).toBe(false);
      expect(result.missing).toEqual([
        "yt-dlp (required for YouTube video download)",
        "ffmpeg (required for audio/video processing)",
      ]);
    });

    it("warns when no transcription adapters are available", async () => {
      vi.mocked(getTranscriberDiagnostics).mockResolvedValueOnce([]);

      const result = await checkYouTubePrerequisites();

      expect(result.ready).toBe(true);
      expect(result.warnings).toEqual(["No transcription adapters available."]);
    });
  });

  describe("getDiagnostics()", () => {
    it("returns external tool and transcriber diagnostics", async () => {
      const diagnostics = await getDiagnostics();

      expect(diagnostics).toEqual({
        ytdlp: true,
        ffmpeg: true,
        transcribers: [
          {
            source: "youtube-captions",
            name: "YouTube Captions",
            available: true,
          },
        ],
      });
    });
  });
});
