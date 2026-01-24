import { playlistExtractor } from "../services/PlaylistExtractor.js";
import { videoProcessor, ProcessOptions } from "./VideoProcessor.js";
import { artifactStore } from "../services/ArtifactStore.js";
import { logger } from "../utils/logger.js";
import type {
  PlaylistMetadata,
  PlaylistEntry,
  PlaylistVideoStatus,
  PlaylistVideoStatusType,
  PlaylistProcessResult,
} from "../types/index.js";

/**
 * Options for playlist processing
 */
export interface PlaylistProcessOptions
  extends Omit<ProcessOptions, "onProgress" | "sourcePlaylist"> {
  /** Maximum videos to process (0 = unlimited) */
  maxVideos?: number;
  /** Number of videos to process in parallel (default: 1 for sequential) */
  concurrency?: number;
  /** Continue processing if individual videos fail (default: true) */
  continueOnError?: boolean;
  /** Skip videos that have already been processed (default: true) */
  skipExisting?: boolean;
  /** Called once after playlist extraction completes */
  onStart?: (videos: PlaylistVideoStatus[], total: number) => void;
  /** Called for each video status update */
  onProgress?: (
    videoId: string,
    status: PlaylistVideoStatusType,
    stage?: string
  ) => void;
}

/**
 * Orchestrator for processing YouTube playlists
 * Delegates all video processing to VideoProcessor
 */
export class PlaylistProcessor {
  /**
   * Process a YouTube URL (playlist or single video)
   * Returns a unified result format for both cases
   */
  async processPlaylist(
    url: string,
    options: PlaylistProcessOptions = {}
  ): Promise<PlaylistProcessResult> {
    const startTime = Date.now();
    const {
      maxVideos = 0,
      concurrency = 1,
      continueOnError = true,
      skipExisting = true,
      onStart,
      onProgress,
      ...videoOptions
    } = options;

    // Extract playlist/video info
    const { metadata, entries } = await playlistExtractor.extract(url, {
      maxVideos,
    });

    logger.debug(
      `Processing ${entries.length} video(s) from "${metadata.title}"`
    );

    // Initialize video statuses
    const videoStatuses: PlaylistVideoStatus[] = entries.map((entry) => ({
      videoId: entry.videoId,
      title: entry.title,
      status: "pending" as PlaylistVideoStatusType,
    }));

    // Notify start
    onStart?.(videoStatuses, entries.length);

    // Process videos
    if (concurrency === 1) {
      await this.processSequential(
        entries,
        videoStatuses,
        metadata,
        videoOptions,
        { skipExisting, continueOnError, onProgress }
      );
    } else {
      await this.processParallel(
        entries,
        videoStatuses,
        metadata,
        videoOptions,
        { concurrency, skipExisting, continueOnError, onProgress }
      );
    }

    // Calculate stats
    const succeeded = videoStatuses.filter(
      (v) => v.status === "completed"
    ).length;
    const failed = videoStatuses.filter((v) => v.status === "failed").length;
    const skipped = videoStatuses.filter((v) => v.status === "skipped").length;
    const totalTime = Date.now() - startTime;

    return {
      playlist: metadata,
      videos: videoStatuses,
      succeeded,
      failed,
      skipped,
      stats: {
        totalTime,
        averageTimePerVideo: succeeded > 0 ? totalTime / succeeded : 0,
      },
    };
  }

  /**
   * Process videos sequentially (default - more reliable)
   */
  private async processSequential(
    entries: PlaylistEntry[],
    statuses: PlaylistVideoStatus[],
    metadata: PlaylistMetadata,
    videoOptions: Omit<ProcessOptions, "onProgress" | "sourcePlaylist">,
    options: {
      skipExisting: boolean;
      continueOnError: boolean;
      onProgress?: (
        videoId: string,
        status: PlaylistVideoStatusType,
        stage?: string
      ) => void;
    }
  ): Promise<void> {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const status = statuses[i];

      // Check if already processed
      if (options.skipExisting && artifactStore.hasVideo(entry.videoId)) {
        status.status = "skipped";
        status.outputPath = artifactStore.getArtifactPath(
          entry.videoId,
          "output/markdown"
        );
        options.onProgress?.(entry.videoId, "skipped");
        logger.debug(`Skipping ${entry.videoId} - already processed`);
        continue;
      }

      status.status = "processing";
      options.onProgress?.(entry.videoId, "processing", "Starting...");

      try {
        const result = await videoProcessor.process(entry.url, {
          ...videoOptions,
          sourcePlaylist: {
            playlistId: metadata.playlistId,
            title: metadata.title,
            position: entry.position,
          },
          onProgress: (progress) => {
            options.onProgress?.(entry.videoId, "processing", progress.message);
          },
        });

        status.status = "completed";
        status.outputPath = result.outputPath;
        options.onProgress?.(entry.videoId, "completed");
        logger.debug(`Completed ${entry.videoId}`);
      } catch (error) {
        status.status = "failed";
        status.error = error instanceof Error ? error.message : String(error);
        options.onProgress?.(entry.videoId, "failed");
        logger.error(`Failed to process ${entry.videoId}: ${status.error}`);

        if (!options.continueOnError) {
          throw new Error(`Playlist processing aborted: ${status.error}`);
        }
      }
    }
  }

  /**
   * Process videos in parallel (faster but more resource intensive)
   */
  private async processParallel(
    entries: PlaylistEntry[],
    statuses: PlaylistVideoStatus[],
    metadata: PlaylistMetadata,
    videoOptions: Omit<ProcessOptions, "onProgress" | "sourcePlaylist">,
    options: {
      concurrency: number;
      skipExisting: boolean;
      continueOnError: boolean;
      onProgress?: (
        videoId: string,
        status: PlaylistVideoStatusType,
        stage?: string
      ) => void;
    }
  ): Promise<void> {
    const { concurrency } = options;

    // Process in batches
    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const batchStatuses = statuses.slice(i, i + concurrency);

      await Promise.all(
        batch.map(async (entry, batchIndex) => {
          const status = batchStatuses[batchIndex];

          if (
            options.skipExisting &&
            artifactStore.hasVideo(entry.videoId)
          ) {
            status.status = "skipped";
            status.outputPath = artifactStore.getArtifactPath(
              entry.videoId,
              "output/markdown"
            );
            options.onProgress?.(entry.videoId, "skipped");
            return;
          }

          status.status = "processing";
          options.onProgress?.(entry.videoId, "processing", "Starting...");

          try {
            const result = await videoProcessor.process(entry.url, {
              ...videoOptions,
              sourcePlaylist: {
                playlistId: metadata.playlistId,
                title: metadata.title,
                position: entry.position,
              },
              onProgress: (progress) => {
                options.onProgress?.(
                  entry.videoId,
                  "processing",
                  progress.message
                );
              },
            });

            status.status = "completed";
            status.outputPath = result.outputPath;
            options.onProgress?.(entry.videoId, "completed");
          } catch (error) {
            status.status = "failed";
            status.error =
              error instanceof Error ? error.message : String(error);
            options.onProgress?.(entry.videoId, "failed");

            if (!options.continueOnError) {
              throw error;
            }
          }
        })
      );
    }
  }
}

// Export singleton instance
export const playlistProcessor = new PlaylistProcessor();
