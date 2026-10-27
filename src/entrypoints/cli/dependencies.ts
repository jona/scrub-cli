import type { MediaMetadata, TranscriptionResult } from "../../core/models.js";
import type { ProcessingStats } from "../../application/contracts.js";
import type { SUMMARY_SCHEMA } from "../../core/summary-template.js";
import type {
  PlaylistProcessResult,
  PlaylistVideoStatus,
  PlaylistVideoStatusType,
  PrepareResult,
  SceneFrame,
} from "../../types/index.js";

export type CliTranscriptionSource =
  | "faster-whisper"
  | "local-whisper"
  | "openai"
  | "deepgram"
  | "youtube-captions";
export interface CliInferenceOptions {
  summarize?: boolean;
  summaryProvider?: string;
  summaryModel?: string;
  visionProvider?: string;
  visionModel?: string;
}
export interface CliProcessOptions extends CliInferenceOptions {
  skipVisuals?: boolean;
  transcriber?: CliTranscriptionSource;
  sceneThreshold?: number;
  maxFrames?: number;
  verbose?: boolean;
  signal?: AbortSignal;
  outputDir?: string;
  force?: boolean;
  onProgress?: (progress: {
    stage: string;
    progress: number;
    message: string;
  }) => void;
}
export interface CliPlaylistOptions extends Omit<
  CliProcessOptions,
  "onProgress"
> {
  maxVideos?: number;
  concurrency?: number;
  continueOnError?: boolean;
  skipExisting?: boolean;
  onStart?: (videos: PlaylistVideoStatus[], total: number) => void;
  onProgress?: (
    contentId: string,
    status: PlaylistVideoStatusType,
    stage?: string
  ) => void;
}
export interface CliProcessResult {
  metadata: MediaMetadata;
  transcript: TranscriptionResult;
  frames: SceneFrame[];
  promptPath: string;
  summaryPath?: string;
  outputPath: string;
  stats: ProcessingStats;
  reused: boolean;
}
interface TranscriberDiagnostic {
  source: CliTranscriptionSource;
  name: string;
  available: boolean;
  requiresApiKey: boolean;
}
interface Prerequisites {
  ready: boolean;
  missing: string[];
  warnings: string[];
}
interface ProgressOption {
  onProgress?: (message: string) => void;
}
/** Local path commands are entrypoint contracts. Runtime implementations are injected. */
export interface CliDependencies {
  config: {
    setOutputDir(directory: string): void;
    getApiKey(service: "openai" | "deepgram"): string | undefined;
    getConfigPath(): string | null;
    getOutputDir(): string;
    getCacheDir(): string;
  };
  processFile(
    file: string,
    options?: CliProcessOptions
  ): Promise<CliProcessResult>;
  processYouTubePlaylist(
    url: string,
    options?: CliPlaylistOptions
  ): Promise<PlaylistProcessResult>;
  checkFilePrerequisites(): Promise<Prerequisites>;
  checkYouTubePrerequisites(): Promise<Prerequisites>;
  getDiagnostics(): Promise<{
    ytdlp: boolean;
    ffmpeg: boolean;
    transcribers: TranscriberDiagnostic[];
  }>;
  download(
    url: string,
    options: ProgressOption & {
      outputDir: string;
      skipVideo?: boolean;
      maxResolution?: number;
      metadata?: MediaMetadata;
    }
  ): Promise<PrepareResult>;
  prepare(
    file: string,
    options: ProgressOption & { outputDir: string; skipVideo?: boolean }
  ): Promise<PrepareResult>;
  transcribe(
    file: string,
    options?: ProgressOption & {
      adapter?: CliTranscriptionSource;
      language?: string;
      model?: "tiny" | "base" | "small" | "medium" | "large";
      youtubeUrl?: string;
      outputText?: string;
    }
  ): Promise<TranscriptionResult>;
  getTranscriberDiagnostics(): Promise<TranscriberDiagnostic[]>;
  extractFrames(
    file: string,
    options: ProgressOption & {
      outputDir: string;
      threshold?: number;
      maxFrames?: number;
      minInterval?: number;
    }
  ): Promise<SceneFrame[]>;
  buildPromptArtifacts(
    file: string,
    options?: ProgressOption & { metadataPath?: string; visualsPath?: string }
  ):
    | { prompt: string; schema: typeof SUMMARY_SCHEMA; metadata: MediaMetadata }
    | Promise<{
        prompt: string;
        schema: typeof SUMMARY_SCHEMA;
        metadata: MediaMetadata;
      }>;
  renderSummaryFile(
    file: string,
    options?: ProgressOption & {
      metadataPath?: string;
      transcriptPath?: string;
      includeFullTranscript?: boolean;
      generatedAt?: string;
    }
  ): string | Promise<string>;
}
