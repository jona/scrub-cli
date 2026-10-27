import { setup } from "rivetkit";
import { scrub } from "./actor.js";
import { scrubAdmission, scrubRequest, scrubVideo } from "./jobs.js";
import { scrubCredentials } from "./credentials.js";

export const registry = setup({
  startEngine: false,
  startServices: false,
  runtime: "native",
  // Leave room for the action envelope around the 256 KiB input limit.
  maxIncomingMessageSize: 300 * 1024,
  use: { scrub, scrubAdmission, scrubRequest, scrubVideo, scrubCredentials },
});
