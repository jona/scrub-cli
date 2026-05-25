/**
 * analyze-visuals — Primitive for visual analysis of video files
 *
 * Chains scene detection (ffmpeg) + frame analysis (Claude Vision).
 * Takes a video file path, returns VisualAnalysis[].
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import {
  commandExists,
  runCommand,
  chunk,
  formatTimestamp,
} from "../utils/helpers.js";
import type { SceneFrame, VisualAnalysis, VisualType } from "../types/index.js";

export interface AnalyzeVisualsOptions {
  /** Directory to save extracted frames */
  outputDir: string;
  /** Scene detection threshold (0-1) */
  threshold?: number;
  /** Maximum frames to analyze */
  maxFrames?: number;
  /** Minimum seconds between frames */
  minInterval?: number;
  onProgress?: (message: string) => void;
}

/**
 * Analyze visual content from a video file.
 * Detects scene changes, extracts frames, and analyzes them with Claude Vision.
 */
export async function analyzeVisuals(
  videoPath: string,
  options: AnalyzeVisualsOptions
): Promise<VisualAnalysis[]> {
  if (!(await commandExists("ffmpeg"))) {
    throw new Error(
      "ffmpeg is not installed. Install with: brew install ffmpeg"
    );
  }

  if (!existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  if (!config.hasAnthropicKey()) {
    throw new Error(
      "Anthropic API key not configured. Add apis.anthropic to ~/.scrub/config.json."
    );
  }

  const visualConfig = config.getVisual();
  const threshold = options.threshold ?? visualConfig.sceneThreshold;
  const maxFrames = options.maxFrames ?? visualConfig.maxFrames;
  const minInterval = options.minInterval ?? 2;
  const { outputDir, onProgress } = options;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Step 1: Detect scenes and extract frames
  onProgress?.("Analyzing video for scene changes...");
  const frames = await detectAndExtractFrames(videoPath, outputDir, {
    threshold,
    maxFrames,
    minInterval,
    onProgress,
  });

  if (frames.length === 0) {
    return [];
  }

  // Step 2: Analyze frames with Claude Vision
  onProgress?.("Analyzing visual content...");
  const visuals = await analyzeFramesWithVision(frames, { onProgress });

  return visuals;
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

// ── Frame Analysis (Claude Vision) ─────────────────────────────────

async function analyzeFramesWithVision(
  frames: SceneFrame[],
  options?: { batchSize?: number; onProgress?: (message: string) => void }
): Promise<VisualAnalysis[]> {
  const apiKey = config.getApiKey("anthropic");
  if (!apiKey) throw new Error("Anthropic API key not configured");

  const client = new Anthropic({ apiKey });
  const visualConfig = config.getVisual();
  const batchSize = options?.batchSize ?? 10;

  const results: VisualAnalysis[] = [];
  const batches = chunk(frames, batchSize);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    options?.onProgress?.(
      `Analyzing frames ${i * batchSize + 1}-${Math.min((i + 1) * batchSize, frames.length)}/${frames.length}...`
    );
    const batchResults = await analyzeBatch(client, batch, visualConfig.model);
    results.push(...batchResults);
  }

  return results;
}

async function analyzeBatch(
  client: Anthropic,
  frames: SceneFrame[],
  model: string
): Promise<VisualAnalysis[]> {
  const content: Anthropic.MessageParam["content"] = [];

  const frameList = frames
    .map((f, i) => `Frame ${i + 1} (${formatTimestamp(f.timestamp)})`)
    .join(", ");

  content.push({
    type: "text",
    text: `Analyze these ${frames.length} frames from an educational/instructional video: ${frameList}

For EACH frame, provide a JSON object with:
- "frameIndex": the frame number (1-based)
- "description": what's being shown (slide content, diagram, code, UI, etc.) - be specific and detailed
- "extractedText": any visible text, code, or formulas transcribed verbatim (use empty string if none)
- "visualType": one of "slide", "code", "diagram", "terminal", "talking-head", or "other"

Focus on educational content - capture key information that would help someone understand the video without watching it.

Respond with a JSON array of objects, one per frame. Example:
[
  {
    "frameIndex": 1,
    "description": "Title slide showing 'Introduction to React Hooks'",
    "extractedText": "Introduction to React Hooks\\nLearn useState, useEffect, and custom hooks",
    "visualType": "slide"
  }
]

Analyze all ${frames.length} frames now:`,
  });

  for (const frame of frames) {
    const imageData = loadImageAsBase64(frame.framePath);
    if (imageData) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: imageData.mediaType,
          data: imageData.data,
        },
      });
    }
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content }],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return parseAnalysisResponse(responseText, frames);
}

function loadImageAsBase64(imagePath: string): {
  data: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
} | null {
  try {
    const stats = statSync(imagePath);
    if (stats.size > 20 * 1024 * 1024) {
      logger.warn(`Image ${basename(imagePath)} exceeds 20MB limit, skipping`);
      return null;
    }

    const buffer = readFileSync(imagePath);
    const data = buffer.toString("base64");

    const ext = imagePath.toLowerCase().split(".").pop();
    const mediaTypes: Record<
      string,
      "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    > = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };

    return { data, mediaType: mediaTypes[ext || "png"] || "image/png" };
  } catch (error) {
    logger.warn(
      `Failed to load image ${imagePath}: ${(error as Error).message}`
    );
    return null;
  }
}

function parseAnalysisResponse(
  responseText: string,
  frames: SceneFrame[]
): VisualAnalysis[] {
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn("Could not find JSON array in visual analysis response");
      return createFallbackAnalysis(frames);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      frameIndex: number;
      description: string;
      extractedText: string;
      visualType: string;
    }>;

    return parsed.map((item, index) => {
      const frameIndex = (item.frameIndex || index + 1) - 1;
      const frame = frames[frameIndex] || frames[index];

      return {
        timestamp: frame?.timestamp ?? index * 30,
        description: item.description || "No description available",
        extractedText: item.extractedText || "",
        visualType: normalizeVisualType(item.visualType),
      };
    });
  } catch (error) {
    logger.warn(
      `Failed to parse analysis response: ${(error as Error).message}`
    );
    return createFallbackAnalysis(frames);
  }
}

function normalizeVisualType(type: string): VisualType {
  const normalized = type?.toLowerCase().trim();
  const validTypes: VisualType[] = [
    "slide",
    "code",
    "diagram",
    "terminal",
    "talking-head",
    "other",
  ];

  if (validTypes.includes(normalized as VisualType)) {
    return normalized as VisualType;
  }

  if (normalized?.includes("code") || normalized?.includes("programming"))
    return "code";
  if (normalized?.includes("slide") || normalized?.includes("presentation"))
    return "slide";
  if (
    normalized?.includes("diagram") ||
    normalized?.includes("chart") ||
    normalized?.includes("graph")
  )
    return "diagram";
  if (
    normalized?.includes("terminal") ||
    normalized?.includes("console") ||
    normalized?.includes("shell")
  )
    return "terminal";
  if (
    normalized?.includes("person") ||
    normalized?.includes("speaker") ||
    normalized?.includes("face")
  )
    return "talking-head";

  return "other";
}

function createFallbackAnalysis(frames: SceneFrame[]): VisualAnalysis[] {
  return frames.map((frame) => ({
    timestamp: frame.timestamp,
    description: "Visual content at this timestamp",
    extractedText: "",
    visualType: "other" as VisualType,
  }));
}
