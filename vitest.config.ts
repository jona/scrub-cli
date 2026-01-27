import { defineConfig } from "vitest/config";
import { resolve } from "path";

const includeE2E = process.argv.includes("--include-e2e");

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
