/**
 * render — Deterministic primitive that renders a summary JSON into markdown
 *
 * Completes the round-trip: an agent harness sends summary.prompt.md to a model,
 * gets back JSON matching summary.schema.json, and `render` turns that JSON into a
 * polished summary.md. No model is called.
 */

import { readFileSync, existsSync } from "fs";
import { extname, basename } from "path";
import { renderSummaryMarkdown } from "./summary-template.js";
import type { MediaMetadata, SummaryResult } from "../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

export interface RenderOptions {
  /** Path to metadata.json (falls back to the summary's own title) */
  metadataPath?: string;
  /** Path to transcript.json to optionally append a full transcript */
  transcriptPath?: string;
  onProgress?: (message: string) => void;
}

/**
 * Render a summary JSON file into markdown.
 */
export function renderSummaryFile(
  summaryPath: string,
  options?: RenderOptions
): string {
  if (!existsSync(summaryPath)) {
    throw new Error(`Summary file not found: ${summaryPath}`);
  }

  options?.onProgress?.("Rendering markdown...");

  const summary = JSON.parse(
    readFileSync(summaryPath, "utf-8")
  ) as SummaryResult;

  const metadata = options?.metadataPath
    ? (JSON.parse(readFileSync(options.metadataPath, "utf-8")) as MediaMetadata)
    : buildMetadataFromSummary(summaryPath, summary);

  const transcript = options?.transcriptPath
    ? (JSON.parse(
        readFileSync(options.transcriptPath, "utf-8")
      ) as TranscriptionResult)
    : undefined;

  return renderSummaryMarkdown(metadata, summary, transcript);
}

function buildMetadataFromSummary(
  summaryPath: string,
  summary: SummaryResult
): MediaMetadata {
  return {
    contentId: "unknown",
    title: summary.title || basename(summaryPath, extname(summaryPath)),
    description: "",
    duration: 0,
    thumbnailUrl: "",
    source: "File",
    uploadDate: new Date().toISOString().split("T")[0],
    url: summaryPath,
  };
}
