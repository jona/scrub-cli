/**
 * summarize — Primitive for summarizing content using Claude API
 *
 * Accepts any file type (.json transcript, .txt, .md, etc.).
 * Detects format and builds appropriate prompt.
 * Consolidates: Summarizer + MarkdownGenerator + SkillGenerator
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import { formatTimestamp } from "../utils/helpers.js";
import type {
  MediaMetadata,
  VisualAnalysis,
  SummaryResult,
  SummarySection,
  CodeBlock,
  OpenQuestion,
  DifficultyAssessment,
  ConfidenceScore,
  SkillChecklist,
  SkillChecklistItem,
  SkillGenerationResult,
} from "../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SummarizeOptions {
  /** Path to metadata.json to enrich summary */
  metadataPath?: string;
  /** Path to visual_analysis.json to enrich summary */
  visualsPath?: string;
  /** Path to transcript for skill generation */
  transcriptPath?: string;
  /** Also output summary.md */
  outputMarkdown?: boolean;
  /** Also output SKILL.md */
  outputSkill?: boolean;
  /** Custom skill name (implies outputSkill) */
  skillName?: string;
  onProgress?: (message: string) => void;
}

export interface SummarizeResult {
  summary: SummaryResult;
  markdown?: string;
  skill?: SkillGenerationResult;
}

/**
 * Summarize content from any file type
 */
export async function summarize(
  filePath: string,
  options?: SummarizeOptions
): Promise<SummarizeResult> {
  if (!config.hasAnthropicKey()) {
    throw new Error(
      "Anthropic API key not configured. Add apis.anthropic to ~/.scrub/config.json."
    );
  }

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Load the input content
  const rawContent = readFileSync(filePath, "utf-8");

  // Detect content type and build appropriate inputs
  const { content, transcript } = detectAndParseContent(rawContent, filePath);

  // Load optional enrichments
  const metadata = options?.metadataPath
    ? (JSON.parse(readFileSync(options.metadataPath, "utf-8")) as MediaMetadata)
    : buildDefaultMetadata(filePath);

  const visuals: VisualAnalysis[] = options?.visualsPath
    ? JSON.parse(readFileSync(options.visualsPath, "utf-8"))
    : [];

  // Generate summary
  options?.onProgress?.("Generating summary...");
  const summary = await callSummarize(metadata, content, transcript, visuals);

  const result: SummarizeResult = { summary };

  // Generate markdown if requested
  if (options?.outputMarkdown) {
    const transcriptForMd = options?.transcriptPath
      ? (JSON.parse(
          readFileSync(options.transcriptPath, "utf-8")
        ) as TranscriptionResult)
      : transcript;
    result.markdown = generateMarkdown(metadata, summary, transcriptForMd);
  }

  // Generate skill if requested
  if (options?.outputSkill || options?.skillName) {
    options?.onProgress?.("Generating SKILL.md...");
    const transcriptForSkill = options?.transcriptPath
      ? (JSON.parse(
          readFileSync(options.transcriptPath, "utf-8")
        ) as TranscriptionResult)
      : transcript;
    result.skill = await generateSkill(metadata, summary, {
      skillName: options?.skillName,
      transcript: transcriptForSkill,
      onProgress: options?.onProgress,
    });
  }

  return result;
}

// ── Content Detection ──────────────────────────────────────────────

function detectAndParseContent(
  rawContent: string,
  filePath: string
): { content: string; transcript?: TranscriptionResult } {
  const ext = extname(filePath).toLowerCase();

  // Try JSON with segments (transcript format)
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed.segments && Array.isArray(parsed.segments)) {
        return {
          content: formatTranscriptAsContent(parsed as TranscriptionResult),
          transcript: parsed as TranscriptionResult,
        };
      }
      // Generic JSON — serialize nicely
      return { content: JSON.stringify(parsed, null, 2) };
    } catch {
      return { content: rawContent };
    }
  }

  // Plain text or markdown — use as-is
  return { content: rawContent };
}

function formatTranscriptAsContent(transcript: TranscriptionResult): string {
  return transcript.segments
    .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
    .join("\n");
}

function buildDefaultMetadata(filePath: string): MediaMetadata {
  const name = basename(filePath, extname(filePath));
  return {
    contentId: "unknown",
    title: name,
    description: "",
    duration: 0,
    thumbnailUrl: "",
    source: "File",
    uploadDate: new Date().toISOString().split("T")[0],
    url: filePath,
  };
}

// ── Claude Summarization ───────────────────────────────────────────

