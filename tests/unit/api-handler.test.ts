import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "../../src/entrypoints/api/handler.js";
import { PipelineError } from "../../src/core/errors.js";
import { SubmissionPolicy } from "../../src/application/jobs/submission.js";
import type {
  JobGateway,
  JobSnapshot,
} from "../../src/application/contracts.js";

const snapshot: JobSnapshot = {
  id: "request-example",
  status: "queued",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  total: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  stage: "enumerate",
};
const source = { url: "https://youtu.be/dQw4w9WgXcQ" };
const endpoint = "https://scrub.example";

function gateway(data = new Uint8Array()) {
  return {
    submit: vi.fn(async () => snapshot),
    get: vi.fn(async (): Promise<JobSnapshot | null> => snapshot),
    results: vi.fn(async () => ({ items: [], total: 0 })),
    cancel: vi.fn(async () => ({ ...snapshot, status: "cancelled" as const })),
    retry: vi.fn(async () => snapshot),
    artifact: vi.fn(
      async (
        _job: string,
        _video: string,
        _artifact: string,
        offset: number,
        length: number
      ) => ({
        bytes: data.slice(offset, offset + length),
        size: data.length,
        mediaType: "application/octet-stream",
      })
    ),
  } satisfies JobGateway;
}
function request(path: string, body?: unknown, extra: RequestInit = {}) {
  return new Request(endpoint + path, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "Content-Type": "application/json" },
    ...extra,
  });
}
const authorized = (jobs: JobGateway) =>
  createApiHandler({ jobs, authorize: () => true });
const artifactPath =
  "/jobs/request-example/videos/dQw4w9WgXcQ/artifacts/artifact-example";

