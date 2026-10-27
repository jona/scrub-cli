import { z } from "zod";
import type { JobSubmission, PipelineSettings } from "../contracts.js";
import {
  inferenceSettingsInputSchema,
  resolveInferenceSettings,
} from "../model.js";
import { normalizeSubmission } from "../playlist.js";
import { resolveSettings } from "../settings.js";
import { PipelineError } from "../../core/errors.js";
import type { NormalizedJobSubmission } from "./model.js";
import type { SubmissionPolicyOptions } from "./ports.js";

const positive = z.number().int().positive();
export const jobSubmissionSchema = z
  .object({
    url: z.string().min(1).max(4096),
    concurrency: z.number().int().min(1).max(16).optional(),
    maxVideos: z.number().int().min(0).max(10_000).optional(),
    continueOnError: z.boolean().optional(),
    skipExisting: z.boolean().optional(),
    settings: z
      .object({
        skipVisuals: z.boolean().optional(),
        sceneThreshold: z.number().min(0).max(1).optional(),
        maxFrames: z.number().int().min(1).max(100).optional(),
        minFrameInterval: z.number().positive().optional(),
        transcription: z
          .object({
            provider: z.string().min(1).max(200).optional(),
            model: z.string().min(1).max(200).optional(),
            language: z.string().min(1).max(200).optional(),
            wordTimestamps: z.boolean().optional(),
          })
          .strict()
          .optional(),
        inference: inferenceSettingsInputSchema.optional(),
        limits: z
          .object({
            maxDurationSeconds: positive.optional(),
            maxSourceBytes: positive.optional(),
            maxArtifactBytes: positive.optional(),
            maxTranscriptCharacters: positive.optional(),
            maxPlaylistVideos: positive.max(10_000).optional(),
            stageTimeoutMs: positive.optional(),
            maxAttempts: positive.max(10).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Validate public intent without filling model or scheduling defaults. */
export function normalizeJobSubmission(value: unknown): JobSubmission {
  const parsed = jobSubmissionSchema.safeParse(value);
  if (!parsed.success)
    throw new PipelineError("invalid_input", "Invalid job submission");
  const normalized = normalizeSubmission({
    ...parsed.data,
    settings: { ...parsed.data.settings, inference: undefined },
  });
  return {
    ...parsed.data,
    url: normalized.url,
  };
}

/** Omitted or identical intent must not rewrite a previously accepted settings snapshot. */
function changesCapturedValue(requested: unknown, captured: unknown): boolean {
  if (requested === undefined) return false;
  if (requested && typeof requested === "object" && !Array.isArray(requested)) {
    const previous =
      captured && typeof captured === "object"
        ? (captured as Record<string, unknown>)
        : {};
    return Object.entries(requested).some(([name, value]) =>
      changesCapturedValue(value, previous[name])
    );
  }
  return requested !== captured;
}

/** Deployment-selected defaults/ceilings shared by every job entry point. */
export class SubmissionPolicy {
  private readonly options: SubmissionPolicyOptions;
  constructor(options: SubmissionPolicyOptions) {
    this.options = {
      ...options,
      inferenceDefaults: resolveInferenceSettings(options.inferenceDefaults)!,
      resourceCeilings: {
        ...resolveSettings().limits,
        ...options.resourceCeilings,
      },
    };
  }

  resolve(
    input: unknown,
    existing?: { settings: PipelineSettings; input: JobSubmission }
  ): NormalizedJobSubmission {
    const request = normalizeJobSubmission(input);
    const settings = this.resolveSettings(request.settings, existing?.settings);
    const normalized = normalizeSubmission({
      ...request,
      concurrency:
        request.concurrency ??
        existing?.input.concurrency ??
        this.options.requestDefault,
      settings,
    });
    return { ...normalized, settings };
  }

  resolveSettings(
    input: JobSubmission["settings"],
    existing?: PipelineSettings
  ): PipelineSettings {
    const parsed = jobSubmissionSchema.shape.settings.safeParse(input);
    if (!parsed.success)
      throw new PipelineError("invalid_input", "Invalid processing settings");
    const requested = parsed.data?.inference;
    const defaults = existing?.inference ?? this.options.inferenceDefaults;
    const inference =
      existing && !changesCapturedValue(requested, existing.inference)
        ? existing.inference
        : resolveInferenceSettings({
            ...defaults,
            ...requested,
            limits: {
              ...this.options.inferenceDefaults.limits,
              ...defaults.limits,
              ...requested?.limits,
            },
          });
    if (inference) {
      const ceiling = resolveInferenceSettings(
        this.options.inferenceDefaults
      )!.limits;
      for (const [name, maximum] of Object.entries(ceiling))
        if (
          inference.limits[name as keyof typeof ceiling] > maximum &&
          (!existing ||
            inference.limits[name as keyof typeof ceiling] !==
              existing.inference?.limits[name as keyof typeof ceiling])
        )
          throw new PipelineError(
            "invalid_input",
            "Inference limits exceed deployment policy"
          );
    }
    const settings = resolveSettings({
      ...parsed.data,
      limits: {
        ...(existing?.limits ?? this.options.resourceCeilings),
        ...parsed.data?.limits,
      },
      ...(inference === undefined ? {} : { inference }),
    });
    // resolveSettings also resolves inference; retain historical snapshots whose
    // older limit shape must remain unchanged for their idempotency fingerprint.
    if (inference === undefined) delete settings.inference;
    else settings.inference = inference;
    const ceiling = this.options.resourceCeilings!;
    for (const [name, limit] of Object.entries(settings.limits)) {
      const maximum = ceiling[name as keyof typeof ceiling];
      if (
        maximum !== undefined &&
        limit > maximum &&
        (!existing || limit !== existing.limits[name as keyof typeof ceiling])
      )
        throw new PipelineError(
          "resource_limit",
          `Requested ${name} exceeds server policy`
        );
    }
    return settings;
  }

  async assertReady(settings: PipelineSettings): Promise<void> {
    await this.options.assertReady?.(settings);
  }
}

/** Stable, provider-independent canonical input to an injected digest function. */
export function canonicalJobValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  );
}
