export type {
  TranscriptSegment,
  TranscriptionResult,
} from "../../core/models.js";
import type { TranscriptionResult } from "../../core/models.js";

/**
 * Source identifier for the transcription method used
 */
export type TranscriptionSource =
  | "faster-whisper"
  | "local-whisper"
  | "openai"
  | "deepgram"
  | "youtube-captions";

/**
 * Options for transcription operations
 */
export interface TranscriptionOptions {
  /** Target language code for transcription */
  language?: string;
  /** Whisper model size for local transcription */
  model?: string;
  /** Enable word-level timestamps if supported */
  wordTimestamps?: boolean;
  videoUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Interface for all transcription adapters
 * Implements the adapter pattern for vendor-agnostic transcription
 */
export interface ITranscriber {
  /** Human-readable name of the transcription provider */
  readonly name: string;
  /** Whether this adapter requires an API key to function */
  readonly requiresApiKey: boolean;

  /**
   * Check if this transcriber is available for use
   * (e.g., checks for installed dependencies, valid API keys, etc.)
   */
  isAvailable(options?: TranscriptionOptions): Promise<boolean>;

  /**
   * Transcribe an audio file
   * @param audioPath - Path to the audio file to transcribe
   * @param options - Optional transcription settings
   * @returns Transcription result with segments and full text
   */
  transcribe(
    audioPath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult>;
}