async function callSummarize(
  metadata: MediaMetadata,
  content: string,
  _transcript: TranscriptionResult | undefined,
  visuals: VisualAnalysis[]
): Promise<SummaryResult> {
  const apiKey = config.getApiKey("anthropic")!;
  const client = new Anthropic({ apiKey });
  const summarizerConfig = config.getSummarizer();

  const formattedVisuals = visuals
    .map(
      (v) =>
        `[${formatTimestamp(v.timestamp)}] (${v.visualType})\n` +
        `  Description: ${v.description}\n` +
        (v.extractedText ? `  Text/Code: ${v.extractedText}` : "")
    )
    .join("\n\n");

  const prompt = `You are creating a comprehensive knowledge artifact from content. Think: "What would future-me or AI agents wish they had extracted without re-reading this content?"

## METADATA
- Title: ${metadata.title}
- Source: ${metadata.source}
${metadata.duration ? `- Duration: ${formatTimestamp(metadata.duration)}` : ""}
- URL: ${metadata.url}
${metadata.description ? `- Description: ${metadata.description.substring(0, 500)}${metadata.description.length > 500 ? "..." : ""}` : ""}

## CONTENT
${content}

## VISUAL CONTENT ANALYSIS
${formattedVisuals || "No visual analysis available."}

---

Create a comprehensive JSON knowledge artifact with ALL of the following layers:

{
  "tldr": "1-2 sentence TLDR that captures the essence",
  "overview": "2-3 sentence overview of what this content covers and its main purpose",

  "thesisAndClaims": {
    "thesis": "The main thesis/argument",
    "keyClaims": [
      { "claim": "Core claim 1", "evidence": "Supporting evidence" },
      { "claim": "Core claim 2", "evidence": "Supporting evidence" }
    ],
    "persuasionGoal": "What the creator is trying to convince you of"
  },

  "actionableInsights": [
    { "action": "Do X when Y happens", "context": "When/where applicable", "rationale": "Why this matters" }
  ],

  "concepts": [
    { "concept": "Term/Concept", "definition": "Clear definition", "example": "Concrete example" }
  ],

  "mentalModels": [
    { "name": "Model/Framework name", "description": "What it is", "whenToUse": "When to apply it", "whyItWorks": "Why it's effective" }
  ],

  "structureMap": [
    { "number": 1, "type": "introduction", "description": "Brief description", "timeRange": "0:00-1:30" }
  ],

  "openQuestions": [
    { "question": "What is uncertain or debated?", "type": "assumption|contradiction|missing_data|debate", "context": "Additional context" }
  ],

  "notableQuotes": [
    { "quote": "Exact quote worth preserving", "significance": "Why it matters", "timestamp": 120 }
  ],

  "biasAnalysis": {
    "perspective": "The viewpoint/lens being used",
    "possibleBiases": ["Bias 1", "Bias 2"],
    "blindSpots": ["What's not being considered"]
  },

  "knowledgeGraph": {
    "topics": ["Topic 1", "Topic 2"],
    "people": ["Person mentioned"],
    "tools": ["Tool/Software"],
    "technologies": ["Tech/Framework"],
    "relationships": ["Topic A relates to Topic B because..."]
  },

  "difficulty": {
    "level": "beginner|intermediate|advanced",
    "prerequisites": ["What you need to know first"],
    "targetAudience": "Who this is for"
  },

  "reusabilityPrompts": {
    "explainToBeginnerPrompt": "Using the concepts from this content, explain...",
    "checklistPrompt": "Create a checklist for...",
    "studyGuidePrompt": "Create a study guide covering...",
    "flashcardsPrompt": "Generate flashcards for..."
  },

  "confidence": {
    "level": "high|medium|low",
    "reasoning": "Why this confidence level"
  },

  "sections": [
    {
      "title": "Section title",
      "startTime": 0,
      "endTime": 120,
      "content": "Detailed summary of this section",
      "visualContent": "Description of visuals (optional)",
      "codeSnippets": [
        { "language": "python", "code": "code here", "context": "what it demonstrates" }
      ]
    }
  ],

  "keyTakeaways": ["Specific actionable takeaway 1", "Specific actionable takeaway 2"],

  "codeSnippets": [
    { "language": "javascript", "code": "code", "timestamp": 180, "context": "what this does" }
  ],

  "references": ["Tools, libraries, URLs, resources mentioned"]
}

Guidelines:
1. Extract 3-7 key claims - what is the creator trying to convince you of?
2. Actionable insights should be specific enough to implement
3. Turn concepts into a searchable glossary with clear definitions
4. Identify mental models, frameworks, decision trees, heuristics, rules of thumb
5. Map the content structure so agents can remix/rewrite content
6. Note contradictions, assumptions, and open questions for deeper research
7. Only preserve "anchor line" quotes that are genuinely significant
8. Detect bias and perspective - don't treat content as ground truth
9. Build knowledge graph nodes for multi-agent systems and retrieval
10. Assess difficulty and prerequisites for learning path organization
11. Generate reusability prompts tailored to this specific content
12. Rate confidence based on source quality, evidence provided, and expertise
13. Timestamps should be in seconds (use 0 if no timestamps available)
14. Include ALL code snippets shown or discussed

Respond with ONLY the JSON object, no additional text:`;

  const response = await client.messages
    .stream({
      model: summarizerConfig.model,
      max_tokens: 16384,
      messages: [{ role: "user", content: prompt }],
    })
    .finalMessage();

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return parseResponse(responseText, metadata);
}

