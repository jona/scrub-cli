import type {
  Failure,
  JobSnapshot,
  JobVideo,
  MediaSource,
  PipelineSettings,
  RunRecord,
} from "../contracts.js";
import type { normalizeSubmission } from "../playlist.js";

export type NormalizedJobSubmission = ReturnType<typeof normalizeSubmission>;
export interface JobRequestRecord {
  id: string;
  fingerprint: string;
  input: NormalizedJobSubmission;
  settings: PipelineSettings;
  createdAt: string;
  updatedAt: string;
  status: JobSnapshot["status"];
  stage: string;
  enumerated: boolean;
  cancelRequested: boolean;
  enumerationAttempts?: number;
  failure?: Failure;
}
export interface JobMember {
  videoId: string;
  title: string;
  position: number;
  status: JobVideo["status"];
  started: boolean;
  details: JobVideo;
}
export interface VideoJobKey {
  requestId: string;
  videoId: string;
}
export interface VideoInitialization extends VideoJobKey {
  source: MediaSource;
  settings: PipelineSettings;
}
export interface VideoJobStatus {
  status: RunRecord["status"];
  stage: string;
  progress: number;
  attempts: number;
  /** Optional legacy runtime metadata; portable services never require it. */
  actorId?: string;
  failure?: Failure;
}
export type WakeReason = "immediate" | "retry" | "recovery" | "stop";
export const terminalJobStatus = (status: string): boolean =>
  [
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
    "skipped",
  ].includes(status);
