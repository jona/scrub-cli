/**
 * transcribe — Primitive for transcribing audio files
 *
 * Delegates to TranscriberFactory for adapter selection and fallback.
 * Takes an audio file path, returns a TranscriptionResult.
 */

import { writeFileSync } from "fs";
import { transcriberFactory } from "../transcription/index.js";
import type {
  TranscriptionResult,
  TranscriptionSource,
} from "../transcription/ITranscriber.js";

export interface TranscribeOptions {
  /** Force a specific transcription adapter */
  adapter?: TranscriptionSource;
  /** Target language code */
  language?: string;
  /** Whisper model size */
  model?: "tiny" | "base" | "small" | "medium" | "large";
  /** Set the YouTube URL for captions fallback */
  youtubeUrl?: string;
  /** Also output a plain text file alongside JSON */
  outputText?: string;
  onProgress?: (message: string) => void;
}

/**
 * Transcribe an audio file
 */
export async function transcribe(
  audioPath: string,
  options?: TranscribeOptions
): Promise<TranscriptionResult> {
  options?.onProgress?.("Transcribing audio...");

  const result = await transcriberFactory.transcribe(audioPath, {
    preferredAdapter: options?.adapter,
    videoUrl: options?.youtubeUrl,
    language: options?.language,
    model: options?.model,
  });

  // Optionally write plain text file
  if (options?.outputText) {
    writeFileSync(options.outputText, result.fullText, "utf-8");
  }

  return result;
}

/**
 * Get diagnostic info about available transcribers
 */
export async function getTranscriberDiagnostics() {
  return transcriberFactory.getDiagnostics();
}
