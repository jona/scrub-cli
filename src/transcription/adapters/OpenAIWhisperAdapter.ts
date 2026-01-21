import { createReadStream, statSync } from "fs";
import OpenAI from "openai";
import { config } from "../../infrastructure/Config.js";
import { logger } from "../../utils/logger.js";
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
} from "../ITranscriber.js";

/**
 * Adapter for OpenAI Whisper API
 *
 * Requires OPENAI_API_KEY environment variable
 * Pricing: ~$0.006 per minute of audio
 */
export class OpenAIWhisperAdapter implements ITranscriber {
  readonly name = "OpenAI Whisper API";
  readonly requiresApiKey = true;

  private client: OpenAI | null = null;

  /**
   * Check if OpenAI API is available
   */
  async isAvailable(): Promise<boolean> {
    const apiKey = config.getApiKey("openai");
    if (!apiKey) {
      return false;
    }

    // Initialize client
    this.client = new OpenAI({ apiKey });

    // Optionally validate the key with a simple call
    // For now, just check if key exists
    return true;
  }

  /**
   * Transcribe audio using OpenAI Whisper API
   */
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    if (!this.client) {
      const available = await this.isAvailable();
      if (!available) {
        throw new Error(
          "OpenAI API key not configured. Set OPENAI_API_KEY environment variable."
        );
      }
    }

    const transcriptionConfig = config.getTranscription();
    const language = options?.language || transcriptionConfig.language;

    // Check file size (OpenAI limit is 25MB)
    const stats = statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    if (fileSizeMB > 25) {
      throw new Error(
        `Audio file is ${fileSizeMB.toFixed(1)}MB, exceeds OpenAI's 25MB limit. ` +
          "Consider using a local transcription option or splitting the file."
      );
    }

    logger.debug(
      `Transcribing ${fileSizeMB.toFixed(1)}MB audio with OpenAI Whisper`
    );

    // Create file stream
    const file = createReadStream(audioPath);

    // Call OpenAI Whisper API with verbose JSON for timestamps
    const response = await this.client!.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: language !== "auto" ? language : undefined,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });

    // Parse the response
    return this.parseResponse(response);
  }

  /**
   * Parse OpenAI API response to our format
   */
  private parseResponse(
    response: OpenAI.Audio.Transcription
  ): TranscriptionResult {
    // The verbose_json format includes segments
    const verboseResponse = response as VerboseTranscriptionResponse;

    const segments: TranscriptSegment[] = (verboseResponse.segments || []).map(
      (seg) => ({
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
        confidence: seg.avg_logprob ? Math.exp(seg.avg_logprob) : undefined,
      })
    );

    // If no segments (shouldn't happen with verbose_json), create one from full text
    if (segments.length === 0 && verboseResponse.text) {
      segments.push({
        start: 0,
        end: verboseResponse.duration || 0,
        text: verboseResponse.text.trim(),
      });
    }

    const fullText =
      verboseResponse.text || segments.map((s) => s.text).join(" ");
    const duration =
      verboseResponse.duration ||
      (segments.length > 0 ? segments[segments.length - 1].end : 0);

    return {
      segments,
      fullText,
      language: verboseResponse.language || "en",
      duration,
      source: "openai",
    };
  }
}

/**
 * OpenAI verbose transcription response type
 */
interface VerboseTranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
  }>;
}
