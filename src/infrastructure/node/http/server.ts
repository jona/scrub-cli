import { createServer, type RequestListener } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function nodeRequestListener(
  handler: (request: Request) => Promise<Response>
): RequestListener {
  return (incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once("aborted", () => controller.abort());
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) controller.abort();
    });
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(`http://localhost${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers,
        signal: controller.signal,
        ...(hasBody
          ? {
              body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              duplex: "half",
            }
          : {}),
      } as RequestInit);
      const result = await handler(request);
      result.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.statusCode = result.status;
      if (result.body)
        await pipeline(
          Readable.fromWeb(
            result.body as import("node:stream/web").ReadableStream
          ),
          outgoing
        );
      else outgoing.end();
    })().catch(() => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ error: "Request failed" }));
      } else outgoing.destroy();
    });
  };
}
export function createNodeHttpServer(
  handler: (request: Request) => Promise<Response>
) {
  const server = createServer(nodeRequestListener(handler));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("Invalid HTTP port");
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error("Invalid HTTP port");
  return port;
}
