import type {
  JobGateway,
  JobSnapshot,
  JobSubmission,
  JobVideo,
} from "../../src/application/contracts.js";
import { PipelineError } from "../../src/core/errors.js";

export const fixtureSnapshot = (): JobSnapshot => ({
  id: "job-1",
  status: "queued",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  total: 1,
  completed: 0,
  failed: 0,
  cancelled: 0,
  stage: "queued",
});
export function createMcpFixture() {
  const state: {
    input?: JobSubmission;
    key?: string;
    submissions: number;
    cancellations: number;
    retries: number;
    reads: { offset: number; length: number }[];
    job: JobSnapshot;
    items: JobVideo[];
    bytes: Uint8Array;
  } = {
    submissions: 0,
    cancellations: 0,
    retries: 0,
    reads: [],
    job: fixtureSnapshot(),
    items: [
      {
        videoId: "dQw4w9WgXcQ",
        title: "Fixture",
        position: 0,
        status: "queued",
      },
    ],
    bytes: new TextEncoder().encode("A readable artifact.\n"),
  };
  const jobs: JobGateway = {
    async submit(input, key) {
      state.input = input;
      state.key = key;
      state.submissions++;
      return state.job;
    },
    async get(id) {
      if (id === "missing") return null;
      if (id === "explode")
        throw new Error("private credential fixture-do-not-expose");
      if (id === "provider-error")
        throw new PipelineError(
          "model_authentication_failed",
          "private credential fixture-do-not-expose",
          { cause: "secret cause" }
        );
      return state.job;
    },
    async results(_id, offset, limit) {
      return {
        items: state.items.slice(offset, offset + limit),
        total: state.items.length,
      };
    },
    async cancel() {
      state.cancellations++;
      state.job = { ...state.job, status: "cancelled", cancelled: 1 };
      return state.job;
    },
    async retry() {
      state.retries++;
      state.job = { ...state.job, status: "queued", cancelled: 0 };
      return state.job;
    },
    async artifact(_job, _video, _artifact, offset, length) {
      state.reads.push({ offset, length });
      return {
        bytes: state.bytes.slice(offset, offset + length),
        mediaType: "text/plain",
        size: state.bytes.byteLength,
      };
    },
  };
  return { jobs, state };
}
