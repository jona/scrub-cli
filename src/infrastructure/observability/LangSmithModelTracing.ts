import { Client, type ClientConfig, type RunTree } from "langsmith";
import { ROOT, traceable } from "langsmith/traceable";
import {
  formatStructuredModelPrompt,
  type StructuredModelGateway,
  type StructuredModelRequest,
  type StructuredModelResponse,
} from "../../application/model.js";
import { PipelineError, throwIfAborted } from "../../core/errors.js";

/** Server-owned configuration. Never included in job settings or model inputs. */
export interface LangSmithTracingConfig {
  enabled: boolean;
  apiKey?: string;
  project: string;
  endpoint: string;
  workspaceId?: string;
  captureContent: boolean;
  timeoutMs: number;
  redactValues?: readonly string[];
}

export interface LangSmithTracingDependencies {
  clientFactory?(configuration: ClientConfig): Client;
}

const OMITTED = "[content omitted]";
const MAX_CLIENTS = 4;
const METADATA_FIELDS = new Set([
  "ls_provider",
  "ls_model_name",
  "thread_id",
  "scrub_run_id",
  "attempt_id",
  "step",
  "call_index",
  "repair_attempt",
  "output_retry",
  "schema_name",
  "max_output_tokens",
  "image_count",
  "image_bytes",
  "error_code",
]);

function redact(text: string, config: LangSmithTracingConfig): string {
  for (const secret of new Set([config.apiKey, ...(config.redactValues ?? [])]))
    if (secret && secret.length >= 8) {
      text = text.split(secret).join("[redacted]");
      text = text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
    }
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|lsv2_[A-Za-z0-9_-]{16,}|admin_[a-fA-F0-9]{32,})\b/g,
      "[redacted]"
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"',<>]+/gi,
      "$1[redacted]"
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s"'<>]+/gi,
      "$1[redacted]"
    );
}

function safeObject(
  value: Record<string, unknown>,
  config: LangSmithTracingConfig
): Record<string, unknown> {
  return JSON.parse(redact(JSON.stringify(value), config)) as Record<
    string,
    unknown
  >;
}

