/**
 * Shared types used across the application
 */

/**
 * Video metadata extracted from YouTube
 */
export interface VideoMetadata {
  videoId: string;
  title: string;
  description: string;
  duration: number;
  thumbnailUrl: string;
  channelName: string;
  uploadDate: string;
  url: string;
}

/**
 * Result from downloading a video
 */
export interface DownloadResult {
  metadata: VideoMetadata;
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
  | 'slide'
  | 'code'
  | 'diagram'
  | 'terminal'
  | 'talking-head'
  | 'other';

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
 * Complete summary result
 */
export interface SummaryResult {
  /** Video title */
  title: string;
  /** 2-3 sentence overview */
  overview: string;
  /** Structured sections with timestamps */
  sections: SummarySection[];
  /** Key bullet points */
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
  stage: 'download' | 'transcribe' | 'scene-detect' | 'visual-analyze' | 'summarize' | 'generate';
  progress: number;
  message: string;
}

/**
 * Callback for progress updates
 */
export type ProgressCallback = (progress: ProcessingProgress) => void;
