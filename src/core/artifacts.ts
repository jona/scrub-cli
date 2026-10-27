import { z } from "zod";
import {
  buildSummaryPrompt,
  renderSummaryMarkdown,
  SUMMARY_SCHEMA,
} from "./summary-template.js";
import type { MediaMetadata } from "./models.js";
import type { RenderSummaryOptions } from "./summary-template.js";

// Bound standalone in-memory prompt/render inputs and outputs.
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_ARTIFACT_BYTES = 384 * 1024;

const text = z.string().max(16_000);
const title = z.string().trim().min(1).max(1_000);
const timestamp = z.number().finite().nonnegative();
const strings = z.array(text).max(200);

export const metadataSchema = z
  .object({
    contentId: z.string().max(1_000).default("unknown"),
    title,
    description: text.default(""),
    duration: timestamp.default(0),
    thumbnailUrl: z.string().max(4_096).default(""),
    source: z.string().max(1_000).default("Text"),
    uploadDate: z.string().max(64).default(""),
    url: z.string().max(4_096).default(""),
  })
  .strict();

export const VISUAL_TYPES = [
  "slide",
  "code",
  "diagram",
  "terminal",
  "talking-head",
  "other",
] as const;

export const visualAnalysisSchema = z
  .object({
    timestamp,
    description: text,
    extractedText: text.default(""),
    visualType: z.enum(VISUAL_TYPES),
  })
  .strict();

export const buildPromptInputSchema = z
  .object({
    metadata: metadataSchema,
    content: z
      .string()
      .min(1)
      .max(200_000)
      .refine((value) => value.trim().length > 0, "Content must not be blank"),
    visuals: z.array(visualAnalysisSchema).max(100).default([]),
  })
  .strict();

const codeSchema = z
  .object({
    language: z.string().max(100).optional(),
    code: text,
    // The emitted model schema permits code snippets without timestamps.
    timestamp: timestamp.default(0),
    context: text.optional(),
  })
  .strict();

const sectionSchema = z
  .object({
    title,
    startTime: timestamp,
    endTime: timestamp,
    content: text,
    visualContent: text.optional(),
    codeSnippets: z.array(codeSchema).max(200).optional(),
  })
  .strict()
  .refine((section) => section.endTime >= section.startTime, {
    message: "endTime must be greater than or equal to startTime",
    path: ["endTime"],
  });

// This validates the full model response before the renderer can access it.
export const summaryInputSchema = z
  .object({
    title: title.optional(),
    tldr: text,
    overview: text,
    thesisAndClaims: z
      .object({
        thesis: text,
        keyClaims: z
          .array(z.object({ claim: text, evidence: text.optional() }).strict())
          .max(200),
        persuasionGoal: text.optional(),
      })
      .strict(),
    actionableInsights: z
      .array(
        z
          .object({
            action: text,
            context: text.optional(),
            rationale: text.optional(),
          })
          .strict()
      )
      .max(200),
    concepts: z
      .array(
        z
          .object({ concept: text, definition: text, example: text.optional() })
          .strict()
      )
      .max(200),
    mentalModels: z
      .array(
        z
          .object({
            name: text,
            description: text,
            whenToUse: text.optional(),
            whyItWorks: text.optional(),
          })
          .strict()
      )
      .max(200),
    structureMap: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            type: text,
            description: text,
            timeRange: text.optional(),
          })
          .strict()
      )
      .max(200),
    openQuestions: z
      .array(
        z
          .object({
            question: text,
            type: z.enum([
              "assumption",
              "contradiction",
              "missing_data",
              "debate",
            ]),
            context: text.optional(),
          })
          .strict()
      )
      .max(200),
    notableQuotes: z
      .array(
        z
          .object({
            quote: text,
            significance: text,
            timestamp: timestamp.optional(),
          })
          .strict()
      )
      .max(200),
    biasAnalysis: z
      .object({
        perspective: text,
        possibleBiases: strings,
        blindSpots: strings,
      })
      .strict(),
    knowledgeGraph: z
      .object({
        topics: strings,
        people: strings,
        tools: strings,
        technologies: strings,
        relationships: strings,
      })
      .strict(),
    difficulty: z
      .object({
        level: z.enum(["beginner", "intermediate", "advanced"]),
        prerequisites: strings,
        targetAudience: text,
      })
      .strict(),
    reusabilityPrompts: z
      .object({
        explainToBeginnerPrompt: text.optional(),
        checklistPrompt: text.optional(),
        studyGuidePrompt: text.optional(),
        flashcardsPrompt: text.optional(),
      })
      .strict(),
    confidence: z
      .object({
        level: z.enum(["high", "medium", "low"]),
        reasoning: text,
      })
      .strict(),
    sections: z.array(sectionSchema).max(200),
    keyTakeaways: strings,
    codeSnippets: z.array(codeSchema).max(200),
    references: strings,
  })
  .strict();

export const renderSummaryInputSchema = z
  .object({ metadata: metadataSchema, summary: summaryInputSchema })
  .strict();

export type BuildPromptInput = z.input<typeof buildPromptInputSchema>;
export type RenderSummaryInput = z.input<typeof renderSummaryInputSchema>;

export interface PromptArtifact {
  metadata: MediaMetadata;
  prompt: string;
  schema: typeof SUMMARY_SCHEMA;
}

export interface RenderedArtifact {
  metadata: MediaMetadata;
  markdown: string;
}

export class ArtifactInputError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "input_too_large" = "input_too_large"
  ) {
    super(message);
    this.name = "ArtifactInputError";
  }
}

function assertSize(
  value: unknown,
  maximum: number,
  description: string
): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ArtifactInputError("Input must be valid JSON", "invalid_input");
  }
  if (encoded === undefined) {
    throw new ArtifactInputError("Input must be valid JSON", "invalid_input");
  }
  if (new TextEncoder().encode(encoded).byteLength > maximum) {
    throw new ArtifactInputError(`${description} exceeds ${maximum} bytes`);
  }
}

export function createPromptArtifact(input: unknown): PromptArtifact {
  assertInputObject(input);
  assertSize(input, MAX_INPUT_BYTES, "Input");
  const parsed = buildPromptInputSchema.parse(input);
  const artifact = {
    metadata: parsed.metadata,
    prompt: buildSummaryPrompt(parsed.metadata, parsed.content, parsed.visuals),
    schema: SUMMARY_SCHEMA,
  };
  assertSize(artifact, MAX_ARTIFACT_BYTES, "Generated prompt artifact");
  return artifact;
}

export function createRenderedArtifact(
  input: unknown,
  options?: RenderSummaryOptions
): RenderedArtifact {
  assertInputObject(input);
  assertSize(input, MAX_INPUT_BYTES, "Input");
  const parsed = renderSummaryInputSchema.parse(input);
  const artifact = {
    metadata: parsed.metadata,
    markdown: renderSummaryMarkdown(
      parsed.metadata,
      {
        ...parsed.summary,
        title: parsed.metadata.title,
      },
      undefined,
      options
    ),
  };
  assertSize(artifact, MAX_ARTIFACT_BYTES, "Generated markdown artifact");
  return artifact;
}

function assertInputObject(input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArtifactInputError("Input must be an object", "invalid_input");
  }
}
