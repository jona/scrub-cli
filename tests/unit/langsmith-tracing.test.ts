import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, type ClientConfig } from "langsmith";
import { traceable } from "langsmith/traceable";
import { inspect } from "node:util";
import type { OperationContext } from "../../src/application/contracts.js";
import type {
  StructuredModelGateway,
  StructuredModelRequest,
  StructuredModelResponse,
} from "../../src/application/model.js";
import { PipelineError } from "../../src/core/errors.js";
import {
  LangSmithModelTracing,
  type LangSmithTracingConfig,
} from "../../src/infrastructure/observability/LangSmithModelTracing.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const secrets = {
  tracing: "TEST_LANGSMITH_CREDENTIAL_SENTINEL",
  provider: "TEST_OPENAI_CREDENTIAL_SENTINEL",
  otherProvider: "TEST_ANTHROPIC_CREDENTIAL_SENTINEL",
};
const image = new TextEncoder().encode("PRIVATE_FRAME_BYTES_SENTINEL");
const baseConfig = (): LangSmithTracingConfig => ({
  enabled: true,
  apiKey: secrets.tracing,
  project: "scrub-tests",
  endpoint: "https://langsmith.example.invalid",
  captureContent: false,
  timeoutMs: 100,
  redactValues: [secrets.provider, secrets.otherProvider],
});
const context = (signal = new AbortController().signal): OperationContext => ({
  runId: "request-one/video-one",
  attemptId: "attempt-two",
  signal,
  now: Date.now,
  emit: () => undefined,
});
const request = (
  overrides: Partial<StructuredModelRequest> = {}
): StructuredModelRequest => ({
  selection: { provider: "openai", model: "allowed-summary" },
  system: `SYSTEM_CONTENT_SENTINEL ${secrets.provider}`,
  prompt: `PROMPT_CONTENT_SENTINEL ${secrets.tracing}`,
  schema: {
    type: "object",
    properties: { summary: { type: "string" } },
  },
  schemaName: "ScrubSummary",
  maxOutputTokens: 4096,
  images: [{ data: image, mediaType: "image/png" }],
  invocation: {
    step: "summary:final",
    callIndex: 7,
    repairAttempt: 1,
    outputRetry: 2,
  },
  ...overrides,
});
const response = (): StructuredModelResponse => ({
  value: { summary: `OUTPUT_CONTENT_SENTINEL ${secrets.otherProvider}` },
  provider: "openai",
  model: "allowed-summary",
  usage: { inputTokens: 123, outputTokens: 45 },
});

function fixture(overrides: Partial<LangSmithTracingConfig> = {}) {
  let configuration = { ...baseConfig(), ...overrides };
  const creates: Record<string, unknown>[] = [];
  const updates: Array<{ id: string; run: Record<string, unknown> }> = [];
  const network = vi.fn<typeof fetch>(async () => {
    throw new Error("Unexpected telemetry network request in unit test");
  });
  const clients: Client[] = [];
  const clientFactory = vi.fn<(config: ClientConfig) => Client>((config) => {
    // Exercise the real traceable/RunTree machinery, replacing only the SDK's
    // export methods. Unit tests never send traces to an external service.
    const client = new Client({ ...config, fetchImplementation: network });
    vi.spyOn(client, "createRun").mockImplementation(async (run) => {
      creates.push(JSON.parse(JSON.stringify(run)));
    });
    vi.spyOn(client, "updateRun").mockImplementation(async (id, run) => {
      updates.push({ id, run: JSON.parse(JSON.stringify(run)) });
    });
    vi.spyOn(client, "flush").mockResolvedValue(undefined);
    vi.spyOn(client, "awaitPendingTraceBatches").mockResolvedValue(undefined);
    clients.push(client);
    return client;
  });
  const original = response();
  const supports = vi.fn<StructuredModelGateway["supports"]>(() => true);
  const generate = vi.fn<StructuredModelGateway["generate"]>(
    async () => original
  );
  const delegate = { supports, generate };
  const tracing = new LangSmithModelTracing(() => configuration, {
    clientFactory,
  });
  const wrapped = tracing.wrap(delegate);
  return {
    original,
    configuration,
    setConfiguration: (changes: Partial<LangSmithTracingConfig>) => {
      configuration = { ...configuration, ...changes };
    },
    creates,
    updates,
    clients,
    network,
    clientFactory,
    delegate,
    wrapped,
    tracing,
    payload: () => JSON.stringify({ creates, updates }),
    settled: async () => {
      await vi.waitFor(() => expect(updates).toHaveLength(1));
      expect(network).not.toHaveBeenCalled();
    },
  };
}

