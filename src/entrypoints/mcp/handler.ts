import { createMcpHandler as createSdkHandler } from "@modelcontextprotocol/server";
import type { JobGateway } from "../../application/contracts.js";
import { createScrubMcpServer, MCP_MAX_REQUEST_BYTES } from "./server.js";

export interface McpHttpDependencies {
  jobs?: JobGateway;
  authorize?: (request: Request) => boolean | Promise<boolean>;
  /** Browser origins accepted by the host, including its public HTTPS origin behind a proxy. */
  allowedOrigins?: readonly string[];
}
export interface ScrubMcpHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
function failure(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/** Authenticated stateless Streamable HTTP. The host owns routing, listening, and job lifetime. */
export function createMcpHandler(
  dependencies: McpHttpDependencies = {}
): ScrubMcpHttpHandler {
  const sdk = createSdkHandler(
    () => {
      if (!dependencies.jobs) throw new Error("Job service is not configured");
      return createScrubMcpServer({ jobs: dependencies.jobs });
    },
    {
      legacy: "stateless",
      responseMode: "json",
      maxRequestBodySize: MCP_MAX_REQUEST_BYTES,
    }
  );
  return {
    close: () => sdk.close(),
    fetch: async (request) => {
      try {
        if (new URL(request.url).pathname !== "/mcp")
          return failure("not_found", "Not found", 404);
        if (!dependencies.authorize || !(await dependencies.authorize(request)))
          return failure("unauthorized", "Authentication required", 401, {
            "WWW-Authenticate": "Bearer",
          });
        const origin = request.headers.get("origin");
        if (
          origin &&
          !(
            dependencies.allowedOrigins ?? [new URL(request.url).origin]
          ).includes(origin)
        )
          return failure("forbidden", "Origin is not allowed", 403);
        if (!dependencies.jobs)
          return failure("unavailable", "Job service is not configured", 503);
        const response = await sdk.fetch(request);
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch {
        return failure("internal_error", "MCP request failed", 500);
      }
    },
  };
}
