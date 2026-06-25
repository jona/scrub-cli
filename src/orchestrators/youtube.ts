/**
 * youtube — Orchestrator for processing YouTube videos and playlists
 *
 * Chains: download → transcribe → extractFrames → emit prompt artifacts
 * Manages artifact storage, caching, progress callbacks, and playlist iteration.
 * Fully deterministic — no model is called. An agent harness consumes the emitted
 * prompt + schema to produce a summary.
 */

import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import { extractVideoId } from "../utils/helpers.js";
import {
  download,
  fetchYouTubeMetadata,
  isYtDlpAvailable,
  isFfmpegAvailable,
} from "../core/download.js";
import { transcribe, getTranscriberDiagnostics } from "../core/transcribe.js";
import { extractFrames } from "../core/extract-frames.js";
import { buildPromptArtifacts } from "../core/prompt.js";
import { artifactStore } from "../services/ArtifactStore.js";
import { playlistExtractor } from "../services/PlaylistExtractor.js";
import type {
  SceneFrame,
  SourcePlaylist,
  PlaylistEntry,
  PlaylistVideoStatus,
  PlaylistVideoStatusType,
  PlaylistProcessResult,
  MediaMetadata,
} from "../types/index.js";
import type {
  TranscriptionResult,
  TranscriptionSource,
} from "../transcription/ITranscriber.js";

export interface YouTubeProcessOptions {
  skipVisuals?: boolean;
  transcriber?: TranscriptionSource;
  sceneThreshold?: number;
  maxFrames?: number;
  verbose?: boolean;
  sourcePlaylist?: SourcePlaylist;
  onProgress?: (progress: {
    stage: string;
    progress: number;
    message: string;
  }) => void;
}

export interface ProcessResult {
  metadata: MediaMetadata;
  transcript: TranscriptionResult;
  frames: SceneFrame[];
  /** Path to the emitted summary.prompt.md */
  promptPath: string;
  /** Primary output path (the assembled prompt) */
  outputPath: string;
  stats: {
    downloadTime: number;
    transcriptionTime: number;
    frameExtractionTime: number;
    promptTime: number;
    totalTime: number;
  };
}

export interface YouTubePlaylistOptions extends Omit<
  YouTubeProcessOptions,
  "onProgress" | "sourcePlaylist"
> {
  maxVideos?: number;
  concurrency?: number;
  continueOnError?: boolean;
  skipExisting?: boolean;
  onStart?: (videos: PlaylistVideoStatus[], total: number) => void;
  onProgress?: (
    contentId: string,
    status: PlaylistVideoStatusType,
    stage?: string
  ) => void;
}

/**
 * Process a single YouTube video through the full pipeline
 */
