import { execa, type ExecaError, type Result } from "execa";
import { join } from "path";
import { TEST_OUTPUT_DIR } from "../e2e/setup.js";

const CLI_PATH = join(process.cwd(), "dist", "entrypoints", "cli", "index.js");

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

/**
 * Run the scrub CLI with given arguments
 */
export async function runCLI(args: string[]): Promise<CLIResult> {
  try {
    const result = await execa("node", [CLI_PATH, ...args], {
      env: {
        ...process.env,
        SCRUB_OUTPUT_DIR: TEST_OUTPUT_DIR,
        // Disable colors for easier output parsing
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      reject: false, // Don't throw on non-zero exit
      timeout: 180000, // 3 minute timeout
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      success: result.exitCode === 0,
    };
  } catch (error) {
    const execaError = error as ExecaError;
    return {
      exitCode: execaError.exitCode ?? 1,
      stdout: execaError.stdout ?? "",
      stderr: execaError.stderr ?? "",
      success: false,
    };
  }
}

/**
 * Run scrub on a video URL
 */
export async function scrubVideo(
  videoIdOrUrl: string,
  options: string[] = []
): Promise<CLIResult> {
  const url = videoIdOrUrl.startsWith("http")
    ? videoIdOrUrl
    : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;

  return runCLI([url, ...options]);
}

/**
 * Run scrub on a playlist URL
 */
export async function scrubPlaylist(
  playlistIdOrUrl: string,
  options: string[] = []
): Promise<CLIResult> {
  const url = playlistIdOrUrl.startsWith("http")
    ? playlistIdOrUrl
    : `https://www.youtube.com/playlist?list=${playlistIdOrUrl}`;

  return runCLI([url, ...options]);
}
