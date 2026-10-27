import type {
  OperationContext,
  PipelineDependencies,
  VideoResult,
} from "../contracts.js";
import type { StructuredModelGateway } from "../model.js";
import { runVideoPipeline } from "../pipeline.js";
import { PipelineError } from "../../core/errors.js";
import { canonicalizeYouTubeVideo } from "../../core/source.js";
import type { VideoInitialization, VideoJobStatus } from "./model.js";
import type {
  JobEnvironment,
  VideoJobRepository,
  VideoRuntime,
} from "./ports.js";
import type { SubmissionPolicy } from "./submission.js";

export interface VideoJobServiceOptions {
  repository: VideoJobRepository;
  runtime: VideoRuntime;
  policy: SubmissionPolicy;
  environment: JobEnvironment;
}
/** Persisted video lifecycle independent of who admits and executes an attempt. */
export class VideoJobService {
  constructor(private readonly options: VideoJobServiceOptions) {}
  private iso(): string {
    return new Date(this.options.environment.now()).toISOString();
  }
  private async statusOrInitialization(): Promise<VideoJobStatus> {
    return (
      (await this.getStatus()) ?? {
        status: "queued",
        stage: "initialize",
        progress: 0,
        attempts: 0,
      }
    );
  }

  async initialize(input: VideoInitialization): Promise<VideoJobStatus> {
    const { repository, policy, runtime } = this.options;
    const existing = await repository.getInitialization();
    if (await repository.getCancellationRequested())
      return this.statusOrInitialization();
    const settings = policy.resolveSettings(input.settings, existing?.settings);
    if (!existing) await policy.assertReady(settings);
    const source =
      input.source.kind === "youtube"
        ? {
            kind: "youtube" as const,
            url: canonicalizeYouTubeVideo(input.source.url),
          }
        : input.source;
    try {
      const initialized = await repository.initialize({
        ...input,
        settings,
        source,
      });
      if (!initialized || (await repository.getCancellationRequested()))
        return this.statusOrInitialization();
      await runtime.wake("immediate");
      return (await this.getStatus())!;
    } catch (error) {
      // Commit/queue acknowledgment can fail after the child became durable.
      // The coordinator must repeat initialization rather than abandon it.
      throw new PipelineError(
        "unavailable",
        "Video initialization could not be acknowledged",
        { stage: "initialize", retryable: true, cause: error }
      );
    }
  }

  async getStatus(): Promise<VideoJobStatus | null> {
    const initialization = await this.options.repository.getInitialization();
    const run = await this.options.repository.runs.get();
    if (
      run?.status !== "completed" &&
      (await this.options.repository.getCancellationRequested())
    )
      return {
        status: "cancelled",
        stage: "cancelled",
        progress: run?.progress ?? 0,
        attempts: run?.attempts ?? 0,
      };
    if (!initialization) return null;
    if (!run)
      return { status: "queued", stage: "queued", progress: 0, attempts: 0 };
    const retrying =
      run.status === "failed" &&
      run.failure?.retryable &&
      run.attempts < initialization.settings.limits.maxAttempts &&
      !run.cancelRequested;
    return {
      status: retrying ? "queued" : run.status,
      stage: retrying ? "retry_wait" : run.stage,
      progress: run.progress,
      attempts: run.attempts,
      ...(run.failure ? { failure: run.failure } : {}),
    };
  }
  async getResult(): Promise<VideoResult | null> {
    return (await this.options.repository.runs.get())?.result ?? null;
  }

  async cancel(): Promise<VideoJobStatus> {
    const { repository, runtime } = this.options;
    await repository.updateCancellation(true, (current) =>
      current
        ? current.status === "completed"
          ? current
          : {
              ...current,
              revision: current.revision + 1,
              cancelRequested: true,
              status: "cancelled",
              stage: "cancelled",
              updatedAt: this.iso(),
            }
        : null
    );
    runtime.abort();
    await runtime.wake("stop");
    return this.statusOrInitialization();
  }

  async retry(): Promise<VideoJobStatus> {
    const { repository, runtime } = this.options;
    const initialization = await repository.getInitialization();
    if (runtime.isActive())
      throw new PipelineError(
        "invalid_state",
        "Wait for the current attempt to stop before retrying"
      );
    await repository.updateCancellation(false, (existing) =>
      existing && existing.status !== "completed"
        ? {
            ...existing,
            revision: existing.revision + 1,
            status: "queued",
            stage: "queued",
            attempts: 0,
            cancelRequested: false,
            failure: undefined,
            updatedAt: this.iso(),
          }
        : existing
    );
    await runtime.wake(initialization ? "immediate" : "stop");
    return this.statusOrInitialization();
  }

  async prepareAttempt(): Promise<VideoInitialization | null> {
    const { repository, runtime } = this.options;
    if (await repository.getCancellationRequested()) {
      await runtime.wake("stop");
      return null;
    }
    const initialization = await repository.getInitialization();
    if (!initialization) return null;
    const current = await repository.runs.get();
    if (
      current?.cancelRequested ||
      current?.status === "cancelled" ||
      current?.status === "completed" ||
      (current?.status === "failed" &&
        (!current.failure?.retryable ||
          current.attempts >= initialization.settings.limits.maxAttempts))
    ) {
      await runtime.wake("stop");
      return null;
    }
    if (
      current &&
      current.attempts >= initialization.settings.limits.maxAttempts
    ) {
      await repository.runs.update((latest) => ({
        ...latest!,
        revision: latest!.revision + 1,
        status: "failed",
        updatedAt: this.iso(),
        failure: {
          code: "attempt_limit",
          message: "Processing retry budget exhausted",
          retryable: false,
        },
      }));
      await runtime.wake("stop");
      return null;
    }
    return initialization;
  }

  /** Called only after runtime admission, with its fenced run repository and signal. */
  async execute(
    dependencies: PipelineDependencies,
    operation: OperationContext,
    resolveModels?: () => Promise<StructuredModelGateway | undefined>
  ): Promise<void> {
    const initialization = await this.prepareAttempt();
    if (!initialization) return;
    let models = dependencies.models;
    if (resolveModels) {
      try {
        models = await resolveModels();
      } catch (error) {
        models = {
          supports: () => {
            throw error;
          },
          generate: async () => {
            throw error;
          },
        };
      }
    }
    try {
      await runVideoPipeline(
        initialization.source,
        initialization.settings,
        { ...dependencies, models },
        operation
      );
    } catch {
      /* The pipeline records typed failures while its attempt still owns the run. */
    }
    const after = await this.options.repository.runs.get();
    if (
      after?.status === "failed" &&
      after.failure?.retryable &&
      after.attempts < initialization.settings.limits.maxAttempts &&
      !after.cancelRequested
    )
      await this.options.runtime.wake("retry", after.attempts);
    else if (!after || (after.status === "running" && !after.cancelRequested))
      await this.options.runtime.wake("recovery");
    else await this.options.runtime.wake("stop");
  }
}
