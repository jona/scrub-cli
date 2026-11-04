import {
  adapterEnvironment,
  type AdapterEnvironmentOptions,
} from "../environment.js";
import { createReadStream, statSync } from "fs";
import {
  DeepgramClient,
  DeepgramError,
  DeepgramTimeoutError,
  type ListenV1Response,
} from "@deepgram/sdk";
import { PipelineError, throwIfAborted } from "../../../core/errors.js";
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
} from "../ITranscriber.js";

/**
 * Adapter for Deepgram Speech-to-Text API
 *
 * Credentials or a client are supplied by the host environment.
 */
export class DeepgramAdapter implements ITranscriber {
  readonly name = "Deepgram API";
  constructor(private readonly environment: AdapterEnvironmentOptions) {}
  readonly requiresApiKey = true;

  private client: DeepgramClient | null = null;

  /**
   * Check if Deepgram API is available
   */
  async isAvailable(): Promise<boolean> {
    if (this.environment.deepgramClient) {
      this.client = this.environment.deepgramClient;
      return true;
    }
    const { config } = await adapterEnvironment(this.environment);
    const apiKey = config.getApiKey("deepgram");
    if (!apiKey) {
      return false;
    }

    // Initialize client
    this.client = new DeepgramClient({ apiKey, logging: { silent: true } });
    return true;
  }

  /**
   * Transcribe audio using Deepgram API
   */
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    throwIfAborted(options?.signal, "transcribe");
    const { config, logger } = await adapterEnvironment(this.environment);
    if (!this.client) {
      const available = await this.isAvailable();
      if (!available) {
        throw new Error(
          "Deepgram API key not configured. Add apis.deepgram to ~/.scrub/config.json."
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
    const audioStream = createReadStream(audioPath, {
      signal: options?.signal,
    });

    // Determine audio mimetype based on extension
    const mimetype = this.getMimeType(audioPath);

    // Call Deepgram API
    try {
      const result = await this.client!.listen.v1.media.transcribeFile(
        audioStream,
        {
          model: "nova-2",
          smart_format: true,
          punctuate: true,
          paragraphs: true,
          utterances: true,
          language: language !== "auto" ? language : undefined,
          detect_language: language === "auto",
        },
        {
          abortSignal: options?.signal,
          timeoutInSeconds:
            options?.timeoutMs === undefined
              ? undefined
              : options.timeoutMs / 1000,
          // The runtime owns retries; an upload stream cannot be replayed.
          maxRetries: 0,
          headers: { "Content-Type": mimetype },
        }
      );
      throwIfAborted(options?.signal, "transcribe");

      if (!result || !("results" in result)) {
        throw new Error("Deepgram returned empty result");
      }

      // Parse the response
      return this.parseResponse(result);
    } catch (error) {
      throwIfAborted(options?.signal, "transcribe");
      if (error instanceof DeepgramTimeoutError) {
        throw new PipelineError("timeout", "Deepgram transcription timed out", {
          stage: "transcribe",
          retryable: true,
          cause: error,
        });
      }
      if (error instanceof DeepgramError) {
        const status = error.statusCode;
        throw new PipelineError(
          status === 429 ? "rate_limited" : "processing_failed",
          "Deepgram transcription failed",
          {
            stage: "transcribe",
            retryable:
              status === 429 || (status !== undefined && status >= 500),
            cause: error,
          }
        );
      }
      throw error;
    } finally {
      audioStream.destroy();
    }
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = filePath.toLowerCase().split(".").pop();
    const mimeTypes: Record<string, string> = {
      wav: "audio/wav",
      mp3: "audio/mp3",
      m4a: "audio/m4a",
      flac: "audio/flac",
      ogg: "audio/ogg",
      webm: "audio/webm",
    };
    return mimeTypes[ext || "wav"] || "audio/wav";
  }

  /**
   * Parse Deepgram API response to our format
   */
  private parseResponse(result: ListenV1Response): TranscriptionResult {
    const channel = result.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];

    if (typeof alternative?.transcript !== "string") {
      throw new Error("No transcription results in Deepgram response");
    }

    // Use utterances for better segment boundaries if available
    const utterances = result.results?.utterances;
    let segments: TranscriptSegment[];

    if (utterances && utterances.length > 0) {
      segments = utterances.map((utt) => {
        if (
          typeof utt.transcript !== "string" ||
          typeof utt.start !== "number" ||
          typeof utt.end !== "number" ||
          !Number.isFinite(utt.start) ||
          !Number.isFinite(utt.end) ||
          utt.start < 0 ||
          utt.end < utt.start
        ) {
          throw new Error("Invalid utterance in Deepgram response");
        }
        return {
          start: utt.start,
          end: utt.end,
          text: utt.transcript.trim(),
          confidence: utt.confidence,
        };
      });
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
    const duration =
      result.metadata?.duration ||
      (segments.length > 0 ? segments[segments.length - 1].end : 0);
    const language =
      channel?.detected_language ||
      result.results?.channels?.[0]?.alternatives?.[0]?.languages?.[0] ||
      "en";

    return {
      segments,
      fullText,
      language,
      duration,
      source: "deepgram",
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
      if (
        typeof word.word !== "string" ||
        typeof word.start !== "number" ||
        typeof word.end !== "number" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end < word.start
      ) {
        throw new Error("Invalid word in Deepgram response");
      }
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
        currentSegment.text += " " + (word.punctuated_word || word.word);
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
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  confidence?: number;
}
