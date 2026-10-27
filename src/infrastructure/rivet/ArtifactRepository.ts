import type { ArtifactState } from "../../core/artifacts.js";
import type { ArtifactRepository } from "../../application/ports/ArtifactRepository.js";

export interface RivetArtifactContext {
  state: ArtifactState;
}

/** Adapts one actor's durable state to the application's storage contract. */
export class RivetArtifactRepository implements ArtifactRepository {
  constructor(private readonly context: RivetArtifactContext) {}

  get(): ArtifactState {
    return this.context.state;
  }

  update(
    change: (current: Readonly<ArtifactState>) => ArtifactState
  ): ArtifactState {
    // No await between reading and assigning: concurrent actions cannot interleave
    // inside this synchronous transition in the actor's JavaScript process.
    this.context.state = change(this.context.state);
    return this.context.state;
  }
}
