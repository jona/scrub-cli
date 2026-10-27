import { join, dirname, relative } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { logger } from "../../utils/logger.js";
import { slugify } from "../../core/format.js";
import type {
  ArtifactManifest,
  ArtifactIndex,
  ArtifactIndexEntry,
  ArtifactType,
  MediaMetadata,
  SceneFrame,
  SourcePlaylist,
} from "../../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

const PIPELINE_VERSION = "1.0.0";
const INDEX_VERSION = "1.0.0";

/**
 * CLI output projection and index management for an explicit output directory
 *
 * Directory structure:
 * {outputDirectory}/
 * ├── {title-slug}/      (stable slug, disambiguated within the index)
 * │   ├── manifest.json
 * │   ├── source/
 * │   │   ├── audio.wav
 * │   │   ├── video.mp4
 * │   │   └── metadata.json
 * │   ├── frames/
 * │   │   ├── frame_*.png
 * │   │   └── frames.json
 * │   ├── transcription/
 * │   │   ├── transcript.json
 * │   │   └── transcript.txt
 * │   ├── prompt/                  (scrub's deterministic output)
 * │   │   ├── summary.prompt.md
 * │   │   └── summary.schema.json
 * │   ├── inference/               (model output, optional)
 * │   │   ├── summary.json
 * │   │   └── visual_analysis.json
 * │   ├── output/                  (rendered from a model's summary.json)
 * │   │   └── summary.md
 * │   └── stats.json
 * └── index.json
 */
export class ArtifactStore {
  private readonly outputDir: string;
  private readonly dirMap: Map<string, string> = new Map(); // contentId → directory name

  constructor(options: { outputDirectory: string }) {
    this.outputDir = options.outputDirectory;
    this.loadDirMap();
  }

  /**
   * Load the contentId -> directory name mapping from the index
   */
  private loadDirMap(): void {
    this.dirMap.clear();
    const indexPath = join(this.outputDir, "index.json");
    if (!existsSync(indexPath)) return;

    try {
      const index: ArtifactIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
      const entries = index.media ?? (index as any).videos ?? {};
      for (const [contentId, entry] of Object.entries(entries)) {
        this.dirMap.set(contentId, (entry as ArtifactIndexEntry).outputPath);
      }
    } catch {
      // Index doesn't exist or is invalid, start fresh
    }
  }

  /**
   * Get or assign the directory name for a video
   */
  private resolveDir(contentId: string, title?: string): string {
    let dirName = this.dirMap.get(contentId);
    if (!dirName) {
      const base = title ? slugify(title) : contentId;
      dirName = this.uniqueDirName(base);
      this.dirMap.set(contentId, dirName);
    }
    return dirName;
  }

  /**
   * Ensure a directory name is unique within the output dir
   */
  private uniqueDirName(base: string): string {
    const existing = new Set(this.dirMap.values());
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }

  /**
   * Get the artifact directory for a specific video
   */
  getVideoDir(contentId: string, title?: string): string {
    return join(this.outputDir, this.resolveDir(contentId, title));
  }

  /**
   * Get the source directory for a video (audio, video, metadata)
   */
  private getSourceDir(contentId: string): string {
    return join(this.getVideoDir(contentId), "source");
  }

  /**
   * Get the frames directory for a video
   */
  getFramesDir(contentId: string): string {
    return join(this.getVideoDir(contentId), "frames");
  }

  /**
   * Get the transcription directory for a video
   */
  private getTranscriptionDir(contentId: string): string {
    return join(this.getVideoDir(contentId), "transcription");
  }

  /**
   * Get the prompt directory for a video (scrub's deterministic output)
   */
  private getPromptDir(contentId: string): string {
    return join(this.getVideoDir(contentId), "prompt");
  }

