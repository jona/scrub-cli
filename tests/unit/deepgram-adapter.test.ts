import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepgramClient } from "@deepgram/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineError } from "../../src/core/errors.js";
import { DeepgramAdapter } from "../../src/infrastructure/transcription/adapters/DeepgramAdapter.js";
import { TranscriberFactory } from "../../src/infrastructure/transcription/TranscriberFactory.js";
import type { TranscriptionConfiguration } from "../../src/infrastructure/transcription/environment.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const configuration = (apiKey?: string): TranscriptionConfiguration => ({
  getApiKey: () => apiKey,
  getTranscription: () => ({
    priority: ["deepgram"],
    whisperModel: "base",
    language: "en",
  }),
  getLocalWhisper: () => ({}),
  getCacheDir: () => tmpdir(),
  resolvePath: (path) => path,
});
const response = () => ({
  metadata: { duration: 4 },
  results: {
    channels: [
      {
        detected_language: "en",
        alternatives: [{ transcript: " Hello world. ", confidence: 0.98 }],
      },
    ],
    utterances: [
      { start: 0.2, end: 1.4, transcript: " Hello ", confidence: 0.99 },
      { start: 2.1, end: 3.6, transcript: " world. ", confidence: 0.97 },
    ],
  },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function fixture(fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), "scrub-deepgram-"));
  directories.push(directory);
  const audioPath = join(directory, "sample audio.wav");
  await writeFile(audioPath, "RIFF fixture audio");
  const environment = {
    config: configuration(),
    deepgramClient: new DeepgramClient({
      apiKey: "fixture-deepgram-key",
      fetch,
      logging: { silent: true },
    }),
  };
  return { audioPath, environment, adapter: new DeepgramAdapter(environment) };
}