// ── Response Parsing ───────────────────────────────────────────────

interface ParsedSummary {
  tldr?: string;
  overview?: string;
  thesisAndClaims?: {
    thesis?: string;
    keyClaims?: Array<{ claim?: string; evidence?: string }>;
    persuasionGoal?: string;
  };
  actionableInsights?: Array<{
    action?: string;
    context?: string;
    rationale?: string;
  }>;
  concepts?: Array<{ concept?: string; definition?: string; example?: string }>;
  mentalModels?: Array<{
    name?: string;
    description?: string;
    whenToUse?: string;
    whyItWorks?: string;
  }>;
  structureMap?: Array<{
    number?: number;
    type?: string;
    description?: string;
    timeRange?: string;
  }>;
  openQuestions?: Array<{ question?: string; type?: string; context?: string }>;
  notableQuotes?: Array<{
    quote?: string;
    significance?: string;
    timestamp?: number;
  }>;
  biasAnalysis?: {
    perspective?: string;
    possibleBiases?: string[];
    blindSpots?: string[];
  };
  knowledgeGraph?: {
    topics?: string[];
    people?: string[];
    tools?: string[];
    technologies?: string[];
    relationships?: string[];
  };
  difficulty?: {
    level?: string;
    prerequisites?: string[];
    targetAudience?: string;
  };
  reusabilityPrompts?: {
    explainToBeginnerPrompt?: string;
    checklistPrompt?: string;
    studyGuidePrompt?: string;
    flashcardsPrompt?: string;
  };
  confidence?: { level?: string; reasoning?: string };
  sections?: Array<{
    title?: string;
    startTime?: number;
    endTime?: number;
    content?: string;
    visualContent?: string;
    codeSnippets?: Array<{ language?: string; code: string; context?: string }>;
  }>;
  keyTakeaways?: string[];
  codeSnippets?: Array<{
    language?: string;
    code: string;
    timestamp?: number;
    context?: string;
  }>;
  references?: string[];
}

