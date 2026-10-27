import { resolve } from "node:path";
import { resolveServerResourceLimits } from "../runtime-config.js";
import { LocalJobRuntime } from "../../infrastructure/node/jobs/LocalJobRuntime.js";
import {
  createDeploymentModelGateway,
  resolveDeploymentModelConfig,
} from "../model-config.js";
import { resolveRuntimeConcurrency } from "../../infrastructure/runtime/config.js";

/** Explicit server composition; imports neither start listeners nor read CLI/HOME configuration. */
export function createLocalApplicationFromEnvironment(
  env: Record<string, string | undefined>
) {
  const resourceCeilings = resolveServerResourceLimits(env);
  const concurrency = resolveRuntimeConcurrency(env);
  const runtime = new LocalJobRuntime({
    dataRoot: resolve(env.SCRUB_DATA_DIR ?? ".local/runtime"),
    native: {
      stagingRoot: resolve(env.SCRUB_STAGING_ROOT ?? ".local/staging"),
      pythonPath: env.SCRUB_PYTHON_PATH ?? "python3",
      ytdlpPath: env.SCRUB_YTDLP_PATH,
      ffmpegPath: env.SCRUB_FFMPEG_PATH,
      ffprobePath: env.SCRUB_FFPROBE_PATH,
      whisperBinaryPath: env.SCRUB_WHISPER_BINARY_PATH,
      whisperModelsPath: env.SCRUB_WHISPER_MODELS_PATH,
      providers: (
        env.SCRUB_TRANSCRIBERS ?? "youtube-captions,faster-whisper"
      ).split(","),
      openaiApiKey: env.OPENAI_API_KEY,
      deepgramApiKey: env.DEEPGRAM_API_KEY,
    },
    models: createDeploymentModelGateway(() => env),
    inferenceDefaults: resolveDeploymentModelConfig(env).defaults,
    resourceCeilings,
    requestDefault: concurrency.requestDefault,
    runnerLimit: concurrency.runnerLimit,
    globalLimit: concurrency.globalLimit,
  });
  runtime.start();
  return {
    jobs: runtime.jobs,
    signal: runtime.signal,
    close: () => runtime.close(),
  };
}
