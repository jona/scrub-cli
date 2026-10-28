import {
  acquireMediaStage,
  transcribeAudioStage,
  extractFramesStage,
  buildPromptStage,
  transcriptContent,
  validateTranscript,
} from "./stages.js";
import { canonicalizeYouTubeVideo } from "../core/source.js";
import {
  PipelineError,
  asPipelineError,
  throwIfAborted,
} from "../core/errors.js";
import { assertInferenceReady } from "./model.js";
import { runModelInference } from "./inference.js";
import type { TranscriptionResult } from "../core/models.js";
import {
  PIPELINE_VERSION,
  type MediaSource,
  type PipelineSettings,
  type PipelineDependencies,
  type OperationContext,
  type RunRecord,
  type VideoResult,
  type ProcessingStats,
  type ArtifactRef,
} from "./contracts.js";
import {
  putJson,
  readArtifactJson,
  resultArtifacts,
  limitArtifactStorage,
} from "./artifact-io.js";

function sameArtifact(
  a: ArtifactRef | undefined,
  b: ArtifactRef | undefined
): boolean {
  return (
    (a === undefined && b === undefined) ||
    (a !== undefined &&
      b !== undefined &&
      a.size === b.size &&
      (a.digest ?? a.id) === (b.digest ?? b.id))
  );
}

export function pipelineCacheKey(
  source: MediaSource,
  settings: PipelineSettings
): string {
  const identity =
    source.kind === "youtube"
      ? canonicalizeYouTubeVideo(source.url)
      : (source.asset.digest ?? source.asset.id);
  return JSON.stringify([
    PIPELINE_VERSION,
    source.kind,
    identity,
    settings.skipVisuals,
    settings.sceneThreshold,
    settings.maxFrames,
    settings.minFrameInterval,
    settings.transcription.provider ?? "default",
    settings.transcription.model ?? "base",
    settings.transcription.language ?? "en",
    settings.transcription.wordTimestamps ?? false,
    settings.limits.maxArtifactBytes,
    settings.limits.maxSourceBytes,
    settings.limits.maxDurationSeconds,
    settings.limits.maxTranscriptCharacters,
    settings.inference ?? null,
  ]);
}

