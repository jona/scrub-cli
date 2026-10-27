import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import Anthropic, {
  type ClientOptions as AnthropicClientOptions,
} from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { OperationContext } from "../../application/contracts.js";
import {
  formatStructuredModelPrompt,
  type ModelSelection,
  type StructuredModelGateway,
  type StructuredModelRequest,
  type StructuredModelResponse,
} from "../../application/model.js";
import { ModelOutputLimitError, PipelineError } from "../../core/errors.js";
import { awaitModel, boundedModelFetch, modelFailure } from "./http.js";

export interface ServerModelProviderConfig {
  name: string;
  protocol: "openai-compatible" | "anthropic";
  apiKey?: string;
  allowedModels: readonly string[];
  /** Trusted deployment configuration only; never taken from a job request. */
  baseURL?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  responseMode?: "json_object" | "json_schema";
}

export interface ModelGatewayDependencies {
  fetch?: typeof fetch;
  openai?(options: OpenAIClientOptions): Pick<OpenAI, "chat">;
  anthropic?(options: AnthropicClientOptions): Pick<Anthropic, "messages">;
}

interface Provider {
  config: ServerModelProviderConfig;
  models: Set<string>;
  timeoutMs: number;
  maxResponseBytes: number;
  client?:
    | { protocol: "openai-compatible"; value: Pick<OpenAI, "chat"> }
    | { protocol: "anthropic"; value: Pick<Anthropic, "messages"> };
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function validateRequest(request: StructuredModelRequest): void {
  if (
    !request ||
    typeof request.system !== "string" ||
    typeof request.prompt !== "string" ||
    !request.schema ||
    request.schema.type !== "object" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName)
  )
    throw new PipelineError(
      "invalid_input",
      "Invalid structured model request"
    );
  if (
    !Number.isInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1 ||
    request.maxOutputTokens > 128_000
  )
    throw new PipelineError(
      "invalid_input",
      "Invalid model output token limit"
    );
  let size = 0;
  for (const image of request.images ?? []) {
    if (
      !(image.data instanceof Uint8Array) ||
      image.data.byteLength === 0 ||
      !IMAGE_TYPES.has(image.mediaType)
    )
      throw new PipelineError("invalid_input", "Unsupported model image input");
    size += image.data.byteLength;
    if (size > MAX_IMAGE_BYTES)
      throw new PipelineError(
        "resource_limit",
        "Model image inputs exceed 8 MiB"
      );
  }
  if ((request.images?.length ?? 0) > 100)
    throw new PipelineError("resource_limit", "Too many model image inputs");
}

function parseValue(text: string, maximum: number): unknown {
  if (Buffer.byteLength(text, "utf8") > maximum)
    throw new PipelineError(
      "resource_limit",
      "Model output exceeded its configured byte limit"
    );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PipelineError(
      "invalid_model_output",
      "Model did not return valid JSON",
      { retryable: true }
    );
  }
}

function usage(
  input: number | undefined,
  output: number | undefined
): { inputTokens: number; outputTokens: number } | undefined {
  return Number.isSafeInteger(input) &&
    input! >= 0 &&
    Number.isSafeInteger(output) &&
    output! >= 0
    ? { inputTokens: input!, outputTokens: output! }
    : undefined;
}

/** Server-owned provider registry with synchronous, network-free model preflight. */
export class ProviderModelGateway implements StructuredModelGateway {
  private readonly providers = new Map<string, Provider>();

