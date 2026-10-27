import type { JobVideo, RunRecord } from "../../application/contracts.js";
import type {
  JobMember,
  JobRequestRecord,
  VideoInitialization,
} from "../../application/jobs/model.js";
import type {
  JobRequestRepository,
  MemberQuery,
  VideoJobRepository,
} from "../../application/jobs/ports.js";
import {
  SqliteDocuments,
  SqliteRunRepository,
  type JobDatabase,
} from "./storage.js";

interface MemberRow extends Record<string, unknown> {
  position: number;
  video_id: string;
  title: string;
  status: JobVideo["status"];
  started: number;
  details: string;
}
export class RivetRequestRepository implements JobRequestRepository {
  constructor(private readonly database: JobDatabase) {}
  get(): Promise<JobRequestRecord | null> {
    return new SqliteDocuments(this.database).get("request");
  }
  update(
    change: (current: JobRequestRecord | null) => JobRequestRecord
  ): Promise<JobRequestRecord> {
    return new SqliteDocuments(this.database).update("request", change);
  }
  async appendMember(
    input: { videoId: string; title: string },
    maximum: number
  ): Promise<void> {
    await this.database.transaction(
      async (transaction) => {
        const requests = await transaction.execute<{ value: string }>(
          "SELECT value FROM documents WHERE key = ?",
          "request"
        );
        if (
          !requests[0] ||
          (JSON.parse(requests[0].value) as JobRequestRecord).cancelRequested
        )
          return;
        const counts = await transaction.execute<{
          count: number;
          position: number;
        }>(
          "SELECT COUNT(*) AS count, COALESCE(MAX(position), 0) AS position FROM members"
        );
        if (counts[0].count >= maximum) return;
        const position = counts[0].position + 1;
        const details: JobVideo = {
          videoId: input.videoId,
          title: input.title,
          position,
          status: "queued",
        };
        await transaction.execute(
          "INSERT OR IGNORE INTO members (position, video_id, title, status, started, details) VALUES (?, ?, ?, ?, 0, ?)",
          position,
          input.videoId,
          input.title,
          "queued",
          JSON.stringify(details)
        );
      },
      { name: "scrub.request.member" }
    );
  }
  async members(query: MemberQuery = {}): Promise<JobMember[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.started !== undefined) {
      clauses.push("started = ?");
      parameters.push(query.started ? 1 : 0);
    }
    if (query.statuses) {
      if (!query.statuses.length) return [];
      clauses.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
      parameters.push(...query.statuses);
    }
    let sql = `SELECT * FROM members${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY position`;
    if (query.limit !== undefined || query.offset !== undefined) {
      sql += " LIMIT ? OFFSET ?";
      parameters.push(query.limit ?? -1, query.offset ?? 0);
    }
    return (await this.database.execute<MemberRow>(sql, ...parameters)).map(
      (row) => ({
        videoId: row.video_id,
        title: row.title,
        position: row.position,
        status: row.status,
        started: !!row.started,
        details: JSON.parse(row.details) as JobVideo,
      })
    );
  }
  async updateMember(member: JobMember): Promise<void> {
    await this.database.execute(
      "UPDATE members SET status = ?, started = ?, details = ? WHERE video_id = ?",
      member.status,
      member.started ? 1 : 0,
      JSON.stringify(member.details),
      member.videoId
    );
  }
  async hasMember(videoId: string): Promise<boolean> {
    return (
      (
        await this.database.execute(
          "SELECT video_id FROM members WHERE video_id = ?",
          videoId
        )
      ).length > 0
    );
  }
  async countMembers(): Promise<number> {
    return (
      await this.database.execute<{ count: number }>(
        "SELECT COUNT(*) AS count FROM members"
      )
    )[0].count;
  }
  async cancelPending(): Promise<void> {
    await this.database.execute(
      "UPDATE members SET status = 'cancelled' WHERE started = 0 AND status = 'queued'"
    );
  }
}
export class RivetVideoRepository implements VideoJobRepository {
  readonly runs: SqliteRunRepository;
  constructor(private readonly database: JobDatabase) {
    this.runs = new SqliteRunRepository(database);
  }
  getInitialization(): Promise<VideoInitialization | null> {
    return new SqliteDocuments(this.database).get("video");
  }
  async initialize(
    input: VideoInitialization
  ): Promise<VideoInitialization | null> {
    return this.database.transaction(
      async (transaction) => {
        const documents = new SqliteDocuments(transaction);
        const existing = await documents.get<VideoInitialization>("video");
        if (existing) return existing;
        if ((await documents.get<boolean>("cancelRequested")) === true)
          return null;
        await transaction.execute(
          "INSERT INTO documents (key, value) VALUES (?, ?)",
          "video",
          JSON.stringify(input)
        );
        return input;
      },
      { name: "scrub.video.initialize" }
    );
  }
  async getCancellationRequested(): Promise<boolean> {
    return (
      (await new SqliteDocuments(this.database).get<boolean>(
        "cancelRequested"
      )) === true
    );
  }
  async updateCancellation(
    requested: boolean,
    change: (current: RunRecord | null) => RunRecord | null
  ): Promise<RunRecord | null> {
    return this.database.transaction(
      async (transaction) => {
        const documents = new SqliteDocuments(transaction);
        const next = change(await documents.get<RunRecord>("run"));
        await transaction.execute(
          "INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          "cancelRequested",
          JSON.stringify(requested)
        );
        if (next)
          await transaction.execute(
            "INSERT INTO documents (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            "run",
            JSON.stringify(next)
          );
        return next;
      },
      { name: "scrub.video.cancel" }
    );
  }
}
