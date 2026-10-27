import { describe, expect, it, vi } from "vitest";
import { runPlaylistForeground } from "../../src/application/jobs/foreground.js";
import { planJobDispatch } from "../../src/application/jobs/dispatch.js";
import type {
  JobSubmission,
  OperationContext,
  SourceCatalog,
} from "../../src/application/contracts.js";
import { PipelineError } from "../../src/core/errors.js";

const url = "https://www.youtube.com/playlist?list=PL_fixture123";
const ids = ["dQw4w9WgXcQ", "aaaaaaaaaaa", "dQw4w9WgXcQ", "bbbbbbbbbbb"];
function fixture(input: JobSubmission = { url }) {
  const consumed: string[] = [];
  let closed = false;
  const catalog: SourceCatalog = {
    enumerate: vi.fn(async () => ({
      metadata: {
        playlistId: "PL_fixture123",
        title: "Fixture",
        description: "",
        channelName: "",
        videoCount: ids.length,
        url,
      },
      entries: (async function* () {
        try {
          for (const [index, id] of ids.entries()) {
            consumed.push(id);
            yield {
              contentId: id,
              title: id,
              duration: 30,
              position: index + 1,
              url: `https://www.youtube.com/watch?v=${id}`,
            };
          }
        } finally {
          closed = true;
        }
      })(),
    })),
  };
  let clock = 1_700_000_000_000;
  const controller = new AbortController();
  const context: OperationContext = {
    runId: "foreground",
    attemptId: "attempt",
    signal: controller.signal,
    now: () => clock++,
    emit: () => undefined,
  };
  return {
    input,
    catalog,
    context,
    controller,
    consumed,
    closed: () => closed,
  };
}

describe("foreground and durable job dispatch policy", () => {
  it("shares capacity, fail-fast and cancellation decisions while retaining occurrence identity", () => {
    const members = [
      { started: true, status: "running" },
      { started: false, status: "queued" },
      { started: false, status: "queued" },
      { started: true, status: "failed" },
    ];
    expect(
      planJobDispatch(members, {
        concurrency: 2,
        cancelRequested: false,
        continueOnError: true,
      })
    ).toEqual({ start: [members[1]], cancel: [], cancelPending: [] });
    expect(
      planJobDispatch(members, {
        concurrency: 2,
        cancelRequested: false,
        continueOnError: false,
      })
    ).toEqual({
      start: [],
      cancel: [members[0]],
      cancelPending: members.slice(1, 3),
    });
    expect(
      planJobDispatch(members, {
        concurrency: 2,
        cancelRequested: true,
        continueOnError: true,
      })
    ).toEqual({
      start: [],
      cancel: [members[0]],
      cancelPending: members.slice(1, 3),
    });
  });

  it.each([true, false])(
    "preserves duplicate occurrences, maxVideos and --skip-existing=%s semantics",
    async (skipExisting) => {
      const f = fixture({ url, maxVideos: 3, concurrency: 2, skipExisting });
      const seen = new Set<string>();
      const calls: string[] = [];
      let active = 0;
      let peak = 0;
      const result = await runPlaylistForeground(
        f.input,
        {
          catalog: f.catalog,
          process: async (entry, _playlist, context) => {
            expect(context.runId).toMatch(/^foreground\/[123]$/);
            active++;
            peak = Math.max(peak, active);
            calls.push(entry.contentId);
            const reused = skipExisting && seen.has(entry.contentId);
            seen.add(entry.contentId);
            await Promise.resolve();
            active--;
            return { reused };
          },
        },
        f.context
      );
      expect(calls).toEqual(ids.slice(0, 3));
      expect(f.consumed).toEqual(ids.slice(0, 3));
      expect(f.closed()).toBe(true);
      expect(peak).toBe(2);
      expect(result.videos.map((video) => video.status)).toEqual([
        "completed",
        "completed",
        skipExisting ? "skipped" : "completed",
      ]);
    }
  );

  it("continues independent failures without canceling the caller or losing later occurrences", async () => {
    const f = fixture({ url, concurrency: 1, continueOnError: true });
    const result = await runPlaylistForeground(
      f.input,
      {
        catalog: f.catalog,
        process: async (entry) => {
          if (entry.position === 2)
            throw new PipelineError(
              "unavailable",
              "Fixture source unavailable",
              { retryable: true }
            );
          return { reused: false };
        },
      },
      f.context,
      {
        onUpdate: () => {
          throw new Error("UI disconnected");
        },
      }
    );
    expect(result.videos.map((video) => video.status)).toEqual([
      "completed",
      "failed",
      "completed",
      "completed",
    ]);
    expect(result.videos[1].failure).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(f.context.signal.aborted).toBe(false);
  });

  it("cancels active work and prevents pending dispatch after a fail-fast failure", async () => {
    const f = fixture({ url, concurrency: 2, continueOnError: false });
    const calls: number[] = [];
    let cleaned = false;
    await expect(
      runPlaylistForeground(
        f.input,
        {
          catalog: f.catalog,
          process: async (entry, _playlist, context) => {
            calls.push(entry.position);
            if (entry.position === 1)
              throw new PipelineError("unavailable", "Fixture failed");
            await new Promise<void>((_resolve, reject) =>
              context.signal.addEventListener(
                "abort",
                () => {
                  cleaned = true;
                  reject(new PipelineError("cancelled", "Stopped"));
                },
                { once: true }
              )
            );
            return { reused: false };
          },
        },
        f.context
      )
    ).rejects.toThrow("Playlist processing aborted: Fixture failed");
    expect(calls).toEqual([1, 2]);
    expect(cleaned).toBe(true);
    expect(f.context.signal.aborted).toBe(false);
  });

  it("waits for active cancellation cleanup and rejects a cancelled foreground request", async () => {
    const f = fixture({ url, concurrency: 1 });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cleaned = false;
    const process = vi.fn(
      async (_entry, _playlist, context: OperationContext) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => {
              cleaned = true;
              reject(new PipelineError("cancelled", "Stopped"));
            },
            { once: true }
          )
        );
        return { reused: false };
      }
    );
    const running = runPlaylistForeground(
      f.input,
      { catalog: f.catalog, process },
      f.context
    );
    await ready;
    f.controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(cleaned).toBe(true);
    expect(process).toHaveBeenCalledTimes(1);
  });
});
