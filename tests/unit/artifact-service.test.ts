import { describe, expect, it } from "vitest";
import type {
  ArtifactState,
  RenderSummaryInput,
} from "../../src/core/artifacts.js";
import {
  ArtifactService,
  createArtifactState,
} from "../../src/application/ArtifactService.js";
import type { ArtifactRepository } from "../../src/application/ports/ArtifactRepository.js";

/** A document-scoped fake whose queued updates satisfy the atomic port contract. */
class MemoryArtifactRepository implements ArtifactRepository {
  private state = createArtifactState();
  private pending: Promise<void> = Promise.resolve();
  writes = 0;
  failure: Error | null = null;

  async get(): Promise<ArtifactState> {
    await this.pending;
    if (this.failure) throw this.failure;
    return structuredClone(this.state);
  }

  update(
    change: (current: Readonly<ArtifactState>) => ArtifactState
  ): Promise<ArtifactState> {
    const result = this.pending.then(async () => {
      // Model storage that yields between receiving an update and committing it.
      await Promise.resolve();
      if (this.failure) throw this.failure;
      const next = change(structuredClone(this.state));
      this.state = structuredClone(next);
      this.writes += 1;
      return structuredClone(next);
    });
    this.pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const promptInput = {
  metadata: { title: "Document notes" },
  content: "One document owns its artifacts.",
};

function renderInput(): RenderSummaryInput {
  return {
    metadata: { title: "Document notes" },
    summary: {
      tldr: "Document storage is independent of the transport.",
      overview: "An artifact service records validated outputs.",
      thesisAndClaims: { thesis: "Separate responsibilities", keyClaims: [] },
      actionableInsights: [],
      concepts: [],
      mentalModels: [],
      structureMap: [],
      openQuestions: [],
      notableQuotes: [],
      biasAnalysis: { perspective: "", possibleBiases: [], blindSpots: [] },
      knowledgeGraph: {
        topics: [],
        people: [],
        tools: [],
        technologies: [],
        relationships: [],
      },
      difficulty: {
        level: "beginner",
        prerequisites: [],
        targetAudience: "Developers",
      },
      reusabilityPrompts: {},
      confidence: { level: "high", reasoning: "A working example" },
      sections: [],
      keyTakeaways: [],
      codeSnippets: [],
      references: [],
    },
  };
}

describe("ArtifactService", () => {
  it("starts with independent empty state values", async () => {
    const first = createArtifactState();
    const second = createArtifactState();
    first.revision = 10;
    expect(second).toEqual({ revision: 0, prompt: null, rendered: null });

    const service = new ArtifactService(new MemoryArtifactRepository());
    expect(await service.getArtifacts()).toEqual(second);
  });

  it("increments revisions and retains the other artifact on each update", async () => {
    const repository = new MemoryArtifactRepository();
    const service = new ArtifactService(repository);

    const prompted = await service.buildPrompt(promptInput);
    expect(prompted.revision).toBe(1);
    expect(prompted.prompt?.prompt).toContain(promptInput.content);
    expect(prompted.prompt?.schema.title).toBe("ScrubSummary");
    expect(prompted.rendered).toBeNull();

    const rendered = await service.renderSummary(renderInput());
    expect(rendered.revision).toBe(2);
    expect(rendered.prompt).toEqual(prompted.prompt);
    expect(rendered.rendered?.markdown).toContain("# Document notes");

    const rebuilt = await service.buildPrompt({
      ...promptInput,
      content: "Revised notes.",
    });
    expect(rebuilt.revision).toBe(3);
    expect(rebuilt.prompt?.prompt).toContain("Revised notes.");
    expect(rebuilt.rendered).toEqual(rendered.rendered);
    expect(await service.getArtifacts()).toEqual(rebuilt);
    expect(repository.writes).toBe(3);
  });

  it("never writes invalid prompt or summary input", async () => {
    const repository = new MemoryArtifactRepository();
    const service = new ArtifactService(repository);
    const before = await service.buildPrompt(promptInput);

    await expect(
      service.buildPrompt({ ...promptInput, content: " " })
    ).rejects.toThrow();
    await expect(
      service.renderSummary({
        ...renderInput(),
        summary: {
          ...renderInput().summary,
          sections: [
            { title: "Invalid", startTime: 5, endTime: 1, content: "" },
          ],
        },
      })
    ).rejects.toThrow("endTime must");

    expect(repository.writes).toBe(1);
    expect(await service.getArtifacts()).toEqual(before);
  });

  it("keeps document repositories isolated", async () => {
    const first = new ArtifactService(new MemoryArtifactRepository());
    const second = new ArtifactService(new MemoryArtifactRepository());
    await first.buildPrompt(promptInput);

    expect((await first.getArtifacts()).revision).toBe(1);
    expect(await second.getArtifacts()).toEqual(createArtifactState());
    await second.renderSummary(renderInput());
    expect((await first.getArtifacts()).rendered).toBeNull();
    expect((await second.getArtifacts()).prompt).toBeNull();
  });

  it("propagates write and read failures without claiming a successful update", async () => {
    const repository = new MemoryArtifactRepository();
    const service = new ArtifactService(repository);
    const before = await service.buildPrompt(promptInput);
    const failure = new Error("Storage unavailable");
    repository.failure = failure;

    await expect(service.renderSummary(renderInput())).rejects.toBe(failure);
    await expect(service.getArtifacts()).rejects.toBe(failure);
    expect(repository.writes).toBe(1);

    repository.failure = null;
    expect(await service.getArtifacts()).toEqual(before);
    expect((await service.renderSummary(renderInput())).revision).toBe(2);
  });

  it("preserves every revision and both artifacts during concurrent calls", async () => {
    const repository = new MemoryArtifactRepository();
    const service = new ArtifactService(repository);
    const updates = await Promise.all([
      service.buildPrompt(promptInput),
      service.renderSummary(renderInput()),
      ...Array.from({ length: 8 }, (_, index) =>
        service.buildPrompt({
          ...promptInput,
          content: `Revision ${index}`,
        })
      ),
    ]);

    expect(updates.map((state) => state.revision)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const latest = await service.getArtifacts();
    expect(latest.revision).toBe(10);
    expect(latest.prompt?.prompt).toContain("Revision 7");
    expect(latest.rendered?.markdown).toContain("# Document notes");
    expect(repository.writes).toBe(10);
  });
});
