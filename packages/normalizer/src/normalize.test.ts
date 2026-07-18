import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '@sentinel/engine';
import { parsePolicy } from '@sentinel/dsl';
import { normalizeEvidence, normalizeField, isDeterministicEvidence } from './normalize.js';
import { getFieldSpec, FIELD_CATALOG, NORMALIZATION_VERSION, isCatalogField } from './fields.js';
import type { FieldSpec } from './fields.js';
import type { FieldContribution } from './normalize.js';

/** Builds a contribution tersely. */
const give = (field: string, value: unknown, provider = 'goplus'): FieldContribution => ({
  field,
  value,
  provider,
});

/** Looks up a spec, failing loudly if the catalog changed underneath the test. */
const specFor = (field: string) => {
  const spec = getFieldSpec(field);
  if (spec === undefined) {
    throw new Error(`catalog is missing ${field}`);
  }
  return spec;
};

describe('the field catalog', () => {
  it('declares a rounding mode for every numeric field, and none for the rest', () => {
    // Widened to FieldSpec deliberately. `as const satisfies` makes the literal
    // catalog precise enough for TypeScript to prove this statically, which would
    // make the check vacuous; the runtime assertion is what guards future edits.
    const specs: readonly FieldSpec[] = FIELD_CATALOG;
    for (const spec of specs) {
      const numeric =
        spec.unit === 'basis_points' || spec.unit === 'whole_units' || spec.unit === 'count';
      expect(numeric ? spec.rounding !== undefined : spec.rounding === undefined).toBe(true);
    }
  });

  it('rounds every cost up and every resource down', () => {
    // The fail-closed invariant, asserted directly against the catalog.
    const costs = ['buy_tax_bp', 'sell_tax_bp', 'transfer_tax_bp'];
    const resources = [
      'liquidity_usd',
      'volume_24h_usd',
      'market_cap_usd',
      'holder_count',
      'pair_age_seconds',
    ];
    for (const field of costs) {
      expect(specFor(field).rounding).toBe('ceil');
    }
    for (const field of resources) {
      expect(specFor(field).rounding).toBe('floor');
    }
  });

  it('gives every field a rationale, so the direction is never unexplained', () => {
    for (const spec of FIELD_CATALOG) {
      expect(spec.rationale.length).toBeGreaterThan(0);
    }
  });

  it('declares no duplicate fields', () => {
    const fields = FIELD_CATALOG.map((spec) => spec.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('fail-closed rounding, end to end', () => {
  it('rounds a tax up so a borderline token is not allowed on a rounding artefact', () => {
    // 7.000001% is over a 700bp cap, and must be reported as 701bp.
    const bundle = normalizeEvidence([give('buy_tax_bp', '0.07000001')]);
    expect(bundle.evidence.buy_tax_bp).toBe(701);

    const policy = parsePolicy({
      intent: 'swap',
      rules: [{ field: 'buy_tax_bp', operator: '<=', value: 700 }],
    });
    expect(evaluatePolicy(policy, bundle.evidence).decision).toBe('BLOCK');
  });

  it('rounds liquidity down so a pool never clears a threshold it does not meet', () => {
    // $10,000.99 must not satisfy "> 10000" by being rounded to 10001.
    const bundle = normalizeEvidence([give('liquidity_usd', '10000.99', 'dexscreener')]);
    expect(bundle.evidence.liquidity_usd).toBe(10000);

    const policy = parsePolicy({
      intent: 'swap',
      rules: [{ field: 'liquidity_usd', operator: '>', value: 10000 }],
    });
    expect(evaluatePolicy(policy, bundle.evidence).decision).toBe('BLOCK');
  });

  it('does not distort a value that is already exact', () => {
    const bundle = normalizeEvidence([
      give('buy_tax_bp', '0.07'),
      give('liquidity_usd', '125000', 'dexscreener'),
    ]);
    expect(bundle.evidence.buy_tax_bp).toBe(700);
    expect(bundle.evidence.liquidity_usd).toBe(125000);
  });

  it('never lets a nonzero tax normalize to zero', () => {
    // A hundredth of a basis point is still a tax; ceil keeps it visible.
    expect(normalizeEvidence([give('buy_tax_bp', '0.0000001')]).evidence.buy_tax_bp).toBe(1);
  });

  it('keeps a zero tax at zero', () => {
    expect(normalizeEvidence([give('buy_tax_bp', '0')]).evidence.buy_tax_bp).toBe(0);
    expect(normalizeEvidence([give('buy_tax_bp', 0)]).evidence.buy_tax_bp).toBe(0);
  });
});

describe('normalizeField — units', () => {
  it('converts basis points from provider fraction strings', () => {
    expect(normalizeField(specFor('buy_tax_bp'), '0.025')).toEqual({ ok: true, value: 250 });
  });

  it('converts whole units, discarding cents', () => {
    expect(normalizeField(specFor('liquidity_usd'), 4200.99)).toEqual({ ok: true, value: 4200 });
  });

  it('accepts the GoPlus string booleans', () => {
    expect(normalizeField(specFor('is_honeypot'), '1')).toEqual({ ok: true, value: true });
    expect(normalizeField(specFor('is_honeypot'), '0')).toEqual({ ok: true, value: false });
  });

  it('accepts real booleans and numeric booleans', () => {
    expect(normalizeField(specFor('is_honeypot'), true)).toEqual({ ok: true, value: true });
    expect(normalizeField(specFor('is_honeypot'), 0)).toEqual({ ok: true, value: false });
    expect(normalizeField(specFor('is_honeypot'), 'false')).toEqual({ ok: true, value: false });
  });

  it('refuses to guess at an unrecognised risk flag', () => {
    // "maybe" must never become false on a honeypot check.
    const result = normalizeField(specFor('is_honeypot'), 'maybe');
    expect(result.ok).toBe(false);
  });

  it('trims identifiers but preserves their case', () => {
    expect(normalizeField(specFor('chain'), '  Base  ')).toEqual({ ok: true, value: 'Base' });
  });

  it('renders a numeric chain id without float notation', () => {
    expect(normalizeField(specFor('chain'), 8453)).toEqual({ ok: true, value: '8453' });
  });

  it('rejects an empty identifier rather than storing a blank', () => {
    expect(normalizeField(specFor('chain'), '   ').ok).toBe(false);
  });

  it.each([
    ['a float chain id', 1.5],
    ['a boolean', true],
    ['an object', { a: 1 }],
  ])('rejects %s for an identifier field', (_label, value) => {
    expect(normalizeField(specFor('chain'), value).ok).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(normalizeField(specFor('holder_count'), -5).ok).toBe(false);
  });

  it('treats null and undefined as absent, not as an error to invent a value for', () => {
    expect(normalizeField(specFor('buy_tax_bp'), null).ok).toBe(false);
    expect(normalizeField(specFor('buy_tax_bp'), undefined).ok).toBe(false);
  });

  it.each([
    ['an object', { a: 1 }],
    ['a list', [1, 2]],
    ['a boolean where a number belongs', true],
  ])('rejects %s for a numeric field', (_label, value) => {
    expect(normalizeField(specFor('liquidity_usd'), value).ok).toBe(false);
  });

  it('rejects an unparseable numeric string', () => {
    const result = normalizeField(specFor('liquidity_usd'), 'not a number');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('bundle assembly', () => {
  it('stamps the ruleset version so a proof can be re-derived', () => {
    expect(normalizeEvidence([]).normalization_version).toBe(NORMALIZATION_VERSION);
  });

  it('records which provider supplied each field', () => {
    const bundle = normalizeEvidence([
      give('buy_tax_bp', '0.02', 'goplus'),
      give('liquidity_usd', '50000', 'dexscreener'),
    ]);
    expect(bundle.sources).toEqual({ buy_tax_bp: 'goplus', liquidity_usd: 'dexscreener' });
  });

  it('preserves raw payloads verbatim for audit', () => {
    const payload = { buy_tax: '0.02', nested: { untouched: true }, extra: [1, 2] };
    const bundle = normalizeEvidence(
      [give('buy_tax_bp', '0.02')],
      [{ provider: 'goplus', payload }],
    );
    expect(bundle.raw).toEqual([{ provider: 'goplus', payload }]);
    // The raw payload is preserved as-is, including structure the engine cannot read.
    expect(bundle.raw[0]?.payload).toBe(payload);
  });

  it('keeps raw payloads out of the evidence the engine sees', () => {
    const bundle = normalizeEvidence(
      [give('buy_tax_bp', '0.02')],
      [{ provider: 'goplus', payload: { buy_tax: '0.02', secret_field: 'leaked' } }],
    );
    expect(Object.keys(bundle.evidence)).toEqual(['buy_tax_bp']);
    expect(Object.keys(bundle.evidence)).not.toContain('secret_field');
  });

  it('drops a field the catalog does not define, with a clear reason', () => {
    const bundle = normalizeEvidence([give('undocumented_field', 42)]);
    expect(bundle.evidence).toEqual({});
    expect(bundle.issues[0]).toMatchObject({ field: 'undocumented_field' });
    expect(bundle.issues[0]?.reason).toContain('does not define this field');
  });

  it('records an issue instead of throwing when a value is unusable', () => {
    const bundle = normalizeEvidence([
      give('buy_tax_bp', 'garbage'),
      give('liquidity_usd', '50000', 'dexscreener'),
    ]);
    // The good field still lands; only the bad one is dropped.
    expect(bundle.evidence.liquidity_usd).toBe(50000);
    expect('buy_tax_bp' in bundle.evidence).toBe(false);
    expect(bundle.issues).toHaveLength(1);
  });

  it('makes a dropped field read as absent, so the engine fails closed', () => {
    const bundle = normalizeEvidence([give('buy_tax_bp', 'garbage')]);
    const policy = parsePolicy({
      intent: 'swap',
      rules: [{ field: 'buy_tax_bp', operator: '<=', value: 500 }],
    });
    const result = evaluatePolicy(policy, bundle.evidence);
    expect(result.decision).toBe('BLOCK');
    expect(result.summary.missing_evidence).toBe(1);
  });
});

describe('provider precedence', () => {
  const conflicting = [
    give('buy_tax_bp', '0.09', 'dexscreener'),
    give('buy_tax_bp', '0.02', 'goplus'),
  ];

  it('resolves a conflict by precedence, not by argument order', () => {
    const bundle = normalizeEvidence(conflicting, [], ['goplus', 'dexscreener']);
    expect(bundle.evidence.buy_tax_bp).toBe(200);
    expect(bundle.sources.buy_tax_bp).toBe('goplus');
  });

  it('produces the same result when the contributions arrive in the other order', () => {
    // Evidence must not depend on which provider responded first.
    const forward = normalizeEvidence(conflicting, [], ['goplus', 'dexscreener']);
    const reversed = normalizeEvidence([...conflicting].reverse(), [], ['goplus', 'dexscreener']);
    expect(reversed.evidence).toEqual(forward.evidence);
    expect(reversed.sources).toEqual(forward.sources);
  });

  it('records the superseded contribution as an issue', () => {
    const bundle = normalizeEvidence(conflicting, [], ['goplus', 'dexscreener']);
    expect(bundle.issues[0]).toMatchObject({ field: 'buy_tax_bp', provider: 'dexscreener' });
    expect(bundle.issues[0]?.reason).toContain('superseded by goplus');
  });

  it('ranks unlisted providers after listed ones, stably', () => {
    const bundle = normalizeEvidence(
      [give('buy_tax_bp', '0.09', 'unknown'), give('buy_tax_bp', '0.02', 'goplus')],
      [],
      ['goplus'],
    );
    expect(bundle.evidence.buy_tax_bp).toBe(200);
  });

  it('falls back to input order when no precedence is configured', () => {
    const bundle = normalizeEvidence(conflicting);
    expect(bundle.sources.buy_tax_bp).toBe('dexscreener');
  });
});

describe('prototype pollution defence', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'drops the reserved field name %s',
    (field) => {
      const bundle = normalizeEvidence([give(field, { polluted: true })]);
      expect(bundle.issues[0]?.reason).toContain('reserved');
      expect('polluted' in {}).toBe(false);
    },
  );

  it('builds evidence on a null prototype', () => {
    const bundle = normalizeEvidence([give('buy_tax_bp', '0.02')]);
    expect(Object.getPrototypeOf(bundle.evidence)).toBeNull();
  });

  it('does not expose inherited keys as evidence', () => {
    const bundle = normalizeEvidence([give('buy_tax_bp', '0.02')]);
    expect('toString' in bundle.evidence).toBe(false);
  });
});

describe('determinism', () => {
  const contributions = [
    give('buy_tax_bp', '0.07000001', 'goplus'),
    give('liquidity_usd', '10000.99', 'dexscreener'),
    give('is_honeypot', '0', 'goplus'),
    give('chain', 'base', 'dexscreener'),
    give('holder_count', '1820.7', 'basescan'),
  ];

  it('produces identical evidence across repeated runs', () => {
    const first = normalizeEvidence(contributions, [], ['goplus', 'dexscreener', 'basescan']);
    for (let i = 0; i < 100; i += 1) {
      expect(normalizeEvidence(contributions, [], ['goplus', 'dexscreener', 'basescan'])).toEqual(
        first,
      );
    }
  });

  it('emits only values the engine can reason about', () => {
    const bundle = normalizeEvidence(contributions);
    expect(isDeterministicEvidence(bundle.evidence)).toBe(true);
  });

  it('emits integers for every numeric field, never floats', () => {
    const bundle = normalizeEvidence(contributions);
    for (const value of Object.values(bundle.evidence)) {
      if (typeof value === 'number') {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  it('returns a frozen bundle so evidence cannot drift after hashing', () => {
    const bundle = normalizeEvidence(contributions);
    expect(Object.isFrozen(bundle.evidence)).toBe(true);
    expect(Object.isFrozen(bundle.sources)).toBe(true);
    expect(Object.isFrozen(bundle.raw)).toBe(true);
  });

  it('normalizes an empty contribution set into empty evidence, not an error', () => {
    const bundle = normalizeEvidence([]);
    expect(bundle.evidence).toEqual({});
    expect(bundle.issues).toEqual([]);
  });
});

describe('isCatalogField', () => {
  it('accepts catalog fields and rejects everything else', () => {
    expect(isCatalogField('buy_tax_bp')).toBe(true);
    expect(isCatalogField('made_up')).toBe(false);
    expect(isCatalogField('toString')).toBe(false);
  });
});

describe('isDeterministicEvidence', () => {
  it('rejects evidence carrying a float', () => {
    expect(isDeterministicEvidence({ liquidity_usd: 4200.5 })).toBe(false);
  });

  it('accepts integer, boolean, string, null, and list values', () => {
    expect(isDeterministicEvidence({ a: 1, b: true, c: 'x', d: null, e: ['f'] })).toBe(true);
  });
});
