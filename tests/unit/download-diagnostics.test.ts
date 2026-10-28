import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchYouTubeMetadata,
  download,
} from "../../src/infrastructure/node/download.js";
import {
  emitNativeCommandDiagnostic,
  flushNativeCommandDiagnostics,
  queueNativeCommandDiagnostic,
  sanitizeNativeCommandDiagnostic,
  type NativeCommandDiagnostic,
} from "../../src/infrastructure/node/diagnostics.js";
import { runCommand } from "../../src/utils/helpers.js";
import {
  PipelineError,
  serializePipelineError,
} from "../../src/core/errors.js";
import * as staging from "../../src/infrastructure/node/staging.js";
import { NodeMediaProcessor } from "../../src/infrastructure/node/NodeMediaProcessor.js";
import { MemoryArtifactStorage } from "../helpers/memory/ArtifactStorage.js";
import { resolveSettings } from "../../src/application/settings.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const sourceId = "dQw4w9WgXcQ";
const url = `https://youtu.be/${sourceId}`;
const metadata = {
  contentId: sourceId,
  title: "Fixture",
  description: "",
  duration: 1,
  thumbnailUrl: "",
  source: "Fixture",
  uploadDate: "",
  url,
};
const event = (
  stderr = "ERROR: source unavailable"
): NativeCommandDiagnostic => ({
  version: 1,
  event: "native_command_failed",
  tool: "yt-dlp",
  operation: "metadata",
  sourceId,
  timestamp: "2026-10-27T00:00:00.000Z",
  elapsedMs: 23,
  stderr,
  stderrTruncated: false,
});

