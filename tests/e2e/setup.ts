import { beforeAll, afterAll } from "vitest";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export const TEST_OUTPUT_DIR = join(process.cwd(), ".test-output");
export const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures");

// Test video and playlist IDs
export const TEST_VIDEO_ID = "56kq0VTkU4k";
export const TEST_PLAYLIST_ID = "PLf2m23nhTg1MjwozACw3ufAc3CUpfOBWO";

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

  // Ensure fixtures directories exist
  mkdirSync(join(FIXTURES_DIR, "videos"), { recursive: true });
  mkdirSync(join(FIXTURES_DIR, "playlists"), { recursive: true });
  mkdirSync(join(FIXTURES_DIR, "cassettes", "anthropic"), { recursive: true });
});

afterAll(async () => {
  // Cleanup test output unless debugging
  if (existsSync(TEST_OUTPUT_DIR) && !process.env.KEEP_TEST_OUTPUT) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
});
