import type { JobSnapshot, JobSubmission, JobVideo } from "../contracts.js";
import { PipelineError } from "../../core/errors.js";
import {
  RequestCoordinator,
  type RequestCoordinatorOptions,
} from "./RequestCoordinator.js";
import { terminalJobStatus } from "./model.js";
import { memberWithStatus, requestSnapshot } from "./request-state.js";
import { SubmissionPolicy } from "./submission.js";

export interface RequestServiceOptions extends RequestCoordinatorOptions {
  policy: SubmissionPolicy;
  resultLimits?: { items: number; bytes: number };
}
export class RequestService {
  constructor(private readonly options: RequestServiceOptions) {}
  getStatus(): Promise<JobSnapshot | null> {
    return requestSnapshot(this.options.repository);
  }
  async hasVideo(id: string): Promise<boolean> {
    if (this.options.repository.hasMember)
      return this.options.repository.hasMember(id);
    return (await this.options.repository.members()).some(
      (member) => member.videoId === id
    );
  }

  async start(id: string, input: JobSubmission): Promise<JobSnapshot> {
    const { repository, policy, environment, runtime } = this.options;
    if (!id)
      throw new PipelineError("invalid_input", "A request ID is required");
    const existing = await repository.get();
    const normalized = policy.resolve(input, existing ?? undefined);
    if (!existing) await policy.assertReady(normalized.settings);
    const fingerprint = environment.fingerprint([
      normalized,
      normalized.settings,
    ]);
    await repository.update((current) => {
      if (current && current.fingerprint !== fingerprint)
        throw new PipelineError(
          "invalid_state",
          "Idempotency key already belongs to another submission"
        );
      const at = new Date(environment.now()).toISOString();
      return (
        current ?? {
          id,
          input: normalized,
          settings: normalized.settings,
          fingerprint,
          createdAt: at,
          updatedAt: at,
          status: "queued",
          stage: "enumerate",
          enumerated: false,
          cancelRequested: false,
        }
      );
    });
    await runtime.scheduleReconcile("immediate");
    await runtime.wakeEnumeration("immediate");
    return (await this.getStatus())!;
  }

  async getResults(
    offset: number,
    limit: number
  ): Promise<{ items: JobVideo[]; total: number }> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new PipelineError("invalid_input", "Invalid result page");
    const { repository, videos } = this.options;
    const request = await repository.get();
    if (!request)
      throw new PipelineError("not_found", "Request does not exist");
    const limits = this.options.resultLimits ?? {
      items: 100,
      bytes: 512 * 1024,
    };
    const rows = await repository.members({
      offset,
      limit: Math.min(limit, limits.items),
    });
    const items: JobVideo[] = [];
    let bytes = 0;
    for (const row of rows) {
      const item = { ...row.details, status: row.status };
      if (row.started && row.status === "completed")
        item.result =
          (await videos.getResult({
            requestId: request.id,
            videoId: row.videoId,
          })) ?? undefined;
      const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
      if (items.length && bytes + size > limits.bytes) break;
      items.push(item);
      bytes += size;
    }
    return {
      items,
      total: repository.countMembers
        ? await repository.countMembers()
        : (await repository.members()).length,
    };
  }

  async cancel(): Promise<JobSnapshot> {
    const { repository, runtime, environment } = this.options;
    await repository.update((current) => {
      if (!current)
        throw new PipelineError("not_found", "Request does not exist");
      return terminalJobStatus(current.status)
        ? current
        : {
            ...current,
            cancelRequested: true,
            ...(!current.enumerated
              ? { status: "cancelled" as const, stage: "cancelled" }
              : {}),
            updatedAt: new Date(environment.now()).toISOString(),
          };
    });
    runtime.abortEnumeration();
    await repository.cancelPending();
    return (await new RequestCoordinator(this.options).reconcile())!;
  }

  async retry(): Promise<JobSnapshot> {
    const { repository, runtime, videos, environment } = this.options;
    const request = await repository.get();
    if (!request)
      throw new PipelineError("not_found", "Request does not exist");
    if (runtime.isEnumerationActive())
      throw new PipelineError(
        "invalid_state",
        "Wait for playlist enumeration to stop before retrying"
      );
    if (!terminalJobStatus(request.status))
      throw new PipelineError("invalid_state", "Request is still active");
    for (const member of await repository.members({
      statuses: ["failed", "cancelled"],
    })) {
      if (member.started)
        await repository.updateMember(
          memberWithStatus(
            member,
            await videos.retry({
              requestId: request.id,
              videoId: member.videoId,
            })
          )
        );
      else
        await repository.updateMember({
          ...member,
          status: "queued",
          details: { ...member.details, status: "queued" },
        });
    }
    await repository.update((current) => ({
      ...current!,
      status: "queued",
      cancelRequested: false,
      enumerationAttempts: current!.enumerated
        ? current!.enumerationAttempts
        : 0,
      failure: undefined,
      updatedAt: new Date(environment.now()).toISOString(),
    }));
    await runtime.scheduleReconcile("immediate");
    await runtime.wakeEnumeration("immediate");
    return (await this.getStatus())!;
  }
}
