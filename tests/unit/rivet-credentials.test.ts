import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdtemp, chmod, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawAccess } from "rivetkit/db";
import {
  EnvironmentCredentialsResolver,
  FallbackCredentialsResolver,
} from "../../src/infrastructure/model/CredentialsResolver.js";
import {
  CREDENTIAL_ACTOR_KEY,
  createCredentialProof,
  verifyCredentialProof,
  credentialDatabase,
  RivetCredentialsResolver,
  scrubCredentials,
} from "../../src/infrastructure/rivet/credentials.js";
// @ts-expect-error Deployment scripts are JavaScript and intentionally outside src.
import {
  parseCredentialFile,
  parseCredentialCommand,
  readCredentialFile,
} from "../../scripts/rivet/credentials.mjs";

const removals: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const remove of removals.splice(0).reverse()) await remove();
});
const bootstrap = "test-only-bootstrap-secret";
const testKey = "test-only-provider-key";

async function database(): Promise<RawAccess> {
  const database = new DatabaseSync(":memory:");
  removals.push(() => database.close());
  const access: RawAccess = {
    execute: async (sql, ...args) =>
      database.prepare(sql).all(...(args as SQLInputValue[])) as never,
    transaction: async (work) => work(access),
    close: async () => undefined,
  };
  await credentialDatabase.onMigrate(access);
  return access;
}

