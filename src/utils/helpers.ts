import { spawn } from "child_process";
import { PipelineError } from "../core/errors.js";

/**
 * Check if a command exists in PATH
 */
export async function commandExists(
  command: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<boolean> {
  try {
    const checkCmd = process.platform === "win32" ? "where" : "which";
    const result = await runCommand(checkCmd, [command], {
      timeoutMs: options?.timeoutMs ?? 5000,
      signal: options?.signal,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Run a command and stream output
 */
export function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutputBytes?: number;
    stdin?: string | Uint8Array;
  }
): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new PipelineError("cancelled", "Processing cancelled"));
      return;
    }
    const maximum = options?.maxOutputBytes ?? 4 * 1024 * 1024;
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      shell: false,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && proc.pid)
          process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch {
        /* The process may already have exited. */
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      forceKill = setTimeout(() => kill("SIGKILL"), 1000);
      forceKill.unref();
    };
    const abort = () =>
      stop(new PipelineError("cancelled", "Processing cancelled"));
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    const timeout = setTimeout(
      () =>
        stop(
          new PipelineError("timeout", "Native operation timed out", {
            retryable: true,
          })
        ),
      options?.timeoutMs ?? 10 * 60 * 1000
    );
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options?.signal?.removeEventListener("abort", abort);
    };
    const collect = (data: Buffer, sink?: (data: string) => void): string => {
      outputBytes += data.byteLength;
      if (outputBytes > maximum) {
        stop(
          new PipelineError(
            "resource_limit",
            "Native diagnostic output exceeds the configured limit"
          )
        );
        return "";
      }
      const value = data.toString();
      try {
        sink?.(value);
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
      return value;
    };

    proc.stdout.on("data", (data) => {
      stdout += collect(data, options?.onStdout);
    });

    proc.stderr.on("data", (data) => {
      stderr += collect(data, options?.onStderr);
    });

    proc.on("close", (code, signal) => {
      cleanup();
      if (failure) reject(failure);
      else if (signal || code === null)
        reject(
          new PipelineError(
            "processing_failed",
            "Native process terminated before completing"
          )
        );
      else resolve({ code, stdout, stderr });
    });

    proc.on("error", (err) => {
      cleanup();
      reject(err);
    });
    proc.stdin.on("error", () => {
      /* Early process exit is handled above. */
    });
    proc.stdin.end(options?.stdin);
  });
}
