import { createHash, randomUUID } from "node:crypto";
import type { RawAccess } from "rivetkit/db";
import type {
  ArtifactBytes,
  ArtifactRef,
  ArtifactStorage,
  RunRecord,
  RunRepository,
} from "../../application/contracts.js";
import { PipelineError } from "../../core/errors.js";

export const BLOB_CHUNK_BYTES = 256 * 1024;
export type JobDatabase = Pick<RawAccess, "execute" | "transaction">;

export async function migrateJobDatabase(database: JobDatabase): Promise<void> {
  await database.execute(
    "CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );
  await database.execute(
    "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, chunk_id TEXT)"
  );
  const columns = await database.execute<{ name: string }>(
    "PRAGMA table_info(artifacts)"
  );
  if (!columns.some((column) => column.name === "chunk_id"))
    await database.execute("ALTER TABLE artifacts ADD COLUMN chunk_id TEXT");
  const legacy = await database.execute<{ id: string }>(
    "SELECT id FROM artifacts WHERE chunk_id IS NULL"
  );
  for (const row of legacy)
    await database.execute(
      "UPDATE artifacts SET chunk_id = ? WHERE id = ?",
      row.id,
      row.id
    );
  await database.execute(
    "CREATE INDEX IF NOT EXISTS artifacts_by_chunk ON artifacts (chunk_id)"
  );
  await database.execute(
    "CREATE TABLE IF NOT EXISTS artifact_chunks (artifact_id TEXT NOT NULL, position INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (artifact_id, position))"
  );
}

export class SqliteDocuments {
  constructor(private readonly database: JobDatabase) {}

  async get<T>(key: string): Promise<T | null> {
    const rows = await this.database.execute<{ value: string }>(
      "SELECT value FROM documents WHERE key = ?",
      key
    );
    return rows[0] ? (JSON.parse(rows[0].value) as T) : null;
  }

  async update<T>(key: string, change: (current: T | null) => T): Promise<T> {
    return this.database.transaction(
      async (transaction) => {
        const rows = await transaction.execute<{ value: string }>(
          "SELECT value FROM documents WHERE key = ?",
          key
        );
        const next = change(rows[0] ? (JSON.parse(rows[0].value) as T) : null);
        await transaction.execute(
          "INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          JSON.stringify(next)
        );
        return next;
      },
      { name: "scrub.document.update" }
    );
  }
}

/** Actor-local SQLite owns bytes. Temporary host paths never enter these records. */
export class SqliteArtifactStorage implements ArtifactStorage {
  constructor(
    private readonly database: JobDatabase,
    private readonly maximumBytes = 512 * 1024 * 1024,
    private readonly maximumSourceBytes = maximumBytes
  ) {}

  async put(
    kind: string,
    data: ArtifactBytes,
    mediaType: string
  ): Promise<ArtifactRef> {
    const stagingId = `pending_${randomUUID()}`;
    const hash = createHash("sha256");
    let size = 0;
    let position = 0;
    let pending = new Uint8Array(BLOB_CHUNK_BYTES);
    let used = 0;
    const storeChunk = async () => {
      await this.database.execute(
        "INSERT INTO artifact_chunks (artifact_id, position, bytes) VALUES (?, ?, ?)",
        stagingId,
        position++,
        pending.subarray(0, used)
      );
      pending = new Uint8Array(BLOB_CHUNK_BYTES);
      used = 0;
    };
    try {
      const stream =
        data instanceof Uint8Array
          ? (async function* () {
              yield data;
            })()
          : data;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array))
          throw new PipelineError(
            "invalid_input",
            "Artifact stream must contain byte arrays"
          );
        size += chunk.byteLength;
        if (
          size >
          (kind === "source/video"
            ? this.maximumSourceBytes
            : this.maximumBytes)
        )
          throw new PipelineError(
            "resource_limit",
            "Artifact exceeds the configured byte limit"
          );
        hash.update(chunk);
        for (let offset = 0; offset < chunk.byteLength; ) {
          const length = Math.min(
            BLOB_CHUNK_BYTES - used,
            chunk.byteLength - offset
          );
          pending.set(chunk.subarray(offset, offset + length), used);
          used += length;
          offset += length;
          if (used === BLOB_CHUNK_BYTES) await storeChunk();
        }
      }
      if (used) await storeChunk();
      const digest = hash.digest("hex");
      const id = `artifact_${createHash("sha256").update(`${kind}\0${mediaType}\0${digest}`).digest("hex")}`;
      const ref: ArtifactRef = { id, kind, mediaType, size, digest };
      // Publish a small indirection record. Rewriting all chunk IDs here would
      // exceed Rivet's SQLite dirty-page commit budget for large media files.
      const publication = await this.database.transaction(
        async (transaction) => {
          const existing = await transaction.execute<{
            metadata: string;
            chunk_id: string;
          }>("SELECT metadata, chunk_id FROM artifacts WHERE id = ?", id);
          if (existing.length) {
            const chunks = await transaction.execute<{
              count: number;
              size: number;
            }>(
              "SELECT COUNT(*) AS count, COALESCE(SUM(length(bytes)), 0) AS size FROM artifact_chunks WHERE artifact_id = ?",
              existing[0].chunk_id
            );
            const previous = JSON.parse(existing[0].metadata) as ArtifactRef;
            if (
              previous.digest === digest &&
              previous.size === size &&
              chunks[0].count === Math.ceil(size / BLOB_CHUNK_BYTES) &&
              chunks[0].size === size
            )
              return { duplicate: true };
            await transaction.execute(
              "UPDATE artifacts SET metadata = ?, chunk_id = ? WHERE id = ?",
              JSON.stringify(ref),
              stagingId,
              id
            );
            return { duplicate: false, replaced: existing[0].chunk_id };
          } else {
            await transaction.execute(
              "INSERT INTO artifacts (id, metadata, chunk_id) VALUES (?, ?, ?)",
              id,
              JSON.stringify(ref),
              stagingId
            );
            return { duplicate: false };
          }
        },
        { name: "scrub.artifact.publish", timeout: 30_000 }
      );
      if (publication.duplicate) await this.removeNamespace(stagingId);
      if (publication.replaced)
        await this.removeIfUnpublished(publication.replaced);
      return ref;
    } catch (error) {
      // A commit acknowledgment can fail after publication: never delete chunks
      // that have become reachable through a metadata record.
      await this.removeIfUnpublished(stagingId).catch(() => undefined);
      throw error;
    }
  }

  async lookup(id: string): Promise<ArtifactRef | null> {
    const rows = await this.database.execute<{ metadata: string }>(
      "SELECT metadata FROM artifacts WHERE id = ?",
      id
    );
    return rows[0] ? (JSON.parse(rows[0].metadata) as ArtifactRef) : null;
  }

  private async stored(
    ref: ArtifactRef
  ): Promise<{ ref: ArtifactRef; chunkId: string } | null> {
    const rows = await this.database.execute<{
      metadata: string;
      chunk_id: string;
    }>("SELECT metadata, chunk_id FROM artifacts WHERE id = ?", ref.id);
    if (!rows[0]) return null;
    const found = JSON.parse(rows[0].metadata) as ArtifactRef;
    return found.size === ref.size &&
      found.kind === ref.kind &&
      found.mediaType === ref.mediaType &&
      (!ref.digest || found.digest === ref.digest)
      ? { ref: found, chunkId: rows[0].chunk_id }
      : null;
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    const found = await this.stored(ref);
    if (!found) return false;
    const chunks = await this.database.execute<{ count: number; size: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(length(bytes)), 0) AS size FROM artifact_chunks WHERE artifact_id = ?",
      found.chunkId
    );
    return (
      chunks[0].count === Math.ceil(ref.size / BLOB_CHUNK_BYTES) &&
      chunks[0].size === ref.size
    );
  }

  async *read(ref: ArtifactRef): AsyncIterable<Uint8Array> {
    if (!(await this.has(ref)))
      throw new PipelineError(
        "artifact_missing",
        "Artifact is missing or does not match its reference"
      );
    for (let offset = 0; offset < ref.size; offset += BLOB_CHUNK_BYTES) {
      yield await this.readRange(
        ref,
        offset,
        Math.min(BLOB_CHUNK_BYTES, ref.size - offset)
      );
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
      length > BLOB_CHUNK_BYTES
    ) {
      throw new PipelineError(
        "invalid_input",
        "Artifact ranges must be nonnegative integers of at most 256 KiB"
      );
    }
    const found = await this.stored(ref);
    if (!found)
      throw new PipelineError(
        "artifact_missing",
        "Artifact is missing or does not match its reference"
      );
    const end = Math.min(ref.size, offset + length);
    if (end <= offset) return new Uint8Array();
    const first = Math.floor(offset / BLOB_CHUNK_BYTES);
    const last = Math.floor((end - 1) / BLOB_CHUNK_BYTES);
    const rows = await this.database.execute<{
      position: number;
      bytes: Uint8Array;
    }>(
      "SELECT position, bytes FROM artifact_chunks WHERE artifact_id = ? AND position >= ? AND position <= ? ORDER BY position",
      found.chunkId,
      first,
      last
    );
    const result = new Uint8Array(end - offset);
    let copied = 0;
    for (const row of rows) {
      const chunk = new Uint8Array(row.bytes);
      const from = Math.max(0, offset - row.position * BLOB_CHUNK_BYTES);
      const to = Math.min(chunk.length, end - row.position * BLOB_CHUNK_BYTES);
      result.set(chunk.subarray(from, to), copied);
      copied += Math.max(0, to - from);
    }
    if (copied !== result.length)
      throw new PipelineError(
        "storage_error",
        "Artifact storage is incomplete"
      );
    return result;
  }

  /** Called during actor startup, before a new writer starts. */
  async removeUnpublished(): Promise<void> {
    const rows = await this.database.execute<{ artifact_id: string }>(
      "SELECT DISTINCT artifact_id FROM artifact_chunks LEFT JOIN artifacts ON artifacts.chunk_id = artifact_chunks.artifact_id WHERE artifacts.id IS NULL"
    );
    for (const row of rows) await this.removeIfUnpublished(row.artifact_id);
  }

  private async removeIfUnpublished(namespace: string): Promise<void> {
    if (
      (
        await this.database.execute(
          "SELECT id FROM artifacts WHERE chunk_id = ?",
          namespace
        )
      ).length === 0
    )
      await this.removeNamespace(namespace);
  }

  private async removeNamespace(namespace: string): Promise<void> {
    // One bounded blob row per commit, including failure/deduplication cleanup.
    for (;;) {
      const rows = await this.database.execute<{ position: number }>(
        "SELECT position FROM artifact_chunks WHERE artifact_id = ? ORDER BY position LIMIT 1",
        namespace
      );
      if (!rows.length) return;
      await this.database.execute(
        "DELETE FROM artifact_chunks WHERE artifact_id = ? AND position = ?",
        namespace,
        rows[0].position
      );
    }
  }
}

