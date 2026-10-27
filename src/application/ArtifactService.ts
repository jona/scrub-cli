import {
  createPromptArtifact,
  createRenderedArtifact,
} from "../core/artifacts.js";
import type {
  ArtifactState,
  BuildPromptInput,
  RenderSummaryInput,
} from "../core/artifacts.js";
import type { ArtifactRepository } from "./ports/ArtifactRepository.js";
import type { RenderSummaryOptions } from "../core/summary-template.js";

export function createArtifactState(): ArtifactState {
  return { revision: 0, prompt: null, rendered: null };
}

/** Document artifact use cases, independent of the storage provider or transport. */
export class ArtifactService {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly rendering?: RenderSummaryOptions
  ) {}

  async buildPrompt(input: BuildPromptInput): Promise<ArtifactState> {
    const prompt = createPromptArtifact(input);
    return this.repository.update((current) => ({
      ...current,
      revision: current.revision + 1,
      prompt,
    }));
  }

  async renderSummary(input: RenderSummaryInput): Promise<ArtifactState> {
    const rendered = createRenderedArtifact(input, this.rendering);
    return this.repository.update((current) => ({
      ...current,
      revision: current.revision + 1,
      rendered,
    }));
  }

  async getArtifacts(): Promise<ArtifactState> {
    return this.repository.get();
  }
}
