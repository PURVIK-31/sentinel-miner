import { describe, it, expect } from 'vitest';
import { PolicyValidationError } from '@sentinel/shared';
import { parsePolicy, parsePolicyInput, safeParsePolicy, referencedFields } from './validate.js';
import { DSL_VERSION } from './schema.js';
import type { PolicyIssue } from './validate.js';

/** A minimal valid policy, cloned per test so mutation cannot leak between cases. */
const validPolicy = (): Record<string, unknown> => ({
  intent: 'swap',
  rules: [{ field: 'buy_tax_bp', operator: '<=', value: 500 }],
});

/** Extracts issues from a thrown PolicyValidationError. */
function issuesOf(fn: () => unknown): PolicyIssue[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyValidationError);
    const details = (error as PolicyValidationError).details as { issues: PolicyIssue[] };
    return details.issues;
  }
  throw new Error('Expected the policy to be rejected, but it was accepted.');
}

describe('parsePolicy — acceptance', () => {
  it('accepts a minimal policy and defaults the DSL version', () => {
    const policy = parsePolicy(validPolicy());
    expect(policy.dsl_version).toBe(DSL_VERSION);
    expect(policy.intent).toBe('swap');
    expect(policy.rules).toHaveLength(1);
  });

  it('accepts every operator with a well-typed operand', () => {
    const policy = parsePolicy({
      intent: 'swap',
      rules: [
        { field: 'is_honeypot', operator: '==', value: false },
        { field: 'symbol', operator: '!=', value: 'SCAM' },
        { field: 'buy_tax_bp', operator: '<', value: 500 },
        { field: 'sell_tax_bp', operator: '<=', value: 500 },
        { field: 'liquidity_usd', operator: '>', value: 10000 },
        { field: 'holder_count', operator: '>=', value: 50 },
        { field: 'chain', operator: 'in', value: ['base', 'ethereum'] },
        { field: 'flags', operator: 'not_in', value: ['blacklisted'] },
        { field: 'contract_verified', operator: 'exists', value: true },
      ],
    });
    expect(policy.rules).toHaveLength(9);
  });

  it('accepts optional metadata and per-rule descriptions', () => {
    const policy = parsePolicy({
      dsl_version: '1.0',
      id: 'strict_treasury',
      name: 'Strict Treasury',
      description: 'Conservative policy for treasury wallets.',
      intent: 'swap',
      rules: [{ field: 'buy_tax_bp', operator: '<=', value: 0, description: 'No tax tolerated.' }],
    });
    expect(policy.id).toBe('strict_treasury');
    expect(policy.rules[0]?.description).toBe('No tax tolerated.');
  });

  it('accepts null as a comparison target for equality operators', () => {
    expect(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'owner', operator: '==', value: null }] }),
    ).not.toThrow();
  });

  it('accepts multiple rules on one field, which is how ranges are expressed', () => {
    const policy = parsePolicy({
      intent: 'swap',
      rules: [
        { field: 'liquidity_usd', operator: '>', value: 10000 },
        { field: 'liquidity_usd', operator: '<', value: 100000000 },
      ],
    });
    expect(policy.rules).toHaveLength(2);
  });
});

describe('parsePolicy — rejection', () => {
  it('rejects a policy with no rules, which would trivially ALLOW everything', () => {
    const issues = issuesOf(() => parsePolicy({ intent: 'swap', rules: [] }));
    expect(issues[0]?.message).toMatch(/at least one rule/i);
  });

  it('rejects a missing intent', () => {
    const issues = issuesOf(() => parsePolicy({ rules: validPolicy().rules }));
    expect(issues.some((issue) => issue.path === 'intent')).toBe(true);
  });

  it('names the offending operator and lists the supported set', () => {
    const issues = issuesOf(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'a', operator: '~=', value: 1 }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('rules.0.operator');
    expect(issues[0]?.message).toContain("'~='");
    expect(issues[0]?.message).toContain('not_in');
  });

  it('reports the index of the offending rule, not just the first rule', () => {
    const issues = issuesOf(() =>
      parsePolicy({
        intent: 'swap',
        rules: [
          { field: 'a', operator: '==', value: 1 },
          { field: 'b', operator: 'contains', value: 1 },
        ],
      }),
    );
    expect(issues[0]?.path).toBe('rules.1.operator');
  });

  it('rejects unknown keys rather than silently dropping them', () => {
    // A typo'd key must never cause a security rule to vanish.
    const issues = issuesOf(() =>
      parsePolicy({ intent: 'swap', rules: validPolicy().rules, unexpected: true }),
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects a misspelled key inside a rule', () => {
    const issues = issuesOf(() =>
      parsePolicy({
        intent: 'swap',
        rules: [{ field: 'a', operatr: '==', value: 1 }],
      }),
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects an unsupported dsl_version', () => {
    const issues = issuesOf(() => parsePolicy({ ...validPolicy(), dsl_version: '2.0' }));
    expect(issues.some((issue) => issue.path === 'dsl_version')).toBe(true);
  });

  it.each([null, undefined, 42, 'a string', []])(
    'rejects the non-object policy %s',
    (candidate) => {
      expect(() => parsePolicy(candidate)).toThrow(PolicyValidationError);
    },
  );
});

describe('parsePolicy — determinism guards', () => {
  it('rejects a float threshold, since floats break reproducible comparison', () => {
    const issues = issuesOf(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'buy_tax_bp', operator: '<=', value: 2.5 }] }),
    );
    expect(issues[0]?.message).toMatch(/integer/i);
  });

  it('accepts a threshold exactly at the safe-integer boundary', () => {
    expect(() =>
      parsePolicy({
        intent: 'swap',
        rules: [{ field: 'supply', operator: '<', value: Number.MAX_SAFE_INTEGER }],
      }),
    ).not.toThrow();
  });

  it('rejects an integer beyond the safe range, where equality stops being reliable', () => {
    const issues = issuesOf(() =>
      parsePolicy({
        intent: 'swap',
        rules: [{ field: 'supply', operator: '<', value: Number.MAX_SAFE_INTEGER + 2 }],
      }),
    );
    expect(issues[0]?.path).toBe('rules.0.value');
    expect(issues[0]?.message).toMatch(/integer/i);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-finite threshold %s',
    (value) => {
      expect(() =>
        parsePolicy({ intent: 'swap', rules: [{ field: 'a', operator: '<', value }] }),
      ).toThrow(PolicyValidationError);
    },
  );

  it('rejects ordered comparison against a string, which would depend on collation', () => {
    expect(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'name', operator: '<', value: 'zebra' }] }),
    ).toThrow(PolicyValidationError);
  });

  it('rejects ordered comparison against a boolean', () => {
    expect(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'ok', operator: '>=', value: true }] }),
    ).toThrow(PolicyValidationError);
  });

  it('rejects an empty set, which would make the rule a constant', () => {
    const issues = issuesOf(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'chain', operator: 'in', value: [] }] }),
    );
    expect(issues[0]?.message).toMatch(/at least one member/i);
  });

  it('rejects a non-boolean operand for exists', () => {
    expect(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'a', operator: 'exists', value: 'yes' }] }),
    ).toThrow(PolicyValidationError);
  });

  it('rejects a nested array inside a set operand', () => {
    expect(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: 'a', operator: 'in', value: [['x']] }] }),
    ).toThrow(PolicyValidationError);
  });
});

