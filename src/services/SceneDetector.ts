import { existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import { commandExists, runCommand, ensureDir } from "../utils/helpers.js";
import type { SceneFrame } from "../types/index.js";

/**
 * Service for detecting scene changes in videos and extracting key frames
 * Uses ffmpeg's scene detection filter
 */
export class SceneDetector {
  /**
   * Check if ffmpeg is available
   */
  async isAvailable(): Promise<boolean> {
    return commandExists("ffmpeg");
  }

  /**
   * Detect scene changes and extract key frames
   */
  async detectScenes(
    videoPath: string,
    options?: {
      outputDir?: string;
      threshold?: number;
      maxFrames?: number;
      minInterval?: number; // Minimum seconds between frames
      onProgress?: (message: string) => void;
    }
  ): Promise<SceneFrame[]> {
    if (!(await this.isAvailable())) {
      throw new Error(
        "ffmpeg is not installed. Install with: brew install ffmpeg"
      );
    }

    if (!existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    const visualConfig = config.getVisual();
    const threshold = options?.threshold ?? visualConfig.sceneThreshold;
    const maxFrames = options?.maxFrames ?? visualConfig.maxFrames;
    const minInterval = options?.minInterval ?? 2; // Default 2 seconds minimum between frames

    // Create output directory for frames
    const outputDir =
      options?.outputDir ??
      join(config.getCacheDir(), basename(videoPath, ".mp4"), "frames");
    ensureDir(outputDir);

    options?.onProgress?.("Analyzing video for scene changes...");

    // First, get video duration
    const duration = await this.getVideoDuration(videoPath);
    logger.debug(`Video duration: ${duration}s`);

    // Run scene detection to get timestamps
    const sceneTimestamps = await this.detectSceneTimestamps(
      videoPath,
      threshold,
      maxFrames,
      minInterval
    );

    logger.debug(`Detected ${sceneTimestamps.length} scene changes`);

    // If we didn't get enough scenes, add periodic frames
    if (sceneTimestamps.length < 3 && duration > 30) {
      const periodicFrames = this.generatePeriodicTimestamps(
        duration,
        maxFrames,
        minInterval
      );
      // Merge with scene timestamps, removing duplicates
      for (const ts of periodicFrames) {
        if (!sceneTimestamps.some((s) => Math.abs(s - ts) < minInterval)) {
          sceneTimestamps.push(ts);
        }
      }
      sceneTimestamps.sort((a, b) => a - b);
    }

    // Limit to maxFrames
    const finalTimestamps = sceneTimestamps.slice(0, maxFrames);

    options?.onProgress?.(`Extracting ${finalTimestamps.length} key frames...`);

    // Extract frames at the detected timestamps
    const frames = await this.extractFrames(
      videoPath,
      finalTimestamps,
      outputDir,
      options?.onProgress
    );

    return frames;
  }

  /**
   * Get video duration using ffprobe
   */
  private async getVideoDuration(videoPath: string): Promise<number> {
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

  /**
   * Detect scene change timestamps using ffmpeg
   */
  private async detectSceneTimestamps(
    videoPath: string,
    threshold: number,
    maxFrames: number,
    minInterval: number
  ): Promise<number[]> {
    // Use ffmpeg's scene detection filter with showinfo to get timestamps
    const result = await runCommand("ffmpeg", [
      "-i",
      videoPath,
      "-filter:v",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ]);

    // Parse timestamps from stderr (ffmpeg outputs info to stderr)
    const timestamps: number[] = [];
    const lines = result.stderr.split("\n");

    for (const line of lines) {
      // Look for showinfo output lines with pts_time
      const match = line.match(/pts_time:(\d+\.?\d*)/);
      if (match) {
        const timestamp = parseFloat(match[1]);

        // Apply minimum interval filter
        const lastTs = timestamps[timestamps.length - 1];
        if (lastTs === undefined || timestamp - lastTs >= minInterval) {
          timestamps.push(timestamp);
        }

        // Stop if we have enough
        if (timestamps.length >= maxFrames) {
          break;
        }
      }
    }

    return timestamps;
  }

  /**
   * Generate periodic timestamps for videos with few scene changes
   */
  private generatePeriodicTimestamps(
    duration: number,
    maxFrames: number,
    minInterval: number
  ): number[] {
    const timestamps: number[] = [];

    // Calculate interval to get roughly maxFrames/2 periodic frames
    const targetFrames = Math.floor(maxFrames / 2);
    const interval = Math.max(duration / targetFrames, minInterval);

    for (let t = interval; t < duration - 1; t += interval) {
      timestamps.push(t);
      if (timestamps.length >= targetFrames) break;
    }

    return timestamps;
  }

  /**
   * Extract frames at specific timestamps
   */
  private async extractFrames(
    videoPath: string,
    timestamps: number[],
    outputDir: string,
    onProgress?: (message: string) => void
  ): Promise<SceneFrame[]> {
    const frames: SceneFrame[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const frameIndex = String(i + 1).padStart(3, "0");
      const framePath = join(outputDir, `frame_${frameIndex}.png`);

      onProgress?.(`Extracting frame ${i + 1}/${timestamps.length}...`);

      // Extract single frame at timestamp
      const result = await runCommand("ffmpeg", [
        "-ss",
        timestamp.toFixed(3),
        "-i",
        videoPath,
        "-vframes",
        "1",
        "-q:v",
        "2", // High quality
        "-y", // Overwrite if exists
        framePath,
      ]);

      if (result.code === 0 && existsSync(framePath)) {
        frames.push({
          timestamp,
          framePath,
        });
      } else {
        logger.debug(`Failed to extract frame at ${timestamp}s`);
      }
    }

    return frames;
  }

  /**
   * Extract frames at regular intervals (simpler alternative)
   */
  async extractPeriodicFrames(
    videoPath: string,
    options?: {
      outputDir?: string;
      interval?: number; // Seconds between frames
      maxFrames?: number;
      onProgress?: (message: string) => void;
    }
  ): Promise<SceneFrame[]> {
    if (!(await this.isAvailable())) {
      throw new Error("ffmpeg is not installed");
    }

    const interval = options?.interval ?? 30; // Default every 30 seconds
    const maxFrames = options?.maxFrames ?? config.getVisual().maxFrames;

    const outputDir =
      options?.outputDir ??
      join(config.getCacheDir(), basename(videoPath, ".mp4"), "frames");
    ensureDir(outputDir);

    const duration = await this.getVideoDuration(videoPath);
    const timestamps: number[] = [];

    for (let t = 0; t < duration; t += interval) {
      timestamps.push(t);
      if (timestamps.length >= maxFrames) break;
    }

    options?.onProgress?.(`Extracting ${timestamps.length} periodic frames...`);

    return this.extractFrames(
      videoPath,
      timestamps,
      outputDir,
      options?.onProgress
    );
  }

  /**
   * Get cached frames if available
   */
  getCachedFrames(cacheDir: string): SceneFrame[] | null {
    const framesDir = join(cacheDir, "frames");

    if (!existsSync(framesDir)) {
      return null;
    }

    const files = readdirSync(framesDir)
      .filter((f) => f.startsWith("frame_") && f.endsWith(".png"))
      .sort();

    if (files.length === 0) {
      return null;
    }

    // We don't have timestamps cached, so we'll return frames without them
    // The visual analyzer can work without precise timestamps
    return files.map((file, index) => ({
      timestamp: index * 30, // Estimate 30s apart
      framePath: join(framesDir, file),
    }));
  }
}

// Export singleton instance
export const sceneDetector = new SceneDetector();
