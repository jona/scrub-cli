export interface NativeCommandDiagnostic {
  version: 1;
  event: "native_command_failed";
  tool: "yt-dlp";
  operation: "metadata" | "audio" | "video";
  sourceId: string;
  timestamp: string;
  elapsedMs: number;
  exitCode?: number;
  signal?: string;
  errorCode?: NativeCommandErrorCode;
  stderr: string;
  stderrTruncated: boolean;
  runId?: string;
  attemptId?: string;
}
export type NativeCommandErrorCode =
  | "nonzero_exit"
  | "spawn_failed"
  | "timeout"
  | "cancelled"
  | "output_limit"
  | "invalid_metadata"
  | "invalid_duration"
  | "command_failed";
export interface NativeDiagnosticsOptions {
  redactValues?: () => readonly string[];
  emit?: (event: NativeCommandDiagnostic) => void | Promise<void>;
}
const codes = new Set<NativeCommandErrorCode>([
  "nonzero_exit",
  "spawn_failed",
  "timeout",
  "cancelled",
  "output_limit",
  "invalid_metadata",
  "invalid_duration",
  "command_failed",
]);
const MAX_STDERR = 8 * 1024;
const MAX_RECORD = 12 * 1024;
const STDERR_TRUNCATION_MARKER = "[earlier stderr truncated]\n";

function prefix(text: string, maximum: number): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
function tail(text: string, maximum: number): string {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - maximum);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}
function stderrTail(text: string, maximum: number, truncated: boolean): string {
  const body = text.startsWith(STDERR_TRUNCATION_MARKER)
    ? text.slice(STDERR_TRUNCATION_MARKER.length)
    : text;
  if (!truncated && Buffer.byteLength(body) <= maximum) return body;
  const markerBytes = Buffer.byteLength(STDERR_TRUNCATION_MARKER);
  if (maximum < markerBytes) return tail(body, maximum);
  return STDERR_TRUNCATION_MARKER + tail(body, maximum - markerBytes);
}
function clean(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
      ""
    );
}
function redact(
  text: string,
  values: readonly string[],
  boundary: boolean
): string {
  text = clean(text);
  const variants = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    variants.add(clean(value));
    variants.add(clean(JSON.stringify(value).slice(1, -1)));
    try {
      variants.add(encodeURIComponent(value));
    } catch {
      /* Invalid Unicode. */
    }
  }
  for (const value of [...variants]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    text = text.split(value).join("[redacted]");
    // Raw stderr may already be a bounded tail. Do not expose a known secret
    // fragment when its beginning was discarded before sanitization.
    if (boundary && !text.startsWith(STDERR_TRUNCATION_MARKER)) {
      for (let size = Math.min(value.length - 1, text.length); size > 0; size--)
        if (text.startsWith(value.slice(-size))) {
          text = "[redacted]" + text.slice(size);
          break;
        }
    }
  }
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|lsv2_[A-Za-z0-9_-]{8,}|admin_[A-Za-z0-9_-]{8,})\b/g,
      "[redacted]"
    )
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi,
      "$1[redacted]"
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          url.username = "redacted";
          url.password = "";
        }
        for (const key of new Set(url.searchParams.keys()))
          url.searchParams.set(key, "redacted");
        if (url.hash) url.hash = "redacted";
        return url.toString();
      } catch {
        return "[URL omitted]";
      }
    });
}

