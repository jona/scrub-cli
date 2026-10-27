import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PipelineError } from "../../core/errors.js";

/** A local adapter lock; dead owners are recoverable after process termination. */
export async function withDirectoryLock<T>(
  path: string,
  run: () => Promise<T>
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(path);
      const owner = await open(`${path}/owner.json`, "wx", 0o600);
      try {
        await owner.writeFile(JSON.stringify({ pid: process.pid }));
        await owner.sync();
      } finally {
        await owner.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(
          await readFile(`${path}/owner.json`, "utf8")
        ) as { pid: number };
        try {
          process.kill(owner.pid, 0);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "ESRCH") {
            await rm(path, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 60_000) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      }
      if (attempt >= 600)
        throw new PipelineError("storage_error", "Local storage is busy", {
          retryable: true,
        });
      await delay(25);
    }
  }
  try {
    return await run();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