  constructor(
    configurations: readonly ServerModelProviderConfig[],
    dependencies: ModelGatewayDependencies = {}
  ) {
    for (const configuration of configurations) {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(configuration.name) ||
        this.providers.has(configuration.name) ||
        !["openai-compatible", "anthropic"].includes(configuration.protocol)
      )
        throw new Error("Invalid model provider configuration");
      const timeoutMs = configuration.timeoutMs ?? 600_000;
      const maxResponseBytes =
        configuration.maxResponseBytes ?? 2 * 1024 * 1024;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 30 * 60_000 ||
        !Number.isSafeInteger(maxResponseBytes) ||
        maxResponseBytes < 1 ||
        maxResponseBytes > 16 * 1024 * 1024
      )
        throw new Error("Invalid model provider limits");
      if (
        configuration.responseMode !== undefined &&
        !["json_object", "json_schema"].includes(configuration.responseMode)
      )
        throw new Error("Invalid model response mode");
      if (configuration.baseURL) {
        let url: URL;
        try {
          url = new URL(configuration.baseURL);
        } catch {
          throw new Error("Invalid model provider endpoint");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Invalid model provider endpoint");
      }
      const models = new Set(configuration.allowedModels);
      if (
        models.size === 0 ||
        [...models].some(
          (model) =>
            typeof model !== "string" ||
            model.length < 1 ||
            model.length > 200 ||
            model !== model.trim()
        )
      )
        throw new Error("Invalid model provider allowlist");
      const provider: Provider = {
        config: { ...configuration, allowedModels: [...models] },
        models,
        timeoutMs,
        maxResponseBytes,
      };
      if (configuration.apiKey?.trim()) {
        const fetch = boundedModelFetch(maxResponseBytes, dependencies.fetch);
        if (configuration.protocol === "openai-compatible") {
          const options: OpenAIClientOptions = {
            apiKey: configuration.apiKey.trim(),
            logLevel: "off",
            maxRetries: 0,
            timeout: timeoutMs,
            baseURL: configuration.baseURL ?? "https://api.openai.com/v1",
            fetch: fetch as unknown as OpenAIClientOptions["fetch"],
          };
          provider.client = {
            protocol: configuration.protocol,
            value: dependencies.openai?.(options) ?? new OpenAI(options),
          };
        } else {
          const options: AnthropicClientOptions = {
            apiKey: configuration.apiKey.trim(),
            maxRetries: 0,
            timeout: timeoutMs,
            logLevel: "off",
            baseURL: configuration.baseURL ?? "https://api.anthropic.com",
            fetch,
          };
          provider.client = {
            protocol: configuration.protocol,
            value: dependencies.anthropic?.(options) ?? new Anthropic(options),
          };
        }
      }
      this.providers.set(configuration.name, provider);
    }
  }

  supports(selection: ModelSelection): boolean {
    const provider = selection && this.providers.get(selection.provider);
    return !!provider?.client && provider.models.has(selection.model);
  }

  async generate(
    request: StructuredModelRequest,
    context: OperationContext
  ): Promise<StructuredModelResponse> {
    if (!this.supports(request?.selection))
      throw new PipelineError(
        "capability_unavailable",
        "Selected model is not configured or allowed"
      );
    validateRequest(request);
    const provider = this.providers.get(request.selection.provider)!;
    const deadline = AbortSignal.timeout(provider.timeoutMs);
    const signal = AbortSignal.any([context.signal, deadline]);
    const prompt = formatStructuredModelPrompt(request);
    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      let value: unknown;
      let measured: StructuredModelResponse["usage"];
      if (provider.client!.protocol === "openai-compatible") {
        const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
          { type: "text", text: prompt },
          ...(request.images ?? []).map((image) => ({
            type: "image_url" as const,
            image_url: {
              url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`,
            },
          })),
        ];
        const result = await awaitModel(
          provider.client!.value.chat.completions.create(
            {
              model: request.selection.model,
              stream: false,
              messages: [
                { role: "system", content: request.system },
                { role: "user", content },
              ],
              max_completion_tokens: request.maxOutputTokens,
              response_format:
                provider.config.responseMode === "json_schema"
                  ? {
                      type: "json_schema",
                      json_schema: {
                        name: request.schemaName,
                        schema: request.schema,
                        strict: false,
                      },
                    }
                  : { type: "json_object" },
            },
            { signal, timeout: provider.timeoutMs, maxRetries: 0 }
          ),
          signal
        );
        const choice = result.choices?.[0];
        if (
          choice?.message?.refusal ||
          choice?.finish_reason === "content_filter"
        )
          throw new PipelineError(
            "model_refused",
            "Model declined the request"
          );
        if (choice?.finish_reason === "length")
          throw new ModelOutputLimitError();
        if (
          choice?.finish_reason !== "stop" ||
          typeof choice.message.content !== "string"
        )
          throw new PipelineError(
            "invalid_model_output",
            "Model did not return a complete structured response",
            { retryable: true }
          );
        value = parseValue(choice.message.content, provider.maxResponseBytes);
        measured = usage(
          result.usage?.prompt_tokens,
          result.usage?.completion_tokens
        );
      } else {
        const format = jsonSchemaOutputFormat(
          request.schema as Parameters<typeof jsonSchemaOutputFormat>[0]
        );
        const content: Anthropic.Messages.ContentBlockParam[] = [
          ...(request.images ?? []).map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mediaType as
                | "image/jpeg"
                | "image/png"
                | "image/webp"
                | "image/gif",
              data: Buffer.from(image.data).toString("base64"),
            },
          })),
          { type: "text", text: prompt },
        ];
        const result = await awaitModel(
          provider.client!.value.messages.create(
            {
              model: request.selection.model,
              max_tokens: request.maxOutputTokens,
              system: request.system,
              messages: [{ role: "user", content }],
              stream: false,
              output_config: {
                format: { type: format.type, schema: format.schema },
              },
            },
            { signal, timeout: provider.timeoutMs, maxRetries: 0 }
          ),
          signal
        );
        if (result.stop_reason === "refusal")
          throw new PipelineError(
            "model_refused",
            "Model declined the request"
          );
        if (result.stop_reason === "max_tokens")
          throw new ModelOutputLimitError();
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (result.stop_reason !== "end_turn" || !text)
          throw new PipelineError(
            "invalid_model_output",
            "Model did not return a complete structured response",
            { retryable: true }
          );
        value = parseValue(text, provider.maxResponseBytes);
        measured = usage(
          result.usage?.input_tokens,
          result.usage?.output_tokens
        );
      }
      return {
        value,
        provider: request.selection.provider,
        model: request.selection.model,
        ...(measured ? { usage: measured } : {}),
      };
    } catch (error) {
      throw modelFailure(error, context.signal, deadline);
    }
  }
}
