import { writeFileSync } from 'fs';
import { config } from '../infrastructure/Config.js';
import { formatTimestamp, ensureParentDir } from '../utils/helpers.js';
import type {
  VideoMetadata,
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
} from '../types/index.js';
import type { TranscriptionResult } from '../transcription/ITranscriber.js';

/**
 * Service for generating markdown output from video summaries
 */
export class MarkdownGenerator {
  /**
   * Generate complete markdown document - comprehensive knowledge artifact
   */
  generate(
    metadata: VideoMetadata,
    summary: SummaryResult,
    transcript?: TranscriptionResult
  ): string {
    const outputConfig = config.getOutput();
    const parts: string[] = [];

    // Title and metadata
    parts.push(this.generateHeader(metadata, summary));

    // TLDR
    parts.push(this.generateTLDR(summary.tldr));

    // Overview
    parts.push(this.generateOverview(summary.overview));

    // Thesis and Key Claims
    parts.push(this.generateThesisAndClaims(summary.thesisAndClaims));

    // Actionable Insights
    if (summary.actionableInsights.length > 0) {
      parts.push(this.generateActionableInsights(summary.actionableInsights));
    }

    // Concepts and Definitions
    if (summary.concepts.length > 0) {
      parts.push(this.generateConcepts(summary.concepts));
    }

    // Mental Models / Frameworks
    if (summary.mentalModels.length > 0) {
      parts.push(this.generateMentalModels(summary.mentalModels));
    }

    // Structure Map
    if (summary.structureMap.length > 0) {
      parts.push(this.generateStructureMap(summary.structureMap));
    }

    // Table of contents for detailed sections
    if (summary.sections.length > 1) {
      parts.push(this.generateTableOfContents(summary.sections));
    }

    // Detailed Sections
    parts.push(this.generateSections(summary.sections));

    // Open Questions and Contradictions
    if (summary.openQuestions.length > 0) {
      parts.push(this.generateOpenQuestions(summary.openQuestions));
    }

    // Notable Quotes
    if (summary.notableQuotes.length > 0) {
      parts.push(this.generateNotableQuotes(summary.notableQuotes));
    }

    // Bias and Perspective Analysis
    parts.push(this.generateBiasAnalysis(summary.biasAnalysis));

    // Knowledge Graph
    parts.push(this.generateKnowledgeGraph(summary.knowledgeGraph));

    // Key takeaways
    if (summary.keyTakeaways.length > 0) {
      parts.push(this.generateKeyTakeaways(summary.keyTakeaways));
    }

    // Consolidated code snippets
    if (summary.codeSnippets.length > 0) {
      parts.push(this.generateCodeSnippets(summary.codeSnippets));
    }

    // References
    if (summary.references.length > 0) {
      parts.push(this.generateReferences(summary.references));
    }

    // Difficulty and Prerequisites
    parts.push(this.generateDifficulty(summary.difficulty));

    // Reusability Prompts
    parts.push(this.generateReusabilityPrompts(summary.reusabilityPrompts));

    // Confidence Score
    parts.push(this.generateConfidence(summary.confidence));

    // Full transcript (optional)
    if (outputConfig.includeFullTranscript && transcript) {
      parts.push(this.generateFullTranscript(transcript));
    }

    // Footer
    parts.push(this.generateFooter());

    return parts.join('\n\n');
  }

  /**
   * Generate header section with metadata
   */
  private generateHeader(metadata: VideoMetadata, summary: SummaryResult): string {
    const difficultyBadge = summary.difficulty?.level 
      ? `**Difficulty:** ${this.capitalize(summary.difficulty.level)}`
      : '';
    const confidenceBadge = summary.confidence?.level
      ? `**Confidence:** ${this.capitalize(summary.confidence.level)}`
      : '';
    
    return `# ${metadata.title}

> **Source:** [${metadata.url}](${metadata.url})  
> **Channel:** ${metadata.channelName}  
> **Duration:** ${formatTimestamp(metadata.duration)}  
> **Processed:** ${new Date().toISOString().split('T')[0]}  
> ${difficultyBadge} | ${confidenceBadge}`;
  }

