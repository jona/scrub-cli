#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { logger, fmt } from "../../utils/logger.js";
import { config } from "../../infrastructure/Config.js";
import {
  checkYouTubePrerequisites,
  getDiagnostics,
} from "../../orchestrators/youtube.js";
import {
  processFile,
  checkFilePrerequisites,
} from "../../orchestrators/file.js";
import { download } from "../../core/download.js";
import { prepare } from "../../core/prepare.js";
import {
  transcribe,
  getTranscriberDiagnostics,
} from "../../core/transcribe.js";
import { analyzeVisuals } from "../../core/analyze-visuals.js";
import { summarize } from "../../core/summarize.js";
import { artifactStore } from "../../services/ArtifactStore.js";
import { App } from "./components/App.js";
import type { TranscriptionSource } from "../../transcription/ITranscriber.js";

const program = new Command();

program
  .name("scrub")
  .description(
    "Turn audio and video content into comprehensive knowledge bases for AI agents"
  )
  .version("0.2.1");

// ── Orchestrators ──────────────────────────────────────────────────

program
  .command("youtube")
  .description("Process a YouTube video or playlist through the full pipeline")
  .argument("<url>", "YouTube video or playlist URL")
  .option("-o, --output-dir <path>", "Output directory for artifacts")
  .option(
    "-t, --transcriber <name>",
    "Force specific transcriber (local-whisper, faster-whisper, openai, deepgram, youtube-captions)"
  )
  .option("--no-visuals", "Skip visual analysis")
  .option(
    "--scene-threshold <number>",
    "Scene detection sensitivity (0-1)",
    parseFloat
  )
  .option("--max-frames <number>", "Maximum frames to analyze", parseInt)
  .option("--skill", "Generate SKILL.md from content")
  .option("--skill-name <name>", "Custom skill name")
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
      artifactStore.reinitialize();
    }

    try {
      const prereqs = await checkYouTubePrerequisites();
      if (!prereqs.ready) {
        logger.banner();
        logger.error("Missing prerequisites:");
        for (const missing of prereqs.missing) logger.keyValue("  ✗", missing);
        process.exit(1);
      }
      for (const w of prereqs.warnings) logger.warn(w);

      const { waitUntilExit } = render(
        React.createElement(App, {
          url,
          options: {
            skipVisuals: options.visuals === false,
            transcriber: options.transcriber as TranscriptionSource | undefined,
            sceneThreshold: options.sceneThreshold,
            maxFrames: options.maxFrames,
            generateSkill: options.skill,
            skillName: options.skillName,
            verbose: options.verbose,
            maxVideos: options.maxVideos || 0,
            concurrency: options.parallel || 1,
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
      process.exit(1);
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
    "--scene-threshold <number>",
    "Scene detection sensitivity (0-1)",
    parseFloat
  )
  .option("--max-frames <number>", "Maximum frames to analyze", parseInt)
  .option("--skill", "Generate SKILL.md from content")
  .option("--skill-name <name>", "Custom skill name")
  .option("-v, --verbose", "Show detailed progress")
  .action(async (filePath: string, options) => {
    if (options.verbose) logger.setVerbose(true);
    if (options.outputDir) {
      config.setOutputDir(options.outputDir);
      artifactStore.reinitialize();
    }

    try {
      const prereqs = await checkFilePrerequisites();
      if (!prereqs.ready) {
        logger.banner();
        logger.error("Missing prerequisites:");
        for (const missing of prereqs.missing) logger.keyValue("  ✗", missing);
        process.exit(1);
      }
      for (const w of prereqs.warnings) logger.warn(w);

      const result = await processFile(filePath, {
        skipVisuals: options.visuals === false,
        transcriber: options.transcriber as TranscriptionSource | undefined,
        sceneThreshold: options.sceneThreshold,
        maxFrames: options.maxFrames,
        generateSkill: options.skill,
        skillName: options.skillName,
        verbose: options.verbose,
        onProgress: (progress) => {
          logger.info(`[${progress.stage}] ${progress.message}`);
        },
      });

      logger.success(`Processed: ${result.metadata.title}`);
      logger.keyValue("  Output", result.outputPath);
      if (result.skillPath) logger.keyValue("  Skill", result.skillPath);
      logger.keyValue(
        "  Time",
        `${(result.stats.totalTime / 1000).toFixed(1)}s`
      );
    } catch (error) {
      logger.error((error as Error).message);
      process.exit(1);
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
      process.exit(1);
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
      process.exit(1);
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
      process.exit(1);
    }
  });

program
  .command("analyze-visuals")
  .description("Analyze visual content from a video file")
  .argument("<video-path>", "Path to video file")
  .option(
    "-o, --output <path>",
    "Output path for visual analysis JSON",
    "./visual_analysis.json"
  )
  .option("--output-dir <dir>", "Directory for extracted frames", "./frames")
  .option(
    "--scene-threshold <number>",
    "Scene detection sensitivity (0-1)",
    parseFloat
  )
  .option("--max-frames <number>", "Maximum frames to analyze", parseInt)
  .action(async (videoPath: string, options) => {
    try {
      const { mkdirSync, existsSync } = await import("fs");
      const framesDir = resolve(options.outputDir);
      if (!existsSync(framesDir)) mkdirSync(framesDir, { recursive: true });

      const result = await analyzeVisuals(videoPath, {
        outputDir: framesDir,
        threshold: options.sceneThreshold,
        maxFrames: options.maxFrames,
        onProgress: (msg) => logger.info(msg),
      });

      const outPath = resolve(options.output);
      writeFileSync(outPath, JSON.stringify(result, null, 2));
      logger.success(`Analyzed ${result.length} frames`);
      logger.keyValue("  Output", outPath);
      logger.keyValue("  Frames", framesDir);
    } catch (error) {
      logger.error((error as Error).message);
      process.exit(1);
    }
  });

program
  .command("summarize")
  .description(
    "Summarize content from any file (.json transcript, .txt, .md, etc.)"
  )
  .argument("<file>", "Path to content file")
  .option(
    "-o, --output <path>",
    "Output path for summary JSON",
    "./summary.json"
  )
  .option("--markdown [path]", "Also output markdown summary")
  .option("--skill", "Also output SKILL.md")
  .option("--skill-name <name>", "Custom skill name (implies --skill)")
  .option("--metadata <path>", "Path to metadata.json to enrich summary")
  .option("--visuals <path>", "Path to visual_analysis.json to enrich summary")
  .option(
    "--transcript <path>",
    "Path to transcript.json (for skill generation)"
  )
  .action(async (filePath: string, options) => {
    try {
      const mdPath =
        typeof options.markdown === "string"
          ? options.markdown
          : options.markdown === true
            ? "./summary.md"
            : undefined;

      const result = await summarize(filePath, {
        metadataPath: options.metadata,
        visualsPath: options.visuals,
        transcriptPath: options.transcript,
        outputMarkdown: !!mdPath,
        outputSkill: options.skill || !!options.skillName,
        skillName: options.skillName,
        onProgress: (msg) => logger.info(msg),
      });

      const outPath = resolve(options.output);
      writeFileSync(outPath, JSON.stringify(result.summary, null, 2));
      logger.success(`Summarized: ${result.summary.title}`);
      logger.keyValue("  Output", outPath);

      if (result.markdown && mdPath) {
        writeFileSync(resolve(mdPath), result.markdown);
        logger.keyValue("  Markdown", mdPath);
      }

      if (result.skill) {
        const skillPath = resolve(dirname(outPath), "SKILL.md");
        writeFileSync(skillPath, result.skill.skillMd);
        logger.keyValue("  Skill", skillPath);
      }
    } catch (error) {
      logger.error((error as Error).message);
      process.exit(1);
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
    logger.info("API Keys:");
    const anthropicLabel = !diag.anthropicKey
      ? fmt.red("✗ missing")
      : diag.anthropicAuth.ok
        ? fmt.green("✓ authenticated")
        : fmt.red(`✗ auth failed (${diag.anthropicAuth.error})`);
    logger.keyValue("  Anthropic", anthropicLabel);
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
      diag.ytdlp &&
      diag.ffmpeg &&
      diag.anthropicKey &&
      diag.anthropicAuth.ok &&
      diag.transcribers.some((t) => t.available);
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
program.parse();