  /**
   * Ensure the directories scrub's deterministic pipeline writes to exist.
   *
   * The `inference/` and `output/` directories are NOT created here — they hold
   * model output and rendered markdown. The full pipeline, render command, or
   * an external harness creates them when publishing those artifacts.
   */
  ensureVideoDirectories(contentId: string, title?: string): void {
    const dirs = [
      this.getVideoDir(contentId, title),
      this.getSourceDir(contentId),
      this.getFramesDir(contentId),
      this.getTranscriptionDir(contentId),
      this.getPromptDir(contentId),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Check if a specific artifact exists
   */
  private hasArtifact(contentId: string, type: ArtifactType): boolean {
    const path = this.getArtifactPath(contentId, type);
    return existsSync(path);
  }

  /**
   * Get the file path for a specific artifact type
   */
  getArtifactPath(contentId: string, type: ArtifactType): string {
    const videoDir = this.getVideoDir(contentId);

    switch (type) {
      case "source/audio":
        return join(videoDir, "source", "audio.wav");
      case "source/video":
        return join(videoDir, "source", "video.mp4");
      case "source/metadata":
        return join(videoDir, "source", "metadata.json");
      case "frames":
        return join(videoDir, "frames");
      case "frames/json":
        return join(videoDir, "frames", "frames.json");
      case "transcription/json":
        return join(videoDir, "transcription", "transcript.json");
      case "transcription/txt":
        return join(videoDir, "transcription", "transcript.txt");
      case "prompt/summary":
        return join(videoDir, "prompt", "summary.prompt.md");
      case "prompt/schema":
        return join(videoDir, "prompt", "summary.schema.json");
      case "inference/summary":
        return join(videoDir, "inference", "summary.json");
      case "inference/visual_analysis":
        return join(videoDir, "inference", "visual_analysis.json");
      case "output/markdown":
        return join(videoDir, "output", "summary.md");
      default:
        throw new Error(`Unknown artifact type: ${type}`);
    }
  }

  /**
   * Save video metadata
   */
  saveMetadata(contentId: string, metadata: MediaMetadata): void {
    this.ensureVideoDirectories(contentId);
    const path = this.getArtifactPath(contentId, "source/metadata");
    writeFileSync(path, JSON.stringify(metadata, null, 2), "utf-8");
    logger.debug(`Saved metadata to ${path}`);
  }

  /**
   * Save transcription result (both JSON and plain text)
   */
  saveTranscription(contentId: string, transcript: TranscriptionResult): void {
    this.ensureVideoDirectories(contentId);

    // Save JSON format
    const jsonPath = this.getArtifactPath(contentId, "transcription/json");
    writeFileSync(jsonPath, JSON.stringify(transcript, null, 2), "utf-8");
    logger.debug(`Saved transcript JSON to ${jsonPath}`);

    // Save plain text format
    const txtPath = this.getArtifactPath(contentId, "transcription/txt");
    writeFileSync(txtPath, transcript.fullText, "utf-8");
    logger.debug(`Saved transcript text to ${txtPath}`);
  }

  /**
   * Save the frame manifest (timestamps + relative paths) as frames.json
   */
  saveFramesManifest(contentId: string, frames: SceneFrame[]): string {
    this.ensureVideoDirectories(contentId);
    const path = this.getArtifactPath(contentId, "frames/json");
    const videoDir = this.getVideoDir(contentId);
    const manifest = frames.map((f) => ({
      timestamp: f.timestamp,
      path: relative(videoDir, f.framePath),
      score: f.score,
    }));
    writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
    logger.debug(`Saved frames manifest to ${path}`);
    return path;
  }

  /**
   * Get list of frame paths in the frames directory
   */
  private getFramePaths(contentId: string): string[] {
    const framesDir = this.getFramesDir(contentId);
    if (!existsSync(framesDir)) return [];

    return readdirSync(framesDir)
      .filter((f) => f.endsWith(".png") || f.endsWith(".jpg"))
      .sort()
      .map((f) => join(framesDir, f));
  }

  /**
   * Save the manifest for a video
   */
  private saveManifest(contentId: string, manifest: ArtifactManifest): void {
    this.ensureVideoDirectories(contentId);
    const path = join(this.getVideoDir(contentId), "manifest.json");
    writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
    logger.debug(`Saved manifest to ${path}`);
  }

  /**
   * Create a manifest from current artifacts
   */
  private createManifest(
    contentId: string,
    metadata: MediaMetadata,
    transcriptionSource: string | null,
    stats: ArtifactManifest["stats"],
    sourcePlaylist?: SourcePlaylist
  ): ArtifactManifest {
    const framePaths = this.getFramePaths(contentId);

    const manifest: ArtifactManifest = {
      contentId,
      url: metadata.url,
      title: metadata.title,
      processedAt: new Date().toISOString(),
      pipelineVersion: PIPELINE_VERSION,
      artifacts: {
        source: {
          audio: this.hasArtifact(contentId, "source/audio"),
          video: this.hasArtifact(contentId, "source/video"),
          metadata: this.hasArtifact(contentId, "source/metadata"),
        },
        frames: {
          count: framePaths.length,
          paths: framePaths.map((p) =>
            relative(this.getVideoDir(contentId), p)
          ),
        },
        transcription: {
          source: transcriptionSource,
          hasJson: this.hasArtifact(contentId, "transcription/json"),
          hasTxt: this.hasArtifact(contentId, "transcription/txt"),
        },
        prompt: {
          summary: this.hasArtifact(contentId, "prompt/summary"),
          schema: this.hasArtifact(contentId, "prompt/schema"),
        },
      },
      stats,
    };

    if (sourcePlaylist) {
      manifest.sourcePlaylist = sourcePlaylist;
    }

    return manifest;
  }

  /**
   * Save processing stats
   */
  private saveStats(contentId: string, stats: ArtifactManifest["stats"]): void {
    this.ensureVideoDirectories(contentId);
    const path = join(this.getVideoDir(contentId), "stats.json");
    writeFileSync(path, JSON.stringify(stats, null, 2), "utf-8");
    logger.debug(`Saved stats to ${path}`);
  }

  /**
   * Get the global index
   */
  getIndex(): ArtifactIndex {
    const indexPath = join(this.outputDir, "index.json");

    if (!existsSync(indexPath)) {
      return {
        version: INDEX_VERSION,
        lastUpdated: new Date().toISOString(),
        media: {},
      };
    }

    return JSON.parse(readFileSync(indexPath, "utf-8"));
  }

  /**
   * Update the global index with a new video entry
   */
  private updateIndex(contentId: string, entry: ArtifactIndexEntry): void {
    const index = this.getIndex();

    index.media[contentId] = entry;
    index.lastUpdated = new Date().toISOString();

    const indexPath = join(this.outputDir, "index.json");
    if (!existsSync(dirname(indexPath))) {
      mkdirSync(dirname(indexPath), { recursive: true });
    }
    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
    logger.debug(`Updated index at ${indexPath}`);
  }

  /**
   * Finalize artifacts for a video - creates manifest and updates index
   */
  finalizeArtifacts(
    contentId: string,
    metadata: MediaMetadata,
    transcriptionSource: string | null,
    stats: ArtifactManifest["stats"],
    sourcePlaylist?: SourcePlaylist
  ): void {
    // Create and save manifest
    const manifest = this.createManifest(
      contentId,
      metadata,
      transcriptionSource,
      stats,
      sourcePlaylist
    );
    this.saveManifest(contentId, manifest);

    // Save stats separately for quick access
    this.saveStats(contentId, stats);

    // Update global index
    this.updateIndex(contentId, {
      title: metadata.title,
      url: metadata.url,
      processedAt: manifest.processedAt,
      outputPath: this.resolveDir(contentId),
    });

    logger.info(`Finalized artifacts for ${contentId}`);
  }
}
