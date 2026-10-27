import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "langsmith";
import type { StructuredModelGateway } from "../../src/application/model.js";
import type { LangSmithTracingConfig } from "../../src/infrastructure/observability/LangSmithModelTracing.js";
import type { CliDependencies } from "../../src/entrypoints/cli/dependencies.js";

const f = vi.hoisted(() => ({
  tracers: [] as Array<{
    load: () => LangSmithTracingConfig;
    flush: ReturnType<typeof vi.fn>;
  }>,
  runtimeOptions: [] as Array<{ models: StructuredModelGateway }>,
  closeRuntime: vi.fn<() => Promise<void>>(),
  runCli: vi.fn<() => Promise<void>>(),
  configApiKey: vi.fn<(provider: string) => string | undefined>(),
  start: vi.fn(),
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
vi.mock("../../src/infrastructure/node/jobs/LocalJobRuntime.js", () => ({
  LocalJobRuntime: class {
    jobs = {};
    signal = new AbortController().signal;
    constructor(options: { models: StructuredModelGateway }) {
      f.runtimeOptions.push(options);
    }
    start = f.start;
    close = f.closeRuntime;
  },
}));
vi.mock("../../src/entrypoints/cli/index.js", () => ({ runCli: f.runCli }));
vi.mock("../../src/infrastructure/Config.js", () => ({
  config: { getApiKey: f.configApiKey },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  f.tracers.length = 0;
  f.runtimeOptions.length = 0;
  f.closeRuntime.mockResolvedValue(undefined);
  f.runCli.mockResolvedValue(undefined);
  f.configApiKey.mockReturnValue(undefined);
  vi.stubEnv("LANGSMITH_TRACING", "false");
  vi.stubEnv("SCRUB_LANGSMITH_CAPTURE_CONTENT", "false");
  vi.stubEnv("SCRUB_LANGSMITH_TIMEOUT_MS", "2000");
  vi.stubEnv("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com");
  vi.stubEnv("LANGSMITH_PROJECT", "fixture");
  vi.stubEnv("LANGSMITH_WORKSPACE_ID", "");
  vi.stubEnv("LANGSMITH_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deployment-owned tracing lifecycle", () => {
  it("redacts Config fallback provider keys from captured CLI trace content", async () => {
    const openaiKey = "CONFIG_ONLY_OPENAI_CREDENTIAL_SENTINEL";
    const anthropicKey = "CONFIG_ONLY_ANTHROPIC_CREDENTIAL_SENTINEL";
    f.configApiKey.mockImplementation((provider) =>
      provider === "openai" ? openaiKey : anthropicKey
    );
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGSMITH_API_KEY", "test-only-tracing-credential");
    vi.stubEnv("SCRUB_LANGSMITH_CAPTURE_CONTENT", "true");
    await import("../../src/deployments/local/cli.js");
    const configuration = f.tracers[0].load;
    expect(configuration()).toMatchObject({
      enabled: true,
      captureContent: true,
      redactValues: expect.arrayContaining([openaiKey, anthropicKey]),
    });

    const { LangSmithModelTracing } = await vi.importActual<
      typeof import("../../src/infrastructure/observability/LangSmithModelTracing.js")
    >("../../src/infrastructure/observability/LangSmithModelTracing.js");
    const payloads: string[] = [];
    const tracing = new LangSmithModelTracing(configuration, {
      clientFactory: (settings) =>
        new Client({
          ...settings,
          autoBatchTracing: false,
          fetchImplementation: async (_input, init) => {
            payloads.push(await new Response(init?.body).text());
            return new Response("{}", {
              headers: { "content-type": "application/json" },
            });
          },
        }),
    });
    const result = {
      value: { text: `visible result ${anthropicKey}` },
      provider: "openai",
      model: "test-model",
    };
    const generate = vi.fn(async () => result);
    expect(
      await tracing.wrap({ supports: () => true, generate }).generate(
        {
          selection: { provider: "openai", model: "test-model" },
          system: "test system",
          prompt: `visible prompt ${openaiKey}`,
          schema: {},
          schemaName: "ScrubSummary",
          maxOutputTokens: 512,
        },
        {
          runId: "test-run",
          attemptId: "test-attempt",
          signal: new AbortController().signal,
          now: () => 0,
          emit: () => undefined,
        }
      )
    ).toBe(result);
    await tracing.flush();
    await vi.waitFor(() =>
      expect(payloads.join("\n")).toContain("visible result")
    );
    const sent = payloads.join("\n");
    expect(sent).toContain("visible prompt");
    expect(sent).toContain("[redacted]");
    expect(sent).not.toContain(openaiKey);
    expect(sent).not.toContain(anthropicKey);
    expect(generate).toHaveBeenCalledOnce();
    expect(result.value.text).toContain(anthropicKey);
  });

  it("returns from CLI action failures so the deployment can flush before process exit", async () => {
    const originalExitCode = process.exitCode;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Immediate process exit bypassed cleanup");
    });
    const { logger } = await import("../../src/utils/logger.js");
    for (const method of ["banner", "error", "keyValue"] as const)
      vi.spyOn(logger, method).mockImplementation(() => {});
    const { runCli } = await vi.importActual<
      typeof import("../../src/entrypoints/cli/index.js")
    >("../../src/entrypoints/cli/index.js");
    const processFile = vi
      .fn()
      .mockRejectedValue(new Error("model request failed"));
    const prerequisites = vi
      .fn()
      .mockResolvedValue({ ready: false, missing: ["ffmpeg"], warnings: [] });
    const dependencies = {
      config: {},
      processFile,
      checkFilePrerequisites: prerequisites,
    } as unknown as CliDependencies;
    try {
      await runCli(["node", "scrub", "file", "fixture.mp4"], dependencies);
      expect(process.exitCode).toBe(1);
      expect(processFile).not.toHaveBeenCalled();
      prerequisites.mockResolvedValue({
        ready: true,
        missing: [],
        warnings: [],
      });
      await runCli(["node", "scrub", "file", "fixture.mp4"], dependencies);
      expect(processFile).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("drains local work before flushing once across concurrent closes", async () => {
    let finish!: () => void;
    f.closeRuntime.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const { createLocalApplicationFromEnvironment } =
      await import("../../src/deployments/local/application.js");
    const env: Record<string, string | undefined> = {
      LANGSMITH_TRACING: "true",
      LANGSMITH_API_KEY: "first-trace-secret",
    };
    const app = createLocalApplicationFromEnvironment(env);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.tracers[0].load().apiKey).toBe("first-trace-secret");
    env.LANGSMITH_API_KEY = "rotated-trace-secret";
    expect(f.tracers[0].load().apiKey).toBe("rotated-trace-secret");
    const closed = app.close();
    expect(app.close()).toBe(closed);
    expect(f.closeRuntime).toHaveBeenCalledOnce();
    expect(f.tracers[0].flush).not.toHaveBeenCalled();
    finish();
    await closed;
    expect(f.tracers[0].flush).toHaveBeenCalledOnce();
  });

  it("flushes when runtime shutdown fails and preserves that failure", async () => {
    f.closeRuntime.mockRejectedValue(new Error("runtime drain failed"));
    const { createLocalApplicationFromEnvironment } =
      await import("../../src/deployments/local/application.js");
    const app = createLocalApplicationFromEnvironment({});
    await expect(app.close()).rejects.toThrow("runtime drain failed");
    await expect(app.close()).rejects.toThrow("runtime drain failed");
    expect(f.closeRuntime).toHaveBeenCalledOnce();
    expect(f.tracers[0].flush).toHaveBeenCalledOnce();
  });

  it("validates tracing policy before opening a local runtime", async () => {
    const { createLocalApplicationFromEnvironment } =
      await import("../../src/deployments/local/application.js");
    expect(() =>
      createLocalApplicationFromEnvironment({ LANGSMITH_TRACING: "yes" })
    ).toThrow("LANGSMITH_TRACING");
    expect(f.start).not.toHaveBeenCalled();
    expect(f.runtimeOptions).toHaveLength(0);
  });

  it.each([false, true])(
    "flushes CLI traces on completion or failure (failure=%s)",
    async (fails) => {
      if (fails) f.runCli.mockRejectedValue(new Error("CLI processing failed"));
      const completion = import("../../src/deployments/local/cli.js");
      if (fails)
        await expect(completion).rejects.toThrow("CLI processing failed");
      else await completion;
      expect(f.runCli).toHaveBeenCalledOnce();
      expect(f.tracers).toHaveLength(1);
      expect(f.tracers[0].flush).toHaveBeenCalledOnce();
    }
  );
});
