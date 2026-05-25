/**
 * download — Primitive for downloading YouTube videos via yt-dlp
 *
 * Pure function: takes a YouTube URL, returns audio/video paths + metadata.
 */

import { logger } from "../utils/logger.js";
import {
  execAsync,
  commandExists,
  extractVideoId,
  runCommand,
} from "../utils/helpers.js";
import type { MediaMetadata, PrepareResult } from "../types/index.js";

/**
 * Raw metadata from yt-dlp --dump-json
 */
interface YtDlpMetadata {
  id: string;
  title: string;
  description: string;
  duration: number;
  thumbnail: string;
  channel: string;
  upload_date: string;
  webpage_url: string;
}

export interface DownloadOptions {
  /** Directory to save audio/video files */
  outputDir: string;
  /** Skip video download (audio only) */
  skipVideo?: boolean;
  /** Max video resolution */
  maxResolution?: number;
  /** Pre-fetched metadata (skips yt-dlp metadata fetch if provided) */
  metadata?: MediaMetadata;
  onProgress?: (message: string) => void;
}

/**
 * Download a YouTube video: extract audio + optionally video + metadata
 */
export async function download(
  url: string,
  options: DownloadOptions
): Promise<PrepareResult> {
  if (!(await commandExists("yt-dlp"))) {
    throw new Error(
      "yt-dlp is not installed. Install with: brew install yt-dlp or pip install yt-dlp"
    );
  }

  const contentId = extractVideoId(url);
  if (!contentId) {
    throw new Error(`Invalid YouTube URL: ${url}`);
  }

  const {
    outputDir,
    skipVideo,
    maxResolution = 720,
    metadata: preMetadata,
    onProgress,
  } = options;
  const audioPath = `${outputDir}/audio.wav`;
  const videoPath = `${outputDir}/video.mp4`;

  // Fetch metadata (skip if pre-fetched)
  onProgress?.("Fetching video metadata...");
  const metadata = preMetadata ?? (await fetchYouTubeMetadata(url));

  // Download audio
  onProgress?.("Downloading audio...");
  await downloadAudio(url, audioPath, onProgress);

  // Download video if needed
  let finalVideoPath = "";
  if (!skipVideo) {
    onProgress?.("Downloading video...");
    finalVideoPath = await downloadVideo(
      url,
      videoPath,
      maxResolution,
      onProgress
    );
  }

  return {
    metadata,
    audioPath,
    videoPath: finalVideoPath,
    cacheDir: outputDir,
  };
}

/**
 * Fetch video metadata using yt-dlp
 */
export async function fetchYouTubeMetadata(
  url: string
): Promise<MediaMetadata> {
  const { stdout } = await execAsync(
    `yt-dlp --dump-json --no-download "${url}"`,
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const raw = JSON.parse(stdout) as YtDlpMetadata;

  return {
    contentId: raw.id,
    title: raw.title,
    description: raw.description || "",
    duration: raw.duration,
    thumbnailUrl: raw.thumbnail,
    source: raw.channel,
    uploadDate: formatUploadDate(raw.upload_date),
    url: raw.webpage_url,
  };
}

/**
 * Check if yt-dlp is installed
 */
export async function isYtDlpAvailable(): Promise<boolean> {
  return commandExists("yt-dlp");
}

/**
 * Check if ffmpeg is installed
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  return commandExists("ffmpeg");
}

async function downloadAudio(
  url: string,
  outputPath: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const args = [
    "-x",
    "--audio-format",
    "wav",
    "--audio-quality",
    "0",
    "-o",
    outputPath,
    "--no-playlist",
    "--no-warnings",
    url,
  ];

  const result = await runCommand("yt-dlp", args, {
    onStderr: (data) => {
      const progressMatch = data.match(/(\d+\.?\d*)%/);
      if (progressMatch) {
        onProgress?.(`Downloading audio: ${progressMatch[1]}%`);
      }
    },
  });

  if (result.code !== 0) {
    throw new Error(`Failed to download audio: ${result.stderr}`);
  }
}

async function downloadVideo(
  url: string,
  outputPath: string,
  maxHeight: number,
  onProgress?: (message: string) => void
): Promise<string> {
  const args = [
    "-f",
    `best[height<=${maxHeight}]/best`,
    "-o",
    outputPath,
    "--no-playlist",
    "--no-warnings",
    url,
  ];

  const result = await runCommand("yt-dlp", args, {
    onStderr: (data) => {
      const progressMatch = data.match(/(\d+\.?\d*)%/);
      if (progressMatch) {
        onProgress?.(`Downloading video: ${progressMatch[1]}%`);
      }
    },
  });

  if (result.code !== 0) {
    logger.warn("Video download failed, visual analysis will be skipped");
    return "";
  }

  return outputPath;
}

function formatUploadDate(date: string): string {
  if (!date || date.length !== 8) return date;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}
