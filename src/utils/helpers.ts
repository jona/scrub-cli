import { exec, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { PipelineError } from "../core/errors.js";

export const execAsync = promisify(exec);

/**
 * Extract YouTube video ID from various URL formats
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    // Standard watch URL
    /(?:youtube\.com\/watch\?v=|youtube\.com\/watch\?.+&v=)([^&]+)/,
    // Short URL
    /youtu\.be\/([^?]+)/,
    // Embed URL
    /youtube\.com\/embed\/([^?]+)/,
    // Shorts URL
    /youtube\.com\/shorts\/([^?]+)/,
    // Mobile URL
    /m\.youtube\.com\/watch\?v=([^&]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  // Check if it's already just a video ID (11 characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
    return url;
  }

  return null;
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

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Ensure parent directory exists for a file path
 */
export function ensureParentDir(filePath: string): void {
  ensureDir(dirname(filePath));
}

/**
 * Format seconds to MM:SS or HH:MM:SS
 */
export function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Parse timestamp string to seconds
 */
export function parseTimestamp(timestamp: string): number {
  const parts = timestamp.split(":").map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

/**
 * Sanitize a string for use as a filename
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "") // Remove invalid characters
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Replace multiple hyphens with single
    .replace(/^-|-$/g, "") // Remove leading/trailing hyphens
    .substring(0, 100); // Limit length
}

/**
 * Convert a title to a URL/directory-safe slug
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 100);
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    onError?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    onError,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      onError?.(lastError, attempt);

      if (attempt < maxAttempts) {
        await sleep(delay);
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  }

  throw lastError;
}

/**
 * Chunk an array into smaller arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}
