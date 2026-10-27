/** CLI path, projection, and artifact-manifest contracts. Portable values live in core/models. */
import type {
  MediaMetadata,
  PlaylistMetadata,
  SourcePlaylist,
} from "../core/models.js";

export type {
  MediaMetadata,
  VisualType,
  VisualAnalysis,
  SummarySection,
  CodeBlock,
  KeyClaim,
  ThesisAndClaims,
  ActionableInsight,
  ConceptDefinition,
  MentalModel,
  StructureSection,
  OpenQuestion,
  NotableQuote,
  BiasAnalysis,
  KnowledgeGraph,
  DifficultyAssessment,
  ReusabilityPrompts,
  ConfidenceScore,
  SummaryResult,
  PlaylistMetadata,
  PlaylistEntry,
  SourcePlaylist,
} from "../core/models.js";

/**
 * Result from preparing media for the pipeline (download or local file prep)
 */
export interface PrepareResult {
  metadata: MediaMetadata;
  audioPath: string;
  videoPath: string;
  cacheDir: string;
}

/**
 * A single frame captured from scene detection
 */
export interface SceneFrame {
  /** Timestamp in the video (seconds) */
  timestamp: number;
  /** Path to the captured frame image */
  framePath: string;
  /** Scene change score (0-1) */
  score?: number;
}

/**
 * Artifact types for type-safe references
 *
 * Categories in the CLI artifact tree. The shared pipeline or an external
 * agent harness can produce the inference and rendered markdown artifacts.
 */
export type ArtifactType =
  | "source/audio"
  | "source/video"
  | "source/metadata"
  | "frames"
  | "frames/json"
  | "transcription/json"
  | "transcription/txt"
  | "prompt/summary"
  | "prompt/schema"
  | "inference/summary"
  | "inference/visual_analysis"
  | "output/markdown";

/**
 * Manifest tracking all artifacts for processed media
 */
export interface ArtifactManifest {
  /** Content identifier (YouTube video ID or local file hash) */
  contentId: string;
  /** Original URL or file path */
  url: string;
  /** Media title */
  title: string;
  /** ISO timestamp when processing completed */
  processedAt: string;
  /** Pipeline version for compatibility tracking */
  pipelineVersion: string;
  /** Optional: playlist this video was extracted from */
  sourcePlaylist?: SourcePlaylist;
  /** Artifact inventory */
  artifacts: {
    source: {
      audio: boolean;
      video: boolean;
      metadata: boolean;
    };
    frames: {
      count: number;
      paths: string[];
    };
    transcription: {
      source: string | null;
      hasJson: boolean;
      hasTxt: boolean;
    };
    prompt: {
      summary: boolean;
      schema: boolean;
    };
  };
  /** Processing statistics */
  stats: {
    downloadTime: number;
    transcriptionTime: number;
    frameExtractionTime: number;
    promptTime: number;
    totalTime: number;
  };
}

/**
 * Entry in the global artifact index
 */
export interface ArtifactIndexEntry {
  /** Media title */
  title: string;
  /** Original URL or file path */
  url: string;
  /** ISO timestamp when processed */
  processedAt: string;
  /** Relative path to video directory */
  outputPath: string;
}

/**
 * Global index of all processed media
 */
export interface ArtifactIndex {
  /** Index schema version */
  version: string;
  /** ISO timestamp of last update */
  lastUpdated: string;
  /** Map of contentId to index entry */
  media: Record<string, ArtifactIndexEntry>;
}

/**
 * Status type for playlist video processing
 */
export type PlaylistVideoStatusType =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

/**
 * Status of individual media processing within a playlist
 */
export interface PlaylistVideoStatus {
  contentId: string;
  title: string;
  status: PlaylistVideoStatusType;
  stage?: string;
  error?: string;
  outputPath?: string;
}

/**
 * Result from processing an entire playlist
 */
export interface PlaylistProcessResult {
  playlist: PlaylistMetadata;
  videos: PlaylistVideoStatus[];
  succeeded: number;
  failed: number;
  skipped: number;
  stats: {
    totalTime: number;
    averageTimePerVideo: number;
  };
}
