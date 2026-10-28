import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentModelGateway,
  resolveDeploymentModelConfig,
} from "../../src/deployments/model-config.js";
import type { OperationContext } from "../../src/application/contracts.js";
import {
  DEFAULT_INFERENCE_LIMITS,
  resolveInferenceSettings,
  validateInferenceSettingsInput,
  type StructuredModelGateway,
} from "../../src/application/model.js";

describe("inference settings boundaries", () => {
  it.each([
    {},
    { mode: "full" },
    { summary: { provider: "openai", model: "allowed-summary" } },
    { vision: { provider: "anthropic", model: "allowed-vision" } },
    { includeFullTranscript: true, limits: { maxModelCalls: 3 } },
    {
      limits: {
        initialOutputTokens: 4096,
        maxOutputTokens: 8192,
        sourceNoteTargetCharacters: 3000,
        initialSourceNoteOutputTokens: 2048,
        maxSummaryInputCharacters: 32_000,
        outputTokenRetries: 1,
      },
    },
  ])(
    "preserves partial request intent without resolved defaults: %j",
    (input) => {
      expect(validateInferenceSettingsInput(input)).toEqual(input);
    }
  );

  it("applies library defaults only when resolving settings", () => {
    expect(resolveInferenceSettings()).toBeUndefined();
    expect(resolveInferenceSettings({})).toEqual({
      mode: "preprocess",
      includeFullTranscript: false,
      limits: DEFAULT_INFERENCE_LIMITS,
    });
    expect(() => resolveInferenceSettings({ mode: "full" })).toThrow(
      "Full processing requires"
    );
    expect(DEFAULT_INFERENCE_LIMITS).toMatchObject({
      initialOutputTokens: 16_384,
      maxOutputTokens: 32_768,
      sourceNoteTargetCharacters: 9000,
      initialSourceNoteOutputTokens: 8192,
      maxSummaryInputCharacters: 64_000,
      outputTokenRetries: 2,
    });
  });

  it("clips initial and source-note budgets to an explicitly lower hard ceiling", () => {
    const settings = resolveInferenceSettings({
      limits: { maxOutputTokens: 1024 },
    });
    expect(settings?.limits).toMatchObject({
      initialOutputTokens: 1024,
      maxOutputTokens: 1024,
      initialSourceNoteOutputTokens: 1024,
    });
  });

  it.each([
    { initialOutputTokens: 32_769 },
    { initialSourceNoteOutputTokens: 32_769 },
    { sourceNoteTargetCharacters: 200_001 },
    { maxSummaryInputCharacters: 512_001 },
    { outputTokenRetries: 5 },
    { outputTokenRetries: 1.5 },
  ])("rejects unbounded adaptive inference settings: %j", (limits) => {
    expect(() => validateInferenceSettingsInput({ limits })).toThrow(
      "Invalid inference settings"
    );
  });
});