describe("private native command diagnostics", () => {
  it("redacts known raw/escaped credentials, provider tokens, headers and URL credentials/query values", () => {
    const known = 'private-key-"quoted\\value';
    const raw = [
      known,
      JSON.stringify(known).slice(1, -1),
      encodeURIComponent(known),
      "sk-testprovidercredentials123456789",
      "lsv2_testtracingcredentials123456789",
      "admin_1234567890abcdef1234567890abcdef",
      "Authorization: Bearer unknown-auth-value",
      "Cookie: session=private-cookie-value; foo=bar",
      "https://private-user:private-password@example.invalid/error?public=private-query-value&token=private-token-value#private-fragment",
      "\u001b[31mERROR: useful failure\u001b[0m\u0000\u202e",
    ].join("\n");
    const sanitized = sanitizeNativeCommandDiagnostic(
      {
        ...event(raw),
        runId: known,
        attemptId: known,
        stdout: "PRIVATE_STDOUT",
        args: [known],
        env: { key: known },
      },
      [known]
    )!;
    const serialized = JSON.stringify(sanitized);
    for (const value of [
      known,
      JSON.stringify(known).slice(1, -1),
      encodeURIComponent(known),
      "testprovidercredentials",
      "testtracingcredentials",
      "1234567890abcdef",
      "unknown-auth-value",
      "private-cookie-value",
      "private-user",
      "private-password",
      "private-query-value",
      "private-token-value",
      "private-fragment",
      "PRIVATE_STDOUT",
    ])
      expect(serialized).not.toContain(value);
    expect(sanitized.stderr).toContain("ERROR: useful failure");
    expect(sanitized.stderr).not.toMatch(/[\u001b\u0000\u202e]/);
    expect(sanitized).not.toHaveProperty("args");
    expect(sanitized).not.toHaveProperty("env");
  });

  it("redacts before UTF8/JSON byte bounds without retaining a secret prefix at the cut", () => {
    const key = "BOUNDARY_PRIVATE_CREDENTIAL_SENTINEL";
    const sanitized = sanitizeNativeCommandDiagnostic(
      event('"'.repeat(8150) + key + "😀".repeat(1000)),
      [key]
    )!;
    expect(sanitized.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(sanitized.stderr)).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(sanitized))).toBeLessThanOrEqual(
      12288
    );
    expect(sanitized.stderr).not.toContain("BOUNDARY_PRIVATE");
    expect(sanitized.stderr).not.toContain("�");
    expect(
      sanitizeNativeCommandDiagnostic({ ...event(), sourceId: "../unsafe" })
    ).toBeNull();
    expect(
      sanitizeNativeCommandDiagnostic({ ...event(), errorCode: key })
    ).not.toHaveProperty("errorCode");
  });

  it("drops the partial first stderr line when bounded capture starts inside a credential", async () => {
    const key = "TRUNCATED_PRIVATE_CREDENTIAL_SENTINEL";
    const emit = vi.fn();
    const raw = "x".repeat(64 * 1024) + key + "\nERROR: retained useful line\n";
    await expect(
      fetchYouTubeMetadata(url, {
        runtime: {
          stagingRoot: "/tmp/unused",
          diagnostics: { emit, redactValues: () => [key] },
          runCommand: async (_command, _args, options) => {
            options?.onStderr?.(raw);
            return { code: 2, stdout: "", stderr: raw.slice(-32) };
          },
        },
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        stderrTruncated: true,
        stderr: "[earlier stderr truncated]\nERROR: retained useful line\n",
      })
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain(
      "CREDENTIAL_SENTINEL"
    );
  });

  it.each(["progress", "JSON-heavy"])(
    "retains the terminal HTTP/bot reason after redacting and truncating %s diagnostics",
    (kind) => {
      const key = "CUT_BOUNDARY_PRIVATE_CREDENTIAL_SENTINEL";
      const reason =
        "ERROR: HTTP Error 403: Forbidden; Sign in to confirm you are not a bot.\n";
      const progress =
        kind === "progress"
          ? "WARNING: retrying source\n".repeat(1500)
          : '"'.repeat(20000);
      const raw =
        progress +
        key +
        "😀".repeat(500) +
        `\nhttps://private-user:private-password@example.invalid/?signature=${key}\n` +
        reason;
      const sanitized = sanitizeNativeCommandDiagnostic(event(raw), [key])!;
      expect(sanitized.stderr.startsWith("[earlier stderr truncated]\n")).toBe(
        true
      );
      expect(sanitized.stderr.endsWith(reason)).toBe(true);
      expect(sanitized.stderr).not.toContain("CUT_BOUNDARY_PRIVATE");
      expect(sanitized.stderr).not.toContain("private-password");
      expect(sanitized.stderr).not.toContain("�");
      expect(Buffer.byteLength(sanitized.stderr)).toBeLessThanOrEqual(8192);
      expect(Buffer.byteLength(JSON.stringify(sanitized))).toBeLessThanOrEqual(
        12288
      );
      expect(sanitizeNativeCommandDiagnostic(sanitized, [key])).toEqual(
        sanitized
      );
    }
  );

  it.each(["metadata", "audio", "video"] as const)(
    "preserves an original output-limit exception during %s and never logs its message",
    async (operation) => {
      const original = new PipelineError(
        "resource_limit",
        "PRIVATE_ORIGINAL_ERROR"
      );
      const emit = vi.fn();
      const runtime = {
        stagingRoot: "/tmp/unused",
        diagnostics: { emit },
        runCommand: vi.fn<typeof runCommand>(async (_command, args) => {
          if (operation === "video" && args.includes("-x"))
            return { code: 0, stdout: "", stderr: "" };
          throw original;
        }),
      };
      const pending =
        operation === "metadata"
          ? fetchYouTubeMetadata(url, { runtime })
          : download(url, {
              runtime,
              metadata,
              outputDir: runtime.stagingRoot,
            });
      await expect(pending).rejects.toBe(original);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ operation, errorCode: "output_limit" })
      );
      expect(JSON.stringify(emit.mock.calls)).not.toContain(original.message);
    }
  );

  it.each(["metadata", "audio", "video"] as const)(
    "records %s nonzero failure without changing its existing outcome",
    async (operation) => {
      const events: NativeCommandDiagnostic[] = [];
      const runtime = {
        stagingRoot: "/tmp/unused-diagnostic-fixture",
        runCommand: vi.fn<typeof runCommand>(
          async (_command, args, options) => {
            if (operation === "video" && args.includes("-x"))
              return { code: 0, stdout: "", stderr: "" };
            options?.onStderr?.("ERROR: failed safely");
            return {
              code: 7,
              stdout: "PRIVATE_STDOUT",
              stderr: "ERROR: failed safely",
            };
          }
        ),
        diagnostics: {
          emit: (value: NativeCommandDiagnostic) => {
            events.push(value);
          },
        },
      };
      if (operation === "metadata")
        await expect(
          fetchYouTubeMetadata(url, { runtime })
        ).rejects.toMatchObject({
          code: "unavailable",
          retryable: true,
          cause: "ERROR: failed safely",
        });
      else if (operation === "audio")
        await expect(
          download(url, { runtime, metadata, outputDir: runtime.stagingRoot })
        ).rejects.toMatchObject({
          code: "processing_failed",
          retryable: true,
          cause: "ERROR: failed safely",
        });
      else
        expect(
          await download(url, {
            runtime,
            metadata,
            outputDir: runtime.stagingRoot,
          })
        ).toMatchObject({ videoPath: "" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        operation,
        sourceId,
        exitCode: 7,
        errorCode: "nonzero_exit",
        stderr: "ERROR: failed safely",
      });
      expect(JSON.stringify(events)).not.toContain("PRIVATE_STDOUT");
    }
  );

  it.each(["invalid", '{"duration":null}'])(
    "diagnoses invalid metadata while retaining parser/duration failure: %s",
    async (stdout) => {
      const emit = vi.fn();
      const pending = fetchYouTubeMetadata(url, {
        runtime: {
          stagingRoot: "/tmp/unused",
          diagnostics: { emit },
          runCommand: async () => ({
            code: 0,
            stdout,
            stderr: "safe tool diagnostic",
          }),
        },
      });
      if (stdout === "invalid")
        await expect(pending).rejects.toMatchObject({
          code: "processing_failed",
          message: "Unable to parse source metadata",
          retryable: false,
          cause: expect.any(SyntaxError),
        });
      else
        await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode:
            stdout === "invalid" ? "invalid_metadata" : "invalid_duration",
          exitCode: 0,
        })
      );
    }
  );

  it("captures actual stderr and termination signal for a timed-out local process", async () => {
    const emit = vi.fn();
    await expect(
      fetchYouTubeMetadata(url, {
        timeoutMs: 1000,
        runtime: {
          stagingRoot: "/tmp/unused",
          diagnostics: { emit },
          runCommand: (_command, _args, options) =>
            runCommand(
              process.execPath,
              [
                "-e",
                "process.stderr.write('ERROR: deadline fixture\\n');setInterval(()=>{},1000)",
              ],
              options
            ),
        },
      })
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "metadata",
        errorCode: "timeout",
        signal: "SIGTERM",
        stderr: expect.stringContaining("deadline fixture"),
      })
    );
  });

  it("preserves exception identity when a diagnostic sink throws or remains pending", async () => {
    vi.useFakeTimers();
    const original = new PipelineError("cancelled", "Original cancellation");
    const emit = vi.fn(() => new Promise<void>(() => {}));
    const pending = fetchYouTubeMetadata(url, {
      runtime: {
        stagingRoot: "/tmp/unused",
        diagnostics: { emit },
        runCommand: async () => {
          throw original;
        },
      },
    });
    const rejected = expect(pending).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(2001);
    await rejected;
    emit.mockImplementation(() => {
      throw new Error("Private sink error");
    });
    await expect(
      fetchYouTubeMetadata(url, {
        runtime: {
          stagingRoot: "/tmp/unused",
          diagnostics: { emit },
          runCommand: async () => {
            throw original;
          },
        },
      })
    ).rejects.toBe(original);
  });

  it("propagates nonretryable metadata failure before its native deadline while queued diagnostics remain pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(staging, "inWorkspace").mockImplementation(
      async (_root, _context, work) => work("/tmp/unused")
    );
    const emit = vi.fn(() => new Promise<void>(() => {}));
    const diagnostics = { emit };
    const media = new NodeMediaProcessor(new MemoryArtifactStorage(), {
      stagingRoot: "/tmp/unused",
      diagnostics,
      runCommand: async () => ({
        code: 0,
        stdout: "private malformed metadata",
        stderr: "safe diagnostic",
      }),
    });
    const settings = resolveSettings({ limits: { stageTimeoutMs: 50 } });
    let failure: unknown;
    const processing = media
      .acquire({ kind: "youtube", url }, settings, {
        runId: "opaque-run",
        attemptId: "opaque-attempt",
        signal: new AbortController().signal,
        now: Date.now,
        emit: () => undefined,
      })
      .catch((error) => {
        failure = error;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(failure).toMatchObject({
      code: "processing_failed",
      retryable: false,
      message: "Unable to parse source metadata",
    });
    await processing;
    expect(emit).toHaveBeenCalledOnce();
    let drained = false;
    const flush = flushNativeCommandDiagnostics(diagnostics).then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(drained).toBe(false);
    expect(failure).toMatchObject({
      code: "processing_failed",
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(1940);
    await flush;
    expect(drained).toBe(true);
  });

  it("keeps malformed JSON stdout and its credential preview out of the public failure", async () => {
    const credential = "FAKE_CREDENTIAL_JSON_STDOUT_SENTINEL";
    const failure = await fetchYouTubeMetadata(url, {
      runtime: {
        stagingRoot: "/tmp/unused",
        runCommand: async () => ({ code: 0, stdout: credential, stderr: "" }),
      },
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(PipelineError);
    expect(failure.cause).toBeInstanceOf(SyntaxError);
    expect(serializePipelineError(failure)).toEqual({
      code: "processing_failed",
      message: "Unable to parse source metadata",
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain("CREDENTIAL");
    expect(JSON.stringify(serializePipelineError(failure))).not.toContain(
      "STDOUT"
    );
  });

  it("isolates host drains by diagnostic sink identity", async () => {
    vi.useFakeTimers();
    const slow = { emit: () => new Promise<void>(() => {}) };
    const other = { emit: vi.fn() };
    queueNativeCommandDiagnostic(event(), slow);
    queueNativeCommandDiagnostic(event(), other);
    await flushNativeCommandDiagnostics(other);
    expect(other.emit).toHaveBeenCalledOnce();
    let drained = false;
    const pending = flushNativeCommandDiagnostics(slow).then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(drained).toBe(true);
  });

  it("drops diagnostics if the redaction provider fails and safely falls back to logger.warn", async () => {
    const emit = vi.fn();
    await emitNativeCommandDiagnostic(event(), {
      emit,
      redactValues: () => {
        throw new Error("private provider failure");
      },
    });
    expect(emit).not.toHaveBeenCalled();
    const warn = vi.fn(() => {
      throw new Error("private logger failure");
    });
    await expect(
      emitNativeCommandDiagnostic(event(), undefined, { warn })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps optional video fallback successful even when the warning logger fails", async () => {
    const warn = vi.fn(() => {
      throw new Error("private logger outage");
    });
    expect(
      await download(url, {
        metadata,
        outputDir: "/tmp/unused",
        runtime: {
          stagingRoot: "/tmp/unused",
          logger: { warn, debug() {}, info() {} },
          runCommand: async (_command, args) => ({
            code: args.includes("-x") ? 0 : 1,
            stdout: "",
            stderr: "video unavailable",
          }),
        },
      })
    ).toMatchObject({ videoPath: "" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("forwards operation correlation from NodeMediaProcessor without logging source stdout", async () => {
    const emit = vi.fn();
    const media = new NodeMediaProcessor(new MemoryArtifactStorage(), {
      stagingRoot: "/tmp/scrub-native-diagnostic-fixture",
      diagnostics: { emit },
      runCommand: async () => ({
        code: 1,
        stdout: "PRIVATE_STDOUT",
        stderr: "source is unavailable",
      }),
    });
    await expect(
      media.acquire({ kind: "youtube", url }, resolveSettings(), {
        runId: "opaque-run",
        attemptId: "opaque-attempt",
        signal: new AbortController().signal,
        now: Date.now,
        emit: () => undefined,
      })
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "opaque-run",
        attemptId: "opaque-attempt",
      })
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE_STDOUT");
  });
});