/** SDK errors must not retain headers, credentials or arbitrary response bodies. */
function safeTraceFetch(
  fetcher: typeof fetch = globalThis.fetch
): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetcher(input, { ...init, redirect: "error" });
    } catch {
      throw new Error("LangSmith tracing export failed");
    }
    if (response.ok) return response;
    void response.body?.cancel().catch(() => undefined);
    return new Response('{"detail":"LangSmith tracing export failed"}', {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

function stageFor(request: StructuredModelRequest): string {
  if (request.schemaName === "ScrubFrameAnalysis") return "vision";
  if (request.schemaName === "ScrubSourceNotes") return "source_notes";
  if (request.schemaName === "ScrubSummary") return "summary";
  return "model";
}

function traceOutput(
  result: StructuredModelResponse,
  config: LangSmithTracingConfig
): Record<string, unknown> {
  let content = OMITTED;
  if (config.captureContent) {
    try {
      content = redact(JSON.stringify(result.value), config);
    } catch {
      content = "[unserializable content omitted]";
    }
  }
  const usage = result.usage;
  return {
    choices: [{ message: { role: "assistant", content } }],
    ...(usage &&
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0 &&
    Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
      ? {
          usage_metadata: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        }
      : {}),
  };
}

interface TraceClient {
  identity: string;
  client: Client;
  active: number;
  timeoutMs: number;
}

/** Optional infrastructure around the sanitized gateway; telemetry never retries model work. */
export class LangSmithModelTracing {
  private readonly clients: TraceClient[] = [];

  constructor(
    private readonly configuration: () => LangSmithTracingConfig,
    private readonly dependencies: LangSmithTracingDependencies = {}
  ) {}

  private client(config: LangSmithTracingConfig): TraceClient | undefined {
    const identity = JSON.stringify([
      config.endpoint,
      config.apiKey,
      config.workspaceId,
      config.timeoutMs,
    ]);
    const existing = this.clients.find((entry) => entry.identity === identity);
    if (existing) return existing;
    // Rotation does not permit an unbounded collection of ingestion buffers.
    if (this.clients.length >= MAX_CLIENTS) {
      const index = this.clients.findIndex((entry) => entry.active === 0);
      if (index < 0) return undefined;
      const [old] = this.clients.splice(index, 1);
      void this.drain(old);
    }
    const factory =
      this.dependencies.clientFactory ?? ((settings) => new Client(settings));
    const client = factory({
      apiKey: config.apiKey,
      apiUrl: config.endpoint,
      workspaceId: config.workspaceId,
      timeout_ms: config.timeoutMs,
      callerOptions: {
        maxRetries: 0,
        maxConcurrency: 1,
        maxQueueSizeBytes: 8 * 1024 * 1024,
      },
      maxIngestMemoryBytes: 8 * 1024 * 1024,
      autoBatchTracing: true,
      manualFlushMode: false,
      blockOnRootRunFinalization: false,
      omitTracedRuntimeInfo: true,
      debug: false,
      tracingMode: "langsmith",
      fetchImplementation: safeTraceFetch(),
      // Strip inherited baggage. Request/response data are explicitly projected
      // before reaching traceable, so even SDK fallback paths see safe values.
      hideMetadata: (metadata) =>
        safeObject(
          Object.fromEntries(
            Object.entries(metadata).filter(([key]) => METADATA_FIELDS.has(key))
          ),
          config
        ),
      anonymizer: (values) => safeObject(values, config),
    });
    const entry = { identity, client, active: 0, timeoutMs: config.timeoutMs };
    this.clients.push(entry);
    return entry;
  }

  wrap(delegate: StructuredModelGateway): StructuredModelGateway {
    return {
      supports: (selection) => delegate.supports(selection),
      generate: async (request, context) => {
        throwIfAborted(context.signal);
        // This single promise survives tracing setup/export failures. Falling
        // back to the model result can never invoke a paid call twice.
        let operation: Promise<StructuredModelResponse> | undefined;
        const invoke = () =>
          (operation ??= Promise.resolve().then(() => {
            throwIfAborted(context.signal);
            return delegate.generate(request, context);
          }));
        let config: LangSmithTracingConfig;
        let entry: TraceClient | undefined;
        try {
          config = this.configuration();
          if (!config.enabled || !config.apiKey?.trim()) return await invoke();
          entry = this.client(config);
          if (!entry) return await invoke();
        } catch {
          return invoke();
        }
        entry.active++;
        try {
          const stage = stageFor(request);
          const inputs = {
            messages: [
              {
                role: "system",
                content: config.captureContent
                  ? redact(request.system, config)
                  : OMITTED,
              },
              {
                role: "user",
                content: config.captureContent
                  ? redact(formatStructuredModelPrompt(request), config)
                  : OMITTED,
              },
            ],
          };
          const metadata = safeObject(
            {
              ls_provider: request.selection.provider,
              ls_model_name: request.selection.model,
              thread_id: context.runId,
              scrub_run_id: context.runId,
              attempt_id: context.attemptId,
              step: request.invocation?.step ?? request.schemaName,
              call_index: request.invocation?.callIndex,
              repair_attempt: request.invocation?.repairAttempt,
              output_retry: request.invocation?.outputRetry,
              schema_name: request.schemaName,
              max_output_tokens: request.maxOutputTokens,
              image_count: request.images?.length ?? 0,
              image_bytes:
                request.images?.reduce(
                  (total, image) => total + image.data.byteLength,
                  0
                ) ?? 0,
            },
            config
          );
          const traced = traceable(
            async (run: RunTree, safeInputs: typeof inputs) => {
              void safeInputs;
              try {
                return traceOutput(await invoke(), config);
              } catch (error) {
                const code =
                  error instanceof PipelineError
                    ? error.code
                    : "internal_error";
                run.extra.metadata = {
                  ...run.extra.metadata,
                  error_code: code,
                };
                // Only a fixed classification reaches LangSmith. Original errors,
                // including SDK causes and stack metadata, stay with the caller.
                throw new Error(`Model call failed (${code})`);
              }
            },
            {
              client: entry.client,
              tracingEnabled: true,
              project_name: config.project,
              name: `scrub.llm.${stage}`,
              run_type: "llm",
              tags: ["scrub", stage, request.selection.provider],
              metadata,
            }
          );
          // Ambient parents otherwise override the client and project. An
          // explicit root preserves this runtime's destination and masking.
          await traced(ROOT, inputs);
        } catch {
          // Observability cannot replace a valid response, alter cancellation,
          // consume retry budgets or disclose a provider exception.
        } finally {
          entry.active--;
        }
        return invoke();
      },
    };
  }

  private async drain(entry: TraceClient): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => entry.client.awaitPendingTraceBatches())
          .catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, entry.timeoutMs);
        }),
      ]);
    } catch {
      /* Export failures never replace processing or shutdown results. */
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.clients.map((entry) => this.drain(entry)));
  }
}
