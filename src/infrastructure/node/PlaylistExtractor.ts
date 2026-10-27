import { NodeSourceCatalog } from "./NodeSourceCatalog.js";
import {
  extractVideoId,
  extractPlaylistId,
  parseYouTubeSource,
} from "../../core/source.js";
import type { OperationContext } from "../../application/contracts.js";
import type { PlaylistMetadata, PlaylistEntry } from "../../core/models.js";

/** Legacy local CLI facade. New applications consume SourceCatalog directly. */
export class PlaylistExtractor {
  isPlaylistUrl(url: string): boolean {
    return extractPlaylistId(url) !== null;
  }
  extractPlaylistId(url: string): string | null {
    return extractPlaylistId(url);
  }
  parseUrl(url: string) {
    const source = parseYouTubeSource(url);
    return {
      contentId: extractVideoId(url),
      playlistId: extractPlaylistId(url),
      isPlaylist: source.kind === "playlist",
    };
  }
  async extract(
    url: string,
    options?: { maxVideos?: number }
  ): Promise<{ metadata: PlaylistMetadata; entries: PlaylistEntry[] }> {
    const context: OperationContext = {
      runId: "local",
      attemptId: "local",
      signal: new AbortController().signal,
      now: Date.now,
      emit() {},
    };
    const catalog = await new NodeSourceCatalog().enumerate(
      url,
      options?.maxVideos && options.maxVideos > 0 ? options.maxVideos : 1000,
      context
    );
    const entries: PlaylistEntry[] = [];
    for await (const entry of catalog.entries) entries.push(entry);
    return { metadata: catalog.metadata, entries };
  }
}
export const playlistExtractor = new PlaylistExtractor();
