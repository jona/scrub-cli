import { join, dirname, relative } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { config } from "../infrastructure/Config.js";
import { logger } from "../utils/logger.js";
import { slugify } from "../utils/helpers.js";
import type {
  ArtifactManifest,
  ArtifactIndex,
  ArtifactIndexEntry,
  ArtifactType,
  MediaMetadata,
  SummaryResult,
  VisualAnalysis,
  SkillChecklist,
  SourcePlaylist,
} from "../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

const PIPELINE_VERSION = "1.0.0";
const INDEX_VERSION = "1.0.0";

/**
 * Service for managing artifact storage in .output directory
 *
 * Directory structure:
 * .output/
 * ├── {number}/          (sequential, assigned in order of creation)
 * │   ├── manifest.json
 * │   ├── source/
 * │   │   ├── audio.wav
 * │   │   ├── video.mp4
 * │   │   └── metadata.json
 * │   ├── frames/
 * │   │   └── frame_*.png
 * │   ├── transcription/
 * │   │   ├── transcript.json
 * │   │   └── transcript.txt
 * │   ├── inference/
 * │   │   ├── summary.json
 * │   │   ├── visual_analysis.json
 * │   │   └── skill_checklist.json
 * │   ├── output/
 * │   │   ├── summary.md
 * │   │   └── SKILL.md
 * │   └── stats.json
 * └── index.json
 */
export class ArtifactStore {
  private outputDir: string;
  private dirMap: Map<string, string> = new Map(); // contentId → directory name

