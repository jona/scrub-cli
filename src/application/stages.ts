import type {
  MediaMetadata,
  SummaryResult,
  TranscriptionResult,
  VisualAnalysis,
} from "../core/models.js";
import { metadataSchema, visualAnalysisSchema } from "../core/artifacts.js";
import { parseSummaryResponse } from "../core/inference.js";
import {
  buildSummaryPrompt,
  renderSummaryMarkdown,
  SUMMARY_SCHEMA,
} from "../core/summary-template.js";
import { formatTimestamp } from "../core/format.js";
import { PipelineError, throwIfAborted } from "../core/errors.js";
import type {
  ArtifactRef,
  ArtifactStorage,
  FrameArtifact,
  MediaProcessor,
  MediaSource,
  OperationContext,
  PipelineSettings,
  PreparedMedia,
  Transcriber,
} from "./contracts.js";
import { limitArtifactStorage, putJson } from "./artifact-io.js";
import { resolveSettings } from "./settings.js";

function assertArtifactSize(ref: ArtifactRef, maximum: number): void {
  if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > maximum)
    throw new PipelineError(
      "resource_limit",
      "Artifact exceeds the processing byte limit"
    );
}

export function validateTranscript(
  value: unknown,
  settings: Pick<PipelineSettings, "limits">
): asserts value is TranscriptionResult {
  const transcript = value as TranscriptionResult | null;
  if (
    !transcript ||
    typeof transcript.fullText !== "string" ||
    transcript.fullText.length > settings.limits.maxTranscriptCharacters ||
    !Array.isArray(transcript.segments) ||
    transcript.segments.length > 100_000 ||
    !Number.isFinite(transcript.duration) ||
    transcript.duration < 0 ||
    transcript.duration > settings.limits.maxDurationSeconds ||
    transcript.segments.some(
      (segment) =>
        !segment ||
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.start < 0 ||
        segment.end < segment.start ||
        segment.end > settings.limits.maxDurationSeconds ||
        typeof segment.text !== "string"
    ) ||
    transcript.segments.reduce(
      (total, segment) => total + segment.text.length,
      0
    ) > settings.limits.maxTranscriptCharacters
  )
    throw new PipelineError(
      "invalid_transcript",
      "Transcription output is invalid or exceeds processing limits"
    );
}

export function transcriptContent(transcript: TranscriptionResult): string {
  return transcript.segments.length
    ? transcript.segments
        .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
        .join("\n")
    : transcript.fullText;
}

export async function acquireMediaStage(
  source: MediaSource,
  settings: PipelineSettings,
  dependencies: { media: MediaProcessor },
  context: OperationContext
): Promise<PreparedMedia> {
  throwIfAborted(context.signal);
  if (source.kind === "asset")
    assertArtifactSize(source.asset, settings.limits.maxSourceBytes);
  const prepared = await dependencies.media.acquire(source, settings, context);
  throwIfAborted(context.signal);
  if (
    !Number.isFinite(prepared.metadata.duration) ||
    prepared.metadata.duration < 0 ||
    prepared.metadata.duration > settings.limits.maxDurationSeconds
  )
    throw new PipelineError(
      "resource_limit",
      "Media duration exceeds the processing limit"
    );
  assertArtifactSize(
    prepared.audio,
    Math.min(settings.limits.maxSourceBytes, settings.limits.maxArtifactBytes)
  );
  if (prepared.video)
    assertArtifactSize(prepared.video, settings.limits.maxSourceBytes);
  const metadata = metadataSchema.safeParse(prepared.metadata);
  if (!metadata.success)
    throw new PipelineError("invalid_input", "Media metadata is invalid");
  return { ...prepared, metadata: metadata.data };
}

export async function transcribeAudioStage(
  request: { audio: ArtifactRef; source: MediaSource },
  settings: PipelineSettings,
  dependencies: { artifacts: ArtifactStorage; transcriber: Transcriber },
  context: OperationContext
): Promise<{
  value: TranscriptionResult;
  transcript: ArtifactRef;
  text: ArtifactRef;
}> {
  throwIfAborted(context.signal);
  assertArtifactSize(request.audio, settings.limits.maxArtifactBytes);
  const value = await dependencies.transcriber.transcribe(
    request,
    settings,
    context
  );
  throwIfAborted(context.signal);
  validateTranscript(value, settings);
  const artifacts = limitArtifactStorage(
    dependencies.artifacts,
    settings.limits.maxArtifactBytes
  );
  const transcript = await putJson(artifacts, "transcription/json", value);
  const text = await artifacts.put(
    "transcription/txt",
    new TextEncoder().encode(value.fullText),
    "text/plain; charset=utf-8"
  );
  throwIfAborted(context.signal);
  return { value, transcript, text };
}

