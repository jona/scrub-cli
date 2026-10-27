/** Node yt-dlp implementation. Portable callers use MediaProcessor. */
import { runCommand } from "../../utils/helpers.js";
import { canonicalizeYouTubeVideo, extractVideoId } from "../../core/source.js";
import { PipelineError } from "../../core/errors.js";
import type { MediaMetadata } from "../../core/models.js";
import type { PrepareResult } from "../../types/index.js";
import type { NativeOperationOptions } from "./runtime.js";

export interface DownloadOptions extends NativeOperationOptions {
  outputDir: string;
  skipVideo?: boolean;
  maxResolution?: number;
  metadata?: MediaMetadata;
  onProgress?: (message: string) => void;
}
export async function download(
  input: string,
  options: DownloadOptions
): Promise<PrepareResult> {
  const url = canonicalizeYouTubeVideo(input);
  const runtime = options.runtime;
  const run = runtime?.runCommand ?? runCommand;
  const binary = runtime?.ytdlpPath ?? "yt-dlp";
  const metadata =
    options.metadata ?? (await fetchYouTubeMetadata(url, options));
  if (metadata.duration > (options.maxDurationSeconds ?? Infinity))
    throw new PipelineError(
      "resource_limit",
      "Media duration exceeds the configured limit"
    );
  const common = [
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "30",
    "--retries",
    "2",
  ];
  if (options.maxSourceBytes !== undefined)
    common.push("--max-filesize", String(options.maxSourceBytes));
  if (runtime?.ffmpegPath) common.push("--ffmpeg-location", runtime.ffmpegPath);
  const audioPath = `${options.outputDir}/audio.wav`;
  options.onProgress?.("Downloading audio...");
  const audio = await run(
    binary,
    [
      ...common,
      "-x",
      "--audio-format",
      "wav",
      "--audio-quality",
      "0",
      "-o",
      audioPath,
      "--",
      url,
    ],
    options
  );
  if (audio.code !== 0)
    throw new PipelineError("processing_failed", "Unable to download audio", {
      cause: audio.stderr,
      retryable: true,
    });
  let videoPath = "";
  if (!options.skipVideo) {
    options.onProgress?.("Downloading video...");
    const path = `${options.outputDir}/video.mp4`;
    const video = await run(
      binary,
      [
        ...common,
        "-f",
        `best[height<=${options.maxResolution ?? 720}]/best`,
        "-o",
        path,
        "--",
        url,
      ],
      options
    );
    if (video.code === 0) videoPath = path;
    else
      runtime?.logger?.warn(
        "Video download failed; visual extraction will be skipped"
      );
  }
  return { metadata, audioPath, videoPath, cacheDir: options.outputDir };
}
export async function fetchYouTubeMetadata(
  input: string,
  options: NativeOperationOptions = {}
): Promise<MediaMetadata> {
  const url = canonicalizeYouTubeVideo(input);
  const run = options.runtime?.runCommand ?? runCommand;
  const result = await run(
    options.runtime?.ytdlpPath ?? "yt-dlp",
    ["--dump-json", "--no-download", "--no-playlist", "--", url],
    { ...options, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024 }
  );
  if (result.code !== 0)
    throw new PipelineError("unavailable", "Unable to read source metadata", {
      retryable: true,
      cause: result.stderr,
    });
  const raw = JSON.parse(result.stdout);
  if (!Number.isFinite(raw.duration) || raw.duration < 0)
    throw new PipelineError("invalid_input", "Source has no finite duration");
  return {
    contentId: extractVideoId(url)!,
    title: String(raw.title ?? "Untitled"),
    description: String(raw.description ?? ""),
    duration: raw.duration,
    thumbnailUrl: String(raw.thumbnail ?? ""),
    source: String(raw.channel ?? "YouTube"),
    uploadDate:
      typeof raw.upload_date === "string" && /^\d{8}$/.test(raw.upload_date)
        ? `${raw.upload_date.slice(0, 4)}-${raw.upload_date.slice(4, 6)}-${raw.upload_date.slice(6, 8)}`
        : "",
    url,
  };
}