export async function processYouTube(
  url: string,
  options: YouTubeProcessOptions = {}
): Promise<ProcessResult> {
  const startTime = Date.now();
  const stats: ProcessResult["stats"] = {
    downloadTime: 0,
    transcriptionTime: 0,
    frameExtractionTime: 0,
    promptTime: 0,
    totalTime: 0,
  };

  const contentId = extractVideoId(url);
  if (!contentId) {
    throw new Error(`Invalid YouTube URL: ${url}`);
  }

  if (options.verbose) logger.setVerbose(true);

  const visualConfig = config.getVisual();
  const skipVisuals = options.skipVisuals ?? !visualConfig.enabled;

  const progress = (
    stage: string,
    step: number,
    total: number,
    message: string
  ) => {
    options.onProgress?.({ stage, progress: (step / total) * 100, message });
  };

  try {
    // Step 1: Download
    progress("download", 1, 5, "Fetching metadata...");
    const downloadStart = Date.now();

    const metadata = await fetchYouTubeMetadata(url);
    artifactStore.ensureVideoDirectories(contentId, metadata.title);
    const sourceDir = artifactStore.getSourceDir(contentId);

    const downloadResult = await download(url, {
      outputDir: sourceDir,
      skipVideo: skipVisuals,
      metadata,
      onProgress: (msg) => progress("download", 1, 5, msg),
    });

    stats.downloadTime = Date.now() - downloadStart;

    // Save metadata
    artifactStore.saveMetadata(contentId, metadata);

    // Step 2: Transcribe
    progress("transcribe", 2, 5, "Transcribing audio...");
    const transcribeStart = Date.now();

    let transcript = artifactStore.loadTranscription(contentId);
    if (transcript && !options.transcriber) {
      stats.transcriptionTime = Date.now() - transcribeStart;
      progress("transcribe", 2, 5, "Using cached transcript");
    } else {
      transcript = await transcribe(downloadResult.audioPath, {
        adapter: options.transcriber,
        youtubeUrl: url,
        onProgress: (msg) => progress("transcribe", 2, 5, msg),
      });
      stats.transcriptionTime = Date.now() - transcribeStart;
      artifactStore.saveTranscription(contentId, transcript);
    }

    // Step 3: Extract key frames (deterministic; vision is the harness's job)
    let frames: SceneFrame[] = [];
    if (!skipVisuals && downloadResult.videoPath) {
      progress("extract-frames", 3, 4, "Extracting key frames...");
      const framesStart = Date.now();

      const framesDir = artifactStore.getFramesDir(contentId);
      frames = await extractFrames(downloadResult.videoPath, {
        outputDir: framesDir,
        threshold: options.sceneThreshold,
        maxFrames: options.maxFrames,
        onProgress: (msg) => progress("extract-frames", 3, 4, msg),
      });

      stats.frameExtractionTime = Date.now() - framesStart;

      if (frames.length > 0) {
        artifactStore.saveFramesManifest(contentId, frames);
      }
    }

    // Step 4: Assemble the summary prompt + output schema
    progress("prompt", 4, 4, "Assembling summary prompt...");
    const promptStart = Date.now();

    const transcriptPath = artifactStore.getArtifactPath(
      contentId,
      "transcription/json"
    );
    const metadataPath = artifactStore.getArtifactPath(
      contentId,
      "source/metadata"
    );

    const { prompt, schema } = buildPromptArtifacts(transcriptPath, {
      metadataPath,
      onProgress: (msg) => progress("prompt", 4, 4, msg),
    });

    const promptPath = artifactStore.savePrompt(contentId, prompt, schema);

    stats.promptTime = Date.now() - promptStart;
    stats.totalTime = Date.now() - startTime;

    // Finalize
    artifactStore.finalizeArtifacts(
      contentId,
      downloadResult.metadata,
      transcript.source,
      stats,
      options.sourcePlaylist
    );

    return {
      metadata: downloadResult.metadata,
      transcript,
      frames,
      promptPath,
      outputPath: promptPath,
      stats,
    };
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to process video ${contentId}: ${err.message}`);
  }
}

/**
 * Process a YouTube URL (playlist or single video)
 */
export async function processYouTubePlaylist(
  url: string,
  options: YouTubePlaylistOptions = {}
): Promise<PlaylistProcessResult> {
  const startTime = Date.now();
  const {
    maxVideos = 0,
    concurrency = 1,
    continueOnError = true,
    skipExisting = true,
    onStart,
    onProgress,
    ...videoOptions
  } = options;

  const { metadata, entries } = await playlistExtractor.extract(url, {
    maxVideos,
  });

  const videoStatuses: PlaylistVideoStatus[] = entries.map((entry) => ({
    contentId: entry.contentId,
    title: entry.title,
    status: "pending" as PlaylistVideoStatusType,
  }));

  onStart?.(videoStatuses, entries.length);

  // Process videos
  const processEntry = async (
    entry: PlaylistEntry,
    status: PlaylistVideoStatus
  ) => {
    if (skipExisting && artifactStore.hasVideo(entry.contentId)) {
      status.status = "skipped";
      status.outputPath = artifactStore.getArtifactPath(
        entry.contentId,
        "prompt/summary"
      );
      onProgress?.(entry.contentId, "skipped");
      return;
    }

    status.status = "processing";
    onProgress?.(entry.contentId, "processing", "Starting...");

    try {
      const result = await processYouTube(entry.url, {
        ...videoOptions,
        sourcePlaylist: {
          playlistId: metadata.playlistId,
          title: metadata.title,
          position: entry.position,
        },
        onProgress: (progress) => {
          onProgress?.(entry.contentId, "processing", progress.message);
        },
      });

      status.status = "completed";
      status.outputPath = result.outputPath;
      onProgress?.(entry.contentId, "completed");
    } catch (error) {
      status.status = "failed";
      status.error = error instanceof Error ? error.message : String(error);
      onProgress?.(entry.contentId, "failed");

      if (!continueOnError) {
        throw new Error(`Playlist processing aborted: ${status.error}`);
      }
    }
  };

  if (concurrency === 1) {
    for (let i = 0; i < entries.length; i++) {
      await processEntry(entries[i], videoStatuses[i]);
    }
  } else {
    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const batchStatuses = videoStatuses.slice(i, i + concurrency);
      await Promise.all(
        batch.map((entry, j) => processEntry(entry, batchStatuses[j]))
      );
    }
  }

  const succeeded = videoStatuses.filter(
    (v) => v.status === "completed"
  ).length;
  const failed = videoStatuses.filter((v) => v.status === "failed").length;
  const skipped = videoStatuses.filter((v) => v.status === "skipped").length;
  const totalTime = Date.now() - startTime;

  return {
    playlist: metadata,
    videos: videoStatuses,
    succeeded,
    failed,
    skipped,
    stats: {
      totalTime,
      averageTimePerVideo: succeeded > 0 ? totalTime / succeeded : 0,
    },
  };
}

/**
 * Check prerequisites for YouTube processing
 */
export async function checkYouTubePrerequisites(): Promise<{
  ready: boolean;
  missing: string[];
  warnings: string[];
}> {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!(await isYtDlpAvailable())) {
    missing.push("yt-dlp (required for YouTube video download)");
  }
  if (!(await isFfmpegAvailable())) {
    missing.push("ffmpeg (required for audio/video processing)");
  }

  const transcribers = await getTranscriberDiagnostics();
  const available = transcribers.filter((t) => t.available);
  if (available.length === 0) {
    warnings.push("No transcription adapters available.");
  }

  return { ready: missing.length === 0, missing, warnings };
}

/**
 * Get system diagnostics
 */
export async function getDiagnostics() {
  const transcribers = await getTranscriberDiagnostics();
  return {
    ytdlp: await isYtDlpAvailable(),
    ffmpeg: await isFfmpegAvailable(),
    transcribers: transcribers.map((t) => ({
      source: t.source,
      name: t.name,
      available: t.available,
    })),
  };
}
