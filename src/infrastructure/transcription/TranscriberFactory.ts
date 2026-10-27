import {
  adapterEnvironment,
  type AdapterEnvironmentOptions,
} from "./environment.js";
import { PipelineError, throwIfAborted } from "../../core/errors.js";
import type {
  ITranscriber,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionSource,
} from "./ITranscriber.js";
import { LocalWhisperAdapter } from "./adapters/LocalWhisperAdapter.js";
import { FasterWhisperAdapter } from "./adapters/FasterWhisperAdapter.js";
import { OpenAIWhisperAdapter } from "./adapters/OpenAIWhisperAdapter.js";
import { DeepgramAdapter } from "./adapters/DeepgramAdapter.js";
import { YouTubeCaptionsAdapter } from "./adapters/YouTubeCaptionsAdapter.js";

/** Per-operation adapter selection; source identity is request data, never mutable state. */
export class TranscriberFactory {
  private readonly adapters: Map<TranscriptionSource, ITranscriber>;
  constructor(
    private readonly environment: AdapterEnvironmentOptions = {},
    overrides: Partial<Record<TranscriptionSource, ITranscriber>> = {}
  ) {
    this.adapters = new Map<TranscriptionSource, ITranscriber>([
      [
        "local-whisper",
        overrides["local-whisper"] ?? new LocalWhisperAdapter(environment),
      ],
      [
        "faster-whisper",
        overrides["faster-whisper"] ?? new FasterWhisperAdapter(environment),
      ],
      ["openai", overrides.openai ?? new OpenAIWhisperAdapter(environment)],
      ["deepgram", overrides.deepgram ?? new DeepgramAdapter(environment)],
      [
        "youtube-captions",
        overrides["youtube-captions"] ??
          new YouTubeCaptionsAdapter(environment),
      ],
    ]);
  }
  getAdapter(source: TranscriptionSource) {
    return this.adapters.get(source);
  }
  async isAvailable(source: TranscriptionSource): Promise<boolean> {
    return (await this.adapters.get(source)?.isAvailable()) ?? false;
  }
  async getAvailableAdapters() {
    const { config } = await adapterEnvironment(this.environment);
    const available: Array<{
      source: TranscriptionSource;
      adapter: ITranscriber;
    }> = [];
    for (const name of config.getTranscription().priority) {
      const source = name as TranscriptionSource;
      const adapter = this.adapters.get(source);
      if (adapter && (await adapter.isAvailable()))
        available.push({ source, adapter });
    }
    return available;
  }
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions & { preferredAdapter?: TranscriptionSource }
  ): Promise<TranscriptionResult> {
    const { config, logger } = await adapterEnvironment(this.environment);
    const priority = options?.preferredAdapter
      ? [options.preferredAdapter]
      : config.getTranscription().priority;
    const errors: unknown[] = [];
    for (const name of priority) {
      throwIfAborted(options?.signal, "transcribe");
      const adapter = this.adapters.get(name as TranscriptionSource);
      if (!adapter || (name === "youtube-captions" && !options?.videoUrl))
        continue;
      try {
        if (!(await adapter.isAvailable(options))) continue;
        return await adapter.transcribe(audioPath, options);
      } catch (error) {
        if (
          error instanceof PipelineError &&
          ["cancelled", "timeout", "resource_limit"].includes(error.code)
        )
          throw error;
        throwIfAborted(options?.signal, "transcribe");
        errors.push(error);
        logger.warn(`Transcription adapter ${name} failed`);
      }
    }
    throw new PipelineError(
      "capability_unavailable",
      "No configured transcription adapter could process this media",
      {
        stage: "transcribe",
        cause: errors,
        retryable: errors.some((error) => {
          if (error instanceof PipelineError) return error.retryable;
          const details = error as { status?: number; code?: string };
          return (
            details?.status === 429 ||
            (typeof details?.status === "number" && details.status >= 500) ||
            ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(
              details?.code ?? ""
            )
          );
        }),
      }
    );
  }
  async transcribeWithCaptions(
    videoUrl: string,
    audioPath?: string,
    options?: TranscriptionOptions
  ) {
    const captions = this.adapters.get("youtube-captions")!;
    try {
      return await captions.transcribe("", { ...options, videoUrl });
    } catch (error) {
      throwIfAborted(options?.signal);
      if (audioPath)
        return this.transcribe(audioPath, { ...options, videoUrl });
      throw error;
    }
  }
  async getDiagnostics() {
    const result = [];
    for (const [source, adapter] of this.adapters)
      result.push({
        source,
        name: adapter.name,
        available: await adapter.isAvailable(),
        requiresApiKey: adapter.requiresApiKey,
      });
    return result;
  }
  clearCache() {
    /* Availability is deliberately re-evaluated per operation. */
  }
}

/** Legacy facade creates a fresh factory per call and has no import-time host effects. */
export const transcriberFactory = {
  transcribe: (...args: Parameters<TranscriberFactory["transcribe"]>) =>
    new TranscriberFactory().transcribe(...args),
  transcribeWithCaptions: (
    ...args: Parameters<TranscriberFactory["transcribeWithCaptions"]>
  ) => new TranscriberFactory().transcribeWithCaptions(...args),
  getDiagnostics: () => new TranscriberFactory().getDiagnostics(),
  getAvailableAdapters: () => new TranscriberFactory().getAvailableAdapters(),
  isAvailable: (source: TranscriptionSource) =>
    new TranscriberFactory().isAvailable(source),
  getAdapter: (source: TranscriptionSource) =>
    new TranscriberFactory().getAdapter(source),
  clearCache() {},
};
