import {
  adapterEnvironment,
  type AdapterEnvironmentOptions,
} from "../environment.js";
import { existsSync, writeFileSync } from "fs";
import { readFile, mkdir, mkdtemp, rm, stat } from "fs/promises";
import { PipelineError } from "../../../core/errors.js";
import { join } from "path";
import { commandExists, runCommand } from "../../../utils/helpers.js";
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
} from "../ITranscriber.js";

/**
 * Adapter for faster-whisper Python package
 *
 * Requires Python 3.8+ and faster-whisper package:
 * pip install faster-whisper
 */
export class FasterWhisperAdapter implements ITranscriber {
  readonly name = "Faster Whisper (Python)";
  constructor(private readonly environment: AdapterEnvironmentOptions) {}
  readonly requiresApiKey = false;

  private pythonPath: string | null = null;

  /**
   * Check if faster-whisper is available
   */
  async isAvailable(options?: TranscriptionOptions): Promise<boolean> {
    const { runtime } = await adapterEnvironment(this.environment);
    // Find Python - check multiple locations since faster-whisper might be
    // installed in a different Python than the default
    const pythonCommands = runtime
      ? [runtime.pythonPath ?? "python3"]
      : [
          "python3",
          "python",
          "/usr/bin/python3", // macOS system Python (often has user packages)
          "python3.9",
          "python3.10",
          "python3.11",
          "python3.12",
        ];

    for (const cmd of pythonCommands) {
      // Check if command exists (for PATH commands) or file exists (for absolute paths)
      const exists = cmd.startsWith("/")
        ? existsSync(cmd)
        : await commandExists(cmd, options);

      if (exists) {
        // Check if faster-whisper is installed
        try {
          const result = await (runtime?.runCommand ?? runCommand)(
            cmd,
            ["-c", 'import faster_whisper; print("ok")'],
            {
              ...options,
              timeoutMs: Math.min(options?.timeoutMs ?? 5000, 5000),
            }
          );
          if (result.code === 0 && result.stdout.includes("ok")) {
            this.pythonPath = cmd;
            return true;
          }
        } catch {
          continue;
        }
      }
    }

    return false;
  }

  /**
   * Transcribe audio using faster-whisper
   */
  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const { config, logger, runtime } = await adapterEnvironment(
      this.environment
    );
    if (!this.pythonPath) {
      const available = await this.isAvailable(options);
      if (!available) {
        throw new Error(
          "faster-whisper is not installed. Install with: pip install faster-whisper"
        );
      }
    }

    const transcriptionConfig = config.getTranscription();
    const model = options?.model || transcriptionConfig.whisperModel;
    const language = options?.language || transcriptionConfig.language;

    // Create temp directory for output
    await mkdir(config.getCacheDir(), { recursive: true });
    const tempDir = await mkdtemp(
      join(config.getCacheDir(), "faster-whisper-")
    );
    const outputPath = join(tempDir, "transcript.json");

    logger.debug(`Running faster-whisper with model: ${model}`);

    // Create Python script for transcription
    const pythonScript = this.generatePythonScript();

    const scriptPath = join(tempDir, "transcribe.py");
    writeFileSync(scriptPath, pythonScript);

    try {
      // Run the Python script
      const requestPath = join(tempDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify({
          audioPath,
          outputPath,
          model,
          language,
          wordTimestamps: options?.wordTimestamps ?? false,
        })
      );
      const result = await (runtime?.runCommand ?? runCommand)(
        this.pythonPath!,
        [scriptPath, requestPath],
        { ...options, stdoutMode: "tail" }
      );

      if (result.code !== 0) {
        throw new Error(
          `Faster-whisper transcription failed: ${result.stderr}`
        );
      }

      // Read the JSON output
      if (!existsSync(outputPath)) {
        throw new Error("Faster-whisper did not produce expected output file");
      }

      if (
        (await stat(outputPath)).size >
        (options?.maxOutputBytes ?? 10 * 1024 * 1024)
      )
        throw new PipelineError(
          "resource_limit",
          "Whisper output exceeds the configured limit"
        );
      const rawOutput = await readFile(outputPath, "utf-8");
      const whisperOutput = JSON.parse(rawOutput) as FasterWhisperOutput;

      return this.parseOutput(whisperOutput);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Generate Python script for transcription
   */
  private generatePythonScript(): string {
    return `
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as request_file:
    request = json.load(request_file)
from faster_whisper import WhisperModel

# Initialize model
model = WhisperModel(request["model"], device="auto", compute_type="auto")

# Transcribe
segments, info = model.transcribe(
    request["audioPath"],
    language=request["language"] if request["language"] != "auto" else None,
    word_timestamps=request["wordTimestamps"],
    vad_filter=True,
)

# Collect results
result = {
    "segments": [],
    "language": info.language,
    "language_probability": info.language_probability,
    "duration": info.duration,
}

for segment in segments:
    seg_data = {
        "start": segment.start,
        "end": segment.end,
        "text": segment.text,
        "avg_logprob": segment.avg_logprob,
    }
    if request["wordTimestamps"] and segment.words:
        seg_data["words"] = [
            {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
            for w in segment.words
        ]
    result["segments"].append(seg_data)

# Write output
with open(request["outputPath"], "w") as f:
    json.dump(result, f, indent=2)

print("Transcription complete")
`.trim();
  }

  /**
   * Parse faster-whisper output to our format
   */
  private parseOutput(output: FasterWhisperOutput): TranscriptionResult {
    const segments: TranscriptSegment[] = output.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      confidence: seg.avg_logprob ? Math.exp(seg.avg_logprob) : undefined,
    }));

    const fullText = segments.map((s) => s.text).join(" ");

    return {
      segments,
      fullText,
      language: output.language || "en",
      duration:
        output.duration ||
        (segments.length > 0 ? segments[segments.length - 1].end : 0),
      source: "faster-whisper",
    };
  }
}

/**
 * Faster-whisper JSON output format
 */
interface FasterWhisperOutput {
  segments: Array<{
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
  }>;
  language: string;
  language_probability?: number;
  duration?: number;
}
