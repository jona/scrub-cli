import type { ResourceLimits } from "../application/contracts.js";
import { resolveSettings } from "../application/settings.js";
import { PipelineError } from "../core/errors.js";
import { jobSubmissionSchema } from "../application/jobs/submission.js";

export function resolveServerResourceLimits(
  env: Record<string, string | undefined>
): ResourceLimits | undefined {
  if (env.SCRUB_RESOURCE_LIMITS === undefined) return undefined;
  try {
    const limits = jobSubmissionSchema.shape.settings
      .unwrap()
      .shape.limits.parse(JSON.parse(env.SCRUB_RESOURCE_LIMITS));
    return resolveSettings({ limits }).limits;
  } catch {
    throw new PipelineError("invalid_input", "Invalid SCRUB_RESOURCE_LIMITS");
  }
}
