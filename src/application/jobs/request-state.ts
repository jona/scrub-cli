import type { JobSnapshot } from "../contracts.js";
import { summarizeVideos } from "../playlist.js";
import type { JobMember, JobRequestRecord, VideoJobStatus } from "./model.js";
import type { JobRequestRepository } from "./ports.js";

export async function summarizeRequest(
  repository: JobRequestRepository,
  request: JobRequestRecord
): Promise<JobSnapshot> {
  return summarizeVideos(
    {
      id: request.id,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      stage: request.stage,
    },
    (await repository.members()).map((member) => ({
      ...member.details,
      status: member.status,
    })),
    request.cancelRequested
  );
}
export async function requestSnapshot(
  repository: JobRequestRepository
): Promise<JobSnapshot | null> {
  const request = await repository.get();
  if (!request) return null;
  return {
    ...(await summarizeRequest(repository, request)),
    status: request.status,
    ...(request.failure ? { failure: request.failure } : {}),
  };
}
export function memberWithStatus(
  member: JobMember,
  status: VideoJobStatus
): JobMember {
  return {
    ...member,
    started: true,
    status: status.status,
    details: {
      videoId: member.videoId,
      title: member.title,
      position: member.position,
      status: status.status,
      stage: status.stage,
      progress: status.progress,
      ...(status.actorId ? { actorId: status.actorId } : {}),
      ...(status.failure ? { failure: status.failure } : {}),
    },
  };
}
