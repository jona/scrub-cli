import type { CliInferenceOptions } from "../../entrypoints/cli/dependencies.js";
import {
  resolveInferenceSettings,
  type InferenceSettingsInput,
  type StructuredModelGateway,
} from "../../application/model.js";
import { PipelineError } from "../../core/errors.js";

/** CLI-only options become public settings plus an injected, credential-owning capability. */
export function resolveLocalInference<
  T extends CliInferenceOptions & { skipVisuals?: boolean },
>(
  options: T,
  loadDefaults: (overrides: CliInferenceOptions) => InferenceSettingsInput,
  models: StructuredModelGateway,
  includeFullTranscript: boolean
) {
  const {
    summarize,
    summaryProvider,
    summaryModel,
    visionProvider,
    visionModel,
    ...processing
  } = options;
  const overrides = {
    summaryProvider,
    summaryModel,
    visionProvider,
    visionModel,
  };
  if (!summarize) {
    if (Object.values(overrides).some((value) => value !== undefined))
      throw new PipelineError(
        "invalid_input",
        "Model options require --summarize"
      );
    return processing;
  }
  const inference = resolveInferenceSettings({
    ...loadDefaults(overrides),
    mode: "full",
    includeFullTranscript,
  })!;
  for (const selection of [
    inference.summary,
    ...(processing.skipVisuals ? [] : [inference.vision]),
  ]) {
    if (!selection || !models.supports(selection))
      throw new PipelineError(
        "capability_unavailable",
        "Full processing requires configured model credentials and allowed selections"
      );
  }
  return { ...processing, inference, models };
}
