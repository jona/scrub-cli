import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { config } from "../../infrastructure/Config.js";
import { logger } from "../../utils/logger.js";
import { commandExists, runCommand, ensureDir } from "../../utils/helpers.js";
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
 * or via the WHISPER_CPP_PATH environment variable.
 */
export class LocalWhisperAdapter implements ITranscriber {
  readonly name = "Local Whisper (whisper.cpp)";
  readonly requiresApiKey = false;

  private whisperPath: string | null = null;

  /**
   * Check if whisper.cpp is available
   */
  async isAvailable(): Promise<boolean> {
    // Check environment variable first
    if (process.env.WHISPER_CPP_PATH) {
      if (existsSync(process.env.WHISPER_CPP_PATH)) {
        this.whisperPath = process.env.WHISPER_CPP_PATH;
        return true;
      }
    }

    // Check common command names
    const commands = ["whisper", "whisper-cpp", "main"];
    for (const cmd of commands) {
      if (await commandExists(cmd)) {
        this.whisperPath = cmd;
        return true;
      }
    }

    // Check common installation paths
    const commonPaths = [
      "/usr/local/bin/whisper",
      "/opt/homebrew/bin/whisper",
      join(process.env.HOME || "", "whisper.cpp/main"),
      join(process.env.HOME || "", ".local/bin/whisper"),
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
    if (!this.whisperPath) {
      const available = await this.isAvailable();
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
    const tempDir = join(config.getCacheDir(), "whisper-temp");
    ensureDir(tempDir);
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
    const result = await runCommand(this.whisperPath!, args);

    if (result.code !== 0) {
      throw new Error(`Whisper transcription failed: ${result.stderr}`);
    }

    // Read the JSON output
    const jsonPath = `${outputBase}.json`;
    if (!existsSync(jsonPath)) {
      throw new Error("Whisper did not produce expected output file");
    }

    const rawOutput = await readFile(jsonPath, "utf-8");
    const whisperOutput = JSON.parse(rawOutput) as WhisperOutput;

    // Convert to our format
    return this.parseWhisperOutput(whisperOutput, "local-whisper");
  }

  /**
   * Get the path to a whisper model file
   */
  private async getModelPath(model: string): Promise<string | null> {
    const modelFileName = `ggml-${model}.bin`;

    // Check common model locations
    const searchPaths = [
      // Environment variable
      process.env.WHISPER_MODELS_PATH,
      // Common whisper.cpp paths
      join(process.env.HOME || "", "whisper.cpp/models"),
      join(process.env.HOME || "", ".cache/whisper"),
      "/usr/local/share/whisper/models",
      "./models",
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
