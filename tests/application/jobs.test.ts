import { describe, expect, it, vi } from "vitest";
import { RequestService } from "../../src/application/jobs/RequestService.js";
import { RequestCoordinator } from "../../src/application/jobs/RequestCoordinator.js";
import { VideoJobService } from "../../src/application/jobs/VideoJobService.js";
import {
  SubmissionPolicy,
  canonicalJobValue,
  normalizeJobSubmission,
} from "../../src/application/jobs/submission.js";
import type {
  JobRequestRecord,
  JobMember,
  VideoInitialization,
  VideoJobStatus,
} from "../../src/application/jobs/model.js";
import type {
  JobRequestRepository,
  RequestRuntime,
  VideoJobControl,
  VideoJobRepository,
  VideoRuntime,
} from "../../src/application/jobs/ports.js";
import type {
  OperationContext,
  RunRepository,
  SourceCatalog,
  VideoResult,
} from "../../src/application/contracts.js";
import { resolveSettings } from "../../src/application/settings.js";
import { PipelineError } from "../../src/core/errors.js";
import { MemoryRunRepository } from "../helpers/memory/RunRepository.js";
import { MemoryArtifactStorage } from "../helpers/memory/ArtifactStorage.js";

const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
const at = () => 1_800_000_000_000;
const operation = (): OperationContext => ({
  runId: "request",
  attemptId: "1",
  signal: new AbortController().signal,
  now: at,
  emit: () => undefined,
});

function cancellationState(runs: RunRepository) {
  let requested = false;
  return {
    getCancellationRequested: async () => requested,
    updateCancellation: vi.fn<VideoJobRepository["updateCancellation"]>(
      async (nextRequested, change) => {
        const next = change(await runs.get());
        requested = nextRequested;
        if (next) await runs.update(() => next);
        return next;
      }
    ),
  };
}

function fixture() {
  const persisted: { request: JobRequestRecord | null; members: JobMember[] } =
    { request: null, members: [] };
  const repository: JobRequestRepository = {
    get: async () => structuredClone(persisted.request),
    update: async (change) => {
      persisted.request = structuredClone(
        change(structuredClone(persisted.request))
      );
      return structuredClone(persisted.request);
    },
    appendMember: async (input, maximum) => {
      if (
        persisted.request?.cancelRequested ||
        persisted.members.length >= maximum ||
        persisted.members.some((member) => member.videoId === input.videoId)
      )
        return;
      const position = persisted.members.length + 1;
      persisted.members.push({
        ...input,
        position,
        status: "queued",
        started: false,
        details: { ...input, position, status: "queued" },
      });
    },
    members: async (query = {}) =>
      structuredClone(
        persisted.members
          .filter(
            (member) =>
              (query.started === undefined ||
                member.started === query.started) &&
              (!query.statuses || query.statuses.includes(member.status))
          )
          .slice(
            query.offset ?? 0,
            query.limit === undefined
              ? undefined
              : (query.offset ?? 0) + query.limit
          )
      ),
    updateMember: async (member) => {
      persisted.members[
        persisted.members.findIndex((item) => item.videoId === member.videoId)
      ] = structuredClone(member);
    },
    cancelPending: async () => {
      for (const member of persisted.members)
        if (!member.started && member.status === "queued")
          member.status = "cancelled";
    },
  };
  const statuses = new Map<string, VideoJobStatus>();
  const results = new Map<string, VideoResult>();
  const initialize = vi.fn<VideoJobControl["initialize"]>(async (key) => {
    if (!statuses.has(key.videoId))
      statuses.set(key.videoId, {
        status: "queued",
        stage: "queued",
        progress: 0,
        attempts: 0,
      });
    return statuses.get(key.videoId)!;
  });
  const cancel = vi.fn<VideoJobControl["cancel"]>(async (key) => {
    const status: VideoJobStatus = {
      status: "cancelled",
      stage: "cancelled",
      progress: 0,
      attempts: 0,
    };
    statuses.set(key.videoId, status);
    return status;
  });
  const videos: VideoJobControl = {
    initialize,
    cancel,
    getStatus: async (key) => statuses.get(key.videoId) ?? null,
    getResult: async (key) => results.get(key.videoId) ?? null,
    retry: async (key) => {
      const status: VideoJobStatus = {
        status: "queued",
        stage: "queued",
        progress: 0,
        attempts: 0,
      };
      statuses.set(key.videoId, status);
      return status;
    },
    readArtifact: async () => ({
      bytes: new Uint8Array(),
      mediaType: "text/plain",
      size: 0,
    }),
  };
  const events: string[] = [];
  const runtime: RequestRuntime = {
    scheduleReconcile: async (reason) => {
      events.push(`reconcile:${reason}`);
    },
    wakeEnumeration: async (reason) => {
      events.push(`enumerate:${reason}`);
    },
    isEnumerationActive: () => false,
    abortEnumeration: vi.fn(),
  };
  const environment = { now: at, fingerprint: canonicalJobValue };
  const policy = new SubmissionPolicy({
    requestDefault: 2,
    inferenceDefaults: { mode: "preprocess" },
  });
  const options = { repository, videos, runtime, environment, policy };
  const catalog = (entries = ids): SourceCatalog => ({
    enumerate: async () => ({
      metadata: {
        title: "Playlist",
        description: "",
        channel: "Fixture",
        videoCount: entries.length,
        url: "https://youtube.com/playlist?list=PLfixture",
      },
      entries: (async function* () {
        for (const videoId of entries)
          yield {
            id: videoId,
            title: videoId,
            url: `https://youtu.be/${videoId}`,
          };
      })(),
    }),
  });
  return {
    persisted,
    repository,
    options,
    catalog,
    statuses,
    initialize,
    cancel,
    events,
    service: new RequestService(options),
    coordinator: new RequestCoordinator(options),
  };
}