describe("deployment model registry", () => {
  it("loads environment credentials lazily and wraps only generation, keeping preflight network-free", async () => {
    let key: string | undefined;
    const order: string[] = [];
    const selection = { provider: "openai", model: "gpt-6.1-sol" };
    const loadEnvironment = vi.fn(() => ({ OPENAI_API_KEY: key }));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("Preflight must not make a network request")
      );
    const tracing = {
      wrap: vi.fn((delegate: StructuredModelGateway) => {
        order.push("wrap");
        expect(delegate.supports(selection)).toBe(true);
        return {
          supports: (model: typeof selection) => delegate.supports(model),
          generate: vi.fn(async () => {
            order.push("generate");
            return { value: { complete: true }, ...selection };
          }),
        };
      }),
    };
    try {
      const gateway = createDeploymentModelGateway(loadEnvironment, tracing);
      expect(loadEnvironment).not.toHaveBeenCalled();
      expect(gateway.supports(selection)).toBe(false);
      key = "test-only-provider-key";
      expect(gateway.supports(selection)).toBe(true);
      expect(tracing.wrap).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(
        await gateway.generate(
          {
            selection,
            system: "system",
            prompt: "prompt",
            schema: {},
            schemaName: "fixture",
            maxOutputTokens: 512,
          },
          {
            runId: "run",
            attemptId: "attempt",
            signal: new AbortController().signal,
            now: Date.now,
            emit: () => {},
          }
        )
      ).toMatchObject({ value: { complete: true } });
      expect(order).toEqual(["wrap", "generate"]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("honors cancellation before loading credentials, tracing, or network work", async () => {
    const controller = new AbortController();
    const loadEnvironment = vi.fn(() => ({
      OPENAI_API_KEY: "test-only-provider-key",
    }));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("Cancelled generation must not make a network request")
      );
    const tracing = {
      wrap: vi.fn((delegate: StructuredModelGateway) => delegate),
    };
    const gateway = createDeploymentModelGateway(loadEnvironment, tracing);
    controller.abort(new Error("Generation cancelled before starting"));
    try {
      await expect(
        gateway.generate(
          {
            selection: { provider: "openai", model: "gpt-6.1-sol" },
            system: "",
            prompt: "",
            schema: {},
            schemaName: "fixture",
            maxOutputTokens: 512,
          },
          {
            runId: "run",
            attemptId: "attempt",
            signal: controller.signal,
            now: Date.now,
            emit: () => {},
          }
        )
      ).rejects.toThrow("Generation cancelled before starting");
      expect(loadEnvironment).not.toHaveBeenCalled();
      expect(tracing.wrap).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("defaults full processing to OpenAI and keeps credentials out of persisted defaults", () => {
    const config = resolveDeploymentModelConfig({
      OPENAI_API_KEY: "test-only-provider-key",
      ANTHROPIC_API_KEY: "test-only-anthropic-key",
    });
    expect(config.defaults).toMatchObject({
      mode: "full",
      summary: { provider: "openai", model: "gpt-6.1-sol" },
      vision: { provider: "openai", model: "gpt-6.1-terra" },
    });
    expect(config.providers[0]).toMatchObject({
      name: "openai",
      allowedModels: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
    });
    expect(config.providers[1]).toMatchObject({
      name: "anthropic",
      allowedModels: ["claude-sonnet-5-5"],
    });
    expect(JSON.stringify(config.defaults)).not.toContain("test-only");
  });

  it("supplies a ten-minute provider deadline when no runtime override is set", () => {
    const config = resolveDeploymentModelConfig({});
    for (const provider of config.providers)
      expect(provider.timeoutMs).toBe(600_000);
  });

  it.each(["1", "600000", "1800000"])(
    "applies runtime model timeout %s to both providers without changing persisted settings",
    (timeout) => {
      const environment = Object.freeze({ SCRUB_MODEL_TIMEOUT_MS: timeout });
      const config = resolveDeploymentModelConfig(environment);
      expect(
        config.providers.map(({ name, timeoutMs }) => ({ name, timeoutMs }))
      ).toEqual([
        { name: "openai", timeoutMs: Number(timeout) },
        { name: "anthropic", timeoutMs: Number(timeout) },
      ]);
      expect(config.defaults).toEqual(
        resolveDeploymentModelConfig({}).defaults
      );
      expect(environment.SCRUB_MODEL_TIMEOUT_MS).toBe(timeout);
    }
  );

  it.each([
    "",
    " ",
    "0",
    "-1",
    "+1",
    "1800001",
    "600000.0",
    "1.5",
    "1e3",
    "0x10",
    "1000ms",
    "1000 ",
    " 1000",
    "NaN",
    "Infinity",
    "9007199254740992",
    "99999999999999999999999999999999999999999",
  ])("rejects invalid runtime model timeout %j", (timeout) => {
    expect(() =>
      resolveDeploymentModelConfig({ SCRUB_MODEL_TIMEOUT_MS: timeout })
    ).toThrow("SCRUB_MODEL_TIMEOUT_MS must be an integer from 1 to 1800000");
  });

  it.each(["openai", "anthropic"] as const)(
    "uses the runtime override for the actual %s model call deadline",
    async (provider) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const response =
        provider === "openai"
          ? {
              choices: [
                { message: { content: '{"ok":true}' }, finish_reason: "stop" },
              ],
            }
          : {
              content: [{ type: "text", text: '{"ok":true}' }],
              stop_reason: "end_turn",
            };
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
        })
      );
      try {
        const gateway = createDeploymentModelGateway(() => ({
          SCRUB_MODEL_TIMEOUT_MS: "600000",
          OPENAI_API_KEY: "test-only-openai-key",
          ANTHROPIC_API_KEY: "test-only-anthropic-key",
        }));
        const result = await gateway.generate(
          {
            selection: {
              provider,
              model:
                provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5",
            },
            system: "Fixture system",
            prompt: "Fixture prompt",
            schema: { type: "object" },
            schemaName: "Fixture",
            maxOutputTokens: 512,
          },
          {
            runId: "test",
            attemptId: "1",
            signal: new AbortController().signal,
            now: Date.now,
            emit: () => undefined,
          }
        );
        expect(result.value).toEqual({ ok: true });
        expect(timeout).toHaveBeenCalledWith(600000);
        expect(fetch).toHaveBeenCalledOnce();
      } finally {
        fetch.mockRestore();
        timeout.mockRestore();
      }
    }
  );
  it("allows only server-registered model selections and bounded inference settings", () => {
    expect(
      resolveDeploymentModelConfig({ SCRUB_SUMMARY_PROVIDER: "anthropic" })
        .defaults.summary
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(() =>
      resolveDeploymentModelConfig({ SCRUB_SUMMARY_MODEL: "unregistered" })
    ).toThrow("Invalid SCRUB_SUMMARY");
    expect(() =>
      resolveDeploymentModelConfig({ SCRUB_OPENAI_MODELS: "" })
    ).toThrow("allowlist");
    expect(() =>
      resolveDeploymentModelConfig({
        SCRUB_INFERENCE_LIMITS: '{"maxImageBytes":9999999}',
      })
    ).toThrow("image limit");
    expect(() =>
      resolveDeploymentModelConfig({
        SCRUB_INFERENCE_LIMITS: '{"apiKey":"must-not-appear"}',
      })
    ).toThrow("Invalid SCRUB_INFERENCE_LIMITS");
    expect(
      resolveDeploymentModelConfig({
        SCRUB_OPENAI_MODELS: "gpt-6.1-sol,gpt-6-luna,another",
        SCRUB_VISION_MODEL: "another",
        SCRUB_INFERENCE_LIMITS: '{"maxModelCalls":10}',
      }).defaults
    ).toMatchObject({
      vision: { model: "another" },
      limits: { maxModelCalls: 10 },
    });
  });
  it("retains the previous OpenAI model as an explicit allowed selection", () => {
    expect(
      resolveDeploymentModelConfig({
        SCRUB_SUMMARY_MODEL: "gpt-6-luna",
        SCRUB_VISION_MODEL: "gpt-6-luna",
      }).defaults
    ).toMatchObject({
      summary: { provider: "openai", model: "gpt-6-luna" },
      vision: { provider: "openai", model: "gpt-6-luna" },
    });
  });
  it("uses a rotated environment credential for the next actual model request", async () => {
    let key = "test-only-first-provider-key";
    const gateway = createDeploymentModelGateway(() => ({
      OPENAI_API_KEY: key,
    }));
    const selection = { provider: "openai", model: "gpt-6.1-sol" };
    const context: OperationContext = {
      runId: "test",
      attemptId: "1",
      signal: new AbortController().signal,
      now: Date.now,
      emit: () => undefined,
    };
    const authorization: Array<string | null> = [];
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const headers = new Headers(
          input instanceof Request ? input.headers : undefined
        );
        new Headers(init?.headers).forEach((value, name) =>
          headers.set(name, value)
        );
        authorization.push(headers.get("authorization"));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"ok":true}' }, finish_reason: "stop" },
            ],
          }),
          { headers: { "content-type": "application/json" } }
        );
      });
    const request = {
      selection,
      system: "system",
      prompt: "prompt",
      schema: { type: "object" },
      schemaName: "test",
      maxOutputTokens: 512,
    };
    try {
      expect(gateway.supports(selection)).toBe(true);
      expect(gateway.supports({ ...selection, model: "unregistered" })).toBe(
        false
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(await gateway.generate(request, context)).toMatchObject({
        value: { ok: true },
      });
      key = "test-only-rotated-provider-key";
      expect(await gateway.generate(request, context)).toMatchObject({
        value: { ok: true },
      });
      expect(authorization).toEqual([
        "Bearer test-only-first-provider-key",
        "Bearer test-only-rotated-provider-key",
      ]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
    }
  });
  it("drops a removed credential before the next model call instead of using its cached client", async () => {
    let key: string | undefined = "test-only-provider-key";
    const selection = { provider: "openai", model: "gpt-6.1-terra" };
    const gateway = createDeploymentModelGateway(() => ({
      OPENAI_API_KEY: key,
    }));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("An unconfigured model must not make a network request")
      );
    try {
      expect(gateway.supports(selection)).toBe(true);
      key = undefined;
      await expect(
        gateway.generate(
          {
            selection,
            system: "system",
            prompt: "prompt",
            schema: { type: "object" },
            schemaName: "test",
            maxOutputTokens: 512,
          },
          {
            runId: "test",
            attemptId: "1",
            signal: new AbortController().signal,
            now: Date.now,
            emit: () => undefined,
          }
        )
      ).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(gateway.supports(selection)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
