import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeCliFixture,
  FIRST_VIDEO,
  SECOND_VIDEO,
  UNAVAILABLE_VIDEO,
  PLAYLIST_URL,
  readJson,
} from "../helpers/native-cli-fixture.js";
const fixtures: Awaited<ReturnType<typeof createNativeCliFixture>>[] = [];
async function fixture() {
  const value = await createNativeCliFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()));
});
describe("local CLI playlist integration", () => {
  it("retains successes after an unavailable member and deduplicates repeated videos", async () => {
    const f = await fixture();
    await f.playlist([
      FIRST_VIDEO,
      UNAVAILABLE_VIDEO,
      SECOND_VIDEO,
      FIRST_VIDEO,
    ]);
    const result = await f.run([
      "youtube",
      PLAYLIST_URL,
      "--parallel",
      "2",
      "--no-visuals",
    ]);
    expect(result.timedOut, result.stdout + result.stderr).toBe(false);
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).not.toMatch(
      /Raw mode|unsettled top-level await|React is not defined/
    );
    for (const directory of ["first-video", "second-video"])
      await access(join(f.output, directory, "prompt/summary.prompt.md"));
    expect(result.stdout).toMatch(/Succeeded:\s*2/);
    expect(result.stdout).toMatch(/Failed:\s*1/);
    expect(result.stdout).toMatch(/Skipped:\s*1/);
    const index = await readJson<{ media: Record<string, unknown> }>(
      join(f.output, "index.json")
    );
    expect(Object.keys(index.media).sort()).toEqual(
      [SECOND_VIDEO, FIRST_VIDEO].sort()
    );
    expect(
      (await f.calls()).filter((call) => call.tool === "whisper")
    ).toHaveLength(2);
  });
  it("honors playlist limits and --no-skip-existing on repeat requests", async () => {
    const f = await fixture();
    const args = [
      "youtube",
      PLAYLIST_URL,
      "--max-videos",
      "1",
      "--parallel",
      "2",
      "--no-visuals",
    ];
    const first = await f.run(args);
    expect(first.timedOut, first.stdout + first.stderr).toBe(false);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(
      Object.keys(
        (
          await readJson<{ media: Record<string, unknown> }>(
            join(f.output, "index.json")
          )
        ).media
      )
    ).toEqual([FIRST_VIDEO]);
    const before = (await f.calls()).filter(
      (call) => call.tool === "whisper"
    ).length;
    const second = await f.run([...args, "--no-skip-existing"]);
    expect(second.exitCode, second.stdout + second.stderr).toBe(0);
    expect(
      (await f.calls()).filter((call) => call.tool === "whisper")
    ).toHaveLength(before + 1);
    expect(second.stdout).toMatch(/Succeeded:\s*1/);
    const enumeration = (await f.calls()).filter(
      (call) => call.tool === "yt-dlp" && call.args.includes("--flat-playlist")
    );
    expect(
      enumeration.every(
        (call) => call.args[call.args.indexOf("--playlist-end") + 1] === "1"
      )
    ).toBe(true);
  });
});