/** Reusable defense at both the native emitter and authenticated storage boundary. */
export function sanitizeNativeCommandDiagnostic(
  value: unknown,
  redactValues: readonly string[] = []
): NativeCommandDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const input = value as NativeCommandDiagnostic;
  if (
    input.version !== 1 ||
    input.event !== "native_command_failed" ||
    input.tool !== "yt-dlp" ||
    !["metadata", "audio", "video"].includes(input.operation) ||
    !/^[A-Za-z0-9_-]{11}$/.test(input.sourceId) ||
    typeof input.timestamp !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.timestamp) ||
    !Number.isFinite(Date.parse(input.timestamp)) ||
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs < 0 ||
    typeof input.stderr !== "string"
  )
    return null;
  const excessive = Buffer.byteLength(input.stderr) > 64 * 1024;
  const safe = excessive
    ? "[excessive diagnostic omitted]"
    : redact(input.stderr, redactValues, input.stderrTruncated);
  const result: NativeCommandDiagnostic = {
    version: 1,
    event: "native_command_failed",
    tool: "yt-dlp",
    operation: input.operation,
    sourceId: input.sourceId,
    timestamp: input.timestamp,
    elapsedMs: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(input.elapsedMs)),
    stderr: stderrTail(
      safe,
      MAX_STDERR,
      Boolean(
        input.stderrTruncated ||
        excessive ||
        Buffer.byteLength(safe) > MAX_STDERR
      )
    ),
    stderrTruncated: Boolean(
      input.stderrTruncated || excessive || Buffer.byteLength(safe) > MAX_STDERR
    ),
    ...(Number.isSafeInteger(input.exitCode) && input.exitCode! >= 0
      ? { exitCode: input.exitCode }
      : {}),
    ...(typeof input.signal === "string" &&
    /^SIG[A-Z0-9]{1,16}$/.test(input.signal)
      ? { signal: input.signal }
      : {}),
    ...(codes.has(input.errorCode!) ? { errorCode: input.errorCode } : {}),
  };
  for (const key of ["runId", "attemptId"] as const)
    if (typeof input[key] === "string")
      result[key] = prefix(redact(input[key], redactValues, false), 256);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RECORD) {
    result.stderrTruncated = true;
    let low = 0,
      high = Buffer.byteLength(result.stderr);
    const stderr = result.stderr;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      result.stderr = stderrTail(stderr, middle, true);
      if (Buffer.byteLength(JSON.stringify(result)) <= MAX_RECORD) low = middle;
      else high = middle - 1;
    }
    result.stderr = stderrTail(stderr, low, true);
  }
  return result;
}

/** Best effort, including slow/throwing diagnostic sinks. Never logs raw errors. */
export async function emitNativeCommandDiagnostic(
  event: NativeCommandDiagnostic,
  options?: NativeDiagnosticsOptions,
  logger?: { warn(message: string): void }
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sanitized = sanitizeNativeCommandDiagnostic(
      event,
      options?.redactValues?.() ?? []
    );
    if (!sanitized) return;
    await Promise.race([
      Promise.resolve()
        .then(() =>
          options?.emit
            ? options.emit(sanitized)
            : logger?.warn(JSON.stringify(sanitized))
        )
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
  } catch {
    /* Diagnostics cannot change processing behavior. */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const defaultSink = {};
const pendingDiagnostics = new WeakMap<object, Set<Promise<void>>>();

/** Delivery starts immediately but never extends a native operation's deadline. */
export function queueNativeCommandDiagnostic(
  event: NativeCommandDiagnostic,
  options?: NativeDiagnosticsOptions,
  logger?: { warn(message: string): void }
): void {
  try {
    const identity = options ?? logger ?? defaultSink;
    let pending = pendingDiagnostics.get(identity);
    if (!pending) {
      pending = new Set();
      pendingDiagnostics.set(identity, pending);
    }
    const work = emitNativeCommandDiagnostic(event, options, logger);
    pending.add(work);
    const remove = () => pending!.delete(work);
    void work.then(remove, remove);
  } catch {
    /* Logging cannot replace the native failure. */
  }
}

/** Hosts call after processing stops, outside pipeline/attempt deadlines. */
export async function flushNativeCommandDiagnostics(
  options?: NativeDiagnosticsOptions,
  logger?: { warn(message: string): void }
): Promise<void> {
  const pending = pendingDiagnostics.get(options ?? logger ?? defaultSink);
  if (pending) await Promise.allSettled([...pending]);
}
