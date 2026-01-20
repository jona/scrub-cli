import { YoutubeTranscript } from 'youtube-transcript';
import { logger } from '../../utils/logger.js';
import { extractVideoId } from '../../utils/helpers.js';
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
} from './ITranscriber.js';

/**
 * Adapter for fetching YouTube's built-in captions/subtitles
 * 
 * This is the fallback option - it uses YouTube's auto-generated
 * or manually added captions instead of transcribing the audio.
 * 
 * Pros: Fast, free, no dependencies
 * Cons: Not all videos have captions, quality varies
 */
export class YouTubeCaptionsAdapter implements ITranscriber {
  readonly name = 'YouTube Captions';
  readonly requiresApiKey = false;

  // Store the video URL for later use since this adapter
  // works with URLs, not audio files
  private videoUrl: string | null = null;

  /**
   * YouTube captions are always "available" as a fallback
   * The actual availability depends on the specific video
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Set the video URL for caption fetching
   * Call this before transcribe() when using this adapter
   */
  setVideoUrl(url: string): void {
    this.videoUrl = url;
  }

  /**
   * Fetch captions from YouTube
   * 
   * Note: The audioPath parameter is ignored for this adapter.
   * Instead, use setVideoUrl() to set the video URL first.
   */
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    // audioPath might actually be a URL if passed directly
    const url = this.videoUrl || audioPath;
    const videoId = extractVideoId(url);

    if (!videoId) {
      throw new Error(
        'No video URL set for YouTube captions. Call setVideoUrl() first or pass URL as audioPath.'
      );
    }

    const language = options?.language || 'en';

    logger.debug(`Fetching YouTube captions for video: ${videoId}`);

    try {
      // Fetch transcript from YouTube
      const transcript = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: language,
      });

      if (!transcript || transcript.length === 0) {
        throw new Error('No captions available for this video');
      }

      // Convert to our format
      return this.parseTranscript(transcript);
    } catch (error) {
      // Provide helpful error message
      const err = error as Error;
      if (err.message?.includes('disabled')) {
        throw new Error(
          'Captions are disabled for this video. Try using audio transcription instead.'
        );
      }
      if (err.message?.includes('not found') || err.message?.includes('unavailable')) {
        throw new Error(
          'No captions found for this video. The video may not have captions, ' +
          'or they may be in a different language.'
        );
      }
      throw error;
    }
  }

  /**
   * Parse YouTube transcript to our format
   */
  private parseTranscript(transcript: YouTubeTranscriptItem[]): TranscriptionResult {
    const segments: TranscriptSegment[] = transcript.map((item) => ({
      start: item.offset / 1000, // Convert ms to seconds
      end: (item.offset + item.duration) / 1000,
      text: this.cleanText(item.text),
    }));

    const fullText = segments.map((s) => s.text).join(' ');
    const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;

    // Detect language from content (rough heuristic)
    const language = this.detectLanguage(fullText);

    return {
      segments,
      fullText,
      language,
      duration,
      source: 'youtube-captions',
    };
  }

  /**
   * Clean caption text (remove HTML entities, extra whitespace, etc.)
   */
  private cleanText(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Simple language detection based on character ranges
   */
  private detectLanguage(text: string): string {
    // Check for common non-Latin scripts
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh'; // Chinese
    if (/[\u3040-\u30ff]/.test(text)) return 'ja'; // Japanese
    if (/[\uac00-\ud7af]/.test(text)) return 'ko'; // Korean
    if (/[\u0600-\u06ff]/.test(text)) return 'ar'; // Arabic
    if (/[\u0400-\u04ff]/.test(text)) return 'ru'; // Cyrillic (Russian)
    if (/[\u0900-\u097f]/.test(text)) return 'hi'; // Hindi

    // Default to English for Latin scripts
    return 'en';
  }
}

/**
 * YouTube transcript item from the library
 */
interface YouTubeTranscriptItem {
  text: string;
  duration: number;
  offset: number;
}
