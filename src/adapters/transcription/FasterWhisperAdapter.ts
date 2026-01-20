import { existsSync, writeFileSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { config } from '../../core/Config.js';
import { logger } from '../../utils/logger.js';
import { commandExists, runCommand, ensureDir } from '../../utils/helpers.js';
import type {
  ITranscriber,
  TranscriptionResult,
  TranscriptionOptions,
  TranscriptSegment,
} from './ITranscriber.js';

/**
 * Adapter for faster-whisper Python package
 * 
 * Requires Python 3.8+ and faster-whisper package:
 * pip install faster-whisper
 */
export class FasterWhisperAdapter implements ITranscriber {
  readonly name = 'Faster Whisper (Python)';
  readonly requiresApiKey = false;

  private pythonPath: string | null = null;

  /**
   * Check if faster-whisper is available
   */
  async isAvailable(): Promise<boolean> {
    // Find Python
    const pythonCommands = ['python3', 'python'];
    for (const cmd of pythonCommands) {
      if (await commandExists(cmd)) {
        // Check if faster-whisper is installed
        try {
          const result = await runCommand(cmd, [
            '-c',
            'import faster_whisper; print("ok")',
          ]);
          if (result.code === 0 && result.stdout.includes('ok')) {
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
    if (!this.pythonPath) {
      const available = await this.isAvailable();
      if (!available) {
        throw new Error(
          'faster-whisper is not installed. Install with: pip install faster-whisper'
        );
      }
    }

    const transcriptionConfig = config.getTranscription();
    const model = options?.model || transcriptionConfig.whisperModel;
    const language = options?.language || transcriptionConfig.language;

    // Create temp directory for output
    const tempDir = join(config.getCacheDir(), 'whisper-temp');
    ensureDir(tempDir);
    const outputPath = join(tempDir, `transcript-${Date.now()}.json`);

    logger.debug(`Running faster-whisper with model: ${model}`);

    // Create Python script for transcription
    const pythonScript = this.generatePythonScript(
      audioPath,
      outputPath,
      model,
      language,
      options?.wordTimestamps
    );

    const scriptPath = join(tempDir, `transcribe-${Date.now()}.py`);
    writeFileSync(scriptPath, pythonScript);

    try {
      // Run the Python script
      const result = await runCommand(this.pythonPath!, [scriptPath]);

      if (result.code !== 0) {
        throw new Error(`Faster-whisper transcription failed: ${result.stderr}`);
      }

      // Read the JSON output
      if (!existsSync(outputPath)) {
        throw new Error('Faster-whisper did not produce expected output file');
      }

      const rawOutput = await readFile(outputPath, 'utf-8');
      const whisperOutput = JSON.parse(rawOutput) as FasterWhisperOutput;

      return this.parseOutput(whisperOutput);
    } finally {
      // Clean up temp files
      try {
        await unlink(scriptPath);
        if (existsSync(outputPath)) {
          await unlink(outputPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Generate Python script for transcription
   */
  private generatePythonScript(
    audioPath: string,
    outputPath: string,
    model: string,
    language: string,
    wordTimestamps?: boolean
  ): string {
    return `
import json
from faster_whisper import WhisperModel

# Initialize model
model = WhisperModel("${model}", device="auto", compute_type="auto")

# Transcribe
segments, info = model.transcribe(
    "${audioPath.replace(/\\/g, '\\\\')}",
    language="${language}" if "${language}" != "auto" else None,
    word_timestamps=${wordTimestamps ? 'True' : 'False'},
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
    if ${wordTimestamps ? 'True' : 'False'} and segment.words:
        seg_data["words"] = [
            {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
            for w in segment.words
        ]
    result["segments"].append(seg_data)

# Write output
with open("${outputPath.replace(/\\/g, '\\\\')}", "w") as f:
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

    const fullText = segments.map((s) => s.text).join(' ');

    return {
      segments,
      fullText,
      language: output.language || 'en',
      duration: output.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0),
      source: 'faster-whisper',
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
