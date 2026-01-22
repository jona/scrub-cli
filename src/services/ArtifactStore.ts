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
import type {
  ArtifactManifest,
  ArtifactIndex,
  ArtifactIndexEntry,
  ArtifactType,
  VideoMetadata,
  SummaryResult,
  VisualAnalysis,
  SkillChecklist,
} from "../types/index.js";
import type { TranscriptionResult } from "../transcription/ITranscriber.js";

const PIPELINE_VERSION = "1.0.0";
const INDEX_VERSION = "1.0.0";

/**
 * Service for managing artifact storage in .output directory
 *
 * Directory structure:
 * .output/
 * ├── {videoId}/
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

  constructor() {
    this.outputDir = config.getOutputDir();
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
  getVideoDir(videoId: string): string {
    return join(this.outputDir, videoId);
  }

  /**
   * Get the source directory for a video (audio, video, metadata)
   */
  getSourceDir(videoId: string): string {
    return join(this.getVideoDir(videoId), "source");
  }

  /**
   * Get the frames directory for a video
   */
  getFramesDir(videoId: string): string {
    return join(this.getVideoDir(videoId), "frames");
  }

  /**
   * Get the transcription directory for a video
   */
  getTranscriptionDir(videoId: string): string {
    return join(this.getVideoDir(videoId), "transcription");
  }

  /**
   * Get the inference directory for a video
   */
  getInferenceDir(videoId: string): string {
    return join(this.getVideoDir(videoId), "inference");
  }

  /**
   * Get the output directory for a video (markdown, skill)
   */
  getOutputSubdir(videoId: string): string {
    return join(this.getVideoDir(videoId), "output");
  }

  /**
   * Ensure all directories exist for a video
   */
  ensureVideoDirectories(videoId: string): void {
    const dirs = [
      this.getVideoDir(videoId),
      this.getSourceDir(videoId),
      this.getFramesDir(videoId),
      this.getTranscriptionDir(videoId),
      this.getInferenceDir(videoId),
      this.getOutputSubdir(videoId),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Check if a video has been processed (has a manifest)
   */
  hasVideo(videoId: string): boolean {
    const manifestPath = join(this.getVideoDir(videoId), "manifest.json");
    return existsSync(manifestPath);
  }

  /**
   * Check if a specific artifact exists
   */
  hasArtifact(videoId: string, type: ArtifactType): boolean {
    const path = this.getArtifactPath(videoId, type);
    return existsSync(path);
  }

  /**
   * Get the file path for a specific artifact type
   */
  getArtifactPath(videoId: string, type: ArtifactType): string {
    const videoDir = this.getVideoDir(videoId);

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
  saveMetadata(videoId: string, metadata: VideoMetadata): void {
    this.ensureVideoDirectories(videoId);
    const path = this.getArtifactPath(videoId, "source/metadata");
    writeFileSync(path, JSON.stringify(metadata, null, 2), "utf-8");
    logger.debug(`Saved metadata to ${path}`);
  }

  /**
   * Load video metadata
   */
  loadMetadata(videoId: string): VideoMetadata | null {
    const path = this.getArtifactPath(videoId, "source/metadata");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save transcription result (both JSON and plain text)
   */
  saveTranscription(videoId: string, transcript: TranscriptionResult): void {
    this.ensureVideoDirectories(videoId);

    // Save JSON format
    const jsonPath = this.getArtifactPath(videoId, "transcription/json");
    writeFileSync(jsonPath, JSON.stringify(transcript, null, 2), "utf-8");
    logger.debug(`Saved transcript JSON to ${jsonPath}`);

    // Save plain text format
    const txtPath = this.getArtifactPath(videoId, "transcription/txt");
    writeFileSync(txtPath, transcript.fullText, "utf-8");
    logger.debug(`Saved transcript text to ${txtPath}`);
  }

  /**
   * Load transcription result
   */
  loadTranscription(videoId: string): TranscriptionResult | null {
    const path = this.getArtifactPath(videoId, "transcription/json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save summary result
   */
  saveSummary(videoId: string, summary: SummaryResult): void {
    this.ensureVideoDirectories(videoId);
    const path = this.getArtifactPath(videoId, "inference/summary");
    writeFileSync(path, JSON.stringify(summary, null, 2), "utf-8");
    logger.debug(`Saved summary to ${path}`);
  }

  /**
   * Load summary result
   */
  loadSummary(videoId: string): SummaryResult | null {
    const path = this.getArtifactPath(videoId, "inference/summary");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save visual analysis results
   */
  saveVisualAnalysis(videoId: string, visuals: VisualAnalysis[]): void {
    this.ensureVideoDirectories(videoId);
    const path = this.getArtifactPath(videoId, "inference/visual_analysis");
    writeFileSync(path, JSON.stringify(visuals, null, 2), "utf-8");
    logger.debug(`Saved visual analysis to ${path}`);
  }

  /**
   * Load visual analysis results
   */
  loadVisualAnalysis(videoId: string): VisualAnalysis[] | null {
    const path = this.getArtifactPath(videoId, "inference/visual_analysis");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save skill checklist
   */
  saveSkillChecklist(videoId: string, checklist: SkillChecklist): void {
    this.ensureVideoDirectories(videoId);
    const path = this.getArtifactPath(videoId, "inference/skill_checklist");
    writeFileSync(path, JSON.stringify(checklist, null, 2), "utf-8");
    logger.debug(`Saved skill checklist to ${path}`);
  }

  /**
   * Load skill checklist
   */
  loadSkillChecklist(videoId: string): SkillChecklist | null {
    const path = this.getArtifactPath(videoId, "inference/skill_checklist");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Save markdown output
   */
  saveMarkdown(videoId: string, markdown: string): string {
    this.ensureVideoDirectories(videoId);
    const path = this.getArtifactPath(videoId, "output/markdown");
    writeFileSync(path, markdown, "utf-8");
    logger.debug(`Saved markdown to ${path}`);
    return path;
  }

  /**
   * Load markdown output
   */
  loadMarkdown(videoId: string): string | null {
    const path = this.getArtifactPath(videoId, "output/markdown");
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  }

  /**
   * Save skill file
   */
  saveSkill(videoId: string, skillMd: string): string {
    this.ensureVideoDirectories(videoId);
    const path = this.getArtifactPath(videoId, "output/skill");
    writeFileSync(path, skillMd, "utf-8");
    logger.debug(`Saved skill to ${path}`);
    return path;
  }

  /**
   * Get list of frame paths in the frames directory
   */
  getFramePaths(videoId: string): string[] {
    const framesDir = this.getFramesDir(videoId);
    if (!existsSync(framesDir)) return [];

    return readdirSync(framesDir)
      .filter((f) => f.endsWith(".png") || f.endsWith(".jpg"))
      .sort()
      .map((f) => join(framesDir, f));
  }

  /**
   * Save the manifest for a video
   */
  saveManifest(videoId: string, manifest: ArtifactManifest): void {
    this.ensureVideoDirectories(videoId);
    const path = join(this.getVideoDir(videoId), "manifest.json");
    writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
    logger.debug(`Saved manifest to ${path}`);
  }

  /**
   * Load the manifest for a video
   */
  loadManifest(videoId: string): ArtifactManifest | null {
    const path = join(this.getVideoDir(videoId), "manifest.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  /**
   * Create a manifest from current artifacts
   */
  createManifest(
    videoId: string,
    metadata: VideoMetadata,
    transcriptionSource: string | null,
    stats: ArtifactManifest["stats"]
  ): ArtifactManifest {
    const framePaths = this.getFramePaths(videoId);

    return {
      videoId,
      url: metadata.url,
      title: metadata.title,
      processedAt: new Date().toISOString(),
      pipelineVersion: PIPELINE_VERSION,
      artifacts: {
        source: {
          audio: this.hasArtifact(videoId, "source/audio"),
          video: this.hasArtifact(videoId, "source/video"),
          metadata: this.hasArtifact(videoId, "source/metadata"),
        },
        frames: {
          count: framePaths.length,
          paths: framePaths.map((p) =>
            relative(this.getVideoDir(videoId), p)
          ),
        },
        transcription: {
          source: transcriptionSource,
          hasJson: this.hasArtifact(videoId, "transcription/json"),
          hasTxt: this.hasArtifact(videoId, "transcription/txt"),
        },
        inference: {
          summary: this.hasArtifact(videoId, "inference/summary"),
          visualAnalysis: this.hasArtifact(videoId, "inference/visual_analysis"),
          skillChecklist: this.hasArtifact(videoId, "inference/skill_checklist"),
        },
        output: {
          markdown: this.hasArtifact(videoId, "output/markdown"),
          skill: this.hasArtifact(videoId, "output/skill"),
        },
      },
      stats,
    };
  }

  /**
   * Save processing stats
   */
  saveStats(videoId: string, stats: ArtifactManifest["stats"]): void {
    this.ensureVideoDirectories(videoId);
    const path = join(this.getVideoDir(videoId), "stats.json");
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
        videos: {},
      };
    }

    return JSON.parse(readFileSync(indexPath, "utf-8"));
  }

  /**
   * Update the global index with a new video entry
   */
  updateIndex(videoId: string, entry: ArtifactIndexEntry): void {
    const index = this.getIndex();

    index.videos[videoId] = entry;
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
    videoId: string,
    metadata: VideoMetadata,
    transcriptionSource: string | null,
    stats: ArtifactManifest["stats"]
  ): void {
    // Create and save manifest
    const manifest = this.createManifest(
      videoId,
      metadata,
      transcriptionSource,
      stats
    );
    this.saveManifest(videoId, manifest);

    // Save stats separately for quick access
    this.saveStats(videoId, stats);

    // Update global index
    this.updateIndex(videoId, {
      title: metadata.title,
      url: metadata.url,
      processedAt: manifest.processedAt,
      outputPath: videoId,
    });

    logger.info(`Finalized artifacts for ${videoId}`);
  }

  /**
   * List all processed video IDs
   */
  listVideoIds(): string[] {
    const index = this.getIndex();
    return Object.keys(index.videos);
  }
}

// Export singleton instance
export const artifactStore = new ArtifactStore();
