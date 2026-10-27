/** Scheduling policy supplied by a deployment, outside the processing pipeline. */
export interface RuntimeConcurrencyPolicy {
  requestDefault: number;
  runnerLimit: number;
  globalLimit?: number;
}
/** Backward-compatible name for the existing Rivet composition. */
export type RivetConcurrencyPolicy = RuntimeConcurrencyPolicy;

export interface RunnerLease {
  readonly token: number;
  isActive(): boolean;
  release(): void;
}

/**
 * Bounds native work in one runner process. A slot stays occupied until work and
 * cancellation cleanup finish; process exit discards all local slots naturally.
 * Acquisition never waits, so durable runtimes can reschedule denied work.
 */
export class RunnerAdmission {
  private readonly leases = new Map<string, RunnerLease>();
  private nextToken = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw new RangeError(
        "Runner concurrency must be an integer between 1 and 64"
      );
  }

  get activeCount(): number {
    return this.leases.size;
  }

  tryAcquire(owner: string): RunnerLease | null {
    if (typeof owner !== "string" || owner.length === 0)
      throw new TypeError("A runner lease owner is required");
    const existing = this.leases.get(owner);
    if (existing) return existing;
    if (this.leases.size >= this.limit) return null;
    const lease: RunnerLease = {
      token: ++this.nextToken,
      isActive: () => this.leases.get(owner) === lease,
      release: () => {
        if (this.leases.get(owner) === lease) this.leases.delete(owner);
      },
    };
    this.leases.set(owner, lease);
    return lease;
  }
}
