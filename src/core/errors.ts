export type PipelineErrorCode =
  | "invalid_input"
  | "invalid_source"
  | "invalid_state"
  | "invalid_transcript"
  | "invalid_model_output"
  | "model_refused"
  | "model_authentication_failed"
  | "artifact_missing"
  | "attempt_limit"
  | "not_found"
  | "unavailable"
  | "capability_unavailable"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "resource_limit"
  | "storage_error"
  | "processing_failed"
  | "internal_error";

export interface PipelineErrorOptions {
  stage?: string;
  retryable?: boolean;
  cause?: unknown;
}

export interface SerializedPipelineError {
  code: PipelineErrorCode;
  message: string;
  retryable: boolean;
  stage?: string;
}

/** Application failures stay useful across CLI, worker and API boundaries. */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly stage?: string;
  readonly retryable: boolean;

  constructor(
    code: PipelineErrorCode,
    message: string,
    options: PipelineErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "PipelineError";
    this.code = code;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
  }

  /** Causes remain available to diagnostics without leaking provider internals on the wire. */
  toJSON(): SerializedPipelineError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.stage === undefined ? {} : { stage: this.stage }),
    };
  }
}

/** The model stopped at its requested token budget, so bounded escalation is possible. */
export class ModelOutputLimitError extends PipelineError {
  constructor() {
    super("resource_limit", "Model output reached its token limit");
    this.name = "ModelOutputLimitError";
  }
}

export function asPipelineError(
  error: unknown,
  options: PipelineErrorOptions = {}
): PipelineError {
  if (error instanceof PipelineError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new PipelineError("cancelled", "Processing cancelled", {
      ...options,
      retryable: false,
      cause: error,
    });
  }
  return new PipelineError(
    "processing_failed",
    error instanceof Error ? error.message : "Processing failed",
    {
      ...options,
      cause: error,
    }
  );
}

export function serializePipelineError(
  error: unknown
): SerializedPipelineError {
  return asPipelineError(error).toJSON();
}

/** A structural signal keeps domain code independent of a runtime's abort implementation. */
export function throwIfAborted(
  signal?: { readonly aborted: boolean; readonly reason?: unknown },
  stage?: string
): void {
  if (signal?.aborted) {
    throw new PipelineError("cancelled", "Processing cancelled", {
      stage,
      cause: signal.reason,
    });
  }
}
