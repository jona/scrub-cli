import { join } from 'path';
import { config } from './Config.js';
import { logger } from '../utils/logger.js';
import { extractVideoId, sanitizeFilename, ensureDir } from '../utils/helpers.js';
import { videoDownloader } from '../services/VideoDownloader.js';
import { transcriberFactory } from '../adapters/transcription/index.js';
import { sceneDetector } from '../services/SceneDetector.js';
import { visualAnalyzer } from '../services/VisualAnalyzer.js';
import { summarizer } from '../services/Summarizer.js';
import { markdownGenerator } from '../services/MarkdownGenerator.js';
import type {
  VideoMetadata,
  VisualAnalysis,
  SummaryResult,
  ProgressCallback,
} from '../types/index.js';
import type {
  TranscriptionResult,
  TranscriptionSource,
} from '../adapters/transcription/ITranscriber.js';

/**
 * Options for processing a video
 */
export interface ProcessOptions {
  /** Output file path (default: ./output/{video-id}.md) */
  outputPath?: string;
  /** Skip visual analysis (faster, cheaper) */
  skipVisuals?: boolean;
  /** Force a specific transcription adapter */
  transcriber?: TranscriptionSource;
  /** Scene detection threshold (0-1) */
  sceneThreshold?: number;
  /** Maximum frames to analyze */
  maxFrames?: number;
  /** Progress callback */
  onProgress?: ProgressCallback;
  /** Verbose logging */
  verbose?: boolean;
}

/**
 * Result of processing a video
 */
export interface ProcessResult {
  metadata: VideoMetadata;
  transcript: TranscriptionResult;
  visuals: VisualAnalysis[];
  summary: SummaryResult;
  markdown: string;
  outputPath: string;
  stats: {
    downloadTime: number;
    transcriptionTime: number;
    visualAnalysisTime: number;
    summarizationTime: number;
    totalTime: number;
  };
}

/**
 * Main orchestrator for video processing
 */
export class VideoProcessor {
  /**
   * Process a YouTube video into a markdown summary
   */
  async process(url: string, options: ProcessOptions = {}): Promise<ProcessResult> {
    const startTime = Date.now();
    const stats = {
      downloadTime: 0,
      transcriptionTime: 0,
      visualAnalysisTime: 0,
      summarizationTime: 0,
      totalTime: 0,
    };

    // Validate URL
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error(`Invalid YouTube URL: ${url}`);
    }

    // Set verbose logging if requested
    if (options.verbose) {
      logger.setVerbose(true);
    }

    const visualConfig = config.getVisual();
    const skipVisuals = options.skipVisuals ?? !visualConfig.enabled;

    type ProcessingStage = 'download' | 'transcribe' | 'scene-detect' | 'visual-analyze' | 'summarize' | 'generate';
    
    // Progress helper
    const progress = (
      stage: ProcessingStage,
      step: number,
      total: number,
      message: string
    ) => {
      options.onProgress?.({
        stage,
        progress: (step / total) * 100,
        message,
      });
    };

