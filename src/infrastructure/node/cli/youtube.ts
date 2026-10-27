import { runPlaylistForeground } from "../../../application/jobs/foreground.js";
import { canonicalizeYouTubeVideo } from "../../../core/source.js";
import {
  createLocalAdapters,
  runLocalPipeline,
  type LocalPipelineOptions,
  type LocalProcessResult,
} from "./pipeline.js";
import { isYtDlpAvailable, isFfmpegAvailable } from "../download.js";
import { getTranscriberDiagnostics } from "../transcribe.js";
import type {
  PlaylistProcessResult,
  PlaylistVideoStatus,
  PlaylistVideoStatusType,
} from "../../../types/index.js";

export type YouTubeProcessOptions = LocalPipelineOptions;
export type ProcessResult = LocalProcessResult;
export interface YouTubePlaylistOptions extends Omit<
  LocalPipelineOptions,
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
export function processYouTube(
  url: string,
  options: YouTubeProcessOptions = {}
): Promise<ProcessResult> {
  return runLocalPipeline(
    { kind: "youtube", url: canonicalizeYouTubeVideo(url) },
    options
  );
}
export async function processYouTubePlaylist(
  url: string,
  options: YouTubePlaylistOptions = {}
): Promise<PlaylistProcessResult> {
  const adapters = createLocalAdapters({ ...options, onProgress: undefined });
  const result = await runPlaylistForeground(
    {
      url,
      settings: adapters.settings,
      maxVideos: options.maxVideos ?? 0,
      concurrency: options.concurrency ?? 1,
      continueOnError: options.continueOnError,
      skipExisting: options.skipExisting,
    },
    {
      catalog: adapters.catalog,
      process: (entry, playlist, context) =>
        processYouTube(entry.url, {
          ...options,
          signal: context.signal,
          force: options.skipExisting === false,
          sourcePlaylist: {
            playlistId: playlist.playlistId,
            title: playlist.title,
            position: entry.position,
          },
          onProgress: (event) =>
            context.emit({ runId: context.runId, ...event }),
        }),
    },
    {
      runId: "cli-playlist",
      attemptId: "foreground",
      signal: options.signal ?? new AbortController().signal,
      now: Date.now,
      emit: () => undefined,
    },
    {
      onStart: (entries) =>
        options.onStart?.(
          entries.map((entry) => ({
            contentId: entry.contentId,
            title: entry.title,
            status: "pending",
          })),
          entries.length
        ),
      onUpdate: (video, _index, event) =>
        options.onProgress?.(
          video.entry.contentId,
          video.status === "running"
            ? "processing"
            : video.status === "queued" || video.status === "cancelled"
              ? "pending"
              : video.status,
          event?.message
        ),
    }
  );
  const videos: PlaylistVideoStatus[] = result.videos.map((video) => ({
    contentId: video.entry.contentId,
    title: video.entry.title,
    status:
      video.status === "running"
        ? "processing"
        : video.status === "queued" || video.status === "cancelled"
          ? "pending"
          : video.status,
    ...(video.value ? { outputPath: video.value.outputPath } : {}),
    ...(video.failure ? { error: video.failure.message } : {}),
  }));
  return {
    playlist: result.playlist,
    videos,
    succeeded: videos.filter((video) => video.status === "completed").length,
    failed: videos.filter((video) => video.status === "failed").length,
    skipped: videos.filter((video) => video.status === "skipped").length,
    stats: result.stats,
  };
}
export async function checkYouTubePrerequisites() {
  const missing: string[] = [];
  if (!(await isYtDlpAvailable()))
    missing.push("yt-dlp (required for YouTube video download)");
  if (!(await isFfmpegAvailable()))
    missing.push("ffmpeg (required for audio/video processing)");
  const transcribers = await getTranscriberDiagnostics();
  return {
    ready: missing.length === 0,
    missing,
    warnings: transcribers.some((t) => t.available)
      ? []
      : ["No transcription adapters available."],
  };
}
export async function getDiagnostics() {
  return {
    ytdlp: await isYtDlpAvailable(),
    ffmpeg: await isFfmpegAvailable(),
    transcribers: await getTranscriberDiagnostics(),
  };
}
