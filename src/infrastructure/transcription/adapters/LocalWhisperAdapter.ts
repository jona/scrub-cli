import {
  adapterEnvironment,
  type AdapterEnvironmentOptions,
} from "../environment.js";
import { existsSync } from "fs";
import { readFile, mkdir, mkdtemp, rm, stat } from "fs/promises";
import { PipelineError } from "../../../core/errors.js";
import { join } from "path";
import { homedir } from "os";
import { commandExists, runCommand } from "../../../utils/helpers.js";
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
} from "../ITranscriber.js";

/**
 * Adapter for local Whisper transcription using whisper.cpp
 *
 * Requires whisper.cpp to be installed and available in PATH as 'whisper'
 * or via localWhisper.binaryPath in ~/.scrub/config.json.
 */
export class LocalWhisperAdapter implements ITranscriber {
  readonly name = "Local Whisper (whisper.cpp)";
  constructor(private readonly environment: AdapterEnvironmentOptions) {}
  readonly requiresApiKey = false;

  private whisperPath: string | null = null;

  /**
   * Check if whisper.cpp is available
   */
  async isAvailable(options?: TranscriptionOptions): Promise<boolean> {
    const { config, runtime } = await adapterEnvironment(this.environment);
    const localWhisperConfig = config.getLocalWhisper();

    // Check configured binary path first
    if (localWhisperConfig.binaryPath) {
      const binaryPath = config.resolvePath(localWhisperConfig.binaryPath);
      if (existsSync(binaryPath)) {
        this.whisperPath = binaryPath;
        return true;
      }
    }

    // Check common command names
    const commands = runtime
      ? [runtime.whisperBinaryPath ?? "whisper"]
      : ["whisper", "whisper-cpp", "main"];
    for (const cmd of commands) {
      if (await commandExists(cmd, options)) {
        this.whisperPath = cmd;
        return true;
      }
    }

    if (runtime) return false;

    // Check common installation paths
    const commonPaths = [
      "/usr/local/bin/whisper",
      "/opt/homebrew/bin/whisper",
      join(homedir(), "whisper.cpp/main"),
      join(homedir(), ".local/bin/whisper"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        this.whisperPath = path;
        return true;
      }
    }

    return false;
  }

  /**
   * Transcribe audio using whisper.cpp
   */
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const { config, logger, runtime } = await adapterEnvironment(
      this.environment
    );
    if (!this.whisperPath) {
      const available = await this.isAvailable(options);
      if (!available) {
        throw new Error(
          "whisper.cpp is not installed. See https://github.com/ggerganov/whisper.cpp for installation instructions."
        );
      }
    }

    const transcriptionConfig = config.getTranscription();
    const model = options?.model || transcriptionConfig.whisperModel;
    const language = options?.language || transcriptionConfig.language;

    // Determine model path
    const modelPath = await this.getModelPath(model);
    if (!modelPath) {
      throw new Error(
        `Whisper model '${model}' not found. Download it using whisper.cpp's download-ggml-model.sh script.`
      );
    }

    // Create temp directory for output
    await mkdir(config.getCacheDir(), { recursive: true });
    const tempDir = await mkdtemp(join(config.getCacheDir(), "whisper-"));
    try {
      const outputBase = join(tempDir, "transcript");

      logger.debug(`Running whisper.cpp with model: ${model}`);

      // Build command arguments
      const args = [
        "-m",
        modelPath,
        "-f",
        audioPath,
        "-of",
        outputBase,
        "-l",
        language,
        "--output-json",
        "--no-prints", // Suppress progress output
      ];

      if (options?.wordTimestamps) {
        args.push("--word-timestamps");
      }

      // Run whisper.cpp
      const result = await (runtime?.runCommand ?? runCommand)(
        this.whisperPath!,
        args,
        { ...options, stdoutMode: "tail" }
      );

      if (result.code !== 0) {
        throw new Error(`Whisper transcription failed: ${result.stderr}`);
      }

      // Read the JSON output
      const jsonPath = `${outputBase}.json`;
      if (!existsSync(jsonPath)) {
        throw new Error("Whisper did not produce expected output file");
      }

      if (
        (await stat(jsonPath)).size >
        (options?.maxOutputBytes ?? 10 * 1024 * 1024)
      )
        throw new PipelineError(
          "resource_limit",
          "Whisper output exceeds the configured limit"
        );
      const rawOutput = await readFile(jsonPath, "utf-8");
      const whisperOutput = JSON.parse(rawOutput) as WhisperOutput;

      // Convert to our format
      return this.parseWhisperOutput(whisperOutput, "local-whisper");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Get the path to a whisper model file
   */
  private async getModelPath(model: string): Promise<string | null> {
    const modelFileName = `ggml-${model}.bin`;
    const { config, runtime } = await adapterEnvironment(this.environment);
    const localWhisperConfig = config.getLocalWhisper();
    if (!/^[A-Za-z0-9._-]+$/.test(model))
      throw new Error("Invalid local model name");

    // Check common model locations
    const configuredModelsPath = localWhisperConfig.modelsPath
      ? config.resolvePath(localWhisperConfig.modelsPath)
      : undefined;

    const searchPaths = [
      // Configured model directory
      configuredModelsPath,
      ...(runtime
        ? []
        : [
            // Common whisper.cpp paths
            join(homedir(), "whisper.cpp/models"),
            join(homedir(), ".cache/whisper"),
            "/usr/local/share/whisper/models",
            "./models",
          ]),
    ].filter(Boolean) as string[];

    for (const basePath of searchPaths) {
      const modelPath = join(basePath, modelFileName);
      if (existsSync(modelPath)) {
        return modelPath;
      }
    }

    return null;
  }

  /**
   * Parse whisper.cpp JSON output to our format
   */
  private parseWhisperOutput(
    output: WhisperOutput,
    source: "local-whisper"
  ): TranscriptionResult {
    const segments: TranscriptSegment[] = output.transcription.map((seg) => ({
      start: seg.offsets.from / 1000, // Convert ms to seconds
      end: seg.offsets.to / 1000,
      text: seg.text.trim(),
      confidence: seg.confidence,
    }));

    const fullText = segments.map((s) => s.text).join(" ");
    const duration =
      segments.length > 0 ? segments[segments.length - 1].end : 0;

    return {
      segments,
      fullText,
      language: output.result?.language || "en",
      duration,
      source,
    };
  }
}

/**
 * Whisper.cpp JSON output format
 */
interface WhisperOutput {
  transcription: Array<{
    text: string;
    offsets: {
      from: number;
      to: number;
    };
    confidence?: number;
  }>;
  result?: {
    language: string;
  };
}
