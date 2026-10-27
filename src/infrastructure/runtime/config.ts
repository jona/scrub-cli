import type { RuntimeConcurrencyPolicy } from "./RunnerAdmission.js";

/** Operational policy is resolved by composition, never by processing functions. */
export function resolveRuntimeConcurrency(
  env: Record<string, string | undefined>
): RuntimeConcurrencyPolicy {
  const integer = (
    name: string,
    fallback: number | undefined,
    maximum: number
  ) => {
    if (env[name] === undefined) return fallback;
    const value = /^\d+$/.test(env[name]!) ? Number(env[name]) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    return value;
  };
  const globalLimit =
    env.SCRUB_GLOBAL_CONCURRENCY === "none"
      ? undefined
      : integer("SCRUB_GLOBAL_CONCURRENCY", undefined, 1024);
  return {
    requestDefault: integer("SCRUB_REQUEST_CONCURRENCY", 1, 16)!,
    runnerLimit: integer("SCRUB_RUNNER_CONCURRENCY", 2, 64)!,
    ...(globalLimit === undefined ? {} : { globalLimit }),
  };
}
