import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LangSmithTracingConfig } from "../../src/infrastructure/observability/LangSmithModelTracing.js";
import type { StructuredModelGateway } from "../../src/application/model.js";

const f = vi.hoisted(() => {
  type Server = {
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
    events: Map<string, () => void>;
  };
  const servers: Server[] = [];
  const makeServer = () => {
    const server: Server = {
      events: new Map(),
      on: vi.fn((event: string, listener: () => void) => {
        server.events.set(event, listener);
        return server;
      }),
      close: vi.fn((callback: () => void) => {
        callback();
        return server;
      }),
      listen: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    servers.push(server);
    return server;
  };
  const registry = {
    start: vi.fn(),
    shutdown: vi.fn<() => Promise<void>>(),
    routes: { prometheusMetrics: vi.fn() },
  };
  return {
    registry,
    makeServer,
    servers,
    setup: vi.fn(() => registry),
    closeMcp: vi.fn<() => Promise<void>>(),
    tracers: [] as Array<{
      load: () => LangSmithTracingConfig;
      flush: ReturnType<typeof vi.fn>;
    }>,
    configureInference: vi.fn(),
    credentialServices: [] as Array<readonly string[]>,
    resolveCredentials:
      vi.fn<
        () => Promise<{
          openai?: string;
          anthropic?: string;
          langsmith?: string;
        }>
      >(),
    signals: new Map<string, () => void>(),
  };
});
vi.mock("rivetkit", () => ({ setup: f.setup }));
vi.mock("../../src/infrastructure/rivet/jobs.js", () => ({
  scrubAdmission: {},
  scrubRequest: {},
  scrubVideo: {},
  configureRivetJobs: vi.fn(),
  configureRivetSubmissionPolicy: vi.fn(),
  configureRivetInference: f.configureInference,
}));
vi.mock("../../src/infrastructure/rivet/credentials.js", () => ({
  scrubCredentials: {},
  configureRivetCredentials: vi.fn(),
  RivetCredentialsResolver: class {
    constructor(
      _client: unknown,
      _token: unknown,
      services: readonly string[]
    ) {
      f.credentialServices.push(services);
    }
    resolve = f.resolveCredentials;
  },
}));
vi.mock("../../src/infrastructure/rivet/JobGateway.js", () => ({
  RivetJobGateway: class {},
}));
vi.mock("../../src/infrastructure/node/http/server.js", () => ({
  createNodeHttpServer: f.makeServer,
  parsePort: (_value: unknown, fallback: number) => fallback,
}));
vi.mock("../../src/infrastructure/node/http/metrics.js", () => ({
  createMetricsServer: f.makeServer,
}));
vi.mock("../../src/entrypoints/api/handler.js", () => ({
  createApiHandler: vi.fn(),
}));
vi.mock("../../src/entrypoints/mcp/handler.js", () => ({
  createMcpHandler: () => ({ fetch: vi.fn(), close: f.closeMcp }),
}));
vi.mock(
  "../../src/infrastructure/observability/LangSmithModelTracing.js",
  () => ({
    LangSmithModelTracing: class {
      flush = vi.fn(async () => {});
      constructor(readonly load: () => LangSmithTracingConfig) {
        f.tracers.push(this);
      }
      wrap(delegate: StructuredModelGateway) {
        return delegate;
      }
    },
  })
);

let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  f.servers.length = 0;
  f.tracers.length = 0;
  f.credentialServices.length = 0;
  f.signals.clear();
  f.registry.shutdown.mockResolvedValue(undefined);
  f.closeMcp.mockResolvedValue(undefined);
  f.resolveCredentials.mockResolvedValue({
    openai: "actor-model-secret",
    langsmith: "actor-trace-secret",
  });
  originalExitCode = process.exitCode;
  const once = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      f.signals.set(event, listener as () => void);
      return process;
    }
    return once(event, listener);
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [name, value] of Object.entries({
    RIVET_TOKEN: "",
    RIVET_ENDPOINT: "",
    SCRUB_API_TOKEN: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    LANGSMITH_API_KEY: "",
    LANGSMITH_TRACING: "false",
    LANGSMITH_PROJECT: "fixture",
    LANGSMITH_ENDPOINT: "https://api.smith.langchain.com",
    LANGSMITH_WORKSPACE_ID: "",
    SCRUB_LANGSMITH_CAPTURE_CONTENT: "false",
    SCRUB_LANGSMITH_TIMEOUT_MS: "2000",
    SCRUB_MODEL_CREDENTIAL_SOURCE: "rivet",
  }))
    vi.stubEnv(name, value);
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Rivet host tracing composition", () => {
  it.each([false, true])(
    "requests the tracing credential only when enabled=%s",
    async (enabled) => {
      vi.stubEnv("LANGSMITH_TRACING", String(enabled));
      await import("../../src/deployments/rivet/main.js");
      expect(f.setup).toHaveBeenCalledWith(
        expect.objectContaining({ shutdown: { disableSignalHandlers: true } })
      );
      const config = f.configureInference.mock.calls[0][0];
      await config.resolveModels({
        abortSignal: new AbortController().signal,
        client: () => ({}),
      });
      expect(f.credentialServices).toEqual([
        enabled
          ? ["openai", "anthropic", "langsmith"]
          : ["openai", "anthropic"],
      ]);
      expect(f.tracers[0].load()).toMatchObject({
        enabled,
        apiKey: "actor-trace-secret",
        redactValues: expect.arrayContaining([
          "actor-model-secret",
          "actor-trace-secret",
        ]),
      });
      f.signals.get("SIGTERM")!();
      await vi.waitFor(() => expect(f.tracers[0].flush).toHaveBeenCalledOnce());
    }
  );

  it("drains actors before flushing and shares one close across signals and startup failures", async () => {
    let drained!: () => void;
    f.registry.shutdown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          drained = resolve;
        })
    );
    await import("../../src/deployments/rivet/main.js");
    f.signals.get("SIGTERM")!();
    f.signals.get("SIGINT")!();
    f.servers[0].events.get("error")!();
    f.servers[1].events.get("error")!();
    expect(f.registry.shutdown).toHaveBeenCalledOnce();
    expect(f.closeMcp).toHaveBeenCalledOnce();
    for (const server of f.servers) expect(server.close).toHaveBeenCalledOnce();
    expect(f.tracers[0].flush).not.toHaveBeenCalled();
    drained();
    await vi.waitFor(() => expect(f.tracers[0].flush).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
  });
});
