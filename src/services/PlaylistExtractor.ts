import { execAsync, extractVideoId } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import type { PlaylistMetadata, PlaylistEntry } from "../types/index.js";

/**
 * Raw playlist metadata from yt-dlp --flat-playlist -J
 */
interface YtDlpPlaylistMetadata {
  id: string;
  title: string;
  description: string;
  channel: string;
  playlist_count: number;
  webpage_url: string;
  entries: YtDlpPlaylistEntry[];
}

/**
 * Raw entry from yt-dlp playlist output
 */
interface YtDlpPlaylistEntry {
  id: string;
  title: string;
  duration: number;
  url: string;
  playlist_index: number;
}

/**
 * Raw video metadata from yt-dlp --dump-json (for single videos)
 */
interface YtDlpVideoMetadata {
  id: string;
  title: string;
  description: string;
  duration: number;
  channel: string;
  webpage_url: string;
}

/**
 * Service for extracting playlist and video information from YouTube URLs
 */
export class PlaylistExtractor {
  /**
   * Check if a URL is a playlist URL
   */
  isPlaylistUrl(url: string): boolean {
    return /[?&]list=([^&]+)/.test(url);
  }

  /**
   * Extract playlist ID from a URL
   */
  extractPlaylistId(url: string): string | null {
    const match = url.match(/[?&]list=([^&]+)/);
    return match ? match[1] : null;
  }

  /**
   * Parse a YouTube URL to determine its type
   */
  parseUrl(url: string): {
    videoId: string | null;
    playlistId: string | null;
    isPlaylist: boolean;
  } {
    const videoId = extractVideoId(url);
    const playlistId = this.extractPlaylistId(url);

    return {
      videoId,
      playlistId,
      isPlaylist: playlistId !== null,
    };
  }

  /**
   * Extract video entries from any YouTube URL
   * For playlists: returns all videos in the playlist
   * For single videos: returns a "playlist" with 1 entry
   */
  async extract(
    url: string,
    options?: { maxVideos?: number }
  ): Promise<{ metadata: PlaylistMetadata; entries: PlaylistEntry[] }> {
    const { isPlaylist, playlistId } = this.parseUrl(url);

    if (isPlaylist && playlistId) {
      return this.extractPlaylist(url, options);
    } else {
      return this.extractSingleVideo(url);
    }
  }

  /**
   * Extract all videos from a playlist URL
   */
  private async extractPlaylist(
    url: string,
    options?: { maxVideos?: number }
  ): Promise<{ metadata: PlaylistMetadata; entries: PlaylistEntry[] }> {
    logger.debug(`Extracting playlist from: ${url}`);

    const { stdout } = await execAsync(
      `yt-dlp --flat-playlist --dump-json -J "${url}"`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer for large playlists
    );

    const raw = JSON.parse(stdout) as YtDlpPlaylistMetadata;

    const metadata: PlaylistMetadata = {
      playlistId: raw.id,
      title: raw.title,
      description: raw.description || "",
      channelName: raw.channel || "",
      videoCount: raw.playlist_count || raw.entries.length,
      url: raw.webpage_url,
    };

    let entries: PlaylistEntry[] = raw.entries.map((entry, index) => ({
      videoId: entry.id,
      title: entry.title,
      duration: entry.duration || 0,
      position: entry.playlist_index || index + 1,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
    }));

    // Apply maxVideos limit if specified
    if (options?.maxVideos && options.maxVideos > 0) {
      entries = entries.slice(0, options.maxVideos);
      logger.debug(`Limited to first ${options.maxVideos} videos`);
    }

    logger.debug(
      `Found ${entries.length} videos in playlist "${metadata.title}"`
    );

    return { metadata, entries };
  }

  /**
   * Create a "playlist" with a single video entry
   * This unified interface allows treating single videos the same as playlists
   */
  private async extractSingleVideo(
    url: string
  ): Promise<{ metadata: PlaylistMetadata; entries: PlaylistEntry[] }> {
    logger.debug(`Extracting single video from: ${url}`);

    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-download "${url}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const raw = JSON.parse(stdout) as YtDlpVideoMetadata;

    // Create a pseudo-playlist metadata for a single video
    const metadata: PlaylistMetadata = {
      playlistId: raw.id, // Use video ID as playlist ID
      title: raw.title,
      description: raw.description || "",
      channelName: raw.channel || "",
      videoCount: 1,
      url: raw.webpage_url,
    };

    const entries: PlaylistEntry[] = [
      {
        videoId: raw.id,
        title: raw.title,
        duration: raw.duration || 0,
        position: 1,
        url: raw.webpage_url,
      },
    ];

    return { metadata, entries };
  }
}

// Export singleton instance
export const playlistExtractor = new PlaylistExtractor();