describe("Fetch job API authorization and submission", () => {
  it("keeps health public and refuses job access when authorization is absent", async () => {
    const jobs = gateway();
    const handler = createApiHandler({ jobs });
    expect((await handler(request("/healthz"))).status).toBe(200);
    const response = await handler(request("/jobs", source));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(jobs.submit).not.toHaveBeenCalled();
  });

  it("checks authorization before reading the body or invoking the gateway", async () => {
    const jobs = gateway();
    const input = request("/jobs", source);
    const read = vi.spyOn(input.body!, "getReader");
    const authorize = vi.fn(async () => false);
    const response = await createApiHandler({ jobs, authorize })(input);
    expect(response.status).toBe(401);
    expect(authorize).toHaveBeenCalledWith(input);
    expect(read).not.toHaveBeenCalled();
    for (const action of Object.values(jobs))
      expect(action).not.toHaveBeenCalled();
  });

  it("reports an unconfigured gateway without consuming an authorized request body", async () => {
    const input = request("/jobs", source);
    const read = vi.spyOn(input.body!, "getReader");
    const response = await createApiHandler({ authorize: () => true })(input);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "unavailable" },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("normalizes valid submissions and forwards idempotency without blocking on work", async () => {
    const jobs = gateway();
    const response = await authorized(jobs)(
      request(
        "/jobs",
        {
          ...source,
          maxVideos: 2,
          concurrency: 2,
          settings: { skipVisuals: true },
        },
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Idempotency-Key": "same-request",
          },
        }
      )
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/jobs/request-example");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(jobs.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        maxVideos: 2,
        concurrency: 2,
        settings: expect.objectContaining({ skipVisuals: true }),
      }),
      "same-request"
    );
    expect(await response.json()).toEqual(snapshot);
  });

  it("preserves omitted request concurrency so the runtime can apply its deployment default", async () => {
    const jobs = gateway();
    expect((await authorized(jobs)(request("/jobs", source))).status).toBe(202);
    expect(jobs.submit.mock.calls[0]?.[0].concurrency).toBeUndefined();
  });

  it.each([
    { mode: "full" },
    { summary: { provider: "anthropic", model: "allowed-summary" } },
    {
      vision: { provider: "openai", model: "allowed-vision" },
      limits: { maxModelCalls: 7 },
    },
    {
      mode: "full",
      includeFullTranscript: true,
      limits: { repairAttempts: 0 },
    },
  ])(
    "preserves partial inference intent for runtime model defaults: %j",
    async (inference) => {
      const jobs = gateway();
      const response = await authorized(jobs)(
        request("/jobs", {
          ...source,
          settings: { inference },
        })
      );
      expect(response.status).toBe(202);
      expect(jobs.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ inference }),
        }),
        undefined
      );
    }
  );

  it.each([
    { mode: "full", apiKey: "fixture-forbidden-credential" },
    { mode: "full", baseURL: "https://untrusted-provider.invalid" },
    {
      summary: {
        provider: "openai",
        model: "summary",
        apiKey: "fixture-forbidden-credential",
      },
    },
    {
      summary: {
        provider: "openai",
        model: "summary",
        baseURL: "https://untrusted-provider.invalid",
      },
    },
    {
      vision: {
        provider: "anthropic",
        model: "vision",
        apiKey: "fixture-forbidden-credential",
      },
    },
    {
      vision: {
        provider: "anthropic",
        model: "vision",
        baseURL: "https://untrusted-provider.invalid",
      },
    },
  ])(
    "rejects request-owned inference credentials or endpoints before the gateway: %j",
    async (inference) => {
      const jobs = gateway();
      const response = await authorized(jobs)(
        request("/jobs", {
          ...source,
          settings: { inference },
        })
      );
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).not.toContain("fixture-forbidden-credential");
      expect(body).not.toContain("untrusted-provider.invalid");
      for (const action of Object.values(jobs))
        expect(action).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    [],
    { url: "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ" },
    { ...source, concurrency: 17 },
    { ...source, maxVideos: 10_001 },
    { ...source, settings: { maxFrames: 101 } },
    { ...source, settings: null },
    { ...source, settings: [] },
    { ...source, settings: "full" },
    { ...source, settings: true },
    { ...source, settings: 1 },
    { ...source, settings: { inference: [] } },
    { ...source, settings: { inference: null } },
    { ...source, settings: { inference: "full" } },
    { ...source, settings: { inference: { summary: [] } } },
    { ...source, settings: { inference: { vision: [] } } },
    { ...source, settings: { inference: { limits: [] } } },
    { ...source, settings: { transcription: [] } },
    { ...source, settings: { limits: [] } },
    { ...source, settings: { limits: null } },
  ])(
    "rejects malformed sources or settings before submission: %j",
    async (input) => {
      const jobs = gateway();
      const response = await authorized(jobs)(request("/jobs", input));
      expect(response.status).toBe(400);
      expect(jobs.submit).not.toHaveBeenCalled();
    }
  );

  it("returns the shared application's deployment resource-policy rejection", async () => {
    const jobs = gateway();
    const policy = new SubmissionPolicy({
      requestDefault: 1,
      inferenceDefaults: { mode: "preprocess" },
    });
    jobs.submit.mockImplementation(async (input) => {
      policy.resolve(input);
      return snapshot;
    });
    const response = await authorized(jobs)(
      request("/jobs", {
        ...source,
        settings: { limits: { maxDurationSeconds: 6 * 60 * 60 + 1 } },
      })
    );
    expect(response.status).toBe(413);
    expect(jobs.submit).toHaveBeenCalledOnce();
  });

  it.each(["text/plain", "application/jsonx"])(
    "requires the JSON media type rather than accepting %s",
    async (mediaType) => {
      const jobs = gateway();
      const response = await authorized(jobs)(
        request("/jobs", source, { headers: { "Content-Type": mediaType } })
      );
      expect(response.status).toBe(400);
      expect(jobs.submit).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed JSON and bounds the actual streamed bytes", async () => {
    const jobs = gateway();
    const handler = authorized(jobs);
    expect(
      (
        await handler(
          new Request(endpoint + "/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{broken",
          })
        )
      ).status
    ).toBe(400);
    const cancelled = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(12 * 1024).fill(32));
      },
      cancel: cancelled,
    });
    const response = await handler(
      new Request(endpoint + "/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "1" },
        body,
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(chunks).toBeLessThanOrEqual(4);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(jobs.submit).not.toHaveBeenCalled();
  });
});

