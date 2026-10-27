import { createServer } from "node:http";

export function createMetricsServer(metrics: () => Promise<Response>) {
  return createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const result = await metrics();
      response.writeHead(result.status, {
        "Content-Type": result.headers.get("Content-Type") ?? "text/plain",
      });
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(503);
      response.end("Metrics unavailable\n");
    }
  });
}
