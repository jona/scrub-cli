import type {
  RunRecord,
  RunRepository,
} from "../../../application/contracts.js";
import type {
  JobMember,
  JobRequestRecord,
  VideoInitialization,
} from "../../../application/jobs/model.js";
import type {
  JobRequestRepository,
  MemberQuery,
  VideoJobRepository,
} from "../../../application/jobs/ports.js";
import { PipelineError } from "../../../core/errors.js";
import { LocalDatabase } from "./LocalDatabase.js";

export class LocalRequestRepository implements JobRequestRepository {
  constructor(
    private readonly database: LocalDatabase,
    readonly scope: string
  ) {}
  async get(): Promise<JobRequestRecord | null> {
    return this.database.get(this.scope, "request");
  }
  async hasMember(videoId: string): Promise<boolean> {
    return !!this.database.sql
      .prepare("SELECT 1 FROM local_members WHERE scope = ? AND video_id = ?")
      .get(this.scope, videoId);
  }
  async countMembers(): Promise<number> {
    return (
      this.database.sql
        .prepare("SELECT COUNT(*) AS count FROM local_members WHERE scope = ?")
        .get(this.scope) as { count: number }
    ).count;
  }
  async update(
    change: (current: JobRequestRecord | null) => JobRequestRecord
  ): Promise<JobRequestRecord> {
    return this.database.update(this.scope, "request", change);
  }
  async appendMember(
    input: { videoId: string; title: string },
    maximum: number
  ): Promise<void> {
    this.database.write(() => {
      if (
        this.database.get<JobRequestRecord>(this.scope, "request")
          ?.cancelRequested
      )
        return;
      if (
        this.database.sql
          .prepare(
            "SELECT 1 FROM local_members WHERE scope = ? AND video_id = ?"
          )
          .get(this.scope, input.videoId)
      )
        return;
      const row = this.database.sql
        .prepare(
          "SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) + 1 AS position FROM local_members WHERE scope = ?"
        )
        .get(this.scope) as { count: number; position: number };
      if (row.count >= maximum)
        throw new PipelineError(
          "resource_limit",
          "Playlist exceeds the configured video limit"
        );
      const details = {
        videoId: input.videoId,
        title: input.title,
        position: row.position,
        status: "queued",
      };
      this.database.sql
        .prepare(
          "INSERT INTO local_members VALUES (?, ?, ?, ?, 'queued', 0, ?)"
        )
        .run(
          this.scope,
          row.position,
          input.videoId,
          input.title,
          JSON.stringify(details)
        );
    });
  }
  async members(query: MemberQuery = {}): Promise<JobMember[]> {
    const conditions = ["scope = ?"];
    const parameters: Array<string | number> = [this.scope];
    if (query.started !== undefined) {
      conditions.push("started = ?");
      parameters.push(Number(query.started));
    }
    if (query.statuses) {
      if (!query.statuses.length) return [];
      conditions.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
      parameters.push(...query.statuses);
    }
    parameters.push(query.limit ?? 10_000, query.offset ?? 0);
    const rows = this.database.sql
      .prepare(
        `SELECT * FROM local_members WHERE ${conditions.join(" AND ")} ORDER BY position LIMIT ? OFFSET ?`
      )
      .all(...parameters) as Array<{
      position: number;
      video_id: string;
      title: string;
      status: JobMember["status"];
      started: number;
      details: string;
    }>;
    try {
      return rows.map((row) => ({
        videoId: row.video_id,
        title: row.title,
        position: row.position,
        status: row.status,
        started: !!row.started,
        details: JSON.parse(row.details) as JobMember["details"],
      }));
    } catch {
      throw new PipelineError(
        "storage_error",
        "A local playlist member record is corrupt"
      );
    }
  }
  async updateMember(member: JobMember): Promise<void> {
    this.database.write(() => {
      this.database.sql
        .prepare(
          "UPDATE local_members SET status = ?, started = ?, details = ? WHERE scope = ? AND position = ? AND video_id = ?"
        )
        .run(
          member.status,
          Number(member.started),
          JSON.stringify(member.details),
          this.scope,
          member.position,
          member.videoId
        );
    });
  }
  async cancelPending(): Promise<void> {
    this.database.write(() =>
      this.database.sql
        .prepare(
          "UPDATE local_members SET status = 'cancelled' WHERE scope = ? AND started = 0 AND status = 'queued'"
        )
        .run(this.scope)
    );
  }
}

export class LocalRunRepository implements RunRepository {
  constructor(
    private readonly database: LocalDatabase,
    private readonly scope: string,
    private readonly attempt?: string
  ) {}
  async get(): Promise<RunRecord | null> {
    return this.database.get(this.scope, "run");
  }
  async update(
    change: (current: RunRecord | null) => RunRecord
  ): Promise<RunRecord> {
    return this.database.update<RunRecord>(this.scope, "run", (current) => {
      if (
        this.attempt &&
        this.database.get<string>(this.scope, "attempt") !== this.attempt
      )
        throw new PipelineError(
          "unavailable",
          "This worker no longer owns the run",
          { retryable: true }
        );
      const next = change(current);
      const cancelled =
        current?.status !== "completed" &&
        (current?.cancelRequested ||
          this.database.get<boolean>(this.scope, "cancellation"));
      if (cancelled && !next.cancelRequested) next.cancelRequested = true;
      if (cancelled && next.status === "completed")
        throw new PipelineError("cancelled", "Processing was cancelled");
      return next;
    });
  }
}

export class LocalVideoRepository implements VideoJobRepository {
  readonly runs: RunRepository;
  constructor(
    private readonly database: LocalDatabase,
    private readonly scope: string
  ) {
    this.runs = new LocalRunRepository(database, scope);
  }
  async getInitialization(): Promise<VideoInitialization | null> {
    return this.database.get(this.scope, "video");
  }
  async initialize(
    input: VideoInitialization
  ): Promise<VideoInitialization | null> {
    return this.database.write(() => {
      const current = this.database.get<VideoInitialization>(
        this.scope,
        "video"
      );
      if (current) return current;
      if (this.database.get<boolean>(this.scope, "cancellation")) return null;
      this.database.sql
        .prepare("INSERT INTO local_documents VALUES (?, 'video', ?)")
        .run(this.scope, JSON.stringify(input));
      return input;
    });
  }
  async getCancellationRequested(): Promise<boolean> {
    return this.database.get<boolean>(this.scope, "cancellation") ?? false;
  }
  async updateCancellation(
    requested: boolean,
    change: (current: RunRecord | null) => RunRecord | null
  ): Promise<RunRecord | null> {
    return this.database.write(() => {
      const next = change(this.database.get<RunRecord>(this.scope, "run"));
      this.database.sql
        .prepare(
          "INSERT INTO local_documents VALUES (?, 'cancellation', ?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value"
        )
        .run(this.scope, JSON.stringify(requested));
      if (next)
        this.database.sql
          .prepare(
            "INSERT INTO local_documents VALUES (?, 'run', ?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value"
          )
          .run(this.scope, JSON.stringify(next));
      return next;
    });
  }
}
