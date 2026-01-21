/**
 * Output formatters for agent-friendly responses
 */

import type { ProcessResult } from '../../core/VideoProcessor.js';
import type { OutputFormat } from './tools.js';

/**
 * Format timestamp in seconds to HH:MM:SS or MM:SS format
 */
function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Summary output format - most useful for agent context
 */
export interface SummaryOutput {
  title: string;
  source: string;
  channel: string;
  duration: string;
  overview: string;
  sections: Array<{
    title: string;
    timestamp: string;
    content: string;
    visualContent?: string;
    codeSnippets?: Array<{
      language?: string;
      code: string;
    }>;
  }>;
  keyTakeaways: string[];
  codeSnippets: Array<{
    language?: string;
    code: string;
    context?: string;
  }>;
  references: string[];
  /** Generated SKILL.md content (if generateSkill was true) */
  skill?: {
    name: string;
    path: string;
    content: string;
  };
}

/**
 * Transcript output format - raw transcript with timestamps
 */
export interface TranscriptOutput {
  title: string;
  source: string;
  duration: string;
  transcriptionSource: string;
  segments: Array<{
    timestamp: string;
    text: string;
  }>;
  fullText: string;
}

/**
 * Format ProcessResult for agent consumption
 */
export function formatOutput(
  result: ProcessResult,
  format: OutputFormat
): SummaryOutput | TranscriptOutput | ProcessResult {
  switch (format) {
    case 'summary':
      return formatSummary(result);
    case 'transcript':
      return formatTranscript(result);
    case 'full':
    default:
      return result;
  }
}

/**
 * Format as summary - sections, takeaways, code snippets
 */
function formatSummary(result: ProcessResult): SummaryOutput {
  const output: SummaryOutput = {
    title: result.metadata.title,
    source: result.metadata.url,
    channel: result.metadata.channelName,
    duration: formatTimestamp(result.metadata.duration),
    overview: result.summary.overview,
    sections: result.summary.sections.map((section) => ({
      title: section.title,
      timestamp: `${formatTimestamp(section.startTime)} - ${formatTimestamp(section.endTime)}`,
      content: section.content,
      visualContent: section.visualContent,
      codeSnippets: section.codeSnippets?.map((snippet) => ({
        language: snippet.language,
        code: snippet.code,
      })),
    })),
    keyTakeaways: result.summary.keyTakeaways,
    codeSnippets: result.summary.codeSnippets.map((snippet) => ({
      language: snippet.language,
      code: snippet.code,
      context: snippet.context,
    })),
    references: result.summary.references,
  };

  // Include skill if generated
  if (result.skillResult && result.skillPath) {
    output.skill = {
      name: result.skillResult.suggestedName,
      path: result.skillPath,
      content: result.skillResult.skillMd,
    };
  }

  return output;
}

/**
 * Format as transcript - raw text with timestamps
 */
function formatTranscript(result: ProcessResult): TranscriptOutput {
  const transcript = result.transcript;

  return {
    title: result.metadata.title,
    source: result.metadata.url,
    duration: formatTimestamp(result.metadata.duration),
    transcriptionSource: transcript.source,
    segments: transcript.segments.map((segment) => ({
      timestamp: formatTimestamp(segment.start),
      text: segment.text,
    })),
    fullText: transcript.fullText,
  };
}

/**
 * Format diagnostics result for agent consumption
 */
export interface DiagnosticsOutput {
  ready: boolean;
  externalTools: {
    ytdlp: { installed: boolean; note: string };
    ffmpeg: { installed: boolean; note: string };
  };
  apiKeys: {
    anthropic: { configured: boolean; required: boolean };
    openai: { configured: boolean; required: boolean };
    deepgram: { configured: boolean; required: boolean };
  };
  transcribers: Array<{
    name: string;
    source: string;
    available: boolean;
  }>;
  issues: string[];
  recommendations: string[];
}

/**
 * Format diagnostics for agent consumption
 */
export function formatDiagnostics(diagnostics: {
  ytdlp: boolean;
  ffmpeg: boolean;
  anthropicKey: boolean;
  transcribers: Array<{ source: string; name: string; available: boolean }>;
}): DiagnosticsOutput {
  const issues: string[] = [];
  const recommendations: string[] = [];

  if (!diagnostics.ytdlp) {
    issues.push('yt-dlp is not installed');
    recommendations.push('Install yt-dlp: brew install yt-dlp (or pip install yt-dlp)');
  }

  if (!diagnostics.ffmpeg) {
    issues.push('ffmpeg is not installed');
    recommendations.push('Install ffmpeg: brew install ffmpeg');
  }

  if (!diagnostics.anthropicKey) {
    issues.push('ANTHROPIC_API_KEY is not configured');
    recommendations.push('Set ANTHROPIC_API_KEY environment variable');
  }

  const availableTranscribers = diagnostics.transcribers.filter((t) => t.available);
  if (availableTranscribers.length === 0) {
    issues.push('No transcription adapters available');
    recommendations.push(
      'Install whisper.cpp, faster-whisper, or set OPENAI_API_KEY for transcription'
    );
  }

  const ready = issues.length === 0;

  return {
    ready,
    externalTools: {
      ytdlp: {
        installed: diagnostics.ytdlp,
        note: diagnostics.ytdlp ? 'Ready' : 'Required for video download',
      },
      ffmpeg: {
        installed: diagnostics.ffmpeg,
        note: diagnostics.ffmpeg ? 'Ready' : 'Required for audio/video processing',
      },
    },
    apiKeys: {
      anthropic: {
        configured: diagnostics.anthropicKey,
        required: true,
      },
      openai: {
        configured: diagnostics.transcribers.some(
          (t) => t.source === 'openai' && t.available
        ),
        required: false,
      },
      deepgram: {
        configured: diagnostics.transcribers.some(
          (t) => t.source === 'deepgram' && t.available
        ),
        required: false,
      },
    },
    transcribers: diagnostics.transcribers,
    issues,
    recommendations,
  };
}

/**
 * Format transcriber list for agent consumption
 */
export interface TranscriberInfo {
  name: string;
  source: string;
  available: boolean;
  requiresApiKey: boolean;
  description: string;
}

export function formatTranscriberList(
  transcribers: Array<{
    source: string;
    name: string;
    available: boolean;
    requiresApiKey?: boolean;
  }>
): TranscriberInfo[] {
  const descriptions: Record<string, string> = {
    'local-whisper': 'Local transcription using whisper.cpp - free, privacy-first',
    'faster-whisper': 'Optimized Python Whisper implementation - free, fast',
    openai: 'OpenAI Whisper API - cloud-based, excellent quality',
    deepgram: 'Deepgram API - enterprise-grade, very fast',
    'youtube-captions': 'YouTube auto-captions - free fallback, quality varies',
  };

  const requiresKey: Record<string, boolean> = {
    'local-whisper': false,
    'faster-whisper': false,
    openai: true,
    deepgram: true,
    'youtube-captions': false,
  };

  return transcribers.map((t) => ({
    name: t.name,
    source: t.source,
    available: t.available,
    requiresApiKey: requiresKey[t.source] ?? false,
    description: descriptions[t.source] ?? 'Unknown transcription adapter',
  }));
}
