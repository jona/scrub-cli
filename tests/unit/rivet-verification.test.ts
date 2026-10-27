import { describe, expect, it, vi } from "vitest";
import { verifyRivetDeployment } from "../../scripts/rivet/verify.mjs";

const configuration = {
  endpoint: "https://engine.example.invalid",
  publicUrl: "https://app.example.invalid",
  token: "fixture-server-token",
  key: "fixture-deployment-check",
};
function fixture() {
  let started = false;
  const snapshot = {
    id: configuration.key,
    status: "queued",
    completed: 0,
    failed: 0,
  };
  const text = "Fixture transcript words. ".repeat(8_000);
  const artifacts = {
    transcript: Buffer.from(JSON.stringify({ fullText: text })),
    prompt: Buffer.from(`Summary instructions\n${text}`),
    schema: Buffer.from(JSON.stringify({ title: "ScrubSummary" })),
  };
  const reference = (id: keyof typeof artifacts) => ({
    id,
    size: artifacts[id].byteLength,
  });
  const actor = {
    getStatus: vi.fn(async () =>
      started ? { ...snapshot, status: "completed", completed: 1 } : null
    ),
    start: vi.fn(async (input: { url: string }) => {
      if (input.url.startsWith("https://example.invalid/"))
        throw new Error("Invalid source");
      started = true;
      return snapshot;
    }),
    getResults: vi.fn(async () => ({
      total: 1,
      items: [
        {
          videoId: "dQw4w9WgXcQ",
          result: {
            mode: "preprocess",
            transcript: reference("transcript"),
            prompt: reference("prompt"),
            schema: reference("schema"),
          },
        },
      ],
    })),
    cancel: vi.fn(async () => ({ ...snapshot, status: "cancelled" })),
  };
  const video = {
    readArtifact: vi.fn(
      async (id: keyof typeof artifacts, offset: number, length: number) => ({
        data: artifacts[id]
          .subarray(offset, offset + length)
          .toString("base64"),
        size: artifacts[id].byteLength,
        mediaType: "application/json",
      })
    ),
  };
  const client = {
    scrubRequest: {
      getOrCreate: vi.fn((key: string[]) =>
        key[0].endsWith("-isolation") ? { getStatus: async () => null } : actor
      ),
    },
    scrubVideo: { get: vi.fn(() => video) },
    dispose: vi.fn(async () => undefined),
  };
  const dependencies = {
    createClient: vi.fn(() => client),
    fetch: vi.fn(async (url: URL) =>
      url.pathname === "/healthz"
        ? Response.json({ service: "scrub", status: "ok" })
        : Response.json({ error: "unauthorized" }, { status: 401 })
    ),
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => 0),
  };
  return { dependencies, client, actor, video, text };
}

describe("current Rivet deployment verification", () => {
  it("checks public health, private job routes, and current actor state without starting media work by default", async () => {
    const f = fixture();
    const result = await verifyRivetDeployment(configuration, f.dependencies);
    expect(result).toMatchObject({
      publicHttp: "passed",
      authentication: "passed",
      actor: "scrubRequest",
      invalidInputPreservesState: "passed",
      actorIsolation: "passed",
      pipeline: "unverified",
    });
    expect(f.dependencies.createClient).toHaveBeenCalledWith({
      endpoint: configuration.endpoint,
      token: configuration.token,
    });
    expect(f.actor.start).toHaveBeenCalledTimes(1);
    expect(f.actor.start).toHaveBeenCalledWith({
      url: "https://example.invalid/not-a-youtube-source",
      settings: { inference: { mode: "preprocess" } },
    });
    expect(f.video.readArtifact).not.toHaveBeenCalled();
    expect(f.client.dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(configuration.token);
    expect(
      f.dependencies.fetch.mock.calls.every(
        ([url]) => url.hostname === "app.example.invalid"
      )
    ).toBe(true);
  });

  it("explicitly preprocesses an optional video and reads complete bounded artifacts through the engine SDK", async () => {
    const f = fixture();
    const videoUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const result = await verifyRivetDeployment(
      { ...configuration, videoUrl },
      f.dependencies
    );
    expect(result).toMatchObject({
      pipeline: "passed",
      pipelineArtifacts: "passed",
      mode: "preprocess",
      transcriptCharacters: f.text.length,
    });
    expect(f.actor.start).toHaveBeenLastCalledWith({
      url: videoUrl,
      maxVideos: 1,
      concurrency: 1,
      settings: {
        skipVisuals: true,
        inference: { mode: "preprocess" },
        limits: { maxDurationSeconds: 120 },
      },
    });
    expect(f.video.readArtifact.mock.calls.length).toBeGreaterThan(3);
    expect(
      f.video.readArtifact.mock.calls.every(
        ([, , length]) => length <= 128 * 1024
      )
    ).toBe(true);
    expect(f.actor.cancel).not.toHaveBeenCalled();
    expect(f.client.dispose).toHaveBeenCalledOnce();
  });

  it("stops an unfinished optional job when verification exceeds its deadline", async () => {
    const f = fixture();
    f.actor.getStatus.mockImplementation(async () =>
      f.actor.start.mock.calls.length > 1
        ? { id: configuration.key, status: "running", completed: 0, failed: 0 }
        : null
    );
    f.dependencies.now.mockReturnValueOnce(0).mockReturnValue(300_001);
    await expect(
      verifyRivetDeployment(
        { ...configuration, videoUrl: "https://youtu.be/dQw4w9WgXcQ" },
        f.dependencies
      )
    ).rejects.toThrow("finish successfully");
    expect(f.actor.cancel).toHaveBeenCalledOnce();
    expect(f.client.dispose).toHaveBeenCalledOnce();
  });

  it("refuses an unprotected HTTP interface before creating an SDK client", async () => {
    const f = fixture();
    f.dependencies.fetch.mockResolvedValue(
      Response.json({ service: "scrub", status: "ok" })
    );
    await expect(
      verifyRivetDeployment(configuration, f.dependencies)
    ).rejects.toThrow("authentication");
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
  });

  it("validates separated endpoints before network activity", async () => {
    const f = fixture();
    await expect(
      verifyRivetDeployment(
        { ...configuration, endpoint: configuration.publicUrl },
        f.dependencies
      )
    ).rejects.toThrow("separate");
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
    expect(f.dependencies.createClient).not.toHaveBeenCalled();
  });
});
