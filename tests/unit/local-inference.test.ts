import { describe, expect, it, vi } from "vitest";
import { resolveLocalInference } from "../../src/deployments/local/inference.js";
import type {
  InferenceSettingsInput,
  ModelSelection,
  StructuredModelGateway,
} from "../../src/application/model.js";

function fixture() {
  const defaults = vi.fn(
    (): InferenceSettingsInput => ({
      mode: "full",
      summary: { provider: "fixture", model: "summary-v1" },
      vision: { provider: "fixture", model: "vision-v1" },
    })
  );
  const models = {
    supports: vi.fn((_selection: ModelSelection) => true),
    generate: vi.fn(),
  } satisfies StructuredModelGateway;
  return { defaults, models };
}

describe("local inference composition", () => {
  it("leaves preprocessing unchanged and never resolves model configuration by default", () => {
    const { defaults, models } = fixture();
    const result = resolveLocalInference(
      { skipVisuals: true, maxFrames: 2 },
      defaults,
      models,
      false
    );
    expect(result).toEqual({ skipVisuals: true, maxFrames: 2 });
    expect(defaults).not.toHaveBeenCalled();
    expect(models.supports).not.toHaveBeenCalled();
    expect(models.generate).not.toHaveBeenCalled();
  });

  it("enables full settings, forwards public overrides, and retains the model capability separately", () => {
    const { defaults, models } = fixture();
    const result = resolveLocalInference(
      {
        summarize: true,
        summaryProvider: "fixture",
        summaryModel: "summary-v1",
        visionProvider: "fixture",
        visionModel: "vision-v1",
        maxFrames: 2,
      },
      defaults,
      models,
      true
    );
    expect(defaults).toHaveBeenCalledWith({
      summaryProvider: "fixture",
      summaryModel: "summary-v1",
      visionProvider: "fixture",
      visionModel: "vision-v1",
    });
    expect(result).toMatchObject({
      maxFrames: 2,
      inference: {
        mode: "full",
        includeFullTranscript: true,
        summary: { provider: "fixture", model: "summary-v1" },
      },
      models,
    });
    expect(result).not.toHaveProperty("summarize");
    expect(result).not.toHaveProperty("summaryModel");
    expect(models.supports).toHaveBeenCalledTimes(2);
    expect(models.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(result.inference)).not.toMatch(
      /apiKey|OPENAI_API_KEY|ANTHROPIC_API_KEY/
    );
  });

  it("requires explicit summarization opt-in before resolving model overrides", () => {
    const { defaults, models } = fixture();
    expect(() =>
      resolveLocalInference(
        { summaryModel: "summary-v1" },
        defaults,
        models,
        false
      )
    ).toThrow("require --summarize");
    expect(defaults).not.toHaveBeenCalled();
    expect(models.generate).not.toHaveBeenCalled();
  });

  it("requires only the summary capability when visuals are explicitly skipped", () => {
    const { defaults, models } = fixture();
    models.supports.mockImplementation(
      (selection) => selection.model === "summary-v1"
    );
    const result = resolveLocalInference(
      { summarize: true, skipVisuals: true },
      defaults,
      models,
      false
    );
    expect(result).toMatchObject({
      skipVisuals: true,
      inference: { mode: "full" },
    });
    expect(models.supports).toHaveBeenCalledTimes(1);
    expect(models.generate).not.toHaveBeenCalled();
  });

  it("rejects unavailable capabilities during configuration, before model work", () => {
    const { defaults, models } = fixture();
    models.supports.mockReturnValue(false);
    expect(() =>
      resolveLocalInference({ summarize: true }, defaults, models, false)
    ).toThrow("configured model credentials");
    expect(models.generate).not.toHaveBeenCalled();
  });
});
