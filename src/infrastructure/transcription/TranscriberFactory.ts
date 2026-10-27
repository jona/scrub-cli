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
    private readonly environment: AdapterEnvironmentOptions,
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
}
