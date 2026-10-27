import { spawn } from "child_process";
import { StringDecoder } from "node:string_decoder";
import { PipelineError } from "../core/errors.js";

/** Bounded byte retention; callbacks receive complete, incrementally decoded text. */
class CommandOutput {
  private bytes: Buffer = Buffer.alloc(0);
  private start = 0;
  private size = 0;
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly maximum: number,
    private readonly mode: "complete" | "tail",
    private readonly sink?: (data: string) => void
  ) {}

  write(data: Buffer): void {
    if (!data.byteLength) return;
    if (this.mode === "complete" && this.size + data.byteLength > this.maximum)
      throw new PipelineError(
        "resource_limit",
        "Native stdout exceeds the configured limit"
      );
    const required = Math.min(this.maximum, this.size + data.byteLength);
    if (required > this.bytes.byteLength) {
      const capacity = Math.min(
        this.maximum,
        Math.max(4096, this.bytes.byteLength * 2, required)
      );
      const expanded = Buffer.allocUnsafe(capacity);
      this.copyInto(expanded);
      this.bytes = expanded;
      this.start = 0;
    }
    // A byte ring avoids retaining whole incoming buffers or one allocation per
    // tiny write. Both retained bytes and bookkeeping remain bounded.
    const incoming = data.subarray(-Math.min(data.byteLength, this.maximum));
    const discard = Math.max(0, this.size + incoming.byteLength - this.maximum);
    if (data.byteLength >= this.maximum) {
      this.start = 0;
      this.size = 0;
    } else {
      this.start = (this.start + discard) % this.bytes.byteLength;
      this.size -= discard;
    }
    const offset = (this.start + this.size) % this.bytes.byteLength;
    const first = Math.min(incoming.byteLength, this.bytes.byteLength - offset);
    incoming.copy(this.bytes, offset, 0, first);
    incoming.copy(this.bytes, 0, first);
    this.size += incoming.byteLength;
    const text = this.decoder.write(data);
    if (text) this.sink?.(text);
  }

  private copyInto(target: Buffer): void {
    const first = Math.min(this.size, this.bytes.byteLength - this.start);
    this.bytes.copy(target, 0, this.start, this.start + first);
    this.bytes.copy(target, first, 0, this.size - first);
  }

  finish(): string {
    const final = this.decoder.end();
    if (final) this.sink?.(final);
    const bytes = Buffer.allocUnsafe(this.size);
    this.copyInto(bytes);
    let start = 0;
    if (this.mode === "tail")
      while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80)
        start++;
    return bytes.subarray(start).toString("utf8");
  }
}

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
 * Structured stdout is complete or fails closed. Diagnostic output retains only
 * a bounded tail while callbacks stream all text; noisy progress never overflows
 * the retained stderr buffer. Artifact-producing commands opt into stdout tail.
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
    /** Maximum retained stdout bytes; complete stdout rejects an overflow. */
    maxOutputBytes?: number;
    stdoutMode?: "complete" | "tail";
    /** Maximum retained stderr bytes, independent of structured stdout. */
    maxDiagnosticBytes?: number;
    stdin?: string | Uint8Array;
  }
): Promise<{ code: number; stdout: string; stderr: string; signal?: string }> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new PipelineError("cancelled", "Processing cancelled"));
      return;
    }
    const maximum = options?.maxOutputBytes ?? 4 * 1024 * 1024;
    const diagnosticMaximum = options?.maxDiagnosticBytes ?? 64 * 1024;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      !Number.isSafeInteger(diagnosticMaximum) ||
      diagnosticMaximum < 1 ||
      (options?.stdoutMode !== undefined &&
        options.stdoutMode !== "complete" &&
        options.stdoutMode !== "tail")
    ) {
      reject(
        new PipelineError("invalid_input", "Invalid native output limits")
      );
      return;
    }
    const stdout = new CommandOutput(
      maximum,
      options?.stdoutMode ?? "complete",
      options?.onStdout
    );
    const stderr = new CommandOutput(
      diagnosticMaximum,
      "tail",
      options?.onStderr
    );
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      shell: false,
      detached: process.platform !== "win32",
    });
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
    const collect = (data: Buffer, output: CommandOutput): void => {
      if (failure) return;
      try {
        output.write(data);
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    };

    proc.stdout.on("data", (data) => {
      collect(data, stdout);
    });

    proc.stderr.on("data", (data) => {
      collect(data, stderr);
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
      else {
        try {
          resolve({ code, stdout: stdout.finish(), stderr: stderr.finish() });
        } catch (error) {
          reject(error);
        }
      }
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
