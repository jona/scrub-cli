import {
  accessSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { PipelineError, throwIfAborted } from "../../../core/errors.js";
import { slugify } from "../../../core/format.js";
import { logger } from "../../../utils/logger.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../../Config.js";
import { ArtifactStore } from "../../filesystem/ArtifactStore.js";
import { FilesystemRunRepository } from "../../filesystem/RunRepository.js";
import { withDirectoryLock } from "../../filesystem/locking.js";
import { FilesystemArtifactStorage } from "../FilesystemArtifactStorage.js";
import { NodeMediaProcessor } from "../NodeMediaProcessor.js";
import { NodeTranscriber } from "../NodeTranscriber.js";
import { NodeSourceCatalog } from "../NodeSourceCatalog.js";
import { buildLocalMetadata, generateContentId } from "../prepare.js";
import {
  runVideoPipeline,
  pipelineCacheKey,
} from "../../../application/pipeline.js";
import { resolveSettings } from "../../../application/settings.js";
import { readArtifactJson } from "../../../application/artifact-io.js";
import type {
  ArtifactRef,
  MediaSource,
  OperationContext,
  PipelineSettings,
  VideoResult,
} from "../../../application/contracts.js";
import type {
  MediaMetadata,
  TranscriptionResult,
} from "../../../core/models.js";
import type { TranscriptionSource } from "../../transcription/ITranscriber.js";
import type {
  InferenceSettingsInput,
  StructuredModelGateway,
} from "../../../application/model.js";

export interface LocalPipelineOptions {
  inference?: InferenceSettingsInput;
  models?: StructuredModelGateway;
  skipVisuals?: boolean;
  transcriber?: TranscriptionSource;
  sceneThreshold?: number;
  maxFrames?: number;
  verbose?: boolean;
  signal?: AbortSignal;
  outputDir?: string;
  force?: boolean;
  onProgress?: (progress: {
    stage: string;
    progress: number;
    message: string;
  }) => void;
  sourcePlaylist?: import("../../../core/models.js").SourcePlaylist;
}
export interface LocalProcessResult {
  metadata: MediaMetadata;
  transcript: TranscriptionResult;
  frames: import("../../../types/index.js").SceneFrame[];
  promptPath: string;
  summaryPath?: string;
  outputPath: string;
  stats: VideoResult["stats"];
  reused: boolean;
}

export function localSettings(options: LocalPipelineOptions): PipelineSettings {
  const visual = config.getVisual();
  const transcription = config.getTranscription();
  return resolveSettings({
    ...(options.inference === undefined
      ? {}
      : { inference: options.inference }),
    skipVisuals: options.skipVisuals ?? !visual.enabled,
    sceneThreshold: options.sceneThreshold ?? visual.sceneThreshold,
    maxFrames: options.maxFrames ?? visual.maxFrames,
    transcription: {
      provider: options.transcriber,
      model: transcription.whisperModel,
      language: transcription.language,
    },
  });
}

export function createLocalAdapters(options: LocalPipelineOptions = {}) {
  const settings = localSettings(options);
  if (settings.inference?.mode === "full") {
    for (const selection of [
      settings.inference.summary,
      ...(settings.skipVisuals ? [] : [settings.inference.vision]),
    ]) {
      if (!selection || !options.models?.supports(selection))
        throw new PipelineError(
          "capability_unavailable",
          "Full processing requires configured model credentials and allowed selections"
        );
    }
  }
  const cache = config.getCacheDir();
  const artifacts = new FilesystemArtifactStorage(join(cache, "artifacts-v2"), {
    maxArtifactBytes: Math.max(
      settings.limits.maxArtifactBytes,
      settings.limits.maxSourceBytes
    ),
  });
  const whisper = config.getLocalWhisper();
  const findBinary = (candidates: Array<string | undefined>) =>
    candidates.find((candidate) => {
      if (!candidate) return false;
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const pathDirectories = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);
  const whisperBinaryPath = findBinary([
    whisper.binaryPath ? config.resolvePath(whisper.binaryPath) : undefined,
    ...["whisper", "whisper-cpp", "main"].flatMap((name) =>
      pathDirectories.map((directory) => join(directory, name))
    ),
    "/usr/local/bin/whisper",
    "/opt/homebrew/bin/whisper",
    join(homedir(), "whisper.cpp/main"),
    join(homedir(), ".local/bin/whisper"),
  ]);
  const whisperModelsPath = [
    whisper.modelsPath ? config.resolvePath(whisper.modelsPath) : undefined,
    join(homedir(), "whisper.cpp/models"),
    join(homedir(), ".cache/whisper"),
    "/usr/local/share/whisper/models",
    resolve("models"),
  ].find(
    (directory) =>
      directory !== undefined &&
      existsSync(
        join(directory, `ggml-${settings.transcription.model ?? "base"}.bin`)
      )
  );
  const runtime = {
    stagingRoot: join(cache, "workspaces"),
    providers: config.getTranscription().priority,
    whisperBinaryPath,
    whisperModelsPath,
    openaiApiKey: config.getApiKey("openai"),
    deepgramApiKey: config.getApiKey("deepgram"),
    logger,
  };
  return {
    ...(options.models ? { models: options.models } : {}),
    artifacts,
    media: new NodeMediaProcessor(artifacts, runtime),
    transcriber: new NodeTranscriber(artifacts, runtime),
    catalog: new NodeSourceCatalog({}),
    settings,
  };
}

async function projectArtifact(
  storage: FilesystemArtifactStorage,
  ref: ArtifactRef,
  target: string
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await pipeline(
      Readable.from(storage.read(ref)),
      createWriteStream(temporary, { flags: "wx" })
    );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runLocalPipeline(
  source: MediaSource,
  options: LocalPipelineOptions = {},
  originalFile?: string
): Promise<LocalProcessResult> {
  const adapters = createLocalAdapters(options);
  const outputDirectory = resolve(options.outputDir ?? config.getOutputDir());
  const runKey = createHash("sha256")
    .update(JSON.stringify([outputDirectory, source]))
    .digest("hex");
  const runFile = join(config.getCacheDir(), "runs-v2", `${runKey}.json`);
  const runs = new FilesystemRunRepository(runFile);
  const context: OperationContext = {
    runId: runKey,
    attemptId: randomUUID(),
    signal: options.signal ?? new AbortController().signal,
    now: () => Date.now(),
    emit: (event) => {
      options.onProgress?.(event);
    },
  };
  return withDirectoryLock(`${runFile}.execution`, async () => {
    const previous = await runs.get();
    const key = pipelineCacheKey(source, adapters.settings);
    if (previous?.status === "failed" || previous?.status === "cancelled") {
      await runs.update((current) => ({
        ...current!,
        attempts: 0,
        cancelRequested: false,
      }));
    }
    const result = await runVideoPipeline(
      source,
      adapters.settings,
      { ...adapters, runs },
      context,
      { force: options.force }
    );
    const reused =
      !options.force &&
      previous?.status === "completed" &&
      previous.cacheKey === key &&
      previous.result?.completedAt === result.completedAt;
    const transcript = await readArtifactJson<TranscriptionResult>(
      adapters.artifacts,
      result.transcript
    );
    // Local path metadata is a CLI compatibility projection, never application identity.
    const metadata = originalFile
      ? buildLocalMetadata(
          originalFile,
          generateContentId(originalFile),
          result.metadata.duration
        )
      : result.metadata;
    return withDirectoryLock(
      join(outputDirectory, ".scrub-index.lock"),
      async () => {
        throwIfAborted(context.signal, "publish");
        const store = new ArtifactStore({ outputDirectory });
        const id = metadata.contentId;
        const finalDirectory = store.getVideoDir(
          id,
          slugify(metadata.title) || id
        );
        const relativeDirectory = relative(outputDirectory, finalDirectory);
        if (
          !relativeDirectory ||
          relativeDirectory.startsWith("..") ||
          relativeDirectory.includes("/")
        )
          throw new PipelineError(
            "storage_error",
            "Invalid local output directory"
          );
        const staging = await mkdtemp(
          join(outputDirectory, ".scrub-publication-")
        );
        const stagedStore = new ArtifactStore({ outputDirectory: staging });
        stagedStore.ensureVideoDirectories(id, basename(finalDirectory));
        const stagedDirectory = stagedStore.getVideoDir(id);
        const backup = join(outputDirectory, `.scrub-backup-${randomUUID()}`);
        const indexTemporary = join(
          outputDirectory,
          `.scrub-index-${randomUUID()}.tmp`
        );
        let movedPrevious = false;
        let published = false;
        let committed = false;
        try {
          const old = await lstat(finalDirectory).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          });
          if (old && (!old.isDirectory() || old.isSymbolicLink()))
            throw new PipelineError(
              "storage_error",
              "Existing output is not a media directory"
            );
          // Preserve harness-authored material, but rebuild all generated namespaces.
          if (old) {
            for (const name of ["inference", "output"]) {
              const path = join(finalDirectory, name);
              if (existsSync(path))
                await cp(path, join(stagedDirectory, name), {
                  recursive: true,
                  dereference: false,
                });
            }
          }
          await projectArtifact(
            adapters.artifacts,
            result.audio,
            stagedStore.getArtifactPath(id, "source/audio")
          );
          if (result.video)
            await projectArtifact(
              adapters.artifacts,
              result.video,
              stagedStore.getArtifactPath(id, "source/video")
            );
          stagedStore.saveMetadata(id, metadata);
          stagedStore.saveTranscription(id, transcript);
          const frames: import("../../../types/index.js").SceneFrame[] = [];
          for (let index = 0; index < result.frames.length; index++) {
            const frame = result.frames[index];
            const filename = `frame_${String(index + 1).padStart(3, "0")}.png`;
            await projectArtifact(
              adapters.artifacts,
              frame.artifact,
              join(stagedStore.getFramesDir(id), filename)
            );
            frames.push({
              timestamp: frame.timestamp,
              framePath: join(store.getFramesDir(id), filename),
              ...(frame.score === undefined ? {} : { score: frame.score }),
            });
          }
          if (frames.length)
            stagedStore.saveFramesManifest(
              id,
              frames.map((frame) => ({
                ...frame,
                framePath: join(
                  stagedStore.getFramesDir(id),
                  basename(frame.framePath)
                ),
              }))
            );
          await projectArtifact(
            adapters.artifacts,
            result.prompt,
            stagedStore.getArtifactPath(id, "prompt/summary")
          );
          await projectArtifact(
            adapters.artifacts,
            result.schema,
            stagedStore.getArtifactPath(id, "prompt/schema")
          );
          if (result.inference) {
            await projectArtifact(
              adapters.artifacts,
              result.inference.visualAnalysis,
              stagedStore.getArtifactPath(id, "inference/visual_analysis")
            );
            await projectArtifact(
              adapters.artifacts,
              result.inference.summary,
              stagedStore.getArtifactPath(id, "inference/summary")
            );
            await projectArtifact(
              adapters.artifacts,
              result.inference.markdown,
              stagedStore.getArtifactPath(id, "output/markdown")
            );
            await projectArtifact(
              adapters.artifacts,
              result.inference.modelUsage,
              join(stagedDirectory, "inference/model_usage.json")
            );
          }
          stagedStore.finalizeArtifacts(
            id,
            metadata,
            transcript.source,
            result.stats,
            options.sourcePlaylist
          );
          const index = store.getIndex();
          const entry = stagedStore.getIndex().media[id];
          index.media[id] = { ...entry, outputPath: relativeDirectory };
          index.lastUpdated = entry.processedAt;
          const indexHandle = await open(indexTemporary, "wx", 0o600);
          try {
            await indexHandle.writeFile(JSON.stringify(index, null, 2));
            await indexHandle.sync();
          } finally {
            await indexHandle.close();
          }
          throwIfAborted(context.signal, "publish");
          if (old) {
            await rename(finalDirectory, backup);
            movedPrevious = true;
          }
          await rename(stagedDirectory, finalDirectory);
          published = true;
          await rename(indexTemporary, join(outputDirectory, "index.json"));
          committed = true;
          const directory = await open(outputDirectory, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          const promptPath = store.getArtifactPath(id, "prompt/summary");
          const summaryPath = result.inference
            ? store.getArtifactPath(id, "output/markdown")
            : undefined;
          return {
            metadata,
            transcript,
            frames,
            promptPath,
            ...(summaryPath ? { summaryPath } : {}),
            outputPath: summaryPath ?? promptPath,
            stats: result.stats,
            reused,
          };
        } catch (error) {
          if (!committed) {
            if (published)
              await rm(finalDirectory, { recursive: true, force: true });
            if (movedPrevious) {
              await rename(backup, finalDirectory);
              movedPrevious = false;
            }
          }
          throw error;
        } finally {
          await rm(staging, { recursive: true, force: true });
          await rm(indexTemporary, { force: true });
          if (committed && movedPrevious)
            await rm(backup, { recursive: true, force: true });
        }
      }
    );
  });
}

export async function importLocalSource(
  file: string,
  options: LocalPipelineOptions
): Promise<MediaSource> {
  const adapters = createLocalAdapters(options);
  const name = basename(file);
  if (!/\.(mp3|mp4)$/i.test(name))
    throw new Error("Unsupported file type. Expected .mp3 or .mp4");
  const asset = await adapters.artifacts.put(
    "input/media",
    createReadStream(resolve(file)),
    name.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "video/mp4"
  );
  return { kind: "asset", asset, name };
}
