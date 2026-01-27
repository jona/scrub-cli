#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { logger, fmt } from "../../utils/logger.js";
import { config } from "../../infrastructure/Config.js";
import { videoProcessor } from "../../core/VideoProcessor.js";
import { transcriberFactory } from "../../transcription/index.js";
import { App } from "./components/App.js";
import type { TranscriptionSource } from "../../transcription/ITranscriber.js";

const program = new Command();

program
  .name("scrub")
  .description("Convert YouTube videos into comprehensive markdown summaries")
  .version("1.0.0");

/**
 * Main process command
 */
program
  .argument("<url>", "YouTube video or playlist URL to process")
  .option("-o, --output <path>", "Output file path")
  .option(
    "-t, --transcriber <name>",
    "Force specific transcriber (local-whisper, faster-whisper, openai, deepgram, youtube-captions)"
  )
  .option("--no-visuals", "Skip visual analysis (faster, cheaper)")
  .option(
    "--scene-threshold <number>",
    "Scene detection sensitivity (0-1)",
    parseFloat
  )
  .option("--max-frames <number>", "Maximum frames to analyze", parseInt)
  .option("--output-skill", "Generate SKILL.md from video content")
  .option(
    "--skill-name <name>",
    "Custom skill name (auto-derived from title if not provided)"
  )
  .option("-v, --verbose", "Show detailed progress")
  .option("--dry-run", "Check prerequisites without processing")
  // Playlist-specific options
  .option(
    "--max-videos <number>",
    "Maximum videos to process from playlist",
    parseInt
  )
  .option(
    "--parallel <number>",
    "Process N videos in parallel (default: 1)",
    parseInt
  )
  .option("--no-skip-existing", "Reprocess videos that already exist")
  .action(async (url: string, options) => {
    // Set verbose mode
    if (options.verbose) {
      logger.setVerbose(true);
    }

    try {
      // Check prerequisites
      const prereqs = await videoProcessor.checkPrerequisites();

      if (!prereqs.ready) {
        logger.banner();
        logger.error("Missing prerequisites:");
        for (const missing of prereqs.missing) {
          logger.keyValue("  \u2717", missing);
        }
        logger.newline();
        logger.info("Please install the missing dependencies and try again.");
        process.exit(1);
      }

      // Show warnings
      for (const warning of prereqs.warnings) {
        logger.warn(warning);
      }

      // Dry run mode
      if (options.dryRun) {
        logger.banner();
        logger.success("All prerequisites satisfied. Ready to process.");
        const diag = await videoProcessor.getDiagnostics();
        logger.newline();
        logger.header("System Diagnostics");
        logger.keyValue(
          "yt-dlp",
          diag.ytdlp ? "\u2713 installed" : "\u2717 missing"
        );
        logger.keyValue(
          "ffmpeg",
          diag.ffmpeg ? "\u2713 installed" : "\u2717 missing"
        );
        logger.keyValue(
          "Anthropic API",
          diag.anthropicKey ? "\u2713 configured" : "\u2717 missing"
        );
        logger.newline();
        logger.info("Available transcribers:");
        for (const t of diag.transcribers) {
          const status = t.available ? fmt.green("\u2713") : fmt.red("\u2717");
          logger.keyValue(`  ${status}`, t.name);
        }
        return;
      }

      // Process using Ink UI
      const { waitUntilExit } = render(
        React.createElement(App, {
          url,
          options: {
            outputPath: options.output,
            skipVisuals: options.visuals === false,
            transcriber: options.transcriber as TranscriptionSource | undefined,
            sceneThreshold: options.sceneThreshold,
            maxFrames: options.maxFrames,
            generateSkill: options.outputSkill,
            skillName: options.skillName,
            verbose: options.verbose,
            maxVideos: options.maxVideos || 0,
            concurrency: options.parallel || 1,
            skipExisting: options.skipExisting !== false,
            continueOnError: true,
          },
          onComplete: (result) => {
            // Results are displayed by the App component
            process.exitCode = result.failed > 0 ? 1 : 0;
          },
          onError: (error) => {
            console.error(error.message);
            process.exitCode = 1;
          },
        })
      );

      await waitUntilExit();
    } catch (error) {
      logger.error((error as Error).message);
      if (options.verbose) {
        console.error(error);
      }
      process.exit(1);
    }
  });

