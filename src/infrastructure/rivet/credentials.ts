import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import type {
  CredentialsResolver,
  ModelProvider,
  ProviderCredentials,
} from "../model/CredentialsResolver.js";
import { PipelineError } from "../../core/errors.js";

export const CREDENTIAL_ACTOR_KEY = ["deployment"];
// Proofs expire after 20 seconds. The verifier accepts at most 30 seconds into
// its future, leaving 10 seconds of clock-skew headroom without extending expiry.
const AUTH_PROOF_LIFETIME_MS = 20_000;
const AUTH_MAX_FUTURE_MS = 30_000;
const PROVIDERS: readonly ModelProvider[] = ["openai", "anthropic"];
export interface CredentialProof {
  expiresAt: number;
  nonce: string;
  signature: string;
}
export interface CredentialConnection {
  authorized: true;
  expiresAt: number;
}
export interface CredentialContext {
  db: RawAccess;
  conn: { state: CredentialConnection };
  key: string[];
}
let authenticationToken: string | undefined;

/** Composition owns the bootstrap token. It is never sent as connection params. */
export function configureRivetCredentials(token: string | undefined): void {
  authenticationToken = token;
}

function signature(
  token: string,
  key: string[],
  proof: Omit<CredentialProof, "signature">
): Buffer {
  return createHmac("sha256", token)
    .update(
      JSON.stringify([
        "scrub.credentials.auth.v1",
        key,
        proof.expiresAt,
        proof.nonce,
      ])
    )
    .digest();
}

export function createCredentialProof(
  token: string,
  key = CREDENTIAL_ACTOR_KEY,
  now = Date.now()
): CredentialProof {
  const proof = {
    expiresAt: now + AUTH_PROOF_LIFETIME_MS,
    nonce: randomBytes(24).toString("hex"),
  };
  return { ...proof, signature: signature(token, key, proof).toString("hex") };
}

export function verifyCredentialProof(
  token: string | undefined,
  key: string[],
  input: unknown,
  now = Date.now()
): CredentialConnection {
  if (!token || !input || typeof input !== "object" || Array.isArray(input))
    throw new UserError("Credential access denied", {
      code: "credential_access_denied",
    });
  const rawProof = input as Omit<CredentialProof, "expiresAt"> & {
    expiresAt: unknown;
  };
  // Native Rivet decodes JSON integer connection params through CBOR as bigint.
  // Canonicalize only lossless safe integers to the number signed by the SDK.
  const expiresAt =
    typeof rawProof.expiresAt === "bigint" &&
    rawProof.expiresAt >= 0n &&
    rawProof.expiresAt <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(rawProof.expiresAt)
      : rawProof.expiresAt;
  if (typeof expiresAt !== "number")
    throw new UserError("Credential access denied", {
      code: "credential_access_denied",
    });
  const proof: CredentialProof = { ...rawProof, expiresAt };
  if (
    Object.keys(proof).sort().join(",") !== "expiresAt,nonce,signature" ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt <= now ||
    proof.expiresAt > now + AUTH_MAX_FUTURE_MS ||
    typeof proof.nonce !== "string" ||
    !/^[a-f0-9]{48}$/.test(proof.nonce) ||
    typeof proof.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.signature) ||
    !timingSafeEqual(
      signature(token, key, proof),
      Buffer.from(proof.signature, "hex")
    )
  )
    throw new UserError("Credential access denied", {
      code: "credential_access_denied",
    });
  return { authorized: true, expiresAt: proof.expiresAt };
}

function authorize(context: CredentialContext): void {
  if (
    context.key.length !== 1 ||
    context.key[0] !== CREDENTIAL_ACTOR_KEY[0] ||
    context.conn?.state?.authorized !== true ||
    context.conn.state.expiresAt <= Date.now()
  )
    throw new UserError("Credential access denied", {
      code: "credential_access_denied",
    });
}
function provider(input: unknown): ModelProvider {
  if (typeof input !== "string" || !PROVIDERS.includes(input as ModelProvider))
    throw new UserError("Invalid credential input", {
      code: "credential_invalid_input",
    });
  return input as ModelProvider;
}
export function validateCredentialInput(input: unknown): {
  provider: ModelProvider;
  key: string;
} {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "key,provider"
  )
    throw new UserError("Invalid credential input", {
      code: "credential_invalid_input",
    });
  const value = input as { provider: unknown; key: unknown };
  const name = provider(value.provider);
  if (typeof value.key !== "string" || !/^[\x21-\x7e]{8,8192}$/.test(value.key))
    throw new UserError("Invalid credential input", {
      code: "credential_invalid_input",
    });
  return { provider: name, key: value.key };
}

