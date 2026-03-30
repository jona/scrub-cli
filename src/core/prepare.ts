/**
 * prepare — Primitive for preparing local audio/video files for the pipeline
 *
 * Pure function: takes a local file path, extracts audio to WAV,
 * builds metadata from file info. Returns the same PrepareResult shape
 * as download() so the rest of the pipeline is source-agnostic.
 */

import { existsSync, statSync } from "fs";
import { resolve, basename, extname } from "path";
import { createHash } from "crypto";
import { runCommand, commandExists } from "../utils/helpers.js";
import type { MediaMetadata, PrepareResult } from "../types/index.js";

export interface PrepareOptions {
  /** Directory to save extracted audio */
  outputDir: string;
  /** Skip keeping video reference (audio only) */
  skipVideo?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Prepare a local .mp3 or .mp4 file for the pipeline
 */
export async function prepare(
  filePath: string,
  options: PrepareOptions
): Promise<PrepareResult> {
  const absolutePath = resolve(filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const fileType = getLocalFileType(absolutePath);
  if (!fileType) {
    throw new Error(
      `Unsupported file type: ${extname(absolutePath)}. Expected .mp3 or .mp4`
    );
  }

  if (!(await commandExists("ffmpeg"))) {
    throw new Error(
      "ffmpeg is not installed. Install with: brew install ffmpeg"
    );
  }

  const { outputDir, skipVideo, onProgress } = options;
  const audioPath = `${outputDir}/audio.wav`;

  // Get duration
  onProgress?.("Reading file metadata...");
  const duration = await getMediaDuration(absolutePath);

  // Build metadata
  const contentId = generateContentId(absolutePath);
  const metadata = buildLocalMetadata(absolutePath, contentId, duration);

  // Extract/convert audio to WAV
  if (!existsSync(audioPath)) {
    onProgress?.("Extracting audio...");
    await extractAudioToWav(absolutePath, audioPath);
  }

  // Video path: only relevant for mp4
  let videoPath = "";
  if (fileType === "mp4" && !skipVideo) {
    videoPath = absolutePath; // Use original file directly
  }

  return {
    metadata,
    audioPath,
    videoPath,
    cacheDir: outputDir,
  };
}

/**
 * Determine if input is a local file path (not a URL)
 */
export function isLocalFilePath(input: string): boolean {
  return /\.(mp3|mp4)$/i.test(input) && !input.startsWith("http");
}

/**
 * Get the media type of a local file
 */
export function getLocalFileType(filePath: string): "mp3" | "mp4" | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp3")) return "mp3";
  if (lower.endsWith(".mp4")) return "mp4";
  return null;
}

/**
 * Generate a deterministic content ID from a file path.
 * Uses sha256 of absolute path, prefixed with "local-" to distinguish from YouTube IDs.
 */
export function generateContentId(filePath: string): string {
  const absolutePath = resolve(filePath);
  const hash = createHash("sha256")
    .update(absolutePath)
    .digest("hex")
    .slice(0, 11);
  return `local-${hash}`;
}

/**
 * Get media duration using ffprobe
 */
export async function getMediaDuration(filePath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);

  if (result.code !== 0) {
    throw new Error(`Failed to get media duration: ${result.stderr}`);
  }

  return parseFloat(result.stdout.trim()) || 0;
}

/**
 * Extract audio from any media file to WAV format (16kHz mono for Whisper)
 */
export async function extractAudioToWav(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const args = [
    "-i", inputPath,
    "-vn", // No video
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    "-y", // Overwrite
    outputPath,
  ];

  const result = await runCommand("ffmpeg", args);

  if (result.code !== 0) {
    throw new Error(`Failed to extract audio: ${result.stderr}`);
  }
}

/**
 * Build MediaMetadata from local file info
 */
export function buildLocalMetadata(
  filePath: string,
  contentId: string,
  duration: number
): MediaMetadata {
  const absolutePath = resolve(filePath);
  const name = basename(absolutePath, extname(absolutePath));
  const stats = statSync(absolutePath);
  const mtime = stats.mtime;
  const uploadDate = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, "0")}-${String(mtime.getDate()).padStart(2, "0")}`;

  return {
    contentId,
    title: name,
    description: `Local file: ${absolutePath}`,
    duration,
    thumbnailUrl: "",
    source: "Local File",
    uploadDate,
    url: `file://${absolutePath}`,
  };
}
