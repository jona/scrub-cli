import {
  DEFAULT_INFERENCE_LIMITS,
  resolveInferenceSettings,
  type InferenceSettingsInput,
  type StructuredModelGateway,
} from "../application/model.js";
import type { OperationContext } from "../application/contracts.js";
import type { LangSmithModelTracing } from "../infrastructure/observability/LangSmithModelTracing.js";
import {
  ProviderModelGateway,
  type ServerModelProviderConfig,
} from "../infrastructure/model/ModelGateway.js";

export interface DeploymentModelConfig {
  /** Public defaults are safe to persist with a job; provider credentials are not. */
  defaults: InferenceSettingsInput;
  providers: ServerModelProviderConfig[];
}

const OPENAI_STAGE_DEFAULTS = {
  SUMMARY: "gpt-6.1-sol",
  VISION: "gpt-6.1-terra",
} as const;
const OPENAI_DEFAULT_ALLOWLIST = [
  ...Object.values(OPENAI_STAGE_DEFAULTS),
  "gpt-6-luna",
];

/** Only trusted deployment composition supplies endpoints, credentials and allowlists. */
export function resolveDeploymentModelConfig(
  env: Record<string, string | undefined>
): DeploymentModelConfig {
  let timeoutMs = 600_000;
  if (env.SCRUB_MODEL_TIMEOUT_MS !== undefined) {
    const value = /^\d+$/.test(env.SCRUB_MODEL_TIMEOUT_MS)
      ? Number(env.SCRUB_MODEL_TIMEOUT_MS)
      : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_800_000)
      throw new Error(
        "SCRUB_MODEL_TIMEOUT_MS must be an integer from 1 to 1800000"
      );
    timeoutMs = value;
  }
  const models = (name: string, fallback: readonly string[]): string[] => {
    const values =
      env[name] === undefined
        ? [...fallback]
        : env[name]!.split(",").map((value) => value.trim());
    if (
      values.length < 1 ||
      values.length > 100 ||
      values.some(
        (value) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)
      )
    )
      throw new Error(`Invalid ${name} model allowlist`);
    return [...new Set(values)];
  };
  const providers: ServerModelProviderConfig[] = [
    {
      name: "openai",
      protocol: "openai-compatible",
      apiKey: env.OPENAI_API_KEY,
      timeoutMs,
      allowedModels: models("SCRUB_OPENAI_MODELS", OPENAI_DEFAULT_ALLOWLIST),
      ...(env.SCRUB_OPENAI_BASE_URL
        ? { baseURL: env.SCRUB_OPENAI_BASE_URL }
        : {}),
    },
    {
      name: "anthropic",
      protocol: "anthropic",
      apiKey: env.ANTHROPIC_API_KEY,
      timeoutMs,
      allowedModels: models("SCRUB_ANTHROPIC_MODELS", ["claude-sonnet-5-5"]),
      ...(env.SCRUB_ANTHROPIC_BASE_URL
        ? { baseURL: env.SCRUB_ANTHROPIC_BASE_URL }
        : {}),
    },
  ];
  const select = (stage: "SUMMARY" | "VISION") => {
    const provider = env[`SCRUB_${stage}_PROVIDER`] ?? "openai";
    const model =
      env[`SCRUB_${stage}_MODEL`] ??
      (provider === "anthropic"
        ? "claude-sonnet-5-5"
        : OPENAI_STAGE_DEFAULTS[stage]);
    if (
      !providers
        .find((candidate) => candidate.name === provider)
        ?.allowedModels.includes(model)
    )
      throw new Error(
        `Invalid SCRUB_${stage}_PROVIDER or SCRUB_${stage}_MODEL`
      );
    return { provider, model };
  };
  let limits = { ...DEFAULT_INFERENCE_LIMITS };
  if (env.SCRUB_INFERENCE_LIMITS !== undefined) {
    try {
      const parsed: unknown = JSON.parse(env.SCRUB_INFERENCE_LIMITS);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      limits = resolveInferenceSettings({ limits: parsed })!.limits;
    } catch {
      throw new Error("Invalid SCRUB_INFERENCE_LIMITS");
    }
  }
  // Both registered transports share the gateway's bounded 8 MiB image envelope.
  if (limits.maxImageBytes > 8 * 1024 * 1024)
    throw new Error(
      "SCRUB_INFERENCE_LIMITS.maxImageBytes exceeds the provider image limit"
    );
  const defaults = resolveInferenceSettings({
    mode: "full",
    summary: select("SUMMARY"),
    vision: select("VISION"),
    limits,
  })!;
  return { defaults, providers };
}

/**
 * Refresh from a server-owned credential cache without persisting keys in jobs.
 * The loader keeps supports() network-free. Composition refreshes the cache
 * before preflight and the optional hook refreshes it before each model call.
 */
export function createDeploymentModelGateway(
  loadEnvironment: () => Record<string, string | undefined>,
  refresh?: (context: OperationContext) => Promise<void>,
  tracing?: Pick<LangSmithModelTracing, "wrap">
): StructuredModelGateway {
  let previous = "";
  let gateway: ProviderModelGateway | undefined;
  const current = () => {
    const { providers } = resolveDeploymentModelConfig(loadEnvironment());
    const identity = JSON.stringify(providers);
    if (!gateway || identity !== previous) {
      const next = new ProviderModelGateway(providers);
      gateway = next;
      previous = identity;
    }
    return gateway;
  };
  return {
    supports: (selection) => current().supports(selection),
    generate: async (request, context) => {
      context.signal.throwIfAborted();
      await refresh?.(context);
      context.signal.throwIfAborted();
      const provider = current();
      return (tracing?.wrap(provider) ?? provider).generate(request, context);
    },
  };
}
