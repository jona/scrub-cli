import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptionSource,
} from "./ITranscriber.js";
import { LocalWhisperAdapter } from "./adapters/LocalWhisperAdapter.js";
import { FasterWhisperAdapter } from "./adapters/FasterWhisperAdapter.js";
import { OpenAIWhisperAdapter } from "./adapters/OpenAIWhisperAdapter.js";
import { DeepgramAdapter } from "./adapters/DeepgramAdapter.js";
import { YouTubeCaptionsAdapter } from "./adapters/YouTubeCaptionsAdapter.js";

/**
 * Factory for creating and managing transcription adapters
 * Implements priority ordering and automatic fallback logic
 */
export class TranscriberFactory {
  private adapters: Map<TranscriptionSource, ITranscriber> = new Map();
  private availabilityCache: Map<TranscriptionSource, boolean> = new Map();

  constructor() {
    // Initialize all adapters
    this.adapters.set("local-whisper", new LocalWhisperAdapter());
    this.adapters.set("faster-whisper", new FasterWhisperAdapter());
    this.adapters.set("openai", new OpenAIWhisperAdapter());
    this.adapters.set("deepgram", new DeepgramAdapter());
    this.adapters.set("youtube-captions", new YouTubeCaptionsAdapter());
  }

  /**
   * Set the video URL (needed for YouTube captions fallback)
   */
  setVideoUrl(url: string): void {
    const captionsAdapter = this.adapters.get(
      "youtube-captions"
    ) as YouTubeCaptionsAdapter;
    captionsAdapter?.setVideoUrl(url);
  }

  /**
   * Get a specific adapter by name
   */
  getAdapter(source: TranscriptionSource): ITranscriber | undefined {
    return this.adapters.get(source);
  }

  /**
   * Check if a specific adapter is available
   */
  async isAvailable(source: TranscriptionSource): Promise<boolean> {
    // Check cache first
    if (this.availabilityCache.has(source)) {
      return this.availabilityCache.get(source)!;
    }

    const adapter = this.adapters.get(source);
    if (!adapter) {
      return false;
    }

    const available = await adapter.isAvailable();
    this.availabilityCache.set(source, available);
    return available;
  }

  /**
   * Get all available adapters in priority order
   */
  async getAvailableAdapters(): Promise<
    Array<{ source: TranscriptionSource; adapter: ITranscriber }>
  > {
    const priority = config.getTranscription().priority;
    const available: Array<{
      source: TranscriptionSource;
      adapter: ITranscriber;
    }> = [];

    for (const source of priority) {
      if (await this.isAvailable(source)) {
        const adapter = this.adapters.get(source)!;
        available.push({ source, adapter });
      }
    }

    return available;
  }

  /**
   * Transcribe audio using the first available adapter
   * Automatically falls back to next adapter on failure
   */
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions & {
      preferredAdapter?: TranscriptionSource;
    }
  ): Promise<TranscriptionResult> {
    const priority = config.getTranscription().priority;
    const errors: Array<{ source: TranscriptionSource; error: Error }> = [];

    // If a specific adapter is preferred, try it first
    if (options?.preferredAdapter) {
      const adapter = this.adapters.get(options.preferredAdapter);
      if (adapter && (await this.isAvailable(options.preferredAdapter))) {
        try {
          logger.debug(`Trying preferred adapter: ${adapter.name}`);
          return await adapter.transcribe(audioPath, options);
        } catch (error) {
          errors.push({
            source: options.preferredAdapter,
            error: error as Error,
          });
          logger.warn(
            `Preferred adapter ${adapter.name} failed: ${(error as Error).message}`
          );
        }
      }
    }

    // Try adapters in priority order
    for (const source of priority) {
      // Skip if already tried as preferred
      if (source === options?.preferredAdapter) continue;

      const adapter = this.adapters.get(source);
      if (!adapter) continue;

      const available = await this.isAvailable(source);
      if (!available) {
        logger.debug(`Skipping ${adapter.name}: not available`);
        continue;
      }

      try {
        logger.debug(`Trying adapter: ${adapter.name}`);
        return await adapter.transcribe(audioPath, options);
      } catch (error) {
        errors.push({ source, error: error as Error });
        logger.warn(`${adapter.name} failed: ${(error as Error).message}`);
      }
    }

    // All adapters failed
    const errorSummary = errors
      .map((e) => `${e.source}: ${e.error.message}`)
      .join("\n  ");

    throw new Error(
      `All transcription adapters failed:\n  ${errorSummary}\n\n` +
        "Suggestions:\n" +
        "  - Install whisper.cpp for local transcription\n" +
        "  - Add apis.openai to ~/.scrub/config.json for OpenAI Whisper API\n" +
        "  - Ensure the video has captions for fallback"
    );
  }

  /**
   * Transcribe with YouTube captions as primary source
   * Useful when you want to prefer captions over audio transcription
   */
  async transcribeWithCaptions(
    videoUrl: string,
    audioPath?: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    this.setVideoUrl(videoUrl);

    // Try captions first
    const captionsAdapter = this.adapters.get("youtube-captions")!;
    try {
      logger.debug("Trying YouTube captions first");
      return await captionsAdapter.transcribe(videoUrl, options);
    } catch (error) {
      logger.debug(`YouTube captions failed: ${(error as Error).message}`);
    }

    // Fall back to audio transcription if captions unavailable
    if (audioPath) {
      return this.transcribe(audioPath, options);
    }

    throw new Error(
      "YouTube captions not available and no audio path provided for transcription"
    );
  }

  /**
   * Get diagnostic information about adapter availability
   */
  async getDiagnostics(): Promise<
    Array<{
      source: TranscriptionSource;
      name: string;
      available: boolean;
      requiresApiKey: boolean;
    }>
  > {
    const results = [];

    for (const [source, adapter] of this.adapters) {
      results.push({
        source,
        name: adapter.name,
        available: await this.isAvailable(source),
        requiresApiKey: adapter.requiresApiKey,
      });
    }

    return results;
  }

  /**
   * Clear the availability cache (useful if environment changes)
   */
  clearCache(): void {
    this.availabilityCache.clear();
  }
}

// Export singleton instance
export const transcriberFactory = new TranscriberFactory();
