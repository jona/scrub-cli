import type { JobGateway, JobSubmission } from "../../application/contracts.js";
import { normalizeJobSubmission } from "../../application/jobs/submission.js";
import { PipelineError } from "../../core/errors.js";

export interface ApiDependencies {
  jobs?: JobGateway;
  authorize?: (request: Request) => boolean | Promise<boolean>;
}
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
const integer = (
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value))
    throw new PipelineError("invalid_input", "Invalid pagination parameter");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw new PipelineError(
      "invalid_input",
      "Pagination parameter is out of range"
    );
  return number;
};
async function parseBody(request: Request): Promise<unknown> {
  if (
    (request.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    throw new PipelineError(
      "invalid_input",
      "Content-Type must be application/json"
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new PipelineError("invalid_input", "A JSON body is required");
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32 * 1024)
        throw new PipelineError(
          "resource_limit",
          "Request body exceeds 32 KiB"
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new PipelineError("invalid_input", "Malformed JSON body");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function submission(value: unknown): JobSubmission {
  return normalizeJobSubmission(value);
}

async function artifactResponse(
  request: Request,
  jobs: JobGateway,
  job: string,
  video: string,
  artifact: string
): Promise<Response> {
  const range = request.headers.get("range");
  const parsed = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
  if (range && !parsed)
    return json(
      { error: { code: "invalid_range", message: "Use a single byte range" } },
      416
    );
  const start = parsed ? Number(parsed[1]) : 0;
  const requestedEnd = parsed?.[2] ? Number(parsed[2]) : undefined;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (requestedEnd !== undefined &&
      (!Number.isSafeInteger(requestedEnd) || requestedEnd < start))
  )
    return json({ error: { code: "invalid_range" } }, 416);
  const block = 128 * 1024;
  const first = await jobs.artifact(job, video, artifact, start, block);
  if (start >= first.size && !(first.size === 0 && start === 0 && !range))
    return json({ error: { code: "invalid_range" } }, 416, {
      "Content-Range": `bytes */${first.size}`,
    });
  const end = Math.min(requestedEnd ?? first.size - 1, first.size - 1);
  const length = Math.max(0, end - start + 1);
  let position = start;
  let initial: Uint8Array | null = first.bytes;
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stopped) return;
      try {
        if (position > end) {
          stopped = true;
          controller.close();
          return;
        }
        const bytes =
          initial ??
          (
            await jobs.artifact(
              job,
              video,
              artifact,
              position,
              Math.min(block, end - position + 1)
            )
          ).bytes;
        initial = null;
        const part = bytes.subarray(0, end - position + 1);
        if (!part.byteLength)
          throw new PipelineError(
            "storage_error",
            "Artifact ended before its declared size"
          );
        position += part.byteLength;
        controller.enqueue(part);
        if (position > end) {
          stopped = true;
          controller.close();
        }
      } catch {
        stopped = true;
        controller.error(new Error("Artifact transfer failed"));
      }
    },
    cancel() {
      stopped = true;
    },
  });
  const headers: Record<string, string> = {
    "Content-Type": first.mediaType,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${first.size}`;
  return new Response(stream, { status: range ? 206 : 200, headers });
}

/** Fetch-standard HTTP transport. The host listener and provider live outside. */
export function createApiHandler(
  dependencies: ApiDependencies = {}
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return request.method === "GET"
          ? json({ service: "scrub", status: "ok" })
          : json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      if (url.pathname !== "/jobs" && !url.pathname.startsWith("/jobs/"))
        return json({ error: "Not found" }, 404);
      if (!dependencies.authorize || !(await dependencies.authorize(request)))
        return json(
          {
            error: { code: "unauthorized", message: "Authentication required" },
          },
          401,
          { "WWW-Authenticate": "Bearer" }
        );
      if (!dependencies.jobs)
        return json(
          {
            error: {
              code: "unavailable",
              message: "Job service is not configured",
            },
          },
          503
        );
      const jobs = dependencies.jobs;
      const path = url.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            throw new PipelineError("invalid_input", "Invalid URL encoding");
          }
        });
      if (
        path.some(
          (part) =>
            !part ||
            part.length > 300 ||
            part.includes("/") ||
            part.includes("\\") ||
            part === "." ||
            part === ".."
        )
      )
        throw new PipelineError(
          "invalid_input",
          "Invalid job or artifact identifier"
        );
      if (path.length === 1 && request.method === "POST") {
        const job = await jobs.submit(
          submission(await parseBody(request)),
          request.headers.get("idempotency-key") ?? undefined
        );
        return json(job, 202, {
          Location: `/jobs/${encodeURIComponent(job.id)}`,
        });
      }
      const id = path[1];
      if (!id)
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      if (path.length === 2 && request.method === "GET") {
        const job = await jobs.get(id);
        return job
          ? json(job)
          : json(
              { error: { code: "not_found", message: "Job not found" } },
              404
            );
      }
      if (
        path.length === 3 &&
        path[2] === "results" &&
        request.method === "GET"
      )
        return json(
          await jobs.results(
            id,
            integer(url.searchParams.get("offset"), 0, 0, 1_000_000),
            integer(url.searchParams.get("limit"), 20, 1, 100)
          )
        );
      if (
        path.length === 3 &&
        path[2] === "cancel" &&
        request.method === "POST"
      )
        return json(await jobs.cancel(id));
      if (path.length === 3 && path[2] === "retry" && request.method === "POST")
        return json(await jobs.retry(id), 202);
      if (
        path.length === 6 &&
        path[2] === "videos" &&
        path[4] === "artifacts" &&
        request.method === "GET"
      )
        return await artifactResponse(request, jobs, id, path[3], path[5]);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof PipelineError) {
        const status = ["invalid_input", "invalid_source"].includes(error.code)
          ? 400
          : error.code === "not_found"
            ? 404
            : error.code === "resource_limit"
              ? 413
              : ["cancelled", "invalid_state"].includes(error.code)
                ? 409
                : error.code === "model_refused"
                  ? 422
                  : [
                        "capability_unavailable",
                        "model_authentication_failed",
                      ].includes(error.code) || error.retryable
                    ? 503
                    : 500;
        return json(
          {
            error: {
              code: error.code,
              message:
                error.code === "capability_unavailable"
                  ? "The requested server capability is not configured or available"
                  : status >= 500
                    ? "Job operation failed"
                    : error.message,
              retryable: error.retryable,
            },
          },
          status
        );
      }
      return json(
        { error: { code: "internal_error", message: "Request failed" } },
        500
      );
    }
  };
}