describe("Deepgram v5 transcription adapter", () => {
  it("uses host credentials and the real SDK to stream audio and parse utterances", async () => {
    let uploaded = "";
    let stream: ReadStream | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      stream = init?.body as unknown as ReadStream;
      for await (const chunk of stream) uploaded += chunk.toString();
      return json(response());
    });
    const f = await fixture(fetch);
    vi.stubGlobal("fetch", fetch);
    const adapter = new DeepgramAdapter({
      config: configuration("fixture-host-key"),
    });
    expect(await adapter.isAvailable()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();

    const result = await adapter.transcribe(f.audioPath, { timeoutMs: 1_250 });
    expect(result).toEqual({
      fullText: "Hello world.",
      duration: 4,
      language: "en",
      source: "deepgram",
      segments: [
        { start: 0.2, end: 1.4, text: "Hello", confidence: 0.99 },
        { start: 2.1, end: 3.6, text: "world.", confidence: 0.97 },
      ],
    });
    expect(uploaded).toBe("RIFF fixture audio");
    expect(stream?.destroyed).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(
      "https://api.deepgram.com/v1/listen"
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: "nova-2",
      language: "en",
      detect_language: "false",
      smart_format: "true",
      punctuate: "true",
      paragraphs: "true",
      utterances: "true",
    });
    expect(url.searchParams.has("mimetype")).toBe(false);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(headers.get("authorization")).toBe("Token fixture-host-key");
  });

  it("does not pick up ambient SDK credentials when the host has no configured key", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "fixture-ambient-key");
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const adapter = new DeepgramAdapter({ config: configuration() });
    expect(await adapter.isAvailable()).toBe(false);
    await expect(adapter.transcribe("missing.wav")).rejects.toThrow(
      "Deepgram API key not configured"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["auto", "es"])(
    "honors the request language %s with an injected v5 client",
    async (language) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json(response())
      );
      const f = await fixture(fetch);
      await f.adapter.transcribe(f.audioPath, { language });
      const url = new URL(String(fetch.mock.calls[0][0]));
      expect(url.searchParams.get("detect_language")).toBe(
        String(language === "auto")
      );
      expect(url.searchParams.get("language")).toBe(
        language === "auto" ? null : language
      );
    }
  );

  it("preserves word timestamps when utterances are absent", async () => {
    const body = response();
    const words = [
      {
        word: "hello",
        punctuated_word: "Hello",
        start: 0.2,
        end: 0.6,
        confidence: 0.9,
      },
      {
        word: "world",
        punctuated_word: "world",
        start: 0.7,
        end: 1,
        confidence: 0.9,
      },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({
        metadata: body.metadata,
        results: {
          channels: [{ alternatives: [{ transcript: "Hello world", words }] }],
        },
      })
    );
    const f = await fixture(fetch);
    expect(await f.adapter.transcribe(f.audioPath)).toMatchObject({
      fullText: "Hello world",
      segments: [{ start: 0.2, end: 1, text: "Hello world", confidence: 0.9 }],
    });
  });

  it("falls back to the complete transcript when timestamps are absent", async () => {
    const body = response();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({
        metadata: body.metadata,
        results: { channels: body.results.channels },
      })
    );
    const f = await fixture(fetch);
    expect(await f.adapter.transcribe(f.audioPath)).toMatchObject({
      segments: [{ start: 0, end: 4, text: "Hello world.", confidence: 0.98 }],
    });
  });

  it.each([
    {},
    { request_id: "callback-only" },
    { results: { channels: [{ alternatives: [{}] }] } },
    {
      ...response(),
      results: {
        ...response().results,
        utterances: [{ transcript: "missing times" }],
      },
    },
    {
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "bad",
                words: [{ word: "bad", start: -1, end: 1 }],
              },
            ],
          },
        ],
      },
    },
  ])("rejects a response without usable transcript data: %j", async (body) => {
    let stream: ReadStream | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      stream = init?.body as unknown as ReadStream;
      return json(body);
    });
    const f = await fixture(fetch);
    await expect(f.adapter.transcribe(f.audioPath)).rejects.toThrow();
    expect(stream?.destroyed).toBe(true);
  });

  it.each([
    [400, false],
    [401, false],
    [429, true],
    [503, true],
  ])(
    "preserves runtime retry classification for HTTP %i without replaying the upload",
    async (status, retryable) => {
      let stream: ReadStream | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        stream = init?.body as unknown as ReadStream;
        return json({ err_msg: "fixture-private-provider-body" }, status);
      });
      const f = await fixture(fetch);
      const factory = new TranscriberFactory(f.environment);
      const error = await factory
        .transcribe(f.audioPath)
        .catch((error) => error);
      expect(error).toBeInstanceOf(PipelineError);
      expect(error).toMatchObject({
        code: "capability_unavailable",
        retryable,
      });
      expect(error.cause[0]).toMatchObject({
        code: status === 429 ? "rate_limited" : "processing_failed",
        message: "Deepgram transcription failed",
        retryable,
        cause: { statusCode: status },
      });
      expect(JSON.stringify(error)).not.toContain(
        "fixture-private-provider-body"
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(stream?.destroyed).toBe(true);
    }
  );

  it("rejects a cancelled request before opening a file or contacting the provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const f = await fixture(fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.adapter.transcribe("missing.wav", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["cancellation", "timeout"])(
    "propagates %s through the real SDK transport and closes the audio stream",
    async (mode) => {
      let stream: ReadStream | undefined;
      let started!: () => void;
      const active = new Promise<void>((resolve) => {
        started = resolve;
      });
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        stream = init?.body as unknown as ReadStream;
        stream.on("error", () => {});
        stream.resume();
        started();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Stopped", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      });
      const f = await fixture(fetch);
      const controller = new AbortController();
      const pending = f.adapter.transcribe(f.audioPath, {
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 25 : 100,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: mode === "timeout" ? "timeout" : "cancelled",
        retryable: mode === "timeout",
        stage: "transcribe",
      });
      await active;
      if (mode === "cancellation") controller.abort();
      await assertion;
      expect(fetch).toHaveBeenCalledOnce();
      expect(stream?.destroyed).toBe(true);
    }
  );
});
