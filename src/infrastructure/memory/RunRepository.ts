import type { RunRecord, RunRepository } from "../../application/contracts.js";

/** One run's volatile state. Atomic transitions match durable repository semantics. */
export class MemoryRunRepository implements RunRepository {
  private state: RunRecord | null;
  private pending: Promise<void> = Promise.resolve();

  constructor(initial: RunRecord | null = null) {
    this.state = structuredClone(initial);
  }

  async get(): Promise<RunRecord | null> {
    await this.pending;
    return structuredClone(this.state);
  }

  update(change: (current: RunRecord | null) => RunRecord): Promise<RunRecord> {
    const result = this.pending.then(() => {
      const next = change(structuredClone(this.state));
      this.state = structuredClone(next);
      return structuredClone(next);
    });
    this.pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
