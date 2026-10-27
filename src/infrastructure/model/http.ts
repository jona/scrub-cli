import { PipelineError } from "../../core/errors.js";

/** Internal marker; no provider response or request data is retained. */
export class ModelResponseLimit extends Error {
  constructor() {
    super("Model response exceeded its configured byte limit");
    this.name = "ModelResponseLimit";
  }
}

/** Bound the actual decoded response body before either SDK parses its JSON. */
export function boundedModelFetch(
  maximum: number,
  fetcher: typeof fetch = globalThis.fetch
): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    // SDK errors otherwise retain arbitrary provider bodies and headers. Their
    // status is useful for retry policy; their payload is never needed here.
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return new Response(
        JSON.stringify({ error: { message: "Model provider request failed" } }),
        {
          status: response.status,
          headers: { "content-type": "application/json" },
        }
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new ModelResponseLimit();
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) {
          void reader.cancel().catch(() => undefined);
          throw new ModelResponseLimit();
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function causedByLimit(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    current && typeof current === "object" && depth < 5;
    depth++
  ) {
    if (current instanceof ModelResponseLimit) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** SDK errors contain bodies and headers; never preserve them as causes or messages. */
export function modelFailure(
  error: unknown,
  caller: AbortSignal,
  deadline: AbortSignal
): PipelineError {
  if (caller.aborted)
    return new PipelineError("cancelled", "Model request was cancelled");
  if (deadline.aborted)
    return new PipelineError("timeout", "Model request timed out", {
      retryable: true,
    });
  if (causedByLimit(error))
    return new PipelineError(
      "resource_limit",
      "Model response exceeded the configured byte limit"
    );
  if (error instanceof PipelineError) return error;
  const detail = error as { status?: unknown; name?: unknown } | null;
  const status = typeof detail?.status === "number" ? detail.status : undefined;
  if (status === 401 || status === 403)
    return new PipelineError(
      "model_authentication_failed",
      "Model provider authentication failed"
    );
  if (status === 429)
    return new PipelineError(
      "rate_limited",
      "Model provider rate limit was reached",
      { retryable: true }
    );
  if (
    status === 408 ||
    detail?.name === "APIConnectionTimeoutError" ||
    detail?.name === "TimeoutError"
  )
    return new PipelineError("timeout", "Model request timed out", {
      retryable: true,
    });
  if (status === undefined || status === 409 || status >= 500)
    return new PipelineError(
      "unavailable",
      "Model provider is temporarily unavailable",
      { retryable: true }
    );
  return new PipelineError(
    "processing_failed",
    "Model provider rejected the request"
  );
}

export function awaitModel<T>(
  request: PromiseLike<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new DOMException("Model request aborted", "AbortError"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(request)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
