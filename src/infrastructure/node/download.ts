/** Node yt-dlp implementation. Portable callers use MediaProcessor. */
import {
  runCommand,
  getCommandFailureDiagnostics,
} from "../../utils/helpers.js";
import { canonicalizeYouTubeVideo, extractVideoId } from "../../core/source.js";
import { PipelineError } from "../../core/errors.js";
import type { MediaMetadata } from "../../core/models.js";
import type { PrepareResult } from "../../types/index.js";
import type { NativeOperationOptions } from "./runtime.js";
import {
  queueNativeCommandDiagnostic,
  type NativeCommandDiagnostic,
  type NativeCommandErrorCode,
} from "./diagnostics.js";

type CommandResult = Awaited<ReturnType<typeof runCommand>>;
async function runDownloader(
  operation: NativeCommandDiagnostic["operation"],
  url: string,
  args: string[],
  options: NativeOperationOptions & { stdoutMode?: "tail" }
): Promise<{
  result: CommandResult;
  diagnose: (code: NativeCommandErrorCode) => void;
}> {
  const started = performance.now();
  let stderr = "";
  let truncated = false;
  let result: CommandResult | undefined;
  let failure: ReturnType<typeof getCommandFailureDiagnostics>;
  const diagnose = (errorCode: NativeCommandErrorCode) => {
    let text = failure?.stderr ?? (stderr || result?.stderr || "");
    const cut = truncated || failure?.stderrTruncated === true;
    // A retained tail can start inside an unknown cookie/header value. Discard
    // that partial line rather than expose an unlabelled credential fragment.
    if (cut)
      text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
    queueNativeCommandDiagnostic(
      {
        version: 1,
        event: "native_command_failed",
        tool: "yt-dlp",
        operation,
        sourceId: extractVideoId(url)!,
        timestamp: new Date().toISOString(),
        elapsedMs: Math.max(0, performance.now() - started),
        errorCode,
        stderr: text,
        stderrTruncated: cut,
        ...(result
          ? {
              exitCode: result.code,
              ...(result.signal ? { signal: result.signal } : {}),
            }
          : failure
            ? {
                ...(failure.code === undefined
                  ? {}
                  : { exitCode: failure.code }),
                ...(failure.signal === undefined
                  ? {}
                  : { signal: failure.signal }),
              }
            : {}),
        ...options.diagnosticContext,
      },
      options.runtime?.diagnostics,
      options.runtime?.logger
    );
  };
  try {
    result = await (options.runtime?.runCommand ?? runCommand)(
      options.runtime?.ytdlpPath ?? "yt-dlp",
      args,
      {
        ...options,
        onStderr: (text) => {
          const bytes = Buffer.from(stderr + text);
          if (bytes.length > 64 * 1024) {
            truncated = true;
            let start = bytes.length - 64 * 1024;
            while (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
              start++;
            stderr = bytes.subarray(start).toString("utf8");
          } else stderr = bytes.toString("utf8");
        },
      }
    );
    if (result.code !== 0) diagnose("nonzero_exit");
    return { result, diagnose };
  } catch (error) {
    failure = getCommandFailureDiagnostics(error);
    const errorCode =
      error instanceof PipelineError
        ? ((
            {
              timeout: "timeout",
              cancelled: "cancelled",
              resource_limit: "output_limit",
            } as const
          )[error.code as "timeout" | "cancelled" | "resource_limit"] ??
          "command_failed")
        : error &&
            typeof error === "object" &&
            ["ENOENT", "EACCES", "ENOTDIR"].includes(
              String((error as { code?: unknown }).code)
            )
          ? "spawn_failed"
          : "command_failed";
    diagnose(errorCode);
    throw error;
  }
}

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
    "--no-progress",
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
  const { result: audio } = await runDownloader(
    "audio",
    url,
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
    { ...options, stdoutMode: "tail" }
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
    const { result: video } = await runDownloader(
      "video",
      url,
      [
        ...common,
        "-f",
        `best[height<=${options.maxResolution ?? 720}]/best`,
        "-o",
        path,
        "--",
        url,
      ],
      { ...options, stdoutMode: "tail" }
    );
    if (video.code === 0) videoPath = path;
    else {
      try {
        void Promise.resolve(
          runtime?.logger?.warn(
            "Video download failed; visual extraction will be skipped"
          )
        ).catch(() => undefined);
      } catch {
        /* A logging outage must not turn optional video failure into job failure. */
      }
    }
  }
  return { metadata, audioPath, videoPath, cacheDir: options.outputDir };
}
export async function fetchYouTubeMetadata(
  input: string,
  options: NativeOperationOptions = {}
): Promise<MediaMetadata> {
  const url = canonicalizeYouTubeVideo(input);
  const { result, diagnose } = await runDownloader(
    "metadata",
    url,
    [
      "--print",
      "%(.{title,description,duration,thumbnail,channel,upload_date})j",
      "--skip-download",
      "--no-playlist",
      "--socket-timeout",
      "30",
      "--retries",
      "2",
      "--no-warnings",
      "--",
      url,
    ],
    { ...options, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024 }
  );
  if (result.code !== 0)
    throw new PipelineError("unavailable", "Unable to read source metadata", {
      retryable: true,
      cause: result.stderr,
    });
  let raw;
  try {
    raw = JSON.parse(result.stdout);
    if (!Number.isFinite(raw.duration) || raw.duration < 0)
      throw new PipelineError("invalid_input", "Source has no finite duration");
  } catch (error) {
    diagnose(
      error instanceof PipelineError ? "invalid_duration" : "invalid_metadata"
    );
    if (error instanceof PipelineError) throw error;
    throw new PipelineError(
      "processing_failed",
      "Unable to parse source metadata",
      {
        retryable: false,
        cause: error,
      }
    );
  }
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
