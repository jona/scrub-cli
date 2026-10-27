import type { NativeLogger, NativeRuntimeOptions } from "../node/runtime.js";
import { silentLogger } from "../node/runtime.js";
import type OpenAI from "openai";
import type { DeepgramClient } from "@deepgram/sdk";

export interface TranscriptionConfiguration {
  getTranscription(): {
    priority: string[];
    whisperModel: string;
    language: string;
  };
  getLocalWhisper(): { binaryPath?: string; modelsPath?: string };
  getApiKey(service: "openai" | "deepgram"): string | undefined;
  getCacheDir(): string;
  resolvePath(path: string): string;
}
export interface AdapterEnvironmentOptions {
  config: TranscriptionConfiguration;
  logger?: NativeLogger;
  runtime?: NativeRuntimeOptions;
  openaiClient?: OpenAI;
  deepgramClient?: DeepgramClient;
}
export function adapterEnvironment(options: AdapterEnvironmentOptions) {
  return {
    config: options.config,
    logger: options.logger ?? silentLogger,
    runtime: options.runtime,
  };
}
