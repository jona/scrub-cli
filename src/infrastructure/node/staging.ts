import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactRef,
  ArtifactStorage,
  OperationContext,
} from "../../application/contracts.js";
import { PipelineError, throwIfAborted } from "../../core/errors.js";

export async function withNativeDeadline<T>(
  context: OperationContext,
  timeoutMs: number,
  stage: string,
  work: (scoped: OperationContext) => Promise<T>
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([context.signal, deadline]);
  try {
    const result = await work({ ...context, signal });
    throwIfAborted(signal, stage);
    return result;
  } catch (error) {
    if (deadline.aborted && !context.signal.aborted)
      throw new PipelineError("timeout", "Native stage timed out", {
        stage,
        retryable: true,
        cause: error,
      });
    throwIfAborted(context.signal, stage);
    throw error;
  }
}

export async function inWorkspace<T>(
  root: string,
  context: OperationContext,
  work: (directory: string) => Promise<T>
): Promise<T> {
  throwIfAborted(context.signal);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "attempt-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function materialize(
  storage: ArtifactStorage,
  ref: ArtifactRef,
  path: string,
  maximum: number,
  context: OperationContext
): Promise<void> {
  if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > maximum)
    throw new PipelineError(
      "resource_limit",
      "Media exceeds the configured size limit"
    );
  const file = await open(path, "wx", 0o600);
  let size = 0;
  const digest = createHash("sha256");
  try {
    for await (const bytes of storage.read(ref)) {
      throwIfAborted(context.signal);
      size += bytes.byteLength;
      digest.update(bytes);
      if (size > maximum)
        throw new PipelineError(
          "resource_limit",
          "Media exceeds the configured size limit"
        );
      await file.writeFile(bytes);
    }
    if (size !== ref.size)
      throw new PipelineError(
        "storage_error",
        "Stored media size does not match its reference"
      );
    if (
      ref.digest &&
      /^[a-f0-9]{64}$/.test(ref.digest) &&
      digest.digest("hex") !== ref.digest
    ) {
      throw new PipelineError(
        "storage_error",
        "Stored media digest does not match its reference"
      );
    }
  } finally {
    await file.close();
  }
}

export async function publishFile(
  storage: ArtifactStorage,
  path: string,
  kind: string,
  mediaType: string,
  maximum: number,
  context: OperationContext
): Promise<ArtifactRef> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum)
    throw new PipelineError(
      "resource_limit",
      "Generated media exceeds the configured artifact limit"
    );
  async function* bytes() {
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      throwIfAborted(context.signal);
      size += chunk.byteLength;
      if (size > maximum)
        throw new PipelineError(
          "resource_limit",
          "Generated media exceeds the configured artifact limit"
        );
      yield chunk;
    }
  }
  return storage.put(kind, bytes(), mediaType);
}
