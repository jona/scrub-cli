import { execa, type ExecaError } from "execa";
import { join } from "path";
import { TEST_OUTPUT_DIR } from "../e2e/setup.js";

const CLI_PATH = join(process.cwd(), "dist", "deployments", "local", "cli.js");
interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

/**
 * Run the scrub CLI with given arguments
 */
async function runCLI(args: string[]): Promise<CLIResult> {
  try {
    const cliArgs = withTestOutputDir(args);
    const result = await execa("node", [CLI_PATH, ...cliArgs], {
      env: {
        ...process.env,
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

function withTestOutputDir(args: string[]): string[] {
  const [command, target, ...rest] = args;
  if (rest.includes("--output-dir") || rest.includes("-o")) {
    return args;
  }

  return [command, target, "--output-dir", TEST_OUTPUT_DIR, ...rest];
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

  return runCLI(["youtube", url, ...options]);
}
