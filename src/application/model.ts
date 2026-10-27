import { z } from "zod";
import type { ArtifactRef, OperationContext } from "./contracts.js";
import { PipelineError } from "../core/errors.js";

export interface ModelSelection {
  provider: string;
  model: string;
}
export interface StructuredModelRequest {
  selection: ModelSelection;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  schemaName: string;
  images?: { data: Uint8Array; mediaType: string }[];
  maxOutputTokens: number;
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface StructuredModelResponse {
  value: unknown;
  provider: string;
  model: string;
  usage?: ModelUsage;
}
/** Provider protocols, credentials, networking and deadlines belong to adapters. */
export interface StructuredModelGateway {
  supports(selection: ModelSelection): boolean;
  generate(
    request: StructuredModelRequest,
    context: OperationContext
  ): Promise<StructuredModelResponse>;
}
export interface InferenceLimits {
  chunkCharacters: number;
  maxOutputTokens: number;
  maxVisionOutputTokens: number;
  maxImageBytes: number;
  maxModelCalls: number;
  repairAttempts: number;
}
export interface InferenceSettings {
  mode: "preprocess" | "full";
  summary?: ModelSelection;
  vision?: ModelSelection;
  includeFullTranscript: boolean;
  limits: InferenceLimits;
}
export interface InferenceSettingsInput {
  mode?: InferenceSettings["mode"];
  summary?: ModelSelection;
  vision?: ModelSelection;
  includeFullTranscript?: boolean;
  limits?: Partial<InferenceLimits>;
}
export const DEFAULT_INFERENCE_LIMITS: InferenceLimits = {
  chunkCharacters: 48_000,
  maxOutputTokens: 8192,
  maxVisionOutputTokens: 2048,
  maxImageBytes: 8 * 1024 * 1024,
  maxModelCalls: 128,
  repairAttempts: 1,
};
const selection = z
  .object({
    provider: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict();
const inferenceInput = z
  .object({
    mode: z.enum(["preprocess", "full"]),
    summary: selection.optional(),
    vision: selection.optional(),
    includeFullTranscript: z.boolean(),
    limits: z
      .object({
        chunkCharacters: z.number().int().min(2000).max(200_000).optional(),
        maxOutputTokens: z.number().int().min(512).max(32_768).optional(),
        maxVisionOutputTokens: z.number().int().min(128).max(8192).optional(),
        maxImageBytes: z
          .number()
          .int()
          .positive()
          .max(20 * 1024 * 1024)
          .optional(),
        maxModelCalls: z.number().int().positive().max(512).optional(),
        repairAttempts: z.number().int().min(0).max(2).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
// Request validation must preserve omission; only resolution applies defaults.
const resolvedInferenceInput = inferenceInput.extend({
  mode: inferenceInput.shape.mode.default("preprocess"),
  includeFullTranscript:
    inferenceInput.shape.includeFullTranscript.default(false),
});
export const inferenceSettingsInputSchema = inferenceInput.partial();

export function validateInferenceSettingsInput(
  input: unknown
): InferenceSettingsInput {
  const parsed = inferenceSettingsInputSchema.safeParse(input);
  if (!parsed.success)
    throw new PipelineError("invalid_input", "Invalid inference settings");
  return parsed.data;
}

export function resolveInferenceSettings(
  input?: InferenceSettingsInput
): InferenceSettings | undefined {
  if (input === undefined) return undefined;
  const parsed = resolvedInferenceInput.safeParse(input);
  if (!parsed.success)
    throw new PipelineError("invalid_input", "Invalid inference settings");
  const result: InferenceSettings = {
    ...parsed.data,
    limits: { ...DEFAULT_INFERENCE_LIMITS, ...parsed.data.limits },
  };
  if (result.mode === "full" && (!result.summary || !result.vision))
    throw new PipelineError(
      "invalid_input",
      "Full processing requires summary and vision model selections"
    );
  return result;
}

export interface ModelStepCheckpoint {
  artifact: ArtifactRef;
  provider: string;
  model: string;
  usage?: ModelUsage;
}
export interface ModelInferenceCheckpoint {
  calls: number;
  steps: Record<string, ModelStepCheckpoint>;
}
export interface InferenceArtifacts {
  visualAnalysis: ArtifactRef;
  summary: ArtifactRef;
  markdown: ArtifactRef;
  modelUsage: ArtifactRef;
}

export function assertInferenceReady(
  settings: InferenceSettings | undefined,
  models: StructuredModelGateway | undefined,
  skipVisuals: boolean
): void {
  if (settings?.mode !== "full") return;
  if (!models || !settings.summary || !models.supports(settings.summary))
    throw new PipelineError(
      "capability_unavailable",
      "The selected summary model is not configured or allowed on this server"
    );
  if (!skipVisuals && (!settings.vision || !models.supports(settings.vision)))
    throw new PipelineError(
      "capability_unavailable",
      "The selected vision model is not configured or allowed on this server"
    );
}
