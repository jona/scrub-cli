/**
 * prompt — Deterministic primitive that assembles a summary prompt + output schema
 *
 * Accepts any text file (.json transcript, .txt, .md, etc.), detects the format,
 * and produces the ready-to-send prompt and the JSON output contract. No model is
 * called — an agent harness sends the prompt to whatever model it wants and
 * validates the response against the schema.
 *
 * Replaces the LLM-backed `summarize` command.
 */

import { readFileSync, existsSync } from "fs";
import { extname, basename } from "path";
import { formatTimestamp } from "../utils/helpers.js";
import {
  buildSummaryPrompt,
  SUMMARY_SCHEMA,
} from "./summary-template.js";
import type { MediaMetadata, VisualAnalysis } from "../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

export interface BuildPromptOptions {
  /** Path to metadata.json to enrich the prompt */
  metadataPath?: string;
  /** Path to visual_analysis.json (harness-produced) to enrich the prompt */
  visualsPath?: string;
  onProgress?: (message: string) => void;
}

export interface BuildPromptResult {
  /** The fully-assembled prompt, ready to send to any model */
  prompt: string;
  /** The JSON Schema describing the expected model response */
  schema: typeof SUMMARY_SCHEMA;
  /** Resolved metadata used to build the prompt */
  metadata: MediaMetadata;
}

/**
 * Build the summary prompt and output schema from a content file.
 */
export function buildPromptArtifacts(
  filePath: string,
  options?: BuildPromptOptions
): BuildPromptResult {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  options?.onProgress?.("Assembling summary prompt...");

  const rawContent = readFileSync(filePath, "utf-8");
  const { content } = detectAndParseContent(rawContent, filePath);

  const metadata = options?.metadataPath
    ? (JSON.parse(readFileSync(options.metadataPath, "utf-8")) as MediaMetadata)
    : buildDefaultMetadata(filePath);

  const visuals: VisualAnalysis[] = options?.visualsPath
    ? JSON.parse(readFileSync(options.visualsPath, "utf-8"))
    : [];

  const prompt = buildSummaryPrompt(metadata, content, visuals);

  return { prompt, schema: SUMMARY_SCHEMA, metadata };
}

// ── Content Detection ──────────────────────────────────────────────

function detectAndParseContent(
  rawContent: string,
  filePath: string
): { content: string; transcript?: TranscriptionResult } {
  const ext = extname(filePath).toLowerCase();

  // Try JSON with segments (transcript format)
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed.segments && Array.isArray(parsed.segments)) {
        return {
          content: formatTranscriptAsContent(parsed as TranscriptionResult),
          transcript: parsed as TranscriptionResult,
        };
      }
      // Generic JSON — serialize nicely
      return { content: JSON.stringify(parsed, null, 2) };
    } catch {
      return { content: rawContent };
    }
  }

  // Plain text or markdown — use as-is
  return { content: rawContent };
}

function formatTranscriptAsContent(transcript: TranscriptionResult): string {
  return transcript.segments
    .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
    .join("\n");
}

function buildDefaultMetadata(filePath: string): MediaMetadata {
  const name = basename(filePath, extname(filePath));
  return {
    contentId: "unknown",
    title: name,
    description: "",
    duration: 0,
    thumbnailUrl: "",
    source: "File",
    uploadDate: new Date().toISOString().split("T")[0],
    url: filePath,
  };
}
