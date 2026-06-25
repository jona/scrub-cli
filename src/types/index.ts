/**
 * Shared types used across the application
 */

/**
 * Media metadata — works for YouTube videos, local files, or any future source
 */
export interface MediaMetadata {
  contentId: string;
  title: string;
  description: string;
  duration: number;
  thumbnailUrl: string;
  source: string; // "YouTube" | "Local File" | channel name
  uploadDate: string;
  url: string;
}

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
 * Type of visual content detected in a frame
 */
export type VisualType =
  | "slide"
  | "code"
  | "diagram"
  | "terminal"
  | "talking-head"
  | "other";

/**
 * Analysis result for a single video frame
 */
export interface VisualAnalysis {
  /** Timestamp in the video (seconds) */
  timestamp: number;
  /** Description of what's shown */
  description: string;
  /** Any text/code extracted via OCR */
  extractedText: string;
  /** Classification of the visual content */
  visualType: VisualType;
}

/**
 * A section of the video summary
 */
export interface SummarySection {
  /** Section title */
  title: string;
  /** Start timestamp in seconds */
  startTime: number;
  /** End timestamp in seconds */
  endTime: number;
  /** Summary content for this section */
  content: string;
  /** Visual content description if applicable */
  visualContent?: string;
  /** Code snippets shown in this section */
  codeSnippets?: CodeBlock[];
}

/**
 * A code block extracted from the video
 */
export interface CodeBlock {
  /** Programming language if detected */
  language?: string;
  /** The code content */
  code: string;
  /** Timestamp where code appeared */
  timestamp: number;
  /** Optional description/context */
  context?: string;
}

/**
 * Key claim with supporting evidence
 */
export interface KeyClaim {
  /** The claim being made */
  claim: string;
  /** Supporting evidence or reasoning */
  evidence?: string;
}

/**
 * Thesis and key claims from the video
 */
export interface ThesisAndClaims {
  /** Main thesis/argument of the video */
  thesis: string;
  /** Core claims (3-7) */
  keyClaims: KeyClaim[];
  /** What the creator is trying to convince you of */
  persuasionGoal?: string;
}

/**
 * Actionable insight from the video
 */
export interface ActionableInsight {
  /** The action to take */
  action: string;
  /** When/context for this action */
  context?: string;
  /** Why this action matters */
  rationale?: string;
}

/**
 * Concept definition from the video
 */
export interface ConceptDefinition {
  /** The concept/term */
  concept: string;
  /** Definition provided */
  definition: string;
  /** Example if provided */
  example?: string;
}

/**
 * Mental model or framework explained in the video
 */
export interface MentalModel {
  /** Name of the model/framework */
  name: string;
  /** Description of the model */
  description: string;
  /** When to use this model */
  whenToUse?: string;
  /** Why it works */
  whyItWorks?: string;
}

/**
 * Structure section for video map
 */
export interface StructureSection {
  /** Section number */
  number: number;
  /** Section type (intro, problem, explanation, example, conclusion, etc.) */
  type: string;
  /** Brief description */
  description: string;
  /** Approximate timestamp range */
  timeRange?: string;
}

/**
 * Open question or contradiction
 */
export interface OpenQuestion {
  /** The question or uncertainty */
  question: string;
  /** Type: assumption, contradiction, missing_data, debate */
  type: "assumption" | "contradiction" | "missing_data" | "debate";
  /** Additional context */
  context?: string;
}

/**
 * Quote worth preserving
 */
export interface NotableQuote {
  /** The quote */
  quote: string;
  /** Why it matters */
  significance: string;
  /** Approximate timestamp */
  timestamp?: number;
}

/**
 * Bias and perspective analysis
 */
export interface BiasAnalysis {
  /** Identified perspective/viewpoint */
  perspective: string;
  /** Possible biases */
  possibleBiases: string[];
  /** What's not being said or considered */
  blindSpots: string[];
}

/**
 * Knowledge graph nodes for structured knowledge
 */
export interface KnowledgeGraph {
  /** Topics covered */
  topics: string[];
  /** People mentioned */
  people: string[];
  /** Tools mentioned */
  tools: string[];
  /** Technologies mentioned */
  technologies: string[];
  /** Relationships between entities */
  relationships: string[];
}

/**
 * Difficulty and prerequisites
 */
export interface DifficultyAssessment {
  /** Difficulty level */
  level: "beginner" | "intermediate" | "advanced";
  /** Prerequisites for understanding */
  prerequisites: string[];
  /** Who this content is for */
  targetAudience: string;
}

/**
 * Reusability prompts for the content
 */
export interface ReusabilityPrompts {
  /** Prompt to explain to a beginner */
  explainToBeginnerPrompt?: string;
  /** Prompt to turn into checklist */
  checklistPrompt?: string;
  /** Prompt to create study guide */
  studyGuidePrompt?: string;
  /** Prompt to create flashcards */
  flashcardsPrompt?: string;
}

/**
 * Confidence assessment
 */
export interface ConfidenceScore {
  /** Overall confidence level */
  level: "high" | "medium" | "low";
  /** Reasoning for the confidence level */
  reasoning: string;
}

/**
 * Complete summary result - comprehensive knowledge artifact
 */
export interface SummaryResult {
  /** Video title */
  title: string;
  /** TLDR - 1-2 sentence summary */
  tldr: string;
  /** 2-3 sentence overview */
  overview: string;
  /** Thesis and key claims */
  thesisAndClaims: ThesisAndClaims;
  /** Actionable insights */
  actionableInsights: ActionableInsight[];
  /** Concepts and definitions */
  concepts: ConceptDefinition[];
  /** Mental models and frameworks */
  mentalModels: MentalModel[];
  /** Video structure map */
  structureMap: StructureSection[];
  /** Open questions and contradictions */
  openQuestions: OpenQuestion[];
  /** Notable quotes */
  notableQuotes: NotableQuote[];
  /** Bias and perspective analysis */
  biasAnalysis: BiasAnalysis;
  /** Knowledge graph nodes */
  knowledgeGraph: KnowledgeGraph;
  /** Difficulty assessment */
  difficulty: DifficultyAssessment;
  /** Reusability prompts */
  reusabilityPrompts: ReusabilityPrompts;
  /** Confidence score */
  confidence: ConfidenceScore;
  /** Structured sections with timestamps */
  sections: SummarySection[];
  /** Key bullet points (legacy, now derived from thesisAndClaims) */
  keyTakeaways: string[];
  /** All code snippets consolidated */
  codeSnippets: CodeBlock[];
  /** Mentioned resources and references */
  references: string[];
}

/**
 * Processing progress information
 */
export interface ProcessingProgress {
  stage: "download" | "transcribe" | "extract-frames" | "prompt";
  progress: number;
  message: string;
}

/**
 * Callback for progress updates
 */
export type ProgressCallback = (progress: ProcessingProgress) => void;

/**
 * Artifact types for type-safe references
 *
 * Scrub produces the deterministic artifacts (source, frames, transcription,
 * prompt). The `inference/*` and `output/markdown` artifacts are produced by an
 * agent harness (or scrub's own `render` primitive given a model's response).
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
 * Playlist metadata extracted from YouTube
 */
export interface PlaylistMetadata {
  playlistId: string;
  title: string;
  description: string;
  channelName: string;
  videoCount: number;
  url: string;
}

/**
 * Individual entry in a playlist
 */
export interface PlaylistEntry {
  contentId: string;
  title: string;
  duration: number;
  position: number;
  url: string;
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

/**
 * Source playlist info stored in artifact manifest
 */
export interface SourcePlaylist {
  playlistId: string;
  title: string;
  position: number;
}
