#!/usr/bin/env node

/**
 * Scrub MCP Server
 *
 * Exposes scrub processing capabilities to Claude Code agents
 * via the Model Context Protocol (MCP).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";

import {
  processYouTube,
  processYouTubePlaylist,
  checkYouTubePrerequisites,
  getDiagnostics,
} from "../../orchestrators/youtube.js";
import {
  processFile,
  checkFilePrerequisites,
} from "../../orchestrators/file.js";
import { isLocalFilePath } from "../../core/prepare.js";
import { getTranscriberDiagnostics } from "../../core/transcribe.js";
import {
  TOOL_DEFINITIONS,
  ScrubVideoInputSchema,
  ScrubPlaylistInputSchema,
} from "./tools.js";
import {
  formatOutput,
  formatDiagnostics,
  formatTranscriberList,
} from "./formatters.js";
import type { TranscriptionSource } from "../../transcription/ITranscriber.js";

process.env.SCRUB_QUIET = "true";

function log(message: string): void {
  process.stderr.write(`[scrub-mcp] ${message}\n`);
}

const VIDEO_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createServer(): Server {
  const server = new Server(
    { name: "scrub", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "scrub_video":
            return await handleScrubVideo(args ?? {});
          case "scrub_playlist":
            return await handleScrubPlaylist(args ?? {});
          case "scrub_doctor":
            return await handleScrubDoctor();
          case "list_transcribers":
            return await handleListTranscribers();
          default:
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                },
              ],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Error in tool ${name}: ${message}`);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message }) },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

async function handleScrubVideo(input: unknown) {
  const parsed = ScrubVideoInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "Invalid input",
            details: parsed.error.format(),
          }),
        },
      ],
      isError: true,
    };
  }

  const {
    url,
    skipVisuals,
    transcriber,
    outputFormat,
    maxFrames,
    sceneThreshold,
    generateSkill,
    skillName,
  } = parsed.data;

  log(`Processing: ${url}`);

  // Route based on input type
  const isLocal = isLocalFilePath(url);

  // Check prerequisites
  const prereqs = isLocal
    ? await checkFilePrerequisites()
    : await checkYouTubePrerequisites();

  if (!prereqs.ready) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "Prerequisites not met",
            missing: prereqs.missing,
            warnings: prereqs.warnings,
            suggestion: "Run scrub_doctor to see full diagnostics",
          }),
        },
      ],
      isError: true,
    };
  }

  const processOptions = {
    skipVisuals,
    transcriber: transcriber as TranscriptionSource | undefined,
    maxFrames,
    sceneThreshold,
    generateSkill,
    skillName,
    onProgress: (progress: { stage: string; message: string }) => {
      log(`[${progress.stage}] ${progress.message}`);
    },
  };

  const result = await withTimeout(
    isLocal
      ? processFile(url, processOptions)
      : processYouTube(url, processOptions),
    VIDEO_PROCESSING_TIMEOUT_MS,
    "Processing"
  );

  log(`Completed: ${result.metadata.title}`);

  const formatted = formatOutput(result, outputFormat ?? "summary");

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(formatted, null, 2) },
    ],
  };
}

async function handleScrubPlaylist(input: unknown) {
  const parsed = ScrubPlaylistInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "Invalid input",
            details: parsed.error.format(),
          }),
        },
      ],
      isError: true,
    };
  }

  const {
    url,
    maxVideos,
    skipVisuals,
    transcriber,
    concurrency,
    continueOnError,
    skipExisting,
  } = parsed.data;

  log(`Processing playlist: ${url}`);

  const prereqs = await checkYouTubePrerequisites();
  if (!prereqs.ready) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "Prerequisites not met",
            missing: prereqs.missing,
            warnings: prereqs.warnings,
          }),
        },
      ],
      isError: true,
    };
  }

  const result = await processYouTubePlaylist(url, {
    maxVideos,
    skipVisuals,
    transcriber: transcriber as TranscriptionSource | undefined,
    concurrency,
    continueOnError,
    skipExisting,
    onStart: (_videos, total) => {
      log(`Found ${total} videos in playlist`);
    },
    onProgress: (contentId, status, stage) => {
      log(`[${contentId}] ${status}${stage ? `: ${stage}` : ""}`);
    },
  });

  log(
    `Completed playlist: ${result.succeeded}/${result.playlist.videoCount} succeeded`
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            playlist: result.playlist,
            succeeded: result.succeeded,
            failed: result.failed,
            skipped: result.skipped,
            videos: result.videos,
            stats: result.stats,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleScrubDoctor() {
  log("Running diagnostics...");
  const diagnostics = await getDiagnostics();
  const formatted = formatDiagnostics(diagnostics);
  log(`Diagnostics complete: ${formatted.ready ? "ready" : "issues found"}`);

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(formatted, null, 2) },
    ],
  };
}

async function handleListTranscribers() {
  log("Listing transcribers...");
  const transcribers = await getTranscriberDiagnostics();
  const formatted = formatTranscriberList(transcribers);
  const available = formatted.filter((t) => t.available).length;
  log(`Found ${available}/${formatted.length} available transcribers`);

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(formatted, null, 2) },
    ],
  };
}

async function main() {
  log("Starting scrub MCP server...");

  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  log("Server connected and ready");

  process.on("SIGINT", async () => {
    log("Received SIGINT, shutting down...");
    await server.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log("Received SIGTERM, shutting down...");
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`Fatal error: ${message}`);
  process.exit(1);
});
