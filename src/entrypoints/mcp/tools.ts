/**
 * MCP Tool definitions and Zod schemas for scrub
 */

import { z } from "zod";

export const OutputFormat = z.enum(["full", "summary", "transcript"]);
export type OutputFormat = z.infer<typeof OutputFormat>;

export const ScrubVideoInputSchema = z.object({
  url: z.string().describe("YouTube video URL or local file path (.mp3, .mp4) to process"),
  skipVisuals: z.boolean().optional().default(false).describe("Skip visual analysis for faster processing"),
  transcriber: z
    .enum(["local-whisper", "faster-whisper", "openai", "deepgram", "youtube-captions"])
    .optional()
    .describe("Force a specific transcription adapter"),
  outputFormat: OutputFormat.optional().default("summary").describe("Output format: full, summary, or transcript"),
  maxFrames: z.number().optional().describe("Maximum frames to analyze for visual content"),
  sceneThreshold: z.number().min(0).max(1).optional().describe("Scene detection sensitivity (0-1)"),
  generateSkill: z.boolean().optional().default(false).describe("Generate SKILL.md from content"),
  skillName: z.string().optional().describe("Custom skill name"),
});

export type ScrubVideoInput = z.infer<typeof ScrubVideoInputSchema>;

export const ScrubPlaylistInputSchema = z.object({
  url: z.string().describe("YouTube playlist URL to process"),
  maxVideos: z.number().optional().default(0).describe("Maximum videos to process (0 = unlimited)"),
  skipVisuals: z.boolean().optional().default(false).describe("Skip visual analysis"),
  transcriber: z
    .enum(["local-whisper", "faster-whisper", "openai", "deepgram", "youtube-captions"])
    .optional()
    .describe("Force a specific transcription adapter"),
  concurrency: z.number().min(1).max(5).optional().default(1).describe("Number of videos to process in parallel (1-5)"),
  continueOnError: z.boolean().optional().default(true).describe("Continue processing if individual videos fail"),
  skipExisting: z.boolean().optional().default(true).describe("Skip already processed videos"),
});

export type ScrubPlaylistInput = z.infer<typeof ScrubPlaylistInputSchema>;

export const ScrubDoctorInputSchema = z.object({});
export type ScrubDoctorInput = z.infer<typeof ScrubDoctorInputSchema>;

export const ListTranscribersInputSchema = z.object({});
export type ListTranscribersInput = z.infer<typeof ListTranscribersInputSchema>;

export const TOOL_DEFINITIONS = [
  {
    name: "scrub_video",
    description: `Process a YouTube video or local media file (.mp3, .mp4) and extract its content as structured data.

WHEN TO USE: Use this tool when you need to extract knowledge from a YouTube video or local audio/video file - for creating documentation, understanding tutorials, extracting code examples, or building context from media content.

Returns transcription, visual analysis, and AI-generated summary with:
- Overview and key takeaways
- Section-by-section breakdown with timestamps
- Code snippets extracted from slides/screen recordings
- References and resources mentioned

Accepts YouTube URLs or local file paths:
- YouTube: https://youtube.com/watch?v=VIDEO_ID
- Local: /path/to/file.mp3 or /path/to/file.mp4

For local .mp3 files, visual analysis is automatically skipped.

Use outputFormat to control what's returned:
- "summary" (default): Overview, sections, key takeaways
- "transcript": Raw transcript with timestamps
- "full": Complete result with all metadata

NOTE: Processing takes 1-5 minutes depending on content length.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "YouTube video URL or local .mp3/.mp4 file path to process" },
        skipVisuals: { type: "boolean", default: false, description: "Skip visual analysis (default: false)" },
        transcriber: {
          type: "string",
          enum: ["local-whisper", "faster-whisper", "openai", "deepgram", "youtube-captions"],
          description: "Force a specific transcription adapter (optional)",
        },
        outputFormat: { type: "string", enum: ["full", "summary", "transcript"], default: "summary", description: "Output format (default: summary)" },
        maxFrames: { type: "number", default: 20, description: "Maximum frames to analyze (default: 20)" },
        sceneThreshold: { type: "number", minimum: 0, maximum: 1, default: 0.4, description: "Scene detection sensitivity 0-1 (default: 0.4)" },
        generateSkill: { type: "boolean", default: false, description: "Generate SKILL.md from content (default: false)" },
        skillName: { type: "string", description: "Custom skill name" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: {
      title: "Process Media",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "scrub_doctor",
    description: `Check system prerequisites for scrub.

WHEN TO USE: Run this FIRST if scrub_video fails, or to verify the system is properly configured.

Returns diagnostic information about:
- External tools: yt-dlp, ffmpeg installation status
- API keys: Anthropic, OpenAI, Deepgram configuration
- Available transcription adapters`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      title: "Check Scrub Prerequisites",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list_transcribers",
    description: `List available transcription adapters and their status.

WHEN TO USE: Use to see which transcription methods are available.

Returns an array of transcribers with name, source, availability, and API key requirements.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      title: "List Transcription Adapters",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "scrub_playlist",
    description: `Process a YouTube playlist and extract content from all videos.

WHEN TO USE: Use when you need to process multiple related videos from a playlist.

Options:
- maxVideos: Limit how many videos to process (0 = all)
- skipExisting: Skip already processed videos (default: true)
- concurrency: Process multiple videos in parallel (1-5, default: 1)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "YouTube playlist URL to process" },
        maxVideos: { type: "number", default: 0, description: "Maximum videos to process (0 = all)" },
        skipVisuals: { type: "boolean", default: false, description: "Skip visual analysis" },
        transcriber: {
          type: "string",
          enum: ["local-whisper", "faster-whisper", "openai", "deepgram", "youtube-captions"],
          description: "Force a specific transcription adapter",
        },
        concurrency: { type: "number", minimum: 1, maximum: 5, default: 1, description: "Number of videos to process in parallel (1-5)" },
        continueOnError: { type: "boolean", default: true, description: "Continue processing if individual videos fail" },
        skipExisting: { type: "boolean", default: true, description: "Skip already processed videos" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: {
      title: "Process YouTube Playlist",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const;
