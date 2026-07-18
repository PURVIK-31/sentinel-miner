import { describe, it, expect } from 'vitest';
import { OPERATORS } from '@sentinel/dsl';
import { applyOperator, OPERATOR_FNS, type RuleOutcome } from './operators.js';
import type { EvidenceValue } from '@sentinel/shared';

/** Shorthand: apply an operator and assert the outcome. */
const outcome = (
  operator: Parameters<typeof applyOperator>[0],
  actual: EvidenceValue | undefined,
  expected: Parameters<typeof applyOperator>[2],
): RuleOutcome => applyOperator(operator, actual, expected);

describe('registry completeness', () => {
  it('implements every operator declared by the DSL grammar', () => {
    // This is the drift guard: the DSL owns the grammar, the engine owns semantics.
    expect(Object.keys(OPERATOR_FNS).sort()).toEqual([...OPERATORS].sort());
  });
});

describe('== (equality)', () => {
  it('passes on identical scalars of each type', () => {
    expect(outcome('==', 250, 250)).toBe('PASS');
    expect(outcome('==', 'base', 'base')).toBe('PASS');
    expect(outcome('==', false, false)).toBe('PASS');
    expect(outcome('==', null, null)).toBe('PASS');
  });

  it('fails on differing values', () => {
    expect(outcome('==', 250, 500)).toBe('FAIL');
    expect(outcome('==', 'base', 'ethereum')).toBe('FAIL');
    expect(outcome('==', true, false)).toBe('FAIL');
  });

  it('never coerces across types, so 1 does not equal "1" or true', () => {
    // Loose equality here would let `"0"` satisfy `is_honeypot == false`.
    expect(outcome('==', 1, '1')).toBe('FAIL');
    expect(outcome('==', 1, true)).toBe('FAIL');
    expect(outcome('==', 0, false)).toBe('FAIL');
    expect(outcome('==', '', false)).toBe('FAIL');
  });

  it('distinguishes null from a missing field', () => {
    expect(outcome('==', null, null)).toBe('PASS');
    expect(outcome('==', undefined, null)).toBe('MISSING_EVIDENCE');
  });

  it('reports a type mismatch when evidence is an array', () => {
    expect(outcome('==', ['a'], 'a')).toBe('TYPE_MISMATCH');
  });
});

describe('!= (inequality)', () => {
  it('is the exact complement of == on comparable operands', () => {
    expect(outcome('!=', 250, 500)).toBe('PASS');
    expect(outcome('!=', 250, 250)).toBe('FAIL');
    expect(outcome('!=', null, null)).toBe('FAIL');
    expect(outcome('!=', 'a', null)).toBe('PASS');
  });

  it('does not invert into a PASS when evidence is missing', () => {
    // Fail-closed: absent evidence must never satisfy a rule.
    expect(outcome('!=', undefined, 'anything')).toBe('MISSING_EVIDENCE');
  });

  it('does not invert into a PASS on a type mismatch', () => {
    expect(outcome('!=', ['a'], 'a')).toBe('TYPE_MISMATCH');
  });
});

describe('ordered comparisons', () => {
  it.each([
    ['<', 4, 5, 'PASS'],
    ['<', 5, 5, 'FAIL'],
    ['<', 6, 5, 'FAIL'],
    ['<=', 4, 5, 'PASS'],
    ['<=', 5, 5, 'PASS'],
    ['<=', 6, 5, 'FAIL'],
    ['>', 6, 5, 'PASS'],
    ['>', 5, 5, 'FAIL'],
    ['>', 4, 5, 'FAIL'],
    ['>=', 6, 5, 'PASS'],
    ['>=', 5, 5, 'PASS'],
    ['>=', 4, 5, 'FAIL'],
  ] as const)('%s: %i vs %i is %s', (operator, actual, expected, result) => {
    expect(outcome(operator, actual, expected)).toBe(result);
  });

  it('handles negative integers and zero correctly', () => {
    expect(outcome('<', -100, 0)).toBe('PASS');
    expect(outcome('>=', 0, -1)).toBe('PASS');
    expect(outcome('<=', -5, -5)).toBe('PASS');
  });

  it('compares at the safe-integer boundary without precision loss', () => {
    expect(outcome('<', Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER)).toBe('PASS');
  });

  it.each(['<', '<=', '>', '>='] as const)(
    '%s reports MISSING_EVIDENCE rather than comparing against undefined',
    (operator) => {
      expect(outcome(operator, undefined, 5)).toBe('MISSING_EVIDENCE');
    },
  );

  it.each(['<', '<=', '>', '>='] as const)(
    '%s refuses to compare a non-integer actual instead of coercing it',
    (operator) => {
      // `"10" < 5` would be a silent string comparison in plain JavaScript.
      expect(outcome(operator, '10', 5)).toBe('TYPE_MISMATCH');
      expect(outcome(operator, true, 5)).toBe('TYPE_MISMATCH');
      expect(outcome(operator, null, 5)).toBe('TYPE_MISMATCH');
      expect(outcome(operator, [1], 5)).toBe('TYPE_MISMATCH');
    },
  );

  it('refuses a float actual, which the normalizer should never have emitted', () => {
    expect(outcome('<', 4.5, 5)).toBe('TYPE_MISMATCH');
  });
});

