import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ArtifactBytes,
  ArtifactRef,
  ArtifactStorage,
} from "../../application/contracts.js";
import { PipelineError } from "../../core/errors.js";

/** An atomic, content-addressed local implementation; durable only on durable volumes. */
export class FilesystemArtifactStorage implements ArtifactStorage {
  private readonly root: string;
  private readonly maximum: number;
  constructor(
    rootDirectory: string,
    options: { maxArtifactBytes?: number } = {}
  ) {
    this.root = resolve(rootDirectory);
    this.maximum = options.maxArtifactBytes ?? 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1)
      throw new Error("Invalid artifact size limit");
  }
  private path(ref: ArtifactRef): string {
    if (
      !/^[a-f0-9]{64}$/.test(ref.id) ||
      !Number.isSafeInteger(ref.size) ||
      ref.size < 0 ||
      ref.size > this.maximum
    )
      throw new PipelineError("invalid_input", "Invalid artifact reference");
    return join(this.root, ref.id);
  }
  async put(
    kind: string,
    data: ArtifactBytes,
    mediaType: string
  ): Promise<ArtifactRef> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.upload-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    let size = 0;
    try {
      const chunks = data instanceof Uint8Array ? [data] : data;
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array))
          throw new PipelineError(
            "invalid_input",
            "Artifact chunks must be bytes"
          );
        size += chunk.byteLength;
        if (size > this.maximum)
          throw new PipelineError(
            "resource_limit",
            "Artifact exceeds the storage size limit"
          );
        digest.update(chunk);
        await handle.writeFile(chunk);
      }
      await handle.sync();
      await handle.close();
      const hash = digest.digest("hex");
      const id = createHash("sha256")
        .update(`${kind}\0${mediaType}\0${hash}`)
        .digest("hex");
      const ref = { id, kind, mediaType, size, digest: hash };
      await rename(temporary, this.path(ref));
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return ref;
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async *read(ref: ArtifactRef): AsyncIterable<Uint8Array> {
    const file = await open(
      this.path(ref),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== ref.size)
        throw new PipelineError("storage_error", "Artifact size mismatch");
      for await (const chunk of file.createReadStream({ autoClose: false }))
        yield chunk;
    } finally {
      await file.close();
    }
  }
  async has(ref: ArtifactRef): Promise<boolean> {
    try {
      const info = await lstat(this.path(ref));
      return info.isFile() && !info.isSymbolicLink() && info.size === ref.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
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
    )
      throw new PipelineError("invalid_input", "Invalid artifact range");
    const file = await open(
      this.path(ref),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== ref.size)
        throw new PipelineError("storage_error", "Artifact size mismatch");
      const bytes = new Uint8Array(
        Math.min(length, Math.max(0, info.size - offset))
      );
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(
          bytes,
          read,
          bytes.length - read,
          offset + read
        );
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      return bytes.subarray(0, read);
    } finally {
      await file.close();
    }
  }
}
