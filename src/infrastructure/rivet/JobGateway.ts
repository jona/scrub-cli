import { createHash, randomUUID } from "node:crypto";
import { createClient } from "rivetkit/client";
import type {
  JobGateway,
  JobSnapshot,
  JobSubmission,
  JobVideo,
} from "../../application/contracts.js";
import { PipelineError, type PipelineErrorCode } from "../../core/errors.js";
import type { JobActorClient } from "./jobs.js";

export interface RivetJobGatewayOptions {
  endpoint: string;
  token: string;
}

/** A server-side SDK adapter; its token must never be sent to product clients. */
export class RivetJobGateway implements JobGateway {
  private readonly client: JobActorClient;

  constructor(options: RivetJobGatewayOptions, client?: JobActorClient) {
    if (!options.endpoint || !options.token)
      throw new PipelineError(
        "unavailable",
        "Rivet job gateway is not configured"
      );
    this.client =
      client ??
      (createClient({
        endpoint: options.endpoint,
        token: options.token,
      }) as unknown as JobActorClient);
  }

  async submit(
    input: JobSubmission,
    idempotencyKey?: string
  ): Promise<JobSnapshot> {
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 200)
    )
      throw new PipelineError(
        "invalid_input",
        "Idempotency key must contain 1 to 200 characters"
      );
    const id = idempotencyKey
      ? `request_${createHash("sha256").update(idempotencyKey).digest("hex")}`
      : `request_${randomUUID()}`;
    return this.call(() =>
      this.client.scrubRequest.getOrCreate([id]).start(input)
    );
  }

  async get(id: string): Promise<JobSnapshot | null> {
    try {
      return await this.call(() =>
        this.client.scrubRequest.get([id]).getStatus()
      );
    } catch (error) {
      if (error instanceof PipelineError && error.code === "not_found")
        return null;
      throw error;
    }
  }

  async results(
    id: string,
    offset: number,
    limit: number
  ): Promise<{ items: JobVideo[]; total: number }> {
    return this.call(() =>
      this.client.scrubRequest.get([id]).getResults(offset, limit)
    );
  }

  async cancel(id: string): Promise<JobSnapshot> {
    return this.call(() => this.client.scrubRequest.get([id]).cancel());
  }

  async retry(id: string): Promise<JobSnapshot> {
    return this.call(() => this.client.scrubRequest.get([id]).retry());
  }

  async artifact(
    jobId: string,
    videoId: string,
    artifactId: string,
    offset: number,
    length: number
  ): Promise<{ bytes: Uint8Array; mediaType: string; size: number }> {
    return this.call(async () => {
      if (!(await this.client.scrubRequest.get([jobId]).hasVideo(videoId)))
        throw new PipelineError(
          "not_found",
          "Video does not belong to this request"
        );
      const response = await this.client.scrubVideo
        .get([jobId, videoId])
        .readArtifact(artifactId, offset, length);
      return {
        bytes: new Uint8Array(Buffer.from(response.data, "base64")),
        mediaType: response.mediaType,
        size: response.size,
      };
    });
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      const detail = (error && typeof error === "object" ? error : {}) as {
        code?: unknown;
        status?: number;
        message?: unknown;
        metadata?: { code?: unknown; retryable?: unknown; stage?: unknown };
      };
      const candidate = detail.metadata?.code ?? detail.code;
      const rawCode = typeof candidate === "string" ? candidate : "unavailable";
      const modelMessages: Partial<Record<PipelineErrorCode, string>> = {
        capability_unavailable:
          "Server model configuration is unavailable; configure credentials and allowed models for the selected provider",
        model_authentication_failed: "Model provider authentication failed",
        model_refused: "Model refused to produce the requested output",
        invalid_model_output: "Model returned invalid structured output",
      };
      const code: PipelineErrorCode =
        rawCode.includes("not_found") || detail.status === 404
          ? "not_found"
          : [
                "invalid_input",
                "invalid_source",
                "invalid_state",
                "resource_limit",
                "cancelled",
                "attempt_limit",
                "capability_unavailable",
                "model_authentication_failed",
                "model_refused",
                "invalid_model_output",
              ].includes(rawCode)
            ? (rawCode as PipelineErrorCode)
            : "unavailable";
      throw new PipelineError(
        code,
        code === "unavailable"
          ? "Rivet job service is unavailable"
          : (modelMessages[code] ??
              (typeof detail.message === "string"
                ? detail.message
                : "Job operation failed")),
        {
          retryable:
            typeof detail.metadata?.retryable === "boolean"
              ? detail.metadata.retryable
              : code === "unavailable",
          stage:
            typeof detail.metadata?.stage === "string" &&
            [
              "queued",
              "enumerate",
              "download",
              "transcribe",
              "extract-frames",
              "vision",
              "summary",
              "summarize",
              "render",
              "prompt",
            ].includes(detail.metadata.stage)
              ? detail.metadata.stage
              : undefined,
        }
      );
    }
  }
}
