import { resolve, join } from "node:path";
import type {
  ArtifactStorage,
  MediaSource,
  OperationContext,
  PipelineSettings,
  Transcriber,
} from "../../application/contracts.js";
import type { TranscriptionResult } from "../../core/models.js";
import { PipelineError, throwIfAborted } from "../../core/errors.js";
import { TranscriberFactory } from "../transcription/TranscriberFactory.js";
import type {
  ITranscriber,
  TranscriptionSource,
} from "../transcription/ITranscriber.js";
import type { TranscriptionConfiguration } from "../transcription/environment.js";
import type { NativeRuntimeOptions } from "./runtime.js";
import { inWorkspace, materialize } from "./staging.js";

export class NodeTranscriber implements Transcriber {
  constructor(
    private readonly artifacts: ArtifactStorage,
    private readonly runtime: NativeRuntimeOptions,
    private readonly overrides: Partial<
      Record<TranscriptionSource, ITranscriber>
    > = {}
  ) {}
  async transcribe(
    request: {
      audio: import("../../application/contracts.js").ArtifactRef;
      source: MediaSource;
    },
    settings: PipelineSettings,
    context: OperationContext
  ): Promise<TranscriptionResult> {
    const deadline = AbortSignal.timeout(settings.limits.stageTimeoutMs);
    const signal = AbortSignal.any([context.signal, deadline]);
    const scoped = { ...context, signal };
    try {
      return await inWorkspace(
        this.runtime.stagingRoot,
        scoped,
        async (directory) => {
          const audioPath = join(directory, "audio.wav");
          await materialize(
            this.artifacts,
            request.audio,
            audioPath,
            settings.limits.maxArtifactBytes,
            scoped
          );
          const priority = settings.transcription.provider
            ? [settings.transcription.provider]
            : (this.runtime.providers ?? [
                "faster-whisper",
                "local-whisper",
                "openai",
                "deepgram",
                "youtube-captions",
              ]);
          const configuration: TranscriptionConfiguration = {
            getTranscription: () => ({
              priority,
              whisperModel: settings.transcription.model ?? "base",
              language: settings.transcription.language ?? "en",
            }),
            getLocalWhisper: () => ({
              binaryPath: this.runtime.whisperBinaryPath,
              modelsPath: this.runtime.whisperModelsPath,
            }),
            getApiKey: (service) =>
              service === "openai"
                ? this.runtime.openaiApiKey
                : this.runtime.deepgramApiKey,
            getCacheDir: () => directory,
            resolvePath: (path) => resolve(path),
          };
          const factory = new TranscriberFactory(
            {
              config: configuration,
              runtime: this.runtime,
              logger: this.runtime.logger,
              openaiClient: this.runtime.openaiClient,
              deepgramClient: this.runtime.deepgramClient,
            },
            this.overrides
          );
          const result = await factory.transcribe(audioPath, {
            preferredAdapter: settings.transcription.provider as
              | TranscriptionSource
              | undefined,
            model: settings.transcription.model,
            language: settings.transcription.language,
            wordTimestamps: settings.transcription.wordTimestamps,
            videoUrl:
              request.source.kind === "youtube"
                ? request.source.url
                : undefined,
            signal,
            timeoutMs: settings.limits.stageTimeoutMs,
            maxOutputBytes: Math.max(
              1024 * 1024,
              settings.limits.maxTranscriptCharacters * 8
            ),
          });
          throwIfAborted(signal, "transcribe");
          if (
            !result ||
            typeof result.fullText !== "string" ||
            !Array.isArray(result.segments) ||
            !Number.isFinite(result.duration) ||
            result.duration < 0
          )
            throw new PipelineError(
              "processing_failed",
              "Transcription provider returned an invalid result"
            );
          if (
            result.fullText.length > settings.limits.maxTranscriptCharacters ||
            result.segments.length > settings.limits.maxTranscriptCharacters ||
            result.duration > settings.limits.maxDurationSeconds
          )
            throw new PipelineError(
              "resource_limit",
              "Transcript exceeds the configured limit"
            );
          let characters = 0;
          for (const segment of result.segments) {
            if (
              typeof segment.text !== "string" ||
              !Number.isFinite(segment.start) ||
              !Number.isFinite(segment.end) ||
              segment.start < 0 ||
              segment.end < segment.start ||
              segment.end > settings.limits.maxDurationSeconds
            )
              throw new PipelineError(
                "processing_failed",
                "Transcription provider returned invalid segments"
              );
            characters += segment.text.length;
            if (characters > settings.limits.maxTranscriptCharacters)
              throw new PipelineError(
                "resource_limit",
                "Transcript segments exceed the configured limit"
              );
          }
          return result;
        }
      );
    } catch (error) {
      if (deadline.aborted && !context.signal.aborted)
        throw new PipelineError("timeout", "Transcription timed out", {
          stage: "transcribe",
          retryable: true,
          cause: error,
        });
      throwIfAborted(context.signal, "transcribe");
      throw error;
    }
  }
}
