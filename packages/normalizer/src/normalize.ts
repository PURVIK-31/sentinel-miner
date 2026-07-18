/**
 * Provider payloads in, deterministic integer evidence out.
 *
 * The output bundle keeps two things strictly apart:
 *
 * - `evidence` — the only thing the policy engine ever sees. Integers, booleans,
 *   and opaque strings; no floats, no nested objects, no provider vocabulary.
 * - `raw` — the untouched provider payloads, preserved for audit and debugging
 *   and hashed into the proof, but never read during evaluation.
 *
 * Keeping them separate is what makes a decision both reproducible and
 * explainable: the evidence explains what was decided, the raw payload explains
 * where it came from.
 *
 * Normalization never throws on a bad field. A value that cannot be normalized
 * is omitted and an issue is recorded, so the field reads as absent to the
 * engine — which fails closed to BLOCK rather than substituting a guess.
 */

import {
  isEvidenceValue,
  isSafeFieldName,
  type Evidence,
  type EvidenceValue,
} from '@sentinel/shared';
import { toScaledInteger } from './decimal.js';
import { getFieldSpec, NORMALIZATION_VERSION, type FieldSpec } from './fields.js';

/** A raw provider response, preserved verbatim for audit. */
export interface ProviderSnapshot {
  /** Stable provider identifier, e.g. `goplus`. */
  readonly provider: string;
  /** The response exactly as received. Never read during evaluation. */
  readonly payload: unknown;
}

/** One provider's claim about one catalog field, before normalization. */
export interface FieldContribution {
  /** The catalog field this value is claimed to be. */
  readonly field: string;
  /** The raw value, in whatever form the provider supplied it. */
  readonly value: unknown;
  /** Which provider supplied it. */
  readonly provider: string;
}

/** Why a contribution did not make it into evidence. */
export interface NormalizationIssue {
  readonly field: string;
  readonly provider: string;
  readonly reason: string;
}

/**
 * A claim that lost to a higher-precedence provider.
 *
 * Kept separate from {@link NormalizationIssue} on purpose. Supersession is the
 * system working as designed — two providers both knew the answer and the more
 * authoritative one won. Filing it under `issues` would bury genuine problems
 * (a malformed value, an unknown field) in routine noise, and an operator
 * checking whether collection went well needs those to be distinguishable.
 */
export interface SupersededClaim {
  readonly field: string;
  /** The provider whose claim was not used. */
  readonly provider: string;
  /** The higher-precedence provider whose claim was used instead. */
  readonly winner: string;
}

/** The result of normalizing a set of provider responses. */
export interface NormalizedBundle {
  /** Ruleset version that produced this evidence. Carried into the proof. */
  readonly normalization_version: string;
  /** Deterministic integer evidence. The engine's sole input. */
  readonly evidence: Evidence;
  /** Which provider supplied each accepted field. */
  readonly sources: Readonly<Record<string, string>>;
  /** Untouched provider payloads, for audit only. */
  readonly raw: readonly ProviderSnapshot[];
  /** Contributions that could not be used, with the reason for each. */
  readonly issues: readonly NormalizationIssue[];
  /** Claims that lost to a higher-precedence provider. Routine, not a problem. */
  readonly superseded: readonly SupersededClaim[];
}

/**
 * Interprets a provider's boolean.
 *
 * Providers are inconsistent here — GoPlus reports flags as the strings `"1"`
 * and `"0"`, others send real booleans or numbers. Only these exact forms are
 * accepted; anything else is an issue rather than a guess, because guessing on a
 * risk flag is precisely the failure this system exists to prevent.
 */
function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 1 || value === '1' || value === 'true') {
    return true;
  }
  if (value === 0 || value === '0' || value === 'false') {
    return false;
  }
  return undefined;
}

/** Interprets a provider's opaque identifier. */
function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  // A numeric chain id is legitimate; render it exactly, without float notation.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}

/** The outcome of normalizing one contribution. */
type FieldResult = { ok: true; value: EvidenceValue } | { ok: false; reason: string };

/** Normalizes one raw value according to its field spec. */
export function normalizeField(spec: FieldSpec, value: unknown): FieldResult {
  // A provider that has no answer says so with null or undefined. That is not an
  // error; the field is simply absent, and the engine will fail closed on it.
  if (value === null || value === undefined) {
    return { ok: false, reason: 'the provider supplied no value' };
  }

  switch (spec.unit) {
    case 'boolean': {
      const result = normalizeBoolean(value);
      return result === undefined
        ? { ok: false, reason: `expected a boolean, received ${describe(value)}` }
        : { ok: true, value: result };
    }
    case 'identifier': {
      const result = normalizeIdentifier(value);
      return result === undefined
        ? { ok: false, reason: `expected a non-empty identifier, received ${describe(value)}` }
        : { ok: true, value: result };
    }
    case 'basis_points':
    case 'whole_units':
    case 'count':
    case 'unix_seconds': {
      if (typeof value !== 'string' && typeof value !== 'number') {
        return { ok: false, reason: `expected a number, received ${describe(value)}` };
      }
      // Every numeric spec declares a rounding mode; the catalog's type enforces it.
      const rounding = spec.rounding ?? 'floor';
      const scale = spec.scale ?? DEFAULT_SCALE[spec.unit];
      try {
        const converted = toScaledInteger(value, scale, rounding);
        if ((spec.unit === 'count' || spec.unit === 'unix_seconds') && converted < 0) {
          return {
            ok: false,
            reason:
              spec.unit === 'count'
                ? 'a count cannot be negative'
                : 'a timestamp before the Unix epoch is not plausible',
          };
        }
        return { ok: true, value: converted };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'the value could not be converted',
        };
      }
    }
  }
}

