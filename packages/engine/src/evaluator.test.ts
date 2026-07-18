import { describe, it, expect } from 'vitest';
import { parsePolicy } from '@sentinel/dsl';
import type { Evidence } from '@sentinel/shared';
import { evaluatePolicy, failedRules, decisionReason } from './evaluator.js';

/** Evidence for a token that is safe under a permissive policy. */
const evidence: Evidence = Object.freeze({
  buy_tax_bp: 250,
  sell_tax_bp: 400,
  liquidity_usd: 125000,
  is_honeypot: false,
  contract_verified: true,
  chain: 'base',
  holder_count: 1820,
});

const policy = (rules: unknown): ReturnType<typeof parsePolicy> =>
  parsePolicy({ intent: 'swap', rules });

describe('decision rule', () => {
  it('ALLOWs only when every rule passes', () => {
    const result = evaluatePolicy(
      policy([
        { field: 'buy_tax_bp', operator: '<=', value: 500 },
        { field: 'liquidity_usd', operator: '>', value: 10000 },
        { field: 'is_honeypot', operator: '==', value: false },
      ]),
      evidence,
    );
    expect(result.decision).toBe('ALLOW');
    expect(result.summary).toEqual({
      total: 3,
      passed: 3,
      failed: 0,
      missing_evidence: 0,
      type_mismatch: 0,
    });
  });

  it('BLOCKs when a single rule fails, however many pass', () => {
    const result = evaluatePolicy(
      policy([
        { field: 'buy_tax_bp', operator: '<=', value: 500 },
        { field: 'liquidity_usd', operator: '>', value: 10000 },
        { field: 'sell_tax_bp', operator: '<=', value: 100 },
      ]),
      evidence,
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.summary.passed).toBe(2);
    expect(result.summary.failed).toBe(1);
  });

  it('BLOCKs when required evidence is missing, rather than skipping the rule', () => {
    // Fail-closed: an unanswerable rule must never be treated as satisfied.
    const result = evaluatePolicy(
      policy([{ field: 'never_collected', operator: '<', value: 10 }]),
      evidence,
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.summary.missing_evidence).toBe(1);
    expect(result.missing_fields).toEqual(['never_collected']);
  });

  it('BLOCKs on a type mismatch rather than throwing', () => {
    const result = evaluatePolicy(policy([{ field: 'chain', operator: '<', value: 10 }]), evidence);
    expect(result.decision).toBe('BLOCK');
    expect(result.summary.type_mismatch).toBe(1);
  });

  it('BLOCKs when a negated rule cannot be evaluated', () => {
    // The classic footgun: `!=` on a missing field must not vacuously pass.
    const result = evaluatePolicy(
      policy([{ field: 'absent', operator: '!=', value: 'bad' }]),
      evidence,
    );
    expect(result.decision).toBe('BLOCK');
  });
});

describe('rule breakdown', () => {
  it('preserves policy order so output is stable across runs', () => {
    const result = evaluatePolicy(
      policy([
        { field: 'liquidity_usd', operator: '>', value: 10000 },
        { field: 'buy_tax_bp', operator: '<=', value: 500 },
        { field: 'is_honeypot', operator: '==', value: false },
      ]),
      evidence,
    );
    expect(result.rules.map((rule) => rule.field)).toEqual([
      'liquidity_usd',
      'buy_tax_bp',
      'is_honeypot',
    ]);
  });

  it('reports expected and actual for each rule', () => {
    const result = evaluatePolicy(
      policy([{ field: 'buy_tax_bp', operator: '<=', value: 500 }]),
      evidence,
    );
    expect(result.rules[0]).toMatchObject({
      field: 'buy_tax_bp',
      operator: '<=',
      expected: 500,
      actual: 250,
      passed: true,
      outcome: 'PASS',
    });
  });

  it('omits `actual` entirely when the field was absent', () => {
    const result = evaluatePolicy(
      policy([{ field: 'absent', operator: '==', value: 1 }]),
      evidence,
    );
    expect('actual' in result.rules[0]!).toBe(false);
  });

  it('includes `actual` as null when the field is present and null', () => {
    // Distinguishing these two is what makes `exists` meaningful.
    const result = evaluatePolicy(policy([{ field: 'owner', operator: '==', value: null }]), {
      owner: null,
    });
    expect(result.rules[0]?.actual).toBeNull();
    expect(result.rules[0]?.passed).toBe(true);
  });

  it("carries through the policy author's rule description", () => {
    const result = evaluatePolicy(
      policy([{ field: 'buy_tax_bp', operator: '<=', value: 500, description: 'Cap entry cost.' }]),
      evidence,
    );
    expect(result.rules[0]?.description).toBe('Cap entry cost.');
  });

  it('omits description when the rule had none', () => {
    const result = evaluatePolicy(
      policy([{ field: 'buy_tax_bp', operator: '<=', value: 500 }]),
      evidence,
    );
    expect('description' in result.rules[0]!).toBe(false);
  });

  it('gives every rule a non-empty explanation, passing or failing', () => {
    const result = evaluatePolicy(
      policy([
        { field: 'buy_tax_bp', operator: '<=', value: 500 },
        { field: 'sell_tax_bp', operator: '<=', value: 100 },
      ]),
      evidence,
    );
    for (const rule of result.rules) {
      expect(rule.explanation.length).toBeGreaterThan(0);
    }
  });

  it('deduplicates repeated missing fields', () => {
    const result = evaluatePolicy(
      policy([
        { field: 'absent', operator: '>', value: 1 },
        { field: 'absent', operator: '<', value: 9 },
      ]),
      evidence,
    );
    expect(result.missing_fields).toEqual(['absent']);
    expect(result.summary.missing_evidence).toBe(2);
  });
});

