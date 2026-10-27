import { resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "../../src/entrypoints/mcp/handler.js";
import {
  MCP_MAX_ARTIFACT_BYTES,
  MCP_MAX_REQUEST_BYTES,
  MCP_MAX_RESULT_BYTES,
} from "../../src/entrypoints/mcp/server.js";
import { createMcpFixture } from "../helpers/mcp-fixture.js";
import { createNativeCliFixture } from "../helpers/native-cli-fixture.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close())
  );
});
const content = (result: CallToolResult) =>
  result.structuredContent as Record<string, any>;
async function httpClient(fixture = createMcpFixture(), modern = true) {
  const handler = createMcpHandler({
    jobs: fixture.jobs,
    authorize: (request) =>
      request.headers.get("authorization") === "Bearer fixture-auth",
  });
  cleanup.push(handler.close);
  const responses: Response[] = [];
  const transport = new StreamableHTTPClientTransport(
    new URL("https://scrub.example/mcp"),
    {
      requestInit: { headers: { Authorization: "Bearer fixture-auth" } },
      fetch: async (input, init) => {
        const response = await handler.fetch(new Request(input, init));
        responses.push(response);
        return response;
      },
    }
  );
  const client = new Client(
    { name: "scrub-integration-test", version: "1.0.0" },
    { versionNegotiation: { mode: modern ? "auto" : "legacy" } }
  );
  cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, fixture, handler, responses };
}

