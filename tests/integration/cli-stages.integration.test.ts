import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeCliFixture,
  FIRST_VIDEO,
  PLAYLIST_URL,
  readJson,
} from "../helpers/native-cli-fixture.js";

const fixtures: Awaited<ReturnType<typeof createNativeCliFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("manual CLI stages through application use cases", () => {
  it("uses an explicitly configured Python for faster-whisper when PATH Python has no module", async () => {
    const f = await createNativeCliFixture();
    fixtures.push(f);
    const python = join(f.root, "configured Python");
    const calls = join(f.root, "configured-python.jsonl");
    await writeFile(
      python,
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='-c')process.stdout.write('ok');else{const request=JSON.parse(fs.readFileSync(args[1],'utf8'));fs.writeFileSync(request.outputPath,JSON.stringify({segments:[{start:0,end:1,text:'Configured Python transcript'}],language:'en',duration:1}));}`,
      { mode: 0o700 }
    );
    const entry = await f.file(
      "configured-python-entry.mjs",
      `process.env.SCRUB_PYTHON_PATH=${JSON.stringify(python)};await import(${JSON.stringify(pathToFileURL(resolve("src/deployments/local/cli.ts")).href)});`
    );
    const audio = await f.file("audio.wav");
    const output = join(f.root, "configured-transcript.json");
    const result = await f.run(
      ["transcribe", audio, "--transcriber", "faster-whisper", "-o", output],
      12_000,
      entry
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(await readJson(output)).toMatchObject({
      source: "faster-whisper",
      fullText: "Configured Python transcript",
    });
    const invocations = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(2);
    expect(invocations[0][0]).toBe("-c");
    expect(invocations[1][0]).toMatch(/transcribe\.py$/);
  });

  it("keeps doctor and transcription discovery available through the active CLI diagnostics", async () => {
    const f = await createNativeCliFixture();
    fixtures.push(f);
    const doctor = await f.run(["doctor"]);
    expect(doctor.exitCode, doctor.stdout + doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain("ffmpeg");
    expect(doctor.stdout).toContain("yt-dlp");
    expect(doctor.stdout).toContain("Local Whisper");
    const adapters = await f.run(["transcribers"]);
    expect(adapters.exitCode, adapters.stdout + adapters.stderr).toBe(0);
    expect(adapters.stdout).toContain("local-whisper");
    expect(
      (await f.calls()).some((call) =>
        ["yt-dlp", "ffmpeg", "whisper"].includes(call.tool)
      )
    ).toBe(false);
  });

  it("actually reprocesses every repeated playlist occurrence with --no-skip-existing", async () => {
    const f = await createNativeCliFixture();
    fixtures.push(f);
    await f.playlist([FIRST_VIDEO, FIRST_VIDEO, FIRST_VIDEO]);
    const result = await f.run([
      "youtube",
      PLAYLIST_URL,
      "--parallel",
      "2",
      "--no-visuals",
      "--no-skip-existing",
    ]);
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toMatch(/Succeeded:\s*3/);
    expect(result.stdout).not.toMatch(/Skipped:\s*[1-9]/);
    expect(
      (await f.calls()).filter((call) => call.tool === "whisper")
    ).toHaveLength(3);
  }, 30_000);

  it("downloads, transcribes and extracts frames using preserved primitive paths and manifests", async () => {
    const f = await createNativeCliFixture();
    fixtures.push(f);
    const output = join(f.root, "download output");
    const downloaded = await f.run([
      "download",
      `https://youtu.be/${FIRST_VIDEO}`,
      "-o",
      output,
    ]);
    expect(downloaded.exitCode, downloaded.stderr + downloaded.stdout).toBe(0);
    expect(await readJson(join(output, "metadata.json"))).toMatchObject({
      contentId: FIRST_VIDEO,
      title: "First Video",
    });
    expect(await readFile(join(output, "video.mp4"), "utf8")).toContain(
      FIRST_VIDEO
    );
    const transcript = join(f.root, "transcript.json");
    const text = join(f.root, "transcript.txt");
    const transcribed = await f.run([
      "transcribe",
      join(output, "audio.wav"),
      "-t",
      "local-whisper",
      "-o",
      transcript,
      "--text",
      text,
    ]);
    expect(transcribed.exitCode, transcribed.stderr + transcribed.stdout).toBe(
      0
    );
    const result = await readJson<{ fullText: string; source: string }>(
      transcript
    );
    expect(result.source).toBe("local-whisper");
    expect(result.fullText).toContain(FIRST_VIDEO);
    expect(await readFile(text, "utf8")).toBe(result.fullText);
    const manifest = join(f.root, "frames.json");
    const frames = join(f.root, "frame output");
    const extracted = await f.run([
      "extract-frames",
      join(output, "video.mp4"),
      "-o",
      manifest,
      "--output-dir",
      frames,
      "--max-frames",
      "2",
    ]);
    expect(extracted.exitCode, extracted.stderr + extracted.stdout).toBe(0);
    expect(await readJson(manifest)).toEqual([
      { timestamp: 5, path: "frame output/frame_001.png" },
      { timestamp: 12, path: "frame output/frame_002.png" },
    ]);
    expect(await readFile(join(frames, "frame_001.png"), "utf8")).toBe(
      "fixture PNG bytes"
    );
  }, 30_000);

  it("prepares a local file with its legacy source identity and honors audio-only download", async () => {
    const f = await createNativeCliFixture();
    fixtures.push(f);
    const input = await f.file("local recording.mp4");
    const output = join(f.root, "prepared output");
    const prepared = await f.run(["prepare", input, "-o", output]);
    expect(prepared.exitCode, prepared.stderr + prepared.stdout).toBe(0);
    expect(await readJson(join(output, "metadata.json"))).toMatchObject({
      contentId: `local-${createHash("sha256").update(input).digest("hex").slice(0, 11)}`,
      title: "local recording",
      source: "Local File",
      url: `file://${input}`,
      duration: 30,
    });
    expect(await readFile(join(output, "audio.wav"), "utf8")).toContain(
      "fixture local media"
    );
    const audioOutput = join(f.root, "audio only");
    const downloaded = await f.run([
      "download",
      `https://youtu.be/${FIRST_VIDEO}`,
      "-o",
      audioOutput,
      "--no-video",
    ]);
    expect(downloaded.exitCode, downloaded.stderr + downloaded.stdout).toBe(0);
    expect(await readFile(join(audioOutput, "audio.wav"), "utf8")).toContain(
      FIRST_VIDEO
    );
    expect(
      (await f.calls()).filter(
        (call) => call.tool === "yt-dlp" && !call.args.includes("--print")
      )
    ).toHaveLength(1);
  }, 30_000);
});
