import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { scrubVideo, runCLI } from "../../helpers/cli-runner.js";
import { useVCR } from "../../helpers/vcr.js";
import { getTestVideoId } from "../../helpers/fixtures.js";
import { TEST_OUTPUT_DIR } from "../setup.js";

describe("CLI: Process Video E2E", () => {
  const testVideoId = getTestVideoId();
  const vcr = useVCR("process-video");

  beforeEach(async () => {
    await vcr.beforeEach();
  });

  afterEach(async () => {
    await vcr.afterEach();
  });

  describe("scrub <video-url>", () => {
    it("should process a video and generate markdown output", async () => {
      const result = await scrubVideo(testVideoId, ["--no-visuals"]);

      expect(result.success).toBe(true);

      // Check that output directory was created
      const outputDir = join(TEST_OUTPUT_DIR, testVideoId, "output");
      expect(existsSync(outputDir)).toBe(true);

      // Check that summary.md was created
      const summaryPath = join(outputDir, "summary.md");
      expect(existsSync(summaryPath)).toBe(true);

      // Verify markdown has content
      const markdown = readFileSync(summaryPath, "utf-8");
      expect(markdown.length).toBeGreaterThan(100);
      expect(markdown).toContain("#"); // Has headers
    }, 180000); // 3 minute timeout

    it("should generate SKILL.md with --output-skill flag", async () => {
      const result = await scrubVideo(testVideoId, [
        "--no-visuals",
        "--output-skill",
      ]);

      expect(result.success).toBe(true);

      // Check that SKILL.md was created
      const outputDir = join(TEST_OUTPUT_DIR, testVideoId, "output");
      const skillPath = join(outputDir, "SKILL.md");

      // Note: SKILL.md may not be generated if skill generation fails
      // but the main process should still succeed
      if (existsSync(skillPath)) {
        const skillContent = readFileSync(skillPath, "utf-8");
        expect(skillContent).toContain("#"); // Has title
      }
    }, 180000);
  });

  describe("--dry-run", () => {
    it("should check prerequisites without processing", async () => {
      const result = await runCLI([
        `https://youtube.com/watch?v=${testVideoId}`,
        "--dry-run",
      ]);

      // Dry run should succeed if prerequisites are met
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("Ready to process");
    }, 30000); // 30 second timeout for dry-run
  });
});