  /**
   * Generate TLDR section
   */
  private generateTLDR(tldr: string): string {
    return `## TL;DR

> ${tldr}`;
  }

  /**
   * Generate overview section
   */
  private generateOverview(overview: string): string {
    return `## Overview

${overview}`;
  }

  /**
   * Generate thesis and key claims section
   */
  private generateThesisAndClaims(thesis: ThesisAndClaims): string {
    const claimsList = thesis.keyClaims
      .map((c) => {
        const evidence = c.evidence ? ` *(${c.evidence})*` : '';
        return `- ${c.claim}${evidence}`;
      })
      .join('\n');

    let content = `## Thesis & Key Claims

**Thesis:** ${thesis.thesis}`;

    if (thesis.persuasionGoal) {
      content += `\n\n**Persuasion Goal:** ${thesis.persuasionGoal}`;
    }

    if (claimsList) {
      content += `\n\n**Key Claims:**\n${claimsList}`;
    }

    return content;
  }

  /**
   * Generate actionable insights section
   */
  private generateActionableInsights(insights: ActionableInsight[]): string {
    const items = insights
      .map((i) => {
        let item = `- **${i.action}**`;
        if (i.context) item += `\n  - *When:* ${i.context}`;
        if (i.rationale) item += `\n  - *Why:* ${i.rationale}`;
        return item;
      })
      .join('\n');

    return `## Actionable Insights

${items}`;
  }

  /**
   * Generate concepts and definitions section
   */
  private generateConcepts(concepts: ConceptDefinition[]): string {
    const items = concepts
      .map((c) => {
        let item = `### ${c.concept}\n\n${c.definition}`;
        if (c.example) item += `\n\n*Example:* ${c.example}`;
        return item;
      })
      .join('\n\n');

    return `## Concepts & Definitions

${items}`;
  }

  /**
   * Generate mental models section
   */
  private generateMentalModels(models: MentalModel[]): string {
    const items = models
      .map((m) => {
        let item = `### ${m.name}\n\n${m.description}`;
        if (m.whenToUse) item += `\n\n**When to use:** ${m.whenToUse}`;
        if (m.whyItWorks) item += `\n\n**Why it works:** ${m.whyItWorks}`;
        return item;
      })
      .join('\n\n');

    return `## Mental Models & Frameworks

${items}`;
  }

  /**
   * Generate structure map section
   */
  private generateStructureMap(structure: StructureSection[]): string {
    const items = structure
      .map((s) => {
        const timeInfo = s.timeRange ? ` (${s.timeRange})` : '';
        return `${s.number}. **${this.capitalize(s.type)}**${timeInfo}: ${s.description}`;
      })
      .join('\n');

    return `## Video Structure

${items}`;
  }

  /**
   * Generate open questions section
   */
  private generateOpenQuestions(questions: OpenQuestion[]): string {
    const grouped: Record<string, OpenQuestion[]> = {};
    
    for (const q of questions) {
      const type = q.type || 'other';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(q);
    }

    const typeLabels: Record<string, string> = {
      assumption: 'Assumptions',
      contradiction: 'Contradictions',
      missing_data: 'Missing Data',
      debate: 'Open Debates',
    };

    const sections = Object.entries(grouped)
      .map(([type, qs]) => {
        const label = typeLabels[type] || 'Other';
        const items = qs
          .map((q) => {
            let item = `- ${q.question}`;
            if (q.context) item += ` *(${q.context})*`;
            return item;
          })
          .join('\n');
        return `**${label}:**\n${items}`;
      })
      .join('\n\n');

    return `## Open Questions & Contradictions

${sections}`;
  }

