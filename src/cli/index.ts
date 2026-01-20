#!/usr/bin/env node

import { Command } from 'commander';
import { logger, fmt } from '../utils/logger.js';
import { config } from '../core/Config.js';
import { videoProcessor } from '../core/VideoProcessor.js';
import { transcriberFactory } from '../adapters/transcription/index.js';
import type { TranscriptionSource } from '../adapters/transcription/ITranscriber.js';

const program = new Command();

program
  .name('scrub')
  .description('Convert YouTube videos into comprehensive markdown summaries')
  .version('1.0.0');

/**
 * Main process command
 */
program
  .argument('<url>', 'YouTube video URL to process')
  .option('-o, --output <path>', 'Output file path')
  .option(
    '-t, --transcriber <name>',
    'Force specific transcriber (local-whisper, faster-whisper, openai, deepgram, youtube-captions)'
  )
  .option('--no-visuals', 'Skip visual analysis (faster, cheaper)')
  .option(
    '--scene-threshold <number>',
    'Scene detection sensitivity (0-1)',
    parseFloat
  )
  .option(
    '--max-frames <number>',
    'Maximum frames to analyze',
    parseInt
  )
  .option('-v, --verbose', 'Show detailed progress')
  .option('--dry-run', 'Check prerequisites without processing')
  .action(async (url: string, options) => {
    logger.banner();

    // Set verbose mode
    if (options.verbose) {
      logger.setVerbose(true);
    }

    try {
      // Check prerequisites
      const prereqs = await videoProcessor.checkPrerequisites();

      if (!prereqs.ready) {
        logger.error('Missing prerequisites:');
        for (const missing of prereqs.missing) {
          logger.keyValue('  ✗', missing);
        }
        logger.newline();
        logger.info('Please install the missing dependencies and try again.');
        process.exit(1);
      }

      // Show warnings
      for (const warning of prereqs.warnings) {
        logger.warn(warning);
      }

      // Dry run mode
      if (options.dryRun) {
        logger.success('All prerequisites satisfied. Ready to process.');
        const diag = await videoProcessor.getDiagnostics();
        logger.newline();
        logger.header('System Diagnostics');
        logger.keyValue('yt-dlp', diag.ytdlp ? '✓ installed' : '✗ missing');
        logger.keyValue('ffmpeg', diag.ffmpeg ? '✓ installed' : '✗ missing');
        logger.keyValue(
          'Anthropic API',
          diag.anthropicKey ? '✓ configured' : '✗ missing'
        );
        logger.newline();
        logger.info('Available transcribers:');
        for (const t of diag.transcribers) {
          const status = t.available ? fmt.green('✓') : fmt.red('✗');
          logger.keyValue(`  ${status}`, t.name);
        }
        return;
      }

      // Process the video
      logger.info(`Processing: ${fmt.url(url)}`);
      logger.newline();

      const startTime = Date.now();

      logger.startSpinner('Starting...');

      const result = await videoProcessor.process(url, {
        outputPath: options.output,
        skipVisuals: options.visuals === false,
        transcriber: options.transcriber as TranscriptionSource | undefined,
        sceneThreshold: options.sceneThreshold,
        maxFrames: options.maxFrames,
        verbose: options.verbose,
        onProgress: (progress) => {
          logger.updateSpinner(progress.message);
        },
      });

      logger.stopSpinnerSuccess('Processing complete!');

      // Show results
      logger.newline();
      logger.header('Results');
      logger.keyValue('Title', result.metadata.title);
      logger.keyValue('Duration', fmt.time(result.metadata.duration));
      logger.keyValue('Transcription', result.transcript.source);
      logger.keyValue('Frames analyzed', String(result.visuals.length));
      logger.keyValue('Sections', String(result.summary.sections.length));
      logger.keyValue('Output', fmt.path(result.outputPath));

      logger.newline();
      logger.header('Timing');
      logger.keyValue('Download', fmt.duration(result.stats.downloadTime));
      logger.keyValue('Transcription', fmt.duration(result.stats.transcriptionTime));
      logger.keyValue('Visual analysis', fmt.duration(result.stats.visualAnalysisTime));
      logger.keyValue('Summarization', fmt.duration(result.stats.summarizationTime));
      logger.keyValue('Total', fmt.duration(Date.now() - startTime));

      logger.newline();
      logger.success(`Summary saved to: ${fmt.path(result.outputPath)}`);
    } catch (error) {
      logger.stopSpinnerFail('Processing failed');
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
  .command('doctor')
  .description('Check system prerequisites and configuration')
  .action(async () => {
    logger.banner();
    logger.header('System Diagnostics');

    const diag = await videoProcessor.getDiagnostics();

    // External tools
    logger.newline();
    logger.info('External Tools:');
    logger.keyValue(
      '  yt-dlp',
      diag.ytdlp ? fmt.green('✓ installed') : fmt.red('✗ not found')
    );
    logger.keyValue(
      '  ffmpeg',
      diag.ffmpeg ? fmt.green('✓ installed') : fmt.red('✗ not found')
    );

    // API Keys
    logger.newline();
    logger.info('API Keys:');
    logger.keyValue(
      '  ANTHROPIC_API_KEY',
      diag.anthropicKey ? fmt.green('✓ configured') : fmt.red('✗ missing')
    );
    logger.keyValue(
      '  OPENAI_API_KEY',
      config.getApiKey('openai')
        ? fmt.green('✓ configured')
        : fmt.dim('○ not set (optional)')
    );
    logger.keyValue(
      '  DEEPGRAM_API_KEY',
      config.getApiKey('deepgram')
        ? fmt.green('✓ configured')
        : fmt.dim('○ not set (optional)')
    );

    // Transcribers
    logger.newline();
    logger.info('Transcription Adapters:');
    for (const t of diag.transcribers) {
      const status = t.available
        ? fmt.green('✓ available')
        : fmt.dim('○ not available');
      logger.keyValue(`  ${t.name}`, status);
    }

    // Config
    logger.newline();
    logger.info('Configuration:');
    const configPath = config.getConfigPath();
    logger.keyValue(
      '  Config file',
      configPath ? fmt.path(configPath) : fmt.dim('using defaults')
    );
    logger.keyValue('  Output dir', fmt.path(config.getOutputDir()));
    logger.keyValue('  Cache dir', fmt.path(config.getCacheDir()));

    // Summary
    logger.newline();
    const ready =
      diag.ytdlp &&
      diag.ffmpeg &&
      diag.anthropicKey &&
      diag.transcribers.some((t) => t.available);

    if (ready) {
      logger.success('System is ready to process videos!');
    } else {
      logger.warn('Some requirements are missing. See above for details.');

      if (!diag.ytdlp) {
        logger.newline();
        logger.info('Install yt-dlp:');
        logger.info('  brew install yt-dlp');
        logger.info('  # or: pip install yt-dlp');
      }

      if (!diag.ffmpeg) {
        logger.newline();
        logger.info('Install ffmpeg:');
        logger.info('  brew install ffmpeg');
      }

      if (!diag.anthropicKey) {
        logger.newline();
        logger.info('Set Anthropic API key:');
        logger.info('  export ANTHROPIC_API_KEY=sk-ant-...');
      }
    }
  });

/**
 * List transcribers command
 */
program
  .command('transcribers')
  .description('List available transcription adapters')
  .action(async () => {
    logger.banner();
    logger.header('Transcription Adapters');

    const diag = await transcriberFactory.getDiagnostics();

    for (const t of diag) {
      const status = t.available
        ? fmt.green('✓ Available')
        : fmt.red('✗ Not available');
      const apiNote = t.requiresApiKey ? fmt.dim(' (requires API key)') : '';

      logger.newline();
      logger.info(`${fmt.bold(t.name)}${apiNote}`);
      logger.keyValue('  ID', t.source);
      logger.keyValue('  Status', status);
    }

    logger.newline();
    logger.info('Adapters are tried in priority order. Configure in scrub.config.json.');
  });

// Parse and run
program.parse();
