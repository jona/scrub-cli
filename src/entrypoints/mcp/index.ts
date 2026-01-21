#!/usr/bin/env node

/**
 * Scrub MCP Server
 *
 * Exposes scrub video processing capabilities to Claude Code agents
 * via the Model Context Protocol (MCP).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { videoProcessor } from "../../core/VideoProcessor.js";
import { transcriberFactory } from "../../transcription/index.js";
import { TOOL_DEFINITIONS, ScrubVideoInputSchema } from "./tools.js";
import {
  formatOutput,
  formatDiagnostics,
  formatTranscriberList,
} from "./formatters.js";
import type { TranscriptionSource } from "../../transcription/ITranscriber.js";

// Suppress console logging in MCP mode - must be set before logger is used
// The logger checks this env var to avoid polluting stdout (JSON-RPC channel)
process.env.SCRUB_QUIET = "true";

/**
 * Log to stderr (safe in MCP - doesn't interfere with JSON-RPC on stdout)
 */
function log(message: string): void {
  process.stderr.write(`[scrub-mcp] ${message}\n`);
}

/**
 * Default timeout for video processing (10 minutes)
 * Video processing can take a while for long videos
 */
const VIDEO_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Wrap a promise with a timeout
 */
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

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: "scrub",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    };
  });

  // Register tool call handler
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "scrub_video":
            return await handleScrubVideo(args ?? {});

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
            {
              type: "text" as const,
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

/**
 * Handle scrub_video tool call
 */
async function handleScrubVideo(input: unknown) {
  // Validate input
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

  log(`Processing video: ${url}`);

  // Check prerequisites first
  const prereqs = await videoProcessor.checkPrerequisites();
  if (!prereqs.ready) {
    log(`Prerequisites not met: ${prereqs.missing.join(", ")}`);
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

  // Process the video with progress logging and timeout
  const result = await withTimeout(
    videoProcessor.process(url, {
      skipVisuals,
      transcriber: transcriber as TranscriptionSource | undefined,
      maxFrames,
      sceneThreshold,
      generateSkill,
      skillName,
      onProgress: (progress) => {
        log(`[${progress.stage}] ${progress.message}`);
      },
    }),
    VIDEO_PROCESSING_TIMEOUT_MS,
    "Video processing"
  );

  log(`Completed processing: ${result.metadata.title}`);

  // Format output based on requested format
  const formatted = formatOutput(result, outputFormat ?? "summary");

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(formatted, null, 2),
      },
    ],
  };
}

/**
 * Handle scrub_doctor tool call
 */
async function handleScrubDoctor() {
  log("Running diagnostics...");
  const diagnostics = await videoProcessor.getDiagnostics();
  const formatted = formatDiagnostics(diagnostics);
  log(`Diagnostics complete: ${formatted.ready ? "ready" : "issues found"}`);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(formatted, null, 2),
      },
    ],
  };
}

/**
 * Handle list_transcribers tool call
 */
async function handleListTranscribers() {
  log("Listing transcribers...");
  const transcribers = await transcriberFactory.getDiagnostics();
  const formatted = formatTranscriberList(transcribers);
  const available = formatted.filter((t) => t.available).length;
  log(`Found ${available}/${formatted.length} available transcribers`);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(formatted, null, 2),
      },
    ],
  };
}

/**
 * Main entry point
 */
async function main() {
  log("Starting scrub MCP server...");

  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  log("Server connected and ready");

  // Handle graceful shutdown
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
