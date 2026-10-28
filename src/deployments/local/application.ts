import { resolve } from "node:path";
import { resolveServerResourceLimits } from "../runtime-config.js";
import { LocalJobRuntime } from "../../infrastructure/node/jobs/LocalJobRuntime.js";
import {
  createDeploymentModelGateway,
  resolveDeploymentModelConfig,
} from "../model-config.js";
import { resolveRuntimeConcurrency } from "../../infrastructure/runtime/config.js";
import { resolveLangSmithTracingConfig } from "../tracing-config.js";
import { LangSmithModelTracing } from "../../infrastructure/observability/LangSmithModelTracing.js";
import { createNativeDiagnostics } from "../native-diagnostics.js";
import { flushNativeCommandDiagnostics } from "../../infrastructure/node/diagnostics.js";

/** Explicit server composition; imports neither start listeners nor read CLI/HOME configuration. */
export function createLocalApplicationFromEnvironment(
  env: Record<string, string | undefined>
) {
  const resourceCeilings = resolveServerResourceLimits(env);
  const concurrency = resolveRuntimeConcurrency(env);
  resolveLangSmithTracingConfig(env);
  const tracing = new LangSmithModelTracing(() =>
    resolveLangSmithTracingConfig(env)
  );
  const nativeDiagnostics = createNativeDiagnostics(() => env);
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
      diagnostics: nativeDiagnostics,
    },
    models: createDeploymentModelGateway(() => env, undefined, tracing),
    inferenceDefaults: resolveDeploymentModelConfig(env).defaults,
    resourceCeilings,
    requestDefault: concurrency.requestDefault,
    runnerLimit: concurrency.runnerLimit,
    globalLimit: concurrency.globalLimit,
  });
  runtime.start();
  let closing: Promise<void> | undefined;
  return {
    jobs: runtime.jobs,
    signal: runtime.signal,
    close: () =>
      (closing ??= (async () => {
        try {
          await runtime.close();
        } finally {
          await Promise.allSettled([
            tracing.flush(),
            flushNativeCommandDiagnostics(nativeDiagnostics),
          ]);
        }
      })()),
  };
}
