import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  MediaMetadata,
  PlaylistEntry,
  PlaylistMetadata,
  PlaylistVideoStatusType,
} from "../../src/types/index.js";
import type { TranscriptionResult } from "../../src/transcription/ITranscriber.js";

const FIRST_VIDEO_ID = "56kq0VTkU4k";
const SECOND_VIDEO_ID = "abc123xyz45";
const PLAYLIST_ID = "PLf2m23nhTg1MjwozACw3ufAc3CUpfOBWO";

const playlistUrl = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
const firstVideoUrl = `https://www.youtube.com/watch?v=${FIRST_VIDEO_ID}`;
const secondVideoUrl = `https://www.youtube.com/watch?v=${SECOND_VIDEO_ID}`;

const playlistMetadata: PlaylistMetadata = {
  playlistId: PLAYLIST_ID,
  title: "TypeScript Tutorial Series",
  description: "Complete TypeScript tutorial.",
  channelName: "Test Channel",
  videoCount: 2,
  url: playlistUrl,
};

const playlistEntries: PlaylistEntry[] = [
  {
    contentId: FIRST_VIDEO_ID,
    title: "TypeScript Introduction",
    duration: 600,
    position: 1,
    url: firstVideoUrl,
  },
  {
    contentId: SECOND_VIDEO_ID,
    title: "TypeScript Types",
    duration: 720,
    position: 2,
    url: secondVideoUrl,
  },
];

const transcript: TranscriptionResult = {
  segments: [{ start: 0, end: 10, text: "Welcome to TypeScript." }],
  fullText: "Welcome to TypeScript.",
  language: "en",
  duration: 600,
  source: "youtube-captions",
};

vi.mock("../../src/services/PlaylistExtractor.js", () => ({
  playlistExtractor: {
    extract: vi.fn(),
  },
}));

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

vi.mock("../../src/infrastructure/Config.js", () => ({
  config: {
    getApiKey: vi.fn(),
    getVisual: vi.fn(),
    getOutput: vi.fn(),
  },
}));

import { processYouTubePlaylist } from "../../src/orchestrators/youtube.js";
import { playlistExtractor } from "../../src/services/PlaylistExtractor.js";
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
import { buildPromptArtifacts } from "../../src/core/prompt.js";
import { artifactStore } from "../../src/services/ArtifactStore.js";
import { config } from "../../src/infrastructure/Config.js";

function metadataFor(contentId: string, url: string): MediaMetadata {
  return {
    contentId,
    title:
      contentId === FIRST_VIDEO_ID
        ? "TypeScript Introduction"
        : "TypeScript Types",
    description: "",
    duration: contentId === FIRST_VIDEO_ID ? 600 : 720,
    thumbnailUrl: "",
    source: "Test Channel",
    uploadDate: "2024-01-15",
    url,
  };
}

function resetMocks(): void {
  vi.clearAllMocks();

  vi.mocked(config.getVisual).mockReturnValue({
    enabled: false,
    sceneThreshold: 0.4,
    maxFrames: 20,
  });
  vi.mocked(config.getOutput).mockReturnValue({
    directory: "./output",
    includeFullTranscript: false,
  });

  vi.mocked(playlistExtractor.extract).mockImplementation(
    async (_url: string, options?: { maxVideos?: number }) => ({
      metadata: playlistMetadata,
      entries:
        options?.maxVideos && options.maxVideos > 0
          ? playlistEntries.slice(0, options.maxVideos)
          : playlistEntries,
    })
  );

  vi.mocked(fetchYouTubeMetadata).mockImplementation(async (url: string) => {
    const contentId = url.includes(SECOND_VIDEO_ID)
      ? SECOND_VIDEO_ID
      : FIRST_VIDEO_ID;
    return metadataFor(contentId, url);
  });
  vi.mocked(download).mockImplementation(async (url: string) => {
    const contentId = url.includes(SECOND_VIDEO_ID)
      ? SECOND_VIDEO_ID
      : FIRST_VIDEO_ID;
    return {
      metadata: metadataFor(contentId, url),
      audioPath: `/tmp/${contentId}.wav`,
      videoPath: `/tmp/${contentId}.mp4`,
      cacheDir: `/tmp/${contentId}`,
    };
  });
  vi.mocked(isYtDlpAvailable).mockResolvedValue(true);
  vi.mocked(isFfmpegAvailable).mockResolvedValue(true);

  vi.mocked(transcribe).mockResolvedValue(transcript);
  vi.mocked(getTranscriberDiagnostics).mockResolvedValue([]);
  vi.mocked(buildPromptArtifacts).mockImplementation(
    (_filePath: string) => ({
      prompt: "PROMPT",
      schema: { type: "object" } as never,
      metadata: metadataFor(FIRST_VIDEO_ID, firstVideoUrl),
    })
  );

  vi.mocked(artifactStore.getSourceDir).mockImplementation(
    (contentId: string) => `/tmp/source/${contentId}`
  );
  vi.mocked(artifactStore.getFramesDir).mockImplementation(
    (contentId: string) => `/tmp/frames/${contentId}`
  );
  vi.mocked(artifactStore.getArtifactPath).mockImplementation(
    (contentId: string, type: string) => `/tmp/output/${contentId}/${type}`
  );
  vi.mocked(artifactStore.loadTranscription).mockReturnValue(null);
  vi.mocked(artifactStore.savePrompt).mockImplementation(
    (contentId: string) => `/tmp/output/${contentId}/summary.prompt.md`
  );
  vi.mocked(artifactStore.hasVideo).mockReturnValue(false);
}

