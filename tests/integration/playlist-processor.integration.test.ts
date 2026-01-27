import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  PlaylistVideoStatus,
  PlaylistVideoStatusType,
} from "../../src/types/index.js";

// Mock data constants
const MOCK_VIDEO_ID = "56kq0VTkU4k";
const MOCK_PLAYLIST_ID = "PLf2m23nhTg1MjwozACw3ufAc3CUpfOBWO";

// Track processed videos for skipExisting tests (module-level state)
const processedVideos = new Set<string>();

// Setup mocks with inline factory functions (vi.mock is hoisted)
vi.mock("../../src/services/PlaylistExtractor.js", () => {
  const mockPlaylistMetadata = {
    playlistId: "PLf2m23nhTg1MjwozACw3ufAc3CUpfOBWO",
    title: "TypeScript Tutorial Series",
    description: "Complete TypeScript tutorial.",
    channelName: "Test Channel",
    videoCount: 2,
    url: "https://www.youtube.com/playlist?list=PLf2m23nhTg1MjwozACw3ufAc3CUpfOBWO",
  };

  const mockPlaylistEntries = [
    {
      videoId: "56kq0VTkU4k",
      title: "TypeScript Introduction",
      duration: 600,
      position: 1,
      url: "https://www.youtube.com/watch?v=56kq0VTkU4k",
    },
    {
      videoId: "abc123xyz",
      title: "TypeScript Types",
      duration: 720,
      position: 2,
      url: "https://www.youtube.com/watch?v=abc123xyz",
    },
  ];

  return {
    playlistExtractor: {
      isPlaylistUrl: vi.fn((url: string) => url.includes("list=")),
      extractPlaylistId: vi.fn((url: string) => {
        const match = url.match(/[?&]list=([^&]+)/);
        return match ? match[1] : null;
      }),
      extract: vi
        .fn()
        .mockImplementation((url: string, options?: { maxVideos?: number }) => {
          const isPlaylist = url.includes("list=");
          if (isPlaylist) {
            let entries = [...mockPlaylistEntries];
            if (options?.maxVideos && options.maxVideos > 0) {
              entries = entries.slice(0, options.maxVideos);
            }
            return Promise.resolve({ metadata: mockPlaylistMetadata, entries });
          }
          // Single video - return as pseudo-playlist
          return Promise.resolve({
            metadata: {
              ...mockPlaylistMetadata,
              playlistId: "56kq0VTkU4k",
              title: "Test Video: Introduction to TypeScript",
              videoCount: 1,
            },
            entries: [mockPlaylistEntries[0]],
          });
        }),
    },
  };
});

vi.mock("../../src/services/VideoDownloader.js", () => ({
  videoDownloader: {
    isAvailable: vi.fn().mockResolvedValue(true),
    hasFfmpeg: vi.fn().mockResolvedValue(true),
    download: vi.fn().mockResolvedValue({
      metadata: {
        videoId: "56kq0VTkU4k",
        title: "Test Video: Introduction to TypeScript",
        description: "A comprehensive introduction to TypeScript.",
        duration: 600,
        thumbnailUrl: "https://i.ytimg.com/vi/56kq0VTkU4k/maxresdefault.jpg",
        channelName: "Test Channel",
        uploadDate: "2024-01-15",
        url: "https://www.youtube.com/watch?v=56kq0VTkU4k",
      },
      audioPath: "/tmp/audio.wav",
      videoPath: "/tmp/video.mp4",
      cacheDir: "/tmp/cache",
    }),
  },
}));

