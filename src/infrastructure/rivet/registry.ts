import { setup } from "rivetkit";
import { scrubAdmission, scrubRequest, scrubVideo } from "./jobs.js";
import { scrubCredentials } from "./credentials.js";

export const registry = setup({
  startEngine: false,
  startServices: false,
  runtime: "native",
  // Bound engine action envelopes independently of HTTP/MCP request limits.
  maxIncomingMessageSize: 300 * 1024,
  use: { scrubAdmission, scrubRequest, scrubVideo, scrubCredentials },
});