function parseResponse(
  responseText: string,
  metadata: MediaMetadata
): SummaryResult {
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("Could not find JSON in summary response");
      return createFallbackSummary(metadata, responseText);
    }

    const parsed = JSON.parse(jsonMatch[0]) as ParsedSummary;

    const sections: SummarySection[] = (parsed.sections || []).map((s) => ({
      title: s.title || "Untitled Section",
      startTime: s.startTime || 0,
      endTime: s.endTime || 0,
      content: s.content || "",
      visualContent: s.visualContent,
      codeSnippets: s.codeSnippets?.map((c) => ({
        language: c.language,
        code: c.code,
        timestamp: s.startTime || 0,
        context: c.context,
      })),
    }));

    const codeSnippets: CodeBlock[] = (parsed.codeSnippets || []).map((c) => ({
      language: c.language,
      code: c.code,
      timestamp: c.timestamp || 0,
      context: c.context,
    }));

    return {
      title: metadata.title,
      tldr:
        parsed.tldr || parsed.overview?.split(".")[0] || "No TLDR available.",
      overview: parsed.overview || "No overview available.",
      thesisAndClaims: {
        thesis: parsed.thesisAndClaims?.thesis || "No thesis identified.",
        keyClaims: (parsed.thesisAndClaims?.keyClaims || []).map((c) => ({
          claim: c.claim || "",
          evidence: c.evidence,
        })),
        persuasionGoal: parsed.thesisAndClaims?.persuasionGoal,
      },
      actionableInsights: (parsed.actionableInsights || []).map((a) => ({
        action: a.action || "",
        context: a.context,
        rationale: a.rationale,
      })),
      concepts: (parsed.concepts || []).map((c) => ({
        concept: c.concept || "",
        definition: c.definition || "",
        example: c.example,
      })),
      mentalModels: (parsed.mentalModels || []).map((m) => ({
        name: m.name || "",
        description: m.description || "",
        whenToUse: m.whenToUse,
        whyItWorks: m.whyItWorks,
      })),
      structureMap: (parsed.structureMap || []).map((s) => ({
        number: s.number || 0,
        type: s.type || "section",
        description: s.description || "",
        timeRange: s.timeRange,
      })),
      openQuestions: (parsed.openQuestions || []).map((q) => ({
        question: q.question || "",
        type: (q.type as OpenQuestion["type"]) || "missing_data",
        context: q.context,
      })),
      notableQuotes: (parsed.notableQuotes || []).map((q) => ({
        quote: q.quote || "",
        significance: q.significance || "",
        timestamp: q.timestamp,
      })),
      biasAnalysis: {
        perspective: parsed.biasAnalysis?.perspective || "Not analyzed.",
        possibleBiases: parsed.biasAnalysis?.possibleBiases || [],
        blindSpots: parsed.biasAnalysis?.blindSpots || [],
      },
      knowledgeGraph: {
        topics: parsed.knowledgeGraph?.topics || [],
        people: parsed.knowledgeGraph?.people || [],
        tools: parsed.knowledgeGraph?.tools || [],
        technologies: parsed.knowledgeGraph?.technologies || [],
        relationships: parsed.knowledgeGraph?.relationships || [],
      },
      difficulty: {
        level:
          (parsed.difficulty?.level as DifficultyAssessment["level"]) ||
          "intermediate",
        prerequisites: parsed.difficulty?.prerequisites || [],
        targetAudience: parsed.difficulty?.targetAudience || "General audience",
      },
      reusabilityPrompts: {
        explainToBeginnerPrompt:
          parsed.reusabilityPrompts?.explainToBeginnerPrompt,
        checklistPrompt: parsed.reusabilityPrompts?.checklistPrompt,
        studyGuidePrompt: parsed.reusabilityPrompts?.studyGuidePrompt,
        flashcardsPrompt: parsed.reusabilityPrompts?.flashcardsPrompt,
      },
      confidence: {
        level:
          (parsed.confidence?.level as ConfidenceScore["level"]) || "medium",
        reasoning:
          parsed.confidence?.reasoning || "No confidence assessment available.",
      },
      sections,
      keyTakeaways: parsed.keyTakeaways || [],
      codeSnippets,
      references: parsed.references || [],
    };
  } catch (error) {
    logger.warn(
      `Failed to parse summary response: ${(error as Error).message}`
    );
    return createFallbackSummary(metadata, responseText);
  }
}

function createFallbackSummary(
  metadata: MediaMetadata,
  rawText: string
): SummaryResult {
  return {
    title: metadata.title,
    tldr: rawText.substring(0, 150) || "Summary generation failed.",
    overview: rawText.substring(0, 500) || "Summary generation failed.",
    thesisAndClaims: {
      thesis: "Unable to extract thesis.",
      keyClaims: [],
      persuasionGoal: undefined,
    },
    actionableInsights: [],
    concepts: [],
    mentalModels: [],
    structureMap: [],
    openQuestions: [],
    notableQuotes: [],
    biasAnalysis: {
      perspective: "Not analyzed.",
      possibleBiases: [],
      blindSpots: [],
    },
    knowledgeGraph: {
      topics: [],
      people: [],
      tools: [],
      technologies: [],
      relationships: [],
    },
    difficulty: {
      level: "intermediate",
      prerequisites: [],
      targetAudience: "General audience",
    },
    reusabilityPrompts: {},
    confidence: {
      level: "low",
      reasoning: "Parsing failed, limited extraction possible.",
    },
    sections: [
      {
        title: "Full Content",
        startTime: 0,
        endTime: metadata.duration,
        content: rawText || "Content unavailable.",
      },
    ],
    keyTakeaways: [],
    codeSnippets: [],
    references: [],
  };
}

// ── Markdown Generation ────────────────────────────────────────────

