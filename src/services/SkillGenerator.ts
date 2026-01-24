import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import type {
  VideoMetadata,
  SummaryResult,
  SkillChecklist,
  SkillChecklistItem,
  SkillGenerationResult,
} from "../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Re-export types for convenience
export type { SkillChecklist, SkillGenerationResult };

/**
 * Options for skill generation
 */
export interface GenerateSkillOptions {
  skillName?: string;
  transcript?: TranscriptionResult;
  onProgress?: (message: string) => void;
}

/**
 * Service for generating SKILL.md files from video content
 */
export class SkillGenerator {
  private client: Anthropic | null = null;
  private skillCreatorGuide: string | null = null;

  /**
   * Check if skill generator is available
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
   * Find a skill directory by searching the skill path hierarchy
   * Order: project .skills/ → ~/.claude/skills/
   */
  private findSkillDir(skillName: string): string | null {
    // Get project root (from dist/services/ or src/services/)
    const projectRoot = join(__dirname, "..", "..");

    // Skill search paths in priority order
    const searchPaths = [
      join(projectRoot, ".skills", skillName), // Project bundled skills
      join(process.cwd(), ".skills", skillName), // CWD .skills/
      join(process.cwd(), ".claude", "skills", skillName), // Project .claude/skills/
      join(homedir(), ".claude", "skills", skillName), // Personal ~/.claude/skills/
    ];

    for (const skillDir of searchPaths) {
      const skillFile = join(skillDir, "SKILL.md");
      if (existsSync(skillFile)) {
        logger.debug(`Found skill '${skillName}' at: ${skillDir}`);
        return skillDir;
      }
    }

    return null;
  }

  /**
   * Load the skill-creator guide from the skill path hierarchy
   */
  private loadSkillCreatorGuide(): string {
    if (this.skillCreatorGuide) {
      return this.skillCreatorGuide;
    }

    const skillsDir = this.findSkillDir("skill-creator");
    if (!skillsDir) {
      throw new Error(
        "skill-creator not found. Expected in .skills/skill-creator/ or ~/.claude/skills/skill-creator/"
      );
    }

    // Load main SKILL.md
    const mainGuide = readFileSync(join(skillsDir, "SKILL.md"), "utf-8");

    // Load reference files if they exist
    let workflowsRef = "";
    let outputPatternsRef = "";

    const workflowsPath = join(skillsDir, "references", "workflows.md");
    const outputPatternsPath = join(
      skillsDir,
      "references",
      "output-patterns.md"
    );

    if (existsSync(workflowsPath)) {
      workflowsRef = readFileSync(workflowsPath, "utf-8");
    }
    if (existsSync(outputPatternsPath)) {
      outputPatternsRef = readFileSync(outputPatternsPath, "utf-8");
    }

    // Combine into a single guide
    this.skillCreatorGuide = mainGuide;

    if (workflowsRef) {
      this.skillCreatorGuide += `\n\n---\n# Reference: Workflow Patterns\n${workflowsRef}`;
    }
    if (outputPatternsRef) {
      this.skillCreatorGuide += `\n\n---\n# Reference: Output Patterns\n${outputPatternsRef}`;
    }

    return this.skillCreatorGuide;
  }

  /**
   * Derive a skill name from video title
   */
  private deriveSkillName(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
      .replace(/\s+/g, "-") // Replace spaces with hyphens
      .replace(/-+/g, "-") // Collapse multiple hyphens
      .replace(/^-|-$/g, "") // Trim leading/trailing hyphens
      .substring(0, 50); // Limit length
  }

  /**
   * Generate a SKILL.md from video content using two-call strategy
   */
  async generate(
    metadata: VideoMetadata,
    summary: SummaryResult,
    options?: GenerateSkillOptions
  ): Promise<SkillGenerationResult> {
    if (!this.isAvailable()) {
      throw new Error("Anthropic API key not configured");
    }

    const skillName =
      options?.skillName || this.deriveSkillName(metadata.title);

    options?.onProgress?.("Analyzing video content for skill creation...");

    // Call 1: Build checklist and assess coverage
    const checklist = await this.buildChecklist(metadata, summary, options);

    options?.onProgress?.("Generating SKILL.md...");

    // Call 2: Generate the skill
    const skillMd = await this.generateSkillContent(
      metadata,
      summary,
      checklist,
      skillName,
      options
    );

    return {
      skillMd,
      checklist,
      suggestedName: skillName,
    };
  }

  /**
   * Call 1: Build checklist analyzing what skill components the video can support
   */
  private async buildChecklist(
    metadata: VideoMetadata,
    summary: SummaryResult,
    options?: GenerateSkillOptions
  ): Promise<SkillChecklist> {
    const client = this.getClient();
    const guide = this.loadSkillCreatorGuide();
    const summarizerConfig = config.getSummarizer();

    const videoContent = this.formatVideoContent(
      metadata,
      summary,
      options?.transcript
    );

    const prompt = `
      <skill_creator_guide>
      ${guide}
      </skill_creator_guide>

      <video_content>
      ${videoContent}
      </video_content>

      Analyze this video content against skill creation requirements.

      For each skill component, assess:
      1. Whether the video provides enough information to cover it
      2. What source the information comes from (summary, transcript, or needs inference)
      3. What gaps exist that would need to be filled by inference

      Return a JSON object with this structure:
      {
        "suggestedName": "kebab-case-skill-name",
        "suitabilityScore": 0-10,
        "checklist": {
          "name": { "covered": true/false, "source": "summary"|"transcript"|"inferred"|null, "gaps": [] },
          "description": { "covered": true/false, "source": "...", "gaps": [] },
          "triggerScenarios": { "covered": true/false, "source": "...", "gaps": ["gap1", "gap2"] },
          "domainKnowledge": { "covered": true/false, "source": "...", "gaps": [] },
          "workflows": { "covered": true/false, "source": "...", "gaps": [] },
          "examples": { "covered": true/false, "source": "...", "gaps": [] },
          "codeSnippets": { "covered": true/false, "source": "...", "gaps": [] },
          "templates": { "covered": true/false, "source": "...", "gaps": [] }
        },
        "notes": "Any important observations about skill generation feasibility"
      }

      Respond with ONLY the JSON object:
    `;

    let response: Anthropic.Message;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        response = await client.messages.create({
          model: summarizerConfig.model,
          max_tokens: 2048,
          system:
            "You are an expert at creating AI agent skills. You've been given the skill-creator guide and video content. Analyze this video content against skill creation requirements.",
          messages: [{ role: "user", content: prompt }],
        });

        const responseText = response.content
          .filter(
            (block): block is Anthropic.TextBlock => block.type === "text"
          )
          .map((block) => block.text)
          .join("\n");

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error("No JSON found in response");
        }