vi.mock("../../src/transcription/index.js", () => ({
  transcriberFactory: {
    setVideoUrl: vi.fn(),
    transcribe: vi.fn().mockResolvedValue({
      segments: [
        { start: 0, end: 10, text: "Welcome to TypeScript.", confidence: 0.95 },
      ],
      fullText: "Welcome to TypeScript.",
      language: "en",
      duration: 600,
      source: "youtube-captions",
    }),
    getDiagnostics: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../src/services/Summarizer.js", () => ({
  summarizer: {
    isAvailable: vi.fn().mockReturnValue(true),
    summarize: vi.fn().mockResolvedValue({
      title: "Test Video",
      tldr: "TypeScript overview.",
      overview: "Introduction to TypeScript.",
      thesisAndClaims: { thesis: "", keyClaims: [], persuasionGoal: undefined },
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
    }),
  },
}));

vi.mock("../../src/services/SkillGenerator.js", () => ({
  skillGenerator: {
    isAvailable: vi.fn().mockReturnValue(true),
    generate: vi.fn().mockResolvedValue({
      skillMd: "# Skill",
      checklist: {},
      suggestedName: "skill",
    }),
  },
}));

vi.mock("../../src/services/SceneDetector.js", () => ({
  sceneDetector: {
    detectScenes: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../src/services/VisualAnalyzer.js", () => ({
  visualAnalyzer: {
    isAvailable: vi.fn().mockReturnValue(false),
    analyzeFrames: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../src/services/MarkdownGenerator.js", () => ({
  markdownGenerator: {
    generate: vi.fn().mockReturnValue("# Test"),
  },
}));

// Create a module-level reference for processedVideos that the mock can access
vi.mock("../../src/services/ArtifactStore.js", () => {
  // We need to track processed videos across tests
  const processedSet = new Set<string>();

  return {
    artifactStore: {
      loadTranscription: vi.fn().mockReturnValue(null),
      saveTranscription: vi.fn(),
      saveSummary: vi.fn(),
      saveVisualAnalysis: vi.fn(),
      saveMarkdown: vi.fn().mockImplementation((videoId: string) => {
        processedSet.add(videoId);
        return `/tmp/output/${videoId}/summary.md`;
      }),
      saveSkill: vi.fn().mockReturnValue("/tmp/output/SKILL.md"),
      saveSkillChecklist: vi.fn(),
      finalizeArtifacts: vi.fn().mockImplementation((videoId: string) => {
        processedSet.add(videoId);
      }),
      hasVideo: vi
        .fn()
        .mockImplementation((videoId: string) => processedSet.has(videoId)),
      getArtifactPath: vi
        .fn()
        .mockImplementation(
          (videoId: string, type: string) => `/tmp/output/${videoId}/${type}`
        ),
      // Expose methods to control the set in tests
      _markProcessed: (videoId: string) => processedSet.add(videoId),
      _clearProcessed: () => processedSet.clear(),
    },
  };
});

vi.mock("../../src/infrastructure/Config.js", () => ({
  config: {
    getApiKey: vi.fn().mockReturnValue("mock-api-key"),
    hasAnthropicKey: vi.fn().mockReturnValue(true),
    getVisual: vi
      .fn()
      .mockReturnValue({ enabled: false, sceneThreshold: 0.3, maxFrames: 10 }),
    getOutput: vi.fn().mockReturnValue({ includeFullTranscript: false }),
  },
}));

// Import after mocks
import { PlaylistProcessor } from "../../src/core/PlaylistProcessor.js";
import { videoProcessor } from "../../src/core/VideoProcessor.js";
import { playlistExtractor } from "../../src/services/PlaylistExtractor.js";
import { artifactStore } from "../../src/services/ArtifactStore.js";

describe("PlaylistProcessor Integration", () => {
  let processor: PlaylistProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear processed videos set
    (artifactStore as any)._clearProcessed?.();
    processor = new PlaylistProcessor();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("processPlaylist() with single video", () => {
    it("should process a single video URL through PlaylistProcessor", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 1,
      });

      // Should return playlist-style result even for single video
      expect(result).toBeDefined();
      expect(result.playlist).toBeDefined();
      expect(result.videos).toBeDefined();
      expect(result.videos.length).toBe(1);

      // Stats
      expect(result.succeeded + result.failed + result.skipped).toBe(
        result.videos.length
      );
      expect(result.stats.totalTime).toBeGreaterThanOrEqual(0);

      // Verify extractor was called
      expect(playlistExtractor.extract).toHaveBeenCalledWith(url, {
        maxVideos: 1,
      });
    });

    it("should mark video as completed after successful processing", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
      });

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.videos[0].status).toBe("completed");
      expect(result.videos[0].outputPath).toBeTruthy();
    });
  });

  describe("processPlaylist() with playlist URL", () => {
    it("should extract and process videos from a playlist", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 2,
        continueOnError: true,
      });

      // Verify playlist metadata
      expect(result.playlist).toBeDefined();
      expect(result.playlist.playlistId).toBe(MOCK_PLAYLIST_ID);
      expect(result.playlist.title).toBe("TypeScript Tutorial Series");

      // Verify video statuses
      expect(result.videos.length).toBeLessThanOrEqual(2);
      result.videos.forEach((video) => {
        expect(video.videoId).toBeTruthy();
        expect(video.title).toBeTruthy();
        expect([
          "pending",
          "processing",
          "completed",
          "failed",
          "skipped",
        ]).toContain(video.status);
      });

      // Verify stats
      expect(result.stats.totalTime).toBeGreaterThanOrEqual(0);
    });

    it("should call onStart callback with video list", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;
      let startVideosStatuses: PlaylistVideoStatusType[] = [];
      let startTotal = 0;

      await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 2,
        onStart: (videos, total) => {
          // Capture the status values at the time onStart is called
          // (videos array objects will be mutated during processing)
          startVideosStatuses = videos.map((v) => v.status);
          startTotal = total;
        },
      });

      // onStart should have been called
      expect(startVideosStatuses.length).toBeGreaterThan(0);
      expect(startTotal).toBeGreaterThan(0);

      // All videos should start as pending at the time onStart is called
      startVideosStatuses.forEach((status) => {
        expect(status).toBe("pending");
      });
    });

    it("should call onProgress callback for each video status change", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;
      const progressUpdates: Array<{
        videoId: string;
        status: PlaylistVideoStatusType;
        stage?: string;
      }> = [];

      await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 1,
        onProgress: (videoId, status, stage) => {
          progressUpdates.push({ videoId, status, stage });
        },
      });

      // Should have received progress updates
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Should see status transitions
      const statuses = progressUpdates.map((p) => p.status);
      expect(
        statuses.some((s) => ["processing", "completed", "skipped"].includes(s))
      ).toBe(true);
    });
  });

  describe("processPlaylist() options", () => {
    it("should respect maxVideos option", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 1,
      });

      expect(result.videos.length).toBe(1);
    });

    it("should skip existing videos when skipExisting is true", async () => {
      // Mark the first video as already processed
      (artifactStore as any)._markProcessed?.(MOCK_VIDEO_ID);

      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        skipExisting: true,
      });

      // Video should be skipped
      expect(result.skipped).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.videos[0].status).toBe("skipped");
    });

    it("should not skip existing videos when skipExisting is false", async () => {
      // Mark video as processed
      (artifactStore as any)._markProcessed?.(MOCK_VIDEO_ID);

      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        skipExisting: false,
      });

      // Should process anyway
      expect(result.skipped).toBe(0);
      expect(result.succeeded).toBe(1);
    });

    it("should continue on error when continueOnError is true", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;

      // Make VideoProcessor fail on first call only
      let callCount = 0;
      vi.spyOn(videoProcessor, "process").mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("First video failed");
        }
        return {
          metadata: {
            videoId: "abc123xyz",
            title: "TypeScript Types",
            description: "",
            duration: 720,
            thumbnailUrl: "",
            channelName: "Test",
            uploadDate: "2024-01-15",
            url: "https://www.youtube.com/watch?v=abc123xyz",
          },
          transcript: {
            segments: [],
            fullText: "",
            language: "en",
            duration: 720,
            source: "youtube-captions" as const,
          },
          visuals: [],
          summary: {} as any,
          markdown: "# Test",
          outputPath: "/tmp/output.md",
          stats: {
            downloadTime: 100,
            transcriptionTime: 100,
            visualAnalysisTime: 0,
            summarizationTime: 100,
            totalTime: 300,
          },
        };
      });

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 2,
        continueOnError: true,
      });

      // Should have processed both videos
      expect(result.videos.length).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(1);
    });

    it("should stop on first error when continueOnError is false", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;

      // Make VideoProcessor fail
      vi.spyOn(videoProcessor, "process").mockRejectedValue(
        new Error("Processing failed")
      );

      await expect(
        processor.processPlaylist(url, {
          skipVisuals: true,
          continueOnError: false,
        })
      ).rejects.toThrow("Playlist processing aborted");
    });
  });

  describe("processPlaylist() with concurrency", () => {
    it("should process videos sequentially when concurrency is 1", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;
      const processingOrder: string[] = [];

      await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 2,
        concurrency: 1,
        onProgress: (videoId, status) => {
          if (status === "processing") {
            processingOrder.push(videoId);
          }
        },
      });

      // With sequential processing, videos should be processed
      expect(processingOrder.length).toBeGreaterThanOrEqual(1);
    });

    it("should process videos in parallel when concurrency > 1", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 2,
        concurrency: 2,
      });

      // Parallel processing should still complete successfully
      expect(result.videos.length).toBeLessThanOrEqual(2);
      expect(result.succeeded + result.failed + result.skipped).toBe(
        result.videos.length
      );
    });
  });

  describe("processPlaylist() result structure", () => {
    it("should return correct result structure", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
      });

      // Verify top-level structure
      expect(result).toHaveProperty("playlist");
      expect(result).toHaveProperty("videos");
      expect(result).toHaveProperty("succeeded");
      expect(result).toHaveProperty("failed");
      expect(result).toHaveProperty("skipped");
      expect(result).toHaveProperty("stats");

      // Verify playlist metadata structure
      expect(result.playlist).toHaveProperty("playlistId");
      expect(result.playlist).toHaveProperty("title");
      expect(result.playlist).toHaveProperty("description");
      expect(result.playlist).toHaveProperty("channelName");
      expect(result.playlist).toHaveProperty("videoCount");
      expect(result.playlist).toHaveProperty("url");

      // Verify video status structure
      if (result.videos.length > 0) {
        const video = result.videos[0];
        expect(video).toHaveProperty("videoId");
        expect(video).toHaveProperty("title");
        expect(video).toHaveProperty("status");
      }

      // Verify stats structure
      expect(result.stats).toHaveProperty("totalTime");
      expect(result.stats).toHaveProperty("averageTimePerVideo");
    });

    it("should calculate stats correctly", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
      });

      // Total time should be positive
      expect(result.stats.totalTime).toBeGreaterThanOrEqual(0);

      // Average time per video should be calculated correctly
      if (result.succeeded > 0) {
        expect(result.stats.averageTimePerVideo).toBeGreaterThanOrEqual(0);
        expect(result.stats.averageTimePerVideo).toBeLessThanOrEqual(
          result.stats.totalTime
        );
      } else {
        expect(result.stats.averageTimePerVideo).toBe(0);
      }

      // Counts should add up
      expect(result.succeeded + result.failed + result.skipped).toBe(
        result.videos.length
      );
    });

    it("should include error messages for failed videos", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      // Mock VideoProcessor to fail
      vi.spyOn(videoProcessor, "process").mockRejectedValue(
        new Error("Test error message")
      );

      const result = await processor.processPlaylist(url, {
        skipVisuals: true,
        continueOnError: true,
      });

      expect(result.failed).toBe(1);
      expect(result.videos[0].status).toBe("failed");
      expect(result.videos[0].error).toContain("Test error message");
    });
  });

  describe("processPlaylist() with sourcePlaylist", () => {
    it("should pass sourcePlaylist info to VideoProcessor", async () => {
      const url = `https://www.youtube.com/playlist?list=${MOCK_PLAYLIST_ID}`;

      const processSpy = vi.spyOn(videoProcessor, "process");

      await processor.processPlaylist(url, {
        skipVisuals: true,
        maxVideos: 1,
      });

      // Verify sourcePlaylist was passed to VideoProcessor
      expect(processSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sourcePlaylist: expect.objectContaining({
            playlistId: MOCK_PLAYLIST_ID,
            title: "TypeScript Tutorial Series",
            position: expect.any(Number),
          }),
        })
      );
    });
  });
});