export class SqliteRunRepository implements RunRepository {
  constructor(
    private readonly database: JobDatabase,
    private readonly attempt?: {
      token: string;
      assertOwnership(): Promise<void>;
    }
  ) {}

  async get(): Promise<RunRecord | null> {
    return new SqliteDocuments(this.database).get<RunRecord>("run");
  }

  async update(
    change: (current: RunRecord | null) => RunRecord
  ): Promise<RunRecord> {
    await this.attempt?.assertOwnership();
    return this.database.transaction(
      async (transaction) => {
        if (this.attempt) {
          const fences = await transaction.execute<{ value: string }>(
            "SELECT value FROM documents WHERE key = ?",
            "attempt"
          );
          if (!fences[0] || JSON.parse(fences[0].value) !== this.attempt.token)
            throw new PipelineError(
              "unavailable",
              "This worker no longer owns the run",
              { retryable: true }
            );
        }
        const rows = await transaction.execute<{ value: string }>(
          "SELECT value FROM documents WHERE key = ?",
          "run"
        );
        const current = rows[0]
          ? (JSON.parse(rows[0].value) as RunRecord)
          : null;
        const cancellations = await transaction.execute<{ value: string }>(
          "SELECT value FROM documents WHERE key = ?",
          "cancelRequested"
        );
        const cancelled =
          current?.cancelRequested ||
          (current?.status !== "completed" &&
            cancellations[0] &&
            JSON.parse(cancellations[0].value) === true);
        const next = change(current);
        if (cancelled && !next.cancelRequested) next.cancelRequested = true;
        if (cancelled && next.status === "completed")
          throw new PipelineError("cancelled", "Processing was cancelled");
        await transaction.execute(
          "INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          "run",
          JSON.stringify(next)
        );
        return next;
      },
      { name: "scrub.run.checkpoint", timeout: 30_000 }
    );
  }
}
