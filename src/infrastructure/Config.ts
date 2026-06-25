import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".scrub");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/**
 * Schema for transcription configuration
 */
const TranscriptionConfigSchema = z.object({
  priority: z
    .array(
      z.enum([
        "faster-whisper",
        "local-whisper",
        "openai",
        "deepgram",
        "youtube-captions",
      ])
    )
    .default(["faster-whisper", "local-whisper", "openai", "youtube-captions"]),
  whisperModel: z
    .enum(["tiny", "base", "small", "medium", "large"])
    .default("base"),
  language: z.string().default("en"),
});

/**
 * Schema for frame extraction configuration
 */
const VisualConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sceneThreshold: z.number().min(0).max(1).default(0.4),
  maxFrames: z.number().min(1).max(100).default(20),
});

/**
 * Schema for output configuration
 */
const OutputConfigSchema = z.object({
  directory: z.string().default("~/.scrub/docs"),
  includeFullTranscript: z.boolean().default(false),
});

/**
 * Schema for cache configuration
 */
const CacheConfigSchema = z.object({
  directory: z.string().default(".cache"),
});

/**
 * Schema for local Whisper configuration
 */
const LocalWhisperConfigSchema = z.object({
  binaryPath: z.string().optional(),
  modelsPath: z.string().optional(),
});

/**
 * Schema for API keys configuration
 */
const ApiKeysSchema = z.object({
  openai: z.string().optional(),
  deepgram: z.string().optional(),
});

/**
 * Complete configuration schema
 */
const ConfigSchema = z.object({
  transcription: TranscriptionConfigSchema.default({}),
  visual: VisualConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  cache: CacheConfigSchema.default({}),
  localWhisper: LocalWhisperConfigSchema.default({}),
  apis: ApiKeysSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TranscriptionConfig = z.infer<typeof TranscriptionConfigSchema>;
export type VisualConfig = z.infer<typeof VisualConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;
export type LocalWhisperConfig = z.infer<typeof LocalWhisperConfigSchema>;

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Config = {
  transcription: {
    priority: ["faster-whisper", "local-whisper", "openai", "youtube-captions"],
    whisperModel: "base",
    language: "en",
  },
  visual: {
    enabled: true,
    sceneThreshold: 0.4,
    maxFrames: 20,
  },
  output: {
    directory: "~/.scrub/docs",
    includeFullTranscript: false,
  },
  cache: {
    directory: ".cache",
  },
  localWhisper: {},
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
   * Load configuration from ~/.scrub/config.json
   */
  private loadConfig(): Config {
    let fileConfig: Partial<Config> = {};

    if (existsSync(CONFIG_FILE)) {
      try {
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        fileConfig = JSON.parse(raw);
        this.configPath = CONFIG_FILE;
      } catch {
        // Invalid JSON, fall back to defaults.
      }
    }

    // Deep merge: defaults < user config
    const merged = this.deepMerge(DEFAULT_CONFIG, fileConfig);

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
          typeof value === "object" &&
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
   * Get frame extraction configuration
   */
  getVisual(): VisualConfig {
    return this.config.visual;
  }

  /**
   * Get output configuration
   */
  getOutput(): OutputConfig {
    return this.config.output;
  }

  /**
   * Get cache configuration
   */
  getCache(): CacheConfig {
    return this.config.cache;
  }

  /**
   * Get local Whisper configuration
   */
  getLocalWhisper(): LocalWhisperConfig {
    return this.config.localWhisper;
  }

  /**
   * Get API key for a service
   */
  getApiKey(service: "openai" | "deepgram"): string | undefined {
    return this.config.apis[service];
  }

  /**
   * Get the path to the loaded config file, if any
   */
  getConfigPath(): string | null {
    return this.configPath;
  }

  /**
   * Get the expected user config path
   */
  getDefaultConfigPath(): string {
    return CONFIG_FILE;
  }

  /**
   * Override the output directory at runtime (e.g. from CLI flags)
   */
  setOutputDir(directory: string): void {
    this.config = {
      ...this.config,
      output: { ...this.config.output, directory },
    };
  }

  /**
   * Get cache directory path
   */
  getCacheDir(): string {
    return this.resolvePath(this.config.cache.directory);
  }

  /**
   * Get output directory path
   */
  getOutputDir(): string {
    return this.resolvePath(this.config.output.directory);
  }

  /**
   * Resolve a path, expanding ~ to the user's home directory
   */
  resolvePath(p: string): string {
    if (p.startsWith("~/") || p === "~") {
      return join(homedir(), p.slice(2));
    }
    return resolve(process.cwd(), p);
  }
}

// Export singleton instance
export const config = new ConfigManager();