describe('parsePolicy — prototype pollution defence', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects %s as a policy field name',
    (field) => {
      expect(() =>
        parsePolicy({ intent: 'swap', rules: [{ field, operator: '==', value: 1 }] }),
      ).toThrow(PolicyValidationError);
    },
  );

  it('rejects an empty field name', () => {
    expect(() =>
      parsePolicy({ intent: 'swap', rules: [{ field: '', operator: '==', value: 1 }] }),
    ).toThrow(PolicyValidationError);
  });

  it('does not pollute Object.prototype when a policy carries a __proto__ key', () => {
    const malicious = JSON.parse(
      '{"intent":"swap","rules":[{"field":"a","operator":"==","value":1}],"__proto__":{"polluted":"yes"}}',
    ) as unknown;
    try {
      parsePolicy(malicious);
    } catch {
      // Rejection is fine; the assertion below is the point.
    }
    // `in` walks the prototype chain, which is exactly where pollution would land.
    expect('polluted' in {}).toBe(false);
  });
});

describe('parsePolicyInput — array shorthand', () => {
  it('normalizes the bare-array form to a canonical policy', () => {
    const policy = parsePolicyInput([{ field: 'buy_tax_bp', operator: '<=', value: 500 }], 'swap');
    expect(policy.intent).toBe('swap');
    expect(policy.dsl_version).toBe(DSL_VERSION);
    expect(policy.rules).toHaveLength(1);
  });

  it('still accepts the canonical object form', () => {
    const policy = parsePolicyInput(validPolicy(), 'ignored');
    // The policy's own intent wins over the fallback.
    expect(policy.intent).toBe('swap');
  });

  it('applies the fallback intent only to the shorthand form', () => {
    const policy = parsePolicyInput([{ field: 'a', operator: '==', value: 1 }], 'bridge');
    expect(policy.intent).toBe('bridge');
  });

  it('rejects an empty shorthand array', () => {
    expect(() => parsePolicyInput([], 'swap')).toThrow(PolicyValidationError);
  });

  it('names a bad operator inside the shorthand form too', () => {
    const issues = issuesOf(() =>
      parsePolicyInput([{ field: 'a', operator: '~=', value: 1 }], 's'),
    );
    expect(issues[0]?.path).toBe('rules.0.operator');
  });
});

describe('safeParsePolicy', () => {
  it('returns the policy on success without throwing', () => {
    const result = safeParsePolicy(validPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.intent).toBe('swap');
    }
  });

  it('returns issues on failure without throwing', () => {
    const result = safeParsePolicy({ intent: 'swap', rules: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('falls back to schema issues when rules is not an array', () => {
    // The operator-scanning shortcut must not crash on a malformed `rules`.
    const result = safeParsePolicy({ intent: 'swap', rules: 'not an array' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('skips non-object entries while scanning rules for bad operators', () => {
    const result = safeParsePolicy({
      intent: 'swap',
      rules: [null, 'a string', 42, { field: 'a', operator: 'bogus', value: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Only the real operator problem is reported, at its true index.
      expect(result.issues).toEqual([expect.objectContaining({ path: 'rules.3.operator' })]);
    }
  });

  it('falls back to schema issues for a non-object candidate', () => {
    const result = safeParsePolicy('not a policy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('reports unsupported operators through the same clear path', () => {
    const result = safeParsePolicy({
      intent: 'swap',
      rules: [{ field: 'a', operator: 'nope', value: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe('rules.0.operator');
    }
  });
});

describe('referencedFields', () => {
  it('lists each distinct field once, preserving first-seen order', () => {
    const policy = parsePolicy({
      intent: 'swap',
      rules: [
        { field: 'liquidity_usd', operator: '>', value: 1 },
        { field: 'buy_tax_bp', operator: '<', value: 1 },
        { field: 'liquidity_usd', operator: '<', value: 100 },
      ],
    });
    expect([...referencedFields(policy)]).toEqual(['liquidity_usd', 'buy_tax_bp']);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(referencedFields(parsePolicy(validPolicy())))).toBe(true);
  });
});
