import type {
  OperationContext,
  SourceCatalog,
} from "../../application/contracts.js";
import type { PlaylistEntry, PlaylistMetadata } from "../../core/models.js";
import { PipelineError, throwIfAborted } from "../../core/errors.js";
import {
  canonicalizeYouTubeVideo,
  parseYouTubeSource,
} from "../../core/source.js";
import { runCommand } from "../../utils/helpers.js";
import { fetchYouTubeMetadata } from "./download.js";
import type { NativeRuntimeOptions } from "./runtime.js";

interface Page {
  metadata: PlaylistMetadata;
  entries: PlaylistEntry[];
  fetched: number;
}
export class NodeSourceCatalog implements SourceCatalog {
  private readonly pageSize: number;
  constructor(
    private readonly options: Partial<NativeRuntimeOptions> & {
      pageSize?: number;
      stageTimeoutMs?: number;
    } = {}
  ) {
    this.pageSize = options.pageSize ?? 25;
    if (
      !Number.isInteger(this.pageSize) ||
      this.pageSize < 1 ||
      this.pageSize > 100
    )
      throw new Error("Invalid source page size");
  }
  async enumerate(
    input: string,
    maximum: number,
    context: OperationContext
  ): Promise<{
    metadata: PlaylistMetadata;
    entries: AsyncIterable<PlaylistEntry>;
  }> {
    throwIfAborted(context.signal, "source");
    const deadline = AbortSignal.timeout(this.options.stageTimeoutMs ?? 60000);
    const signal = AbortSignal.any([context.signal, deadline]);
    const translate = (error: unknown): never => {
      if (deadline.aborted && !context.signal.aborted) {
        throw new PipelineError("timeout", "Source enumeration timed out", {
          stage: "source",
          retryable: true,
          cause: error,
        });
      }
      throwIfAborted(context.signal, "source");
      throw error;
    };
    try {
      const listing = await this.enumerateWithinDeadline(input, maximum, {
        ...context,
        signal,
      });
      return {
        metadata: listing.metadata,
        entries: (async function* () {
          try {
            yield* listing.entries;
          } catch (error) {
            translate(error);
          }
        })(),
      };
    } catch (error) {
      return translate(error);
    }
  }

  private async enumerateWithinDeadline(
    input: string,
    maximum: number,
    context: OperationContext
  ): Promise<{
    metadata: PlaylistMetadata;
    entries: AsyncIterable<PlaylistEntry>;
  }> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10000)
      throw new PipelineError(
        "invalid_input",
        "Playlist maximum must be between 1 and 10000"
      );
    throwIfAborted(context.signal, "source");
    const source = parseYouTubeSource(input);
    if (source.kind === "video") {
      const metadata = await fetchYouTubeMetadata(source.url, {
        runtime: {
          ...this.options,
          stagingRoot: this.options.stagingRoot ?? "",
        },
        signal: context.signal,
        timeoutMs: this.options.stageTimeoutMs ?? 60000,
      });
      const entry = {
        contentId: metadata.contentId,
        title: metadata.title,
        duration: metadata.duration,
        position: 1,
        url: metadata.url,
      };
      return {
        metadata: {
          playlistId: metadata.contentId,
          title: metadata.title,
          description: metadata.description,
          channelName: metadata.source,
          videoCount: 1,
          url: metadata.url,
        },
        entries: (async function* () {
          throwIfAborted(context.signal);
          yield entry;
        })(),
      };
    }
    const fetchPage = async (start: number, end: number): Promise<Page> => {
      throwIfAborted(context.signal, "source");
      const result = await (this.options.runCommand ?? runCommand)(
        this.options.ytdlpPath ?? "yt-dlp",
        [
          "--flat-playlist",
          "--dump-single-json",
          "--playlist-start",
          String(start),
          "--playlist-end",
          String(end),
          "--socket-timeout",
          "30",
          "--retries",
          "2",
          "--no-warnings",
          "--",
          source.url,
        ],
        {
          signal: context.signal,
          timeoutMs: this.options.stageTimeoutMs ?? 60000,
          maxOutputBytes: 2 * 1024 * 1024,
        }
      );
      if (result.code !== 0)
        throw new PipelineError(
          "unavailable",
          "Unable to enumerate source playlist",
          { retryable: true, cause: result.stderr }
        );
      const raw = JSON.parse(result.stdout);
      if (!Array.isArray(raw.entries) || raw.entries.length > end - start + 1)
        throw new PipelineError(
          "processing_failed",
          "Source returned an invalid playlist page"
        );
      const entries = raw.entries.map(
        (entry: Record<string, unknown>, index: number): PlaylistEntry => {
          const id = String(entry.id ?? "");
          const url = canonicalizeYouTubeVideo(id);
          return {
            contentId: id,
            title: String(entry.title ?? "Untitled"),
            duration:
              typeof entry.duration === "number" &&
              Number.isFinite(entry.duration) &&
              entry.duration >= 0
                ? entry.duration
                : 0,
            position:
              typeof entry.playlist_index === "number"
                ? entry.playlist_index
                : start + index,
            url,
          };
        }
      );
      return {
        fetched: raw.entries.length,
        entries,
        metadata: {
          playlistId: source.playlistId,
          title: String(raw.title ?? "YouTube playlist"),
          description: String(raw.description ?? ""),
          channelName: String(raw.channel ?? ""),
          videoCount:
            typeof raw.playlist_count === "number"
              ? Math.min(maximum, raw.playlist_count)
              : entries.length,
          url: source.url,
        },
      };
    };
    const first = await fetchPage(1, Math.min(maximum, this.pageSize));
    const pageSize = this.pageSize;
    async function* entries() {
      let page = first;
      let start = 1;
      let yielded = 0;
      while (true) {
        for (const entry of page.entries) {
          throwIfAborted(context.signal, "source");
          if (yielded >= maximum) return;
          yielded++;
          yield entry;
        }
        const requested = Math.min(pageSize, maximum - start + 1);
        if (page.fetched < requested || yielded >= maximum) return;
        start += page.fetched;
        page = await fetchPage(start, Math.min(maximum, start + pageSize - 1));
      }
    }
    return { metadata: first.metadata, entries: entries() };
  }
}
