import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "node:http";
import {
  createNodeApiServer as createApiServer,
  parsePort,
} from "../../src/infrastructure/node/http/server.js";
import { createMetricsServer } from "../../src/infrastructure/node/http/metrics.js";

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
  it("imports and creates servers without a provider or listener", async () => {
    vi.resetModules();
    vi.doMock("rivetkit", () => {
      throw new Error("The API must not load a deployment provider");
    });
    const listenSpy = vi.spyOn(Server.prototype, "listen");
    try {
      const api = await import("../../src/infrastructure/node/http/server.js");
      const metrics =
        await import("../../src/infrastructure/node/http/metrics.js");
      expect(api.createNodeApiServer().listening).toBe(false);
      expect(
        metrics.createMetricsServer(async () => new Response("")).listening
      ).toBe(false);
      expect(listenSpy).not.toHaveBeenCalled();
    } finally {
      listenSpy.mockRestore();
      vi.doUnmock("rivetkit");
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

  it.each(["/metrics", "/actors", "/unknown"])(
    "does not expose %s on the public listener",
    async (path) => {
      const url = await listen(createApiServer());
      const response = await fetch(`${url}${path}`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
  );

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

describe("separate metrics server", () => {
  it("serves the supplied response on the separate listener", async () => {
    const metrics = vi.fn(
      async () =>
        new Response("scrub_actions_total 2\n", {
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        })
    );
    const url = await listen(createMetricsServer(metrics));
    const response = await fetch(`${url}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4"
    );
    expect(await response.text()).toBe("scrub_actions_total 2\n");
    expect(metrics).toHaveBeenCalledOnce();
  });

  it("forwards a metrics callback failure status", async () => {
    const url = await listen(
      createMetricsServer(async () => new Response("warming", { status: 503 }))
    );
    const response = await fetch(`${url}/metrics`);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("warming");
  });

  it("hides internal errors when metrics collection throws", async () => {
    const url = await listen(
      createMetricsServer(async () => {
        throw new Error("internal configuration details");
      })
    );
    const response = await fetch(`${url}/metrics`);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Metrics unavailable\n");
  });

  it("does not invoke metrics for other routes or methods", async () => {
    const metrics = vi.fn(async () => new Response("metrics"));
    const url = await listen(createMetricsServer(metrics));

    expect((await fetch(`${url}/`)).status).toBe(404);
    expect((await fetch(`${url}/metrics`, { method: "POST" })).status).toBe(
      404
    );
    expect(metrics).not.toHaveBeenCalled();
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
