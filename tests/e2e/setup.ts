import { beforeAll, afterAll } from "vitest";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export const TEST_OUTPUT_DIR = join(process.cwd(), ".test-output");

// The opt-in live CLI smoke test uses this public video.
export const TEST_VIDEO_ID = "56kq0VTkU4k";

beforeAll(async () => {
  // Ensure the project is built before running E2E tests
  if (!existsSync(join(process.cwd(), "dist"))) {
    console.log("Building project for E2E tests...");
    execSync("npm run build", { stdio: "inherit" });
  }

  // Create clean test output directory
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
  mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
});

afterAll(async () => {
  // Cleanup test output unless debugging
  if (existsSync(TEST_OUTPUT_DIR) && !process.env.KEEP_TEST_OUTPUT) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
});
