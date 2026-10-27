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
import { PipelineError } from "../../core/errors.js";
import { silentLogger, type NativeOperationOptions } from "./runtime.js";
import { commandExists, runCommand } from "../../utils/helpers.js";
import type { SceneFrame } from "../../types/index.js";

export interface ExtractFramesOptions extends NativeOperationOptions {
  /** Directory to save extracted frames */
  outputDir: string;
  /** Scene detection threshold (0-1) */
  threshold?: number;
  /** Maximum frames to extract */
  maxFrames?: number;
  /** Minimum seconds between frames */
  minInterval?: number;
  /** Full inference needs a representative frame even for a short static clip. */
  ensureFrame?: boolean;
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
  if (!options.runtime && !(await commandExists("ffmpeg"))) {
    throw new Error(
      "ffmpeg is not installed. Install with: brew install ffmpeg"
    );
  }

  if (!existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const visualConfig = options.runtime
    ? { sceneThreshold: 0.4, maxFrames: 20 }
    : (await import("../Config.js")).config.getVisual();
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
    operation: options,
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
    operation: NativeOperationOptions & { ensureFrame?: boolean };
  }
): Promise<SceneFrame[]> {
  const { threshold, maxFrames, minInterval, onProgress, operation } = options;
  const run = operation.runtime?.runCommand ?? runCommand;
  const logger = operation.runtime?.logger ?? silentLogger;

  // Get video duration
  const duration = await getVideoDuration(videoPath, operation);
  if (duration > (operation.maxDurationSeconds ?? Infinity))
    throw new PipelineError(
      "resource_limit",
      "Video duration exceeds the configured limit"
    );
  logger.debug(`Video duration: ${duration}s`);

  // Run scene detection
  let timestamps = await detectSceneTimestamps(
    videoPath,
    threshold,
    maxFrames,
    minInterval,
    operation
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
  if (timestamps.length === 0 && operation.ensureFrame && duration > 0)
    timestamps.push(Math.min(1, duration / 2));

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

    const result = await run(
      operation.runtime?.ffmpegPath ?? "ffmpeg",
      [
        "-ss",
        timestamp.toFixed(3),
        "-i",
        videoPath,
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-y",
        ...(operation.maxArtifactBytes === undefined
          ? []
          : ["-fs", String(operation.maxArtifactBytes)]),
        framePath,
      ],
      { ...operation, stdoutMode: "tail" }
    );

    if (result.code === 0 && existsSync(framePath)) {
      frames.push({ timestamp, framePath });
    } else {
      logger.debug(`Failed to extract frame at ${timestamp}s`);
    }
  }

  return frames;
}

async function getVideoDuration(
  videoPath: string,
  operation: NativeOperationOptions
): Promise<number> {
  const run = operation.runtime?.runCommand ?? runCommand;
  const result = await run(
    operation.runtime?.ffprobePath ?? "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    operation
  );

  if (result.code !== 0) {
    throw new Error(`Failed to get video duration: ${result.stderr}`);
  }

  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration < 0 || result.stdout.trim() === "")
    throw new PipelineError(
      "processing_failed",
      "Media probe returned an invalid duration"
    );
  return duration;
}

async function detectSceneTimestamps(
  videoPath: string,
  threshold: number,
  maxFrames: number,
  minInterval: number,
  operation: NativeOperationOptions
): Promise<number[]> {
  const run = operation.runtime?.runCommand ?? runCommand;
  const timestamps: number[] = [];
  let pending = "";
  let streamed = false;
  const receive = (text: string) => {
    streamed = true;
    if (timestamps.length >= maxFrames) return;
    // stderr is a diagnostic tail. Consume scene timestamps as they arrive so
    // long ffmpeg runs cannot discard early frames. Only retain a partial token.
    const input = pending + text;
    const pattern = /pts_time:(\d+(?:\.\d+)?)(?=\s)/g;
    let consumed = 0;
    for (const match of input.matchAll(pattern)) {
      consumed = match.index + match[0].length;
      const timestamp = Number(match[1]);
      const last = timestamps[timestamps.length - 1];
      if (
        Number.isFinite(timestamp) &&
        (last === undefined || timestamp - last >= minInterval)
      )
        timestamps.push(timestamp);
      if (timestamps.length >= maxFrames) break;
    }
    pending = input.slice(Math.max(consumed, input.length - 128));
  };
  const result = await run(
    operation.runtime?.ffmpegPath ?? "ffmpeg",
    [
      "-i",
      videoPath,
      "-filter:v",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ],
    { ...operation, stdoutMode: "tail", onStderr: receive }
  );
  // Injected command adapters may provide a complete result without callbacks.
  if (!streamed) receive(result.stderr);
  receive("\n");

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
