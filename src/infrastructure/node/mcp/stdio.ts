import {
  StdioServerTransport,
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import {
  createScrubMcpServer,
  MCP_MAX_REQUEST_BYTES,
  type McpDependencies,
} from "../../../entrypoints/mcp/server.js";

/** Only this host adapter depends on Node streams; stdout remains reserved for MCP. */
export function serveScrubStdio(
  dependencies: McpDependencies,
  streams: { input?: Readable; output?: Writable; onClose?: () => void } = {}
): StdioServerHandle {
  const transport = new StdioServerTransport(streams.input, streams.output, {
    maxBufferSize: MCP_MAX_REQUEST_BYTES,
  });
  const handle = serveStdio(() => createScrubMcpServer(dependencies), {
    transport,
  });
  const close = transport.onclose;
  transport.onclose = () => {
    close?.();
    streams.onClose?.();
  };
  return handle;
}
