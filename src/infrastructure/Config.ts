import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Schema for transcription configuration
 */
const TranscriptionConfigSchema = z.object({
  priority: z
    .array(
      z.enum([
        'local-whisper',
        'faster-whisper',
        'openai',
        'deepgram',
        'youtube-captions',
      ])
    )
    .default([
      'local-whisper',
      'faster-whisper',
      'openai',
      'youtube-captions',
    ]),
  whisperModel: z
    .enum(['tiny', 'base', 'small', 'medium', 'large'])
    .default('base'),
  language: z.string().default('en'),
});

/**
 * Schema for visual analysis configuration
 */
const VisualConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sceneThreshold: z.number().min(0).max(1).default(0.4),
  maxFrames: z.number().min(1).max(100).default(20),
  model: z.string().default('claude-sonnet-4-20250514'),
});

/**
 * Schema for summarizer configuration
 */
const SummarizerConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-20250514'),
});

/**
 * Schema for output configuration
 */
const OutputConfigSchema = z.object({
  directory: z.string().default('./output'),
  includeFullTranscript: z.boolean().default(false),
});

/**
 * Schema for API keys configuration
 */
const ApiKeysSchema = z.object({
  anthropic: z.string().optional(),
  openai: z.string().optional(),
  deepgram: z.string().optional(),
});

/**
 * Complete configuration schema
 */
const ConfigSchema = z.object({
  transcription: TranscriptionConfigSchema.default({}),
  visual: VisualConfigSchema.default({}),
  summarizer: SummarizerConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  apis: ApiKeysSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TranscriptionConfig = z.infer<typeof TranscriptionConfigSchema>;
export type VisualConfig = z.infer<typeof VisualConfigSchema>;
export type SummarizerConfig = z.infer<typeof SummarizerConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Config = {
  transcription: {
    priority: [
      'local-whisper',
      'faster-whisper',
      'openai',
      'youtube-captions',
    ],
    whisperModel: 'base',
    language: 'en',
  },
  visual: {
    enabled: true,
    sceneThreshold: 0.4,
    maxFrames: 20,
    model: 'claude-sonnet-4-20250514',
  },
  summarizer: {
    model: 'claude-sonnet-4-20250514',
  },
  output: {
    directory: './output',
    includeFullTranscript: false,
  },
  apis: {},
};

/**
 * Configuration manager singleton
 */
class ConfigManager {
  private config: Config;
  private configPath: string | null = null;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Load configuration from file and environment
   */
  private loadConfig(): Config {
    let fileConfig: Partial<Config> = {};

    // Try to load from scrub.config.json
    const configPaths = [
      resolve(process.cwd(), 'scrub.config.json'),
      resolve(process.cwd(), '.scrubrc.json'),
    ];

    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        try {
          const raw = readFileSync(configPath, 'utf-8');
          fileConfig = JSON.parse(raw);
          this.configPath = configPath;
          break;
        } catch {
          // Invalid JSON, continue
        }
      }
    }

    // Merge with environment variables for API keys
    const envConfig: Partial<Config> = {
      apis: {
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        deepgram: process.env.DEEPGRAM_API_KEY,
      },
    };

    // Override output directory from env if set
    if (process.env.SCRUB_OUTPUT_DIR) {
      envConfig.output = {
        directory: process.env.SCRUB_OUTPUT_DIR,
        includeFullTranscript: fileConfig.output?.includeFullTranscript ?? false,
      };
    }

    // Deep merge: defaults < file config < env config
    const merged = this.deepMerge(
      DEFAULT_CONFIG,
      fileConfig,
      envConfig
    );

    // Validate and return
    return ConfigSchema.parse(merged);
  }

  /**
   * Deep merge multiple objects
   */
  private deepMerge(...objects: Partial<Config>[]): Partial<Config> {
    const result: Record<string, unknown> = {};

    for (const obj of objects) {
      for (const key of Object.keys(obj)) {
        const value = (obj as Record<string, unknown>)[key];
        if (
          value !== undefined &&
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          result[key] = this.deepMerge(
            (result[key] as Partial<Config>) || {},
            value as Partial<Config>
          );
        } else if (value !== undefined) {
          result[key] = value;
        }
      }
    }

    return result as Partial<Config>;
  }

  /**
   * Get the current configuration
   */
  get(): Config {
    return this.config;
  }

  /**
   * Get transcription configuration
   */
  getTranscription(): TranscriptionConfig {
    return this.config.transcription;
  }

  /**
   * Get visual analysis configuration
   */
  getVisual(): VisualConfig {
    return this.config.visual;
  }

  /**
   * Get summarizer configuration
   */
  getSummarizer(): SummarizerConfig {
    return this.config.summarizer;
  }

  /**
   * Get output configuration
   */
  getOutput(): OutputConfig {
    return this.config.output;
  }

  /**
   * Get API key for a service
   */
  getApiKey(service: 'anthropic' | 'openai' | 'deepgram'): string | undefined {
    return this.config.apis[service];
  }

  /**
   * Check if Anthropic API key is configured
   */
  hasAnthropicKey(): boolean {
    return !!this.config.apis.anthropic;
  }

  /**
   * Get the path to the loaded config file, if any
   */
  getConfigPath(): string | null {
    return this.configPath;
  }

  /**
   * Get cache directory path
   */
  getCacheDir(): string {
    return process.env.SCRUB_CACHE_DIR || resolve(process.cwd(), 'cache');
  }

  /**
   * Get output directory path
   */
  getOutputDir(): string {
    return resolve(process.cwd(), this.config.output.directory);
  }
}

// Export singleton instance
export const config = new ConfigManager();