describe("Playlist Orchestrator Integration", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("processes a playlist and returns statuses plus aggregate stats", async () => {
    const result = await processYouTubePlaylist(playlistUrl, {
      skipVisuals: true,
      maxVideos: 2,
      continueOnError: true,
    });

    expect(playlistExtractor.extract).toHaveBeenCalledWith(playlistUrl, {
      maxVideos: 2,
    });
    expect(result.playlist).toEqual(playlistMetadata);
    expect(result.videos).toHaveLength(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.stats.totalTime).toBeGreaterThanOrEqual(0);
    expect(result.stats.averageTimePerVideo).toBeGreaterThanOrEqual(0);
    expect(result.videos.map((video) => video.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("supports single-video URLs through the playlist pipeline", async () => {
    vi.mocked(playlistExtractor.extract).mockResolvedValueOnce({
      metadata: {
        ...playlistMetadata,
        playlistId: FIRST_VIDEO_ID,
        title: "TypeScript Introduction",
        videoCount: 1,
        url: firstVideoUrl,
      },
      entries: [playlistEntries[0]],
    });

    const result = await processYouTubePlaylist(firstVideoUrl, {
      skipVisuals: true,
    });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toEqual(
      expect.objectContaining({
        contentId: FIRST_VIDEO_ID,
        title: "TypeScript Introduction",
        status: "completed",
        outputPath: `/tmp/output/${FIRST_VIDEO_ID}/summary.prompt.md`,
      })
    );
  });

  it("emits start and progress callbacks with pending and terminal states", async () => {
    const startedStatuses: PlaylistVideoStatusType[] = [];
    const progressStatuses: PlaylistVideoStatusType[] = [];

    await processYouTubePlaylist(playlistUrl, {
      skipVisuals: true,
      maxVideos: 1,
      onStart: (videos) => {
        startedStatuses.push(...videos.map((video) => video.status));
      },
      onProgress: (_contentId, status) => {
        progressStatuses.push(status);
      },
    });

    expect(startedStatuses).toEqual(["pending"]);
    expect(progressStatuses).toEqual(
      expect.arrayContaining(["processing", "completed"])
    );
  });

  it("skips videos that already exist when skipExisting is true", async () => {
    vi.mocked(artifactStore.hasVideo).mockImplementation(
      (contentId: string) => contentId === FIRST_VIDEO_ID
    );

    const result = await processYouTubePlaylist(playlistUrl, {
      skipVisuals: true,
      maxVideos: 1,
      skipExisting: true,
    });

    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.videos[0]).toEqual(
      expect.objectContaining({
        contentId: FIRST_VIDEO_ID,
        status: "skipped",
        outputPath: `/tmp/output/${FIRST_VIDEO_ID}/prompt/summary`,
      })
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("continues processing later videos when continueOnError is true", async () => {
    vi.mocked(download).mockRejectedValueOnce(new Error("First video failed"));

    const result = await processYouTubePlaylist(playlistUrl, {
      skipVisuals: true,
      maxVideos: 2,
      continueOnError: true,
    });

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.videos.map((video) => video.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(result.videos[0].error).toContain("First video failed");
  });

  it("aborts playlist processing when continueOnError is false", async () => {
    vi.mocked(download).mockRejectedValueOnce(new Error("Processing failed"));

    await expect(
      processYouTubePlaylist(playlistUrl, {
        skipVisuals: true,
        continueOnError: false,
      })
    ).rejects.toThrow("Playlist processing aborted");
  });

  it("passes source playlist metadata into each finalized video artifact", async () => {
    await processYouTubePlaylist(playlistUrl, {
      skipVisuals: true,
      maxVideos: 1,
    });

    expect(artifactStore.finalizeArtifacts).toHaveBeenCalledWith(
      FIRST_VIDEO_ID,
      expect.any(Object),
      "youtube-captions",
      expect.objectContaining({ totalTime: expect.any(Number) }),
      {
        playlistId: PLAYLIST_ID,
        title: "TypeScript Tutorial Series",
        position: 1,
      }
    );
  });

  it("processes batches successfully when concurrency is greater than one", async () => {
    const result = await processYouTubePlaylist(playlistUrl, {
      skipVisuals: true,
      maxVideos: 2,
      concurrency: 2,
    });

    expect(result.videos).toHaveLength(2);
    expect(result.succeeded + result.failed + result.skipped).toBe(2);
    expect(download).toHaveBeenCalledTimes(2);
  });
});
