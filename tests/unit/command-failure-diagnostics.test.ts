import { describe, expect, it } from "vitest";
import {
  getCommandFailureDiagnostics,
  runCommand,
} from "../../src/utils/helpers.js";

describe("private native command failure diagnostics", () => {
  it("retains actual timeout signal and stderr without changing the public error", async () => {
    const secret = "TEST_ONLY_DIAGNOSTIC_SECRET";
    const error = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stderr.write(process.argv[1]);setInterval(()=>{},1000)",
        secret,
      ],
      { timeoutMs: 500 }
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "timeout",
      retryable: true,
      message: "Native operation timed out",
    });
    expect(getCommandFailureDiagnostics(error)).toEqual({
      signal: "SIGTERM",
      stderr: secret,
      stderrTruncated: false,
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(Object.getOwnPropertyNames(error)).not.toContain("stderr");
  });

  it("preserves an original sink error and exposes only an immutable explicit snapshot", async () => {
    const original = new Error("Diagnostic sink rejected output");
    const propertyNames = Object.getOwnPropertyNames(original);
    const secret = "TEST_ONLY_PRIVATE_STDERR";
    const error = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stderr.write(process.argv[1]);setInterval(()=>{},1000)",
        secret,
      ],
      {
        onStderr: () => {
          throw original;
        },
      }
    ).catch((error: unknown) => error);
    expect(error).toBe(original);
    expect(Object.getOwnPropertyNames(original)).toEqual(propertyNames);
    expect(JSON.stringify(original)).toBe("{}");
    const details = getCommandFailureDiagnostics(original)!;
    expect(details).toMatchObject({ stderr: secret, signal: "SIGTERM" });
    expect(Object.isFrozen(details)).toBe(true);
    expect(() => Object.assign(details, { stderr: "changed" })).toThrow();
    expect(getCommandFailureDiagnostics(original)?.stderr).toBe(secret);
    expect(getCommandFailureDiagnostics(original)).not.toBe(details);
  });

  it("records a genuine process termination signal instead of inventing an exit code", async () => {
    const error = await runCommand(process.execPath, [
      "-e",
      "process.stderr.write('before termination',()=>process.kill(process.pid,'SIGTERM'))",
    ]).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "processing_failed" });
    expect(getCommandFailureDiagnostics(error)).toEqual({
      signal: "SIGTERM",
      stderr: "before termination",
      stderrTruncated: false,
    });
  });

  it("captures bounded UTF-8 stderr tails on cancellation and preserves the cancelled error", async () => {
    const controller = new AbortController();
    const error = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stderr.write('😀'.repeat(1000)+'TAIL');setInterval(()=>{},1000)",
      ],
      {
        signal: controller.signal,
        maxDiagnosticBytes: 97,
        onStderr: (text) => {
          if (text.includes("TAIL")) controller.abort();
        },
      }
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "cancelled", retryable: false });
    const details = getCommandFailureDiagnostics(error)!;
    expect(details.signal).toBe("SIGTERM");
    expect(details.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(details.stderr)).toBeLessThanOrEqual(97);
    expect(details.stderr.endsWith("TAIL")).toBe(true);
    expect(details.stderr).not.toContain("�");
  });

  it("keeps stdout-limit failure classification and never retains stdout in diagnostics", async () => {
    const error = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stderr.write('prior diagnostic');setTimeout(()=>{process.stdout.write('PRIVATE_STDOUT'.repeat(100));setInterval(()=>{},1000)},50)",
      ],
      { maxOutputBytes: 16 }
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "resource_limit" });
    const details = getCommandFailureDiagnostics(error)!;
    expect(details.stderr).toBe("prior diagnostic");
    expect(details.signal).toBe("SIGTERM");
    expect(JSON.stringify(details)).not.toContain("PRIVATE_STDOUT");
    expect(details).not.toHaveProperty("stdout");
  });

  it("retains spawn errors without guessed code or signal and leaves normal nonzero results alone", async () => {
    const error = await runCommand(
      "/__scrub_missing_native_tool__/yt-dlp",
      []
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "ENOENT" });
    expect(getCommandFailureDiagnostics(error)).toEqual({
      stderr: "",
      stderrTruncated: false,
    });
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stderr.write('nonzero diagnostic');process.exitCode=7",
    ]);
    expect(result).toEqual({
      code: 7,
      stdout: "",
      stderr: "nonzero diagnostic",
    });
    expect(getCommandFailureDiagnostics(result)).toBeUndefined();
    for (const value of [
      undefined,
      null,
      "error",
      4,
      {},
      new Error("unrelated"),
    ])
      expect(getCommandFailureDiagnostics(value)).toBeUndefined();
  });
});
