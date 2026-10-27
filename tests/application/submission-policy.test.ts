import { describe, expect, it } from "vitest";
import {
  SubmissionPolicy,
  canonicalJobValue,
  normalizeJobSubmission,
} from "../../src/application/jobs/submission.js";
import type { InferenceLimits } from "../../src/application/model.js";
import type { ResourceLimits } from "../../src/application/contracts.js";

const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const selections = {
  summary: { provider: "fixture", model: "summary" },
  vision: { provider: "fixture", model: "vision" },
};
const policy = (
  limits: Partial<InferenceLimits> = {},
  resourceCeilings: Partial<ResourceLimits> = {}
) =>
  new SubmissionPolicy({
    requestDefault: 2,
    inferenceDefaults: { mode: "full", ...selections, limits },
    resourceCeilings,
  });

describe("inference resource policy", () => {
  it("preserves omitted request intent for the adaptive limits", () => {
    const input = {
      url,
      settings: {
        inference: {
          limits: {
            initialOutputTokens: 1024,
            outputTokenRetries: 0,
            maxSummaryInputCharacters: 16_000,
          },
        },
      },
    };
    expect(normalizeJobSubmission(input)).toEqual(input);
  });

  it.each([
    { maxOutputTokens: 16_384 },
    { initialOutputTokens: 8192 },
    { initialSourceNoteOutputTokens: 4096 },
    { sourceNoteTargetCharacters: 6000 },
    { maxSummaryInputCharacters: 64_000 },
    { outputTokenRetries: 2 },
  ])("rejects new inference limits above deployment ceilings: %j", (limits) => {
    const bounded = policy({
      maxOutputTokens: 8192,
      initialOutputTokens: 4096,
      initialSourceNoteOutputTokens: 2048,
      sourceNoteTargetCharacters: 3000,
      maxSummaryInputCharacters: 32_000,
      outputTokenRetries: 1,
    });
    expect(() =>
      bounded.resolve({ url, settings: { inference: { limits } } })
    ).toThrow("Inference limits exceed deployment policy");
  });

  it("does not let existing settings bypass current ceilings for new overrides", () => {
    const accepted = policy().resolve({ url });
    const existing = { settings: accepted.settings, input: accepted };
    const bounded = policy(
      {
        maxOutputTokens: 8192,
        initialOutputTokens: 4096,
        initialSourceNoteOutputTokens: 2048,
        sourceNoteTargetCharacters: 3000,
        maxSummaryInputCharacters: 32_000,
        outputTokenRetries: 1,
      },
      { maxSourceBytes: 1024 }
    );
    expect(bounded.resolve({ url }, existing)).toEqual(accepted);
    expect(() =>
      bounded.resolve(
        {
          url,
          settings: { inference: { limits: { maxOutputTokens: 16_384 } } },
        },
        existing
      )
    ).toThrow("Inference limits exceed deployment policy");
    expect(() =>
      bounded.resolve(
        {
          url,
          settings: { limits: { maxSourceBytes: 2048 } },
        },
        existing
      )
    ).toThrow("exceeds server policy");
  });

  it("preserves legacy replay fingerprints when newly introduced limits were never captured", () => {
    const accepted = policy().resolve({
      url,
      settings: { inference: { limits: { maxOutputTokens: 8192 } } },
    });
    const limits = accepted.settings.inference!.limits as unknown as Record<
      string,
      unknown
    >;
    for (const name of [
      "initialOutputTokens",
      "initialSourceNoteOutputTokens",
      "sourceNoteTargetCharacters",
      "maxSummaryInputCharacters",
      "outputTokenRetries",
    ])
      delete limits[name];
    const frozen = canonicalJobValue(accepted);
    const existing = { settings: accepted.settings, input: accepted };
    const bounded = policy({ maxOutputTokens: 4096, outputTokenRetries: 0 });
    expect(canonicalJobValue(bounded.resolve({ url }, existing))).toBe(frozen);
    expect(
      canonicalJobValue(
        bounded.resolve(
          {
            url,
            settings: { inference: { summary: selections.summary } },
          },
          existing
        )
      )
    ).toBe(frozen);
    expect(() =>
      bounded.resolve(
        {
          url,
          settings: { inference: { limits: { outputTokenRetries: 1 } } },
        },
        existing
      )
    ).toThrow("Inference limits exceed deployment policy");
  });
});
