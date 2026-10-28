import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "node:http";
import {
  createNodeHttpServer,
  parsePort,
} from "../../src/infrastructure/node/http/server.js";
import { createBearerAuthorizer } from "../../src/infrastructure/node/http/auth.js";
import { createApiHandler } from "../../src/entrypoints/api/handler.js";

const createApiServer = () => createNodeHttpServer(createApiHandler());

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("public API server", () => {
  it("imports and creates a server without opening a listener", async () => {
    vi.resetModules();
    const listenSpy = vi.spyOn(Server.prototype, "listen");
    try {
      const api = await import("../../src/infrastructure/node/http/server.js");
      expect(api.createNodeHttpServer(createApiHandler()).listening).toBe(
        false
      );
      expect(listenSpy).not.toHaveBeenCalled();
    } finally {
      listenSpy.mockRestore();
      vi.resetModules();
    }
  });

  it.each(["/", "/healthz", "/healthz?probe=1"])(
    "serves app health at %s",
    async (path) => {
      const url = await listen(createApiServer());
      const response = await fetch(`${url}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        service: "scrub",
        status: "ok",
      });
    }
  );

  it("returns 404 for an unknown route", async () => {
    const url = await listen(createApiServer());
    const response = await fetch(`${url}/internal`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("requires the configured bearer token for job routes while keeping health public", async () => {
    const url = await listen(
      createNodeHttpServer(
        createApiHandler({
          authorize: createBearerAuthorizer("test-only-api-token"),
        })
      )
    );
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const response = await fetch(`${url}/jobs`, {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
    }
    const authenticated = await fetch(`${url}/jobs`, {
      headers: { authorization: "Bearer test-only-api-token" },
    });
    expect(authenticated.status).toBe(503);
    expect(await authenticated.json()).toMatchObject({
      error: { code: "unavailable" },
    });
  });

  it("rejects writes to the health endpoint", async () => {
    const url = await listen(createApiServer());
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ status: "changed" }),
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.json()).toEqual({ error: "Method not allowed" });
  });
});

describe("port configuration", () => {
  it("uses the supplied default only when the value is absent", () => {
    expect(parsePort(undefined, 8080)).toBe(8080);
    expect(parsePort(undefined, 9464)).toBe(9464);
    expect(parsePort("1", 8080)).toBe(1);
    expect(parsePort("65535", 8080)).toBe(65535);
  });

  it.each(["", "0", "65536", "-1", "8080.5", "8e3", " 8080", "NaN"])(
    "rejects invalid port %j",
    (value) => {
      expect(() => parsePort(value, 8080)).toThrow("Invalid HTTP port");
    }
  );
});
