import { describe, it, expect, vi } from "vitest";
import type {
  MediaMetadata,
  SummaryResult,
  VisualAnalysis,
  TranscriptionResult,
} from "../../src/core/models.js";
import {
  buildSummaryPrompt,
  formatVisuals,
  SUMMARY_SCHEMA,
  renderSummaryMarkdown,
} from "../../src/core/summary-template.js";

const metadata: MediaMetadata = {
  contentId: "abc",
  title: "Intro to React Hooks",
  description: "A beginner walkthrough of useState.",
  duration: 125,
  thumbnailUrl: "",
  source: "YouTube",
  uploadDate: "2026-01-01",
  url: "https://youtu.be/abc",
};

function fullSummary(): SummaryResult {
  return {
    title: "Intro to React Hooks",
    tldr: "Hooks add state to function components.",
    overview: "A short intro.",
    thesisAndClaims: {
      thesis: "Hooks simplify state",
      keyClaims: [{ claim: "useState holds state", evidence: "demo" }],
      persuasionGoal: "Adopt hooks",
    },
    actionableInsights: [{ action: "Use useState", context: "local state" }],
    concepts: [{ concept: "useState", definition: "a hook" }],
    mentalModels: [],
    structureMap: [],
    openQuestions: [],
    notableQuotes: [],
    biasAnalysis: {
      perspective: "pro-hooks",
      possibleBiases: [],
      blindSpots: [],
    },
    knowledgeGraph: {
      topics: ["React"],
      people: [],
      tools: [],
      technologies: ["React"],
      relationships: [],
    },
    difficulty: {
      level: "beginner",
      prerequisites: [],
      targetAudience: "devs",
    },
    reusabilityPrompts: {},
    confidence: { level: "high", reasoning: "clear" },
    sections: [
      {
        title: "Intro",
        startTime: 0,
        endTime: 20,
        content: "Welcome.",
        codeSnippets: [
          { language: "js", code: "const [n] = useState(0)", context: "demo" },
        ],
      },
    ],
    keyTakeaways: ["Hooks are functions"],
    codeSnippets: [],
    references: ["https://react.dev", "Some Book"],
  };
}

describe("buildSummaryPrompt", () => {
  it("interpolates metadata and content with the instruction scaffold", () => {
    const prompt = buildSummaryPrompt(metadata, "the transcript body", []);

    expect(prompt).toContain("- Title: Intro to React Hooks");
    expect(prompt).toContain("- Source: YouTube");
    expect(prompt).toContain("- URL: https://youtu.be/abc");
    expect(prompt).toContain("- Duration: 2:05"); // 125s formatted
    expect(prompt).toContain("## CONTENT\nthe transcript body");
    expect(prompt).toContain('"tldr"'); // JSON skeleton present
    expect(prompt).toContain("Respond with ONLY the JSON object");
  });

  it("omits the duration line when duration is 0", () => {
    const prompt = buildSummaryPrompt({ ...metadata, duration: 0 }, "x", []);
    expect(prompt).not.toContain("- Duration:");
  });

  it("truncates long descriptions to 500 chars with an ellipsis", () => {
    const prompt = buildSummaryPrompt(
      { ...metadata, description: "x".repeat(600) },
      "body",
      []
    );
    expect(prompt).toContain("x".repeat(500) + "...");
    expect(prompt).not.toContain("x".repeat(501));
  });

  it("renders the no-visuals placeholder when there are no visuals", () => {
    const prompt = buildSummaryPrompt(metadata, "body", []);
    expect(prompt).toContain("No visual analysis available.");
  });

  it("inlines visual analysis when present", () => {
    const visuals: VisualAnalysis[] = [
      {
        timestamp: 60,
        description: "A slide about hooks",
        extractedText: "const [n] = useState(0)",
        visualType: "slide",
      },
    ];
    const prompt = buildSummaryPrompt(metadata, "body", visuals);
    expect(prompt).toContain("[1:00] (slide)");
    expect(prompt).toContain("Description: A slide about hooks");
    expect(prompt).toContain("Text/Code: const [n] = useState(0)");
    expect(prompt).not.toContain("No visual analysis available.");
  });
});

describe("formatVisuals", () => {
  it("omits the Text/Code line when extractedText is empty", () => {
    const out = formatVisuals([
      {
        timestamp: 0,
        description: "talking head",
        extractedText: "",
        visualType: "talking-head",
      },
    ]);
    expect(out).toContain("(talking-head)");
    expect(out).toContain("Description: talking head");
    expect(out).not.toContain("Text/Code:");
  });
});

describe("SUMMARY_SCHEMA", () => {
  it("describes the ScrubSummary object contract", () => {
    expect(SUMMARY_SCHEMA.type).toBe("object");
    expect(SUMMARY_SCHEMA.title).toBe("ScrubSummary");
    expect(SUMMARY_SCHEMA.required).toHaveLength(18);
    expect(Object.keys(SUMMARY_SCHEMA.properties)).toEqual(
      expect.arrayContaining([
        "tldr",
        "thesisAndClaims",
        "sections",
        "keyTakeaways",
        "references",
      ])
    );
    expect(SUMMARY_SCHEMA.properties.difficulty.properties.level.enum).toEqual([
      "beginner",
      "intermediate",
      "advanced",
    ]);
  });
});

describe("renderSummaryMarkdown", () => {
  it("renders explicit timestamps without consulting the ambient clock", () => {
    vi.useFakeTimers();
    try {
      const options = { generatedAt: "2026-10-26T12:34:56.000Z" };
      vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
      const first = renderSummaryMarkdown(
        metadata,
        fullSummary(),
        undefined,
        options
      );
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const second = renderSummaryMarkdown(
        metadata,
        fullSummary(),
        undefined,
        options
      );
      expect(first).toBe(second);
      expect(first).toContain("**Processed:** 2026-10-26");
      expect(first).toContain("on 2026-10-26T12:34:56.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a deterministic timestamp when compatibility callers omit context", () => {
    expect(renderSummaryMarkdown(metadata, fullSummary())).toContain(
      "on 1970-01-01T00:00:00.000Z"
    );
  });

  it("rejects invalid timestamp context", () => {
    expect(() =>
      renderSummaryMarkdown(metadata, fullSummary(), undefined, {
        generatedAt: "today",
      })
    ).toThrow("generatedAt must");
  });

  it("renders headers, badges, sections, code blocks, and reference links", () => {
    const md = renderSummaryMarkdown(metadata, fullSummary());

    expect(md).toContain("# Intro to React Hooks");
    expect(md).toContain("## TL;DR");
    expect(md).toContain("**Difficulty:** Beginner");
    expect(md).toContain("**Confidence:** High");
    expect(md).toContain("### Intro (0:00 - 0:20)");
    expect(md).toContain("```js\nconst [n] = useState(0)\n```");
    expect(md).toContain("- [https://react.dev](https://react.dev)"); // http → link
    expect(md).toContain("- Some Book"); // non-url → plain
  });

  it("appends the full transcript only when options opt in", () => {
    const transcript: TranscriptionResult = {
      segments: [{ start: 0, end: 5, text: "hello there" }],
      fullText: "hello there",
      language: "en",
      duration: 5,
      source: "youtube-captions",
    };

    const without = renderSummaryMarkdown(metadata, fullSummary(), transcript);
    expect(without).not.toContain("## Full Transcript");

    const withT = renderSummaryMarkdown(metadata, fullSummary(), transcript, {
      generatedAt: "2026-10-26T12:00:00.000Z",
      includeFullTranscript: true,
    });
    expect(withT).toContain("## Full Transcript");
    expect(withT).toContain("hello there");
  });
});
