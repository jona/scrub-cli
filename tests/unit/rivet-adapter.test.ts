import { describe, expect, it, vi } from "vitest";
import { UserError } from "rivetkit";
import type { BuildPromptInput } from "../../src/core/artifacts.js";
import { scrub } from "../../src/infrastructure/rivet/actor.js";
import { RivetArtifactRepository } from "../../src/infrastructure/rivet/ArtifactRepository.js";
import { createArtifactState } from "../../src/application/ArtifactService.js";

vi.mock("../../src/infrastructure/Config.js", () => ({
  config: { getOutput: () => ({ includeFullTranscript: false }) },
}));

describe("Rivet artifact adapter", () => {
  it("delegates actor actions to the application service and durable context", async () => {
    const context = { state: createArtifactState() };
    const input = {
      metadata: { title: "Notes" },
      content: "A durable document",
    };
    const result = await scrub.config.actions.buildPrompt(context, input);

    expect(result.revision).toBe(1);
    expect(context.state.prompt?.prompt).toContain(input.content);
    expect(await scrub.config.actions.getArtifacts(context)).toEqual(result);
    expect(
      await scrub.config.actions.getArtifacts({ state: createArtifactState() })
    ).toEqual(createArtifactState());
  });

  it("translates rejected asynchronous validation into Rivet errors without writing", async () => {
    const context = { state: createArtifactState() };
    await expect(
      scrub.config.actions.buildPrompt(context, {
        metadata: { title: "Notes" },
        content: "",
      })
    ).rejects.toBeInstanceOf(UserError);
    await expect(
      scrub.config.actions.buildPrompt(context, {
        metadata: { title: "Notes" },
        content: "💡".repeat(70_000),
      })
    ).rejects.toMatchObject({ code: "input_too_large" });
    expect(context.state).toEqual(createArtifactState());
  });

  it("keeps actor updates atomic across concurrent service calls", async () => {
    const context = { state: createArtifactState() };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        scrub.config.actions.buildPrompt(context, {
          metadata: { title: "Notes" },
          content: `Revision ${index}`,
        })
      )
    );
    expect(results.map((state) => state.revision)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(context.state.revision).toBe(8);
  });

  it.each([100, 1_000])(
    "bounds transport error details for malformed nested collections (%i items)",
    async (length) => {
      const context = { state: createArtifactState() };
      const input = {
        metadata: { title: "Notes" },
        content: "Notes",
        visuals: Array.from({ length }, () => ({})),
      } as unknown as BuildPromptInput;
      const error = await scrub.config.actions
        .buildPrompt(context, input)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(UserError);
      if (!(error instanceof UserError)) throw error;
      expect(error.code).toBe("invalid_input");
      if (length <= 100) {
        expect(error.metadata?.issues).toHaveLength(20);
        expect(error.metadata?.issueCount).toBeGreaterThan(20);
      } else {
        // Patched Zod rejects oversized collections before traversing their items.
        expect(error.metadata?.issues.length).toBeLessThanOrEqual(20);
        expect(error.metadata?.issueCount).toBeLessThanOrEqual(20);
      }
      expect(Buffer.byteLength(JSON.stringify(error.metadata))).toBeLessThan(
        10_000
      );
      expect(context.state.revision).toBe(0);
    }
  );

  it("does not replace state when a transition throws", () => {
    const context = { state: createArtifactState() };
    const repository = new RivetArtifactRepository(context);
    const before = context.state;
    expect(() =>
      repository.update(() => {
        throw new Error("Failed transition");
      })
    ).toThrow("Failed transition");
    expect(repository.get()).toBe(before);
  });
});
