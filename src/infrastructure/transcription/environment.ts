import type { NativeLogger, NativeRuntimeOptions } from "../node/runtime.js";
import { silentLogger } from "../node/runtime.js";
import { resolve } from "node:path";
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
  config?: TranscriptionConfiguration;
  logger?: NativeLogger;
  runtime?: NativeRuntimeOptions;
  openaiClient?: OpenAI;
  deepgramClient?: DeepgramClient;
}
export async function adapterEnvironment(options: AdapterEnvironmentOptions) {
  // Legacy CLI compatibility is lazy; imports of native adapters never read HOME.
  const runtime = options.runtime;
  const explicit = runtime || options.openaiClient || options.deepgramClient;
  const defaults: TranscriptionConfiguration = {
    getTranscription: () => ({
      priority: runtime?.providers ?? [
        "faster-whisper",
        "local-whisper",
        "openai",
        "deepgram",
        "youtube-captions",
      ],
      whisperModel: "base",
      language: "en",
    }),
    getLocalWhisper: () => ({
      binaryPath: runtime?.whisperBinaryPath,
      modelsPath: runtime?.whisperModelsPath,
    }),
    getApiKey: (service) =>
      service === "openai" ? runtime?.openaiApiKey : runtime?.deepgramApiKey,
    getCacheDir: () => {
      if (!runtime?.stagingRoot)
        throw new Error("A staging root is required for local transcription");
      return runtime.stagingRoot;
    },
    resolvePath: (path) => resolve(path),
  };
  const configuration =
    options.config ??
    (explicit ? defaults : (await import("../Config.js")).config);
  return {
    config: configuration,
    logger: options.logger ?? silentLogger,
    runtime: options.runtime,
  };
}
