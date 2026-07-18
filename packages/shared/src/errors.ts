/**
 * The error hierarchy for Sentinel Miner.
 *
 * Every failure the system can produce is one of these. Each carries a stable
 * machine-readable `code` (safe to branch on, safe to expose to clients) and an
 * `httpStatus` so the API layer can map errors to responses without a translation
 * table that drifts out of sync.
 *
 * `details` is the only free-form field, and it is part of the public response
 * body — never put provider API keys, raw upstream URLs, or internal stack context
 * in it. See {@link SentinelError.toPublicJSON}.
 */

/** Stable, machine-readable error codes. Values are part of the API contract. */
export const ErrorCode = {
  POLICY_INVALID: 'POLICY_INVALID',
  REQUEST_INVALID: 'REQUEST_INVALID',
  UNKNOWN_OPERATOR: 'UNKNOWN_OPERATOR',
  OPERAND_TYPE_MISMATCH: 'OPERAND_TYPE_MISMATCH',
  EVIDENCE_UNAVAILABLE: 'EVIDENCE_UNAVAILABLE',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  NORMALIZATION_FAILED: 'NORMALIZATION_FAILED',
  CONFIGURATION_INVALID: 'CONFIGURATION_INVALID',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The client-safe shape of an error. This is what crosses the API boundary. */
export interface PublicErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

/** Base class for every error raised inside Sentinel Miner. */
export abstract class SentinelError extends Error {
  /** Stable machine-readable code. */
  abstract readonly code: ErrorCode;

  /** HTTP status the API layer should use for this error. */
  abstract readonly httpStatus: number;

  /**
   * Whether a caller can reasonably retry the same request unchanged.
   * Timeouts and rate limits are retryable; an invalid policy never is.
   */
  readonly retryable: boolean = false;

  /** Client-safe structured context. Must not contain secrets. */
  readonly details: unknown;

  constructor(message: string, options?: { cause?: unknown; details?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options?.details;
    // Keeps `instanceof` working when compiled output is consumed across module
    // boundaries with differing target settings.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serializes to the client-safe body. Never includes `cause` or the stack. */
  toPublicJSON(): PublicErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** A policy failed DSL validation. */
export class PolicyValidationError extends SentinelError {
  readonly code = ErrorCode.POLICY_INVALID;
  readonly httpStatus = 400;
}

/** A request body failed schema validation. */
export class RequestValidationError extends SentinelError {
  readonly code = ErrorCode.REQUEST_INVALID;
  readonly httpStatus = 400;
}

/** A policy referenced an operator the engine does not implement. */
export class UnknownOperatorError extends SentinelError {
  readonly code = ErrorCode.UNKNOWN_OPERATOR;
  readonly httpStatus = 400;

  constructor(operator: string, supported: readonly string[]) {
    super(`Unknown operator '${operator}'.`, {
      details: { operator, supported },
    });
  }
}

/**
 * An operator was applied to operands it cannot compare — for example `<` against
 * a boolean. This is a policy authoring error, not a data error.
 */
export class OperandTypeMismatchError extends SentinelError {
  readonly code = ErrorCode.OPERAND_TYPE_MISMATCH;
  readonly httpStatus = 400;
}

/** A field the policy requires was not supplied by any provider. */
export class EvidenceUnavailableError extends SentinelError {
  readonly code = ErrorCode.EVIDENCE_UNAVAILABLE;
  readonly httpStatus = 422;
}

/** An evidence provider returned an error or an unparseable response. */
export class ProviderError extends SentinelError {
  readonly code = ErrorCode.PROVIDER_FAILED;
  readonly httpStatus = 502;
}

/** An evidence provider did not respond within its configured budget. */
export class ProviderTimeoutError extends SentinelError {
  readonly code = ErrorCode.PROVIDER_TIMEOUT;
  readonly httpStatus = 504;
  override readonly retryable = true;
}

/** An evidence provider rejected the request for rate limiting. */
export class ProviderRateLimitError extends SentinelError {
  readonly code = ErrorCode.PROVIDER_RATE_LIMITED;
  readonly httpStatus = 429;
  override readonly retryable = true;
}

/** A provider response could not be normalized into deterministic evidence. */
export class NormalizationError extends SentinelError {
  readonly code = ErrorCode.NORMALIZATION_FAILED;
  readonly httpStatus = 502;
}

/** Environment or configuration failed validation. Fatal at startup. */
export class ConfigurationError extends SentinelError {
  readonly code = ErrorCode.CONFIGURATION_INVALID;
  readonly httpStatus = 500;
}

/** An unexpected internal failure. The message is deliberately generic. */
export class InternalError extends SentinelError {
  readonly code = ErrorCode.INTERNAL;
  readonly httpStatus = 500;
}

/** Narrows an unknown thrown value to a {@link SentinelError}. */
export function isSentinelError(value: unknown): value is SentinelError {
  return value instanceof SentinelError;
}

/**
 * Wraps any thrown value into a {@link SentinelError}.
 *
 * Used at trust boundaries so nothing escapes as a bare `unknown`. Non-Sentinel
 * errors collapse to {@link InternalError} with a generic message — the original
 * is preserved as `cause` for the logger but never reaches the client, since
 * upstream error strings can leak URLs and credentials.
 */
export function toSentinelError(value: unknown): SentinelError {
  if (isSentinelError(value)) {
    return value;
  }
  return new InternalError('An unexpected internal error occurred.', { cause: value });
}
