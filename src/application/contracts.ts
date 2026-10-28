import type {
  MediaMetadata,
  PlaylistEntry,
  PlaylistMetadata,
  TranscriptionResult,
} from "../core/models.js";
import type {
  InferenceSettings,
  InferenceSettingsInput,
  ModelInferenceCheckpoint,
  StructuredModelGateway,
  InferenceArtifacts,
} from "./model.js";

export const PIPELINE_VERSION = "3.0.0";

/** Opaque storage identity. A reference is never a host file path or signed URL. */
export interface ArtifactRef {
  id: string;
  kind: string;
  mediaType: string;
  size: number;
  digest?: string;
}
export interface FrameArtifact {
  timestamp: number;
  artifact: ArtifactRef;
  score?: number;
}
export type MediaSource =
  | { kind: "youtube"; url: string }
  | { kind: "asset"; asset: ArtifactRef; name: string };

export interface ResourceLimits {
  maxDurationSeconds: number;
  maxSourceBytes: number;
  maxArtifactBytes: number;
  maxTranscriptCharacters: number;
  maxPlaylistVideos: number;
  stageTimeoutMs: number;
  maxAttempts: number;
}
export interface PipelineSettings {
  inference?: InferenceSettings;
  skipVisuals: boolean;
  sceneThreshold: number;
  maxFrames: number;
  minFrameInterval: number;
  transcription: {
    provider?: string;
    model?: string;
    language?: string;
    wordTimestamps?: boolean;
  };
  limits: ResourceLimits;
}
export interface PipelineEvent {
  runId: string;
  stage: string;
  progress: number;
  message: string;
  warning?: boolean;
}
export interface OperationContext {
  runId: string;
  attemptId: string;
  signal: AbortSignal;
  now(): number;
  emit(event: PipelineEvent): void | Promise<void>;
}
export type ArtifactBytes = Uint8Array | AsyncIterable<Uint8Array>;
export interface ArtifactStorage {
  /** Resolve only after all bytes are published to the adapter's durable store. */
  put(
    kind: string,
    data: ArtifactBytes,
    mediaType: string
  ): Promise<ArtifactRef>;
  read(ref: ArtifactRef): AsyncIterable<Uint8Array>;
  has(ref: ArtifactRef): Promise<boolean>;
  readRange(
    ref: ArtifactRef,
    offset: number,
    length: number
  ): Promise<Uint8Array>;
}
export interface PreparedMedia {
  metadata: MediaMetadata;
  audio: ArtifactRef;
  video?: ArtifactRef;
  warnings?: string[];
}
export interface MediaProcessor {
  acquire(
    source: MediaSource,
    settings: PipelineSettings,
    context: OperationContext
  ): Promise<PreparedMedia>;
  extractFrames(
    video: ArtifactRef,
    settings: PipelineSettings,
    context: OperationContext,
    /** Known source timeline; zero or omission means the duration is unknown. */
    sourceDurationSeconds?: number
  ): Promise<FrameArtifact[]>;
}
export interface SourceCatalog {
  enumerate(
    url: string,
    maximum: number,
    context: OperationContext
  ): Promise<{
    metadata: PlaylistMetadata;
    entries: AsyncIterable<PlaylistEntry>;
  }>;
}
export interface Transcriber {
  transcribe(
    request: { audio: ArtifactRef; source: MediaSource },
    settings: PipelineSettings,
    context: OperationContext
  ): Promise<TranscriptionResult>;
}
export interface ProcessingStats {
  visionTime?: number;
  summarizationTime?: number;
  renderTime?: number;
  downloadTime: number;
  transcriptionTime: number;
  frameExtractionTime: number;
  promptTime: number;
  totalTime: number;
}
export interface VideoResult {
  mode?: "preprocess" | "full";
  inference?: InferenceArtifacts;
  metadata: MediaMetadata;
  transcript: ArtifactRef;
  transcriptText: ArtifactRef;
  frames: FrameArtifact[];
  framesManifest?: ArtifactRef;
  metadataArtifact: ArtifactRef;
  prompt: ArtifactRef;
  schema: ArtifactRef;
  audio: ArtifactRef;
  video?: ArtifactRef;
  cacheKey: string;
  completedAt: string;
  warnings: string[];
  stats: ProcessingStats;
}
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export interface Failure {
  code: string;
  message: string;
  stage?: string;
  retryable: boolean;
}
export interface RunRecord {
  revision: number;
  status: RunStatus;
  source: MediaSource;
  settings: PipelineSettings;
  cacheKey: string;
  startedAt: string;
  updatedAt: string;
  stage: string;
  progress: number;
  attempts: number;
  cancelRequested: boolean;
  checkpoints: {
    inference?: ModelInferenceCheckpoint;
    acquire?: PreparedMedia;
    transcribe?: { transcript: ArtifactRef; text: ArtifactRef };
    frames?: { frames: FrameArtifact[]; manifest: ArtifactRef };
  };
  result?: VideoResult;
  failure?: Failure;
}
export interface RunRepository {
  get(): Promise<RunRecord | null>;
  /** Serialize updates and await durable acknowledgment before resolving. */
  update(change: (current: RunRecord | null) => RunRecord): Promise<RunRecord>;
}
export interface PipelineDependencies {
  models?: StructuredModelGateway;
  artifacts: ArtifactStorage;
  media: MediaProcessor;
  transcriber: Transcriber;
  runs: RunRepository;
}

export interface JobSubmission {
  url: string;
  settings?: Partial<
    Omit<PipelineSettings, "limits" | "transcription" | "inference">
  > & {
    inference?: InferenceSettingsInput;
    transcription?: PipelineSettings["transcription"];
    limits?: Partial<ResourceLimits>;
  };
  maxVideos?: number;
  concurrency?: number;
  continueOnError?: boolean;
  skipExisting?: boolean;
}
export interface JobVideo {
  videoId: string;
  title: string;
  position: number;
  status: RunStatus | "skipped";
  stage?: string;
  progress?: number;
  result?: VideoResult;
  failure?: Failure;
}
export interface JobSnapshot {
  id: string;
  status: RunStatus | "completed_with_errors";
  createdAt: string;
  updatedAt: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  stage: string;
  failure?: Failure;
}
export interface JobGateway {
  submit(input: JobSubmission, idempotencyKey?: string): Promise<JobSnapshot>;
  get(id: string): Promise<JobSnapshot | null>;
  results(
    id: string,
    offset: number,
    limit: number
  ): Promise<{ items: JobVideo[]; total: number }>;
  cancel(id: string): Promise<JobSnapshot>;
  retry(id: string): Promise<JobSnapshot>;
  artifact(
    jobId: string,
    videoId: string,
    artifactId: string,
    offset: number,
    length: number
  ): Promise<{ bytes: Uint8Array; mediaType: string; size: number }>;
}
