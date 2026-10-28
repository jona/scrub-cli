import { describe, expect, it } from "vitest";
import { resolveLangSmithTracingConfig } from "../../src/deployments/tracing-config.js";

describe("server-owned LangSmith tracing configuration", () => {
  it("defaults to disabled metadata-only tracing with a bounded deadline", () => {
    expect(resolveLangSmithTracingConfig({})).toEqual({
      enabled: false,
      project: "scrub",
      endpoint: "https://api.smith.langchain.com",
      captureContent: false,
      timeoutMs: 2000,
      redactValues: [],
    });
  });

  it("accepts explicit server configuration without mutating it or requiring a startup key", () => {
    const env = Object.freeze({
      LANGSMITH_TRACING: "true",
      LANGSMITH_PROJECT: "custom project",
      LANGSMITH_ENDPOINT: "https://eu.api.smith.langchain.com/",
      LANGSMITH_WORKSPACE_ID: "12345678-1234-1234-1234-123456789012",
      SCRUB_LANGSMITH_CAPTURE_CONTENT: "true",
      SCRUB_LANGSMITH_TIMEOUT_MS: "10000",
    });
    expect(resolveLangSmithTracingConfig(env)).toEqual({
      enabled: true,
      project: "custom project",
      endpoint: "https://eu.api.smith.langchain.com",
      workspaceId: env.LANGSMITH_WORKSPACE_ID,
      captureContent: true,
      timeoutMs: 10000,
      redactValues: [],
    });
    expect(
      resolveLangSmithTracingConfig({ LANGSMITH_WORKSPACE_ID: "" })
    ).not.toHaveProperty("workspaceId");
  });

  it("supplies exact known secret values for redaction without treating public settings as secrets", () => {
    const env = {
      LANGSMITH_API_KEY: " tracing-secret-fixture ",
      OPENAI_API_KEY: "model-secret-fixture",
      ADMIN_API_TOKEN: "admin-secret-fixture",
      SCRUB_API_TOKEN: "app-secret-fixture",
      ANTHROPIC_API_KEY: "model-secret-fixture",
      UNUSED_PASSWORD: "",
      SHORT_TOKEN: "short",
      SCRUB_SUMMARY_MODEL: "public-model",
      LANGSMITH_PROJECT: "public-project",
    };
    const config = resolveLangSmithTracingConfig(env);
    expect(config.apiKey).toBe("tracing-secret-fixture");
    expect(config.redactValues).toEqual([
      " tracing-secret-fixture ",
      "tracing-secret-fixture",
      "model-secret-fixture",
      "admin-secret-fixture",
      "app-secret-fixture",
    ]);
    expect(config.project).toBe("public-project");
  });

  for (const name of ["LANGSMITH_TRACING", "SCRUB_LANGSMITH_CAPTURE_CONTENT"])
    it.each(["", "TRUE", "FALSE", "1", "0", "yes", " true", "false "])(
      `rejects ambiguous ${name}=%j`,
      (value) => {
        expect(() => resolveLangSmithTracingConfig({ [name]: value })).toThrow(
          name
        );
      }
    );

  it.each([
    "http://localhost:1984",
    "ftp://example.invalid",
    "https://key@example.invalid",
    "https://user:password@example.invalid",
    "https://example.invalid?key=secret",
    "https://example.invalid/#fragment",
    " https://example.invalid",
    "https://exam\nple.invalid",
    "invalid",
  ])(
    "rejects unsafe endpoints without echoing their contents: %s",
    (endpoint) => {
      expect(() =>
        resolveLangSmithTracingConfig({ LANGSMITH_ENDPOINT: endpoint })
      ).toThrow("Invalid LANGSMITH_ENDPOINT");
    }
  );

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    "10001",
    " 1000",
    "1000 ",
    "Infinity",
    "NaN",
    "9007199254740992",
  ])("rejects invalid tracing deadline %j", (value) => {
    expect(() =>
      resolveLangSmithTracingConfig({ SCRUB_LANGSMITH_TIMEOUT_MS: value })
    ).toThrow("SCRUB_LANGSMITH_TIMEOUT_MS");
  });

  it.each(["", " ", "x".repeat(201), "project\nname"])(
    "rejects invalid project %j",
    (value) => {
      expect(() =>
        resolveLangSmithTracingConfig({ LANGSMITH_PROJECT: value })
      ).toThrow("LANGSMITH_PROJECT");
    }
  );

  it.each(["x".repeat(201), "workspace id", "workspace\nID"])(
    "rejects invalid workspace selection %j",
    (value) => {
      expect(() =>
        resolveLangSmithTracingConfig({ LANGSMITH_WORKSPACE_ID: value })
      ).toThrow("LANGSMITH_WORKSPACE_ID");
    }
  );
});