    try {
      // Step 1: Download video
      progress('download', 1, 5, 'Downloading video...');
      const downloadStart = Date.now();
      
      const download = await videoDownloader.download(url, {
        skipVideo: skipVisuals,
        onProgress: (msg) => progress('download', 1, 5, msg),
      });
      
      stats.downloadTime = Date.now() - downloadStart;
      logger.debug(`Download completed in ${stats.downloadTime}ms`);

      // Step 2: Transcribe audio
      progress('transcribe', 2, 5, 'Transcribing audio...');
      const transcribeStart = Date.now();

      // Set video URL for captions fallback
      transcriberFactory.setVideoUrl(url);

      const transcript = await transcriberFactory.transcribe(
        download.audioPath,
        {
          preferredAdapter: options.transcriber,
        }
      );

      stats.transcriptionTime = Date.now() - transcribeStart;
      logger.debug(
        `Transcription completed in ${stats.transcriptionTime}ms using ${transcript.source}`
      );

      // Step 3: Visual analysis (optional)
      let visuals: VisualAnalysis[] = [];
      
      if (!skipVisuals && download.videoPath) {
        progress('scene-detect', 3, 5, 'Detecting scenes...');
        const visualStart = Date.now();

        // Detect scenes and extract frames
        const frames = await sceneDetector.detectScenes(download.videoPath, {
          threshold: options.sceneThreshold ?? visualConfig.sceneThreshold,
          maxFrames: options.maxFrames ?? visualConfig.maxFrames,
          onProgress: (msg) => progress('scene-detect', 3, 5, msg),
        });

        if (frames.length > 0 && visualAnalyzer.isAvailable()) {
          progress('visual-analyze', 3, 5, 'Analyzing visual content...');
          
          visuals = await visualAnalyzer.analyzeFrames(frames, {
            onProgress: (msg) => progress('visual-analyze', 3, 5, msg),
          });
        }

        stats.visualAnalysisTime = Date.now() - visualStart;
        logger.debug(
          `Visual analysis completed in ${stats.visualAnalysisTime}ms (${visuals.length} frames)`
        );
      } else {
        progress('visual-analyze', 3, 5, 'Skipping visual analysis');
      }

      // Step 4: Summarize content
      progress('summarize', 4, 5, 'Generating summary...');
      const summarizeStart = Date.now();

      const summary = await summarizer.summarize(
        download.metadata,
        transcript,
        visuals,
        {
          onProgress: (msg) => progress('summarize', 4, 5, msg),
        }
      );

      stats.summarizationTime = Date.now() - summarizeStart;
      logger.debug(`Summarization completed in ${stats.summarizationTime}ms`);

      // Step 5: Generate markdown
      progress('generate', 5, 5, 'Generating markdown...');

      const includeTranscript = config.getOutput().includeFullTranscript;
      const markdown = markdownGenerator.generate(
        download.metadata,
        summary,
        includeTranscript ? transcript : undefined
      );

      // Determine output path
      const outputPath = this.resolveOutputPath(
        options.outputPath,
        download.metadata
      );

      // Save the markdown file
      markdownGenerator.save(markdown, outputPath);

      stats.totalTime = Date.now() - startTime;

      logger.debug(`Total processing time: ${stats.totalTime}ms`);

      return {
        metadata: download.metadata,
        transcript,
        visuals,
        summary,
        markdown,
        outputPath,
        stats,
      };
    } catch (error) {
      // Re-throw with more context
      const err = error as Error;
      throw new Error(`Failed to process video ${videoId}: ${err.message}`);
    }
  }

  /**
   * Resolve the output file path
   */
  private resolveOutputPath(
    customPath: string | undefined,
    metadata: VideoMetadata
  ): string {
    if (customPath) {
      return customPath;
    }

    const outputDir = config.getOutputDir();
    ensureDir(outputDir);

    const filename = sanitizeFilename(metadata.title) || metadata.videoId;
    return join(outputDir, `${filename}.md`);
  }

  /**
   * Check prerequisites before processing
   */
  async checkPrerequisites(): Promise<{
    ready: boolean;
    missing: string[];
    warnings: string[];
  }> {
    const missing: string[] = [];
    const warnings: string[] = [];

    // Check yt-dlp
    if (!(await videoDownloader.isAvailable())) {
      missing.push('yt-dlp (required for video download)');
    }

    // Check ffmpeg (needed for audio extraction and scene detection)
    if (!(await videoDownloader.hasFfmpeg())) {
      missing.push('ffmpeg (required for audio/video processing)');
    }

    // Check Anthropic API key
    if (!config.hasAnthropicKey()) {
      missing.push('ANTHROPIC_API_KEY (required for summarization)');
    }

    // Check transcription options
    const transcribers = await transcriberFactory.getDiagnostics();
    const availableTranscribers = transcribers.filter((t) => t.available);

    if (availableTranscribers.length === 0) {
      warnings.push(
        'No transcription adapters available. Install whisper.cpp, ' +
        'faster-whisper, or set OPENAI_API_KEY for transcription.'
      );
    } else {
      const names = availableTranscribers.map((t) => t.name).join(', ');
      logger.debug(`Available transcribers: ${names}`);
    }

    // YouTube captions are always available as fallback
    const hasCaptionsFallback = transcribers.find(
      (t) => t.source === 'youtube-captions'
    )?.available;

    if (!hasCaptionsFallback && availableTranscribers.length === 0) {
      missing.push('No transcription method available');
    }

    return {
      ready: missing.length === 0,
      missing,
      warnings,
    };
  }

  /**
   * Get diagnostic information about the system
   */
  async getDiagnostics(): Promise<{
    ytdlp: boolean;
    ffmpeg: boolean;
    anthropicKey: boolean;
    transcribers: Array<{
      source: string;
      name: string;
      available: boolean;
    }>;
  }> {
    const transcribers = await transcriberFactory.getDiagnostics();

    return {
      ytdlp: await videoDownloader.isAvailable(),
      ffmpeg: await videoDownloader.hasFfmpeg(),
      anthropicKey: config.hasAnthropicKey(),
      transcribers: transcribers.map((t) => ({
        source: t.source,
        name: t.name,
        available: t.available,
      })),
    };
  }
}

// Export singleton instance
export const videoProcessor = new VideoProcessor();