describe("Scrub MCP application interface", () => {
  it.each([true, false])(
    "serves official SDK clients over stateless HTTP (modern=%s)",
    async (modern) => {
      const { client, fixture, responses } = await httpClient(
        undefined,
        modern
      );
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "scrub_cancel_job",
        "scrub_get_job",
        "scrub_list_results",
        "scrub_read_artifact",
        "scrub_retry_job",
        "scrub_submit_job",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations).toHaveProperty("readOnlyHint");
      }
      expect(
        tools.find((tool) => tool.name === "scrub_get_job")?.annotations
      ).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
      expect(
        tools.find((tool) => tool.name === "scrub_cancel_job")?.annotations
      ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      const submitted = await client.callTool({
        name: "scrub_submit_job",
        arguments: {
          request: {
            url: "https://youtu.be/dQw4w9WgXcQ",
            settings: { inference: { includeFullTranscript: true } },
          },
          idempotencyKey: "fixture-request-1",
        },
      });
      expect(submitted.isError).not.toBe(true);
      expect(content(submitted).job.id).toBe("job-1");
      expect(fixture.state.input).toEqual({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        settings: { inference: { includeFullTranscript: true } },
      });
      expect(fixture.state.input?.concurrency).toBeUndefined();
      expect(fixture.state.key).toBe("fixture-request-1");
      expect(
        content(
          await client.callTool({
            name: "scrub_get_job",
            arguments: { jobId: "job-1" },
          })
        ).job.status
      ).toBe("queued");
      expect(
        responses.every(
          (response) => response.headers.get("mcp-session-id") === null
        )
      ).toBe(true);
      expect(
        responses.every(
          (response) => response.headers.get("cache-control") === "no-store"
        )
      ).toBe(true);
      expect(fixture.state.cancellations).toBe(0);
      expect(
        content(
          await client.callTool({
            name: "scrub_cancel_job",
            arguments: { jobId: "job-1" },
          })
        ).job.status
      ).toBe("cancelled");
      expect(
        content(
          await client.callTool({
            name: "scrub_retry_job",
            arguments: { jobId: "job-1" },
          })
        ).job.status
      ).toBe("queued");
      expect(fixture.state.cancellations).toBe(1);
      expect(fixture.state.retries).toBe(1);
    }
  );

  it("authenticates and rejects hostile origins before reading a body or calling the gateway", async () => {
    const fixture = createMcpFixture();
    let pulled = 0;
    const request = () =>
      new Request("https://scrub.example/mcp", {
        method: "POST",
        body: new ReadableStream(
          {
            pull(controller) {
              pulled++;
              controller.enqueue(new TextEncoder().encode("{"));
              controller.close();
            },
          },
          { highWaterMark: 0 }
        ),
        duplex: "half",
      } as RequestInit);
    const handler = createMcpHandler({ jobs: fixture.jobs });
    cleanup.push(handler.close);
    expect((await handler.fetch(request())).status).toBe(401);
    expect(pulled).toBe(0);
    expect(fixture.state.submissions).toBe(0);
    const authenticated = createMcpHandler({
      jobs: fixture.jobs,
      authorize: () => true,
    });
    cleanup.push(authenticated.close);
    const hostile = request();
    hostile.headers.set("origin", "https://untrusted.example");
    expect((await authenticated.fetch(hostile)).status).toBe(403);
    expect(pulled).toBe(0);
    const unavailable = createMcpHandler({ authorize: () => true });
    cleanup.push(unavailable.close);
    expect((await unavailable.fetch(request())).status).toBe(503);
    expect(pulled).toBe(0);
  });

  it("rejects oversized HTTP messages and strict public settings before work starts", async () => {
    const { client, fixture, handler } = await httpClient();
    const oversized = await handler.fetch(
      new Request("https://scrub.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture-auth",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: " ".repeat(MCP_MAX_REQUEST_BYTES + 1),
      })
    );
    expect(oversized.status).toBe(413);
    for (const request of [
      { url: "https://youtu.be/dQw4w9WgXcQ", settings: [] },
      {
        url: "https://youtu.be/dQw4w9WgXcQ",
        settings: {
          inference: {
            summary: {
              provider: "openai",
              model: "model",
              apiKey: "fixture-value",
            },
          },
        },
      },
      {
        url: "https://youtu.be/dQw4w9WgXcQ",
        settings: { inference: { baseURL: "https://untrusted.example" } },
      },
      { url: "https://untrusted.example/video" },
      { url: "https://youtu.be/dQw4w9WgXcQ", concurrency: 0 },
    ]) {
      const outcome = await client
        .callTool({ name: "scrub_submit_job", arguments: { request } })
        .catch((error: Error) => error);
      expect(outcome instanceof Error || outcome.isError).toBe(true);
      expect(
        outcome instanceof Error ? outcome.message : JSON.stringify(outcome)
      ).not.toContain("fixture-value");
    }
    expect(fixture.state.submissions).toBe(0);
  });

  it("returns bounded result pages with usable continuation offsets", async () => {
    const fixture = createMcpFixture();
    fixture.state.items = Array.from({ length: 35 }, (_, position) => ({
      videoId: `video-${position}`,
      title: "t".repeat(10_000),
      position,
      status: "completed",
      progress: 100,
    }));
    const { client } = await httpClient(fixture);
    let offset = 0;
    const positions: number[] = [];
    do {
      const page = await client.callTool({
        name: "scrub_list_results",
        arguments: { jobId: "job-1", offset, limit: 35 },
      });
      expect(page.isError).not.toBe(true);
      expect(
        new TextEncoder().encode(JSON.stringify(page.structuredContent))
          .byteLength
      ).toBeLessThanOrEqual(MCP_MAX_RESULT_BYTES);
      const data = content(page);
      positions.push(...data.items.map((item: any) => item.position));
      expect(data.items.length).toBeLessThan(35);
      if (!data.hasMore) break;
      expect(data.nextOffset).toBeGreaterThan(offset);
      offset = data.nextOffset;
    } while (offset < 35);
    expect(positions).toEqual(Array.from({ length: 35 }, (_, index) => index));
  });

  it("reads and reconstructs bounded artifact chunks without leaking paths", async () => {
    const fixture = createMcpFixture();
    fixture.state.bytes = Uint8Array.from(
      { length: 150_001 },
      (_, index) => index % 251
    );
    const { client } = await httpClient(fixture);
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await client.callTool({
        name: "scrub_read_artifact",
        arguments: {
          jobId: "job-1",
          videoId: "dQw4w9WgXcQ",
          artifactId: "artifact-1",
          offset,
          length: MCP_MAX_ARTIFACT_BYTES,
        },
      });
      expect(chunk.isError).not.toBe(true);
      const data = content(chunk);
      const bytes = Buffer.from(data.data, "base64");
      parts.push(bytes);
      expect(bytes.byteLength).toBeLessThanOrEqual(MCP_MAX_ARTIFACT_BYTES);
      expect(data.length).toBe(bytes.byteLength);
      expect(data.offset).toBe(offset);
      if (data.nextOffset === undefined) break;
      offset = data.nextOffset;
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(fixture.state.bytes));
    expect(fixture.state.reads).toHaveLength(3);
    const bad = await client
      .callTool({
        name: "scrub_read_artifact",
        arguments: {
          jobId: "job-1",
          videoId: "video",
          artifactId: "../private",
          length: MCP_MAX_ARTIFACT_BYTES + 1,
        },
      })
      .catch((error: Error) => error);
    expect(bad instanceof Error || bad.isError).toBe(true);
    expect(fixture.state.reads).toHaveLength(3);
  });

  it("publishes full-pipeline artifact references without exposing runtime details", async () => {
    const fixture = createMcpFixture();
    const artifact = (kind: string) => ({
      id: `artifact-${kind}`,
      kind,
      size: 12,
      mediaType: "application/json",
    });
    fixture.state.items = [
      {
        videoId: "dQw4w9WgXcQ",
        title: "Completed fixture",
        position: 0,
        status: "completed",
        stage: "completed",
        progress: 100,
        actorId: "private-runtime-actor-id",
        result: {
          mode: "full",
          metadata: {
            contentId: "dQw4w9WgXcQ",
            title: "Completed fixture",
            description: "",
            duration: 2,
            thumbnailUrl: "",
            source: "YouTube",
            uploadDate: "",
            url: "https://youtu.be/dQw4w9WgXcQ",
          },
          transcript: artifact("transcript"),
          transcriptText: artifact("transcriptText"),
          metadataArtifact: artifact("metadata"),
          prompt: artifact("prompt"),
          schema: artifact("schema"),
          audio: artifact("audio"),
          video: artifact("video"),
          framesManifest: artifact("framesManifest"),
          frames: [{ timestamp: 1, artifact: artifact("frame") }],
          inference: {
            visualAnalysis: artifact("visualAnalysis"),
            summary: artifact("summary"),
            markdown: artifact("markdown"),
            modelUsage: artifact("modelUsage"),
          },
          cacheKey: "private-runtime-cache-key",
          completedAt: "2026-10-26T00:01:00.000Z",
          warnings: [],
          stats: {
            downloadTime: 0,
            transcriptionTime: 0,
            frameExtractionTime: 0,
            promptTime: 0,
            totalTime: 0,
          },
        },
      },
    ];
    const { client } = await httpClient(fixture);
    const output = await client.callTool({
      name: "scrub_list_results",
      arguments: { jobId: "job-1" },
    });
    expect(output.isError).not.toBe(true);
    const video = content(output).items[0];
    expect(video.progress).toBe(100);
    expect(Object.keys(video.result.artifacts).sort()).toEqual(
      [
        "transcript",
        "transcriptText",
        "metadataArtifact",
        "prompt",
        "schema",
        "audio",
        "video",
        "framesManifest",
        "visualAnalysis",
        "summary",
        "markdown",
        "modelUsage",
      ].sort()
    );
    expect(video.result.frames).toEqual([
      { timestamp: 1, artifact: artifact("frame") },
    ]);
    expect(JSON.stringify(output)).not.toMatch(
      /private-runtime-actor-id|private-runtime-cache-key/
    );
  });

  it("redacts thrown errors, causes, and persisted provider failure messages", async () => {
    const { client, fixture } = await httpClient();
    for (const jobId of ["explode", "provider-error", "missing"]) {
      const output = await client.callTool({
        name: "scrub_get_job",
        arguments: { jobId },
      });
      expect(output.isError).toBe(true);
      expect(JSON.stringify(output)).not.toMatch(
        /fixture-do-not-expose|secret cause|private credential/
      );
    }
    fixture.state.job = {
      ...fixture.state.job,
      failure: {
        code: "processing_failed",
        message: "fixture-do-not-expose",
        retryable: true,
        stage: "/private/provider-key",
      },
    };
    const output = await client.callTool({
      name: "scrub_get_job",
      arguments: { jobId: "job-1" },
    });
    expect(JSON.stringify(output)).not.toMatch(
      /fixture-do-not-expose|private\/provider/
    );
    expect(content(output).job.failure).toMatchObject({
      code: "processing_failed",
      retryable: true,
    });
  });

  it("serves the same tools through the official stdio client without stdout pollution", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("tests/fixtures/mcp-server.ts")],
      cwd: resolve("."),
      env: {},
      stderr: "pipe",
      maxBufferSize: 256 * 1024,
    });
    const client = new Client(
      { name: "stdio-fixture-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    cleanup.push(() => client.close());
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(6);
    expect(
      content(
        await client.callTool({
          name: "scrub_submit_job",
          arguments: { request: { url: "https://youtu.be/dQw4w9WgXcQ" } },
        })
      ).job.id
    ).toBe("job-1");
    expect(
      content(
        await client.callTool({
          name: "scrub_get_job",
          arguments: { jobId: "job-1" },
        })
      ).job.status
    ).toBe("queued");
    await client.close();
    expect(stderr).toBe("");
  }, 20_000);

  it("shuts down the actual persistent local composition when stdin closes", async () => {
    const fixture = await createNativeCliFixture();
    cleanup.push(() => fixture.dispose());
    const output = await fixture.run(
      [],
      10_000,
      resolve("src/deployments/local/mcp.ts")
    );
    expect(output.timedOut, output.stderr).toBe(false);
    expect(output.exitCode, output.stderr).toBe(0);
    expect(output.stdout).toBe("");
    expect(await fixture.calls()).toEqual([]);
  }, 15_000);
});
