import Anthropic from "@anthropic-ai/sdk";
import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import { formatTimestamp } from "../utils/helpers.js";
import type {
  VideoMetadata,
  VisualAnalysis,
  SummaryResult,
  SummarySection,
  CodeBlock,
  ThesisAndClaims,
  ActionableInsight,
  ConceptDefinition,
  MentalModel,
  StructureSection,
  OpenQuestion,
  NotableQuote,
  BiasAnalysis,
  KnowledgeGraph,
  DifficultyAssessment,
  ReusabilityPrompts,
  ConfidenceScore,
} from "../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

/**
 * Service for summarizing video content using Claude API
 */
export class Summarizer {
  private client: Anthropic | null = null;

  /**
   * Check if summarizer is available
   */
  isAvailable(): boolean {
    return config.hasAnthropicKey();
  }

  /**
   * Initialize the Anthropic client
   */
  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = config.getApiKey("anthropic");
      if (!apiKey) {
        throw new Error(
          "Anthropic API key not configured. Set ANTHROPIC_API_KEY environment variable."
        );
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  /**
   * Generate a comprehensive summary from transcript and visual analysis
   */
  async summarize(
    metadata: VideoMetadata,
    transcript: TranscriptionResult,
    visuals: VisualAnalysis[],
    options?: {
      onProgress?: (message: string) => void;
    }
  ): Promise<SummaryResult> {
    if (!this.isAvailable()) {
      throw new Error("Anthropic API key not configured");
    }

    options?.onProgress?.("Generating summary...");

    const client = this.getClient();
    const summarizerConfig = config.getSummarizer();

    // Build the comprehensive prompt
    const prompt = this.buildSummaryPrompt(metadata, transcript, visuals);

    logger.debug(`Summarizing with prompt length: ${prompt.length} chars`);

    // Make API call
    const response = await client.messages.create({
      model: summarizerConfig.model,
      max_tokens: 16384,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    // Extract text response
    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Parse the structured response
    return this.parseResponse(responseText, metadata);
  }

  /**
   * Build the summary prompt
   */
  private buildSummaryPrompt(
    metadata: VideoMetadata,
    transcript: TranscriptionResult,
    visuals: VisualAnalysis[]
  ): string {
    // Format transcript with timestamps
    const formattedTranscript = transcript.segments
      .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
      .join("\n");

    // Format visual analyses
    const formattedVisuals = visuals
      .map(
        (v) =>
          `[${formatTimestamp(v.timestamp)}] (${v.visualType})\n` +
          `  Description: ${v.description}\n` +
          (v.extractedText ? `  Text/Code: ${v.extractedText}` : "")
      )
      .join("\n\n");

    return `You are creating a comprehensive knowledge artifact from a video. Think: "What would future-me or AI agents wish they had extracted without re-watching this video?"

## VIDEO METADATA
- Title: ${metadata.title}
- Channel: ${metadata.channelName}
- Duration: ${formatTimestamp(metadata.duration)}
- URL: ${metadata.url}
${metadata.description ? `- Description: ${metadata.description.substring(0, 500)}${metadata.description.length > 500 ? "..." : ""}` : ""}

## TRANSCRIPT
${formattedTranscript}

## VISUAL CONTENT ANALYSIS
${formattedVisuals || "No visual analysis available."}

---

Create a comprehensive JSON knowledge artifact with ALL of the following layers:

{
  "tldr": "1-2 sentence TLDR that captures the essence",
  "overview": "2-3 sentence overview of what this video covers and its main purpose",
  
  "thesisAndClaims": {
    "thesis": "The main thesis/argument of the video",
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
    "explainToBeginnerPrompt": "Using the concepts from this video, explain...",
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
5. Map the video structure so agents can remix/rewrite content
6. Note contradictions, assumptions, and open questions for deeper research
7. Only preserve "anchor line" quotes that are genuinely significant
8. Detect bias and perspective - don't treat content as ground truth
9. Build knowledge graph nodes for multi-agent systems and retrieval
10. Assess difficulty and prerequisites for learning path organization
11. Generate reusability prompts tailored to this specific content
12. Rate confidence based on source quality, evidence provided, and expertise
13. Timestamps should be in seconds
14. Include ALL code snippets shown or discussed

Respond with ONLY the JSON object, no additional text:`;
  }

  /**
   * Parse the summary response
   */
  private parseResponse(
    responseText: string,
    metadata: VideoMetadata
  ): SummaryResult {
    try {
      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn("Could not find JSON in summary response");
        return this.createFallbackSummary(metadata, responseText);
      }

      const parsed = JSON.parse(jsonMatch[0]) as ParsedSummary;

      // Convert sections to our format
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

      const codeSnippets: CodeBlock[] = (parsed.codeSnippets || []).map(
        (c) => ({
          language: c.language,
          code: c.code,
          timestamp: c.timestamp || 0,
          context: c.context,
        })
      );

      // Parse thesis and claims
      const thesisAndClaims: ThesisAndClaims = {
        thesis: parsed.thesisAndClaims?.thesis || "No thesis identified.",
        keyClaims: (parsed.thesisAndClaims?.keyClaims || []).map((c) => ({
          claim: c.claim || "",
          evidence: c.evidence,
        })),
        persuasionGoal: parsed.thesisAndClaims?.persuasionGoal,
      };

      // Parse actionable insights
      const actionableInsights: ActionableInsight[] = (
        parsed.actionableInsights || []
      ).map((a) => ({
        action: a.action || "",
        context: a.context,
        rationale: a.rationale,
      }));

      // Parse concepts
      const concepts: ConceptDefinition[] = (parsed.concepts || []).map(
        (c) => ({
          concept: c.concept || "",
          definition: c.definition || "",
          example: c.example,
        })
      );

      // Parse mental models
      const mentalModels: MentalModel[] = (parsed.mentalModels || []).map(
        (m) => ({
          name: m.name || "",
          description: m.description || "",
          whenToUse: m.whenToUse,
          whyItWorks: m.whyItWorks,
        })
      );

      // Parse structure map
      const structureMap: StructureSection[] = (parsed.structureMap || []).map(
        (s) => ({
          number: s.number || 0,
          type: s.type || "section",
          description: s.description || "",
          timeRange: s.timeRange,
        })
      );

      // Parse open questions
      const openQuestions: OpenQuestion[] = (parsed.openQuestions || []).map(
        (q) => ({
          question: q.question || "",
          type: (q.type as OpenQuestion["type"]) || "missing_data",
          context: q.context,
        })
      );

      // Parse notable quotes
      const notableQuotes: NotableQuote[] = (parsed.notableQuotes || []).map(
        (q) => ({
          quote: q.quote || "",
          significance: q.significance || "",
          timestamp: q.timestamp,
        })
      );

      // Parse bias analysis
      const biasAnalysis: BiasAnalysis = {
        perspective: parsed.biasAnalysis?.perspective || "Not analyzed.",
        possibleBiases: parsed.biasAnalysis?.possibleBiases || [],
        blindSpots: parsed.biasAnalysis?.blindSpots || [],
      };

      // Parse knowledge graph
      const knowledgeGraph: KnowledgeGraph = {
        topics: parsed.knowledgeGraph?.topics || [],
        people: parsed.knowledgeGraph?.people || [],
        tools: parsed.knowledgeGraph?.tools || [],
        technologies: parsed.knowledgeGraph?.technologies || [],
        relationships: parsed.knowledgeGraph?.relationships || [],
      };

      // Parse difficulty assessment
      const difficulty: DifficultyAssessment = {
        level:
          (parsed.difficulty?.level as DifficultyAssessment["level"]) ||
          "intermediate",
        prerequisites: parsed.difficulty?.prerequisites || [],
        targetAudience: parsed.difficulty?.targetAudience || "General audience",
      };

      // Parse reusability prompts
      const reusabilityPrompts: ReusabilityPrompts = {
        explainToBeginnerPrompt:
          parsed.reusabilityPrompts?.explainToBeginnerPrompt,
        checklistPrompt: parsed.reusabilityPrompts?.checklistPrompt,
        studyGuidePrompt: parsed.reusabilityPrompts?.studyGuidePrompt,
        flashcardsPrompt: parsed.reusabilityPrompts?.flashcardsPrompt,
      };

      // Parse confidence score
      const confidence: ConfidenceScore = {
        level:
          (parsed.confidence?.level as ConfidenceScore["level"]) || "medium",
        reasoning:
          parsed.confidence?.reasoning || "No confidence assessment available.",
      };

      return {
        title: metadata.title,
        tldr:
          parsed.tldr || parsed.overview?.split(".")[0] || "No TLDR available.",
        overview: parsed.overview || "No overview available.",
        thesisAndClaims,
        actionableInsights,
        concepts,
        mentalModels,
        structureMap,
        openQuestions,
        notableQuotes,
        biasAnalysis,
        knowledgeGraph,
        difficulty,
        reusabilityPrompts,
        confidence,
        sections,
        keyTakeaways: parsed.keyTakeaways || [],
        codeSnippets,
        references: parsed.references || [],
      };
    } catch (error) {
      logger.warn(
        `Failed to parse summary response: ${(error as Error).message}`
      );
      return this.createFallbackSummary(metadata, responseText);
    }
  }

  /**
   * Create a fallback summary when parsing fails
   */
  private createFallbackSummary(
    metadata: VideoMetadata,
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

  /**
   * Generate a quick summary (less detailed, faster)
   */
  async quickSummarize(
    metadata: VideoMetadata,
    transcript: TranscriptionResult,
    options?: {
      onProgress?: (message: string) => void;
    }
  ): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error("Anthropic API key not configured");
    }

    options?.onProgress?.("Generating quick summary...");

    const client = this.getClient();
    const summarizerConfig = config.getSummarizer();

    const prompt = `Summarize this video transcript in 3-5 paragraphs:

Title: ${metadata.title}
Channel: ${metadata.channelName}
Duration: ${formatTimestamp(metadata.duration)}

Transcript:
${transcript.fullText}

Focus on:
1. Main topic and purpose
2. Key concepts explained
3. Important takeaways
4. Any code or technical details mentioned

Write a clear, informative summary:`;

    const response = await client.messages.create({
      model: summarizerConfig.model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
}

/**
 * Parsed summary structure from API response
 */
interface ParsedSummary {
  tldr?: string;
  overview?: string;
  thesisAndClaims?: {
    thesis?: string;
    keyClaims?: Array<{
      claim?: string;
      evidence?: string;
    }>;
    persuasionGoal?: string;
  };
  actionableInsights?: Array<{
    action?: string;
    context?: string;
    rationale?: string;
  }>;
  concepts?: Array<{
    concept?: string;
    definition?: string;
    example?: string;
  }>;
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
  openQuestions?: Array<{
    question?: string;
    type?: string;
    context?: string;
  }>;
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
  confidence?: {
    level?: string;
    reasoning?: string;
  };
  sections?: Array<{
    title?: string;
    startTime?: number;
    endTime?: number;
    content?: string;
    visualContent?: string;
    codeSnippets?: Array<{
      language?: string;
      code: string;
      context?: string;
    }>;
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

// Export singleton instance
export const summarizer = new Summarizer();
