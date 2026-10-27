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
} from "../../src/application/model.js";

describe("inference settings boundaries", () => {
  it.each([
    {},
    { mode: "full" },
    { summary: { provider: "openai", model: "allowed-summary" } },
    { vision: { provider: "anthropic", model: "allowed-vision" } },
    { includeFullTranscript: true, limits: { maxModelCalls: 3 } },
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
  });
});

describe("deployment model registry", () => {
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
  it("loads credentials lazily and refreshes before each generation while honoring abort", async () => {
    let key: string | undefined;
    let refreshes = 0;
    const controller = new AbortController();
    const gateway = createDeploymentModelGateway(
      () => ({ OPENAI_API_KEY: key }),
      async () => {
        refreshes++;
        controller.abort();
      }
    );
    const selection = { provider: "openai", model: "gpt-6.1-sol" };
    expect(gateway.supports(selection)).toBe(false);
    key = "test-only-provider-key";
    expect(gateway.supports(selection)).toBe(true);
    expect(gateway.supports({ ...selection, model: "unregistered" })).toBe(
      false
    );
    const context: OperationContext = {
      runId: "test",
      attemptId: "1",
      signal: controller.signal,
      now: Date.now,
      emit: () => undefined,
    };
    await expect(
      gateway.generate(
        {
          selection,
          system: "system",
          prompt: "prompt",
          schema: {},
          schemaName: "test",
          maxOutputTokens: 512,
        },
        context
      )
    ).rejects.toThrow();
    expect(refreshes).toBe(1);
  });
  it("drops a removed credential before the next model call instead of using its cached client", async () => {
    let key: string | undefined = "test-only-provider-key";
    const selection = { provider: "openai", model: "gpt-6.1-terra" };
    const gateway = createDeploymentModelGateway(
      () => ({ OPENAI_API_KEY: key }),
      async () => {
        key = undefined;
      }
    );
    expect(gateway.supports(selection)).toBe(true);
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
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
