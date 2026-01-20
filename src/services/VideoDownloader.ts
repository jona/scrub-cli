import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { config } from '../core/Config.js';
import { logger } from '../utils/logger.js';
import {
  execAsync,
  commandExists,
  extractVideoId,
  ensureDir,
  runCommand,
} from '../utils/helpers.js';
import type { VideoMetadata, DownloadResult } from '../types/index.js';

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

/**
 * Service for downloading videos and extracting audio using yt-dlp
 */
export class VideoDownloader {
  private cacheDir: string;

  constructor() {
    this.cacheDir = config.getCacheDir();
  }

  /**
   * Check if yt-dlp is installed
   */
  async isAvailable(): Promise<boolean> {
    return commandExists('yt-dlp');
  }

  /**
   * Check if ffmpeg is installed
   */
  async hasFfmpeg(): Promise<boolean> {
    return commandExists('ffmpeg');
  }

  /**
   * Download video and extract audio
   */
  async download(
    url: string,
    options?: {
      skipVideo?: boolean;
      maxResolution?: number;
      onProgress?: (message: string) => void;
    }
  ): Promise<DownloadResult> {
    // Validate yt-dlp is installed
    if (!(await this.isAvailable())) {
      throw new Error(
        'yt-dlp is not installed. Install with: brew install yt-dlp or pip install yt-dlp'
      );
    }

    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error(`Invalid YouTube URL: ${url}`);
    }

    // Create cache directory for this video
    const videoCacheDir = join(this.cacheDir, videoId);
    ensureDir(videoCacheDir);

    const audioPath = join(videoCacheDir, 'audio.wav');
    const videoPath = join(videoCacheDir, 'video.mp4');
    const metadataPath = join(videoCacheDir, 'metadata.json');

    // Check if already downloaded
    if (existsSync(metadataPath) && existsSync(audioPath)) {
      logger.debug('Using cached download');
      const metadata = JSON.parse(
        readFileSync(metadataPath, 'utf-8')
      ) as VideoMetadata;

      return {
        metadata,
        audioPath,
        videoPath: existsSync(videoPath) ? videoPath : '',
        cacheDir: videoCacheDir,
      };
    }

    // Fetch metadata first
    options?.onProgress?.('Fetching video metadata...');
    const metadata = await this.fetchMetadata(url);

    // Save metadata
    const { writeFileSync } = await import('fs');
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Download audio
    options?.onProgress?.('Downloading audio...');
    await this.downloadAudio(url, audioPath, options?.onProgress);

    // Download video if needed for visual analysis
    let finalVideoPath = '';
    if (!options?.skipVideo) {
      options?.onProgress?.('Downloading video...');
      finalVideoPath = await this.downloadVideo(
        url,
        videoPath,
        options?.maxResolution || 720,
        options?.onProgress
      );
    }

    return {
      metadata,
      audioPath,
      videoPath: finalVideoPath,
      cacheDir: videoCacheDir,
    };
  }

  /**
   * Fetch video metadata using yt-dlp
   */
  async fetchMetadata(url: string): Promise<VideoMetadata> {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-download "${url}"`,
      { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for large descriptions
    );

    const raw = JSON.parse(stdout) as YtDlpMetadata;

    return {
      videoId: raw.id,
      title: raw.title,
      description: raw.description || '',
      duration: raw.duration,
      thumbnailUrl: raw.thumbnail,
      channelName: raw.channel,
      uploadDate: this.formatUploadDate(raw.upload_date),
      url: raw.webpage_url,
    };
  }

  /**
   * Download and extract audio as WAV
   */
  private async downloadAudio(
    url: string,
    outputPath: string,
    onProgress?: (message: string) => void
  ): Promise<void> {
    const args = [
      '-x', // Extract audio
      '--audio-format', 'wav', // Convert to WAV for whisper compatibility
      '--audio-quality', '0', // Best quality
      '-o', outputPath, // Output path
      '--no-playlist', // Don't download playlists
      '--no-warnings', // Suppress warnings
      url,
    ];

    const result = await runCommand('yt-dlp', args, {
      onStderr: (data) => {
        // Parse progress from yt-dlp output
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

  /**
   * Download video at specified max resolution
   */
  private async downloadVideo(
    url: string,
    outputPath: string,
    maxHeight: number,
    onProgress?: (message: string) => void
  ): Promise<string> {
    const args = [
      '-f', `best[height<=${maxHeight}]/best`, // Best format up to max height
      '-o', outputPath,
      '--no-playlist',
      '--no-warnings',
      url,
    ];

    const result = await runCommand('yt-dlp', args, {
      onStderr: (data) => {
        const progressMatch = data.match(/(\d+\.?\d*)%/);
        if (progressMatch) {
          onProgress?.(`Downloading video: ${progressMatch[1]}%`);
        }
      },
    });

    if (result.code !== 0) {
      // Video download is optional, log but don't throw
      logger.warn('Video download failed, visual analysis will be skipped');
      return '';
    }

    return outputPath;
  }

  /**
   * Format yt-dlp date (YYYYMMDD) to readable format
   */
  private formatUploadDate(date: string): string {
    if (!date || date.length !== 8) return date;
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }

  /**
   * Get cached download if available
   */
  getCached(videoId: string): DownloadResult | null {
    const videoCacheDir = join(this.cacheDir, videoId);
    const metadataPath = join(videoCacheDir, 'metadata.json');
    const audioPath = join(videoCacheDir, 'audio.wav');

    if (!existsSync(metadataPath) || !existsSync(audioPath)) {
      return null;
    }

    const metadata = JSON.parse(
      readFileSync(metadataPath, 'utf-8')
    ) as VideoMetadata;

    const videoPath = join(videoCacheDir, 'video.mp4');

    return {
      metadata,
      audioPath,
      videoPath: existsSync(videoPath) ? videoPath : '',
      cacheDir: videoCacheDir,
    };
  }

  /**
   * Clean up cached files for a video
   */
  async cleanCache(videoId: string): Promise<void> {
    const videoCacheDir = join(this.cacheDir, videoId);
    if (existsSync(videoCacheDir)) {
      const { rm } = await import('fs/promises');
      await rm(videoCacheDir, { recursive: true });
    }
  }
}

// Export singleton instance
export const videoDownloader = new VideoDownloader();