/** The units that carry a numeric value and therefore a scale. */
type NumericUnit = 'basis_points' | 'whole_units' | 'count' | 'unix_seconds';

/**
 * Default power of ten per unit, when a field declares no explicit scale.
 *
 * `basis_points` multiplies a fraction by 10^4. The rest are already whole
 * units, so a field only needs an explicit `scale` when the provider reports in
 * sub-units — as DexScreener does with millisecond timestamps.
 */
const DEFAULT_SCALE: Readonly<Record<NumericUnit, number>> = Object.freeze({
  basis_points: 4,
  whole_units: 0,
  count: 0,
  unix_seconds: 0,
});

/** Describes an unusable value for an issue message, without leaking its content. */
function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (typeof value === 'object') {
    return 'an object';
  }
  return `a ${typeof value}`;
}

/**
 * Normalizes provider contributions into a deterministic evidence bundle.
 *
 * When two providers claim the same field, the first contribution in
 * `precedence` order wins and the later one is recorded in `superseded`. Precedence
 * is explicit rather than "last writer wins" so the result cannot depend on the
 * order provider requests happened to resolve in — that would make evidence, and
 * therefore proofs, non-reproducible.
 *
 * @param contributions Field claims from every provider that answered.
 * @param snapshots     Raw payloads, preserved verbatim in the bundle.
 * @param precedence    Provider ids, most trusted first. Providers not listed
 *                      rank after all listed ones, in a stable order.
 */
export function normalizeEvidence(
  contributions: readonly FieldContribution[],
  snapshots: readonly ProviderSnapshot[] = [],
  precedence: readonly string[] = [],
): NormalizedBundle {
  const rank = (provider: string): number => {
    const index = precedence.indexOf(provider);
    return index === -1 ? precedence.length : index;
  };

  // Sort by provider precedence, keeping original order within a rank so the
  // result is a pure function of the inputs.
  const ordered = contributions
    .map((contribution, index) => ({ contribution, index }))
    .sort((a, b) => {
      const byRank = rank(a.contribution.provider) - rank(b.contribution.provider);
      return byRank === 0 ? a.index - b.index : byRank;
    })
    .map((entry) => entry.contribution);

  // Null-prototype accumulator: nothing written here can reach Object.prototype,
  // whatever a provider puts in a field name.
  const evidence = Object.create(null) as Record<string, EvidenceValue>;
  const sources = Object.create(null) as Record<string, string>;
  const issues: NormalizationIssue[] = [];
  const superseded: SupersededClaim[] = [];

  for (const contribution of ordered) {
    const { field, provider, value } = contribution;

    if (!isSafeFieldName(field)) {
      issues.push({ field, provider, reason: 'the field name is reserved' });
      continue;
    }

    const spec = getFieldSpec(field);
    if (spec === undefined) {
      issues.push({
        field,
        provider,
        reason: `the normalization catalog (v${NORMALIZATION_VERSION}) does not define this field`,
      });
      continue;
    }

    if (Object.hasOwn(evidence, field)) {
      superseded.push({ field, provider, winner: sources[field] ?? 'unknown' });
      continue;
    }

    const result = normalizeField(spec, value);
    if (!result.ok) {
      issues.push({ field, provider, reason: result.reason });
      continue;
    }

    evidence[field] = result.value;
    sources[field] = provider;
  }

  return {
    normalization_version: NORMALIZATION_VERSION,
    evidence: Object.freeze(evidence),
    sources: Object.freeze(sources),
    raw: Object.freeze([...snapshots]),
    issues: Object.freeze(issues),
    superseded: Object.freeze(superseded),
  };
}

/**
 * Asserts that evidence contains only values the engine can reason about.
 *
 * The type system already says this, but evidence crosses a trust boundary —
 * it is assembled from parsed JSON — and a single float slipping through would
 * silently break determinism rather than fail visibly. Cheap to check, and it
 * turns a subtle class of bug into an immediate one.
 */
export function isDeterministicEvidence(evidence: Evidence): boolean {
  return Object.values(evidence).every(isEvidenceValue);
}
