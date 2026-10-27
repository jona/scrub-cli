import type {
  Failure,
  JobSubmission,
  OperationContext,
  PipelineEvent,
  RunStatus,
  SourceCatalog,
} from "../contracts.js";
import type { PlaylistEntry, PlaylistMetadata } from "../../core/models.js";
import {
  asPipelineError,
  PipelineError,
  throwIfAborted,
} from "../../core/errors.js";
import { enumerateSubmission } from "../playlist.js";
import { planJobDispatch } from "./dispatch.js";

export interface ForegroundVideo<T> {
  entry: PlaylistEntry;
  started: boolean;
  status: RunStatus | "skipped";
  value?: T;
  failure?: Failure;
}

/** Foreground occurrences share dispatch policy with durable jobs, without a daemon. */
export async function runPlaylistForeground<T extends { reused: boolean }>(
  input: JobSubmission,
  dependencies: {
    catalog: SourceCatalog;
    process: (
      entry: PlaylistEntry,
      playlist: PlaylistMetadata,
      context: OperationContext
    ) => Promise<T>;
  },
  context: OperationContext,
  observers: {
    onStart?(
      entries: readonly PlaylistEntry[],
      playlist: PlaylistMetadata
    ): void;
    onUpdate?(
      video: Readonly<ForegroundVideo<T>>,
      index: number,
      event?: PipelineEvent
    ): void;
  } = {}
): Promise<{
  playlist: PlaylistMetadata;
  videos: ForegroundVideo<T>[];
  stats: { totalTime: number; averageTimePerVideo: number };
}> {
  const started = context.now();
  throwIfAborted(context.signal);
  const listing = await enumerateSubmission(
    dependencies.catalog,
    input,
    context
  );
  const videos: ForegroundVideo<T>[] = listing.entries.map((entry) => ({
    entry,
    started: false,
    status: "queued",
  }));
  const controllers = new Map<number, AbortController>();
  const pending = new Map<number, Promise<void>>();
  const abort = () => {
    for (const controller of controllers.values()) controller.abort();
  };
  const notify = (index: number, event?: PipelineEvent) => {
    // Observer delivery cannot change the outcome of completed processing.
    try {
      observers.onUpdate?.({ ...videos[index] }, index, event);
    } catch {
      /* UI observer. */
    }
  };
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    observers.onStart?.(listing.entries, listing.metadata);
    for (;;) {
      const plan = planJobDispatch(videos, {
        concurrency: listing.input.concurrency,
        cancelRequested: context.signal.aborted,
        continueOnError: listing.input.continueOnError,
      });
      for (const video of plan.cancelPending) {
        video.status = "cancelled";
        notify(videos.indexOf(video));
      }
      for (const video of plan.cancel)
        controllers.get(videos.indexOf(video))?.abort();
      for (const video of plan.start) {
        const index = videos.indexOf(video);
        const controller = new AbortController();
        controllers.set(index, controller);
        video.started = true;
        video.status = "running";
        notify(index);
        const operation: OperationContext = {
          ...context,
          runId: `${context.runId}/${index + 1}`,
          attemptId: `${context.attemptId}/${index + 1}`,
          signal: AbortSignal.any([context.signal, controller.signal]),
          emit: async (event) => {
            notify(index, event);
            await context.emit(event);
          },
        };
        const work = Promise.resolve().then(async () => {
          try {
            throwIfAborted(operation.signal);
            video.value = await dependencies.process(
              video.entry,
              listing.metadata,
              operation
            );
            video.status =
              video.value.reused && listing.input.skipExisting
                ? "skipped"
                : "completed";
          } catch (error) {
            const failure = asPipelineError(error);
            video.status = operation.signal.aborted ? "cancelled" : "failed";
            video.failure = {
              ...failure.toJSON(),
              ...(operation.signal.aborted
                ? { code: "cancelled", retryable: false }
                : {}),
            };
          } finally {
            notify(index);
            controllers.delete(index);
            pending.delete(index);
          }
        });
        pending.set(index, work);
      }
      if (!pending.size) break;
      await Promise.race(pending.values());
    }
    throwIfAborted(context.signal);
    const failed = videos.find((video) => video.status === "failed");
    if (!listing.input.continueOnError && failed)
      throw new PipelineError(
        "processing_failed",
        `Playlist processing aborted: ${failed.failure?.message ?? "Processing failed"}`
      );
    const succeeded = videos.filter(
      (video) => video.status === "completed"
    ).length;
    const totalTime = Math.max(0, context.now() - started);
    return {
      playlist: listing.metadata,
      videos,
      stats: {
        totalTime,
        averageTimePerVideo: succeeded ? totalTime / succeeded : 0,
      },
    };
  } finally {
    context.signal.removeEventListener("abort", abort);
    abort();
    await Promise.allSettled(pending.values());
  }
}
