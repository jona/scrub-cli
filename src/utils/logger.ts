import chalk from "chalk";

/** CLI feedback; native workers receive their own logger through runtime options. */
class Logger {
  private verbose = false;

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.verbose) console.log(chalk.gray(`[DEBUG] ${message}`), ...args);
  }

  info(message: string, ...args: unknown[]): void {
    console.log(chalk.blue("ℹ"), message, ...args);
  }

  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green("✓"), message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.log(chalk.yellow("⚠"), message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(chalk.red("✖"), message, ...args);
  }

  newline(): void {
    console.log();
  }

  keyValue(key: string, value: string | number): void {
    console.log(`  ${chalk.gray(key + ":")} ${value}`);
  }

  header(text: string): void {
    console.log();
    console.log(chalk.bold.cyan(text));
    console.log(chalk.gray("─".repeat(text.length)));
  }

  banner(): void {
    console.log();
    console.log(chalk.bold.cyan("  🎬 Scrub"));
    console.log(chalk.gray("  YouTube Video → Markdown Summarizer"));
    console.log();
  }
}

export const logger = new Logger();

export const fmt = {
  bold: chalk.bold,
  dim: chalk.dim,
  green: chalk.green,
  red: chalk.red,
  path: chalk.yellow,
};
