#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { writeFileSync } from "fs";
import { resolve, dirname, relative } from "path";
import { logger, fmt } from "../../utils/logger.js";
import type { CliDependencies } from "./dependencies.js";
import { App } from "./components/App.js";
import type { TranscriptionSource } from "../../infrastructure/transcription/ITranscriber.js";

export async function runCli(
  argv: string[],
  dependencies: CliDependencies
): Promise<void> {
  const {
    config,
    processFile,
    processYouTubePlaylist,
    checkFilePrerequisites,
    checkYouTubePrerequisites,
    getDiagnostics,
    download,
    prepare,
    transcribe,
    getTranscriberDiagnostics,
    extractFrames,
    buildPromptArtifacts,
    renderSummaryFile,
  } = dependencies;
  const program = new Command();

  program
    .name("scrub")
    .description(
      "Turn audio and video content into comprehensive knowledge bases for AI agents"
    )
    .version("0.3.0");

  // ── Orchestrators ──────────────────────────────────────────────────

  program
    .command("youtube")
    .description(
      "Process a YouTube video or playlist through the full pipeline"
    )
    .argument("<url>", "YouTube video or playlist URL")
    .option("-o, --output-dir <path>", "Output directory for artifacts")
    .option(
      "-t, --transcriber <name>",
      "Force specific transcriber (local-whisper, faster-whisper, openai, deepgram, youtube-captions)"
    )
    .option("--no-visuals", "Skip visual analysis")
    .option(
      "--summarize",
      "Run configured vision and summary models after preprocessing"
    )
    .option(
      "--summary-provider <name>",
      "Summary provider registered by the local deployment"
    )
    .option(
      "--summary-model <name>",
      "Allowed summary model (requires --summarize)"
    )
    .option(
      "--vision-provider <name>",
      "Vision provider registered by the local deployment"
    )
    .option(
      "--vision-model <name>",
      "Allowed vision model (requires --summarize)"
    )
    .option(
      "--scene-threshold <number>",
      "Scene detection sensitivity (0-1)",
      parseFloat
    )
    .option("--max-frames <number>", "Maximum frames to extract", parseInt)
    .option("-v, --verbose", "Show detailed progress")
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
      if (options.verbose) logger.setVerbose(true);
      if (options.outputDir) {
        config.setOutputDir(options.outputDir);
      }

      try {
        const prereqs = await checkYouTubePrerequisites();
        if (!prereqs.ready) {
          logger.banner();
          logger.error("Missing prerequisites:");
          for (const missing of prereqs.missing)
            logger.keyValue("  ✗", missing);
          process.exitCode = 1;
          return;
        }
        for (const w of prereqs.warnings) logger.warn(w);

        const { waitUntilExit } = render(
          React.createElement(App, {
            url,
            processPlaylist: processYouTubePlaylist,
            options: {
              skipVisuals: options.visuals === false,
              summarize: options.summarize,
              summaryProvider: options.summaryProvider,
              summaryModel: options.summaryModel,
              visionProvider: options.visionProvider,
              visionModel: options.visionModel,
              transcriber: options.transcriber as
                | TranscriptionSource
                | undefined,
              sceneThreshold: options.sceneThreshold,
              maxFrames: options.maxFrames,
              verbose: options.verbose,
              maxVideos: options.maxVideos ?? 0,
              concurrency: options.parallel ?? 1,
              skipExisting: options.skipExisting !== false,
              continueOnError: true,
            },
            onComplete: (result) => {
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
        process.exitCode = 1;
        return;
      }
    });

  program
    .command("file")
    .description("Process a local .mp3 or .mp4 file through the full pipeline")
    .argument("<path>", "Path to local .mp3 or .mp4 file")
    .option("-o, --output-dir <path>", "Output directory for artifacts")
    .option(
      "-t, --transcriber <name>",
      "Force specific transcriber (local-whisper, faster-whisper, openai, deepgram)"
    )
    .option("--no-visuals", "Skip visual analysis (always skipped for mp3)")
    .option(
      "--summarize",
      "Run configured vision and summary models after preprocessing"
    )
    .option(
      "--summary-provider <name>",
      "Summary provider registered by the local deployment"
    )
    .option(
      "--summary-model <name>",
      "Allowed summary model (requires --summarize)"
    )
    .option(
      "--vision-provider <name>",
      "Vision provider registered by the local deployment"
    )
    .option(
      "--vision-model <name>",
      "Allowed vision model (requires --summarize)"
    )
    .option(
      "--scene-threshold <number>",
      "Scene detection sensitivity (0-1)",
      parseFloat
    )
    .option("--max-frames <number>", "Maximum frames to extract", parseInt)
    .option("-v, --verbose", "Show detailed progress")
    .action(async (filePath: string, options) => {
      if (options.verbose) logger.setVerbose(true);
      if (options.outputDir) {
        config.setOutputDir(options.outputDir);
      }

      try {
        const prereqs = await checkFilePrerequisites();
        if (!prereqs.ready) {
          logger.banner();
          logger.error("Missing prerequisites:");
          for (const missing of prereqs.missing)
            logger.keyValue("  ✗", missing);
          process.exitCode = 1;
          return;
        }
        for (const w of prereqs.warnings) logger.warn(w);

        const result = await processFile(filePath, {
          skipVisuals: options.visuals === false,
          summarize: options.summarize,
          summaryProvider: options.summaryProvider,
          summaryModel: options.summaryModel,
          visionProvider: options.visionProvider,
          visionModel: options.visionModel,
          transcriber: options.transcriber as TranscriptionSource | undefined,
          sceneThreshold: options.sceneThreshold,
          maxFrames: options.maxFrames,
          verbose: options.verbose,
          onProgress: (progress) => {
            logger.info(`[${progress.stage}] ${progress.message}`);
          },
        });

        logger.success(`Processed: ${result.metadata.title}`);
        logger.keyValue("  Prompt", result.promptPath);
        if (result.summaryPath)
          logger.keyValue("  Summary", result.summaryPath);
        logger.keyValue(
          "  Time",
          `${(result.stats.totalTime / 1000).toFixed(1)}s`
        );
      } catch (error) {
        logger.error((error as Error).message);
        process.exitCode = 1;
        return;
      }
    });

  // ── Primitives ─────────────────────────────────────────────────────

  program
    .command("download")
    .description("Download a YouTube video (audio + video + metadata)")
    .argument("<url>", "YouTube video URL")
    .option("-o, --output-dir <dir>", "Output directory", "./download")
    .option("--no-video", "Skip video download (audio only)")
    .action(async (url: string, options) => {
      try {
        const { mkdirSync, existsSync } = await import("fs");
        const outDir = resolve(options.outputDir);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

        const result = await download(url, {
          outputDir: outDir,
          skipVideo: options.video === false,
          onProgress: (msg) => logger.info(msg),
        });

        writeFileSync(
          `${outDir}/metadata.json`,
          JSON.stringify(result.metadata, null, 2)
        );
        logger.success(`Downloaded: ${result.metadata.title}`);
        logger.keyValue("  Audio", result.audioPath);
        if (result.videoPath) logger.keyValue("  Video", result.videoPath);
        logger.keyValue("  Metadata", `${outDir}/metadata.json`);
      } catch (error) {
        logger.error((error as Error).message);
        process.exitCode = 1;
        return;
      }
    });

  program
    .command("prepare")
    .description(
      "Prepare a local .mp3/.mp4 file (extract audio + build metadata)"
    )
    .argument("<path>", "Path to local .mp3 or .mp4 file")
    .option("-o, --output-dir <dir>", "Output directory", "./prepare")
    .option("--no-video", "Skip video reference")
    .action(async (filePath: string, options) => {
      try {
        const { mkdirSync, existsSync } = await import("fs");
        const outDir = resolve(options.outputDir);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

        const result = await prepare(filePath, {
          outputDir: outDir,
          skipVideo: options.video === false,
          onProgress: (msg) => logger.info(msg),
        });

        writeFileSync(
          `${outDir}/metadata.json`,
          JSON.stringify(result.metadata, null, 2)
        );
        logger.success(`Prepared: ${result.metadata.title}`);
        logger.keyValue("  Audio", result.audioPath);
        if (result.videoPath) logger.keyValue("  Video", result.videoPath);
        logger.keyValue("  Metadata", `${outDir}/metadata.json`);
      } catch (error) {
        logger.error((error as Error).message);
        process.exitCode = 1;
        return;
      }
    });

  program
    .command("transcribe")
    .description("Transcribe an audio file")
    .argument("<audio-path>", "Path to audio file (WAV, MP3, etc.)")
    .option(
      "-o, --output <path>",
      "Output path for transcript JSON",
      "./transcript.json"
    )
    .option("--text [path]", "Also output plain text transcript")
    .option("-t, --transcriber <name>", "Force specific transcriber")
    .action(async (audioPath: string, options) => {
      try {
        const textPath =
          typeof options.text === "string"
            ? options.text
            : options.text === true
              ? "./transcript.txt"
              : undefined;

        const result = await transcribe(audioPath, {
          adapter: options.transcriber as TranscriptionSource | undefined,
          outputText: textPath,
          onProgress: (msg) => logger.info(msg),
        });

        const outPath = resolve(options.output);
        writeFileSync(outPath, JSON.stringify(result, null, 2));
        logger.success(`Transcribed using ${result.source}`);
        logger.keyValue("  Output", outPath);
        if (textPath) logger.keyValue("  Text", textPath);
        logger.keyValue("  Duration", `${result.duration.toFixed(1)}s`);
        logger.keyValue("  Segments", String(result.segments.length));
      } catch (error) {
        logger.error((error as Error).message);
        process.exitCode = 1;
        return;
      }
    });

  program
    .command("extract-frames")
    .description("Extract key frames from a video file via scene detection")
    .argument("<video-path>", "Path to video file")
    .option(
      "-o, --output <path>",
      "Output path for the frames manifest JSON",
      "./frames.json"
    )
    .option("--output-dir <dir>", "Directory for extracted frames", "./frames")
    .option(
      "--scene-threshold <number>",
      "Scene detection sensitivity (0-1)",
      parseFloat
    )
    .option("--max-frames <number>", "Maximum frames to extract", parseInt)
    .action(async (videoPath: string, options) => {
      try {
        const { mkdirSync, existsSync } = await import("fs");
        const framesDir = resolve(options.outputDir);
        if (!existsSync(framesDir)) mkdirSync(framesDir, { recursive: true });

        const frames = await extractFrames(videoPath, {
          outputDir: framesDir,
          threshold: options.sceneThreshold,
          maxFrames: options.maxFrames,
          onProgress: (msg) => logger.info(msg),
        });

        const outPath = resolve(options.output);
        const manifest = frames.map((f) => ({
          timestamp: f.timestamp,
          path: relative(dirname(outPath), f.framePath),
          score: f.score,
        }));
        writeFileSync(outPath, JSON.stringify(manifest, null, 2));
        logger.success(`Extracted ${frames.length} frames`);
        logger.keyValue("  Manifest", outPath);
        logger.keyValue("  Frames", framesDir);
      } catch (error) {
        logger.error((error as Error).message);
        process.exitCode = 1;
        return;
      }
    });

  program
    .command("prompt")
    .description(
      "Assemble a model-agnostic summary prompt + output schema from a content file"
    )
    .argument(
      "<file>",
      "Path to content file (.json transcript, .txt, .md, etc.)"
    )
    .option(
      "-o, --output <path>",
      "Output path for the assembled prompt",
      "./summary.prompt.md"
    )
    .option(
      "--schema <path>",
      "Output path for the JSON output schema",
      "./summary.schema.json"
    )
    .option("--metadata <path>", "Path to metadata.json to enrich the prompt")
    .option(
      "--visuals <path>",
      "Path to visual_analysis.json to enrich the prompt"
    )
    .action(async (filePath: string, options) => {
      try {
        const { prompt, schema } = await buildPromptArtifacts(filePath, {
          metadataPath: options.metadata,
          visualsPath: options.visuals,
          onProgress: (msg) => logger.info(msg),
        });

        const promptPath = resolve(options.output);
        const schemaPath = resolve(options.schema);
        writeFileSync(promptPath, prompt);
        writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

        logger.success("Assembled summary prompt");
        logger.keyValue("  Prompt", promptPath);
        logger.keyValue("  Schema", schemaPath);
        logger.info(
          "Send the prompt to any model, then `scrub render` the JSON response."
        );
      } catch (error) {
        logger.error((error as Error).message);
        process.exitCode = 1;
        return;
      }
    });

  program
    .command("render")
    .description(
      "Render a model-produced summary JSON (matching the schema) into markdown"
    )
    .argument("<summary>", "Path to summary JSON")
    .option("-o, --output <path>", "Output path for markdown", "./summary.md")
    .option("--metadata <path>", "Path to metadata.json")
    .option(
      "--transcript <path>",
      "Path to transcript.json to append a full transcript"
    )
    .action(async (summaryPath: string, options) => {
      try {
        const markdown = await renderSummaryFile(summaryPath, {
          metadataPath: options.metadata,
          transcriptPath: options.transcript,
          onProgress: (msg) => logger.info(msg),
        });

        const outPath = resolve(options.output);
        writeFileSync(outPath, markdown);
        logger.success("Rendered summary markdown");
        logger.keyValue("  Output", outPath);
      } catch (error) {
        logger.error((error as Error).message);
        process.exitCode = 1;
        return;
      }
    });

  // ── Utilities ──────────────────────────────────────────────────────

  program
    .command("doctor")
    .description("Check system prerequisites and configuration")
    .action(async () => {
      logger.banner();
      logger.header("System Diagnostics");

      const diag = await getDiagnostics();

      logger.newline();
      logger.info("External Tools:");
      logger.keyValue(
        "  yt-dlp",
        diag.ytdlp ? fmt.green("✓ installed") : fmt.red("✗ not found")
      );
      logger.keyValue(
        "  ffmpeg",
        diag.ffmpeg ? fmt.green("✓ installed") : fmt.red("✗ not found")
      );

      logger.newline();
      logger.info("API Keys (optional — for hosted transcription):");
      logger.keyValue(
        "  OpenAI",
        config.getApiKey("openai")
          ? fmt.green("✓ configured")
          : fmt.dim("○ not set (optional)")
      );
      logger.keyValue(
        "  Deepgram",
        config.getApiKey("deepgram")
          ? fmt.green("✓ configured")
          : fmt.dim("○ not set (optional)")
      );

      logger.newline();
      logger.info("Transcription Adapters:");
      for (const t of diag.transcribers) {
        const status = t.available
          ? fmt.green("✓ available")
          : fmt.dim("○ not available");
        logger.keyValue(`  ${t.name}`, status);
      }

      logger.newline();
      logger.info("Configuration:");
      const configPath = config.getConfigPath();
      logger.keyValue(
        "  Config file",
        configPath ? fmt.path(configPath) : fmt.dim("using defaults")
      );
      logger.keyValue("  Output dir", fmt.path(config.getOutputDir()));
      logger.keyValue("  Cache dir", fmt.path(config.getCacheDir()));

      logger.newline();
      const ready =
        diag.ytdlp && diag.ffmpeg && diag.transcribers.some((t) => t.available);
      if (ready) {
        logger.success("System is ready!");
      } else {
        logger.warn("Some requirements are missing. See above for details.");
        process.exitCode = 1;
      }
    });

  program
    .command("transcribers")
    .description("List available transcription adapters")
    .action(async () => {
      logger.banner();
      logger.header("Transcription Adapters");

      const diag = await getTranscriberDiagnostics();
      for (const t of diag) {
        const status = t.available
          ? fmt.green("✓ Available")
          : fmt.red("✗ Not available");
        const apiNote = t.requiresApiKey ? fmt.dim(" (requires API key)") : "";
        logger.newline();
        logger.info(`${fmt.bold(t.name)}${apiNote}`);
        logger.keyValue("  ID", t.source);
        logger.keyValue("  Status", status);
      }

      logger.newline();
      logger.info(
        "Adapters are tried in priority order. Configure in ~/.scrub/config.json."
      );
    });

  // Parse and run
  await program.parseAsync(argv);
}
