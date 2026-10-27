import { PipelineError } from "../core/errors.js";
import type { JobSubmission, PipelineSettings } from "./contracts.js";
import { resolveInferenceSettings } from "./model.js";

export function resolveSettings(
  input: JobSubmission["settings"] = {}
): PipelineSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new PipelineError(
      "invalid_input",
      "Processing settings must be an object"
    );
  for (const name of ["transcription", "limits"] as const) {
    const value = input[name];
    if (
      value !== undefined &&
      (!value || typeof value !== "object" || Array.isArray(value))
    )
      throw new PipelineError("invalid_input", `${name} must be an object`);
  }
  const transcription = Object.fromEntries(
    Object.entries(input.transcription ?? {}).filter(
      ([, value]) => value !== undefined
    )
  );
  const result: PipelineSettings = {
    ...(input.inference === undefined
      ? {}
      : { inference: resolveInferenceSettings(input.inference) }),
    skipVisuals: input.skipVisuals ?? false,
    sceneThreshold: input.sceneThreshold ?? 0.4,
    maxFrames: input.maxFrames ?? 20,
    minFrameInterval: input.minFrameInterval ?? 2,
    transcription: { model: "base", language: "en", ...transcription },
    limits: {
      maxDurationSeconds: 6 * 60 * 60,
      maxSourceBytes: 512 * 1024 * 1024,
      maxArtifactBytes: 512 * 1024 * 1024,
      maxTranscriptCharacters: 5_000_000,
      maxPlaylistVideos: 10_000,
      stageTimeoutMs: 30 * 60 * 1000,
      maxAttempts: 3,
      ...input.limits,
    },
  };
  const fail = (name: string): never => {
    throw new PipelineError(
      "invalid_input",
      `Invalid processing setting: ${name}`
    );
  };
  if (typeof result.skipVisuals !== "boolean") fail("skipVisuals");
  if (
    !Number.isFinite(result.sceneThreshold) ||
    result.sceneThreshold < 0 ||
    result.sceneThreshold > 1
  )
    fail("sceneThreshold");
  if (
    !Number.isInteger(result.maxFrames) ||
    result.maxFrames < 1 ||
    result.maxFrames > 100
  )
    fail("maxFrames");
  if (!Number.isFinite(result.minFrameInterval) || result.minFrameInterval <= 0)
    fail("minFrameInterval");
  for (const [name, value] of Object.entries(result.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(name);
  }
  if (
    result.limits.maxPlaylistVideos > 10_000 ||
    result.limits.maxAttempts > 10
  )
    fail("limits");
  for (const [name, value] of Object.entries(result.transcription)) {
    if (name === "wordTimestamps") {
      if (typeof value !== "boolean") fail(name);
    } else if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 200
    )
      fail(name);
  }
  return result;
}
