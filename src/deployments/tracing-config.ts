import type { LangSmithTracingConfig } from "../infrastructure/observability/LangSmithModelTracing.js";

/** Server-owned observability policy; never part of persisted processing settings. */
export function resolveLangSmithTracingConfig(
  env: Record<string, string | undefined>
): LangSmithTracingConfig {
  const flag = (name: string, fallback: boolean): boolean => {
    const value = env[name];
    if (value === undefined) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Invalid ${name}; expected true or false`);
  };
  const enabled = flag("LANGSMITH_TRACING", false);
  const captureContent = flag("SCRUB_LANGSMITH_CAPTURE_CONTENT", false);
  const project = env.LANGSMITH_PROJECT ?? "scrub";
  if (
    !project.trim() ||
    project.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(project)
  )
    throw new Error("Invalid LANGSMITH_PROJECT");
  const endpoint = env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Invalid LANGSMITH_ENDPOINT");
  }
  if (
    endpoint !== endpoint.trim() ||
    /[\u0000-\u0020\u007f]/.test(endpoint) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /[?#]/.test(endpoint)
  )
    throw new Error(
      "Invalid LANGSMITH_ENDPOINT; use HTTPS without credentials, query, or fragment"
    );
  const workspaceId = env.LANGSMITH_WORKSPACE_ID?.trim() || undefined;
  if (
    workspaceId !== undefined &&
    (!workspaceId.trim() ||
      workspaceId.length > 200 ||
      /[\u0000-\u0020\u007f]/.test(workspaceId))
  )
    throw new Error("Invalid LANGSMITH_WORKSPACE_ID");
  let timeoutMs = 2000;
  if (env.SCRUB_LANGSMITH_TIMEOUT_MS !== undefined) {
    const value = env.SCRUB_LANGSMITH_TIMEOUT_MS;
    const number = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(number) || number < 1 || number > 10_000)
      throw new Error(
        "SCRUB_LANGSMITH_TIMEOUT_MS must be an integer from 1 to 10000"
      );
    timeoutMs = number;
  }
  return {
    enabled,
    ...(env.LANGSMITH_API_KEY?.trim()
      ? { apiKey: env.LANGSMITH_API_KEY.trim() }
      : {}),
    project: project.trim(),
    endpoint: url.href.replace(/\/$/, ""),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    captureContent,
    timeoutMs,
    redactValues: [
      ...new Set(
        Object.entries(env)
          .filter(([name]) =>
            /(?:^|_)(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD)(?:$|_)/.test(name)
          )
          .flatMap(([, value]) =>
            value === undefined ? [] : [value, value.trim()]
          )
          .filter((value) => value.length >= 8)
      ),
    ],
  };
}
