/**
 * extract-frames — Primitive for extracting key frames from a video file
 *
 * Deterministic: uses ffmpeg scene detection + frame extraction only. Emits the
 * frames and their timestamps as artifacts so an agent harness can run its own
 * vision model over them (and optionally write visual_analysis.json, which the
 * `prompt` primitive can fold back into the summary prompt).
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { commandExists, runCommand } from "../utils/helpers.js";
import { config } from "../infrastructure/Config.js";
import type { SceneFrame } from "../types/index.js";

export interface ExtractFramesOptions {
  /** Directory to save extracted frames */
  outputDir: string;
  /** Scene detection threshold (0-1) */
  threshold?: number;
  /** Maximum frames to extract */
  maxFrames?: number;
  /** Minimum seconds between frames */
  minInterval?: number;
  onProgress?: (message: string) => void;
}

/**
 * Extract key frames from a video file via scene detection.
 * Returns each frame's timestamp and on-disk path.
 */
export async function extractFrames(
  videoPath: string,
  options: ExtractFramesOptions
): Promise<SceneFrame[]> {
  if (!(await commandExists("ffmpeg"))) {
    throw new Error(
      "ffmpeg is not installed. Install with: brew install ffmpeg"
    );
  }

  if (!existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const visualConfig = config.getVisual();
  const threshold = options.threshold ?? visualConfig.sceneThreshold;
  const maxFrames = options.maxFrames ?? visualConfig.maxFrames;
  const minInterval = options.minInterval ?? 2;
  const { outputDir, onProgress } = options;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  onProgress?.("Analyzing video for scene changes...");
  const frames = await detectAndExtractFrames(videoPath, outputDir, {
    threshold,
    maxFrames,
    minInterval,
    onProgress,
  });

  return frames;
}

// ── Scene Detection ────────────────────────────────────────────────

async function detectAndExtractFrames(
  videoPath: string,
  outputDir: string,
  options: {
    threshold: number;
    maxFrames: number;
    minInterval: number;
    onProgress?: (message: string) => void;
  }
): Promise<SceneFrame[]> {
  const { threshold, maxFrames, minInterval, onProgress } = options;

  // Get video duration
  const duration = await getVideoDuration(videoPath);
  logger.debug(`Video duration: ${duration}s`);

  // Run scene detection
  let timestamps = await detectSceneTimestamps(
    videoPath,
    threshold,
    maxFrames,
    minInterval
  );
  logger.debug(`Detected ${timestamps.length} scene changes`);

  // Add periodic frames if too few scenes detected
  if (timestamps.length < 3 && duration > 30) {
    const periodicFrames = generatePeriodicTimestamps(
      duration,
      maxFrames,
      minInterval
    );
    for (const ts of periodicFrames) {
      if (!timestamps.some((s) => Math.abs(s - ts) < minInterval)) {
        timestamps.push(ts);
      }
    }
    timestamps.sort((a, b) => a - b);
  }

  // Limit
  const finalTimestamps = timestamps.slice(0, maxFrames);

  onProgress?.(`Extracting ${finalTimestamps.length} key frames...`);

  // Extract frames
  const frames: SceneFrame[] = [];
  for (let i = 0; i < finalTimestamps.length; i++) {
    const timestamp = finalTimestamps[i];
    const frameIndex = String(i + 1).padStart(3, "0");
    const framePath = join(outputDir, `frame_${frameIndex}.png`);

    onProgress?.(`Extracting frame ${i + 1}/${finalTimestamps.length}...`);

    const result = await runCommand("ffmpeg", [
      "-ss",
      timestamp.toFixed(3),
      "-i",
      videoPath,
      "-vframes",
      "1",
      "-q:v",
      "2",
      "-y",
      framePath,
    ]);

    if (result.code === 0 && existsSync(framePath)) {
      frames.push({ timestamp, framePath });
    } else {
      logger.debug(`Failed to extract frame at ${timestamp}s`);
    }
  }

  return frames;
}

async function getVideoDuration(videoPath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);

  if (result.code !== 0) {
    throw new Error(`Failed to get video duration: ${result.stderr}`);
  }

  return parseFloat(result.stdout.trim()) || 0;
}

async function detectSceneTimestamps(
  videoPath: string,
  threshold: number,
  maxFrames: number,
  minInterval: number
): Promise<number[]> {
  const result = await runCommand("ffmpeg", [
    "-i",
    videoPath,
    "-filter:v",
    `select='gt(scene,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ]);

  const timestamps: number[] = [];
  const lines = result.stderr.split("\n");

  for (const line of lines) {
    const match = line.match(/pts_time:(\d+\.?\d*)/);
    if (match) {
      const timestamp = parseFloat(match[1]);
      const lastTs = timestamps[timestamps.length - 1];
      if (lastTs === undefined || timestamp - lastTs >= minInterval) {
        timestamps.push(timestamp);
      }
      if (timestamps.length >= maxFrames) break;
    }
  }

  return timestamps;
}

function generatePeriodicTimestamps(
  duration: number,
  maxFrames: number,
  minInterval: number
): number[] {
  const timestamps: number[] = [];
  const targetFrames = Math.floor(maxFrames / 2);
  const interval = Math.max(duration / targetFrames, minInterval);

  for (let t = interval; t < duration - 1; t += interval) {
    timestamps.push(t);
    if (timestamps.length >= targetFrames) break;
  }

  return timestamps;
}
