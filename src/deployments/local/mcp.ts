import { createLocalApplicationFromEnvironment } from "./application.js";
import { serveScrubStdio } from "../../infrastructure/node/mcp/stdio.js";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

const application = await createLocalApplicationFromEnvironment(process.env);
let transport: StdioServerHandle | undefined;
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= Promise.resolve().then(async () => {
    await transport?.close();
    await application.close();
  }));
const stop = () => {
  void close().catch(() => {
    process.exitCode = 1;
  });
};
application.signal.addEventListener("abort", stop, { once: true });
transport = serveScrubStdio({ jobs: application.jobs }, { onClose: stop });
process.stdin.once("end", stop);
process.stdin.once("error", stop);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
if (application.signal.aborted || process.stdin.readableEnded) stop();
