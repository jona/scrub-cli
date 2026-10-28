import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: npm run diagnostics:rivet -- <job-id> <video-id> [limit:1..5]";
export function parseDiagnosticsCommand(args) {
  if (args.length === 1 && ["help", "--help"].includes(args[0]))
    return { help: true };
  const [jobId, videoId, raw = "3"] = args;
  const limit = /^[1-5]$/.test(raw) ? Number(raw) : NaN;
  if (
    args.length < 2 ||
    args.length > 3 ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(jobId ?? "") ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(videoId ?? "") ||
    !Number.isInteger(limit)
  )
    throw new Error(usage);
  return { jobId, videoId, limit };
}

export async function runDiagnosticsCommand(args) {
  const input = parseDiagnosticsCommand(args);
  if (input.help) {
    console.log(usage);
    return;
  }
  const { RIVET_ENDPOINT: endpoint, RIVET_TOKEN: token } = process.env;
  if (!endpoint || !token)
    throw new Error(
      "Set server-only RIVET_ENDPOINT and RIVET_TOKEN in ignored .env.rivet.local"
    );
  let client;
  try {
    const [
      { createClient },
      { createCredentialProof },
      { sanitizeNativeCommandDiagnostic },
      { configureDefaultLogger },
    ] = await Promise.all([
      import("rivetkit/client"),
      import("../../dist/infrastructure/rivet/credentials.js"),
      import("../../dist/infrastructure/node/diagnostics.js"),
      import("rivetkit/log"),
    ]);
    configureDefaultLogger("silent");
    client = createClient({ endpoint, token });
    const key = [input.jobId, input.videoId];
    const actorId = await client.scrubVideo
      .get(key, { signal: AbortSignal.timeout(30_000) })
      .resolve();
    const response = await client.scrubVideo
      .getForId(actorId, { signal: AbortSignal.timeout(30_000) })
      .getDiagnostics(createCredentialProof(token, key), input.limit);
    if (
      !Array.isArray(response?.events) ||
      response.events.length > input.limit ||
      !Number.isSafeInteger(response.retained) ||
      response.retained < 0 ||
      !Number.isSafeInteger(response.dropped) ||
      response.dropped < 0
    )
      throw new Error();
    const secrets = Object.entries(process.env)
      .filter(
        ([name, value]) =>
          /(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)/.test(name) &&
          value?.length >= 8
      )
      .map(([, value]) => value);
    const events = response.events.map((event) =>
      sanitizeNativeCommandDiagnostic(event, secrets)
    );
    if (events.some((event) => !event)) throw new Error();
    console.log(
      JSON.stringify(
        {
          jobId: input.jobId,
          videoId: input.videoId,
          retained: response.retained,
          dropped: response.dropped,
          events,
        },
        null,
        2
      )
    );
  } catch {
    throw new Error(
      "Rivet diagnostic read failed; credentials and raw SDK errors were omitted"
    );
  } finally {
    try {
      await client?.dispose();
    } catch {
      /* Never print transport headers or bodies. */
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runDiagnosticsCommand(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Diagnostic read failed"
    );
    process.exitCode = 1;
  }
}
