#!/usr/bin/env node
import { extname } from "node:path";
import { runCli } from "../../entrypoints/cli/index.js";
import { config } from "../../infrastructure/Config.js";
import { artifactStore } from "../../infrastructure/filesystem/ArtifactStore.js";
import {
  processFile,
  checkFilePrerequisites,
} from "../../infrastructure/node/cli/file.js";
import {
  processYouTubePlaylist,
  checkYouTubePrerequisites,
  getDiagnostics,
} from "../../infrastructure/node/cli/youtube.js";
import { getTranscriberDiagnostics } from "../../infrastructure/node/transcribe.js";
import { createCliStages } from "../../infrastructure/node/cli/stages.js";
import {
  createDeploymentModelGateway,
  resolveDeploymentModelConfig,
} from "../model-config.js";
import { resolveLocalInference } from "./inference.js";
import type { CliInferenceOptions } from "../../entrypoints/cli/dependencies.js";

const modelEnvironment = () => ({
  ...process.env,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? config.getApiKey("openai"),
  ANTHROPIC_API_KEY:
    process.env.ANTHROPIC_API_KEY ?? config.getApiKey("anthropic"),
});
const models = createDeploymentModelGateway(modelEnvironment);
const stages = createCliStages();
const modelDefaults = (overrides: CliInferenceOptions) => {
  const env: Record<string, string | undefined> = modelEnvironment();
  const current = resolveDeploymentModelConfig(env).defaults;
  for (const [stage, provider, model, previous] of [
    [
      "SUMMARY",
      overrides.summaryProvider,
      overrides.summaryModel,
      current.summary,
    ],
    ["VISION", overrides.visionProvider, overrides.visionModel, current.vision],
  ] as const) {
    if (provider !== undefined) {
      env[`SCRUB_${stage}_PROVIDER`] = provider;
      if (provider !== previous?.provider && model === undefined)
        env[`SCRUB_${stage}_MODEL`] = undefined;
    }
    if (model !== undefined) env[`SCRUB_${stage}_MODEL`] = model;
  }
  return resolveDeploymentModelConfig(env).defaults;
};

await runCli(process.argv, {
  config,
  artifactStore,
  processFile: (file, options) =>
    processFile(
      file,
      resolveLocalInference(
        {
          ...options,
          skipVisuals:
            extname(file).toLowerCase() === ".mp3" || options?.skipVisuals,
        },
        modelDefaults,
        models,
        config.getOutput().includeFullTranscript
      )
    ),
  processYouTubePlaylist: (url, options) =>
    processYouTubePlaylist(
      url,
      resolveLocalInference(
        options ?? {},
        modelDefaults,
        models,
        config.getOutput().includeFullTranscript
      )
    ),
  checkFilePrerequisites,
  checkYouTubePrerequisites,
  getDiagnostics,
  ...stages,
  getTranscriberDiagnostics,
  renderSummaryFile: (path, options) =>
    stages.renderSummaryFile(path, {
      ...options,
      includeFullTranscript:
        options?.includeFullTranscript ??
        config.getOutput().includeFullTranscript,
      generatedAt: options?.generatedAt ?? new Date().toISOString(),
    }),
});