describe("portable job services", () => {
  it("preserves omitted intent, freezes idempotent defaults, and rejects conflicting input", async () => {
    expect(
      normalizeJobSubmission({
        url: `https://youtu.be/${ids[0]}`,
        settings: {
          inference: { summary: { provider: "openai", model: "allowed" } },
        },
      })
    ).toEqual({
      url: `https://www.youtube.com/watch?v=${ids[0]}`,
      settings: {
        inference: { summary: { provider: "openai", model: "allowed" } },
      },
    });
    const f = fixture();
    const input = { url: `https://youtu.be/${ids[0]}` };
    await f.service.start("request", input);
    const initial = structuredClone(f.persisted.request);
    const changed = new RequestService({
      ...f.options,
      policy: new SubmissionPolicy({
        requestDefault: 6,
        inferenceDefaults: {
          mode: "full",
          summary: { provider: "new", model: "summary" },
          vision: { provider: "new", model: "vision" },
        },
      }),
    });
    await changed.start("request", input);
    expect(f.persisted.request).toEqual(initial);
    await expect(
      changed.start("request", { ...input, concurrency: 3 })
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("enforces resource and inference policy before accepting work", async () => {
    const f = fixture();
    await expect(
      f.service.start("request", {
        url: `https://youtu.be/${ids[0]}`,
        settings: { limits: { maxArtifactBytes: 1024 * 1024 * 1024 } },
      })
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(f.persisted.request).toBeNull();
    expect(f.initialize).not.toHaveBeenCalled();
    const policy = new SubmissionPolicy({
      requestDefault: 1,
      inferenceDefaults: {
        mode: "full",
        summary: { provider: "allowed", model: "summary" },
        vision: { provider: "allowed", model: "vision" },
      },
      assertReady: async () => {
        throw new PipelineError("capability_unavailable", "No model");
      },
    });
    await expect(
      new RequestService({ ...f.options, policy }).start("request", {
        url: `https://youtu.be/${ids[0]}`,
      })
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(f.persisted.request).toBeNull();
  });

  it("uses lowered deployment resource defaults and freezes them for an idempotent replay", async () => {
    const f = fixture();
    const policy = new SubmissionPolicy({
      requestDefault: 2,
      inferenceDefaults: { mode: "preprocess" },
      resourceCeilings: { maxSourceBytes: 1024, maxAttempts: 2 },
    });
    const request = { url: `https://youtu.be/${ids[0]}` };
    const service = new RequestService({ ...f.options, policy });
    await service.start("request", request);
    expect(f.persisted.request?.settings.limits).toMatchObject({
      maxSourceBytes: 1024,
      maxAttempts: 2,
    });
    const before = structuredClone(f.persisted.request);
    const changed = new SubmissionPolicy({
      requestDefault: 8,
      inferenceDefaults: { mode: "preprocess" },
      resourceCeilings: { maxSourceBytes: 2048, maxAttempts: 3 },
    });
    await new RequestService({ ...f.options, policy: changed }).start(
      "request",
      request
    );
    expect(f.persisted.request).toEqual(before);
    expect(() =>
      policy.resolve({
        ...request,
        settings: { limits: { maxSourceBytes: 1025 } },
      })
    ).toThrow("exceeds server policy");
  });

  it("recovers partial enumeration from persisted membership without duplicate positions", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
      maxVideos: 2,
    });
    const failed: SourceCatalog = {
      enumerate: async () => ({
        metadata: {
          title: "Playlist",
          description: "",
          channel: "Fixture",
          videoCount: 2,
          url: "https://youtube.com/playlist?list=PLfixture",
        },
        entries: (async function* () {
          expect(f.events).toContain("enumerate:recovery");
          yield {
            id: ids[0],
            title: "first",
            url: `https://youtu.be/${ids[0]}`,
          };
          throw new PipelineError("timeout", "Catalog retry", {
            retryable: true,
          });
        })(),
      }),
    };
    await f.coordinator.enumerate(failed, operation());
    expect(f.persisted.request).toMatchObject({
      status: "queued",
      enumerated: false,
      enumerationAttempts: 1,
    });
    expect(f.persisted.members.map((member) => member.videoId)).toEqual([
      ids[0],
    ]);
    const restarted = new RequestCoordinator(f.options);
    await restarted.enumerate(f.catalog([ids[0], ids[1], ids[2]]), operation());
    expect(
      f.persisted.members.map(({ videoId, position }) => ({
        videoId,
        position,
      }))
    ).toEqual([
      { videoId: ids[0], position: 1 },
      { videoId: ids[1], position: 2 },
    ]);
    expect(f.persisted.request).toMatchObject({
      enumerated: true,
      enumerationAttempts: 2,
    });
  });

  it("schedules bounded children and aggregates partial results through the same coordinator", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
    });
    await f.coordinator.enumerate(f.catalog(), operation());
    await f.coordinator.reconcile();
    expect(f.initialize).toHaveBeenCalledTimes(2);
    f.statuses.set(ids[0], {
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 1,
    });
    f.statuses.set(ids[1], {
      status: "failed",
      stage: "transcribe",
      progress: 30,
      attempts: 3,
      failure: {
        code: "processing_failed",
        message: "Failure",
        retryable: false,
      },
    });
    await f.coordinator.reconcile();
    expect(f.initialize).toHaveBeenCalledTimes(3);
    f.statuses.set(ids[2], {
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 1,
    });
    expect(await f.coordinator.reconcile()).toMatchObject({
      status: "completed_with_errors",
      total: 3,
      completed: 2,
      failed: 1,
    });
    expect(
      (await f.service.getResults(1, 1)).items.map((item) => item.videoId)
    ).toEqual([ids[1]]);
  });

  it("durably fails an accepted child rejected by a lowered deployment policy", async () => {
    const f = fixture();
    await f.service.start("request", { url: `https://youtu.be/${ids[0]}` });
    await f.coordinator.enumerate(f.catalog([ids[0]]), operation());
    let initialization: VideoInitialization | null = null;
    const runs = new MemoryRunRepository();
    const child = new VideoJobService({
      repository: {
        runs,
        ...cancellationState(runs),
        getInitialization: async () => initialization,
        initialize: async (input) => (initialization ??= input),
      },
      runtime: { wake: vi.fn(), isActive: () => false, abort: vi.fn() },
      policy: new SubmissionPolicy({
        requestDefault: 1,
        inferenceDefaults: { mode: "preprocess" },
        resourceCeilings: { maxSourceBytes: 1024 },
      }),
      environment: f.options.environment,
    });
    f.initialize.mockImplementation((_key, input) => child.initialize(input));
    expect(await f.coordinator.reconcile()).toMatchObject({
      status: "failed",
      total: 1,
      failed: 1,
    });
    expect(initialization).toBeNull();
    expect(f.persisted.members[0]).toMatchObject({
      started: false,
      status: "failed",
      details: {
        stage: "initialize",
        failure: { code: "resource_limit", retryable: false },
      },
    });
    await new RequestCoordinator(f.options).reconcile();
    expect(f.initialize).toHaveBeenCalledOnce();
    expect(f.persisted.request?.settings.limits.maxSourceBytes).toBe(
      512 * 1024 * 1024
    );
  });

  it("continues other children after a permanent initialization capability rejection", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
      continueOnError: true,
    });
    await f.coordinator.enumerate(f.catalog(ids.slice(0, 2)), operation());
    f.initialize.mockRejectedValueOnce(
      new PipelineError("capability_unavailable", "Model configuration changed")
    );
    f.initialize.mockResolvedValueOnce({
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 1,
    });
    expect(await f.coordinator.reconcile()).toMatchObject({
      status: "completed_with_errors",
      completed: 1,
      failed: 1,
    });
    expect(f.initialize).toHaveBeenCalledTimes(2);
    expect((await f.service.getResults(0, 2)).items[0].failure).toMatchObject({
      code: "capability_unavailable",
      retryable: false,
    });
  });

  it("never abandons a child when initialization commits before its acknowledgment fails", async () => {
    const f = fixture();
    await f.service.start("request", { url: `https://youtu.be/${ids[0]}` });
    await f.coordinator.enumerate(f.catalog([ids[0]]), operation());
    let initialization: VideoInitialization | null = null;
    let interrupted = false;
    const runs = new MemoryRunRepository();
    const repository: VideoJobRepository = {
      runs,
      ...cancellationState(runs),
      getInitialization: async () => initialization,
      initialize: async (input) => {
        initialization ??= input;
        if (!interrupted) {
          interrupted = true;
          throw new PipelineError("resource_limit", "Commit reply was lost");
        }
        return initialization;
      },
    };
    const child = new VideoJobService({
      repository,
      runtime: { wake: vi.fn(), isActive: () => false, abort: vi.fn() },
      policy: f.options.policy,
      environment: f.options.environment,
    });
    f.initialize.mockImplementation((_key, input) => child.initialize(input));
    await expect(f.coordinator.reconcile()).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(initialization).not.toBeNull();
    expect(f.persisted.members[0]).toMatchObject({
      status: "queued",
      started: true,
      details: { stage: "initialize" },
    });
    await new RequestCoordinator(f.options).reconcile();
    expect(f.persisted.members[0]).toMatchObject({
      status: "queued",
      started: true,
    });
    expect(f.initialize).toHaveBeenCalledTimes(2);
  });

  it("applies fail-fast immediately when a selected child cannot initialize", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
      concurrency: 3,
      continueOnError: false,
    });
    await f.coordinator.enumerate(f.catalog(), operation());
    f.initialize.mockResolvedValueOnce({
      status: "running",
      stage: "download",
      progress: 1,
      attempts: 1,
    });
    f.initialize.mockRejectedValueOnce(
      new PipelineError("resource_limit", "Server limits changed")
    );
    expect(await f.coordinator.reconcile()).toMatchObject({
      total: 3,
      failed: 1,
      cancelled: 2,
    });
    expect(f.initialize).toHaveBeenCalledTimes(2);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
      requestId: "request",
      videoId: ids[0],
    });
    expect(f.persisted.members[2]).toMatchObject({
      status: "cancelled",
      started: false,
    });
  });

  it.each([
    new PipelineError("unavailable", "Coordination is unavailable"),
    new PipelineError("resource_limit", "Temporary admission limit", {
      retryable: true,
    }),
    new Error("Initialization response was lost"),
  ])(
    "keeps uncertain initialization pending for idempotent reconciliation: %s",
    async (failure) => {
      const f = fixture();
      await f.service.start("request", { url: `https://youtu.be/${ids[0]}` });
      await f.coordinator.enumerate(f.catalog([ids[0]]), operation());
      f.initialize.mockImplementationOnce(async (key) => {
        f.statuses.set(key.videoId, {
          status: "completed",
          stage: "completed",
          progress: 100,
          attempts: 1,
        });
        throw failure;
      });
      await expect(f.coordinator.reconcile()).rejects.toBe(failure);
      expect(f.persisted.members[0]).toMatchObject({
        status: "queued",
        started: true,
        details: { stage: "initialize" },
      });
      expect(f.events).toContain("reconcile:poll");
      expect(await new RequestCoordinator(f.options).reconcile()).toMatchObject(
        {
          status: "completed",
          completed: 1,
        }
      );
      expect(f.initialize).toHaveBeenCalledOnce();
    }
  );

  it("keeps cancellation when it races a permanent initialization rejection", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
      concurrency: 1,
    });
    await f.coordinator.enumerate(f.catalog(), operation());
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reject!: (error: unknown) => void;
    f.initialize.mockImplementationOnce(async () => {
      entered();
      return new Promise((_resolve, rejectInitialization) => {
        reject = rejectInitialization;
      });
    });
    const reconciling = f.coordinator.reconcile();
    await started;
    await f.service.cancel();
    reject(new PipelineError("resource_limit", "Server limits changed"));
    await reconciling;
    expect(await f.service.getStatus()).toMatchObject({
      status: "cancelled",
      cancelled: 3,
      failed: 0,
    });
    expect(f.initialize).toHaveBeenCalledOnce();
  });

  it("cancels delayed initialization despite a lost reply and permits only explicit retry", async () => {
    const f = fixture();
    await f.service.start("request", { url: `https://youtu.be/${ids[0]}` });
    await f.coordinator.enumerate(f.catalog([ids[0]]), operation());
    const runs = new MemoryRunRepository();
    const cancellation = cancellationState(runs);
    let initialization: VideoInitialization | null = null;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake = vi.fn<VideoRuntime["wake"]>(async () => undefined);
    const child = new VideoJobService({
      repository: {
        runs,
        ...cancellation,
        getInitialization: async () => initialization,
        initialize: async (input) => {
          entered();
          await delayed;
          if (await cancellation.getCancellationRequested()) return null;
          return (initialization ??= input);
        },
      },
      runtime: { wake, isActive: () => false, abort: vi.fn() },
      policy: f.options.policy,
      environment: f.options.environment,
    });
    let loseReply = true;
    f.initialize.mockImplementation(async (_key, input) => {
      const status = await child.initialize(input);
      if (loseReply) {
        loseReply = false;
        throw new Error("Initialization reply was lost");
      }
      return status;
    });
    f.cancel.mockImplementation(() => child.cancel());
    f.options.videos.getStatus = () => child.getStatus();
    f.options.videos.retry = () => child.retry();
    const reconciling = f.coordinator.reconcile();
    await started;
    expect(f.persisted.members[0]).toMatchObject({
      started: true,
      details: { stage: "initialize" },
    });
    expect(await f.service.cancel()).toMatchObject({
      status: "cancelled",
      cancelled: 1,
    });
    release();
    await reconciling;
    expect(initialization).toBeNull();
    expect(await child.prepareAttempt()).toBeNull();
    expect(wake.mock.calls.every(([reason]) => reason === "stop")).toBe(true);
    expect(await new RequestCoordinator(f.options).reconcile()).toMatchObject({
      status: "cancelled",
    });
    expect(f.initialize).toHaveBeenCalledOnce();
    await f.service.retry();
    await f.coordinator.reconcile();
    expect(initialization).not.toBeNull();
    expect(await child.getStatus()).toMatchObject({ status: "queued" });
    expect(f.initialize).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledWith("immediate");
  });

  it("cancellation wins when it races child initialization and prevents later dispatch", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
      concurrency: 1,
    });
    await f.coordinator.enumerate(f.catalog(), operation());
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (value: VideoJobStatus) => void;
    f.initialize.mockImplementationOnce(async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const reconciling = f.coordinator.reconcile();
    await entered;
    await f.service.cancel();
    release({ status: "queued", stage: "queued", progress: 0, attempts: 0 });
    await reconciling;
    expect(f.cancel).toHaveBeenCalledWith({
      requestId: "request",
      videoId: ids[0],
    });
    expect(f.initialize).toHaveBeenCalledOnce();
    expect(await f.service.getStatus()).toMatchObject({
      status: "cancelled",
      cancelled: 3,
    });
    expect(
      f.persisted.members.every((member) => member.status === "cancelled")
    ).toBe(true);
  });

  it("cancels an interrupted enumeration without publishing later members", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
    });
    let first!: () => void;
    const entered = new Promise<void>((resolve) => {
      first = resolve;
    });
    let proceed!: () => void;
    const paused = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const catalog: SourceCatalog = {
      enumerate: async () => ({
        metadata: {
          title: "Playlist",
          description: "",
          channel: "Fixture",
          videoCount: 2,
          url: "https://youtube.com/playlist?list=PLfixture",
        },
        entries: (async function* () {
          yield {
            id: ids[0],
            title: "first",
            url: `https://youtu.be/${ids[0]}`,
          };
          first();
          await paused;
          yield {
            id: ids[1],
            title: "second",
            url: `https://youtu.be/${ids[1]}`,
          };
        })(),
      }),
    };
    const enumerating = f.coordinator.enumerate(catalog, operation());
    await entered;
    await f.service.cancel();
    proceed();
    await enumerating;
    expect(f.persisted.members.map((member) => member.videoId)).toEqual([
      ids[0],
    ]);
    expect(await f.service.getStatus()).toMatchObject({
      status: "cancelled",
      total: 1,
      cancelled: 1,
    });
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("enumerate:stop");
  });

  it("retries only failed members and keeps completed children intact", async () => {
    const f = fixture();
    await f.service.start("request", {
      url: "https://youtube.com/playlist?list=PLfixture",
      concurrency: 1,
      maxVideos: 2,
    });
    await f.coordinator.enumerate(f.catalog(), operation());
    await f.coordinator.reconcile();
    f.statuses.set(ids[0], {
      status: "failed",
      stage: "transcribe",
      progress: 20,
      attempts: 3,
      failure: {
        code: "processing_failed",
        message: "Failure",
        retryable: false,
      },
    });
    await f.coordinator.reconcile();
    f.statuses.set(ids[1], {
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 1,
    });
    expect(await f.coordinator.reconcile()).toMatchObject({
      status: "completed_with_errors",
    });
    const retry = vi.spyOn(f.options.videos, "retry");
    expect(await f.service.retry()).toMatchObject({ status: "queued" });
    expect(retry).toHaveBeenCalledExactlyOnceWith({
      requestId: "request",
      videoId: ids[0],
    });
    expect(f.persisted.members[1].status).toBe("completed");
    f.statuses.set(ids[0], {
      status: "completed",
      stage: "completed",
      progress: 100,
      attempts: 1,
    });
    expect(await f.coordinator.reconcile()).toMatchObject({
      status: "completed",
      completed: 2,
      failed: 0,
    });
    expect(f.initialize).toHaveBeenCalledTimes(2);
  });

  it("manual video retry clears cancellation without erasing checkpoints or paid-call budgets", async () => {
    const f = fixture();
    const settings = resolveSettings();
    const initialization: VideoInitialization = {
      requestId: "request",
      videoId: ids[0],
      source: { kind: "youtube", url: `https://youtu.be/${ids[0]}` },
      settings,
    };
    const runs = new MemoryRunRepository({
      revision: 1,
      status: "cancelled",
      source: initialization.source,
      settings,
      cacheKey: "cached",
      startedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      stage: "cancelled",
      progress: 40,
      attempts: 2,
      cancelRequested: true,
      checkpoints: { inference: { calls: 7, steps: {} } },
    });
    const cancellation = cancellationState(runs);
    const repository: VideoJobRepository = {
      runs,
      ...cancellation,
      getInitialization: async () => initialization,
      initialize: async () => initialization,
    };
    let active = false;
    const runtime: VideoRuntime = {
      wake: vi.fn(async () => undefined),
      abort: vi.fn(),
      isActive: () => active,
    };
    const service = new VideoJobService({
      repository,
      runtime,
      policy: f.options.policy,
      environment: f.options.environment,
    });
    await service.retry();
    expect(cancellation.updateCancellation).toHaveBeenCalledOnce();
    expect(await runs.get()).toMatchObject({
      status: "queued",
      attempts: 0,
      cancelRequested: false,
      checkpoints: { inference: { calls: 7 } },
    });
    active = true;
    await expect(service.retry()).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("video execution resumes a persisted pipeline checkpoint after a retryable failure", async () => {
    const f = fixture();
    const artifacts = new MemoryArtifactStorage();
    const runs = new MemoryRunRepository();
    const settings = resolveSettings({ skipVisuals: true });
    const initialization: VideoInitialization = {
      requestId: "request",
      videoId: ids[0],
      source: { kind: "youtube", url: `https://youtu.be/${ids[0]}` },
      settings,
    };
    const repository: VideoJobRepository = {
      runs,
      ...cancellationState(runs),
      getInitialization: async () => initialization,
      initialize: async () => initialization,
    };
    const wakes: string[] = [];
    const runtime: VideoRuntime = {
      wake: async (reason) => {
        wakes.push(reason);
      },
      abort: () => undefined,
      isActive: () => false,
    };
    const media = {
      acquire: vi.fn(async () => ({
        metadata: {
          contentId: ids[0],
          title: "Fixture",
          description: "",
          duration: 5,
          thumbnailUrl: "",
          source: "Fixture",
          uploadDate: "",
          url: `https://youtu.be/${ids[0]}`,
        },
        audio: await artifacts.put(
          "source/audio",
          new Uint8Array([1]),
          "audio/wav"
        ),
      })),
      extractFrames: vi.fn(async () => []),
    };
    const transcriber = {
      transcribe: vi.fn(async () => ({
        segments: [],
        fullText: "Words",
        language: "en",
        duration: 5,
        source: "fixture",
      })),
    };
    transcriber.transcribe.mockRejectedValueOnce(
      new PipelineError("timeout", "Retry", { retryable: true })
    );
    const options = {
      repository,
      runtime,
      policy: f.options.policy,
      environment: f.options.environment,
    };
    await new VideoJobService(options).execute(
      { artifacts, runs, media, transcriber },
      operation()
    );
    expect(await runs.get()).toMatchObject({
      status: "failed",
      attempts: 1,
      checkpoints: { acquire: {} },
    });
    expect(wakes.at(-1)).toBe("retry");
    await new VideoJobService(options).execute(
      { artifacts, runs, media, transcriber },
      { ...operation(), attemptId: "2" }
    );
    expect(await runs.get()).toMatchObject({
      status: "completed",
      attempts: 2,
    });
    expect(media.acquire).toHaveBeenCalledOnce();
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2);
    expect(wakes.at(-1)).toBe("stop");
  });
});
