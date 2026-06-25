/**
 * Represents a single segment of transcribed audio with timing information
 */
export interface TranscriptSegment {
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
  /** Transcribed text content */
  text: string;
  /** Confidence score (0-1) if available */
  confidence?: number;
}

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
 * Complete result from a transcription operation
 */
export interface TranscriptionResult {
  /** Individual timed segments */
  segments: TranscriptSegment[];
  /** Full concatenated transcript text */
  fullText: string;
  /** Detected or specified language code (e.g., 'en', 'es') */
  language: string;
  /** Total duration of the audio in seconds */
  duration: number;
  /** Which transcription method produced this result */
  source: TranscriptionSource;
}

/**
 * Options for transcription operations
 */
export interface TranscriptionOptions {
  /** Target language code for transcription */
  language?: string;
  /** Whisper model size for local transcription */
  model?: "tiny" | "base" | "small" | "medium" | "large";
  /** Enable word-level timestamps if supported */
  wordTimestamps?: boolean;
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
  isAvailable(): Promise<boolean>;

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