describe('in / not_in (set membership)', () => {
  it('detects membership for each scalar type', () => {
    expect(outcome('in', 'base', ['base', 'ethereum'])).toBe('PASS');
    expect(outcome('in', 2, [1, 2, 3])).toBe('PASS');
    expect(outcome('in', true, [true])).toBe('PASS');
  });

  it('reports a non-member as FAIL', () => {
    expect(outcome('in', 'solana', ['base', 'ethereum'])).toBe('FAIL');
  });

  it('inverts correctly for not_in', () => {
    expect(outcome('not_in', 'solana', ['base'])).toBe('PASS');
    expect(outcome('not_in', 'base', ['base'])).toBe('FAIL');
  });

  it('matches by strict identity, never by coercion', () => {
    expect(outcome('in', '1', [1])).toBe('FAIL');
    expect(outcome('in', 1, ['1'])).toBe('FAIL');
    expect(outcome('in', 0, [false])).toBe('FAIL');
  });

  it('treats null evidence as a non-member rather than an error', () => {
    // Sets cannot contain null by schema, so this is unambiguous.
    expect(outcome('in', null, ['base'])).toBe('FAIL');
    expect(outcome('not_in', null, ['base'])).toBe('PASS');
  });

  it('reports MISSING_EVIDENCE for an absent field, for both directions', () => {
    // not_in must not vacuously PASS on missing evidence.
    expect(outcome('in', undefined, ['base'])).toBe('MISSING_EVIDENCE');
    expect(outcome('not_in', undefined, ['base'])).toBe('MISSING_EVIDENCE');
  });

  it('reports a type mismatch when evidence is itself an array', () => {
    expect(outcome('in', ['base'], ['base'])).toBe('TYPE_MISMATCH');
    expect(outcome('not_in', ['base'], ['base'])).toBe('TYPE_MISMATCH');
  });

  it('never consults inherited array members', () => {
    expect(outcome('in', 'toString', ['base'])).toBe('FAIL');
  });
});

describe('exists (presence)', () => {
  it('treats a present, non-null value as existing', () => {
    expect(outcome('exists', 250, true)).toBe('PASS');
    expect(outcome('exists', 0, true)).toBe('PASS');
    expect(outcome('exists', '', true)).toBe('PASS');
    expect(outcome('exists', false, true)).toBe('PASS');
    expect(outcome('exists', [], true)).toBe('PASS');
  });

  it('does not treat falsy values as absent', () => {
    // A truthiness check here would report `liquidity_usd: 0` as missing.
    expect(outcome('exists', 0, false)).toBe('FAIL');
    expect(outcome('exists', '', false)).toBe('FAIL');
    expect(outcome('exists', false, false)).toBe('FAIL');
  });

  it('treats an explicit null as not existing', () => {
    expect(outcome('exists', null, false)).toBe('PASS');
    expect(outcome('exists', null, true)).toBe('FAIL');
  });

  it('treats an absent field as not existing', () => {
    expect(outcome('exists', undefined, false)).toBe('PASS');
    expect(outcome('exists', undefined, true)).toBe('FAIL');
  });

  it('refuses a non-boolean operand, guarding direct callers that bypass the DSL', () => {
    // Validated policies cannot reach this, but `applyOperator` is public API.
    expect(outcome('exists', 250, 'yes')).toBe('TYPE_MISMATCH');
    expect(outcome('exists', 250, 1)).toBe('TYPE_MISMATCH');
    expect(outcome('exists', 250, null)).toBe('TYPE_MISMATCH');
  });

  it('is the one operator that never reports MISSING_EVIDENCE', () => {
    // Its entire purpose is to answer the presence question.
    expect(outcome('exists', undefined, true)).not.toBe('MISSING_EVIDENCE');
    expect(outcome('exists', undefined, false)).not.toBe('MISSING_EVIDENCE');
  });
});

describe('determinism', () => {
  const cases: readonly [
    Parameters<typeof applyOperator>[0],
    EvidenceValue | undefined,
    Parameters<typeof applyOperator>[2],
  ][] = [
    ['==', 250, 250],
    ['<', 4, 5],
    ['in', 'base', ['base']],
    ['exists', null, true],
    ['!=', undefined, 1],
  ];

  it('returns an identical outcome across repeated invocations', () => {
    for (const [operator, actual, expected] of cases) {
      const first = applyOperator(operator, actual, expected);
      for (let i = 0; i < 100; i += 1) {
        expect(applyOperator(operator, actual, expected)).toBe(first);
      }
    }
  });

  it('does not mutate its operands', () => {
    const actual: EvidenceValue = ['a', 'b'];
    const expected = ['a', 'b'];
    applyOperator('in', actual, expected);
    expect(actual).toEqual(['a', 'b']);
    expect(expected).toEqual(['a', 'b']);
  });
});
