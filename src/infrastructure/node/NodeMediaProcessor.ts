import { basename, extname, join } from "node:path";
import type {
  ArtifactRef,
  ArtifactStorage,
  FrameArtifact,
  MediaProcessor,
  MediaSource,
  OperationContext,
  PipelineSettings,
  PreparedMedia,
} from "../../application/contracts.js";
import { PipelineError, throwIfAborted } from "../../core/errors.js";
import { download, fetchYouTubeMetadata } from "./download.js";
import { prepare } from "./prepare.js";
import { extractFrames } from "./extract-frames.js";
import {
  inWorkspace,
  materialize,
  publishFile,
  withNativeDeadline,
} from "./staging.js";
import type {
  NativeOperationOptions,
  NativeRuntimeOptions,
} from "./runtime.js";

export class NodeMediaProcessor implements MediaProcessor {
  constructor(
    private readonly artifacts: ArtifactStorage,
    private readonly runtime: NativeRuntimeOptions
  ) {}
  private operation(
    settings: PipelineSettings,
    context: OperationContext
  ): NativeOperationOptions {
    return {
      runtime: this.runtime,
      signal: context.signal,
      timeoutMs: settings.limits.stageTimeoutMs,
      maxDurationSeconds: settings.limits.maxDurationSeconds,
      maxSourceBytes: settings.limits.maxSourceBytes,
      maxArtifactBytes: settings.limits.maxArtifactBytes,
      diagnosticContext: { runId: context.runId, attemptId: context.attemptId },
    };
  }
  async acquire(
    source: MediaSource,
    settings: PipelineSettings,
    context: OperationContext
  ): Promise<PreparedMedia> {
    return withNativeDeadline(
      context,
      settings.limits.stageTimeoutMs,
      "acquire",
      async (context) => {
        const operation = this.operation(settings, context);
        return inWorkspace(
          this.runtime.stagingRoot,
          context,
          async (directory) => {
            let prepared;
            if (source.kind === "youtube") {
              const metadata = await fetchYouTubeMetadata(
                source.url,
                operation
              );
              if (metadata.duration > settings.limits.maxDurationSeconds)
                throw new PipelineError(
                  "resource_limit",
                  "Media duration exceeds the configured limit"
                );
              prepared = await download(source.url, {
                ...operation,
                outputDir: directory,
                skipVideo: settings.skipVisuals,
                metadata,
              });
            } else {
              const extension = extname(source.name).toLowerCase();
              if (extension !== ".mp3" && extension !== ".mp4")
                throw new PipelineError(
                  "invalid_input",
                  "Expected MP3 or MP4 media"
                );
              const path = join(directory, `input${extension}`);
              await materialize(
                this.artifacts,
                source.asset,
                path,
                settings.limits.maxSourceBytes,
                context
              );
              prepared = await prepare(path, {
                ...operation,
                outputDir: directory,
                skipVideo: settings.skipVisuals,
              });
              prepared.metadata = {
                ...prepared.metadata,
                contentId: source.asset.digest ?? source.asset.id,
                title: basename(source.name, extension),
                description: "",
                url: `artifact:${source.asset.id}`,
                uploadDate: "",
              };
            }
            throwIfAborted(context.signal);
            const audio = await publishFile(
              this.artifacts,
              prepared.audioPath,
              "source/audio",
              "audio/wav",
              settings.limits.maxArtifactBytes,
              context
            );
            const video = prepared.videoPath
              ? await publishFile(
                  this.artifacts,
                  prepared.videoPath,
                  "source/video",
                  "video/mp4",
                  settings.limits.maxSourceBytes,
                  context
                )
              : undefined;
            return {
              metadata: prepared.metadata,
              audio,
              ...(video ? { video } : {}),
              ...(!settings.skipVisuals && !video
                ? {
                    warnings: [
                      "Video was unavailable; visual extraction was skipped",
                    ],
                  }
                : {}),
            };
          }
        );
      }
    );
  }
  async extractFrames(
    video: ArtifactRef,
    settings: PipelineSettings,
    context: OperationContext,
    sourceDurationSeconds?: number
  ): Promise<FrameArtifact[]> {
    return withNativeDeadline(
      context,
      settings.limits.stageTimeoutMs,
      "frames",
      async (context) => {
        return inWorkspace(
          this.runtime.stagingRoot,
          context,
          async (directory) => {
            const input = join(directory, "video.mp4");
            await materialize(
              this.artifacts,
              video,
              input,
              settings.limits.maxSourceBytes,
              context
            );
            const frames = await extractFrames(input, {
              ...this.operation(settings, context),
              outputDir: join(directory, "frames"),
              threshold: settings.sceneThreshold,
              maxFrames: settings.maxFrames,
              minInterval: settings.minFrameInterval,
              ensureFrame: settings.inference?.mode === "full",
              sourceDurationSeconds,
            });
            const result: FrameArtifact[] = [];
            for (const frame of frames) {
              result.push({
                timestamp: frame.timestamp,
                artifact: await publishFile(
                  this.artifacts,
                  frame.framePath,
                  "frame",
                  "image/png",
                  settings.limits.maxArtifactBytes,
                  context
                ),
                ...(frame.score === undefined ? {} : { score: frame.score }),
              });
            }
            return result;
          }
        );
      }
    );
  }
}