  constructor() {
    this.outputDir = config.getOutputDir();
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
   * Re-read config and reload the dir map (call after config.setOutputDir)
   */
  reinitialize(): void {
    this.outputDir = config.getOutputDir();
    this.loadDirMap();
  }

  /**
   * Get the base output directory
   */
  getOutputDir(): string {
    return this.outputDir;
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
  getSourceDir(contentId: string): string {
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
  getTranscriptionDir(contentId: string): string {
    return join(this.getVideoDir(contentId), "transcription");
  }

  /**
   * Get the inference directory for a video
   */
  getInferenceDir(contentId: string): string {
    return join(this.getVideoDir(contentId), "inference");
  }

  /**
   * Get the output directory for a video (markdown, skill)
   */
  getOutputSubdir(contentId: string): string {
    return join(this.getVideoDir(contentId), "output");
  }

  /**
   * Ensure all directories exist for a video
   */
  ensureVideoDirectories(contentId: string, title?: string): void {
    const dirs = [
      this.getVideoDir(contentId, title),
      this.getSourceDir(contentId),
      this.getFramesDir(contentId),
      this.getTranscriptionDir(contentId),
      this.getInferenceDir(contentId),
      this.getOutputSubdir(contentId),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Check if a video has been processed (exists in index)
   */
  hasVideo(contentId: string): boolean {
    return this.dirMap.has(contentId);
  }

  /**
   * Check if a specific artifact exists
   */
  hasArtifact(contentId: string, type: ArtifactType): boolean {
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
      case "transcription/json":
        return join(videoDir, "transcription", "transcript.json");
      case "transcription/txt":
        return join(videoDir, "transcription", "transcript.txt");
      case "inference/summary":
        return join(videoDir, "inference", "summary.json");
      case "inference/visual_analysis":
        return join(videoDir, "inference", "visual_analysis.json");
      case "inference/skill_checklist":
        return join(videoDir, "inference", "skill_checklist.json");
      case "output/markdown":
        return join(videoDir, "output", "summary.md");
      case "output/skill":
        return join(videoDir, "output", "SKILL.md");
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
   * Load video metadata
   */
  loadMetadata(contentId: string): MediaMetadata | null {
    const path = this.getArtifactPath(contentId, "source/metadata");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
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
   * Load transcription result
   */
  loadTranscription(contentId: string): TranscriptionResult | null {
    const path = this.getArtifactPath(contentId, "transcription/json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save summary result
   */
  saveSummary(contentId: string, summary: SummaryResult): void {
    this.ensureVideoDirectories(contentId);
    const path = this.getArtifactPath(contentId, "inference/summary");
    writeFileSync(path, JSON.stringify(summary, null, 2), "utf-8");
    logger.debug(`Saved summary to ${path}`);
  }

  /**
   * Load summary result
   */
  loadSummary(contentId: string): SummaryResult | null {
    const path = this.getArtifactPath(contentId, "inference/summary");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save visual analysis results
   */
  saveVisualAnalysis(contentId: string, visuals: VisualAnalysis[]): void {
    this.ensureVideoDirectories(contentId);
    const path = this.getArtifactPath(contentId, "inference/visual_analysis");
    writeFileSync(path, JSON.stringify(visuals, null, 2), "utf-8");
    logger.debug(`Saved visual analysis to ${path}`);
  }

  /**
   * Load visual analysis results
   */
  loadVisualAnalysis(contentId: string): VisualAnalysis[] | null {
    const path = this.getArtifactPath(contentId, "inference/visual_analysis");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save skill checklist
   */
  saveSkillChecklist(contentId: string, checklist: SkillChecklist): void {
    this.ensureVideoDirectories(contentId);
    const path = this.getArtifactPath(contentId, "inference/skill_checklist");
    writeFileSync(path, JSON.stringify(checklist, null, 2), "utf-8");
    logger.debug(`Saved skill checklist to ${path}`);
  }

  /**
   * Load skill checklist
   */
  loadSkillChecklist(contentId: string): SkillChecklist | null {
    const path = this.getArtifactPath(contentId, "inference/skill_checklist");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save markdown output
   */
  saveMarkdown(contentId: string, markdown: string): string {
    this.ensureVideoDirectories(contentId);
    const path = this.getArtifactPath(contentId, "output/markdown");
    writeFileSync(path, markdown, "utf-8");
    logger.debug(`Saved markdown to ${path}`);
    return path;
  }

  /**
   * Load markdown output
   */
  loadMarkdown(contentId: string): string | null {
    const path = this.getArtifactPath(contentId, "output/markdown");
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  }

  /**
   * Save skill file
   */
  saveSkill(contentId: string, skillMd: string): string {
    this.ensureVideoDirectories(contentId);
    const path = this.getArtifactPath(contentId, "output/skill");
    writeFileSync(path, skillMd, "utf-8");
    logger.debug(`Saved skill to ${path}`);
    return path;
  }

  /**
   * Get list of frame paths in the frames directory
   */
  getFramePaths(contentId: string): string[] {
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
  saveManifest(contentId: string, manifest: ArtifactManifest): void {
    this.ensureVideoDirectories(contentId);
    const path = join(this.getVideoDir(contentId), "manifest.json");
    writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
    logger.debug(`Saved manifest to ${path}`);
  }

  /**
   * Load the manifest for a video
   */
  loadManifest(contentId: string): ArtifactManifest | null {
    const path = join(this.getVideoDir(contentId), "manifest.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Create a manifest from current artifacts
   */
  createManifest(
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
        inference: {
          summary: this.hasArtifact(contentId, "inference/summary"),
          visualAnalysis: this.hasArtifact(
            contentId,
            "inference/visual_analysis"
          ),
          skillChecklist: this.hasArtifact(
            contentId,
            "inference/skill_checklist"
          ),
        },
        output: {
          markdown: this.hasArtifact(contentId, "output/markdown"),
          skill: this.hasArtifact(contentId, "output/skill"),
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
  saveStats(contentId: string, stats: ArtifactManifest["stats"]): void {
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
  updateIndex(contentId: string, entry: ArtifactIndexEntry): void {
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

  /**
   * List all processed video IDs
   */
  listVideoIds(): string[] {
    const index = this.getIndex();
    return Object.keys(index.media);
  }
}

// Export singleton instance
export const artifactStore = new ArtifactStore();
