import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { config } from '../core/Config.js';

/**
 * Simple file-based cache for transcripts and other data
 */
export class Cache {
  private cacheDir: string;

  constructor(subDir?: string) {
    this.cacheDir = subDir
      ? join(config.getCacheDir(), subDir)
      : config.getCacheDir();
  }

  /**
   * Get a cached value
   */
  get<T>(key: string): T | null {
    const path = this.getPath(key);
    if (!existsSync(path)) {
      return null;
    }

    try {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  /**
   * Set a cached value
   */
  set<T>(key: string, value: T): void {
    const path = this.getPath(key);
    this.ensureDir(dirname(path));
    writeFileSync(path, JSON.stringify(value, null, 2));
  }

  /**
   * Check if a key exists in cache
   */
  has(key: string): boolean {
    return existsSync(this.getPath(key));
  }

  /**
   * Delete a cached value
   */
  async delete(key: string): Promise<void> {
    const path = this.getPath(key);
    if (existsSync(path)) {
      const { unlink } = await import('fs/promises');
      await unlink(path);
    }
  }

  /**
   * Get the file path for a cache key
   */
  private getPath(key: string): string {
    // Sanitize key for filesystem
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.cacheDir, `${safeKey}.json`);
  }

  /**
   * Ensure directory exists
   */
  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Create a cache instance for a specific video
 */
export function createVideoCache(videoId: string): Cache {
  return new Cache(videoId);
}

// Default cache instance
export const cache = new Cache();
