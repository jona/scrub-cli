import { createReadStream, statSync } from 'fs';
import { createClient, DeepgramClient } from '@deepgram/sdk';
import { config } from '../../core/Config.js';
import { logger } from '../../utils/logger.js';
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
} from './ITranscriber.js';

/**
 * Adapter for Deepgram Speech-to-Text API
 * 
 * Requires DEEPGRAM_API_KEY environment variable
 * Known for excellent accuracy and fast processing
 */
export class DeepgramAdapter implements ITranscriber {
  readonly name = 'Deepgram API';
  readonly requiresApiKey = true;

  private client: DeepgramClient | null = null;

  /**
   * Check if Deepgram API is available
   */
  async isAvailable(): Promise<boolean> {
    const apiKey = config.getApiKey('deepgram');
    if (!apiKey) {
      return false;
    }

    // Initialize client
    this.client = createClient(apiKey);
    return true;
  }

  /**
   * Transcribe audio using Deepgram API
   */
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    if (!this.client) {
      const available = await this.isAvailable();
      if (!available) {
        throw new Error(
          'Deepgram API key not configured. Set DEEPGRAM_API_KEY environment variable.'
        );
      }
    }

    const transcriptionConfig = config.getTranscription();
    const language = options?.language || transcriptionConfig.language;

    // Get file info
    const stats = statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    logger.debug(`Transcribing ${fileSizeMB.toFixed(1)}MB audio with Deepgram`);

    // Create file stream
    const audioStream = createReadStream(audioPath);

    // Determine audio mimetype based on extension
    const mimetype = this.getMimeType(audioPath);

    // Call Deepgram API
    const { result, error } = await this.client!.listen.prerecorded.transcribeFile(
      audioStream,
      {
        model: 'nova-2', // Latest and most accurate model
        smart_format: true,
        punctuate: true,
        paragraphs: true,
        utterances: true,
        language: language !== 'auto' ? language : undefined,
        detect_language: language === 'auto',
        mimetype,
      }
    );

    if (error) {
      throw new Error(`Deepgram transcription failed: ${error.message}`);
    }

    if (!result) {
      throw new Error('Deepgram returned empty result');
    }

    // Parse the response
    return this.parseResponse(result);
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = filePath.toLowerCase().split('.').pop();
    const mimeTypes: Record<string, string> = {
      wav: 'audio/wav',
      mp3: 'audio/mp3',
      m4a: 'audio/m4a',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      webm: 'audio/webm',
    };
    return mimeTypes[ext || 'wav'] || 'audio/wav';
  }

  /**
   * Parse Deepgram API response to our format
   */
  private parseResponse(result: DeepgramResult): TranscriptionResult {
    const channel = result.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];

    if (!alternative) {
      throw new Error('No transcription results in Deepgram response');
    }

    // Use utterances for better segment boundaries if available
    const utterances = result.results?.utterances;
    let segments: TranscriptSegment[];

    if (utterances && utterances.length > 0) {
      segments = utterances.map((utt) => ({
        start: utt.start,
        end: utt.end,
        text: utt.transcript.trim(),
        confidence: utt.confidence,
      }));
    } else if (alternative.words && alternative.words.length > 0) {
      // Fall back to word-level timestamps, grouped into sentences
      segments = this.groupWordsIntoSegments(alternative.words);
    } else {
      // Last resort: single segment with full text
      segments = [
        {
          start: 0,
          end: result.metadata?.duration || 0,
          text: alternative.transcript.trim(),
          confidence: alternative.confidence,
        },
      ];
    }

    const fullText = alternative.transcript.trim();
    const duration = result.metadata?.duration || 
      (segments.length > 0 ? segments[segments.length - 1].end : 0);
    const language = channel?.detected_language || 
      result.results?.channels?.[0]?.alternatives?.[0]?.languages?.[0] || 
      'en';

    return {
      segments,
      fullText,
      language,
      duration,
      source: 'deepgram',
    };
  }

  /**
   * Group words into sentence-like segments
   */
  private groupWordsIntoSegments(words: DeepgramWord[]): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    let currentSegment: TranscriptSegment | null = null;
    const maxGap = 1.5; // Max seconds between words before starting new segment
    const maxDuration = 30; // Max segment duration

    for (const word of words) {
      const shouldStartNew =
        !currentSegment ||
        word.start - currentSegment.end > maxGap ||
        word.end - currentSegment.start > maxDuration ||
        word.punctuated_word?.match(/[.!?]$/);

      if (shouldStartNew) {
        if (currentSegment) {
          segments.push(currentSegment);
        }
        currentSegment = {
          start: word.start,
          end: word.end,
          text: word.punctuated_word || word.word,
          confidence: word.confidence,
        };
      } else if (currentSegment) {
        currentSegment.end = word.end;
        currentSegment.text += ' ' + (word.punctuated_word || word.word);
        if (word.confidence && currentSegment.confidence) {
          currentSegment.confidence = 
            (currentSegment.confidence + word.confidence) / 2;
        }
      }
    }

    if (currentSegment) {
      segments.push(currentSegment);
    }

    return segments;
  }
}

/**
 * Deepgram response types
 */
interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
}

interface DeepgramResult {
  metadata?: {
    duration?: number;
  };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript: string;
        confidence: number;
        words?: DeepgramWord[];
        languages?: string[];
      }>;
    }>;
    utterances?: Array<{
      start: number;
      end: number;
      transcript: string;
      confidence: number;
    }>;
  };
}
