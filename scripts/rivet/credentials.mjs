import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const MAX_INPUT_BYTES = 20 * 1024;
const usage =
  "Usage: node --env-file=.env.rivet.local scripts/rivet/credentials.mjs list | save [--input .env.models.local|-] | remove <openai|anthropic>";

export function parseCredentialFile(text) {
  let values;
  try {
    values = text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : parseEnv(text);
  } catch {
    throw new Error("Invalid provider credential file");
  }
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).some(
      (key) => !["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)
    )
  )
    throw new Error(
      "Credential file may contain only OPENAI_API_KEY and ANTHROPIC_API_KEY"
    );
  const entries = [];
  for (const [name, provider] of [
    ["OPENAI_API_KEY", "openai"],
    ["ANTHROPIC_API_KEY", "anthropic"],
  ]) {
    const key = values[name];
    if (key === undefined || key === "") continue;
    if (typeof key !== "string" || !/^[\x21-\x7e]{8,8192}$/.test(key))
      throw new Error("Invalid provider credential value");
    entries.push({ provider, key });
  }
  if (!entries.length) throw new Error("No provider credentials were supplied");
  return entries;
}

export async function readCredentialFile(path) {
  if (path === "-") {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES)
        throw new Error("Credential input exceeds its size limit");
      chunks.push(chunk);
    }
    return parseCredentialFile(Buffer.concat(chunks).toString("utf8"));
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_INPUT_BYTES ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error();
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_INPUT_BYTES) throw new Error();
    return parseCredentialFile(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    throw new Error(
      "Credential input must be an owner-only regular file (mode 0600), at most 20 KiB"
    );
  } finally {
    await handle?.close();
  }
}

export function parseCredentialCommand(args) {
  const [command, flag, path, ...extra] = args;
  if ((command === "--help" || command === "help") && args.length === 1)
    return { command: "help" };
  if (command === "list" && args.length === 1) return { command };
  if (
    command === "remove" &&
    args.length === 2 &&
    ["openai", "anthropic"].includes(flag)
  )
    return { command, provider: flag };
  if (
    command === "save" &&
    !extra.length &&
    (args.length === 1 || (args.length === 3 && flag === "--input" && path))
  )
    return { command, input: path ?? ".env.models.local" };
  throw new Error(usage);
}

export async function runCredentialCommand(args) {
  const input = parseCredentialCommand(args);
  if (input.command === "help") {
    console.log(usage);
    return;
  }
  const entries =
    input.command === "save" ? await readCredentialFile(input.input) : [];
  const { RIVET_ENDPOINT: endpoint, RIVET_TOKEN: token } = process.env;
  if (!endpoint || !token)
    throw new Error(
      "Set server-side RIVET_ENDPOINT and RIVET_TOKEN in ignored .env.rivet.local"
    );
  let client;
  try {
    const [{ createClient }, { CREDENTIAL_ACTOR_KEY, createCredentialProof }] =
      await Promise.all([
        import("rivetkit/client"),
        import("../../dist/infrastructure/rivet/credentials.js"),
      ]);
    client = createClient({ endpoint, token });
    const handle = () =>
      client.scrubCredentials.getOrCreate(CREDENTIAL_ACTOR_KEY, {
        params: createCredentialProof(token),
        signal: AbortSignal.timeout(10_000),
      });
    for (const entry of entries) await handle().save(entry);
    if (input.command === "remove") await handle().remove(input.provider);
    const metadata = await handle().list();
    console.log(
      JSON.stringify({
        configuredProviders: metadata
          .map((entry) => entry.provider)
          .filter((name) => name === "openai" || name === "anthropic"),
      })
    );
  } catch {
    throw new Error(
      "Rivet credential operation failed; credential values were omitted"
    );
  } finally {
    // A transport teardown failure must not print an SDK error body or headers.
    try {
      await client?.dispose();
    } catch {
      /* Operation result is already known. */
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runCredentialCommand(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Credential operation failed"
    );
    process.exitCode = 1;
  }
}
