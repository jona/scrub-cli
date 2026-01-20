import { writeFileSync } from 'fs';
import { config } from '../core/Config.js';
import { formatTimestamp, ensureParentDir } from '../utils/helpers.js';
import type {
  VideoMetadata,
  SummaryResult,
  SummarySection,
  CodeBlock,
} from '../types/index.js';
import type { TranscriptionResult } from '../adapters/transcription/ITranscriber.js';

/**
 * Service for generating markdown output from video summaries
 */
export class MarkdownGenerator {
  /**
   * Generate complete markdown document
   */
  generate(
    metadata: VideoMetadata,
    summary: SummaryResult,
    transcript?: TranscriptionResult
  ): string {
    const outputConfig = config.getOutput();
    const parts: string[] = [];

    // Title and metadata
    parts.push(this.generateHeader(metadata));

    // Overview
    parts.push(this.generateOverview(summary.overview));

    // Table of contents
    if (summary.sections.length > 1) {
      parts.push(this.generateTableOfContents(summary.sections));
    }

    // Sections
    parts.push(this.generateSections(summary.sections));

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
  private generateHeader(metadata: VideoMetadata): string {
    return `# ${metadata.title}

> **Source:** [${metadata.url}](${metadata.url})  
> **Channel:** ${metadata.channelName}  
> **Duration:** ${formatTimestamp(metadata.duration)}  
> **Processed:** ${new Date().toISOString().split('T')[0]}`;
  }

  /**
   * Generate overview section
   */
  private generateOverview(overview: string): string {
    return `## Overview

${overview}`;
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

*Generated by [Scrub](https://github.com/your-repo/scrub) on ${new Date().toISOString()}*`;
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