export async function extractFramesStage(
  video: ArtifactRef | undefined,
  settings: PipelineSettings,
  dependencies: { artifacts: ArtifactStorage; media: MediaProcessor },
  context: OperationContext
): Promise<{ frames: FrameArtifact[]; manifest: ArtifactRef }> {
  throwIfAborted(context.signal);
  if (video) assertArtifactSize(video, settings.limits.maxSourceBytes);
  const frames =
    !settings.skipVisuals && video
      ? await dependencies.media.extractFrames(video, settings, context)
      : [];
  throwIfAborted(context.signal);
  if (frames.length > settings.maxFrames)
    throw new PipelineError(
      "resource_limit",
      "Frame output exceeds configured limit"
    );
  for (const frame of frames) {
    if (
      !Number.isFinite(frame.timestamp) ||
      frame.timestamp < 0 ||
      frame.timestamp > settings.limits.maxDurationSeconds ||
      (frame.score !== undefined && !Number.isFinite(frame.score))
    )
      throw new PipelineError("processing_failed", "Frame output is invalid");
    assertArtifactSize(frame.artifact, settings.limits.maxArtifactBytes);
  }
  const artifacts = limitArtifactStorage(
    dependencies.artifacts,
    settings.limits.maxArtifactBytes
  );
  return { frames, manifest: await putJson(artifacts, "frames/json", frames) };
}

export async function publishPromptStage(
  prompt: string,
  dependencies: { artifacts: ArtifactStorage },
  context: OperationContext
): Promise<{ prompt: ArtifactRef; schema: ArtifactRef }> {
  throwIfAborted(context.signal);
  const artifact = await dependencies.artifacts.put(
    "prompt/summary",
    new TextEncoder().encode(prompt),
    "text/markdown; charset=utf-8"
  );
  const schema = await putJson(
    dependencies.artifacts,
    "prompt/schema",
    SUMMARY_SCHEMA
  );
  throwIfAborted(context.signal);
  return { prompt: artifact, schema };
}

export async function buildPromptStage(
  input: {
    metadata: MediaMetadata;
    content: string;
    visuals?: VisualAnalysis[];
  },
  dependencies: { artifacts: ArtifactStorage },
  context: OperationContext,
  maximumCharacters = 5_000_000
): Promise<{ prompt: ArtifactRef; schema: ArtifactRef }> {
  throwIfAborted(context.signal);
  const metadata = metadataSchema.safeParse(input.metadata);
  const visuals = visualAnalysisSchema
    .array()
    .max(100)
    .safeParse(input.visuals ?? []);
  if (
    !metadata.success ||
    !visuals.success ||
    typeof input.content !== "string" ||
    input.content.length > maximumCharacters
  )
    throw new PipelineError("invalid_input", "Invalid prompt stage input");
  return publishPromptStage(
    buildSummaryPrompt(metadata.data, input.content, visuals.data),
    dependencies,
    context
  );
}

export function validateSummaryForMetadata(
  value: unknown,
  metadata: MediaMetadata
): SummaryResult {
  const summary = parseSummaryResponse(value, metadata);
  const times = [
    ...summary.sections.flatMap((section) => [
      section.startTime,
      section.endTime,
      ...(section.codeSnippets ?? []).map((code) => code.timestamp),
    ]),
    ...summary.codeSnippets.map((code) => code.timestamp),
    ...summary.notableQuotes.flatMap((quote) =>
      quote.timestamp === undefined ? [] : [quote.timestamp]
    ),
  ];
  if (
    metadata.duration > 0 &&
    times.some((timestamp) => timestamp > metadata.duration)
  )
    throw new PipelineError(
      "invalid_model_output",
      "Summary timestamps exceed the source duration",
      { stage: "summary", retryable: true }
    );
  return summary;
}

export async function renderSummaryStage(
  input: {
    metadata: MediaMetadata;
    summary: unknown;
    transcript?: TranscriptionResult;
    includeFullTranscript?: boolean;
    generatedAt?: string;
  },
  dependencies: { artifacts: ArtifactStorage },
  context: OperationContext,
  settings: Pick<PipelineSettings, "limits"> = resolveSettings()
): Promise<ArtifactRef> {
  throwIfAborted(context.signal);
  const metadata = metadataSchema.safeParse(input.metadata);
  if (!metadata.success)
    throw new PipelineError("invalid_input", "Invalid render stage metadata");
  if (input.transcript) validateTranscript(input.transcript, settings);
  const summary = validateSummaryForMetadata(input.summary, metadata.data);
  const markdown = renderSummaryMarkdown(
    metadata.data,
    summary,
    input.transcript,
    {
      generatedAt: input.generatedAt ?? new Date(context.now()).toISOString(),
      includeFullTranscript: input.includeFullTranscript ?? false,
    }
  );
  const artifacts = limitArtifactStorage(
    dependencies.artifacts,
    settings.limits.maxArtifactBytes
  );
  const artifact = await artifacts.put(
    "output/summary",
    new TextEncoder().encode(markdown),
    "text/markdown; charset=utf-8"
  );
  throwIfAborted(context.signal);
  return artifact;
}
