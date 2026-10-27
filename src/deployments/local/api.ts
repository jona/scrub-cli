import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "../../entrypoints/api/handler.js";
import { createMcpHandler } from "../../entrypoints/mcp/handler.js";
import { createBearerAuthorizer } from "../../infrastructure/node/http/auth.js";
import {
  createNodeHttpServer,
  parsePort,
} from "../../infrastructure/node/http/server.js";
import { createLocalApplicationFromEnvironment } from "./application.js";

/** One independently deployable host; API and MCP share its application/runtime. */
export async function startLocalApi(env: Record<string, string | undefined>) {
  if (!env.SCRUB_API_TOKEN?.trim())
    throw new Error("Set server-side SCRUB_API_TOKEN before starting the API");
  const port = env.PORT === "0" ? 0 : parsePort(env.PORT, 8080);
  const host = env.SCRUB_HOST ?? "0.0.0.0";
  const allowedOrigins = env.SCRUB_PUBLIC_ORIGINS?.split(",").map(
    (origin) => new URL(origin.trim()).origin
  ) ?? [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const application = createLocalApplicationFromEnvironment(env);
  const authorize = createBearerAuthorizer(env.SCRUB_API_TOKEN);
  const api = createApiHandler({ jobs: application.jobs, authorize });
  const mcp = createMcpHandler({
    jobs: application.jobs,
    authorize,
    allowedOrigins,
  });
  const server = createNodeHttpServer((request) =>
    new URL(request.url).pathname === "/mcp" ? mcp.fetch(request) : api(request)
  );
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      const stopped = new Promise<void>((resolveClosed) =>
        server.close(() => resolveClosed())
      );
      const force = setTimeout(() => server.closeAllConnections(), 5_000);
      force.unref();
      try {
        await application.close();
        await mcp.close();
        await stopped;
      } finally {
        clearTimeout(force);
      }
    }));
  application.signal.addEventListener(
    "abort",
    () => {
      void close();
    },
    { once: true }
  );
  try {
    await new Promise<void>((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolveListening();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { ...application, server, close };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const host = await startLocalApi(process.env);
    const address = host.server.address();
    console.info(
      `Scrub API and MCP listening on port ${typeof address === "object" && address ? address.port : "unknown"}`
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void host.close().catch(() => {
          process.exitCode = 1;
        });
      });
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith("Set server-side")
        ? error.message
        : "Scrub API startup failed"
    );
    process.exitCode = 1;
  }
}
