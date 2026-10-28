import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeDiagnostics } from "../../src/deployments/native-diagnostics.js";
import type { NativeCommandDiagnostic } from "../../src/infrastructure/node/diagnostics.js";
import { NodeMediaProcessor } from "../../src/infrastructure/node/NodeMediaProcessor.js";
import { FilesystemArtifactStorage } from "../../src/infrastructure/node/FilesystemArtifactStorage.js";
import { resolveSettings } from "../../src/application/settings.js";

const event = (stderr: string): NativeCommandDiagnostic => ({
  version: 1,
  event: "native_command_failed",
  tool: "yt-dlp",
  operation: "metadata",
  sourceId: "abcdefghijk",
  timestamp: "2026-10-27T00:00:00.000Z",
  elapsedMs: 100,
  exitCode: 1,
  stderr,
  stderrTruncated: false,
  runId: "request-test/abcdefghijk",
  attemptId: "test-attempt",
});
afterEach(() => vi.unstubAllEnvs());

describe("deployment-owned native diagnostics", () => {
  it("captures a real failing native process through the media adapter with run context and redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scrub-diagnostic-host-"));
    const key = "INHERITED_NATIVE_TEST_CREDENTIAL_SENTINEL";
    vi.stubEnv("SCRUB_DIAGNOSTICS_TEST_SECRET", key);
    const write = vi.fn();
    try {
      const binary = join(directory, "yt-dlp");
      await writeFile(
        binary,
        '#!/usr/bin/env node\nprocess.stderr.write("ERROR: HTTP Error 429: Too Many Requests " + process.env.SCRUB_DIAGNOSTICS_TEST_SECRET + "\\n");process.exit(1);\n',
        { mode: 0o700 }
      );
      const media = new NodeMediaProcessor(
        new FilesystemArtifactStorage(join(directory, "artifacts")),
        {
          stagingRoot: join(directory, "work"),
          ytdlpPath: binary,
          diagnostics: createNativeDiagnostics(
            () => process.env,
            undefined,
            write
          ),
        }
      );
      await expect(
        media.acquire(
          {
            kind: "youtube",
            url: "https://www.youtube.com/watch?v=abcdefghijk",
          },
          resolveSettings(),
          {
            runId: "request-process/abcdefghijk",
            attemptId: "native-attempt",
            signal: new AbortController().signal,
            now: Date.now,
            emit: () => undefined,
          }
        )
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Unable to read source metadata",
        retryable: true,
      });
      expect(write).toHaveBeenCalledOnce();
      expect(write.mock.calls[0][0]).toMatchObject({
        tool: "yt-dlp",
        operation: "metadata",
        sourceId: "abcdefghijk",
        exitCode: 1,
        runId: "request-process/abcdefghijk",
        attemptId: "native-attempt",
      });
      const captured = JSON.stringify(write.mock.calls[0][0]);
      expect(captured).toContain("HTTP Error 429");
      expect(captured).not.toContain(key);
      expect(captured).not.toContain(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts both environment and credential-store/config keys before the log sink", async () => {
    const environment = {
      SERVER_DIAGNOSTICS_TOKEN: "SERVER_ENV_CREDENTIAL_SENTINEL",
      SCRUB_API_TOKEN: "PUBLIC_API_CREDENTIAL_SENTINEL",
      YTDLP_COOKIE: "COOKIE_CREDENTIAL_SENTINEL",
    };
    const configuredKey = "CONFIG_CREDENTIAL_SENTINEL";
    const write = vi.fn();
    const diagnostics = createNativeDiagnostics(
      () => environment,
      () => [configuredKey],
      write
    );
    await diagnostics.emit?.(
      event(
        `ERROR: HTTP Error 429: Too Many Requests\n${Object.values(environment).join(" ")} ${configuredKey}`
      )
    );
    expect(write).toHaveBeenCalledOnce();
    const captured = JSON.stringify(write.mock.calls[0][0]);
    expect(captured).toContain("HTTP Error 429");
    for (const value of [...Object.values(environment), configuredKey])
      expect(captured).not.toContain(value);
    expect(write.mock.calls[0][0]).toMatchObject({
      operation: "metadata",
      exitCode: 1,
      runId: "request-test/abcdefghijk",
    });
  });

  it("refreshes server-owned redactions after credential rotation without serializing the secret source", async () => {
    const environment: Record<string, string | undefined> = {
      OPENAI_API_KEY: "FIRST_ENVIRONMENT_SENTINEL",
    };
    let stored = "FIRST_STORED_SENTINEL";
    const write = vi.fn();
    const diagnostics = createNativeDiagnostics(
      () => environment,
      () => [stored],
      write
    );
    environment.OPENAI_API_KEY = "ROTATED_ENVIRONMENT_SENTINEL";
    stored = "ROTATED_STORED_SENTINEL";
    await diagnostics.emit?.(
      event(`ERROR: connection reset ${environment.OPENAI_API_KEY} ${stored}`)
    );
    const captured = JSON.stringify(write.mock.calls[0][0]);
    expect(captured).toContain("connection reset");
    expect(captured).not.toContain(environment.OPENAI_API_KEY);
    expect(captured).not.toContain(stored);
    expect(captured).not.toContain("redactValues");
    expect(captured).not.toContain("OPENAI_API_KEY");
  });
});