describe('prototype safety', () => {
  it('does not resolve inherited properties as evidence', () => {
    const result = evaluatePolicy(
      policy([{ field: 'hasOwnProperty', operator: 'exists', value: false }]),
      evidence,
    );
    // `hasOwnProperty` exists on the prototype but is not evidence.
    expect(result.decision).toBe('ALLOW');
  });

  it('evaluates correctly against null-prototype evidence', () => {
    const bare = Object.assign(Object.create(null) as Evidence, { buy_tax_bp: 100 });
    const result = evaluatePolicy(
      policy([{ field: 'buy_tax_bp', operator: '<', value: 500 }]),
      bare,
    );
    expect(result.decision).toBe('ALLOW');
  });
});

describe('determinism', () => {
  const complexPolicy = policy([
    { field: 'buy_tax_bp', operator: '<=', value: 500 },
    { field: 'chain', operator: 'in', value: ['base', 'ethereum'] },
    { field: 'contract_verified', operator: 'exists', value: true },
    { field: 'absent_field', operator: '>', value: 1 },
  ]);

  it('produces an identical result across many repetitions', () => {
    const first = evaluatePolicy(complexPolicy, evidence);
    for (let i = 0; i < 200; i += 1) {
      expect(evaluatePolicy(complexPolicy, evidence)).toEqual(first);
    }
  });

  it('does not mutate the policy or the evidence', () => {
    const evidenceCopy = { ...evidence };
    evaluatePolicy(complexPolicy, evidence);
    expect(evidence).toEqual(evidenceCopy);
    expect(complexPolicy.rules).toHaveLength(4);
  });

  it('ignores evidence key insertion order', () => {
    const reordered: Evidence = {
      holder_count: 1820,
      chain: 'base',
      contract_verified: true,
      is_honeypot: false,
      liquidity_usd: 125000,
      sell_tax_bp: 400,
      buy_tax_bp: 250,
    };
    expect(evaluatePolicy(complexPolicy, reordered)).toEqual(
      evaluatePolicy(complexPolicy, evidence),
    );
  });
});

describe('the specification demo scenario', () => {
  // Two agents, identical evidence, opposite decisions — explained entirely by policy.
  const shared: Evidence = {
    buy_tax_bp: 250,
    sell_tax_bp: 400,
    liquidity_usd: 4200,
    is_honeypot: false,
  };

  const strictTreasury = policy([
    { field: 'buy_tax_bp', operator: '<=', value: 100 },
    { field: 'liquidity_usd', operator: '>', value: 100000 },
    { field: 'is_honeypot', operator: '==', value: false },
  ]);

  const highRisk = policy([
    { field: 'buy_tax_bp', operator: '<=', value: 2000 },
    { field: 'liquidity_usd', operator: '>', value: 1000 },
    { field: 'is_honeypot', operator: '==', value: false },
  ]);

  it('BLOCKs under the strict treasury policy', () => {
    expect(evaluatePolicy(strictTreasury, shared).decision).toBe('BLOCK');
  });

  it('ALLOWs the same evidence under the high risk policy', () => {
    expect(evaluatePolicy(highRisk, shared).decision).toBe('ALLOW');
  });

  it('attributes the difference to specific rules, not to judgement', () => {
    const failures = failedRules(evaluatePolicy(strictTreasury, shared));
    expect(failures.map((rule) => rule.field)).toEqual(['buy_tax_bp', 'liquidity_usd']);
  });
});

describe('failedRules', () => {
  it('returns an empty list when everything passed', () => {
    const result = evaluatePolicy(
      policy([{ field: 'buy_tax_bp', operator: '<', value: 999 }]),
      evidence,
    );
    expect(failedRules(result)).toEqual([]);
  });

  it('returns failures in policy order', () => {
    const result = evaluatePolicy(
      policy([
        { field: 'buy_tax_bp', operator: '>', value: 9999 },
        { field: 'liquidity_usd', operator: '>', value: 1 },
        { field: 'sell_tax_bp', operator: '>', value: 9999 },
      ]),
      evidence,
    );
    expect(failedRules(result).map((rule) => rule.field)).toEqual(['buy_tax_bp', 'sell_tax_bp']);
  });
});

describe('decisionReason', () => {
  it('summarises an allow', () => {
    const result = evaluatePolicy(
      policy([{ field: 'buy_tax_bp', operator: '<', value: 999 }]),
      evidence,
    );
    expect(decisionReason(result)).toBe('ALLOW: all 1 rules passed.');
  });

  it('uses the singular when exactly one rule failed', () => {
    const result = evaluatePolicy(
      policy([{ field: 'buy_tax_bp', operator: '>', value: 999 }]),
      evidence,
    );
    expect(decisionReason(result)).toContain('1 of 1 rule failed');
  });

  it('uses the plural for multiple failures and includes each explanation', () => {
    const result = evaluatePolicy(
      policy([
        { field: 'buy_tax_bp', operator: '>', value: 999 },
        { field: 'sell_tax_bp', operator: '>', value: 999 },
      ]),
      evidence,
    );
    const reason = decisionReason(result);
    expect(reason).toContain('2 of 2 rules failed');
    expect(reason).toContain('buy_tax_bp');
    expect(reason).toContain('sell_tax_bp');
  });
});
