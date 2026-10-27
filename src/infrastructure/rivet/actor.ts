import { actor, UserError } from "rivetkit";
import { z } from "zod";
import { ArtifactInputError } from "../../core/artifacts.js";
import type {
  ArtifactState,
  BuildPromptInput,
  RenderSummaryInput,
} from "../../core/artifacts.js";
import {
  ArtifactService,
  createArtifactState,
} from "../../application/ArtifactService.js";
import {
  RivetArtifactRepository,
  type RivetArtifactContext,
} from "./ArtifactRepository.js";

async function withRivetErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new UserError("Invalid artifact input", {
        code: "invalid_input",
        metadata: {
          issueCount: error.issues.length,
          issues: error.issues
            .slice(0, 20)
            .map(({ path, message }) => ({ path, message })),
        },
      });
    }
    if (error instanceof ArtifactInputError) {
      throw new UserError(error.message, { code: error.code });
    }
    throw error;
  }
}

function service(context: RivetArtifactContext): ArtifactService {
  return new ArtifactService(new RivetArtifactRepository(context), {
    generatedAt: new Date().toISOString(),
  });
}

export const scrub = actor({
  db: undefined,
  createState: createArtifactState,
  actions: {
    buildPrompt: (
      context: RivetArtifactContext,
      input: BuildPromptInput
    ): Promise<ArtifactState> =>
      withRivetErrors(() => service(context).buildPrompt(input)),
    renderSummary: (
      context: RivetArtifactContext,
      input: RenderSummaryInput
    ): Promise<ArtifactState> =>
      withRivetErrors(() => service(context).renderSummary(input)),
    getArtifacts: (context: RivetArtifactContext): Promise<ArtifactState> =>
      service(context).getArtifacts(),
  },
});
