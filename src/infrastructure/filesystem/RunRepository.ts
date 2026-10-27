import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunRecord, RunRepository } from "../../application/contracts.js";
import { withDirectoryLock } from "./locking.js";

export class FilesystemRunRepository implements RunRepository {
  constructor(private readonly file: string) {}
  async get(): Promise<RunRecord | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as RunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async update(
    change: (current: RunRecord | null) => RunRecord
  ): Promise<RunRecord> {
    return withDirectoryLock(`${this.file}.lock`, async () => {
      const next = change(await this.get());
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.file);
        const directory = await open(dirname(this.file), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
      return next;
    });
  }
}
