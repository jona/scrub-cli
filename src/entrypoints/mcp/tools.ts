/**
 * MCP Tool definitions and Zod schemas for scrub
 */

import { z } from 'zod';

/**
 * Output format options for scrub_video
 */
export const OutputFormat = z.enum(['full', 'summary', 'transcript']);
export type OutputFormat = z.infer<typeof OutputFormat>;

/**
 * Schema for scrub_video tool input
 */
export const ScrubVideoInputSchema = z.object({
  url: z.string().describe('YouTube video URL to process'),
  skipVisuals: z
    .boolean()
    .optional()
    .default(false)
    .describe('Skip visual analysis for faster processing'),
  transcriber: z
    .enum([
      'local-whisper',
      'faster-whisper',
      'openai',
      'deepgram',
      'youtube-captions',
    ])
    .optional()
    .describe('Force a specific transcription adapter'),
  outputFormat: OutputFormat.optional()
    .default('summary')
    .describe(
      'Output format: full (complete result), summary (sections + takeaways), transcript (raw text)'
    ),
  maxFrames: z
    .number()
    .optional()
    .describe('Maximum frames to analyze for visual content'),
  sceneThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Scene detection sensitivity (0-1)'),
  generateSkill: z
    .boolean()
    .optional()
    .default(false)
    .describe('Generate SKILL.md alongside regular output - creates a reusable AI agent skill from the video content'),
  skillName: z
    .string()
    .optional()
    .describe('Custom skill name (auto-derived from video title if not provided)'),
});

export type ScrubVideoInput = z.infer<typeof ScrubVideoInputSchema>;

/**
 * Schema for scrub_doctor tool input (no inputs needed)
 */
export const ScrubDoctorInputSchema = z.object({});
export type ScrubDoctorInput = z.infer<typeof ScrubDoctorInputSchema>;

/**
 * Schema for list_transcribers tool input (no inputs needed)
 */
export const ListTranscribersInputSchema = z.object({});
export type ListTranscribersInput = z.infer<typeof ListTranscribersInputSchema>;

/**
 * Tool definitions for MCP server
 * Following MCP spec with annotations for tool behavior hints
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'scrub_video',
    description: `Process a YouTube video and extract its content as structured data.

WHEN TO USE: Use this tool when you need to extract knowledge from a YouTube video - for creating documentation, understanding tutorials, extracting code examples, or building context from video content.

Returns transcription, visual analysis, and AI-generated summary with:
- Overview and key takeaways
- Section-by-section breakdown with timestamps
- Code snippets extracted from slides/screen recordings
- References and resources mentioned

Use outputFormat to control what's returned:
- "summary" (default): Overview, sections, key takeaways - best for context
- "transcript": Raw transcript with timestamps - best for detailed analysis
- "full": Complete ProcessResult with all metadata - best for programmatic use

NOTE: Processing takes 1-5 minutes depending on video length. Use skipVisuals=true for faster processing.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'YouTube video URL to process (e.g., https://youtube.com/watch?v=VIDEO_ID)',
        },
        skipVisuals: {
          type: 'boolean',
          default: false,
          description: 'Skip visual analysis for faster processing (default: false)',
        },
        transcriber: {
          type: 'string',
          enum: [
            'local-whisper',
            'faster-whisper',
            'openai',
            'deepgram',
            'youtube-captions',
          ],
          description: 'Force a specific transcription adapter (optional - auto-selects best available)',
        },
        outputFormat: {
          type: 'string',
          enum: ['full', 'summary', 'transcript'],
          default: 'summary',
          description: 'Output format (default: summary)',
        },
        maxFrames: {
          type: 'number',
          default: 20,
          description: 'Maximum frames to analyze for visual content (default: 20)',
        },
        sceneThreshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.4,
          description: 'Scene detection sensitivity 0-1 (default: 0.4)',
        },
        generateSkill: {
          type: 'boolean',
          default: false,
          description: 'Generate SKILL.md from video content (default: false)',
        },
        skillName: {
          type: 'string',
          description: 'Custom skill name (auto-derived from title if not provided)',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    // MCP tool annotations for behavior hints
    annotations: {
      title: 'Process YouTube Video',
      readOnlyHint: true, // Doesn't modify external state
      destructiveHint: false,
      idempotentHint: true, // Same URL produces same result
      openWorldHint: true, // Accesses external YouTube
    },
  },
  {
    name: 'scrub_doctor',
    description: `Check system prerequisites for scrub.

WHEN TO USE: Run this FIRST if scrub_video fails, or to verify the system is properly configured before processing videos.

Returns diagnostic information about:
- External tools: yt-dlp, ffmpeg installation status
- API keys: Anthropic, OpenAI, Deepgram configuration
- Available transcription adapters
- Specific issues and recommendations to fix them`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      title: 'Check Scrub Prerequisites',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'list_transcribers',
    description: `List available transcription adapters and their status.

WHEN TO USE: Use to see which transcription methods are available, especially if you want to force a specific transcriber with scrub_video.

Returns an array of transcribers with:
- name: Human-readable name
- source: Adapter identifier (use this value for scrub_video's transcriber param)
- available: Whether it's ready to use
- requiresApiKey: Whether an API key is needed
- description: What this transcriber does

Transcribers are tried in priority order during processing.`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      title: 'List Transcription Adapters',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;
