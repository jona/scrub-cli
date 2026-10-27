import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CliDependencies } from "../../../entrypoints/cli/dependencies.js";
import type {
  ArtifactRef,
  ArtifactStorage,
  MediaSource,
  OperationContext,
} from "../../../application/contracts.js";
import type {
  MediaMetadata,
  TranscriptionResult,
  VisualAnalysis,
} from "../../../core/models.js";
import {
  acquireMediaStage,
  transcribeAudioStage,
  extractFramesStage,
  buildPromptStage,
  renderSummaryStage,
  transcriptContent,
  validateTranscript,
} from "../../../application/stages.js";
import {
  readArtifactBytes,
  readArtifactJson,
} from "../../../application/artifact-io.js";
import { resolveSettings } from "../../../application/settings.js";
import { canonicalizeYouTubeVideo } from "../../../core/source.js";
import { PipelineError } from "../../../core/errors.js";
import { SUMMARY_SCHEMA } from "../../../core/summary-template.js";
import { buildLocalMetadata, generateContentId } from "../prepare.js";
import { createLocalAdapters, importLocalSource } from "./pipeline.js";

type StageBindings = Pick<
  CliDependencies,
  | "download"
  | "prepare"
  | "transcribe"
  | "extractFrames"
  | "buildPromptArtifacts"
  | "renderSummaryFile"
>;
const context = (): OperationContext => ({
  runId: "cli-stage",
  attemptId: randomUUID(),
  signal: new AbortController().signal,
  now: Date.now,
  emit: () => undefined,
});
const metadataFor = (file: string): MediaMetadata => ({
  contentId: "unknown",
  title: basename(file, extname(file)),
  description: "",
  duration: 0,
  thumbnailUrl: "",
  source: "File",
  uploadDate: "",
  url: file,
});
async function readText(path: string, maximum: number): Promise<string> {
  if ((await stat(path)).size > maximum)
    throw new PipelineError(
      "resource_limit",
      "Stage input exceeds the configured byte limit"
    );
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > maximum)
    throw new PipelineError(
      "resource_limit",
      "Stage input exceeds the configured byte limit"
    );
  return text;
}
async function exportFile(
  storage: ArtifactStorage,
  ref: ArtifactRef,
  path: string
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.from(storage.read(ref)), createWriteStream(path));
  return path;
}