export function generateMarkdown(
  metadata: MediaMetadata,
  summary: SummaryResult,
  transcript?: TranscriptionResult
): string {
  const outputConfig = config.getOutput();
  const parts: string[] = [];

  function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim();
  }

  function formatCodeBlock(code: CodeBlock): string {
    return `\`\`\`${code.language || ""}\n${code.code}\n\`\`\``;
  }

  // Header
  const difficultyBadge = summary.difficulty?.level
    ? `**Difficulty:** ${capitalize(summary.difficulty.level)}`
    : "";
  const confidenceBadge = summary.confidence?.level
    ? `**Confidence:** ${capitalize(summary.confidence.level)}`
    : "";
  parts.push(
    `# ${metadata.title}\n\n> **Source:** [${metadata.url}](${metadata.url})  \n> **Source:** ${metadata.source}  \n${metadata.duration ? `> **Duration:** ${formatTimestamp(metadata.duration)}  \n` : ""}> **Processed:** ${new Date().toISOString().split("T")[0]}  \n> ${difficultyBadge} | ${confidenceBadge}`
  );

  // TLDR
  parts.push(`## TL;DR\n\n> ${summary.tldr}`);

  // Overview
  parts.push(`## Overview\n\n${summary.overview}`);

  // Thesis and Key Claims
  const claimsList = summary.thesisAndClaims.keyClaims
    .map((c) => {
      const evidence = c.evidence ? ` *(${c.evidence})*` : "";
      return `- ${c.claim}${evidence}`;
    })
    .join("\n");
  let thesisContent = `## Thesis & Key Claims\n\n**Thesis:** ${summary.thesisAndClaims.thesis}`;
  if (summary.thesisAndClaims.persuasionGoal)
    thesisContent += `\n\n**Persuasion Goal:** ${summary.thesisAndClaims.persuasionGoal}`;
  if (claimsList) thesisContent += `\n\n**Key Claims:**\n${claimsList}`;
  parts.push(thesisContent);

  // Actionable Insights
  if (summary.actionableInsights.length > 0) {
    const items = summary.actionableInsights
      .map((i) => {
        let item = `- **${i.action}**`;
        if (i.context) item += `\n  - *When:* ${i.context}`;
        if (i.rationale) item += `\n  - *Why:* ${i.rationale}`;
        return item;
      })
      .join("\n");
    parts.push(`## Actionable Insights\n\n${items}`);
  }

  // Concepts
  if (summary.concepts.length > 0) {
    const items = summary.concepts
      .map((c) => {
        let item = `### ${c.concept}\n\n${c.definition}`;
        if (c.example) item += `\n\n*Example:* ${c.example}`;
        return item;
      })
      .join("\n\n");
    parts.push(`## Concepts & Definitions\n\n${items}`);
  }

  // Mental Models
  if (summary.mentalModels.length > 0) {
    const items = summary.mentalModels
      .map((m) => {
        let item = `### ${m.name}\n\n${m.description}`;
        if (m.whenToUse) item += `\n\n**When to use:** ${m.whenToUse}`;
        if (m.whyItWorks) item += `\n\n**Why it works:** ${m.whyItWorks}`;
        return item;
      })
      .join("\n\n");
    parts.push(`## Mental Models & Frameworks\n\n${items}`);
  }

  // Structure Map
  if (summary.structureMap.length > 0) {
    const items = summary.structureMap
      .map((s) => {
        const timeInfo = s.timeRange ? ` (${s.timeRange})` : "";
        return `${s.number}. **${capitalize(s.type)}**${timeInfo}: ${s.description}`;
      })
      .join("\n");
    parts.push(`## Content Structure\n\n${items}`);
  }

  // Table of Contents
  if (summary.sections.length > 1) {
    const links = summary.sections.map((section, index) => {
      const anchor = slugify(section.title);
      const timestamp = formatTimestamp(section.startTime);
      return `${index + 1}. [${section.title}](#${anchor}) (${timestamp})`;
    });
    parts.push(`## Table of Contents\n\n${links.join("\n")}`);
  }

  // Sections
  if (summary.sections.length > 0) {
    const sectionParts = summary.sections.map((section) => {
      const timeRange = `${formatTimestamp(section.startTime)} - ${formatTimestamp(section.endTime)}`;
      let content = `### ${section.title} (${timeRange})\n\n${section.content}`;
      if (section.visualContent)
        content += `\n\n**Visual Content:** ${section.visualContent}`;
      if (section.codeSnippets && section.codeSnippets.length > 0) {
        const codeBlocks = section.codeSnippets
          .map((code) => formatCodeBlock(code))
          .join("\n\n");
        content += `\n\n${codeBlocks}`;
      }
      return content;
    });
    parts.push(`## Content\n\n${sectionParts.join("\n\n---\n\n")}`);
  }

  // Open Questions
  if (summary.openQuestions.length > 0) {
    const typeLabels: Record<string, string> = {
      assumption: "Assumptions",
      contradiction: "Contradictions",
      missing_data: "Missing Data",
      debate: "Open Debates",
    };
    const grouped: Record<string, OpenQuestion[]> = {};
    for (const q of summary.openQuestions) {
      const type = q.type || "other";
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(q);
    }
    const sections = Object.entries(grouped)
      .map(([type, qs]) => {
        const label = typeLabels[type] || "Other";
        const items = qs
          .map((q) => {
            let item = `- ${q.question}`;
            if (q.context) item += ` *(${q.context})*`;
            return item;
          })
          .join("\n");
        return `**${label}:**\n${items}`;
      })
      .join("\n\n");
    parts.push(`## Open Questions & Contradictions\n\n${sections}`);
  }

  // Notable Quotes
  if (summary.notableQuotes.length > 0) {
    const items = summary.notableQuotes
      .map((q) => {
        const timestamp = q.timestamp
          ? ` *(${formatTimestamp(q.timestamp)})*`
          : "";
        return `> "${q.quote}"${timestamp}\n>\n> **Why it matters:** ${q.significance}`;
      })
      .join("\n\n");
    parts.push(`## Notable Quotes\n\n${items}`);
  }

  // Bias Analysis
  let biasContent = `## Bias & Perspective Analysis\n\n**Perspective:** ${summary.biasAnalysis.perspective}`;
  if (summary.biasAnalysis.possibleBiases.length > 0)
    biasContent += `\n\n**Possible Biases:**\n${summary.biasAnalysis.possibleBiases.map((b) => `- ${b}`).join("\n")}`;
  if (summary.biasAnalysis.blindSpots.length > 0)
    biasContent += `\n\n**Blind Spots:**\n${summary.biasAnalysis.blindSpots.map((b) => `- ${b}`).join("\n")}`;
  parts.push(biasContent);

  // Knowledge Graph
  const kgSections: string[] = [];
  if (summary.knowledgeGraph.topics.length > 0)
    kgSections.push(`**Topics:** ${summary.knowledgeGraph.topics.join(", ")}`);
  if (summary.knowledgeGraph.people.length > 0)
    kgSections.push(`**People:** ${summary.knowledgeGraph.people.join(", ")}`);
  if (summary.knowledgeGraph.tools.length > 0)
    kgSections.push(`**Tools:** ${summary.knowledgeGraph.tools.join(", ")}`);
  if (summary.knowledgeGraph.technologies.length > 0)
    kgSections.push(
      `**Technologies:** ${summary.knowledgeGraph.technologies.join(", ")}`
    );
  if (summary.knowledgeGraph.relationships.length > 0)
    kgSections.push(
      `**Relationships:**\n${summary.knowledgeGraph.relationships.map((r) => `- ${r}`).join("\n")}`
    );
  parts.push(`## Knowledge Graph\n\n${kgSections.join("\n\n")}`);

  // Key Takeaways
  if (summary.keyTakeaways.length > 0) {
    parts.push(
      `## Key Takeaways\n\n${summary.keyTakeaways.map((t) => `- ${t}`).join("\n")}`
    );
  }

  // Code Snippets
  if (summary.codeSnippets.length > 0) {
    const codeBlocks = summary.codeSnippets
      .map((snippet) => {
        const header = snippet.context
          ? `**${snippet.context}** (${formatTimestamp(snippet.timestamp)})`
          : `Code at ${formatTimestamp(snippet.timestamp)}`;
        return `${header}\n\n${formatCodeBlock(snippet)}`;
      })
      .join("\n\n---\n\n");
    parts.push(`## Code Snippets\n\n${codeBlocks}`);
  }

  // References
  if (summary.references.length > 0) {
    const items = summary.references
      .map((r) => (r.match(/^https?:\/\//) ? `- [${r}](${r})` : `- ${r}`))
      .join("\n");
    parts.push(`## References & Resources\n\n${items}`);
  }

  // Difficulty
  let diffContent = `## Difficulty & Prerequisites\n\n**Level:** ${capitalize(summary.difficulty.level)}\n\n**Target Audience:** ${summary.difficulty.targetAudience}`;
  if (summary.difficulty.prerequisites.length > 0)
    diffContent += `\n\n**Prerequisites:**\n${summary.difficulty.prerequisites.map((p) => `- ${p}`).join("\n")}`;
  parts.push(diffContent);

  // Reusability Prompts
  const promptList: string[] = [];
  if (summary.reusabilityPrompts.explainToBeginnerPrompt)
    promptList.push(
      `**Explain to a Beginner:**\n\`\`\`\n${summary.reusabilityPrompts.explainToBeginnerPrompt}\n\`\`\``
    );
  if (summary.reusabilityPrompts.checklistPrompt)
    promptList.push(
      `**Create a Checklist:**\n\`\`\`\n${summary.reusabilityPrompts.checklistPrompt}\n\`\`\``
    );
  if (summary.reusabilityPrompts.studyGuidePrompt)
    promptList.push(
      `**Create a Study Guide:**\n\`\`\`\n${summary.reusabilityPrompts.studyGuidePrompt}\n\`\`\``
    );
  if (summary.reusabilityPrompts.flashcardsPrompt)
    promptList.push(
      `**Generate Flashcards:**\n\`\`\`\n${summary.reusabilityPrompts.flashcardsPrompt}\n\`\`\``
    );
  parts.push(
    promptList.length > 0
      ? `## Reusability Prompts\n\n${promptList.join("\n\n")}`
      : `## Reusability Prompts\n\n*No reusability prompts generated.*`
  );

  // Confidence
  parts.push(
    `## Confidence Assessment\n\n**Level:** ${capitalize(summary.confidence.level)}\n\n**Reasoning:** ${summary.confidence.reasoning}`
  );

  // Full transcript (optional)
  if (outputConfig.includeFullTranscript && transcript) {
    const lines = transcript.segments.map(
      (seg) => `**[${formatTimestamp(seg.start)}]** ${seg.text}`
    );
    parts.push(
      `## Full Transcript\n\n<details>\n<summary>Click to expand full transcript</summary>\n\n${lines.join("\n\n")}\n\n</details>`
    );
  }

  // Footer
  parts.push(
    `---\n\n*Generated by [Scrub](https://github.com/yourusername/scrub) on ${new Date().toISOString()}*`
  );

  return parts.join("\n\n");
}

// ── Skill Generation ───────────────────────────────────────────────

async function generateSkill(
  metadata: MediaMetadata,
  summary: SummaryResult,
  options?: {
    skillName?: string;
    transcript?: TranscriptionResult;
    onProgress?: (message: string) => void;
  }
): Promise<SkillGenerationResult> {
  const apiKey = config.getApiKey("anthropic")!;
  const client = new Anthropic({ apiKey });
  const summarizerConfig = config.getSummarizer();

  const skillName = options?.skillName || deriveSkillName(metadata.title);
  const guide = loadSkillCreatorGuide();
  const videoContent = formatContentForSkill(
    metadata,
    summary,
    options?.transcript
  );

  // Call 1: Build checklist
  options?.onProgress?.("Analyzing content for skill creation...");
  const checklist = await buildSkillChecklist(
    client,
    summarizerConfig.model,
    guide,
    videoContent
  );

  // Call 2: Generate skill
  options?.onProgress?.("Generating SKILL.md...");
  const skillMd = await generateSkillContent(
    client,
    summarizerConfig.model,
    guide,
    videoContent,
    checklist,
    skillName
  );

  return { skillMd, checklist, suggestedName: skillName };
}

function deriveSkillName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

function loadSkillCreatorGuide(): string {
  const projectRoot = join(__dirname, "..");
  const searchPaths = [
    join(projectRoot, ".skills", "skill-creator"),
    join(process.cwd(), ".skills", "skill-creator"),
    join(process.cwd(), ".claude", "skills", "skill-creator"),
    join(homedir(), ".claude", "skills", "skill-creator"),
  ];

  for (const skillDir of searchPaths) {
    const skillFile = join(skillDir, "SKILL.md");
    if (existsSync(skillFile)) {
      let guide = readFileSync(skillFile, "utf-8");
      const workflowsPath = join(skillDir, "references", "workflows.md");
      const outputPatternsPath = join(
        skillDir,
        "references",
        "output-patterns.md"
      );
      if (existsSync(workflowsPath))
        guide += `\n\n---\n# Reference: Workflow Patterns\n${readFileSync(workflowsPath, "utf-8")}`;
      if (existsSync(outputPatternsPath))
        guide += `\n\n---\n# Reference: Output Patterns\n${readFileSync(outputPatternsPath, "utf-8")}`;
      return guide;
    }
  }

  throw new Error(
    "skill-creator not found. Expected in .skills/skill-creator/ or ~/.claude/skills/skill-creator/"
  );
}

function formatContentForSkill(
  metadata: MediaMetadata,
  summary: SummaryResult,
  transcript?: TranscriptionResult
): string {
  let content = `## Metadata\n- Title: ${metadata.title}\n- Source: ${metadata.source}\n- Duration: ${Math.floor(metadata.duration / 60)} minutes\n- URL: ${metadata.url}\n\n## Summary\nTLDR: ${summary.tldr}\n\nOverview: ${summary.overview}\n\n### Thesis and Claims\n${summary.thesisAndClaims.thesis}\n${summary.thesisAndClaims.keyClaims.map((c) => `- ${c.claim}`).join("\n")}\n\n### Actionable Insights\n${summary.actionableInsights.map((a) => `- ${a.action}${a.context ? ` (${a.context})` : ""}`).join("\n")}\n\n### Concepts\n${summary.concepts.map((c) => `- **${c.concept}**: ${c.definition}`).join("\n")}\n\n### Mental Models\n${summary.mentalModels.map((m) => `- **${m.name}**: ${m.description}`).join("\n")}\n\n### Key Takeaways\n${summary.keyTakeaways.map((t) => `- ${t}`).join("\n")}`;

  if (summary.codeSnippets.length > 0) {
    content += `\n\n### Code Snippets\n`;
    for (const snippet of summary.codeSnippets) {
      content += `\n\`\`\`${snippet.language || ""}\n${snippet.code}\n\`\`\`\n`;
      if (snippet.context) content += `Context: ${snippet.context}\n`;
    }
  }

  if (summary.references.length > 0) {
    content += `\n\n### References\n${summary.references.map((r) => `- ${r}`).join("\n")}`;
  }

  if (transcript) {
    content += `\n\n## Transcript (excerpts)\n${transcript.fullText.substring(0, 5000)}`;
    if (transcript.fullText.length > 5000)
      content += "\n[... transcript truncated ...]";
  }

  return content;
}

async function buildSkillChecklist(
  client: Anthropic,
  model: string,
  guide: string,
  videoContent: string
): Promise<SkillChecklist> {
  const prompt = `<skill_creator_guide>\n${guide}\n</skill_creator_guide>\n\n<video_content>\n${videoContent}\n</video_content>\n\nAnalyze this content against skill creation requirements.\n\nReturn a JSON object with this structure:\n{\n  "checklist": {\n    "name": { "covered": true/false, "source": "summary"|"transcript"|"inferred"|null, "gaps": [] },\n    "description": { "covered": true/false, "source": "...", "gaps": [] },\n    "triggerScenarios": { "covered": true/false, "source": "...", "gaps": [] },\n    "domainKnowledge": { "covered": true/false, "source": "...", "gaps": [] },\n    "workflows": { "covered": true/false, "source": "...", "gaps": [] },\n    "examples": { "covered": true/false, "source": "...", "gaps": [] },\n    "codeSnippets": { "covered": true/false, "source": "...", "gaps": [] },\n    "templates": { "covered": true/false, "source": "...", "gaps": [] }\n  }\n}\n\nRespond with ONLY the JSON object:`;

  try {
    const response = await client.messages
      .stream({
        model,
        max_tokens: 2048,
        system: "You are an expert at creating AI agent skills.",
        messages: [{ role: "user", content: prompt }],
      })
      .finalMessage();

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.checklist as SkillChecklist;
  } catch (error) {
    logger.warn(`Skill checklist parsing failed: ${(error as Error).message}`);
    const defaultItem: SkillChecklistItem = {
      covered: false,
      source: "inferred",
      gaps: ["Could not analyze"],
    };
    return {
      name: { covered: true, source: "summary" },
      description: { covered: true, source: "summary" },
      triggerScenarios: defaultItem,
      domainKnowledge: defaultItem,
      workflows: defaultItem,
      examples: defaultItem,
      codeSnippets: defaultItem,
      templates: defaultItem,
    };
  }
}

async function generateSkillContent(
  client: Anthropic,
  model: string,
  guide: string,
  videoContent: string,
  checklist: SkillChecklist,
  skillName: string
): Promise<string> {
  const prompt = `You are an expert at creating AI agent skills. Generate a complete SKILL.md file.\n\n<skill_creator_guide>\n${guide}\n</skill_creator_guide>\n\n<video_content>\n${videoContent}\n</video_content>\n\n<checklist>\n${JSON.stringify(checklist, null, 2)}\n</checklist>\n\n<skill_name>\n${skillName}\n</skill_name>\n\nGenerate a complete SKILL.md following the skill-creator guide format:\n1. Start with YAML frontmatter containing name and description\n2. IMPORTANT: The frontmatter description must not contain YAML-invalid characters like colons\n3. Fill identified gaps using reasonable inference\n4. Keep the skill under 500 lines\n5. Include concrete examples and workflows\n6. Use imperative/infinitive form for instructions\n\nRespond with ONLY the SKILL.md content (starting with ---):`;

  const response = await client.messages
    .stream({
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    })
    .finalMessage();
  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const skillMatch = responseText.match(/^---[\s\S]*$/m);
  return skillMatch ? skillMatch[0] : responseText;
}
