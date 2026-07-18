import { describe, it, expect } from 'vitest';
import {
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

describe('SentinelError', () => {
  it('sets name from the concrete subclass, not the base', () => {
    expect(new PolicyValidationError('bad').name).toBe('PolicyValidationError');
  });

  it('remains instanceof both the subclass and the base', () => {
    const error = new PolicyValidationError('bad');
    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error).toBeInstanceOf(SentinelError);
    expect(error).toBeInstanceOf(Error);
  });

  it('defaults to non-retryable', () => {
    expect(new PolicyValidationError('bad').retryable).toBe(false);
  });

  it('marks transient provider failures as retryable', () => {
    expect(new ProviderTimeoutError('slow').retryable).toBe(true);
    expect(new ProviderRateLimitError('slow down').retryable).toBe(true);
  });

  it('preserves cause for logging', () => {
    const cause = new Error('underlying');
    expect(new InternalError('wrapped', { cause }).cause).toBe(cause);
  });

  it('leaves cause undefined when not supplied', () => {
    expect(new InternalError('plain').cause).toBeUndefined();
  });
});

describe('toPublicJSON', () => {
  it('emits code and message', () => {
    expect(new PolicyValidationError('Policy is empty.').toPublicJSON()).toEqual({
      error: { code: ErrorCode.POLICY_INVALID, message: 'Policy is empty.' },
    });
  });

  it('omits details entirely when there are none', () => {
    const body = new PolicyValidationError('bad').toPublicJSON();
    expect('details' in body.error).toBe(false);
  });

  it('includes details when supplied', () => {
    const body = new PolicyValidationError('bad', { details: { ruleIndex: 2 } }).toPublicJSON();
    expect(body.error.details).toEqual({ ruleIndex: 2 });
  });

  it('never leaks the cause or the stack to clients', () => {
    const cause = new Error('postgres://user:hunter2@host/db unreachable');
    const body = new InternalError('An unexpected internal error occurred.', { cause });
    const serialized = JSON.stringify(body.toPublicJSON());
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('postgres');
    expect(serialized).not.toContain('stack');
  });
});

describe('UnknownOperatorError', () => {
  it('reports the offending operator and the supported set', () => {
    const error = new UnknownOperatorError('~=', ['==', '!=']);
    expect(error.message).toBe("Unknown operator '~='.");
    expect(error.details).toEqual({ operator: '~=', supported: ['==', '!='] });
    expect(error.httpStatus).toBe(400);
  });
});

describe('http status mapping', () => {
  it.each([
    [new PolicyValidationError('x'), 400],
    [new ProviderRateLimitError('x'), 429],
    [new ProviderTimeoutError('x'), 504],
    [new InternalError('x'), 500],
  ])('maps %s to status %i', (error, status) => {
    expect(error.httpStatus).toBe(status);
  });
});

describe('the full error taxonomy', () => {
  // Every error the system can raise, with the contract each one promises.
  const cases = [
    { error: new PolicyValidationError('x'), code: ErrorCode.POLICY_INVALID, status: 400 },
    { error: new RequestValidationError('x'), code: ErrorCode.REQUEST_INVALID, status: 400 },
    {
      error: new OperandTypeMismatchError('x'),
      code: ErrorCode.OPERAND_TYPE_MISMATCH,
      status: 400,
    },
    { error: new EvidenceUnavailableError('x'), code: ErrorCode.EVIDENCE_UNAVAILABLE, status: 422 },
    { error: new ProviderError('x'), code: ErrorCode.PROVIDER_FAILED, status: 502 },
    { error: new ProviderTimeoutError('x'), code: ErrorCode.PROVIDER_TIMEOUT, status: 504 },
    { error: new ProviderRateLimitError('x'), code: ErrorCode.PROVIDER_RATE_LIMITED, status: 429 },
    { error: new NormalizationError('x'), code: ErrorCode.NORMALIZATION_FAILED, status: 502 },
    { error: new ConfigurationError('x'), code: ErrorCode.CONFIGURATION_INVALID, status: 500 },
    { error: new InternalError('x'), code: ErrorCode.INTERNAL, status: 500 },
  ] as const;

  it.each(cases)('$error.name carries code $code and status $status', ({ error, code, status }) => {
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error).toBeInstanceOf(SentinelError);
    expect(error.toPublicJSON().error.code).toBe(code);
  });

  it('assigns a distinct code to every error class', () => {
    const codes = cases.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('marks exactly the transient failures as retryable', () => {
    const retryable = cases.filter((entry) => entry.error.retryable).map((entry) => entry.code);
    expect(retryable.sort()).toEqual(
      [ErrorCode.PROVIDER_RATE_LIMITED, ErrorCode.PROVIDER_TIMEOUT].sort(),
    );
  });
});

describe('isSentinelError', () => {
  it('accepts Sentinel errors and rejects everything else', () => {
    expect(isSentinelError(new PolicyValidationError('x'))).toBe(true);
    expect(isSentinelError(new Error('x'))).toBe(false);
    expect(isSentinelError('a string throw')).toBe(false);
    expect(isSentinelError(null)).toBe(false);
    expect(isSentinelError(undefined)).toBe(false);
  });
});

describe('toSentinelError', () => {
  it('returns Sentinel errors unchanged, preserving identity', () => {
    const original = new PolicyValidationError('bad');
    expect(toSentinelError(original)).toBe(original);
  });

  it.each([
    ['a bare Error', new Error('boom')],
    ['a thrown string', 'boom'],
    ['a thrown null', null],
    ['a thrown object', { weird: true }],
  ])('collapses %s to a generic InternalError', (_label, thrown) => {
    const wrapped = toSentinelError(thrown);
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.code).toBe(ErrorCode.INTERNAL);
    expect(wrapped.message).toBe('An unexpected internal error occurred.');
    expect(wrapped.cause).toBe(thrown);
  });

  it('does not let an upstream error message reach the client', () => {
    const leaky = new Error('Basescan rejected apikey=SECRET123');
    const body = toSentinelError(leaky).toPublicJSON();
    expect(JSON.stringify(body)).not.toContain('SECRET123');
  });
});
