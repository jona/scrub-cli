/**
 * file — Orchestrator for processing local .mp3/.mp4 files
 *
 * Chains: prepare → transcribe → (analyzeVisuals if mp4) → summarize
 * Manages artifact storage, caching, and progress callbacks.
 */

import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import { prepare, generateContentId, getLocalFileType } from "../core/prepare.js";
import { transcribe } from "../core/transcribe.js";
import { analyzeVisuals } from "../core/analyze-visuals.js";
import { summarize } from "../core/summarize.js";
import { isFfmpegAvailable } from "../core/download.js";
import { getTranscriberDiagnostics } from "../core/transcribe.js";
import { artifactStore } from "../services/ArtifactStore.js";
import type { VisualAnalysis } from "../types/index.js";
import type { TranscriptionSource } from "../transcription/ITranscriber.js";
import type { ProcessResult } from "./youtube.js";

export interface FileProcessOptions {
  skipVisuals?: boolean;
  transcriber?: TranscriptionSource;
  sceneThreshold?: number;
  maxFrames?: number;
  generateSkill?: boolean;
  skillName?: string;
  verbose?: boolean;
  onProgress?: (progress: { stage: string; progress: number; message: string }) => void;
}

/**
 * Process a local .mp3 or .mp4 file through the full pipeline
 */
export async function processFile(
  filePath: string,
  options: FileProcessOptions = {}
): Promise<ProcessResult> {
  const startTime = Date.now();
  const stats: ProcessResult["stats"] = {
    downloadTime: 0,
    transcriptionTime: 0,
    visualAnalysisTime: 0,
    summarizationTime: 0,
    totalTime: 0,
  };

  if (options.verbose) logger.setVerbose(true);

  const fileType = getLocalFileType(filePath);
  if (!fileType) {
    throw new Error(`Unsupported file type. Expected .mp3 or .mp4`);
  }

  // For mp3, always skip visuals
  let skipVisuals = options.skipVisuals ?? false;
  if (fileType === "mp3") skipVisuals = true;

  const visualConfig = config.getVisual();
  if (!skipVisuals && !visualConfig.enabled) skipVisuals = true;

  const contentId = generateContentId(filePath);

  const progress = (stage: string, step: number, total: number, message: string) => {
    options.onProgress?.({ stage, progress: (step / total) * 100, message });
  };

  try {
    // Step 1: Prepare (extract audio, build metadata)
    progress("download", 1, 5, "Preparing local file...");
    const prepareStart = Date.now();

    artifactStore.ensureVideoDirectories(contentId);
    const sourceDir = artifactStore.getSourceDir(contentId);

    const prepareResult = await prepare(filePath, {
      outputDir: sourceDir,
      skipVideo: skipVisuals,
      onProgress: (msg) => progress("download", 1, 5, msg),
    });

    stats.downloadTime = Date.now() - prepareStart;

    // Save metadata
    artifactStore.saveMetadata(contentId, prepareResult.metadata);

    // Step 2: Transcribe
    progress("transcribe", 2, 5, "Transcribing audio...");
    const transcribeStart = Date.now();

    let transcript = artifactStore.loadTranscription(contentId);
    if (transcript && !options.transcriber) {
      stats.transcriptionTime = Date.now() - transcribeStart;
      progress("transcribe", 2, 5, "Using cached transcript");
    } else {
      // No YouTube URL for local files — captions adapter will be skipped
      transcript = await transcribe(prepareResult.audioPath, {
        adapter: options.transcriber,
        onProgress: (msg) => progress("transcribe", 2, 5, msg),
      });
      stats.transcriptionTime = Date.now() - transcribeStart;
      artifactStore.saveTranscription(contentId, transcript);
    }

    // Step 3: Visual analysis (mp4 only)
    let visuals: VisualAnalysis[] = [];
    if (!skipVisuals && prepareResult.videoPath) {
      progress("scene-detect", 3, 5, "Detecting scenes...");
      const visualStart = Date.now();

      const framesDir = artifactStore.getFramesDir(contentId);
      visuals = await analyzeVisuals(prepareResult.videoPath, {
        outputDir: framesDir,
        threshold: options.sceneThreshold,
        maxFrames: options.maxFrames,
        onProgress: (msg) => progress("visual-analyze", 3, 5, msg),
      });

      stats.visualAnalysisTime = Date.now() - visualStart;

      if (visuals.length > 0) {
        artifactStore.saveVisualAnalysis(contentId, visuals);
      }
    }

    // Step 4: Summarize
    progress("summarize", 4, 5, "Generating summary...");
    const summarizeStart = Date.now();

    const transcriptPath = artifactStore.getArtifactPath(contentId, "transcription/json");
    const metadataPath = artifactStore.getArtifactPath(contentId, "source/metadata");
    const visualsPath = artifactStore.getArtifactPath(contentId, "inference/visual_analysis");

    const summarizeResult = await summarize(transcriptPath, {
      metadataPath,
      visualsPath: visuals.length > 0 ? visualsPath : undefined,
      outputMarkdown: true,
      outputSkill: options.generateSkill,
      skillName: options.skillName,
      transcriptPath,
      onProgress: (msg) => progress("summarize", 4, 5, msg),
    });

    stats.summarizationTime = Date.now() - summarizeStart;

    // Save artifacts
    artifactStore.saveSummary(contentId, summarizeResult.summary);
    const outputPath = artifactStore.saveMarkdown(contentId, summarizeResult.markdown!);

    let skillPath: string | undefined;
    if (summarizeResult.skill) {
      skillPath = artifactStore.saveSkill(contentId, summarizeResult.skill.skillMd);
      artifactStore.saveSkillChecklist(contentId, summarizeResult.skill.checklist);
    }

    stats.totalTime = Date.now() - startTime;

    // Finalize
    artifactStore.finalizeArtifacts(
      contentId,
      prepareResult.metadata,
      transcript.source,
      stats
    );

    return {
      metadata: prepareResult.metadata,
      transcript,
      visuals,
      summary: summarizeResult.summary,
      markdown: summarizeResult.markdown!,
      outputPath,
      skillPath,
      skillResult: summarizeResult.skill,
      stats,
    };
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to process file ${filePath}: ${err.message}`);
  }
}

/**
 * Check prerequisites for local file processing
 */
export async function checkFilePrerequisites(): Promise<{
  ready: boolean;
  missing: string[];
  warnings: string[];
}> {
  const missing: string[] = [];
  const warnings: string[] = [];

  // yt-dlp NOT required for local files
  if (!(await isFfmpegAvailable())) {
    missing.push("ffmpeg (required for audio extraction)");
  }
  if (!config.hasAnthropicKey()) {
    missing.push("ANTHROPIC_API_KEY (required for summarization)");
  }

  const transcribers = await getTranscriberDiagnostics();
  const available = transcribers.filter((t) => t.available);
  // Filter out youtube-captions since it won't work for local files
  const localAvailable = available.filter((t) => t.source !== "youtube-captions");
  if (localAvailable.length === 0) {
    warnings.push("No local transcription adapters available (youtube-captions cannot be used for local files).");
  }

  return { ready: missing.length === 0, missing, warnings };
}
