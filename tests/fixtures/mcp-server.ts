import { serveScrubStdio } from "../../src/infrastructure/node/mcp/stdio.js";
import { createMcpFixture } from "../helpers/mcp-fixture.js";

serveScrubStdio({ jobs: createMcpFixture().jobs });