export const credentialDatabase = db({
  onMigrate: async (database) => {
    await database.execute(
      "CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, secret TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
  },
});

/** Rivet's documented credentials-Actor pattern, isolated from job databases. */
export const scrubCredentials = actor({
  db: credentialDatabase,
  inspector: {
    tabs: [
      { id: "database", hidden: true },
      { id: "connections", hidden: true },
    ],
  },
  createConnState: (context: { key: string[] }, proof: unknown) =>
    verifyCredentialProof(authenticationToken, context.key, proof),
  actions: {
    save: async (
      context: CredentialContext,
      input: unknown
    ): Promise<{ provider: ModelProvider; configured: true }> => {
      authorize(context);
      const value = validateCredentialInput(input);
      try {
        await context.db.execute(
          "INSERT INTO credentials (provider, secret, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at",
          value.provider,
          value.key,
          new Date().toISOString()
        );
      } catch {
        throw new UserError("Credential storage is unavailable", {
          code: "credential_store_unavailable",
        });
      }
      return { provider: value.provider, configured: true };
    },
    list: async (
      context: CredentialContext
    ): Promise<
      { provider: ModelProvider; configured: true; updatedAt: string }[]
    > => {
      authorize(context);
      try {
        const rows = await context.db.execute<{
          provider: ModelProvider;
          updated_at: string;
        }>("SELECT provider, updated_at FROM credentials ORDER BY provider");
        return rows.map((row) => ({
          provider: row.provider,
          configured: true,
          updatedAt: row.updated_at,
        }));
      } catch {
        throw new UserError("Credential storage is unavailable", {
          code: "credential_store_unavailable",
        });
      }
    },
    read: async (
      context: CredentialContext,
      input: unknown
    ): Promise<string | null> => {
      authorize(context);
      const name = provider(input);
      try {
        const rows = await context.db.execute<{ secret: string }>(
          "SELECT secret FROM credentials WHERE provider = ?",
          name
        );
        return rows[0]?.secret ?? null;
      } catch {
        throw new UserError("Credential storage is unavailable", {
          code: "credential_store_unavailable",
        });
      }
    },
    remove: async (
      context: CredentialContext,
      input: unknown
    ): Promise<{ provider: ModelProvider; configured: false }> => {
      authorize(context);
      const name = provider(input);
      try {
        await context.db.execute(
          "DELETE FROM credentials WHERE provider = ?",
          name
        );
      } catch {
        throw new UserError("Credential storage is unavailable", {
          code: "credential_store_unavailable",
        });
      }
      return { provider: name, configured: false };
    },
  },
});

export interface CredentialsActorClient {
  scrubCredentials: {
    getOrCreate(
      key: string[],
      options: { params: CredentialProof; signal?: AbortSignal }
    ): { read(provider: ModelProvider): Promise<string | null> };
  };
}
export class RivetCredentialsResolver implements CredentialsResolver {
  constructor(
    private readonly client: () => CredentialsActorClient,
    private readonly token: () => string | undefined
  ) {}

  async resolve(signal?: AbortSignal): Promise<ProviderCredentials> {
    signal?.throwIfAborted();
    const token = this.token();
    if (!token) return {};
    const deadline = AbortSignal.timeout(10_000);
    const operationSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    const credentials: ProviderCredentials = {};
    try {
      for (const provider of PROVIDERS) {
        operationSignal.throwIfAborted();
        const value = await this.client()
          .scrubCredentials.getOrCreate(CREDENTIAL_ACTOR_KEY, {
            params: createCredentialProof(token),
            signal: operationSignal,
          })
          .read(provider);
        operationSignal.throwIfAborted();
        if (value !== null)
          credentials[provider] = validateCredentialInput({
            provider,
            key: value,
          }).key;
      }
      return credentials;
    } catch (error) {
      signal?.throwIfAborted();
      const detail =
        error && typeof error === "object"
          ? (error as {
              code?: unknown;
              status?: unknown;
              statusCode?: unknown;
              metadata?: { code?: unknown };
            })
          : {};
      const code = detail.metadata?.code ?? detail.code;
      if (
        code === "credential_access_denied" ||
        code === "credential_invalid_input" ||
        detail.status === 401 ||
        detail.status === 403 ||
        detail.statusCode === 401 ||
        detail.statusCode === 403
      )
        throw new PipelineError(
          "capability_unavailable",
          "Server model credential access is not configured"
        );
      throw new PipelineError(
        "unavailable",
        "Server model credential service is temporarily unavailable",
        { retryable: true }
      );
    }
  }
}