  /**
   * Generate notable quotes section
   */
  private generateNotableQuotes(quotes: NotableQuote[]): string {
    const items = quotes
      .map((q) => {
        const timestamp = q.timestamp ? ` *(${formatTimestamp(q.timestamp)})*` : '';
        return `> "${q.quote}"${timestamp}\n>\n> **Why it matters:** ${q.significance}`;
      })
      .join('\n\n');

    return `## Notable Quotes

${items}`;
  }

  /**
   * Generate bias analysis section
   */
  private generateBiasAnalysis(bias: BiasAnalysis): string {
    let content = `## Bias & Perspective Analysis

**Perspective:** ${bias.perspective}`;

    if (bias.possibleBiases.length > 0) {
      content += `\n\n**Possible Biases:**\n${bias.possibleBiases.map((b) => `- ${b}`).join('\n')}`;
    }

    if (bias.blindSpots.length > 0) {
      content += `\n\n**Blind Spots (What's Not Being Said):**\n${bias.blindSpots.map((b) => `- ${b}`).join('\n')}`;
    }

    return content;
  }

  /**
   * Generate knowledge graph section
   */
  private generateKnowledgeGraph(graph: KnowledgeGraph): string {
    const sections: string[] = [];

    if (graph.topics.length > 0) {
      sections.push(`**Topics:** ${graph.topics.join(', ')}`);
    }
    if (graph.people.length > 0) {
      sections.push(`**People:** ${graph.people.join(', ')}`);
    }
    if (graph.tools.length > 0) {
      sections.push(`**Tools:** ${graph.tools.join(', ')}`);
    }
    if (graph.technologies.length > 0) {
      sections.push(`**Technologies:** ${graph.technologies.join(', ')}`);
    }
    if (graph.relationships.length > 0) {
      sections.push(`**Relationships:**\n${graph.relationships.map((r) => `- ${r}`).join('\n')}`);
    }

    return `## Knowledge Graph

${sections.join('\n\n')}`;
  }

  /**
   * Generate difficulty assessment section
   */
  private generateDifficulty(difficulty: DifficultyAssessment): string {
    let content = `## Difficulty & Prerequisites

**Level:** ${this.capitalize(difficulty.level)}

**Target Audience:** ${difficulty.targetAudience}`;

    if (difficulty.prerequisites.length > 0) {
      content += `\n\n**Prerequisites:**\n${difficulty.prerequisites.map((p) => `- ${p}`).join('\n')}`;
    }

    return content;
  }

  /**
   * Generate reusability prompts section
   */
  private generateReusabilityPrompts(prompts: ReusabilityPrompts): string {
    const promptList: string[] = [];

    if (prompts.explainToBeginnerPrompt) {
      promptList.push(`**Explain to a Beginner:**\n\`\`\`\n${prompts.explainToBeginnerPrompt}\n\`\`\``);
    }
    if (prompts.checklistPrompt) {
      promptList.push(`**Create a Checklist:**\n\`\`\`\n${prompts.checklistPrompt}\n\`\`\``);
    }
    if (prompts.studyGuidePrompt) {
      promptList.push(`**Create a Study Guide:**\n\`\`\`\n${prompts.studyGuidePrompt}\n\`\`\``);
    }
    if (prompts.flashcardsPrompt) {
      promptList.push(`**Generate Flashcards:**\n\`\`\`\n${prompts.flashcardsPrompt}\n\`\`\``);
    }

    if (promptList.length === 0) {
      return `## Reusability Prompts

*No reusability prompts generated.*`;
    }

    return `## Reusability Prompts

${promptList.join('\n\n')}`;
  }

  /**
   * Generate confidence score section
   */
  private generateConfidence(confidence: ConfidenceScore): string {
    return `## Confidence Assessment

**Level:** ${this.capitalize(confidence.level)}

**Reasoning:** ${confidence.reasoning}`;
  }

