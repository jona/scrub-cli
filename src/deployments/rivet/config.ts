import { resolveRuntimeConcurrency } from "../../infrastructure/runtime/config.js";
export type { RuntimeConcurrencyPolicy as RivetConcurrencyPolicy } from "../../infrastructure/runtime/RunnerAdmission.js";

/** Compatibility name; both local and Rivet deployments use the same policy parser. */
export const resolveRivetConcurrency = resolveRuntimeConcurrency;