        const parsed = JSON.parse(jsonMatch[0]);

        logger.debug(`Skill suitability score: ${parsed.suitabilityScore}/10`);
        if (parsed.notes) {
          logger.debug(`Skill generation notes: ${parsed.notes}`);
        }

        return parsed.checklist as SkillChecklist;
      } catch (error) {
        logger.warn(
          `Checklist parsing attempt ${attempts} failed: ${(error as Error).message}`
        );
        if (attempts >= maxAttempts) {
          // Return a partial/default checklist on failure
          return this.createDefaultChecklist();
        }
      }
    }

    return this.createDefaultChecklist();
  }

  /**
   * Call 2: Generate the actual SKILL.md content
   */
  private async generateSkillContent(
    metadata: VideoMetadata,
    summary: SummaryResult,
    checklist: SkillChecklist,
    skillName: string,
    options?: GenerateSkillOptions
  ): Promise<string> {
    const client = this.getClient();
    const guide = this.loadSkillCreatorGuide();
    const summarizerConfig = config.getSummarizer();

    const videoContent = this.formatVideoContent(
      metadata,
      summary,
      options?.transcript
    );

    const prompt = `You are an expert at creating AI agent skills. Generate a complete SKILL.md file.

<skill_creator_guide>
${guide}
</skill_creator_guide>

<video_content>
${videoContent}
</video_content>

<checklist>
${JSON.stringify(checklist, null, 2)}
</checklist>

<skill_name>
${skillName}
</skill_name>

Generate a complete SKILL.md following the skill-creator guide format:

1. Start with YAML frontmatter containing name and description
2. The description should clearly explain when this skill should be triggered
3. Fill identified gaps using reasonable inference from the video content
4. Keep the skill under 500 lines total
5. Include concrete examples and workflows from the video
6. Use imperative/infinitive form for instructions
7. Do NOT include installation guides, READMEs, or auxiliary documentation

The skill should be immediately usable by an AI agent. Focus on:
- Clear trigger scenarios in the frontmatter description
- Actionable workflows and procedures
- Domain knowledge extracted from the video
- Code snippets or templates if applicable

Respond with ONLY the SKILL.md content (starting with ---):`;

    const response = await client.messages.create({
      model: summarizerConfig.model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Extract the SKILL.md content (should start with ---)
    const skillMatch = responseText.match(/^---[\s\S]*$/m);
    if (skillMatch) {
      return skillMatch[0];
    }

    // If no frontmatter found, return as-is (may need validation later)
    return responseText;
  }

  /**
   * Format video content for prompts
   */
  private formatVideoContent(
    metadata: VideoMetadata,
    summary: SummaryResult,
    transcript?: TranscriptionResult
  ): string {
    let content = `## Video Metadata
- Title: ${metadata.title}
- Channel: ${metadata.channelName}
- Duration: ${Math.floor(metadata.duration / 60)} minutes
- URL: ${metadata.url}

## Summary
TLDR: ${summary.tldr}

Overview: ${summary.overview}

### Thesis and Claims
${summary.thesisAndClaims.thesis}
${summary.thesisAndClaims.keyClaims.map((c) => `- ${c.claim}`).join("\n")}

### Actionable Insights
${summary.actionableInsights.map((a) => `- ${a.action}${a.context ? ` (${a.context})` : ""}`).join("\n")}

### Concepts
${summary.concepts.map((c) => `- **${c.concept}**: ${c.definition}`).join("\n")}

### Mental Models
${summary.mentalModels.map((m) => `- **${m.name}**: ${m.description}`).join("\n")}

### Key Takeaways
${summary.keyTakeaways.map((t) => `- ${t}`).join("\n")}`;

    if (summary.codeSnippets.length > 0) {
      content += `\n\n### Code Snippets\n`;
      for (const snippet of summary.codeSnippets) {
        content += `\n\`\`\`${snippet.language || ""}\n${snippet.code}\n\`\`\`\n`;
        if (snippet.context) {
          content += `Context: ${snippet.context}\n`;
        }
      }
    }

    if (summary.references.length > 0) {
      content += `\n\n### References\n${summary.references.map((r) => `- ${r}`).join("\n")}`;
    }

    if (transcript) {
      content += `\n\n## Transcript (excerpts)\n${transcript.fullText.substring(0, 5000)}`;
      if (transcript.fullText.length > 5000) {
        content += "\n[... transcript truncated ...]";
      }
    }

    return content;
  }

  /**
   * Create a default checklist when parsing fails
   */
  private createDefaultChecklist(): SkillChecklist {
    const defaultItem: SkillChecklistItem = {
      covered: false,
      source: "inferred",
      gaps: ["Could not analyze - using inference"],
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

// Export singleton instance
export const skillGenerator = new SkillGenerator();
