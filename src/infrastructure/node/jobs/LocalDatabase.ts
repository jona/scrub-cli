import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { PipelineError } from "../../../core/errors.js";

export type LocalWorkKind = "request" | "enumeration" | "video";
export interface LocalWake {
  kind: LocalWorkKind;
  scope: string;
  dueAt: number;
  generation: number;
}

/** One fenced runtime owns a local data root; SQLite serializes ownership changes. */
export class LocalDatabase {
  readonly sql: DatabaseSync;
  private owner?: { id: string; token: number; deadline: number };
  private closed = false;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.sql.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS local_owner (
        id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL,
        token INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_documents (
        scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(scope, name)
      );
      CREATE TABLE IF NOT EXISTS local_members (
        scope TEXT NOT NULL, position INTEGER NOT NULL, video_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL,
        details TEXT NOT NULL, PRIMARY KEY(scope, position), UNIQUE(scope, video_id)
      );
      CREATE INDEX IF NOT EXISTS local_member_status ON local_members(scope, started, status);
      CREATE TABLE IF NOT EXISTS local_wakeups (
        kind TEXT NOT NULL, scope TEXT NOT NULL, due_at INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(kind, scope)
      );
      CREATE INDEX IF NOT EXISTS local_due ON local_wakeups(due_at);
      CREATE TABLE IF NOT EXISTS local_quarantine (
        kind TEXT NOT NULL, scope TEXT NOT NULL, failed_at INTEGER NOT NULL,
        PRIMARY KEY(kind, scope)
      );
    `);
  }

  acquire(owner: string, duration: number): void {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      const current = this.sql
        .prepare(
          "SELECT owner, token, expires_at FROM local_owner WHERE id = 1"
        )
        .get() as
        | { owner: string; token: number; expires_at: number }
        | undefined;
      if (current && current.expires_at > now) {
        throw new PipelineError(
          "unavailable",
          "The local data directory already has an active runtime",
          { retryable: true }
        );
      }
      const token = (current?.token ?? 0) + 1;
      this.sql
        .prepare(
          "INSERT INTO local_owner VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, token=excluded.token, expires_at=excluded.expires_at"
        )
        .run(owner, token, now + duration);
      this.sql.exec("COMMIT");
      this.owner = { id: owner, token, deadline: performance.now() + duration };
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  assertOwned(): void {
    const owner = this.owner;
    if (!owner || this.closed || performance.now() >= owner.deadline) {
      throw new PipelineError(
        "unavailable",
        "Local runtime ownership was lost",
        { retryable: true }
      );
    }
    const row = this.sql
      .prepare("SELECT owner, token, expires_at FROM local_owner WHERE id = 1")
      .get() as
      | { owner: string; token: number; expires_at: number }
      | undefined;
    if (
      !row ||
      row.owner !== owner.id ||
      row.token !== owner.token ||
      row.expires_at <= Date.now()
    ) {
      throw new PipelineError(
        "unavailable",
        "Local runtime ownership was lost",
        { retryable: true }
      );
    }
  }

  renew(duration: number): void {
    this.write(() => {
      this.sql
        .prepare(
          "UPDATE local_owner SET expires_at = ? WHERE id = 1 AND owner = ? AND token = ?"
        )
        .run(Date.now() + duration, this.owner!.id, this.owner!.token);
    });
    this.owner!.deadline = performance.now() + duration;
  }

  write<T>(change: () => T): T {
    this.assertOwned();
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      this.assertOwned();
      const value = change();
      this.assertOwned();
      this.sql.exec("COMMIT");
      return value;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  get<T>(scope: string, name: string): T | null {
    const row = this.sql
      .prepare("SELECT value FROM local_documents WHERE scope = ? AND name = ?")
      .get(scope, name) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      throw new PipelineError("storage_error", "A local job record is corrupt");
    }
  }

  update<T>(scope: string, name: string, change: (current: T | null) => T): T {
    return this.write(() => {
      const next = change(this.get<T>(scope, name));
      this.sql
        .prepare(
          "INSERT INTO local_documents VALUES (?, ?, ?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value"
        )
        .run(scope, name, JSON.stringify(next));
      return next;
    });
  }

  wake(kind: LocalWorkKind, scope: string, dueAt: number | null): void {
    this.write(() => {
      if (dueAt === null)
        this.sql
          .prepare("DELETE FROM local_wakeups WHERE kind = ? AND scope = ?")
          .run(kind, scope);
      else
        this.sql
          .prepare(
            "INSERT INTO local_wakeups(kind,scope,due_at,generation) VALUES (?, ?, ?, 1) ON CONFLICT(kind,scope) DO UPDATE SET due_at=MIN(local_wakeups.due_at,excluded.due_at), generation=local_wakeups.generation+1"
          )
          .run(kind, scope, dueAt);
    });
  }

  /** Consume before execution; a durable recovery intent replaces this within the same transaction. */
  claim(work: LocalWake, recoverAt: number): number | null {
    return this.write(() => {
      const row = this.sql
        .prepare(
          "SELECT due_at, generation FROM local_wakeups WHERE kind = ? AND scope = ?"
        )
        .get(work.kind, work.scope) as
        | { due_at: number; generation: number }
        | undefined;
      if (!row || row.due_at > Date.now()) return null;
      const generation = row.generation + 1;
      this.sql
        .prepare(
          "UPDATE local_wakeups SET due_at = ?, generation = ? WHERE kind = ? AND scope = ?"
        )
        .run(recoverAt, generation, work.kind, work.scope);
      return generation;
    });
  }

  due(limit = 100): LocalWake[] {
    // Queued native work must not hide coordination while all native slots are occupied.
    const now = Date.now();
    const coordination = this.sql
      .prepare(
        "SELECT kind,scope,due_at AS dueAt,generation FROM local_wakeups WHERE kind = 'request' AND due_at <= ? ORDER BY due_at,scope LIMIT ?"
      )
      .all(now, Math.ceil(limit / 2)) as unknown as LocalWake[];
    const native = this.sql
      .prepare(
        "SELECT kind,scope,due_at AS dueAt,generation FROM local_wakeups WHERE kind != 'request' AND due_at <= ? ORDER BY due_at,kind,scope LIMIT ?"
      )
      .all(now, limit - coordination.length) as unknown as LocalWake[];
    return [...coordination, ...native];
  }

  finish(work: LocalWake, generation: number): void {
    this.write(() =>
      this.sql
        .prepare(
          "DELETE FROM local_wakeups WHERE kind = ? AND scope = ? AND generation = ?"
        )
        .run(work.kind, work.scope, generation)
    );
  }

  recoverPending(): void {
    this.write(() => {
      // Recover the commit-before-enqueue gap as well as already scheduled work.
      for (const [name, kind] of [
        ["request", "request"],
        ["request", "enumeration"],
        ["video", "video"],
      ] as const) {
        this.sql
          .prepare(
            "INSERT OR IGNORE INTO local_wakeups(kind,scope,due_at,generation) SELECT ?,scope,?,1 FROM local_documents WHERE name = ?"
          )
          .run(kind, Date.now(), name);
      }
    });
  }

  quarantine(work: LocalWake): void {
    this.write(() => {
      this.sql
        .prepare("INSERT OR REPLACE INTO local_quarantine VALUES (?, ?, ?)")
        .run(work.kind, work.scope, Date.now());
      this.sql
        .prepare("DELETE FROM local_wakeups WHERE kind = ? AND scope = ?")
        .run(work.kind, work.scope);
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      if (this.owner)
        this.sql
          .prepare(
            "UPDATE local_owner SET expires_at = 0 WHERE id = 1 AND owner = ? AND token = ?"
          )
          .run(this.owner.id, this.owner.token);
    } finally {
      this.closed = true;
      this.sql.close();
    }
  }
}
