import type {
  JobSnapshot,
  OperationContext,
  SourceCatalog,
} from "../contracts.js";
import { enumerateSubmission } from "../playlist.js";
import { resolveInferenceSettings } from "../model.js";
import { PipelineError, asPipelineError } from "../../core/errors.js";
import {
  canonicalizeYouTubeVideo,
  parseYouTubeSource,
} from "../../core/source.js";
import { terminalJobStatus, type VideoJobStatus } from "./model.js";
import { planJobDispatch } from "./dispatch.js";
import type {
  JobEnvironment,
  JobRequestRepository,
  RequestRuntime,
  VideoJobControl,
} from "./ports.js";
import {
  memberWithStatus,
  requestSnapshot,
  summarizeRequest,
} from "./request-state.js";

/** These failures reject captured settings before a child initialization commits. */
function isInitializationRejection(error: unknown): error is PipelineError {
  return (
    error instanceof PipelineError &&
    !error.retryable &&
    [
      "invalid_input",
      "invalid_source",
      "resource_limit",
      "capability_unavailable",
      "model_authentication_failed",
    ].includes(error.code)
  );
}

export interface RequestCoordinatorOptions {
  repository: JobRequestRepository;
  videos: VideoJobControl;
  runtime: RequestRuntime;
  environment: JobEnvironment;
}

/** Business coordination; runtimes own execution admission and wake delivery. */
export class RequestCoordinator {
  constructor(protected readonly options: RequestCoordinatorOptions) {}
  snapshot(): Promise<JobSnapshot | null> {
    return requestSnapshot(this.options.repository);
  }

  async enumerate(
    catalog: SourceCatalog,
    operation: OperationContext
  ): Promise<void> {
    const { repository, runtime, environment } = this.options;
    const request = await repository.get();
    if (
      !request ||
      request.enumerated ||
      request.cancelRequested ||
      terminalJobStatus(request.status)
    )
      return;
    try {
      await runtime.wakeEnumeration("recovery");
      if (
        (request.enumerationAttempts ?? 0) >=
        request.settings.limits.maxAttempts
      )
        throw new PipelineError(
          "attempt_limit",
          "Playlist enumeration retry budget exhausted"
        );
      await repository.update((current) => ({
        ...current!,
        enumerationAttempts: (current!.enumerationAttempts ?? 0) + 1,
      }));
      const maximum = Math.min(
        request.input.maxVideos || request.settings.limits.maxPlaylistVideos,
        request.settings.limits.maxPlaylistVideos
      );
      await enumerateSubmission(
        catalog,
        request.input,
        operation,
        async (entry) => {
          if (
            operation.signal.aborted ||
            (await repository.get())?.cancelRequested
          )
            throw new PipelineError(
              "cancelled",
              "Playlist enumeration was cancelled"
            );
          const videoId = parseYouTubeSource(entry.url).videoId;
          if (videoId)
            await repository.appendMember(
              { videoId, title: entry.title },
              maximum
            );
        }
      );
      await repository.update((current) => ({
        ...current!,
        enumerated: true,
        status: current!.cancelRequested ? "cancelled" : "running",
        stage: "processing",
        failure: undefined,
        updatedAt: new Date(environment.now()).toISOString(),
      }));
      await runtime.scheduleReconcile("immediate");
      await runtime.wakeEnumeration("stop");
    } catch (error) {
      const current = await repository.get();
      if (!current) return;
      const failure = current.cancelRequested
        ? new PipelineError("cancelled", "Playlist enumeration was cancelled", {
            stage: "enumerate",
          })
        : operation.signal.aborted
          ? new PipelineError(
              "unavailable",
              "Playlist enumeration was interrupted",
              { stage: "enumerate", retryable: true }
            )
          : asPipelineError(error, { stage: "enumerate" });
      const retry =
        !current.cancelRequested &&
        failure.retryable &&
        (current.enumerationAttempts ?? 0) <
          current.settings.limits.maxAttempts;
      await repository.update((latest) => ({
        ...latest!,
        status: latest!.cancelRequested
          ? "cancelled"
          : retry
            ? "queued"
            : failure.code === "cancelled"
              ? "cancelled"
              : "failed",
        stage: "enumerate",
        failure: failure.toJSON(),
        updatedAt: new Date(environment.now()).toISOString(),
      }));
      await runtime.wakeEnumeration(
        retry ? "retry" : "stop",
        current.enumerationAttempts
      );
    }
  }

