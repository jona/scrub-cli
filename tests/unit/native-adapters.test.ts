import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { FilesystemArtifactStorage } from "../../src/infrastructure/node/FilesystemArtifactStorage.js";
import { NodeMediaProcessor } from "../../src/infrastructure/node/NodeMediaProcessor.js";
import { NodeSourceCatalog } from "../../src/infrastructure/node/NodeSourceCatalog.js";
import { NodeTranscriber } from "../../src/infrastructure/node/NodeTranscriber.js";
import { runCommand } from "../../src/utils/helpers.js";
import type {
  OperationContext,
  PipelineSettings,
} from "../../src/application/contracts.js";
import { resolveInferenceSettings } from "../../src/application/model.js";

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "scrub-native-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});
const bytes = (value: string) => new TextEncoder().encode(value);
const context = (signal = new AbortController().signal): OperationContext => ({
  runId: "test",
  attemptId: "attempt",
  signal,
  now: () => 0,
  emit() {},
});
const settings = (): PipelineSettings => ({
  skipVisuals: false,
  sceneThreshold: 0.4,
  maxFrames: 2,
  minFrameInterval: 2,
  transcription: { provider: "youtube-captions", language: "en" },
  limits: {
    maxDurationSeconds: 60,
    maxSourceBytes: 1024,
    maxArtifactBytes: 2048,
    maxTranscriptCharacters: 1000,
    maxPlaylistVideos: 5,
    stageTimeoutMs: 10000,
    maxAttempts: 1,
  },
});
const success = (stdout = "", stderr = "") => ({ code: 0, stdout, stderr });
async function executable(root: string, name: string, body: string) {
  const path = join(root, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return path;
}

describe("durable filesystem artifact storage", () => {
  it("publishes streamed bytes atomically and reads them after recreation", async () => {
    const root = await temporary();
    const store = new FilesystemArtifactStorage(root);
    const ref = await store.put(
      "test",
      (async function* () {
        yield bytes("hello ");
        yield bytes("world");
      })(),
      "text/plain"
    );
    expect(ref.id).toMatch(/^[a-f0-9]{64}$/);
    expect(ref.size).toBe(11);
    const restored = new FilesystemArtifactStorage(root);
    expect(await restored.has(ref)).toBe(true);
    expect(new TextDecoder().decode(await restored.readRange(ref, 6, 5))).toBe(
      "world"
    );
    expect(await restored.readRange(ref, 99, 5)).toHaveLength(0);
    const chunks = [];
    for await (const chunk of restored.read(ref)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("hello world");
    expect(await readdir(root)).toEqual([ref.id]);
  });
  it("rejects traversal, forged sizes and symlink references", async () => {
    const root = await temporary();
    const store = new FilesystemArtifactStorage(root);
    const ref = await store.put("test", bytes("private"), "text/plain");
    await expect(
      store.readRange({ ...ref, id: "../private" }, 0, 3)
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.readRange({ ...ref, size: 2 }, 0, 3)
    ).rejects.toMatchObject({ code: "storage_error" });
    await expect(store.readRange(ref, -1, 3)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await rm(join(root, ref.id));
    await symlink("/etc/hosts", join(root, ref.id));
    expect(await store.has(ref)).toBe(false);
    await expect(store.readRange(ref, 0, 3)).rejects.toThrow();
  });
  it("removes incomplete files after limits or an interrupted byte stream", async () => {
    const root = await temporary();
    const store = new FilesystemArtifactStorage(root, { maxArtifactBytes: 3 });
    await expect(
      store.put("test", bytes("large"), "text/plain")
    ).rejects.toMatchObject({ code: "resource_limit" });
    await expect(
      store.put(
        "test",
        (async function* () {
          yield bytes("a");
          throw new Error("stream interrupted");
        })(),
        "text/plain"
      )
    ).rejects.toThrow("stream interrupted");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("bounded native processes", () => {
  it("passes arguments without a shell and captures successful output", async () => {
    const value = '"quoted"; $(touch not-a-command)';
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1]);process.stderr.write('diagnostic')",
      value,
    ]);
    expect(result).toMatchObject({
      code: 0,
      stdout: value,
      stderr: "diagnostic",
    });
  });
  it("kills a runaway process at its deadline", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeoutMs: 50,
      })
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("enforces diagnostic byte limits", async () => {
    await expect(
      runCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)",
        ],
        { maxOutputBytes: 100 }
      )
    ).rejects.toMatchObject({ code: "resource_limit" });
  });
  it("cancels work and does not report a killed process as success", async () => {
    const controller = new AbortController();
    const pending = runCommand(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      runCommand(process.execPath, [
        "-e",
        "process.kill(process.pid,'SIGTERM')",
      ])
    ).rejects.toMatchObject({ code: "processing_failed" });
  });
});