/**
 * Diagnostics command
 */
program
  .command("doctor")
  .description("Check system prerequisites and configuration")
  .action(async () => {
    logger.banner();
    logger.header("System Diagnostics");

    const diag = await videoProcessor.getDiagnostics();

    // External tools
    logger.newline();
    logger.info("External Tools:");
    logger.keyValue(
      "  yt-dlp",
      diag.ytdlp ? fmt.green("\u2713 installed") : fmt.red("\u2717 not found")
    );
    logger.keyValue(
      "  ffmpeg",
      diag.ffmpeg ? fmt.green("\u2713 installed") : fmt.red("\u2717 not found")
    );

    // API Keys
    logger.newline();
    logger.info("API Keys:");
    logger.keyValue(
      "  ANTHROPIC_API_KEY",
      diag.anthropicKey
        ? fmt.green("\u2713 configured")
        : fmt.red("\u2717 missing")
    );
    logger.keyValue(
      "  OPENAI_API_KEY",
      config.getApiKey("openai")
        ? fmt.green("\u2713 configured")
        : fmt.dim("\u25CB not set (optional)")
    );
    logger.keyValue(
      "  DEEPGRAM_API_KEY",
      config.getApiKey("deepgram")
        ? fmt.green("\u2713 configured")
        : fmt.dim("\u25CB not set (optional)")
    );

    // Transcribers
    logger.newline();
    logger.info("Transcription Adapters:");
    for (const t of diag.transcribers) {
      const status = t.available
        ? fmt.green("\u2713 available")
        : fmt.dim("\u25CB not available");
      logger.keyValue(`  ${t.name}`, status);
    }

    // Config
    logger.newline();
    logger.info("Configuration:");
    const configPath = config.getConfigPath();
    logger.keyValue(
      "  Config file",
      configPath ? fmt.path(configPath) : fmt.dim("using defaults")
    );
    logger.keyValue("  Output dir", fmt.path(config.getOutputDir()));
    logger.keyValue("  Artifacts", fmt.dim("stored in .output/{videoId}/"));

    // Summary
    logger.newline();
    const ready =
      diag.ytdlp &&
      diag.ffmpeg &&
      diag.anthropicKey &&
      diag.transcribers.some((t) => t.available);

    if (ready) {
      logger.success("System is ready to process videos!");
    } else {
      logger.warn("Some requirements are missing. See above for details.");

      if (!diag.ytdlp) {
        logger.newline();
        logger.info("Install yt-dlp:");
        logger.info("  brew install yt-dlp");
        logger.info("  # or: pip install yt-dlp");
      }

      if (!diag.ffmpeg) {
        logger.newline();
        logger.info("Install ffmpeg:");
        logger.info("  brew install ffmpeg");
      }

      if (!diag.anthropicKey) {
        logger.newline();
        logger.info("Set Anthropic API key:");
        logger.info("  export ANTHROPIC_API_KEY=sk-ant-...");
      }
    }
  });

/**
 * List transcribers command
 */
program
  .command("transcribers")
  .description("List available transcription adapters")
  .action(async () => {
    logger.banner();
    logger.header("Transcription Adapters");

    const diag = await transcriberFactory.getDiagnostics();

    for (const t of diag) {
      const status = t.available
        ? fmt.green("\u2713 Available")
        : fmt.red("\u2717 Not available");
      const apiNote = t.requiresApiKey ? fmt.dim(" (requires API key)") : "";

      logger.newline();
      logger.info(`${fmt.bold(t.name)}${apiNote}`);
      logger.keyValue("  ID", t.source);
      logger.keyValue("  Status", status);
    }

    logger.newline();
    logger.info(
      "Adapters are tried in priority order. Configure in scrub.config.json."
    );
  });

// Parse and run
program.parse();
