import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProcessingProgress } from "../../src/types/index.js";

// Mock data constants
const MOCK_VIDEO_ID = "56kq0VTkU4k";

// Setup mocks with inline factory functions (vi.mock is hoisted)
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
      audioPath: "/tmp/test-audio.wav",
      videoPath: "/tmp/test-video.mp4",
      cacheDir: "/tmp/test-cache",
    }),
  },
}));

vi.mock("../../src/transcription/index.js", () => ({
  transcriberFactory: {
    setVideoUrl: vi.fn(),
    transcribe: vi.fn().mockResolvedValue({
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
    }),
    getDiagnostics: vi.fn().mockResolvedValue([
      {
        source: "youtube-captions",
        name: "YouTube Captions",
        available: true,
        requiresApiKey: false,
      },
    ]),
  },
}));

vi.mock("../../src/services/Summarizer.js", () => ({
  summarizer: {
    isAvailable: vi.fn().mockReturnValue(true),
    summarize: vi.fn().mockResolvedValue({
      title: "Test Video: Introduction to TypeScript",
      tldr: "TypeScript adds static typing to JavaScript.",
      overview: "This video introduces TypeScript.",
      thesisAndClaims: {
        thesis: "TypeScript improves development.",
        keyClaims: [],
        persuasionGoal: undefined,
      },
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
      skillMd: "---\nname: test\n---\n# Test Skill",
      checklist: {
        name: { covered: true, source: "summary" },
        description: { covered: true, source: "summary" },
        triggerScenarios: { covered: true, source: "summary" },
        domainKnowledge: { covered: true, source: "summary" },
        workflows: { covered: false, source: null },
        examples: { covered: false, source: null },
        codeSnippets: { covered: false, source: null },
        templates: { covered: false, source: null },
      },
      suggestedName: "test-skill",
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
    generate: vi
      .fn()
      .mockReturnValue(
        "# Test Video: Introduction to TypeScript\n\n## Summary"
      ),
  },
}));

vi.mock("../../src/services/ArtifactStore.js", () => ({
  artifactStore: {
    loadTranscription: vi.fn().mockReturnValue(null),
    saveTranscription: vi.fn(),
    saveSummary: vi.fn(),
    saveVisualAnalysis: vi.fn(),
    saveMarkdown: vi
      .fn()
      .mockReturnValue("/tmp/test-output/56kq0VTkU4k/output/summary.md"),
    saveSkill: vi
      .fn()
      .mockReturnValue("/tmp/test-output/56kq0VTkU4k/output/SKILL.md"),
    saveSkillChecklist: vi.fn(),
    finalizeArtifacts: vi.fn(),
  },
}));

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

// Import after mocks are set up
import { VideoProcessor } from "../../src/core/VideoProcessor.js";
import { videoDownloader } from "../../src/services/VideoDownloader.js";
import { transcriberFactory } from "../../src/transcription/index.js";
import { summarizer } from "../../src/services/Summarizer.js";
import { skillGenerator } from "../../src/services/SkillGenerator.js";
import { sceneDetector } from "../../src/services/SceneDetector.js";
import { visualAnalyzer } from "../../src/services/VisualAnalyzer.js";
import { markdownGenerator } from "../../src/services/MarkdownGenerator.js";
import { artifactStore } from "../../src/services/ArtifactStore.js";
import { config } from "../../src/infrastructure/Config.js";

describe("VideoProcessor Integration", () => {
  let processor: VideoProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new VideoProcessor();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("process()", () => {
    it("should process a video and return a complete result", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.process(url, {
        skipVisuals: true,
        verbose: false,
      });

      // Verify result structure
      expect(result).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata.videoId).toBe(MOCK_VIDEO_ID);
      expect(result.metadata.title).toBe(
        "Test Video: Introduction to TypeScript"
      );
      expect(result.metadata.channelName).toBe("Test Channel");

      // Verify transcript
      expect(result.transcript).toBeDefined();
      expect(result.transcript.fullText).toContain("TypeScript");
      expect(result.transcript.source).toBe("youtube-captions");

      // Verify summary
      expect(result.summary).toBeDefined();
      expect(result.summary.title).toBe(
        "Test Video: Introduction to TypeScript"
      );
      expect(result.summary.tldr).toContain("TypeScript");

      // Verify markdown output
      expect(result.markdown).toBeTruthy();
      expect(result.markdown).toContain("#");
      expect(result.outputPath).toBeTruthy();

      // Verify stats
      expect(result.stats).toBeDefined();
      expect(result.stats.downloadTime).toBeGreaterThanOrEqual(0);
      expect(result.stats.totalTime).toBeGreaterThanOrEqual(0);

      // Verify mocks were called correctly
      expect(videoDownloader.download).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ skipVideo: true })
      );
      expect(transcriberFactory.transcribe).toHaveBeenCalled();
      expect(summarizer.summarize).toHaveBeenCalled();
      expect(markdownGenerator.generate).toHaveBeenCalled();
      expect(artifactStore.saveMarkdown).toHaveBeenCalled();
    });

    it("should skip visuals when skipVisuals is true", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.process(url, {
        skipVisuals: true,
      });

      // Visuals should be empty when skipped
      expect(result.visuals).toEqual([]);

      // Scene detector and visual analyzer should not be called
      expect(sceneDetector.detectScenes).not.toHaveBeenCalled();
      expect(visualAnalyzer.analyzeFrames).not.toHaveBeenCalled();
    });

    it("should call progress callback during processing", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;
      const progressUpdates: ProcessingProgress[] = [];

      await processor.process(url, {
        skipVisuals: true,
        onProgress: (progress) => {
          progressUpdates.push({ ...progress });
        },
      });

      // Should have received progress updates
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Should include key stages
      const stages = progressUpdates.map((p) => p.stage);
      expect(stages).toContain("download");
      expect(stages).toContain("transcribe");
      expect(stages).toContain("summarize");
      expect(stages).toContain("generate");
    });

    it("should generate SKILL.md when generateSkill is true", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      const result = await processor.process(url, {
        skipVisuals: true,
        generateSkill: true,
      });

      // Skill result should be present
      expect(result.skillResult).toBeDefined();
      expect(result.skillResult!.skillMd).toContain("# Test Skill");
      expect(result.skillResult!.checklist).toBeDefined();
      expect(result.skillPath).toBeTruthy();

      // Verify skill generator was called
      expect(skillGenerator.generate).toHaveBeenCalled();
      expect(artifactStore.saveSkill).toHaveBeenCalled();
    });

    it("should throw an error for invalid YouTube URLs", async () => {
      // Test with URLs that won't match any YouTube pattern
      // Note: extractVideoId accepts 11-char strings as raw video IDs, so we use longer strings
      const invalidUrl1 = "this-is-not-a-valid-url";
      const invalidUrl2 = "https://example.com/video";
      const invalidUrl3 = "random-string-that-is-too-long";

      // These should throw because extractVideoId returns null for non-YouTube URLs
      await expect(processor.process(invalidUrl1)).rejects.toThrow(
        "Invalid YouTube URL"
      );
      await expect(processor.process(invalidUrl2)).rejects.toThrow(
        "Invalid YouTube URL"
      );
      await expect(processor.process(invalidUrl3)).rejects.toThrow(
        "Invalid YouTube URL"
      );
    });

    it("should use cached transcript when available", async () => {
      // Configure artifact store to return a cached transcript
      vi.mocked(artifactStore.loadTranscription).mockReturnValueOnce({
        segments: [
          { start: 0, end: 10, text: "Cached transcript.", confidence: 0.9 },
        ],
        fullText: "Cached transcript.",
        language: "en",
        duration: 600,
        source: "youtube-captions",
      });

      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      await processor.process(url, {
        skipVisuals: true,
      });

      // Verify cached transcript was checked
      expect(artifactStore.loadTranscription).toHaveBeenCalledWith(
        MOCK_VIDEO_ID
      );

      // Transcriber should not be called when cached transcript exists
      expect(transcriberFactory.transcribe).not.toHaveBeenCalled();
    });

    it("should save all artifacts during processing", async () => {
      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      await processor.process(url, {
        skipVisuals: true,
      });

      // Verify artifacts were saved
      expect(artifactStore.saveTranscription).toHaveBeenCalled();
      expect(artifactStore.saveSummary).toHaveBeenCalled();
      expect(artifactStore.saveMarkdown).toHaveBeenCalled();
      expect(artifactStore.finalizeArtifacts).toHaveBeenCalled();
    });

    it("should handle errors gracefully and provide context", async () => {
      // Configure downloader to fail
      vi.mocked(videoDownloader.download).mockRejectedValueOnce(
        new Error("Network error")
      );

      const url = `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`;

      await expect(processor.process(url)).rejects.toThrow(
        `Failed to process video ${MOCK_VIDEO_ID}`
      );
    });

    it("should accept various YouTube URL formats", async () => {
      const validUrls = [
        `https://www.youtube.com/watch?v=${MOCK_VIDEO_ID}`,
        `https://youtube.com/watch?v=${MOCK_VIDEO_ID}`,
        `https://youtu.be/${MOCK_VIDEO_ID}`,
      ];

      for (const url of validUrls) {
        vi.clearAllMocks();
        const result = await processor.process(url, { skipVisuals: true });
        expect(result.metadata.videoId).toBe(MOCK_VIDEO_ID);
      }
    });
  });

  describe("checkPrerequisites()", () => {
    it("should return prerequisite check results", async () => {
      const result = await processor.checkPrerequisites();

      expect(result).toBeDefined();
      expect(typeof result.ready).toBe("boolean");
      expect(Array.isArray(result.missing)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it("should report ready when all prerequisites are met", async () => {
      const result = await processor.checkPrerequisites();

      expect(result.ready).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("should report missing yt-dlp when not available", async () => {
      vi.mocked(videoDownloader.isAvailable).mockResolvedValueOnce(false);

      const result = await processor.checkPrerequisites();

      expect(result.ready).toBe(false);
      expect(result.missing).toContain("yt-dlp (required for video download)");
    });

    it("should report missing ffmpeg when not available", async () => {
      vi.mocked(videoDownloader.hasFfmpeg).mockResolvedValueOnce(false);

      const result = await processor.checkPrerequisites();

      expect(result.ready).toBe(false);
      expect(result.missing).toContain(
        "ffmpeg (required for audio/video processing)"
      );
    });

    it("should report missing Anthropic API key", async () => {
      vi.mocked(config.hasAnthropicKey).mockReturnValueOnce(false);

      const result = await processor.checkPrerequisites();

      expect(result.ready).toBe(false);
      expect(result.missing).toContain(
        "ANTHROPIC_API_KEY (required for summarization)"
      );
    });
  });

  describe("getDiagnostics()", () => {
    it("should return diagnostic information", async () => {
      const diagnostics = await processor.getDiagnostics();

      expect(diagnostics).toBeDefined();
      expect(typeof diagnostics.ytdlp).toBe("boolean");
      expect(typeof diagnostics.ffmpeg).toBe("boolean");
      expect(typeof diagnostics.anthropicKey).toBe("boolean");
      expect(Array.isArray(diagnostics.transcribers)).toBe(true);
    });

    it("should return transcriber availability info", async () => {
      const diagnostics = await processor.getDiagnostics();

      // Each transcriber should have required fields
      diagnostics.transcribers.forEach((t) => {
        expect(t.source).toBeTruthy();
        expect(t.name).toBeTruthy();
        expect(typeof t.available).toBe("boolean");
      });
    });

    it("should reflect current system state", async () => {
      const diagnostics = await processor.getDiagnostics();

      expect(diagnostics.ytdlp).toBe(true);
      expect(diagnostics.ffmpeg).toBe(true);
      expect(diagnostics.anthropicKey).toBe(true);
    });
  });
});
