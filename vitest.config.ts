import { defineConfig } from "vitest/config";
import { resolve } from "path";

// e2e tests are opt-in via INCLUDE_E2E=1 (they drive real yt-dlp/ffmpeg + network).
// Must be an env var, not a `--include-e2e` argv flag: vitest v4's CLI parser
// rejects unknown flags before this config is evaluated.
const includeE2E = !!process.env.INCLUDE_E2E;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: includeE2E
      ? ["node_modules", "dist"]
      : ["node_modules", "dist", "tests/e2e/**"],

    // Timeout for E2E tests (video processing can be slow)
    testTimeout: 180000, // 3 minutes
    hookTimeout: 120000, // 2 minutes for setup/teardown

    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },

    // Setup files (only for e2e)
    setupFiles: includeE2E ? ["./tests/e2e/setup.ts"] : [],

    // Run E2E tests sequentially to avoid resource conflicts
    sequence: {
      concurrent: false,
    },
  },

  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@fixtures": resolve(__dirname, "./tests/fixtures"),
      "@helpers": resolve(__dirname, "./tests/helpers"),
    },
  },
});