/** Path I/O belongs here; processing and validation belong to application stages. */
export function createCliStages(): StageBindings {
  return {
    async download(url, options) {
      const adapters = createLocalAdapters({
        skipVisuals: options.skipVideo ?? false,
      });
      options.onProgress?.("Downloading media...");
      const result = await acquireMediaStage(
        { kind: "youtube", url: canonicalizeYouTubeVideo(url) },
        adapters.settings,
        adapters,
        context()
      );
      const output = resolve(options.outputDir);
      return {
        metadata: result.metadata,
        audioPath: await exportFile(
          adapters.artifacts,
          result.audio,
          join(output, "audio.wav")
        ),
        videoPath: result.video
          ? await exportFile(
              adapters.artifacts,
              result.video,
              join(output, "video.mp4")
            )
          : "",
        cacheDir: output,
      };
    },
    async prepare(file, options) {
      const skipVisuals =
        extname(file).toLowerCase() === ".mp3" || (options.skipVideo ?? false);
      const adapters = createLocalAdapters({ skipVisuals });
      const source = await importLocalSource(file, { skipVisuals });
      options.onProgress?.("Preparing media...");
      const result = await acquireMediaStage(
        source,
        adapters.settings,
        adapters,
        context()
      );
      const output = resolve(options.outputDir);
      return {
        metadata: buildLocalMetadata(
          file,
          generateContentId(file),
          result.metadata.duration
        ),
        audioPath: await exportFile(
          adapters.artifacts,
          result.audio,
          join(output, "audio.wav")
        ),
        videoPath: result.video ? resolve(file) : "",
        cacheDir: output,
      };
    },
    async transcribe(file, options) {
      const adapters = createLocalAdapters({ transcriber: options?.adapter });
      const settings = resolveSettings({
        ...adapters.settings,
        transcription: {
          ...adapters.settings.transcription,
          ...(options?.language ? { language: options.language } : {}),
          ...(options?.model ? { model: options.model } : {}),
        },
      });
      const audio = await adapters.artifacts.put(
        "source/audio",
        createReadStream(resolve(file)),
        "audio/wav"
      );
      const source: MediaSource = options?.youtubeUrl
        ? { kind: "youtube", url: canonicalizeYouTubeVideo(options.youtubeUrl) }
        : { kind: "asset", asset: audio, name: basename(file) };
      options?.onProgress?.("Transcribing audio...");
      const result = await transcribeAudioStage(
        { audio, source },
        settings,
        adapters,
        context()
      );
      if (options?.outputText) {
        await mkdir(dirname(resolve(options.outputText)), { recursive: true });
        await writeFile(options.outputText, result.value.fullText);
      }
      return result.value;
    },
    async extractFrames(file, options) {
      const adapters = createLocalAdapters({
        skipVisuals: false,
        sceneThreshold: options.threshold,
        maxFrames: options.maxFrames,
      });
      const settings = resolveSettings({
        ...adapters.settings,
        minFrameInterval: options.minInterval ?? 2,
      });
      const video = await adapters.artifacts.put(
        "source/video",
        createReadStream(resolve(file)),
        "video/mp4"
      );
      options.onProgress?.("Extracting key frames...");
      const { frames } = await extractFramesStage(
        video,
        settings,
        adapters,
        context()
      );
      return Promise.all(
        frames.map(async (frame, index) => ({
          timestamp: frame.timestamp,
          framePath: await exportFile(
            adapters.artifacts,
            frame.artifact,
            join(
              resolve(options.outputDir),
              `frame_${String(index + 1).padStart(3, "0")}.png`
            )
          ),
          ...(frame.score === undefined ? {} : { score: frame.score }),
        }))
      );
    },
    async buildPromptArtifacts(file, options) {
      const adapters = createLocalAdapters();
      const raw = await readText(
        file,
        adapters.settings.limits.maxArtifactBytes
      );
      let content = raw;
      if (extname(file).toLowerCase() === ".json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* Plain-text JSON input is supported. */
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as TranscriptionResult).segments)
        ) {
          validateTranscript(parsed, adapters.settings);
          content = transcriptContent(parsed);
        } else if (parsed !== undefined)
          content = JSON.stringify(parsed, null, 2);
      }
      const metadata: MediaMetadata = options?.metadataPath
        ? JSON.parse(
            await readText(
              options.metadataPath,
              adapters.settings.limits.maxArtifactBytes
            )
          )
        : metadataFor(file);
      const visuals: VisualAnalysis[] = options?.visualsPath
        ? JSON.parse(
            await readText(
              options.visualsPath,
              adapters.settings.limits.maxArtifactBytes
            )
          )
        : [];
      options?.onProgress?.("Assembling summary prompt...");
      const result = await buildPromptStage(
        { metadata, content, visuals },
        adapters,
        context(),
        adapters.settings.limits.maxTranscriptCharacters
      );
      return {
        prompt: new TextDecoder().decode(
          await readArtifactBytes(
            adapters.artifacts,
            result.prompt,
            adapters.settings.limits.maxArtifactBytes
          )
        ),
        schema: await readArtifactJson<typeof SUMMARY_SCHEMA>(
          adapters.artifacts,
          result.schema
        ),
        metadata,
      };
    },
    async renderSummaryFile(file, options) {
      const adapters = createLocalAdapters();
      const summary: unknown = JSON.parse(
        await readText(file, adapters.settings.limits.maxArtifactBytes)
      );
      const metadata: MediaMetadata = options?.metadataPath
        ? JSON.parse(
            await readText(
              options.metadataPath,
              adapters.settings.limits.maxArtifactBytes
            )
          )
        : {
            ...metadataFor(file),
            title:
              (summary as { title?: string })?.title || metadataFor(file).title,
          };
      const transcript: TranscriptionResult | undefined =
        options?.transcriptPath
          ? JSON.parse(
              await readText(
                options.transcriptPath,
                adapters.settings.limits.maxArtifactBytes
              )
            )
          : undefined;
      if (transcript) validateTranscript(transcript, adapters.settings);
      options?.onProgress?.("Rendering markdown...");
      const ref = await renderSummaryStage(
        {
          metadata,
          summary,
          transcript,
          generatedAt: options?.generatedAt,
          includeFullTranscript: options?.includeFullTranscript,
        },
        adapters,
        context(),
        adapters.settings
      );
      return new TextDecoder().decode(
        await readArtifactBytes(
          adapters.artifacts,
          ref,
          adapters.settings.limits.maxArtifactBytes
        )
      );
    },
  };
}