describe("LangSmith model tracing", () => {
  it.each(["disabled", "missing credentials"] as const)(
    "forwards capabilities and model calls unchanged when %s despite ambient tracing",
    async (mode) => {
      vi.stubEnv("LANGSMITH_TRACING", "true");
      vi.stubEnv("LANGSMITH_API_KEY", "AMBIENT_TRACING_KEY_SENTINEL");
      const f = fixture(
        mode === "disabled" ? { enabled: false } : { apiKey: undefined }
      );
      const selected = request();
      const operation = context();
      expect(f.wrapped.supports(selected.selection)).toBe(true);
      expect(f.delegate.supports).toHaveBeenCalledWith(selected.selection);
      expect(await f.wrapped.generate(selected, operation)).toBe(f.original);
      expect(f.delegate.generate).toHaveBeenCalledExactlyOnceWith(
        selected,
        operation
      );
      await f.tracing.flush();
      expect(f.clientFactory).not.toHaveBeenCalled();
      expect(f.network).not.toHaveBeenCalled();
      expect(f.creates).toEqual([]);
    }
  );

  it("records LLM metadata and measured usage without capturing prompts, outputs, credentials, or frame bytes", async () => {
    const f = fixture();
    const selected = request();
    const operation = context();
    expect(await f.wrapped.generate(selected, operation)).toBe(f.original);
    expect(f.delegate.generate).toHaveBeenCalledExactlyOnceWith(
      selected,
      operation
    );
    await f.settled();
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0]).toMatchObject({
      name: "scrub.llm.summary",
      run_type: "llm",
      session_name: "scrub-tests",
      tags: ["scrub", "summary", "openai"],
      extra: {
        metadata: {
          ls_provider: "openai",
          ls_model_name: "allowed-summary",
          thread_id: operation.runId,
          scrub_run_id: operation.runId,
          attempt_id: operation.attemptId,
          step: "summary:final",
          call_index: 7,
          repair_attempt: 1,
          output_retry: 2,
          schema_name: "ScrubSummary",
          max_output_tokens: 4096,
          image_count: 1,
          image_bytes: image.byteLength,
        },
      },
      inputs: {
        messages: [
          { role: "system", content: "[content omitted]" },
          { role: "user", content: "[content omitted]" },
        ],
      },
    });
    expect(f.updates[0].run).toMatchObject({
      outputs: {
        choices: [
          { message: { role: "assistant", content: "[content omitted]" } },
        ],
        usage_metadata: {
          input_tokens: 123,
          output_tokens: 45,
          total_tokens: 168,
        },
      },
    });
    const sent = f.payload();
    for (const sentinel of [
      ...Object.values(secrets),
      "SYSTEM_CONTENT_SENTINEL",
      "PROMPT_CONTENT_SENTINEL",
      "OUTPUT_CONTENT_SENTINEL",
      "PRIVATE_FRAME_BYTES_SENTINEL",
      Buffer.from(image).toString("base64"),
    ])
      expect(sent).not.toContain(sentinel);
    expect(sent).not.toContain('"images"');
  });

  it("captures redacted text only when explicitly enabled and always excludes image payloads", async () => {
    const f = fixture({ captureContent: true });
    expect(await f.wrapped.generate(request(), context())).toBe(f.original);
    await f.settled();
    const sent = f.payload();
    for (const sentinel of [
      "SYSTEM_CONTENT_SENTINEL",
      "PROMPT_CONTENT_SENTINEL",
      "OUTPUT_CONTENT_SENTINEL",
      "JSON Schema",
    ])
      expect(sent).toContain(sentinel);
    for (const secret of Object.values(secrets))
      expect(sent).not.toContain(secret);
    expect(sent).not.toContain(Buffer.from(image).toString("base64"));
    expect(sent).not.toContain("PRIVATE_FRAME_BYTES_SENTINEL");
    // Redaction is a telemetry projection, never a mutation of model inputs.
    expect(f.delegate.generate.mock.calls[0][0].system).toContain(
      secrets.provider
    );
    expect(f.original.value).toEqual({
      summary: `OUTPUT_CONTENT_SENTINEL ${secrets.otherProvider}`,
    });
  });

  it("honors a runtime disable after tracing an earlier call", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    const f = fixture();
    await f.wrapped.generate(request(), context());
    await f.settled();
    f.setConfiguration({ enabled: false });
    expect(await f.wrapped.generate(request(), context())).toBe(f.original);
    expect(f.delegate.generate).toHaveBeenCalledTimes(2);
    expect(f.clientFactory).toHaveBeenCalledOnce();
    expect(f.creates).toHaveLength(1);
    expect(f.updates).toHaveLength(1);
  });

  it("records the vision provider and stage without serializing binary frames", async () => {
    const f = fixture();
    const selected = request({
      selection: { provider: "anthropic", model: "allowed-vision" },
      schemaName: "ScrubFrameAnalysis",
      invocation: {
        step: "vision:0:5:frame-digest",
        callIndex: 1,
        repairAttempt: 0,
        outputRetry: 0,
      },
    });
    await f.wrapped.generate(selected, context());
    await f.settled();
    expect(f.creates[0]).toMatchObject({
      name: "scrub.llm.vision",
      tags: ["scrub", "vision", "anthropic"],
      extra: {
        metadata: {
          ls_provider: "anthropic",
          ls_model_name: "allowed-vision",
          step: "vision:0:5:frame-digest",
          call_index: 1,
        },
      },
    });
    expect(f.payload()).not.toContain(Buffer.from(image).toString("base64"));
  });

  it("identifies individual source-note reduction attempts", async () => {
    const f = fixture();
    await f.wrapped.generate(
      request({
        schemaName: "ScrubSourceNotes",
        invocation: {
          step: "reduce:1:0",
          callIndex: 12,
          repairAttempt: 0,
          outputRetry: 1,
        },
      }),
      context()
    );
    await f.settled();
    expect(f.creates[0]).toMatchObject({
      name: "scrub.llm.source_notes",
      tags: ["scrub", "source_notes", "openai"],
      extra: {
        metadata: {
          step: "reduce:1:0",
          call_index: 12,
          repair_attempt: 0,
          output_retry: 1,
        },
      },
    });
  });

  it("preserves model error identity while tracing only its safe category", async () => {
    const f = fixture({ captureContent: true });
    const originalError = new PipelineError(
      "model_authentication_failed",
      "PRIVATE_PROVIDER_ERROR_SENTINEL",
      { cause: new Error("PRIVATE_PROVIDER_CAUSE_SENTINEL") }
    );
    f.delegate.generate.mockRejectedValueOnce(originalError);
    await expect(f.wrapped.generate(request(), context())).rejects.toBe(
      originalError
    );
    await f.settled();
    expect(f.delegate.generate).toHaveBeenCalledOnce();
    const sent = f.payload();
    expect(sent).toContain("model_authentication_failed");
    expect(sent).not.toContain("PRIVATE_PROVIDER_ERROR_SENTINEL");
    expect(sent).not.toContain("PRIVATE_PROVIDER_CAUSE_SENTINEL");
    expect(f.updates[0].run).toMatchObject({
      error: expect.stringContaining("model_authentication_failed"),
    });
  });

  it("does not copy arbitrary provider error codes or properties into trace payloads", async () => {
    const f = fixture({ captureContent: true });
    const originalError = Object.assign(
      new Error("PRIVATE_UNCLASSIFIED_ERROR_SENTINEL"),
      {
        code: "PRIVATE_UNTRUSTED_CODE_SENTINEL",
        headers: { authorization: secrets.provider },
        response: { body: "PRIVATE_ERROR_BODY_SENTINEL" },
      }
    );
    f.delegate.generate.mockRejectedValueOnce(originalError);
    await expect(f.wrapped.generate(request(), context())).rejects.toBe(
      originalError
    );
    await f.settled();
    for (const privateValue of [
      "PRIVATE_UNCLASSIFIED_ERROR_SENTINEL",
      "PRIVATE_UNTRUSTED_CODE_SENTINEL",
      "PRIVATE_ERROR_BODY_SENTINEL",
      secrets.provider,
    ])
      expect(f.payload()).not.toContain(privateValue);
  });

  it("runs the model once when constructing the telemetry client fails", async () => {
    const generate = vi.fn<StructuredModelGateway["generate"]>(async () =>
      response()
    );
    const clientFactory = vi.fn<(config: ClientConfig) => Client>(() => {
      throw new Error("PRIVATE_TELEMETRY_CONFIGURATION_SENTINEL");
    });
    const tracing = new LangSmithModelTracing(baseConfig, { clientFactory });
    const output = await tracing
      .wrap({ supports: () => true, generate })
      .generate(request(), context());
    expect(output).toMatchObject({
      usage: { inputTokens: 123, outputTokens: 45 },
    });
    expect(generate).toHaveBeenCalledOnce();
    await expect(tracing.flush()).resolves.toBeUndefined();
  });

  it("keeps tracing configuration failures from preventing model execution", async () => {
    const original = response();
    const generate = vi.fn<StructuredModelGateway["generate"]>(
      async () => original
    );
    const clientFactory = vi.fn<(config: ClientConfig) => Client>();
    const tracing = new LangSmithModelTracing(
      () => {
        throw new Error("PRIVATE_TRACING_CONFIG_SENTINEL");
      },
      { clientFactory }
    );
    expect(
      await tracing
        .wrap({ supports: () => true, generate })
        .generate(request(), context())
    ).toBe(original);
    expect(generate).toHaveBeenCalledOnce();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("does not fail or repeat a successful model call when trace export fails", async () => {
    const f = fixture();
    const factory = f.clientFactory.getMockImplementation()!;
    f.clientFactory.mockImplementation((config) => {
      const client = factory(config);
      vi.mocked(client.createRun).mockRejectedValue(new Error("Export failed"));
      vi.mocked(client.updateRun).mockRejectedValue(new Error("Export failed"));
      return client;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await f.wrapped.generate(request(), context())).toBe(f.original);
    await f.tracing.flush();
    expect(f.delegate.generate).toHaveBeenCalledOnce();
    expect(f.network).not.toHaveBeenCalled();
  });

  it("preserves in-flight cancellation without waiting for trace delivery", async () => {
    const f = fixture();
    const controller = new AbortController();
    const cancelled = new PipelineError("cancelled", "Cancelled by caller");
    f.delegate.generate.mockImplementation(
      async (_request, operation) =>
        new Promise<StructuredModelResponse>((_resolve, reject) => {
          const abort = () => reject(cancelled);
          operation.signal.addEventListener("abort", abort, { once: true });
          if (operation.signal.aborted) abort();
        })
    );
    const pending = f.wrapped.generate(request(), context(controller.signal));
    await vi.waitFor(() => expect(f.delegate.generate).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toBe(cancelled);
    await f.settled();
    expect(f.payload()).toContain("cancelled");
    expect(f.delegate.generate).toHaveBeenCalledOnce();
  });

  it("starts neither telemetry nor model work for a pre-cancelled operation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.wrapped.generate(request(), context(controller.signal))
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.clientFactory).not.toHaveBeenCalled();
    expect(f.delegate.generate).not.toHaveBeenCalled();
  });

  it("sanitizes export failures before SDK diagnostics can retain response bodies, headers, or fetch exceptions", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(`PRIVATE_EXPORT_RESPONSE_SENTINEL ${secrets.tracing}`, {
          status: 500,
          headers: { "x-private-provider-value": secrets.provider },
        })
    );
    vi.stubGlobal("fetch", fetcher);
    const f = fixture();
    await f.wrapped.generate(request(), context());
    await f.settled();
    const exportRequest = f.clientFactory.mock.calls[0][0].fetchImplementation!;
    const failed = await exportRequest(
      "https://langsmith.example.invalid/runs",
      { method: "POST", body: "{}" }
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).toContain("LangSmith tracing export failed");
    expect(failed.headers.get("x-private-provider-value")).toBeNull();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    fetcher.mockRejectedValueOnce(
      new Error(`PRIVATE_EXPORT_NETWORK_SENTINEL ${secrets.tracing}`)
    );
    const error: unknown = await exportRequest(
      "https://langsmith.example.invalid/runs"
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("LangSmith tracing export failed");
    expect((error as Error).cause).toBeUndefined();
    expect(f.delegate.generate).toHaveBeenCalledOnce();
  });

  it("absorbs trace-drain failures without changing the completed model result", async () => {
    const f = fixture();
    expect(await f.wrapped.generate(request(), context())).toBe(f.original);
    await f.settled();
    vi.mocked(f.clients[0].awaitPendingTraceBatches).mockRejectedValue(
      new Error("PRIVATE_TRACE_DRAIN_SENTINEL")
    );
    await expect(f.tracing.flush()).resolves.toBeUndefined();
    expect(f.delegate.generate).toHaveBeenCalledOnce();
  });

  it("exports actual SDK HTTP payloads with metadata masking and no inherited tracing baggage", async () => {
    vi.stubEnv("LANGCHAIN_PROJECT", "AMBIENT_PROJECT_SENTINEL");
    vi.stubEnv("LANGCHAIN_API_KEY", secrets.otherProvider);
    vi.stubEnv("LANGCHAIN_PRIVATE_METADATA", "AMBIENT_METADATA_SENTINEL");
    const requests: Array<{
      method: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = await new Response(init?.body).text();
      requests.push({
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: JSON.parse(body || "{}"),
      });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const original = response();
    const generate = vi.fn<StructuredModelGateway["generate"]>(
      async () => original
    );
    const tracing = new LangSmithModelTracing(baseConfig, {
      clientFactory: (config) =>
        new Client({ ...config, autoBatchTracing: false }),
    });
    const wrapped = tracing.wrap({ supports: () => true, generate });
    const parentClient = new Client({
      apiKey: "TEST_PARENT_TRACING_CREDENTIAL",
      apiUrl: "https://parent.example.invalid",
      autoBatchTracing: false,
      blockOnRootRunFinalization: false,
      fetchImplementation: async () => {
        throw new Error("Parent trace must never export from this test");
      },
    });
    vi.spyOn(parentClient, "createRun").mockResolvedValue(undefined);
    vi.spyOn(parentClient, "updateRun").mockResolvedValue(undefined);
    const parent = traceable(
      async () => wrapped.generate(request(), context()),
      {
        name: "unrelated-parent",
        project_name: "parent-test",
        client: parentClient,
        tracingEnabled: true,
        metadata: { private_parent_field: "PRIVATE_PARENT_METADATA_SENTINEL" },
        tags: [secrets.provider],
      }
    );
    expect(await parent()).toBe(original);
    await tracing.flush();
    await vi.waitFor(() =>
      expect(requests.some((item) => item.method === "PATCH")).toBe(true)
    );
    const created = requests.find((item) => item.method === "POST")!;
    const updated = requests.find((item) => item.method === "PATCH")!;
    expect(created.headers.get("x-api-key")).toBe(secrets.tracing);
    expect(created.body).toMatchObject({
      run_type: "llm",
      session_name: "scrub-tests",
      extra: {
        metadata: {
          ls_provider: "openai",
          ls_model_name: "allowed-summary",
          thread_id: "request-one/video-one",
        },
      },
    });
    expect(updated.body).toMatchObject({
      outputs: {
        usage_metadata: {
          input_tokens: 123,
          output_tokens: 45,
          total_tokens: 168,
        },
      },
    });
    const sent = JSON.stringify(requests.map((item) => item.body));
    for (const value of [
      ...Object.values(secrets),
      "AMBIENT_PROJECT_SENTINEL",
      "AMBIENT_METADATA_SENTINEL",
      "PRIVATE_PARENT_METADATA_SENTINEL",
      "PROMPT_CONTENT_SENTINEL",
      "OUTPUT_CONTENT_SENTINEL",
      Buffer.from(image).toString("base64"),
    ])
      expect(sent).not.toContain(value);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("keeps secret-echoing HTTP export failures out of actual SDK diagnostics", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warned = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const bodies: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(await new Response(init?.body).text());
      return new Response(
        `PRIVATE_EXPORT_RESPONSE_SENTINEL ${secrets.tracing}`,
        {
          status: 403,
          headers: { "x-private-value": secrets.provider },
        }
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const original = response();
    const generate = vi.fn<StructuredModelGateway["generate"]>(
      async () => original
    );
    const tracing = new LangSmithModelTracing(baseConfig, {
      clientFactory: (config) =>
        new Client({ ...config, autoBatchTracing: false }),
    });
    expect(
      await tracing
        .wrap({ supports: () => true, generate })
        .generate(request(), context())
    ).toBe(original);
    await tracing.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetcher).toHaveBeenCalled();
    expect(generate).toHaveBeenCalledOnce();
    const diagnostics = inspect([...logged.mock.calls, ...warned.mock.calls]);
    for (const value of [
      ...Object.values(secrets),
      "PRIVATE_EXPORT_RESPONSE_SENTINEL",
      "PROMPT_CONTENT_SENTINEL",
      "OUTPUT_CONTENT_SENTINEL",
    ]) {
      expect(diagnostics).not.toContain(value);
      expect(bodies.join("\n")).not.toContain(value);
    }
  });

  it("bounds SDK buffering and flush duration without changing model execution", async () => {
    const f = fixture({ timeoutMs: 50 });
    await f.wrapped.generate(request(), context());
    await f.settled();
    expect(f.clientFactory.mock.calls[0][0]).toMatchObject({
      autoBatchTracing: true,
      manualFlushMode: false,
      maxIngestMemoryBytes: 8 * 1024 * 1024,
      omitTracedRuntimeInfo: true,
      blockOnRootRunFinalization: false,
      timeout_ms: 50,
      debug: false,
      callerOptions: { maxRetries: 0 },
    });
    vi.mocked(f.clients[0].awaitPendingTraceBatches).mockImplementation(
      async () => new Promise(() => undefined)
    );
    vi.useFakeTimers();
    const finished = f.tracing.flush();
    await vi.advanceTimersByTimeAsync(60);
    await expect(finished).resolves.toBeUndefined();
    expect(f.clients[0].awaitPendingTraceBatches).toHaveBeenCalledOnce();
    expect(f.delegate.generate).toHaveBeenCalledOnce();
  });
});
