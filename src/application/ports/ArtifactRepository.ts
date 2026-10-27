import type { ArtifactState } from "../../core/artifacts.js";

/** Storage for one document's artifacts, bound to that document by its adapter. */
export interface ArtifactRepository {
  get(): ArtifactState | Promise<ArtifactState>;

  /**
   * Apply a logical transition atomically to the latest state and return the
   * resulting state, visible to subsequent reads. The adapter must serialize
   * concurrent updates or use a transaction;
   * get-then-set without concurrency control does not satisfy this contract.
   *
   * Transitions are synchronous and must not mutate the supplied state. An
   * adapter may re-evaluate a transition when retrying an optimistic transaction.
   * Persistence acknowledgments are adapter-defined. Propagate failures observed
   * during get/update; this port does not promise a durable flush before return.
   */
  update(
    change: (current: Readonly<ArtifactState>) => ArtifactState
  ): ArtifactState | Promise<ArtifactState>;
}
