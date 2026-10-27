import { describe, expect, it } from "vitest";
import { resolveRuntimeConcurrency } from "../../src/infrastructure/runtime/config.js";
import { parseJobCommand } from "../../scripts/rivet/job.mjs";
import { execa } from "execa";
import { fileURLToPath } from "node:url";

describe("Shared deployment concurrency policy", () => {
  it("defaults requests to one and runners to two, with the global cap disabled", () => {
    expect(resolveRuntimeConcurrency({})).toEqual({
      requestDefault: 1,
      runnerLimit: 2,
    });
  });

  it("accepts explicit bounds and leaves the supplied environment unchanged", () => {
    const env = Object.freeze({
      SCRUB_REQUEST_CONCURRENCY: "16",
      SCRUB_RUNNER_CONCURRENCY: "64",
      SCRUB_GLOBAL_CONCURRENCY: "1024",
    });
    expect(resolveRuntimeConcurrency(env)).toEqual({
      requestDefault: 16,
      runnerLimit: 64,
      globalLimit: 1024,
    });
    expect(
      resolveRuntimeConcurrency({ SCRUB_GLOBAL_CONCURRENCY: "1" })
    ).toEqual({
      requestDefault: 1,
      runnerLimit: 2,
      globalLimit: 1,
    });
  });

  it("accepts the explicit none sentinel for a disabled image default", () => {
    expect(
      resolveRuntimeConcurrency({ SCRUB_GLOBAL_CONCURRENCY: "none" })
    ).toEqual({ requestDefault: 1, runnerLimit: 2 });
    expect(() =>
      resolveRuntimeConcurrency({ SCRUB_GLOBAL_CONCURRENCY: "NONE" })
    ).toThrow("SCRUB_GLOBAL_CONCURRENCY");
  });

  for (const name of [
    "SCRUB_REQUEST_CONCURRENCY",
    "SCRUB_RUNNER_CONCURRENCY",
    "SCRUB_GLOBAL_CONCURRENCY",
  ]) {
    it.each([
      "",
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "2e1",
      " 2",
      "2 ",
      "two",
      "2_0",
      "9007199254740992",
    ])(`rejects invalid ${name}=%j`, (value) => {
      expect(() => resolveRuntimeConcurrency({ [name]: value })).toThrow(name);
    });
  }
  it.each([
    ["SCRUB_REQUEST_CONCURRENCY", "17"],
    ["SCRUB_RUNNER_CONCURRENCY", "65"],
    ["SCRUB_GLOBAL_CONCURRENCY", "1025"],
  ])("rejects %s above its maximum", (name, value) => {
    expect(() => resolveRuntimeConcurrency({ [name]: value })).toThrow(name);
  });
});

describe("Rivet job CLI concurrency options", () => {
  const url = "https://youtu.be/dQw4w9WgXcQ";
  it("keeps deployment defaults when no request override is supplied", () => {
    expect(parseJobCommand(["submit", url])).toEqual({
      command: "submit",
      value: url,
    });
  });
  it.each([["--concurrency", "4"], ["--concurrency=16"]])(
    "parses an explicit request override: %j",
    (...options) => {
      const args = options.flat();
      expect(parseJobCommand(["submit", url, ...args]).concurrency).toBe(
        args.includes("4") ? 4 : 16
      );
    }
  );
  it.each([
    ["--concurrency"],
    ["--concurrency", "0"],
    ["--concurrency", "17"],
    ["--concurrency", "1.5"],
    ["--concurrency=NaN"],
    ["--concurrency="],
    ["--concurrency", "2", "--concurrency", "3"],
    ["--parallel", "2"],
  ])("rejects invalid submit options %j", (...options) => {
    expect(() => parseJobCommand(["submit", url, ...options.flat()])).toThrow();
  });
  it("rejects request concurrency flags on non-submission commands and invalid result offsets", () => {
    expect(() =>
      parseJobCommand(["status", "request-1", "--concurrency", "2"])
    ).toThrow();
    expect(() => parseJobCommand(["results", "request-1", "1e3"])).toThrow(
      "offset"
    );
    expect(parseJobCommand(["results", "request-1", "20"])).toEqual({
      command: "results",
      value: "request-1",
      offset: 20,
    });
    expect(parseJobCommand(["--help"])).toEqual({ command: "help" });
  });

  it("validates actual CLI options before requiring credentials or loading a gateway", async () => {
    const script = fileURLToPath(
      new URL("../../scripts/rivet/job.mjs", import.meta.url)
    );
    const invalid = await execa(
      process.execPath,
      [script, "submit", url, "--concurrency", "0"],
      { extendEnv: false, env: {}, reject: false }
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("--concurrency");
    expect(invalid.stderr).not.toContain("RIVET_TOKEN");
    const help = await execa(process.execPath, [script, "--help"], {
      extendEnv: false,
      env: {},
      reject: false,
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--concurrency");
  });
});
