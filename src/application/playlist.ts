import { PipelineError } from "../core/errors.js";
import { parseYouTubeSource } from "../core/source.js";
import type {
  JobSubmission,
  JobVideo,
  JobSnapshot,
  SourceCatalog,
  OperationContext,
} from "./contracts.js";
import { resolveSettings } from "./settings.js";

export function normalizeSubmission(input: JobSubmission): Required<
  Omit<JobSubmission, "settings">
> & {
  settings: ReturnType<typeof resolveSettings>;
} {
  if (!input || typeof input.url !== "string")
    throw new PipelineError("invalid_input", "A YouTube URL is required");
  const source = parseYouTubeSource(input.url);
  const settings = resolveSettings(input.settings);
  const concurrency = input.concurrency ?? 1;
  const maxVideos = input.maxVideos ?? 0;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new PipelineError(
      "invalid_input",
      "Concurrency must be an integer between 1 and 16"
    );
  if (
    !Number.isInteger(maxVideos) ||
    maxVideos < 0 ||
    maxVideos > settings.limits.maxPlaylistVideos
  )
    throw new PipelineError("invalid_input", "Invalid playlist video limit");
  if (
    input.continueOnError !== undefined &&
    typeof input.continueOnError !== "boolean"
  )
    throw new PipelineError("invalid_input", "Invalid continueOnError flag");
  if (
    input.skipExisting !== undefined &&
    typeof input.skipExisting !== "boolean"
  )
    throw new PipelineError("invalid_input", "Invalid skipExisting flag");
  return {
    url: source.url,
    settings,
    concurrency,
    maxVideos,
    continueOnError: input.continueOnError ?? true,
    skipExisting: input.skipExisting ?? true,
  };
}

export async function enumerateSubmission(
  catalog: SourceCatalog,
  request: JobSubmission,
  context: OperationContext,
  onEntry?: (entry: import("../core/models.js").PlaylistEntry) => Promise<void>
) {
  const input = normalizeSubmission(request);
  const maximum = input.maxVideos || input.settings.limits.maxPlaylistVideos;
  const listing = await catalog.enumerate(input.url, maximum, context);
  const entries: import("../core/models.js").PlaylistEntry[] = [];
  for await (const entry of listing.entries) {
    if (context.signal.aborted)
      throw new PipelineError("cancelled", "Playlist enumeration cancelled");
    await onEntry?.(entry);
    entries.push(entry);
    if (entries.length >= maximum) break;
  }
  return {
    metadata: { ...listing.metadata, videoCount: entries.length },
    entries,
    input,
  };
}

export function summarizeVideos(
  base: Pick<JobSnapshot, "id" | "createdAt" | "updatedAt" | "stage">,
  videos: JobVideo[],
  cancelled = false
): JobSnapshot {
  const completed = videos.filter(
    (v) => v.status === "completed" || v.status === "skipped"
  ).length;
  const failed = videos.filter((v) => v.status === "failed").length;
  const stopped = videos.filter((v) => v.status === "cancelled").length;
  const active = videos.some(
    (v) => v.status === "running" || v.status === "queued"
  );
  const status = active
    ? cancelled
      ? "cancelled"
      : "running"
    : cancelled || stopped > 0
      ? "cancelled"
      : failed > 0
        ? completed > 0
          ? "completed_with_errors"
          : "failed"
        : "completed";
  return {
    ...base,
    status,
    total: videos.length,
    completed,
    failed,
    cancelled: stopped,
  };
}
