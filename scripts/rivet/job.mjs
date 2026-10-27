import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: npm run job:rivet -- submit <youtube-url> [--concurrency <1..16>] | status <job-id> | results <job-id> [offset] | cancel <job-id> | retry <job-id>";

export function parseJobCommand(args) {
  const [command, value, ...options] = args;
  if ((command === "--help" || command === "help") && !value)
    return { command: "help" };
  if (
    !["submit", "status", "results", "cancel", "retry"].includes(command) ||
    !value ||
    value.startsWith("--")
  )
    throw new Error(usage);
  if (command === "submit") {
    let concurrency;
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      let raw;
      if (option === "--concurrency") raw = options[++index];
      else if (option.startsWith("--concurrency="))
        raw = option.slice("--concurrency=".length);
      else throw new Error(`Unknown submit option: ${option}`);
      const parsed =
        typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (
        concurrency !== undefined ||
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > 16
      )
        throw new Error(
          "--concurrency must be supplied once with an integer from 1 to 16"
        );
      concurrency = parsed;
    }
    return {
      command,
      value,
      ...(concurrency === undefined ? {} : { concurrency }),
    };
  }
  if (command === "results") {
    const raw = options[0] ?? "0";
    const offset = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (options.length > 1 || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Result offset must be a nonnegative integer");
    return { command, value, offset };
  }
  if (options.length) throw new Error(usage);
  return { command, value };
}

async function run(args) {
  const input = parseJobCommand(args);
  if (input.command === "help") {
    console.log(usage);
    return;
  }
  const { RIVET_ENDPOINT: endpoint, RIVET_TOKEN: token } = process.env;
  if (!endpoint || !token)
    throw new Error(
      "Set server-side RIVET_ENDPOINT and RIVET_TOKEN in ignored .env.rivet.local"
    );
  const [{ createClient }, { RivetJobGateway }] = await Promise.all([
    import("rivetkit/client"),
    import("../../dist/infrastructure/rivet/JobGateway.js"),
  ]);
  const client = createClient({ endpoint, token });
  const jobs = new RivetJobGateway({ endpoint, token }, client);
  try {
    let result;
    if (input.command === "submit")
      result = await jobs.submit(
        {
          url: input.value,
          ...(input.concurrency === undefined
            ? {}
            : { concurrency: input.concurrency }),
        },
        randomUUID()
      );
    else if (input.command === "status") result = await jobs.get(input.value);
    else if (input.command === "results")
      result = await jobs.results(input.value, input.offset, 20);
    else if (input.command === "cancel")
      result = await jobs.cancel(input.value);
    else result = await jobs.retry(input.value);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.dispose();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
