import Anthropic from '@anthropic-ai/sdk';
import { config } from '../core/Config.js';
import { logger } from '../utils/logger.js';
import { formatTimestamp } from '../utils/helpers.js';
import type {
  VideoMetadata,
  VisualAnalysis,
  SummaryResult,
  SummarySection,
  CodeBlock,
} from '../types/index.js';
import type { TranscriptionResult } from '../adapters/transcription/ITranscriber.js';

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
      const apiKey = config.getApiKey('anthropic');
      if (!apiKey) {
        throw new Error(
          'Anthropic API key not configured. Set ANTHROPIC_API_KEY environment variable.'
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
      throw new Error('Anthropic API key not configured');
    }

    options?.onProgress?.('Generating summary...');

    const client = this.getClient();
    const visualConfig = config.getVisual();

    // Build the comprehensive prompt
    const prompt = this.buildSummaryPrompt(metadata, transcript, visuals);

    logger.debug(`Summarizing with prompt length: ${prompt.length} chars`);

    // Make API call
    const response = await client.messages.create({
      model: visualConfig.model,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    // Extract text response
    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

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
      .join('\n');

    // Format visual analyses
    const formattedVisuals = visuals
      .map(
        (v) =>
          `[${formatTimestamp(v.timestamp)}] (${v.visualType})\n` +
          `  Description: ${v.description}\n` +
          (v.extractedText ? `  Text/Code: ${v.extractedText}` : '')
      )
      .join('\n\n');

    return `You are creating a comprehensive markdown summary of an educational video for future reference and LLM context use.

## VIDEO METADATA
- Title: ${metadata.title}
- Channel: ${metadata.channelName}
- Duration: ${formatTimestamp(metadata.duration)}
- URL: ${metadata.url}
${metadata.description ? `- Description: ${metadata.description.substring(0, 500)}${metadata.description.length > 500 ? '...' : ''}` : ''}

## TRANSCRIPT
${formattedTranscript}

## VISUAL CONTENT ANALYSIS
${formattedVisuals || 'No visual analysis available.'}

---

Create a structured JSON summary with the following format:
{
  "overview": "2-3 sentence overview of what this video covers and its main purpose",
  "sections": [
    {
      "title": "Section title",
      "startTime": 0,
      "endTime": 120,
      "content": "Detailed summary of this section, capturing key concepts, explanations, and examples",
      "visualContent": "Description of relevant visuals shown during this section (optional)",
      "codeSnippets": [
        {
          "language": "python",
          "code": "actual code shown or discussed",
          "context": "what this code demonstrates"
        }
      ]
    }
  ],
  "keyTakeaways": [
    "Key point 1 - specific and actionable",
    "Key point 2 - specific and actionable"
  ],
  "codeSnippets": [
    {
      "language": "javascript",
      "code": "consolidated important code example",
      "timestamp": 180,
      "context": "what this code does"
    }
  ],
  "references": [
    "Any tools, libraries, websites, or resources mentioned"
  ]
}

Guidelines:
1. Break the content into logical sections based on topic changes
2. Capture specific technical details, not just high-level summaries
3. Include ALL code snippets shown or discussed, properly formatted
4. Make key takeaways specific and actionable
5. Note any tools, libraries, or resources mentioned
6. Use proper markdown in the content fields
7. Timestamps should be in seconds

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
        logger.warn('Could not find JSON in summary response');
        return this.createFallbackSummary(metadata, responseText);
      }

      const parsed = JSON.parse(jsonMatch[0]) as ParsedSummary;

      // Convert to our format
      const sections: SummarySection[] = (parsed.sections || []).map((s) => ({
        title: s.title || 'Untitled Section',
        startTime: s.startTime || 0,
        endTime: s.endTime || 0,
        content: s.content || '',
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
        overview: parsed.overview || 'No overview available.',
        sections,
        keyTakeaways: parsed.keyTakeaways || [],
        codeSnippets,
        references: parsed.references || [],
      };
    } catch (error) {
      logger.warn(`Failed to parse summary response: ${(error as Error).message}`);
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
      overview: rawText.substring(0, 500) || 'Summary generation failed.',
      sections: [
        {
          title: 'Full Content',
          startTime: 0,
          endTime: metadata.duration,
          content: rawText || 'Content unavailable.',
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
      throw new Error('Anthropic API key not configured');
    }

    options?.onProgress?.('Generating quick summary...');

    const client = this.getClient();

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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
}

/**
 * Parsed summary structure from API response
 */
interface ParsedSummary {
  overview?: string;
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
