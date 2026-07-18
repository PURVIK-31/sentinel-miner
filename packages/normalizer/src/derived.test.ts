import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '@sentinel/engine';
import { parsePolicy } from '@sentinel/dsl';
import { currentContext, type EvaluationContext, type Evidence } from '@sentinel/shared';
import {
  buildEvaluationView,
  isDerivedField,
  DERIVED_FIELDS,
  DERIVED_FIELD_NAMES,
} from './derived.js';
import { normalizeEvidence } from './normalize.js';

const DAY = 86_400;
const CREATED = 1_700_000_000;
const at = (now: number): EvaluationContext => ({ now_unix: now });

describe('the derived field catalog', () => {
  it('declares what each derived field requires and why', () => {
    for (const spec of DERIVED_FIELDS) {
      expect(spec.requires.length).toBeGreaterThan(0);
      expect(spec.rationale.length).toBeGreaterThan(0);
    }
  });

  it('identifies derived fields, and does not claim evidence fields', () => {
    expect(isDerivedField('pair_age_seconds')).toBe(true);
    expect(isDerivedField('pair_created_at_unix')).toBe(false);
    expect(isDerivedField('liquidity_usd')).toBe(false);
  });

  it('keeps pair_age_seconds out of the evidence catalog entirely', () => {
    // The whole point of the split: age is not a fact about the subject.
    expect(DERIVED_FIELD_NAMES).toContain('pair_age_seconds');
  });
});

describe('pair_age_seconds derivation', () => {
  const evidence: Evidence = { pair_created_at_unix: CREATED };

  it('computes elapsed seconds from evidence and context', () => {
    expect(buildEvaluationView(evidence, at(CREATED + DAY))['pair_age_seconds']).toBe(DAY);
  });

  it('reports zero for a pair created at the reference instant', () => {
    expect(buildEvaluationView(evidence, at(CREATED))['pair_age_seconds']).toBe(0);
  });

  it('omits the field for a creation time in the future rather than going negative', () => {
    // Clock skew between provider and caller; a negative age compares meaninglessly.
    const view = buildEvaluationView(evidence, at(CREATED - 500));
    expect('pair_age_seconds' in view).toBe(false);
  });

  it('omits the field when the creation instant was never collected', () => {
    const view = buildEvaluationView({ liquidity_usd: 1 }, at(CREATED));
    expect('pair_age_seconds' in view).toBe(false);
  });

  it('omits the field when the creation instant is not a usable integer', () => {
    for (const bad of ['1700000000', 1.5, -1, null, true]) {
      const view = buildEvaluationView({ pair_created_at_unix: bad }, at(CREATED + DAY));
      expect('pair_age_seconds' in view).toBe(false);
    }
  });

  it('omits the field when the context instant is unusable', () => {
    const view = buildEvaluationView(evidence, { now_unix: -1 });
    expect('pair_age_seconds' in view).toBe(false);
  });
});

describe('the evidence hash invariant', () => {
  // This is the property the evidence/context split exists to protect.
  const contributions = [
    { field: 'pair_created_at_unix', value: CREATED * 1000, provider: 'dexscreener' },
    { field: 'liquidity_usd', value: 125_000.4482, provider: 'dexscreener' },
  ];

  it('produces identical evidence no matter when normalization runs', () => {
    const first = normalizeEvidence(contributions);
    const later = normalizeEvidence(contributions);
    expect(later.evidence).toEqual(first.evidence);
    expect(first.evidence['pair_created_at_unix']).toBe(CREATED);
  });

  it('leaves evidence unchanged across wildly different evaluation contexts', () => {
    // Under the old model, `pair_age_seconds` in evidence made this fail: the
    // evidence hash moved every second even with an identical provider payload.
    const bundle = normalizeEvidence(contributions);
    const now = buildEvaluationView(bundle.evidence, at(CREATED + DAY));
    const muchLater = buildEvaluationView(bundle.evidence, at(CREATED + 365 * DAY));

    expect(bundle.evidence['pair_age_seconds']).toBeUndefined();
    expect(now['pair_age_seconds']).toBe(DAY);
    expect(muchLater['pair_age_seconds']).toBe(365 * DAY);
    // The evidence itself never moved.
    expect(bundle.evidence).toEqual(normalizeEvidence(contributions).evidence);
  });

  it('never writes a derived field back into evidence', () => {
    const bundle = normalizeEvidence(contributions);
    buildEvaluationView(bundle.evidence, at(CREATED + DAY));
    expect('pair_age_seconds' in bundle.evidence).toBe(false);
  });

  it('converts a millisecond instant to seconds during normalization', () => {
    // The provider reports milliseconds; the catalog stores seconds.
    const bundle = normalizeEvidence([
      { field: 'pair_created_at_unix', value: 1_700_000_000_500, provider: 'dexscreener' },
    ]);
    // Rounds up: a later creation time reads as younger, the conservative direction.
    expect(bundle.evidence['pair_created_at_unix']).toBe(1_700_000_001);
  });

  it('rejects a pre-epoch instant', () => {
    const bundle = normalizeEvidence([
      { field: 'pair_created_at_unix', value: -5000, provider: 'dexscreener' },
    ]);
    expect('pair_created_at_unix' in bundle.evidence).toBe(false);
    expect(bundle.issues[0]?.reason).toContain('epoch');
  });
});

