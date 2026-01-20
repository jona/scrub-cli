import chalk from 'chalk';
import ora, { Ora } from 'ora';

/**
 * Log levels for the application
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger configuration
 */
interface LoggerConfig {
  verbose: boolean;
  silent: boolean;
}

/**
 * Logger class for CLI feedback
 */
class Logger {
  private config: LoggerConfig = {
    verbose: false,
    silent: false,
  };

  private spinner: Ora | null = null;

  /**
   * Configure the logger
   */
  configure(options: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...options };
  }

  /**
   * Set verbose mode
   */
  setVerbose(verbose: boolean): void {
    this.config.verbose = verbose;
  }

  /**
   * Set silent mode (no output)
   */
  setSilent(silent: boolean): void {
    this.config.silent = silent;
  }

  /**
   * Log debug message (only in verbose mode)
   */
  debug(message: string, ...args: unknown[]): void {
    if (this.config.silent || !this.config.verbose) return;
    this.pauseSpinner();
    console.log(chalk.gray(`[DEBUG] ${message}`), ...args);
    this.resumeSpinner();
  }

  /**
   * Log info message
   */
  info(message: string, ...args: unknown[]): void {
    if (this.config.silent) return;
    this.pauseSpinner();
    console.log(chalk.blue('ℹ'), message, ...args);
    this.resumeSpinner();
  }

  /**
   * Log success message
   */
  success(message: string, ...args: unknown[]): void {
    if (this.config.silent) return;
    this.pauseSpinner();
    console.log(chalk.green('✓'), message, ...args);
    this.resumeSpinner();
  }

  /**
   * Log warning message
   */
  warn(message: string, ...args: unknown[]): void {
    if (this.config.silent) return;
    this.pauseSpinner();
    console.log(chalk.yellow('⚠'), message, ...args);
    this.resumeSpinner();
  }

  /**
   * Log error message
   */
  error(message: string, ...args: unknown[]): void {
    if (this.config.silent) return;
    this.pauseSpinner();
    console.error(chalk.red('✖'), message, ...args);
    this.resumeSpinner();
  }

  /**
   * Log a step in the process
   */
  step(step: number, total: number, message: string): void {
    if (this.config.silent) return;
    this.pauseSpinner();
    console.log(
      chalk.cyan(`[${step}/${total}]`),
      message
    );
    this.resumeSpinner();
  }

  /**
   * Start a spinner with a message
   */
  startSpinner(message: string): void {
    if (this.config.silent) return;
    this.spinner = ora({
      text: message,
      color: 'cyan',
    }).start();
  }

  /**
   * Update spinner text
   */
  updateSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.text = message;
    }
  }

  /**
   * Stop spinner with success
   */
  stopSpinnerSuccess(message: string): void {
    if (this.spinner) {
      this.spinner.succeed(message);
      this.spinner = null;
    }
  }

  /**
   * Stop spinner with failure
   */
  stopSpinnerFail(message: string): void {
    if (this.spinner) {
      this.spinner.fail(message);
      this.spinner = null;
    }
  }

  /**
   * Stop spinner with warning
   */
  stopSpinnerWarn(message: string): void {
    if (this.spinner) {
      this.spinner.warn(message);
      this.spinner = null;
    }
  }

  /**
   * Stop spinner without status change
   */
  stopSpinner(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  /**
   * Pause spinner for logging
   */
  private pauseSpinner(): void {
    if (this.spinner?.isSpinning) {
      this.spinner.stop();
    }
  }

  /**
   * Resume spinner after logging
   */
  private resumeSpinner(): void {
    if (this.spinner && !this.spinner.isSpinning) {
      this.spinner.start();
    }
  }

  /**
   * Print a blank line
   */
  newline(): void {
    if (this.config.silent) return;
    console.log();
  }

  /**
   * Print a divider line
   */
  divider(): void {
    if (this.config.silent) return;
    console.log(chalk.gray('─'.repeat(50)));
  }

  /**
   * Print formatted key-value pair
   */
  keyValue(key: string, value: string | number): void {
    if (this.config.silent) return;
    console.log(`  ${chalk.gray(key + ':')} ${value}`);
  }

  /**
   * Print a header
   */
  header(text: string): void {
    if (this.config.silent) return;
    console.log();
    console.log(chalk.bold.cyan(text));
    console.log(chalk.gray('─'.repeat(text.length)));
  }

  /**
   * Print the app banner
   */
  banner(): void {
    if (this.config.silent) return;
    console.log();
    console.log(chalk.bold.cyan('  🎬 Watcher'));
    console.log(chalk.gray('  YouTube Video → Markdown Summarizer'));
    console.log();
  }
}

// Export singleton instance
export const logger = new Logger();

// Export formatting utilities
export const fmt = {
  bold: chalk.bold,
  dim: chalk.dim,
  cyan: chalk.cyan,
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  gray: chalk.gray,
  url: chalk.underline.blue,
  path: chalk.yellow,
  time: (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  },
  duration: (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  },
  fileSize: (bytes: number): string => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  },
};