/** The same stage implementation runs in the foreground or inside a durable job. */
export async function runVideoPipeline(
  requestedSource: MediaSource,
  settings: PipelineSettings,
  dependencies: PipelineDependencies,
  context: OperationContext,
  options: { force?: boolean } = {}
): Promise<VideoResult> {
  throwIfAborted(context.signal);
  const source: MediaSource =
    requestedSource.kind === "youtube"
      ? { kind: "youtube", url: canonicalizeYouTubeVideo(requestedSource.url) }
      : requestedSource;
  const { runs } = dependencies;
  const artifacts = limitArtifactStorage(
    dependencies.artifacts,
    settings.limits.maxArtifactBytes,
    settings.limits.maxSourceBytes
  );
  const cacheKey = pipelineCacheKey(source, settings);
  const iso = () => new Date(context.now()).toISOString();
  const initial = await runs.get();
  if (
    !options.force &&
    initial?.cacheKey === cacheKey &&
    initial.status === "completed" &&
    initial.result
  ) {
    const available = await Promise.all(
      resultArtifacts(initial.result).map((ref) => artifacts.has(ref))
    );
    if (available.every(Boolean)) return initial.result;
  }
  const started = context.now();
  const initializedAt = iso();
  let record = await runs.update((current) => {
    const resumable = !options.force && current?.cacheKey === cacheKey;
    if (resumable && current.cancelRequested)
      throw new PipelineError("cancelled", "Processing was cancelled");
    return {
      revision: (current?.revision ?? 0) + 1,
      status: "running",
      source,
      settings,
      cacheKey,
      startedAt: resumable ? current.startedAt : initializedAt,
      updatedAt: initializedAt,
      stage: resumable ? current.stage : "queued",
      progress: 0,
      attempts: resumable ? current.attempts + 1 : 1,
      cancelRequested: false,
      checkpoints: resumable ? current.checkpoints : {},
    };
  });
  const stats: ProcessingStats = {
    downloadTime: 0,
    transcriptionTime: 0,
    frameExtractionTime: 0,
    promptTime: 0,
    totalTime: 0,
  };
  let stage = "download";
  const assertActive = async () => {
    throwIfAborted(context.signal);
    const current = await runs.get();
    if (current?.cancelRequested)
      throw new PipelineError("cancelled", "Processing was cancelled");
  };
  const announce = async (next: string, progress: number, message: string) => {
    await assertActive();
    stage = next;
    const at = iso();
    record = await runs.update((current) => {
      if (!current)
        throw new PipelineError("invalid_state", "Run record is missing");
      if (current.cancelRequested)
        throw new PipelineError("cancelled", "Processing was cancelled");
      return {
        ...current,
        revision: current.revision + 1,
        stage,
        progress,
        updatedAt: at,
      };
    });
    await context.emit({ runId: context.runId, stage, progress, message });
  };
  const saveCheckpoint = async (
    checkpoint: Partial<RunRecord["checkpoints"]>
  ) => {
    await assertActive();
    const at = iso();
    record = await runs.update((current) => {
      if (!current)
        throw new PipelineError("invalid_state", "Run record is missing");
      if (current.cancelRequested)
        throw new PipelineError("cancelled", "Processing was cancelled");
      return {
        ...current,
        revision: current.revision + 1,
        checkpoints: { ...current.checkpoints, ...checkpoint },
        updatedAt: at,
      };
    });
  };
  const resetInference = (
    keepVision = false
  ): RunRecord["checkpoints"]["inference"] => {
    const previous = record.checkpoints.inference;
    const visionPending = keepVision
      ? Object.entries(previous?.pending ?? {}).filter(([key]) =>
          key.startsWith("vision:")
        )
      : [];
    return previous
      ? {
          calls: previous.calls,
          steps: keepVision
            ? Object.fromEntries(
                Object.entries(previous.steps).filter(([key]) =>
                  key.startsWith("vision:")
                )
              )
            : {},
          ...(visionPending.length
            ? { pending: Object.fromEntries(visionPending) }
            : {}),
        }
      : undefined;
  };
  try {
    assertInferenceReady(
      settings.inference,
      dependencies.models,
      settings.skipVisuals
    );
    if (record.attempts > settings.limits.maxAttempts)
      throw new PipelineError(
        "attempt_limit",
        "Processing retry budget exhausted"
      );
    await announce("download", 10, "Fetching and preparing media...");
    let mark = context.now();
    let prepared = record.checkpoints.acquire;
    if (
      prepared &&
      !(
        (await artifacts.has(prepared.audio)) &&
        (!prepared.video || (await artifacts.has(prepared.video)))
      )
    )
      prepared = undefined;
    if (!prepared) {
      const previous = record.checkpoints.acquire;
      prepared = await acquireMediaStage(
        source,
        settings,
        dependencies,
        context
      );
      await saveCheckpoint({
        acquire: prepared,
        ...(!sameArtifact(previous?.audio, prepared.audio) ||
        !sameArtifact(previous?.video, prepared.video) ||
        JSON.stringify(previous?.metadata) !== JSON.stringify(prepared.metadata)
          ? { inference: resetInference() }
          : {}),
        ...(!sameArtifact(previous?.audio, prepared.audio)
          ? { transcribe: undefined }
          : {}),
        ...(!sameArtifact(previous?.video, prepared.video)
          ? { frames: undefined }
          : {}),
      });
    }
    stats.downloadTime = Math.max(0, context.now() - mark);
    const metadataArtifact = await putJson(
      artifacts,
      "source/metadata",
      prepared.metadata
    );

    await announce("transcribe", 35, "Transcribing audio...");
    mark = context.now();
    let transcriptCheckpoint = record.checkpoints.transcribe;
    if (
      transcriptCheckpoint &&
      !(
        (await artifacts.has(transcriptCheckpoint.transcript)) &&
        (await artifacts.has(transcriptCheckpoint.text))
      )
    )
      transcriptCheckpoint = undefined;
    let transcript: TranscriptionResult | undefined;
    if (transcriptCheckpoint) {
      try {
        transcript = await readArtifactJson<TranscriptionResult>(
          artifacts,
          transcriptCheckpoint.transcript,
          settings.limits.maxArtifactBytes
        );
        validateTranscript(transcript, settings);
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(
            error instanceof PipelineError &&
            (error.code === "invalid_transcript" ||
              error.code === "artifact_missing" ||
              (error.code === "storage_error" && !error.retryable))
          )
        )
          throw error;
        transcriptCheckpoint = undefined;
        transcript = undefined;
      }
    }
    if (!transcriptCheckpoint || !transcript) {
      const generated = await transcribeAudioStage(
        { audio: prepared.audio, source },
        settings,
        { ...dependencies, artifacts },
        context
      );
      transcript = generated.value;
      transcriptCheckpoint = {
        transcript: generated.transcript,
        text: generated.text,
      };
      await saveCheckpoint({
        transcribe: transcriptCheckpoint,
        ...(!sameArtifact(
          record.checkpoints.transcribe?.transcript,
          transcriptCheckpoint.transcript
        )
          ? { inference: resetInference(true) }
          : {}),
      });
    }
    stats.transcriptionTime = Math.max(0, context.now() - mark);

    await announce(
      "extract-frames",
      65,
      settings.skipVisuals
        ? "Frame extraction disabled"
        : "Extracting key frames..."
    );
    mark = context.now();
    let frameCheckpoint = record.checkpoints.frames;
    if (
      frameCheckpoint &&
      (frameCheckpoint.frames.some(
        (frame) =>
          !Number.isFinite(frame.timestamp) ||
          frame.timestamp < 0 ||
          (prepared.metadata.duration > 0 &&
            frame.timestamp > prepared.metadata.duration)
      ) ||
        !(
          (await artifacts.has(frameCheckpoint.manifest)) &&
          (
            await Promise.all(
              frameCheckpoint.frames.map((f) => artifacts.has(f.artifact))
            )
          ).every(Boolean)
        ))
    )
      frameCheckpoint = undefined;
    if (!frameCheckpoint) {
      frameCheckpoint = await extractFramesStage(
        prepared.video,
        settings,
        { ...dependencies, artifacts },
        context,
        prepared.metadata.duration
      );
      const { frames } = frameCheckpoint;
      const previousFrames = record.checkpoints.frames?.frames;
      const unchanged =
        previousFrames?.length === frames.length &&
        frames.every(
          (frame, index) =>
            frame.timestamp === previousFrames[index].timestamp &&
            sameArtifact(frame.artifact, previousFrames[index].artifact)
        );
      await saveCheckpoint({
        frames: frameCheckpoint,
        ...(!unchanged ? { inference: resetInference(true) } : {}),
      });
    }
    stats.frameExtractionTime = Math.max(0, context.now() - mark);

    let prompt: ArtifactRef;
    let schema: ArtifactRef;
    let inference: VideoResult["inference"];
    if (settings.inference?.mode === "full") {
      if (
        !settings.skipVisuals &&
        (!prepared.video || frameCheckpoint.frames.length === 0)
      )
        throw new PipelineError(
          "capability_unavailable",
          "Vision requires sampled video frames; select audio-only processing explicitly to skip visuals"
        );
      const generated = await runModelInference({
        settings: settings.inference,
        processingSettings: settings,
        models: dependencies.models!,
        artifacts,
        metadata: prepared.metadata,
        transcript,
        frames: frameCheckpoint.frames,
        context,
        checkpoint: record.checkpoints.inference,
        save: (checkpoint) => saveCheckpoint({ inference: checkpoint }),
        announce,
      });
      ({ prompt, schema, inference } = generated);
      stats.visionTime = generated.visionTime;
      stats.summarizationTime = generated.summarizationTime;
      stats.renderTime = generated.renderTime;
    } else {
      await announce("prompt", 85, "Assembling summary prompt...");
      mark = context.now();
      ({ prompt, schema } = await buildPromptStage(
        { metadata: prepared.metadata, content: transcriptContent(transcript) },
        { artifacts },
        context,
        settings.limits.maxTranscriptCharacters
      ));
      stats.promptTime = Math.max(0, context.now() - mark);
    }
    stats.totalTime = Math.max(0, context.now() - started);
    await assertActive();
    const result: VideoResult = {
      mode: settings.inference?.mode ?? "preprocess",
      ...(inference ? { inference } : {}),
      metadata: prepared.metadata,
      metadataArtifact,
      transcript: transcriptCheckpoint.transcript,
      transcriptText: transcriptCheckpoint.text,
      audio: prepared.audio,
      ...(prepared.video ? { video: prepared.video } : {}),
      frames: frameCheckpoint.frames,
      framesManifest: frameCheckpoint.manifest,
      prompt,
      schema,
      stats,
      cacheKey,
      completedAt: iso(),
      warnings: prepared.warnings ?? [],
    };
    // Required outputs exist before publishing the durable completion record.
    if (
      !(
        await Promise.all(
          resultArtifacts(result).map((ref) => artifacts.has(ref))
        )
      ).every(Boolean)
    )
      throw new PipelineError(
        "artifact_missing",
        "Required output was not published",
        { retryable: true }
      );
    record = await runs.update((current) => {
      if (!current || current.cancelRequested)
        throw new PipelineError("cancelled", "Processing was cancelled");
      return {
        ...current,
        revision: current.revision + 1,
        status: "completed",
        stage: "completed",
        progress: 100,
        updatedAt: result.completedAt,
        result,
      };
    });
    // A disconnected observer cannot undo an already committed result.
    try {
      await context.emit({
        runId: context.runId,
        stage: "completed",
        progress: 100,
        message: "Processing completed",
      });
    } catch {
      /* Completion is durable. */
    }
    return result;
  } catch (error) {
    // Hosts interrupt attempts for retryable shutdown, lease loss or deadlines.
    // Native adapters may reduce every abort to "cancelled", so retain the
    // typed host reason while reserving cancellation for an actual user stop.
    let failure =
      context.signal.aborted && context.signal.reason instanceof PipelineError
        ? context.signal.reason
        : context.signal.aborted
          ? new PipelineError("cancelled", "Processing cancelled", { stage })
          : asPipelineError(error, { stage });
    const at = iso();
    await runs.update((current) => {
      if (!current) throw failure;
      if (current.cancelRequested)
        failure = new PipelineError("cancelled", "Processing cancelled", {
          stage,
        });
      const cancelled = failure.code === "cancelled";
      return {
        ...current,
        revision: current.revision + 1,
        status: cancelled ? "cancelled" : "failed",
        stage,
        updatedAt: at,
        failure: {
          code: cancelled ? "cancelled" : failure.code,
          message: failure.message,
          stage,
          retryable: cancelled ? false : failure.retryable,
        },
      };
    });
    throw failure;
  }
}
