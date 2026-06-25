import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { scrubVideo } from "../../helpers/cli-runner.js";
import { useVCR } from "../../helpers/vcr.js";
import { getTestVideoId } from "../../helpers/fixtures.js";
import { TEST_OUTPUT_DIR } from "../setup.js";

/** Recursively find the first file with the given name under `dir`. */
function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

describe("CLI: Process Video E2E", () => {
  const testVideoId = getTestVideoId();
  const vcr = useVCR("process-video");

  beforeEach(async () => {
    await vcr.beforeEach();
  });

  afterEach(async () => {
    await vcr.afterEach();
  });

  describe("scrub youtube <video-url>", () => {
    it("should process a video and emit the summary prompt + schema", async () => {
      const result = await scrubVideo(testVideoId, ["--no-visuals"]);

      expect(result.success).toBe(true);

      // The deterministic pipeline emits prompt/summary.prompt.md + summary.schema.json
      const promptPath = findFile(TEST_OUTPUT_DIR, "summary.prompt.md");
      expect(promptPath).not.toBeNull();

      const schemaPath = findFile(TEST_OUTPUT_DIR, "summary.schema.json");
      expect(schemaPath).not.toBeNull();

      // Prompt has real content (instructions + transcript)
      const prompt = readFileSync(promptPath!, "utf-8");
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).toContain("## CONTENT");

      // Schema is valid JSON describing an object
      const schema = JSON.parse(readFileSync(schemaPath!, "utf-8"));
      expect(schema.type).toBe("object");
    }, 180000); // 3 minute timeout

    it("should not produce any LLM-derived artifacts (no summary.md / SKILL.md)", async () => {
      const result = await scrubVideo(testVideoId, ["--no-visuals"]);

      expect(result.success).toBe(true);
      expect(findFile(TEST_OUTPUT_DIR, "SKILL.md")).toBeNull();
      expect(findFile(TEST_OUTPUT_DIR, "summary.md")).toBeNull();
    }, 180000);
  });
});