  async reconcile(): Promise<JobSnapshot | null> {
    const { repository, videos, runtime, environment } = this.options;
    const request = await repository.get();
    if (!request || terminalJobStatus(request.status)) return this.snapshot();
    // Durable scheduling acknowledgment comes before child calls.
    await runtime.scheduleReconcile("poll");
    if (!request.enumerated) {
      await runtime.wakeEnumeration("immediate");
      return this.snapshot();
    }
    const initializing = new Set<string>();
    for (const member of await repository.members({
      started: true,
      statuses: ["queued", "running"],
    })) {
      const status = await videos.getStatus({
        requestId: request.id,
        videoId: member.videoId,
      });
      if (
        !status ||
        (member.details.stage === "initialize" &&
          ["queued", "running"].includes(status.status))
      )
        initializing.add(member.videoId);
      else await repository.updateMember(memberWithStatus(member, status));
    }
    const latest = (await repository.get())!;
    const members = await repository.members();
    const plan = planJobDispatch(members, {
      concurrency: latest.input.concurrency,
      cancelRequested: latest.cancelRequested,
      continueOnError: latest.input.continueOnError,
    });
    if (plan.cancelPending.length) await repository.cancelPending();
    for (const member of plan.cancel) {
      const status = await videos.cancel({
        requestId: request.id,
        videoId: member.videoId,
      });
      await repository.updateMember(memberWithStatus(member, status));
    }
    const cancelled = new Set(plan.cancel.map((member) => member.videoId));
    const dispatch = [
      ...members.filter(
        (member) =>
          initializing.has(member.videoId) && !cancelled.has(member.videoId)
      ),
      ...plan.start,
    ];
    for (const member of dispatch) {
      const key = { requestId: latest.id, videoId: member.videoId };
      if ((await repository.get())?.cancelRequested) {
        if (member.started)
          await repository.updateMember(
            memberWithStatus(member, await videos.cancel(key))
          );
        continue;
      }
      // Reserve this member before the RPC so cancellation can leave a durable
      // child tombstone even if the initialization reply is lost or delayed.
      await repository.updateMember({
        ...member,
        started: true,
        details: { ...member.details, stage: "initialize" },
      });
      if ((await repository.get())?.cancelRequested) {
        await repository.updateMember(
          memberWithStatus(member, await videos.cancel(key))
        );
        continue;
      }
      let status: VideoJobStatus;
      try {
        status = await videos.initialize(key, {
          ...key,
          source: {
            kind: "youtube",
            url: canonicalizeYouTubeVideo(member.videoId),
          },
          settings:
            latest.settings.inference === undefined
              ? {
                  ...latest.settings,
                  inference: resolveInferenceSettings({ mode: "preprocess" }),
                }
              : latest.settings,
        });
      } catch (error) {
        const current = (await repository.get())!;
        if (current.cancelRequested) {
          await repository.updateMember(
            memberWithStatus(member, await videos.cancel(key))
          );
          continue;
        }
        // A lost reply may hide a successfully initialized child. Keep its
        // durable dispatch intent so the next poll repeats initialization.
        if (!isInitializationRejection(error)) throw error;
        await repository.updateMember({
          ...member,
          status: "failed",
          started: false,
          details: {
            ...member.details,
            status: "failed",
            stage: "initialize",
            failure: {
              ...error.toJSON(),
              stage: error.stage ?? "initialize",
            },
          },
        });
        if (!current.input.continueOnError) {
          const stop = planJobDispatch(await repository.members(), {
            concurrency: current.input.concurrency,
            cancelRequested: current.cancelRequested,
            continueOnError: false,
          });
          if (stop.cancelPending.length) await repository.cancelPending();
          for (const active of stop.cancel) {
            const cancelled = await videos.cancel({
              requestId: current.id,
              videoId: active.videoId,
            });
            await repository.updateMember(memberWithStatus(active, cancelled));
          }
          break;
        }
        continue;
      }
      if ((await repository.get())?.cancelRequested)
        status = await videos.cancel(key);
      await repository.updateMember(memberWithStatus(member, status));
    }
    const current = (await repository.get())!;
    const summary = await summarizeRequest(repository, current);
    const finished =
      summary.total === summary.completed + summary.failed + summary.cancelled;
    await repository.update((record) => ({
      ...record!,
      updatedAt: new Date(environment.now()).toISOString(),
      status: finished ? summary.status : "running",
      stage: finished ? summary.status : "processing",
    }));
    return this.snapshot();
  }
}
