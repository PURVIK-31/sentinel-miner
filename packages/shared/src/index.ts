/**
 * @packageDocumentation
 * Pure domain types and the error hierarchy shared across Sentinel Miner.
 * This package has no runtime dependencies and contains no business logic.
 */

export type { Scalar, EvidenceValue, Evidence, Decision } from './values.js';
export {
  isDeterministicNumber,
  isScalar,
  isEvidenceValue,
  isSafeFieldName,
  readField,
  FORBIDDEN_FIELD_NAMES,
} from './values.js';

export type { PublicErrorBody } from './errors.js';
export {
  ErrorCode,
  SentinelError,
  PolicyValidationError,
  RequestValidationError,
  UnknownOperatorError,
  OperandTypeMismatchError,
  EvidenceUnavailableError,
  ProviderError,
  ProviderTimeoutError,
  ProviderRateLimitError,
  NormalizationError,
  ConfigurationError,
  InternalError,
  isSentinelError,
  toSentinelError,
} from './errors.js';
