import type {
  ArtifactBytes,
  ArtifactRef,
  ArtifactStorage,
} from "../../application/contracts.js";
import { PipelineError } from "../../core/errors.js";

/** Volatile storage for embedded callers and contract tests; never a durable deployment store. */
export class MemoryArtifactStorage implements ArtifactStorage {
  private readonly values = new Map<string, Uint8Array>();
  private sequence = 0;

  constructor(private readonly maximumBytes = 512 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new PipelineError("invalid_input", "Invalid artifact size limit");
  }

  async put(
    kind: string,
    data: ArtifactBytes,
    mediaType: string
  ): Promise<ArtifactRef> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const source = data instanceof Uint8Array ? [data] : data;
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array))
        throw new PipelineError(
          "invalid_input",
          "Artifact chunks must be bytes"
        );
      size += chunk.byteLength;
      if (size > this.maximumBytes)
        throw new PipelineError(
          "resource_limit",
          "Artifact exceeds storage byte limit"
        );
      chunks.push(chunk.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const id = `memory-${++this.sequence}`;
    this.values.set(id, bytes);
    return { id, kind, mediaType, size };
  }

  async *read(ref: ArtifactRef): AsyncIterable<Uint8Array> {
    const bytes = this.values.get(ref.id);
    if (!bytes)
      throw new PipelineError("artifact_missing", "Artifact is unavailable", {
        retryable: true,
      });
    if (bytes.byteLength !== ref.size)
      throw new PipelineError("storage_error", "Artifact size mismatch");
    yield bytes.slice();
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    return this.values.get(ref.id)?.byteLength === ref.size;
  }

  async readRange(
    ref: ArtifactRef,
    offset: number,
    length: number
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 8 * 1024 * 1024
    ) {
      throw new PipelineError("invalid_input", "Invalid artifact byte range");
    }
    const bytes = this.values.get(ref.id);
    if (!bytes)
      throw new PipelineError("artifact_missing", "Artifact is unavailable", {
        retryable: true,
      });
    if (bytes.byteLength !== ref.size)
      throw new PipelineError("storage_error", "Artifact size mismatch");
    return bytes.slice(offset, offset + length);
  }
}