describe("Rivet deployment credential authentication", () => {
  it("verifies native CBOR bigint timestamps using lossless canonicalization only", () => {
    const now = 1_800_000_000_000;
    const proof = createCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, now);
    const native = { ...proof, expiresAt: BigInt(proof.expiresAt) };
    expect(
      verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, native, now)
    ).toEqual({ authorized: true, expiresAt: proof.expiresAt });
    expect(typeof native.expiresAt).toBe("bigint");
    for (const expiresAt of [
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      -1n,
      String(proof.expiresAt),
      proof.expiresAt + 0.5,
      NaN,
      Infinity,
    ])
      expect(() =>
        verifyCredentialProof(
          bootstrap,
          CREDENTIAL_ACTOR_KEY,
          { ...proof, expiresAt },
          now
        )
      ).toThrow("Credential access denied");
    expect(() =>
      verifyCredentialProof(
        bootstrap,
        CREDENTIAL_ACTOR_KEY,
        native,
        proof.expiresAt
      )
    ).toThrow("Credential access denied");
    expect(() =>
      verifyCredentialProof(
        bootstrap,
        CREDENTIAL_ACTOR_KEY,
        native,
        now - 10_001
      )
    ).toThrow("Credential access denied");
  });
  it("permits bounded client clock skew while rejecting expired and excessively future proofs", () => {
    const now = 1_800_000_000_000;
    for (const offset of [-2000, 2000]) {
      const proof = createCredentialProof(
        bootstrap,
        CREDENTIAL_ACTOR_KEY,
        now + offset
      );
      expect(
        verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, proof, now)
      ).toEqual({ authorized: true, expiresAt: now + offset + 20_000 });
    }
    const future = createCredentialProof(
      bootstrap,
      CREDENTIAL_ACTOR_KEY,
      now + 10_001
    );
    expect(() =>
      verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, future, now)
    ).toThrow("Credential access denied");
    const expired = createCredentialProof(
      bootstrap,
      CREDENTIAL_ACTOR_KEY,
      now - 20_001
    );
    expect(() =>
      verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, expired, now)
    ).toThrow("Credential access denied");
    const boundary = createCredentialProof(
      bootstrap,
      CREDENTIAL_ACTOR_KEY,
      now - 20_000
    );
    expect(() =>
      verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, boundary, now)
    ).toThrow("Credential access denied");
  });
  it("binds a short-lived proof to the actor key without sending the bootstrap secret", () => {
    const proof = createCredentialProof(bootstrap);
    expect(JSON.stringify(proof)).not.toContain(bootstrap);
    expect(
      verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, proof).authorized
    ).toBe(true);
    for (const check of [
      () => verifyCredentialProof("other", CREDENTIAL_ACTOR_KEY, proof),
      () => verifyCredentialProof(bootstrap, ["other"], proof),
      () =>
        verifyCredentialProof(
          bootstrap,
          CREDENTIAL_ACTOR_KEY,
          proof,
          proof.expiresAt + 1
        ),
      () =>
        verifyCredentialProof(
          bootstrap,
          CREDENTIAL_ACTOR_KEY,
          proof,
          proof.expiresAt - 30_001
        ),
      () => verifyCredentialProof(undefined, CREDENTIAL_ACTOR_KEY, proof),
      () =>
        verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, {
          ...proof,
          extra: testKey,
        }),
      () =>
        verifyCredentialProof(bootstrap, CREDENTIAL_ACTOR_KEY, {
          ...proof,
          signature: "invalid",
        }),
    ])
      expect(check).toThrow("Credential access denied");
  });

  it("stores keys in its separate database while list exposes metadata only", async () => {
    const db = await database();
    const context = {
      db,
      key: CREDENTIAL_ACTOR_KEY,
      conn: {
        state: verifyCredentialProof(
          bootstrap,
          CREDENTIAL_ACTOR_KEY,
          createCredentialProof(bootstrap)
        ),
      },
    };
    await scrubCredentials.config.actions.save(context, {
      provider: "openai",
      key: testKey,
    });
    expect(await scrubCredentials.config.actions.read(context, "openai")).toBe(
      testKey
    );
    expect(
      await scrubCredentials.config.actions.read(context, "anthropic")
    ).toBe(null);
    const metadata = await scrubCredentials.config.actions.list(context);
    expect(metadata).toMatchObject([{ provider: "openai", configured: true }]);
    expect(JSON.stringify(metadata)).not.toContain(testKey);
    expect(
      await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).toEqual([{ name: "credentials" }]);
    await scrubCredentials.config.actions.save(context, {
      provider: "openai",
      key: "replacement-provider-key",
    });
    expect(await scrubCredentials.config.actions.list(context)).toHaveLength(1);
    expect(
      await scrubCredentials.config.actions.remove(context, "openai")
    ).toEqual({ provider: "openai", configured: false });
    expect(
      await scrubCredentials.config.actions.read(context, "openai")
    ).toBeNull();
    expect(await scrubCredentials.config.actions.list(context)).toEqual([]);
    // Removal is idempotent, including cleanup after an interrupted provision.
    await expect(
      scrubCredentials.config.actions.remove(context, "openai")
    ).resolves.toEqual({ provider: "openai", configured: false });
  });

  it("checks auth and expiry for every action and rejects invalid providers and values", async () => {
    const db = await database();
    const context = {
      db,
      key: CREDENTIAL_ACTOR_KEY,
      conn: {
        state: { authorized: true as const, expiresAt: Date.now() + 30_000 },
      },
    };
    for (const conn of [
      { state: { authorized: false, expiresAt: Date.now() + 30_000 } },
      { state: { authorized: true, expiresAt: Date.now() - 1 } },
    ]) {
      const denied = { ...context, conn } as never;
      await expect(
        scrubCredentials.config.actions.read(denied, "openai")
      ).rejects.toThrow("access denied");
      await expect(
        scrubCredentials.config.actions.list(denied)
      ).rejects.toThrow("access denied");
      await expect(
        scrubCredentials.config.actions.remove(denied, "openai")
      ).rejects.toThrow("access denied");
      await expect(
        scrubCredentials.config.actions.save(denied, {
          provider: "openai",
          key: testKey,
        })
      ).rejects.toThrow("access denied");
    }
    for (const value of [
      { provider: "other", key: testKey },
      { provider: "openai", key: "short" },
      { provider: "openai", key: "new\nline" },
      { provider: "openai", key: testKey, baseURL: "https://example.com" },
    ])
      await expect(
        scrubCredentials.config.actions.save(context, value)
      ).rejects.toThrow("Invalid credential input");
    const failed = {
      ...context,
      db: {
        execute: async () => {
          throw new Error(testKey);
        },
      } as unknown as RawAccess,
    };
    await expect(
      scrubCredentials.config.actions.save(failed, {
        provider: "openai",
        key: testKey,
      })
    ).rejects.toThrow("Credential storage is unavailable");
    await expect(
      scrubCredentials.config.actions.remove(context, "other")
    ).rejects.toThrow("Invalid credential input");
    await expect(
      scrubCredentials.config.actions.remove(failed, "openai")
    ).rejects.toThrow("Credential storage is unavailable");
  });

  it("refreshes each provider through authenticated SDK actions, with generic failures", async () => {
    let value: string | null = testKey;
    const parameters: unknown[] = [];
    const read = vi.fn(async (provider: string) =>
      provider === "openai" ? value : null
    );
    const resolver = new RivetCredentialsResolver(
      () => ({
        scrubCredentials: {
          getOrCreate: (_key, options) => {
            parameters.push(options.params);
            verifyCredentialProof(
              bootstrap,
              CREDENTIAL_ACTOR_KEY,
              options.params
            );
            return { read };
          },
        },
      }),
      () => bootstrap
    );
    expect(await resolver.resolve()).toEqual({ openai: testKey });
    value = "replacement-provider-key";
    expect(await resolver.resolve()).toEqual({ openai: value });
    value = null;
    expect(await resolver.resolve()).toEqual({});
    expect(parameters).toHaveLength(6);
    expect(JSON.stringify(parameters)).not.toContain(bootstrap);
    read.mockRejectedValueOnce(new Error(testKey));
    await expect(resolver.resolve()).rejects.toMatchObject({
      code: "unavailable",
      message: "Server model credential service is temporarily unavailable",
      retryable: true,
    });
    for (const failure of [
      { code: "credential_access_denied", message: testKey },
      { metadata: { code: "credential_invalid_input" }, message: testKey },
      { status: 403, message: testKey },
    ]) {
      read.mockRejectedValueOnce(failure);
      const result = await resolver.resolve().catch((error) => error);
      expect(result).toMatchObject({
        code: "capability_unavailable",
        retryable: false,
        message: "Server model credential access is not configured",
      });
      expect(result.cause).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(testKey);
    }
    read.mockRejectedValueOnce({
      code: "credential_store_unavailable",
      message: testKey,
    });
    await expect(resolver.resolve()).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    const controller = new AbortController();
    controller.abort();
    const count = read.mock.calls.length;
    await expect(resolver.resolve(controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(count);
  });

  it("treats an absent bootstrap token as missing configuration without issuing an RPC", async () => {
    const client = vi.fn();
    const resolver = new RivetCredentialsResolver(client, () => undefined);
    expect(await resolver.resolve()).toEqual({});
    expect(client).not.toHaveBeenCalled();
  });

  it("uses explicit environment credentials first and keeps optional provider failures isolated", async () => {
    const fallback = {
      resolve: vi.fn(async () => ({
        openai: "stored-key",
        anthropic: "stored-anthropic-key",
      })),
    };
    const resolver = new FallbackCredentialsResolver(
      new EnvironmentCredentialsResolver(() => ({ OPENAI_API_KEY: testKey })),
      fallback
    );
    expect(await resolver.resolve()).toEqual({
      openai: testKey,
      anthropic: "stored-anthropic-key",
    });
    fallback.resolve.mockRejectedValueOnce(new Error("unavailable"));
    expect(await resolver.resolve()).toEqual({ openai: testKey });
  });
});

