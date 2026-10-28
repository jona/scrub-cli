import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactRef,
  OperationContext,
  PipelineDependencies,
  RunRecord,
  VideoResult,
} from "../../src/application/contracts.js";
import { VideoJobService } from "../../src/application/jobs/VideoJobService.js";
import type { VideoInitialization } from "../../src/application/jobs/model.js";
import type {
  VideoJobRepository,
  VideoRuntime,
} from "../../src/application/jobs/ports.js";
import {
  SubmissionPolicy,
  canonicalJobValue,
} from "../../src/application/jobs/submission.js";
import { resolveSettings } from "../../src/application/settings.js";
import { MemoryArtifactStorage } from "../helpers/memory/ArtifactStorage.js";
import { MemoryRunRepository } from "../helpers/memory/RunRepository.js";

describe("completed video retry preservation", () => {
  it("keeps the complete result, published usage, settings, and paid checkpoints when a retry wakes an already completed child", async () => {
    const artifacts = new MemoryArtifactStorage();
    const digest = (value: Uint8Array | string) =>
      createHash("sha256").update(value).digest("hex");
    const publish = async (
      kind: string,
      value: string,
      mediaType = "application/json"
    ): Promise<ArtifactRef> => {
      const bytes = new TextEncoder().encode(value);
      return {
        ...(await artifacts.put(kind, bytes, mediaType)),
        digest: digest(bytes),
      };
    };
    const settings = resolveSettings({
      skipVisuals: false,
      inference: {
        mode: "full",
        summary: { provider: "openai", model: "gpt-6.1-sol" },
        vision: { provider: "openai", model: "gpt-6.1-terra" },
      },
    });
    const initialization: VideoInitialization = {
      requestId: "playlist-request",
      videoId: "aaaaaaaaaaa",
      source: {
        kind: "youtube",
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      },
      settings,
    };
    const metadata = {
      contentId: initialization.videoId,
      title: "Completed source",
      description: "Published work must survive retrying another member",
      duration: 18,
      thumbnailUrl: "",
      source: "YouTube",
      uploadDate: "2026-10-27",
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    };
    const transcript = await publish("transcript/json", '{"fullText":"Done"}');
    const transcriptText = await publish(
      "transcript/text",
      "Done",
      "text/plain"
    );
    const frame = await publish("frames/image", "frame", "image/jpeg");
    const visionStep = `vision:0:5:${frame.digest}`;
    const visualAnalysis = await publish("inference/vision", "[]");
    const summary = await publish("inference/summary", '{"tldr":"Done"}');
    const usage = JSON.stringify({
      calls: 3,
      tokenUsageScope: "validated_checkpoint_responses",
      steps: [
        {
          name: visionStep,
          provider: "openai",
          model: "gpt-6.1-terra",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
        {
          name: "summary:final",
          provider: "openai",
          model: "gpt-6.1-sol",
          usage: { inputTokens: 200, outputTokens: 100 },
        },
      ],
    });
    const modelUsage = await publish("inference/usage", usage);
    const result: VideoResult = {
      mode: "full",
      inference: {
        visualAnalysis,
        summary,
        markdown: await publish("summary/markdown", "# Done", "text/markdown"),
        modelUsage,
      },
      metadata,
      transcript,
      transcriptText,
      frames: [{ timestamp: 5, artifact: frame }],
      framesManifest: await publish("frames/manifest", "[]"),
      metadataArtifact: await publish(
        "metadata/json",
        JSON.stringify(metadata)
      ),
      prompt: await publish("summary/prompt", "Prompt", "text/plain"),
      schema: await publish("summary/schema", '{"type":"object"}'),
      audio: await publish("source/audio", "audio", "audio/wav"),
      video: await publish("source/video", "video", "video/mp4"),
      cacheKey: "immutable-cache-key",
      completedAt: "2026-10-27T03:00:00.000Z",
      warnings: ["An existing warning"],
      stats: {
        downloadTime: 2,
        transcriptionTime: 3,
        frameExtractionTime: 4,
        promptTime: 5,
        totalTime: 21,
        visionTime: 6,
        summarizationTime: 7,
        renderTime: 1,
      },
    };
    const completed: RunRecord = {
      revision: 14,
      status: "completed",
      source: initialization.source,
      settings,
      cacheKey: result.cacheKey,
      startedAt: "2026-10-27T02:00:00.000Z",
      updatedAt: result.completedAt,
      stage: "completed",
      progress: 100,
      attempts: 2,
      cancelRequested: false,
      checkpoints: {
        acquire: { metadata, audio: result.audio, video: result.video },
        transcribe: { transcript, text: transcriptText },
        frames: { frames: result.frames, manifest: result.framesManifest! },
        inference: {
          calls: 3,
          steps: {
            [visionStep]: {
              artifact: visualAnalysis,
              provider: "openai",
              model: "gpt-6.1-terra",
              usage: { inputTokens: 100, outputTokens: 50 },
            },
            "summary:final": {
              artifact: summary,
              provider: "openai",
              model: "gpt-6.1-sol",
              usage: { inputTokens: 200, outputTokens: 100 },
            },
          },
        },
      },
      result,
    };
    const before = structuredClone(completed);
    const initialSettings = structuredClone(initialization);
    const runs = new MemoryRunRepository(completed);
    let cancelRequested = false;
    const repository: VideoJobRepository = {
      runs,
      getInitialization: async () => initialization,
      initialize: vi.fn(async () => initialization),
      getCancellationRequested: async () => cancelRequested,
      updateCancellation: async (requested, change) => {
        const changed = change(await runs.get());
        cancelRequested = requested;
        if (changed) await runs.update(() => changed);
        return changed;
      },
    };
    const runtime: VideoRuntime = {
      wake: vi.fn(async () => undefined),
      isActive: () => false,
      abort: vi.fn(),
    };
    const service = new VideoJobService({
      repository,
      runtime,
      policy: new SubmissionPolicy({
        requestDefault: 2,
        inferenceDefaults: settings.inference!,
      }),
      environment: {
        now: () => Date.parse("2026-10-28T03:00:00.000Z"),
        fingerprint: canonicalJobValue,
      },
    });
    const unexpectedWork = vi.fn(async (): Promise<never> => {
      throw new Error("Completed work must not execute again");
    });
    const supports = vi.fn(() => true);
    const resolveModels = vi.fn(async () => ({
      supports,
      generate: unexpectedWork,
    }));
    const dependencies: PipelineDependencies = {
      runs,
      artifacts,
      models: { supports, generate: unexpectedWork },
      media: { acquire: unexpectedWork, extractFrames: unexpectedWork },
      transcriber: { transcribe: unexpectedWork },
    };
    const storageCalls = [
      vi.spyOn(artifacts, "put"),
      vi.spyOn(artifacts, "read"),
      vi.spyOn(artifacts, "has"),
      vi.spyOn(artifacts, "readRange"),
    ];
    const context: OperationContext = {
      runId: `${initialization.requestId}/${initialization.videoId}`,
      attemptId: "manual-retry",
      now: () => 1_800_000_000_000,
      signal: new AbortController().signal,
      emit: vi.fn(),
    };

    expect(await service.retry()).toEqual({
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 2,
    });
    await service.execute(dependencies, context, resolveModels);

    expect(await runs.get()).toEqual(before);
    expect(await service.getResult()).toEqual(before.result);
    expect(initialization).toEqual(initialSettings);
    expect(digest(JSON.stringify(await service.getResult()))).toBe(
      digest(JSON.stringify(before.result))
    );
    expect(unexpectedWork).not.toHaveBeenCalled();
    expect(supports).not.toHaveBeenCalled();
    expect(resolveModels).not.toHaveBeenCalled();
    expect(repository.initialize).not.toHaveBeenCalled();
    for (const call of storageCalls) expect(call).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalled();
    expect(runtime.wake).toHaveBeenNthCalledWith(1, "immediate");
    expect(runtime.wake).toHaveBeenNthCalledWith(2, "stop");
    const publishedUsage = await artifacts.readRange(
      modelUsage,
      0,
      modelUsage.size
    );
    expect(digest(publishedUsage)).toBe(modelUsage.digest);
    expect(new TextDecoder().decode(publishedUsage)).toBe(usage);
  });
});