describe("Fetch job queries and transitions", () => {
  it("reports missing server model capability without exposing diagnostics or recommending blind retries", async () => {
    const jobs = gateway();
    jobs.submit.mockRejectedValueOnce(
      new PipelineError("capability_unavailable", "private server diagnostic")
    );
    const response = await authorized(jobs)(request("/jobs", source));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "capability_unavailable",
        message:
          "The requested server capability is not configured or available",
        retryable: false,
      },
    });
  });
  it("dispatches status, result pagination, cancellation, and retry", async () => {
    const jobs = gateway();
    const handler = authorized(jobs);
    expect((await handler(request("/jobs/request-example"))).status).toBe(200);
    expect(jobs.get).toHaveBeenCalledWith("request-example");
    expect(
      (await handler(request("/jobs/request-example/results"))).status
    ).toBe(200);
    expect(jobs.results).toHaveBeenLastCalledWith("request-example", 0, 20);
    await handler(request("/jobs/request-example/results?offset=20&limit=10"));
    expect(jobs.results).toHaveBeenLastCalledWith("request-example", 20, 10);
    expect(
      (
        await handler(
          request("/jobs/request-example/cancel", undefined, { method: "POST" })
        )
      ).status
    ).toBe(200);
    expect(jobs.cancel).toHaveBeenCalledWith("request-example");
    expect(
      (
        await handler(
          request("/jobs/request-example/retry", undefined, { method: "POST" })
        )
      ).status
    ).toBe(202);
    expect(jobs.retry).toHaveBeenCalledWith("request-example");
    jobs.get.mockResolvedValueOnce(null);
    expect((await handler(request("/jobs/missing"))).status).toBe(404);
  });

  it.each([
    "offset=-1",
    "offset=1.5",
    "offset=1e2",
    "offset=1000001",
    "limit=0",
    "limit=101",
    "limit=NaN",
    "limit=%20%202",
  ])(
    "rejects invalid pagination %s without querying the gateway",
    async (query) => {
      const jobs = gateway();
      expect(
        (
          await authorized(jobs)(
            request(`/jobs/request-example/results?${query}`)
          )
        ).status
      ).toBe(400);
      expect(jobs.results).not.toHaveBeenCalled();
    }
  );

  it("rejects encoded path separators before the gateway", async () => {
    const jobs = gateway();
    expect((await authorized(jobs)(request("/jobs/a%2Fb"))).status).toBe(400);
    expect(jobs.get).not.toHaveBeenCalled();
  });

  it.each([
    new Error("private fixture credential"),
    new PipelineError("storage_error", "private fixture credential", {
      retryable: true,
      cause: "private cause",
    }),
  ])("hides internal and provider failures: %s", async (error) => {
    const jobs = gateway();
    jobs.get.mockRejectedValueOnce(error);
    const response = await authorized(jobs)(request("/jobs/request-example"));
    expect(response.status).toBe(error instanceof PipelineError ? 503 : 500);
    expect(await response.text()).not.toContain("private");
  });
});

describe("Fetch artifact delivery", () => {
  it("streams multiple bounded chunks with content metadata", async () => {
    const data = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);
    const jobs = gateway(data);
    const response = await authorized(jobs)(request(artifactPath));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(data.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
    expect(jobs.artifact.mock.calls.map((call) => call[3])).toEqual([
      0, 131_072, 262_144,
    ]);
    expect(
      jobs.artifact.mock.calls.every((call) => call[4] <= 128 * 1024)
    ).toBe(true);
  });

  it.each(["bytes=5-9", "bytes=5-"])(
    "serves a single byte range %s",
    async (range) => {
      const data = new TextEncoder().encode("0123456789");
      const jobs = gateway(data);
      const response = await authorized(jobs)(
        request(artifactPath, undefined, { headers: { Range: range } })
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 5-9/10");
      expect(response.headers.get("content-length")).toBe("5");
      expect(await response.text()).toBe("56789");
    }
  );

  it.each([
    "bytes=-5",
    "bytes=3-1",
    "bytes=0-1,4-5",
    "bytes=NaN-",
    "bytes=9007199254740992-",
  ])("rejects unsupported or invalid byte ranges %s", async (range) => {
    const jobs = gateway(new Uint8Array(10));
    const response = await authorized(jobs)(
      request(artifactPath, undefined, { headers: { Range: range } })
    );
    expect(response.status).toBe(416);
    expect(jobs.artifact).not.toHaveBeenCalled();
  });

  it("reports unsatisfiable offsets and handles an empty full artifact", async () => {
    const jobs = gateway(new Uint8Array(10));
    const handler = authorized(jobs);
    const response = await handler(
      request(artifactPath, undefined, { headers: { Range: "bytes=10-" } })
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    const empty = await authorized(gateway())(request(artifactPath));
    expect(empty.status).toBe(200);
    expect((await empty.arrayBuffer()).byteLength).toBe(0);
  });

  it("stops fetching once an artifact consumer cancels", async () => {
    const jobs = gateway(new Uint8Array(1024 * 1024));
    const response = await authorized(jobs)(request(artifactPath));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const count = jobs.artifact.mock.calls.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(jobs.artifact.mock.calls).toHaveLength(count);
    expect(count).toBeLessThanOrEqual(2);
  });

  it("does not reveal backend diagnostic secrets when a later chunk fails", async () => {
    const jobs = gateway(new Uint8Array(300_000));
    jobs.artifact.mockRejectedValueOnce(
      new Error("private fixture credential")
    );
    // Failure before headers is translated to a generic JSON error.
    const unavailable = await authorized(jobs)(request(artifactPath));
    expect(unavailable.status).toBe(500);
    expect(await unavailable.text()).not.toContain("private");
    jobs.artifact.mockImplementationOnce(async () => ({
      bytes: new Uint8Array(128 * 1024),
      size: 300_000,
      mediaType: "application/octet-stream",
    }));
    jobs.artifact.mockRejectedValueOnce(
      new Error("private fixture credential")
    );
    const response = await authorized(jobs)(request(artifactPath));
    let failed: unknown;
    try {
      await response.arrayBuffer();
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).not.toContain("private");
  });
});
