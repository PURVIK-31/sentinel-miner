import { describe, it, expect } from 'vitest';
import {
  isDeterministicNumber,
  isScalar,
  isEvidenceValue,
  isSafeFieldName,
  readField,
  FORBIDDEN_FIELD_NAMES,
} from './values.js';
import type { Evidence } from './values.js';

describe('isDeterministicNumber', () => {
  it.each([0, -0, 1, -1, 250, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    'accepts the integer %s',
    (value) => {
      expect(isDeterministicNumber(value)).toBe(true);
    },
  );

  it.each([0.1, -2.5, 1e-7, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-integer %s',
    (value) => {
      expect(isDeterministicNumber(value)).toBe(false);
    },
  );

  it.each([['1'], [true], [null], [undefined], [{}], [[]]])(
    'rejects the non-number %s',
    (value) => {
      expect(isDeterministicNumber(value)).toBe(false);
    },
  );
});

describe('isScalar', () => {
  it('accepts strings, booleans, and integers', () => {
    expect(isScalar('token')).toBe(true);
    expect(isScalar('')).toBe(true);
    expect(isScalar(false)).toBe(true);
    expect(isScalar(42)).toBe(true);
  });

  it('rejects floats, so a float can never enter the engine as a scalar', () => {
    expect(isScalar(4.2)).toBe(false);
  });

  it('rejects null, undefined, objects, and arrays', () => {
    expect(isScalar(null)).toBe(false);
    expect(isScalar(undefined)).toBe(false);
    expect(isScalar({})).toBe(false);
    expect(isScalar([1])).toBe(false);
  });
});

describe('isEvidenceValue', () => {
  it('accepts scalars and null', () => {
    expect(isEvidenceValue('a')).toBe(true);
    expect(isEvidenceValue(7)).toBe(true);
    expect(isEvidenceValue(true)).toBe(true);
    expect(isEvidenceValue(null)).toBe(true);
  });

  it('accepts flat arrays of scalars, including the empty array', () => {
    expect(isEvidenceValue([])).toBe(true);
    expect(isEvidenceValue(['a', 'b'])).toBe(true);
    expect(isEvidenceValue([1, 2, 3])).toBe(true);
    expect(isEvidenceValue([1, 'mixed', true])).toBe(true);
  });

  it('rejects nested arrays and arrays containing objects', () => {
    expect(isEvidenceValue([[1]])).toBe(false);
    expect(isEvidenceValue([{ a: 1 }])).toBe(false);
    expect(isEvidenceValue([null])).toBe(false);
  });

  it('rejects arrays containing floats', () => {
    expect(isEvidenceValue([1, 2.5])).toBe(false);
  });

  it('rejects plain objects and undefined', () => {
    expect(isEvidenceValue({ a: 1 })).toBe(false);
    expect(isEvidenceValue(undefined)).toBe(false);
  });
});

describe('isSafeFieldName', () => {
  it('accepts ordinary field names', () => {
    expect(isSafeFieldName('buy_tax_bp')).toBe(true);
    expect(isSafeFieldName('liquidity_usd')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isSafeFieldName('')).toBe(false);
  });

  it.each(FORBIDDEN_FIELD_NAMES)('rejects the prototype-pollution vector %s', (field) => {
    expect(isSafeFieldName(field)).toBe(false);
  });
});

describe('readField', () => {
  const evidence: Evidence = { buy_tax_bp: 250, note: null };

  it('returns the value for a present field', () => {
    expect(readField(evidence, 'buy_tax_bp')).toBe(250);
  });

  it('distinguishes a present null field from an absent one', () => {
    // This distinction is the entire basis of the `exists` operator.
    expect(readField(evidence, 'note')).toBeNull();
    expect(readField(evidence, 'missing')).toBeUndefined();
  });

  it('never resolves inherited properties from the prototype chain', () => {
    // `toString` exists on Object.prototype but is not evidence.
    expect(readField(evidence, 'toString')).toBeUndefined();
    expect(readField(evidence, 'constructor')).toBeUndefined();
    expect(readField(evidence, '__proto__')).toBeUndefined();
  });

  it('reads own properties even on a null-prototype record', () => {
    const bare = Object.assign(Object.create(null) as Evidence, { a: 1 });
    expect(readField(bare, 'a')).toBe(1);
  });
});
