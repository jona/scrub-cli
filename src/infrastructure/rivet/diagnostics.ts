import { UserError } from "rivetkit";
import {
  sanitizeNativeCommandDiagnostic,
  type NativeCommandDiagnostic,
} from "../node/diagnostics.js";
import type { NativeRuntimeOptions } from "../node/runtime.js";
import { verifyCredentialProof } from "./credentials.js";
import { SqliteDocuments, type JobDatabase } from "./storage.js";

const DOCUMENT_KEY = "native-command-diagnostics";
const MAX_EVENTS = 20;
const MAX_EVENT_BYTES = 12 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024;
const SINK_TIMEOUT_MS = 1500;
let authenticationToken: string | undefined;

interface DiagnosticJournal {
  version: 1;
  events: NativeCommandDiagnostic[];
  dropped: number;
}
export interface RivetDiagnosticPage {
  events: NativeCommandDiagnostic[];
  retained: number;
  dropped: number;
}

/** Deployment supplies the bootstrap secret; adapters never read process.env. */
export function configureRivetDiagnostics(token: string | undefined): void {
  authenticationToken = token;
}

function redactions(load?: () => readonly string[]): readonly string[] {
  const values = load?.() ?? [];
  if (!Array.isArray(values))
    throw new Error("Invalid diagnostic redaction configuration");
  return [...values, ...(authenticationToken ? [authenticationToken] : [])];
}

function boundedEvent(
  input: unknown,
  values: readonly string[]
): NativeCommandDiagnostic | null {
  let event = sanitizeNativeCommandDiagnostic(input, values);
  while (event && Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
    const bytes = Buffer.from(event.stderr);
    if (!bytes.length) return null;
    let start = Math.min(
      bytes.length,
      Buffer.byteLength(JSON.stringify(event)) - MAX_EVENT_BYTES + 4
    );
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    event = {
      ...event,
      stderr: bytes.subarray(start).toString("utf8"),
      stderrTruncated: true,
    };
  }
  return event;
}

const increment = (count: number, amount = 1) =>
  Math.min(Number.MAX_SAFE_INTEGER, count + amount);
function normalizeJournal(
  value: unknown,
  values: readonly string[]
): DiagnosticJournal {
  const stored =
    value && typeof value === "object"
      ? (value as Partial<DiagnosticJournal>)
      : {};
  const events = Array.isArray(stored.events) ? stored.events : [];
  const dropped =
    Number.isSafeInteger(stored.dropped) && stored.dropped! >= 0
      ? stored.dropped!
      : 0;
  const journal: DiagnosticJournal = {
    version: 1,
    events: [],
    dropped: increment(dropped, Math.max(0, events.length - MAX_EVENTS)),
  };
  for (const event of events.slice(-MAX_EVENTS)) {
    const safe = boundedEvent(event, values);
    if (safe) journal.events.push(safe);
    else journal.dropped = increment(journal.dropped);
  }
  trimJournal(journal);
  return journal;
}
function trimJournal(journal: DiagnosticJournal): void {
  while (
    journal.events.length > MAX_EVENTS ||
    Buffer.byteLength(JSON.stringify(journal)) > MAX_JOURNAL_BYTES
  ) {
    journal.events.shift();
    journal.dropped = increment(journal.dropped);
  }
}

function documents(database: JobDatabase): SqliteDocuments {
  return new SqliteDocuments({
    execute: (...args) => database.execute(...args),
    transaction: (work, options) =>
      database.transaction(work, { ...options, timeout: SINK_TIMEOUT_MS }),
  });
}

/** Each sink has its own deadline; late rejection is always consumed. */
async function bestEffort(
  work: () => unknown | Promise<unknown>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          () => undefined,
          () => undefined
        ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SINK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Attempt-scoped diagnostics stay outside pipeline settings and public failures. */
export function createRivetNativeDiagnostics(
  database: JobDatabase,
  outer: NativeRuntimeOptions["diagnostics"],
  context: { runId: string; attemptId: string }
): NonNullable<NativeRuntimeOptions["diagnostics"]> {
  return {
    redactValues: () => redactions(outer?.redactValues),
    emit: async (event) => {
      let values: readonly string[];
      let safe: NativeCommandDiagnostic | null;
      try {
        values = redactions(outer?.redactValues);
        const normalized = boundedEvent(event, values);
        safe =
          normalized &&
          boundedEvent(
            {
              ...normalized,
              runId: context.runId,
              attemptId: context.attemptId,
            },
            values
          );
      } catch {
        return;
      }
      await Promise.all([
        bestEffort(() => safe && outer?.emit?.({ ...safe })),
        bestEffort(() =>
          documents(database).update<DiagnosticJournal>(
            DOCUMENT_KEY,
            (current) => {
              const journal = normalizeJournal(current, values);
              if (safe) journal.events.push(safe);
              else journal.dropped = increment(journal.dropped);
              trimJournal(journal);
              return journal;
            }
          )
        ),
      ]);
    },
  };
}

/** Authenticate every read against the video actor key before touching its DB. */
export async function readRivetDiagnostics(
  context: { db: JobDatabase; key: string[] },
  proof: unknown,
  limit = 3,
  redactValues?: () => readonly string[]
): Promise<RivetDiagnosticPage> {
  verifyCredentialProof(authenticationToken, context.key, proof);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5)
    throw new UserError("Invalid diagnostic limit", { code: "invalid_input" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const journal = await Promise.race([
      documents(context.db).get<DiagnosticJournal>(DOCUMENT_KEY),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Diagnostic read timed out")),
          SINK_TIMEOUT_MS
        );
      }),
    ]);
    const safe = normalizeJournal(journal, redactions(redactValues));
    return {
      events: safe.events.slice(-limit).reverse(),
      retained: safe.events.length,
      dropped: safe.dropped,
    };
  } catch {
    throw new UserError("Diagnostic journal is unavailable", {
      code: "unavailable",
      metadata: { retryable: true },
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
