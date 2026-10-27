import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

it("closes the standalone MCP transport when its persistent runtime loses ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scrub-mcp-lifecycle-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      resolve("src/deployments/local/mcp.ts"),
    ],
    cwd: resolve("."),
    env: {
      SCRUB_DATA_DIR: directory,
      SCRUB_STAGING_ROOT: join(directory, "staging"),
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "ownership-lifecycle-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  let closed!: () => void;
  const disconnected = new Promise<void>((resolveClosed) => {
    closed = resolveClosed;
  });
  client.onclose = closed;
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(6);
    expect(transport.pid).not.toBeNull();
    const database = new DatabaseSync(join(directory, "jobs.sqlite"));
    try {
      database
        .prepare(
          "UPDATE local_owner SET owner = ?, token = token + 1, expires_at = ? WHERE id = 1"
        )
        .run("replacement-runtime", Date.now() + 60_000);
    } finally {
      database.close();
    }
    await new Promise<void>((resolveClosed, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error("MCP process did not stop after losing runtime ownership")
        );
      }, 8_000);
      void disconnected.then(() => {
        clearTimeout(timeout);
        resolveClosed();
      });
    });
    expect(transport.pid).toBeNull();
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
