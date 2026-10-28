import type { runCommand } from "../../utils/helpers.js";
import type OpenAI from "openai";
import type { DeepgramClient } from "@deepgram/sdk";
import type { NativeDiagnosticsOptions } from "./diagnostics.js";
export type { NativeDiagnosticsOptions } from "./diagnostics.js";

export interface NativeLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}
export const silentLogger: NativeLogger = {
  debug() {},
  info() {},
  warn() {},
};

/** Host capabilities resolved by composition, never by the portable pipeline. */
export interface NativeRuntimeOptions {
  stagingRoot: string;
  ytdlpPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  pythonPath?: string;
  whisperBinaryPath?: string;
  whisperModelsPath?: string;
  openaiApiKey?: string;
  deepgramApiKey?: string;
  openaiClient?: OpenAI;
  deepgramClient?: DeepgramClient;
  providers?: string[];
  logger?: NativeLogger;
  runCommand?: typeof runCommand;
  diagnostics?: NativeDiagnosticsOptions;
}

export interface NativeOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxDiagnosticBytes?: number;
  runtime?: NativeRuntimeOptions;
  maxDurationSeconds?: number;
  maxSourceBytes?: number;
  maxArtifactBytes?: number;
  diagnosticContext?: { runId: string; attemptId: string };
}