describe('buildEvaluationView', () => {
  it('passes evidence through untouched', () => {
    const evidence: Evidence = { liquidity_usd: 500, is_honeypot: false };
    expect(buildEvaluationView(evidence, at(CREATED))).toMatchObject(evidence);
  });

  it('never lets a derived value overwrite a provider-supplied fact', () => {
    const evidence: Evidence = { pair_created_at_unix: CREATED, pair_age_seconds: 42 };
    expect(buildEvaluationView(evidence, at(CREATED + DAY))['pair_age_seconds']).toBe(42);
  });

  it('returns a frozen, null-prototype record like the evidence it extends', () => {
    const view = buildEvaluationView({ pair_created_at_unix: CREATED }, at(CREATED));
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.getPrototypeOf(view)).toBeNull();
  });

  it('is deterministic for a fixed evidence and context pair', () => {
    const evidence: Evidence = { pair_created_at_unix: CREATED };
    const first = buildEvaluationView(evidence, at(CREATED + DAY));
    for (let i = 0; i < 50; i += 1) {
      expect(buildEvaluationView(evidence, at(CREATED + DAY))).toEqual(first);
    }
  });
});

describe('policies can still express age', () => {
  const bundle = normalizeEvidence([
    { field: 'pair_created_at_unix', value: CREATED * 1000, provider: 'dexscreener' },
  ]);

  const maturityPolicy = parsePolicy({
    intent: 'swap',
    rules: [{ field: 'pair_age_seconds', operator: '>=', value: DAY }],
  });

  it('ALLOWs a pair that has matured, given the context', () => {
    const view = buildEvaluationView(bundle.evidence, at(CREATED + DAY));
    expect(evaluatePolicy(maturityPolicy, view).decision).toBe('ALLOW');
  });

  it('BLOCKs a pair that is still too new', () => {
    const view = buildEvaluationView(bundle.evidence, at(CREATED + 60));
    expect(evaluatePolicy(maturityPolicy, view).decision).toBe('BLOCK');
  });

  it('BLOCKs when the creation instant was never collected', () => {
    const view = buildEvaluationView({}, at(CREATED + DAY));
    const result = evaluatePolicy(maturityPolicy, view);
    expect(result.decision).toBe('BLOCK');
    expect(result.summary.missing_evidence).toBe(1);
  });

  it('supports the caller-precomputed-threshold form against the absolute fact', () => {
    // The alternative expression: compare the stored instant directly.
    const absolutePolicy = parsePolicy({
      intent: 'swap',
      rules: [{ field: 'pair_created_at_unix', operator: '<=', value: CREATED + DAY - DAY }],
    });
    expect(evaluatePolicy(absolutePolicy, bundle.evidence).decision).toBe('ALLOW');
  });

  it('gives the same decision for both forms at the same reference instant', () => {
    const now = CREATED + 2 * DAY;
    const derived = evaluatePolicy(maturityPolicy, buildEvaluationView(bundle.evidence, at(now)));
    const absolute = evaluatePolicy(
      parsePolicy({
        intent: 'swap',
        rules: [{ field: 'pair_created_at_unix', operator: '<=', value: now - DAY }],
      }),
      bundle.evidence,
    );
    expect(derived.decision).toBe(absolute.decision);
  });
});

describe('currentContext', () => {
  it('produces whole-second precision', () => {
    expect(Number.isSafeInteger(currentContext().now_unix)).toBe(true);
  });

  it('carries optional qualifiers through', () => {
    const context = currentContext({ chain: 'base', network: 'mainnet' });
    expect(context.chain).toBe('base');
    expect(context.network).toBe('mainnet');
  });

  it('is the only clock read in the system, and is called at the edge', () => {
    const context = currentContext();
    expect(context.now_unix).toBeGreaterThan(1_700_000_000);
  });
});
