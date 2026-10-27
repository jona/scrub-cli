import type {
  PipelineSettings,
  RunRecord,
  RunRepository,
  VideoResult,
} from "../contracts.js";
import type { InferenceSettingsInput } from "../model.js";
import type {
  JobMember,
  JobRequestRecord,
  VideoInitialization,
  VideoJobKey,
  VideoJobStatus,
  WakeReason,
} from "./model.js";

export interface MemberQuery {
  started?: boolean;
  statuses?: readonly JobMember["status"][];
  offset?: number;
  limit?: number;
}
/** Scoped to one request. Updates and membership publication await persistence. */
export interface JobRequestRepository {
  get(): Promise<JobRequestRecord | null>;
  update(
    change: (current: JobRequestRecord | null) => JobRequestRecord
  ): Promise<JobRequestRecord>;
  /** Atomically deduplicate by video ID, enforce maximum, and allocate position. */
  appendMember(
    input: { videoId: string; title: string },
    maximum: number
  ): Promise<void>;
  members(query?: MemberQuery): Promise<JobMember[]>;
  hasMember?(videoId: string): Promise<boolean>;
  countMembers?(): Promise<number>;
  updateMember(member: JobMember): Promise<void>;
  cancelPending(): Promise<void>;
}
/** Scoped to one video; initialize is atomic and keeps an existing initialization. */
export interface VideoJobRepository {
  getInitialization(): Promise<VideoInitialization | null>;
  /** Atomically keep existing initialization or refuse new work behind a cancellation marker. */
  initialize(input: VideoInitialization): Promise<VideoInitialization | null>;
  getCancellationRequested(): Promise<boolean>;
  /** Persist the cancellation marker and corresponding run transition in one transaction. */
  updateCancellation(
    requested: boolean,
    change: (current: RunRecord | null) => RunRecord | null
  ): Promise<RunRecord | null>;
  readonly runs: RunRepository;
}
/** A local service router or an authenticated remote transport. */
export interface VideoJobControl {
  initialize(
    key: VideoJobKey,
    input: VideoInitialization
  ): Promise<VideoJobStatus>;
  getStatus(key: VideoJobKey): Promise<VideoJobStatus | null>;
  getResult(key: VideoJobKey): Promise<VideoResult | null>;
  cancel(key: VideoJobKey): Promise<VideoJobStatus>;
  retry(key: VideoJobKey): Promise<VideoJobStatus>;
  readArtifact(
    key: VideoJobKey,
    id: string,
    offset: number,
    length: number
  ): Promise<{ bytes: Uint8Array; mediaType: string; size: number }>;
}
/** Runtime chooses delays/admission and durably acknowledges scheduling intent. */
export interface RequestRuntime {
  scheduleReconcile(reason: "immediate" | "poll"): Promise<void>;
  wakeEnumeration(reason: WakeReason, attempt?: number): Promise<void>;
  isEnumerationActive(): boolean;
  abortEnumeration(): void;
}
export interface VideoRuntime {
  wake(reason: WakeReason, attempt?: number): Promise<void>;
  isActive(): boolean;
  abort(): void;
}
export interface JobEnvironment {
  now(): number;
  fingerprint(value: unknown): string;
}
export interface SubmissionPolicyOptions {
  requestDefault: number;
  inferenceDefaults: InferenceSettingsInput;
  resourceCeilings?: Partial<PipelineSettings["limits"]>;
  assertReady?(settings: PipelineSettings): Promise<void>;
}