describe("provider credential provisioning input", () => {
  it("parses removal without accepting credential values as arguments", () => {
    expect(parseCredentialCommand(["remove", "openai"])).toEqual({
      command: "remove",
      provider: "openai",
    });
    expect(parseCredentialCommand(["remove", "anthropic"])).toEqual({
      command: "remove",
      provider: "anthropic",
    });
    for (const args of [
      ["remove"],
      ["remove", "other"],
      ["remove", "openai", "extra"],
      ["list", "extra"],
      ["save", "--input"],
    ])
      expect(() => parseCredentialCommand(args)).toThrow("Usage:");
  });
  it("accepts only provider environment values without echoing secrets in errors", () => {
    expect(
      parseCredentialFile(`OPENAI_API_KEY=${testKey}\nANTHROPIC_API_KEY=\n`)
    ).toEqual([{ provider: "openai", key: testKey }]);
    expect(() =>
      parseCredentialFile(JSON.stringify({ RIVET_TOKEN: testKey }))
    ).toThrow("may contain only");
    expect(() => parseCredentialFile("OPENAI_API_KEY=\n")).toThrow(
      "No provider credentials"
    );
    try {
      parseCredentialFile(JSON.stringify({ OPENAI_API_KEY: `${testKey}\n` }));
    } catch (error) {
      expect(String(error)).not.toContain(testKey);
    }
  });
  it("requires an owner-only regular file and rejects symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "scrub-credential-input-"));
    removals.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, ".env.models.local");
    await writeFile(path, `OPENAI_API_KEY=${testKey}`, { mode: 0o600 });
    expect(await readCredentialFile(path)).toEqual([
      { provider: "openai", key: testKey },
    ]);
    await chmod(path, 0o640);
    await expect(readCredentialFile(path)).rejects.toThrow("mode 0600");
    await chmod(path, 0o600);
    await symlink(path, join(root, "link"));
    await expect(readCredentialFile(join(root, "link"))).rejects.toThrow(
      "regular file"
    );
  });
});
