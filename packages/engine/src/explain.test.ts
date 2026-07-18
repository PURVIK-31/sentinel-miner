import { describe, it, expect } from 'vitest';
import { parsePolicy, type Rule } from '@sentinel/dsl';
import { explain, formatValue } from './explain.js';

/** Builds a single validated rule. */
const rule = (candidate: unknown): Rule => {
  const policy = parsePolicy({ intent: 'swap', rules: [candidate] });
  return policy.rules[0]!;
};

describe('formatValue', () => {
  it('renders each scalar type unambiguously', () => {
    expect(formatValue(250)).toBe('250');
    expect(formatValue(-1)).toBe('-1');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(false)).toBe('false');
    expect(formatValue('base')).toBe('"base"');
  });

  it('distinguishes null from absent, and both from the strings', () => {
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('absent');
    expect(formatValue('null')).toBe('"null"');
    expect(formatValue('absent')).toBe('"absent"');
  });

  it('distinguishes the number 1 from the string "1"', () => {
    expect(formatValue(1)).not.toBe(formatValue('1'));
  });

  it('renders lists with their members formatted', () => {
    expect(formatValue(['base', 'ethereum'])).toBe('["base", "ethereum"]');
    expect(formatValue([1, 2])).toBe('[1, 2]');
    expect(formatValue([])).toBe('[]');
  });

  it('escapes quotes and backslashes so output stays parseable', () => {
    expect(formatValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatValue('a\\b')).toBe('"a\\\\b"');
  });

  it('escapes backslashes before quotes, not after', () => {
    // Getting this order wrong double-escapes and corrupts the output.
    expect(formatValue('\\"')).toBe('"\\\\\\""');
  });
});

describe('explain — comparisons', () => {
  it('states the value, the condition, and that it was satisfied', () => {
    const message = explain(rule({ field: 'buy_tax_bp', operator: '<=', value: 500 }), 250, 'PASS');
    expect(message).toBe('buy_tax_bp is 250, which satisfies <= 500.');
  });

  it('states clearly when a condition was not satisfied', () => {
    const message = explain(
      rule({ field: 'liquidity_usd', operator: '>', value: 10000 }),
      4200,
      'FAIL',
    );
    expect(message).toBe('liquidity_usd is 4200, which does not satisfy > 10000.');
  });

  it('explains missing evidence as uncollected, not as a failed threshold', () => {
    const message = explain(
      rule({ field: 'holders', operator: '>', value: 10 }),
      undefined,
      'MISSING_EVIDENCE',
    );
    expect(message).toContain('was not supplied by any evidence provider');
    expect(message).toContain('holders');
  });

  it('names the offending type on a mismatch', () => {
    const message = explain(
      rule({ field: 'chain', operator: '<', value: 10 }),
      'base',
      'TYPE_MISMATCH',
    );
    expect(message).toContain('"base"');
    expect(message).toContain('(string)');
    expect(message).toContain('cannot be compared');
  });

  it('reports a decimal actual as a decimal, flagging the upstream bug', () => {
    const message = explain(rule({ field: 'tax', operator: '<', value: 10 }), 2.5, 'TYPE_MISMATCH');
    expect(message).toContain('(decimal)');
  });

  it('reports a list actual as a list', () => {
    const message = explain(
      rule({ field: 'tags', operator: '<', value: 10 }),
      ['a'],
      'TYPE_MISMATCH',
    );
    expect(message).toContain('(list)');
  });

  it('reports an absent actual as absent if a mismatch is reported for one', () => {
    const message = explain(
      rule({ field: 'tax', operator: '<', value: 10 }),
      undefined,
      'TYPE_MISMATCH',
    );
    expect(message).toContain('(absent)');
  });

  it('reports a boolean actual as a boolean', () => {
    const message = explain(
      rule({ field: 'tax', operator: '<', value: 10 }),
      true,
      'TYPE_MISMATCH',
    );
    expect(message).toContain('(boolean)');
  });

  it('reports a null actual as null', () => {
    const message = explain(
      rule({ field: 'tax', operator: '<', value: 10 }),
      null,
      'TYPE_MISMATCH',
    );
    expect(message).toContain('(null)');
  });

  it('renders set conditions readably', () => {
    const message = explain(
      rule({ field: 'chain', operator: 'in', value: ['base', 'ethereum'] }),
      'solana',
      'FAIL',
    );
    expect(message).toBe('chain is "solana", which does not satisfy in ["base", "ethereum"].');
  });
});

describe('explain — exists', () => {
  it('confirms a required field that is present', () => {
    const message = explain(
      rule({ field: 'contract_verified', operator: 'exists', value: true }),
      true,
      'PASS',
    );
    expect(message).toBe('contract_verified is present, as required.');
  });

  it('distinguishes absent from null when a required field is missing', () => {
    const required = rule({ field: 'contract_verified', operator: 'exists', value: true });
    expect(explain(required, undefined, 'FAIL')).toContain('it is absent');
    expect(explain(required, null, 'FAIL')).toContain('it is null');
  });

  it('confirms a forbidden field that is absent', () => {
    const message = explain(
      rule({ field: 'owner', operator: 'exists', value: false }),
      undefined,
      'PASS',
    );
    expect(message).toBe('owner is absent, as required.');
  });

  it('shows the offending value when a forbidden field is present', () => {
    const message = explain(
      rule({ field: 'owner', operator: 'exists', value: false }),
      '0xabc',
      'FAIL',
    );
    expect(message).toContain('required to be absent');
    expect(message).toContain('"0xabc"');
  });

  it('does not describe a present falsy value as absent', () => {
    const message = explain(
      rule({ field: 'liquidity_usd', operator: 'exists', value: true }),
      0,
      'PASS',
    );
    expect(message).toBe('liquidity_usd is present, as required.');
  });
});

describe('determinism', () => {
  it('returns byte-identical text across repeated calls', () => {
    const target = rule({ field: 'buy_tax_bp', operator: '<=', value: 500 });
    const first = explain(target, 250, 'PASS');
    for (let i = 0; i < 50; i += 1) {
      expect(explain(target, 250, 'PASS')).toBe(first);
    }
  });

  it('formats numbers without locale-dependent grouping separators', () => {
    // `toLocaleString` would render 1234567 as "1,234,567" or "1.234.567".
    expect(formatValue(1234567)).toBe('1234567');
  });
});
