/** Shared selection policy; runtimes execute and admit the selected work. */
export function planJobDispatch<T extends { started: boolean; status: string }>(
  members: readonly T[],
  policy: {
    concurrency: number;
    cancelRequested: boolean;
    continueOnError: boolean;
  }
): { start: T[]; cancel: T[]; cancelPending: T[] } {
  const active = members.filter(
    (member) => member.started && ["queued", "running"].includes(member.status)
  );
  const pending = members.filter(
    (member) => !member.started && member.status === "queued"
  );
  const stop =
    policy.cancelRequested ||
    (!policy.continueOnError &&
      members.some((member) => member.status === "failed"));
  return stop
    ? { start: [], cancel: active, cancelPending: pending }
    : {
        start: pending.slice(
          0,
          Math.max(0, policy.concurrency - active.length)
        ),
        cancel: [],
        cancelPending: [],
      };
}