  /**
   * Capitalize first letter
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Generate table of contents
   */
  private generateTableOfContents(sections: SummarySection[]): string {
    const links = sections.map((section, index) => {
      const anchor = this.slugify(section.title);
      const timestamp = formatTimestamp(section.startTime);
      return `${index + 1}. [${section.title}](#${anchor}) (${timestamp})`;
    });

    return `## Table of Contents

${links.join('\n')}`;
  }

  /**
   * Generate sections
   */
  private generateSections(sections: SummarySection[]): string {
    const sectionParts = sections.map((section) => {
      const timeRange = `${formatTimestamp(section.startTime)} - ${formatTimestamp(section.endTime)}`;
      let content = `### ${section.title} (${timeRange})

${section.content}`;

      // Add visual content if present
      if (section.visualContent) {
        content += `\n\n**Visual Content:** ${section.visualContent}`;
      }

      // Add code snippets within the section
      if (section.codeSnippets && section.codeSnippets.length > 0) {
        const codeBlocks = section.codeSnippets
          .map((code) => this.formatCodeBlock(code))
          .join('\n\n');
        content += `\n\n${codeBlocks}`;
      }

      return content;
    });

    return `## Content

${sectionParts.join('\n\n---\n\n')}`;
  }

  /**
   * Generate key takeaways section
   */
  private generateKeyTakeaways(takeaways: string[]): string {
    const items = takeaways.map((t) => `- ${t}`).join('\n');
    return `## Key Takeaways

${items}`;
  }

  /**
   * Generate consolidated code snippets section
   */
  private generateCodeSnippets(snippets: CodeBlock[]): string {
    const codeBlocks = snippets
      .map((snippet) => {
        const header = snippet.context
          ? `**${snippet.context}** (${formatTimestamp(snippet.timestamp)})`
          : `Code at ${formatTimestamp(snippet.timestamp)}`;

        return `${header}\n\n${this.formatCodeBlock(snippet)}`;
      })
      .join('\n\n---\n\n');

    return `## Code Snippets

${codeBlocks}`;
  }

  /**
   * Format a single code block
   */
  private formatCodeBlock(code: CodeBlock): string {
    const language = code.language || '';
    return `\`\`\`${language}
${code.code}
\`\`\``;
  }

  /**
   * Generate references section
   */
  private generateReferences(references: string[]): string {
    const items = references.map((r) => {
      // Try to detect if it's a URL
      if (r.match(/^https?:\/\//)) {
        return `- [${r}](${r})`;
      }
      return `- ${r}`;
    }).join('\n');

    return `## References & Resources

${items}`;
  }

  /**
   * Generate full transcript section
   */
  private generateFullTranscript(transcript: TranscriptionResult): string {
    const lines = transcript.segments.map(
      (seg) => `**[${formatTimestamp(seg.start)}]** ${seg.text}`
    );

    return `## Full Transcript

<details>
<summary>Click to expand full transcript</summary>

${lines.join('\n\n')}

</details>`;
  }

  /**
   * Generate footer
   */
  private generateFooter(): string {
    return `---

*Generated by [Scrub](https://github.com/yourusername/scrub) on ${new Date().toISOString()}*`;
  }

  /**
   * Convert title to URL-safe slug
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }

  /**
   * Save markdown to file
   */
  save(content: string, outputPath: string): void {
    ensureParentDir(outputPath);
    writeFileSync(outputPath, content, 'utf-8');
  }

  /**
   * Generate a simple summary (without full structure)
   */
  generateSimple(
    metadata: VideoMetadata,
    transcriptText: string,
    summary?: string
  ): string {
    return `# ${metadata.title}

> **Source:** [${metadata.url}](${metadata.url})  
> **Channel:** ${metadata.channelName}  
> **Duration:** ${formatTimestamp(metadata.duration)}

## Summary

${summary || 'No summary available.'}

## Transcript

${transcriptText}

---

*Generated by Scrub*`;
  }
}

// Export singleton instance
export const markdownGenerator = new MarkdownGenerator();