describe("semantic native media adapter", () => {
  it("applies one deadline to the full stage and cleans partially generated media", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const input = await storage.put("input", bytes("audio"), "audio/mp3");
    const run = vi.fn<typeof runCommand>(async (_command, args) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (args.includes("-show_entries")) return success("1");
      await writeFile(args.at(-1)!, bytes("wave"));
      return success();
    });
    const media = new NodeMediaProcessor(storage, {
      stagingRoot: join(root, "stage"),
      runCommand: run,
    });
    const bounded = settings();
    bounded.limits.stageTimeoutMs = 120;
    await expect(
      media.acquire(
        { kind: "asset", asset: input, name: "audio.mp3" },
        bounded,
        context()
      )
    ).rejects.toMatchObject({ code: "timeout" });
    expect(await readdir(join(root, "stage"))).toEqual([]);
  });
  it("rejects malformed probe results instead of treating them as zero duration", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const input = await storage.put("input", bytes("audio"), "audio/mp3");
    const run = vi.fn<typeof runCommand>(async () => success("not-a-duration"));
    const media = new NodeMediaProcessor(storage, {
      stagingRoot: join(root, "stage"),
      runCommand: run,
    });
    await expect(
      media.acquire(
        { kind: "asset", asset: input, name: "audio.mp3" },
        settings(),
        context()
      )
    ).rejects.toMatchObject({ code: "processing_failed" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readdir(join(root, "stage"))).toEqual([]);
  });
  it("runs actual configured media executables with paths containing spaces", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const input = await storage.put(
      "input",
      bytes("actual-video"),
      "video/mp4"
    );
    const probe = await executable(
      root,
      "fake probe",
      "process.stdout.write('12')"
    );
    const convert = await executable(
      root,
      "fake converter",
      "const fs=require('node:fs');const args=process.argv.slice(2);const input=args[args.indexOf('-i')+1];fs.writeFileSync(args.at(-1),Buffer.concat([Buffer.from('RIFF'),fs.readFileSync(input)]));"
    );
    const media = new NodeMediaProcessor(storage, {
      stagingRoot: join(root, "stage with spaces"),
      ffprobePath: probe,
      ffmpegPath: convert,
    });
    const result = await media.acquire(
      { kind: "asset", asset: input, name: "example.mp4" },
      settings(),
      context()
    );
    expect(
      new TextDecoder().decode(await storage.readRange(result.audio, 0, 100))
    ).toBe("RIFFactual-video");
    expect(await readdir(join(root, "stage with spaces"))).toEqual([]);
  });
  it("materializes input privately, reuses media primitives and publishes durable output", async () => {
    const root = await temporary();
    const stage = join(root, "stage");
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const input = await storage.put("input", bytes("video-data"), "video/mp4");
    const run = vi.fn<typeof runCommand>(async (command, args) => {
      if (command === "probe") return success("12");
      if (command === "convert") {
        await writeFile(args.at(-1)!, bytes("wave-data"));
        return success();
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const media = new NodeMediaProcessor(storage, {
      stagingRoot: stage,
      ffprobePath: "probe",
      ffmpegPath: "convert",
      runCommand: run,
    });
    const result = await media.acquire(
      { kind: "asset", asset: input, name: "meeting.mp4" },
      settings(),
      context()
    );
    expect(result.metadata).toMatchObject({
      contentId: input.digest,
      title: "meeting",
      duration: 12,
      url: `artifact:${input.id}`,
    });
    expect(await storage.has(result.audio)).toBe(true);
    expect(result.video?.digest).toBe(input.digest);
    expect(await readdir(stage)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("rejects overlong media before conversion and cleans scratch files", async () => {
    const root = await temporary();
    const stage = join(root, "stage");
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const input = await storage.put("input", bytes("audio"), "audio/mp3");
    const run = vi.fn<typeof runCommand>(async () => success("999"));
    const media = new NodeMediaProcessor(storage, {
      stagingRoot: stage,
      runCommand: run,
    });
    await expect(
      media.acquire(
        { kind: "asset", asset: input, name: "talk.mp3" },
        settings(),
        context()
      )
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readdir(stage)).toEqual([]);
  });
  it("extracts bounded frame artifacts using the supplied binary adapter", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const input = await storage.put("video", bytes("video"), "video/mp4");
    const run = vi.fn<typeof runCommand>(async (command, args) => {
      if (command === "probe") return success("20");
      if (args.includes("-filter:v"))
        return success("", "pts_time:2\npts_time:6\npts_time:9\n");
      await writeFile(args.at(-1)!, bytes("png"));
      return success();
    });
    const media = new NodeMediaProcessor(storage, {
      stagingRoot: join(root, "stage"),
      ffprobePath: "probe",
      runCommand: run,
    });
    const frames = await media.extractFrames(input, settings(), context());
    expect(frames.map((frame) => frame.timestamp)).toEqual([2, 6]);
    expect(
      frames.every((frame) => frame.artifact.mediaType === "image/png")
    ).toBe(true);
    expect(await readdir(join(root, "stage"))).toEqual([]);
  });

  it("samples a short static clip for full inference while preserving zero-frame preprocessing", async () => {
    const root = await temporary();
    const stage = join(root, "scratch stage");
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const input = await storage.put("video", bytes("static-clip"), "video/mp4");
    const log = join(root, "frame-commands.jsonl");
    const probe = await executable(
      root,
      "short clip probe",
      "process.stdout.write('0.5')"
    );
    const converter = await executable(
      root,
      "static clip converter",
      `
      const fs=require('node:fs');
      const args=process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
      if(!args.includes('-filter:v'))fs.writeFileSync(args.at(-1),'representative PNG');
    `
    );
    const media = new NodeMediaProcessor(storage, {
      stagingRoot: stage,
      ffprobePath: probe,
      ffmpegPath: converter,
    });
    const preprocessing = await media.extractFrames(
      input,
      settings(),
      context()
    );
    expect(preprocessing).toEqual([]);
    const full = settings();
    full.inference = resolveInferenceSettings({
      mode: "full",
      summary: { provider: "fixture", model: "summary" },
      vision: { provider: "fixture", model: "vision" },
    });
    const frames = await media.extractFrames(input, full, context());
    expect(frames).toHaveLength(1);
    expect(frames[0].timestamp).toBe(0.25);
    expect(frames[0].artifact.mediaType).toBe("image/png");
    expect(
      new TextDecoder().decode(
        await storage.readRange(frames[0].artifact, 0, 100)
      )
    ).toBe("representative PNG");
    const commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.filter((args) => args.includes("-filter:v"))).toHaveLength(
      2
    );
    const sampled = commands.filter((args) => args.includes("-vframes"));
    expect(sampled).toHaveLength(1);
    expect(sampled[0][sampled[0].indexOf("-ss") + 1]).toBe("0.250");
    expect(await readdir(stage)).toEqual([]);
  });
});

describe("bounded lazy source catalog", () => {
  it("uses the remaining enumeration budget for a later page", async () => {
    vi.useFakeTimers();
    const deadlineSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("deadline")), milliseconds);
        return controller.signal;
      });
    try {
      const run = vi.fn<typeof runCommand>(async (_command, args, options) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 60);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("process aborted"));
            },
            { once: true }
          );
        });
        const start = Number(args[args.indexOf("--playlist-start") + 1]);
        return success(
          JSON.stringify({
            title: "Playlist",
            playlist_count: 2,
            entries: [{ id: `AAAAAAAAAA${start}`, title: `Video ${start}` }],
          })
        );
      });
      const catalog = new NodeSourceCatalog({
        pageSize: 1,
        stageTimeoutMs: 100,
        runCommand: run,
      });
      const pendingListing = catalog.enumerate(
        "https://www.youtube.com/playlist?list=PLexample",
        2,
        context()
      );
      await vi.advanceTimersByTimeAsync(60);
      const listing = await pendingListing;
      const iterator = listing.entries[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.position).toBe(1);
      const outcome = iterator.next().then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error })
      );
      await vi.advanceTimersByTimeAsync(60);
      expect((await outcome).error).toMatchObject({
        code: "timeout",
        retryable: true,
        stage: "source",
      });
      expect(run).toHaveBeenCalledTimes(2);
      expect(deadlineSpy).toHaveBeenCalledTimes(1);
    } finally {
      deadlineSpy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("never requests beyond maximum and stops paging when its consumer stops", async () => {
    const calls: number[][] = [];
    const run = vi.fn<typeof runCommand>(async (_command, args) => {
      const start = Number(args[args.indexOf("--playlist-start") + 1]);
      const end = Number(args[args.indexOf("--playlist-end") + 1]);
      calls.push([start, end]);
      return success(
        JSON.stringify({
          title: "Playlist",
          playlist_count: 100,
          entries: Array.from({ length: end - start + 1 }, (_, index) => ({
            id: `AAAAAAAAAA${start + index}`,
            title: `Video ${start + index}`,
          })),
        })
      );
    });
    const catalog = new NodeSourceCatalog({ pageSize: 2, runCommand: run });
    const first = await catalog.enumerate(
      "https://www.youtube.com/playlist?list=PLexample",
      5,
      context()
    );
    for await (const _entry of first.entries) break;
    expect(calls).toEqual([[1, 2]]);
    calls.length = 0;
    const full = await catalog.enumerate(
      "https://www.youtube.com/playlist?list=PLexample",
      5,
      context()
    );
    const items = [];
    for await (const entry of full.entries) items.push(entry);
    expect(items).toHaveLength(5);
    expect(calls).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
  });
  it("rejects unsafe sources and cancellation before launching tools", async () => {
    const run = vi.fn<typeof runCommand>();
    const catalog = new NodeSourceCatalog({ runCommand: run });
    await expect(
      catalog.enumerate("https://example.com/watch?v=AAAAAAAAAA1", 5, context())
    ).rejects.toMatchObject({ code: "invalid_source" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      catalog.enumerate("AAAAAAAAAA1", 5, context(controller.signal))
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("native transcription isolation", () => {
  it("passes quoted Python request fields as JSON data to a real subprocess", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const audio = await storage.put("audio", bytes("wave"), "audio/wav");
    const python = await executable(
      root,
      "fake python",
      "const fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='-c'){process.stdout.write('ok')}else{const request=JSON.parse(fs.readFileSync(args[1],'utf8'));const script=fs.readFileSync(args[0],'utf8');if(script.includes(request.audioPath)||script.includes(request.language))process.exit(8);fs.writeFileSync(request.outputPath,JSON.stringify({segments:[{start:0,end:1,text:request.language}],language:'en',duration:1}));}"
    );
    const transcriber = new NodeTranscriber(storage, {
      stagingRoot: join(root, 'work "quoted"'),
      pythonPath: python,
    });
    const requestSettings = settings();
    requestSettings.transcription = {
      provider: "faster-whisper",
      language: 'en"; not executable',
    };
    const result = await transcriber.transcribe(
      { audio, source: { kind: "asset", asset: audio, name: "audio.wav" } },
      requestSettings,
      context()
    );
    expect(result.fullText).toBe('en"; not executable');
    expect(await readdir(join(root, 'work "quoted"'))).toEqual([]);
  });
  it("runs concurrent Whisper binaries with independent output workspaces", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const first = await storage.put(
      "audio",
      bytes("first-source"),
      "audio/wav"
    );
    const second = await storage.put(
      "audio",
      bytes("second-source"),
      "audio/wav"
    );
    await writeFile(join(root, "ggml-base.bin"), "fake-model");
    const binary = await executable(
      root,
      "fake whisper",
      "const fs=require('node:fs');const args=process.argv.slice(2);const text=fs.readFileSync(args[args.indexOf('-f')+1],'utf8');setTimeout(()=>fs.writeFileSync(args[args.indexOf('-of')+1]+'.json',JSON.stringify({transcription:[{text,offsets:{from:0,to:1000}}],result:{language:'en'}})),30);"
    );
    const transcriber = new NodeTranscriber(storage, {
      stagingRoot: join(root, "stage"),
      whisperBinaryPath: binary,
      whisperModelsPath: root,
    });
    const localSettings = settings();
    localSettings.transcription.provider = "local-whisper";
    const result = await Promise.all(
      [first, second].map((audio) =>
        transcriber.transcribe(
          {
            audio,
            source: { kind: "asset", asset: audio, name: "sample.wav" },
          },
          localSettings,
          context()
        )
      )
    );
    expect(result.map((item) => item.fullText)).toEqual([
      "first-source",
      "second-source",
    ]);
    expect(await readdir(join(root, "stage"))).toEqual([]);
  });
  it("resolves the captions SDK independently of the caller directory and forwards data arguments to its cancellable process", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const audio = await storage.put("source/audio", bytes("wave"), "audio/wav");
    const sdk = join(root, "fixture captions SDK.mjs");
    await writeFile(
      sdk,
      'export const YoutubeTranscript={fetchTranscript:async(id,{lang})=>[{offset:1000,duration:2000,text:id+" "+lang}]};'
    );
    const execute = vi.fn<typeof runCommand>(async (command, args, options) => {
      expect(command).toBe(process.execPath);
      expect(args[3]).toBe(import.meta.resolve("youtube-transcript"));
      expect(args.slice(4)).toEqual(["AAAAAAAAAA1", "en"]);
      expect(options?.signal).toBeDefined();
      expect(options?.timeoutMs).toBe(settings().limits.stageTimeoutMs);
      // Replace only the remote dependency; execute the adapter's actual child
      // script with no node_modules available in its working directory.
      return runCommand(
        command,
        [...args.slice(0, 3), pathToFileURL(sdk).href, ...args.slice(4)],
        { ...options, cwd: root }
      );
    });
    const transcriber = new NodeTranscriber(storage, {
      stagingRoot: join(root, "stage"),
      runCommand: execute,
    });
    const result = await transcriber.transcribe(
      {
        audio,
        source: {
          kind: "youtube",
          url: "https://www.youtube.com/watch?v=AAAAAAAAAA1",
        },
      },
      settings(),
      context()
    );
    expect(result).toMatchObject({
      source: "youtube-captions",
      fullText: "AAAAAAAAAA1 en",
      segments: [{ start: 1, end: 3, text: "AAAAAAAAAA1 en" }],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(await readdir(join(root, "stage"))).toEqual([]);
  });

  it("passes each source explicitly and never reads local user configuration", async () => {
    vi.doMock("../../src/infrastructure/Config.js", () => {
      throw new Error(
        "The native application path must not load user configuration"
      );
    });
    try {
      const root = await temporary();
      const storage = new FilesystemArtifactStorage(join(root, "store"));
      const audio = await storage.put("audio", bytes("wave"), "audio/wav");
      const adapter = {
        name: "Test captions",
        requiresApiKey: false,
        async isAvailable() {
          return true;
        },
        async transcribe(_path: string, options?: { videoUrl?: string }) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            fullText: options?.videoUrl ?? "",
            language: "en",
            duration: 1,
            source: "youtube-captions",
            segments: [],
          };
        },
      };
      const transcriber = new NodeTranscriber(
        storage,
        { stagingRoot: join(root, "stage") },
        { "youtube-captions": adapter }
      );
      const results = await Promise.all(
        ["AAAAAAAAAA1", "AAAAAAAAAA2"].map((id) =>
          transcriber.transcribe(
            {
              audio,
              source: {
                kind: "youtube",
                url: `https://www.youtube.com/watch?v=${id}`,
              },
            },
            settings(),
            context()
          )
        )
      );
      expect(results.map((result) => result.fullText)).toEqual([
        "https://www.youtube.com/watch?v=AAAAAAAAAA1",
        "https://www.youtube.com/watch?v=AAAAAAAAAA2",
      ]);
      expect(await readdir(join(root, "stage"))).toEqual([]);
    } finally {
      vi.doUnmock("../../src/infrastructure/Config.js");
    }
  });
  it.each([
    [401, false],
    [429, true],
    [503, true],
  ])(
    "classifies provider status %i for retry policy",
    async (status, retryable) => {
      const root = await temporary();
      const storage = new FilesystemArtifactStorage(join(root, "store"));
      const audio = await storage.put("audio", bytes("wave"), "audio/wav");
      const adapter = {
        name: "Failing provider",
        requiresApiKey: false,
        async isAvailable() {
          return true;
        },
        async transcribe(): Promise<never> {
          throw Object.assign(new Error("provider failure"), { status });
        },
      };
      const transcriber = new NodeTranscriber(
        storage,
        { stagingRoot: join(root, "stage") },
        { "youtube-captions": adapter }
      );
      await expect(
        transcriber.transcribe(
          {
            audio,
            source: {
              kind: "youtube",
              url: "https://www.youtube.com/watch?v=AAAAAAAAAA1",
            },
          },
          settings(),
          context()
        )
      ).rejects.toMatchObject({ retryable });
    }
  );
  it("enforces transcript bounds before returning provider output", async () => {
    const root = await temporary();
    const storage = new FilesystemArtifactStorage(join(root, "store"));
    const audio = await storage.put("audio", bytes("wave"), "audio/wav");
    const adapter = {
      name: "Large captions",
      requiresApiKey: false,
      async isAvailable() {
        return true;
      },
      async transcribe() {
        return {
          fullText: "x".repeat(1001),
          language: "en",
          duration: 1,
          source: "youtube-captions",
          segments: [],
        };
      },
    };
    const transcriber = new NodeTranscriber(
      storage,
      { stagingRoot: join(root, "stage") },
      { "youtube-captions": adapter }
    );
    await expect(
      transcriber.transcribe(
        {
          audio,
          source: {
            kind: "youtube",
            url: "https://www.youtube.com/watch?v=AAAAAAAAAA1",
          },
        },
        settings(),
        context()
      )
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(await readdir(join(root, "stage"))).toEqual([]);
  });
});
