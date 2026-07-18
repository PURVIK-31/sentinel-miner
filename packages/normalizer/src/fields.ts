/**
 * The versioned normalization ruleset.
 *
 * This catalog is the authoritative statement of what an evidence field *means*:
 * its unit, its type, and — for numeric fields — which direction it rounds when
 * precision must be discarded.
 *
 * Every rounding direction here is chosen to **fail closed**: when the exact
 * value is unavailable, the normalized value must be the one that makes the
 * policy harder to satisfy, never easier. Costs and risks round up; resources and
 * safety margins round down. The consequence is that a decision may occasionally
 * be more conservative than reality by one unit, which is the correct direction
 * for a security control to be wrong in.
 *
 * The ruleset is versioned because changing any rounding direction changes
 * decisions and therefore proof hashes. A stored proof is only reproducible
 * against the ruleset version that produced it. See
 * docs/adr/0003-fail-closed-normalization.md.
 */

import type { RoundingMode } from './decimal.js';

/**
 * The normalization ruleset version.
 *
 * Bump this whenever a field's unit, type, or rounding direction changes, or
 * when a field is added or removed. It is carried in the proof so an archived
 * decision can be re-derived exactly.
 */
export const NORMALIZATION_VERSION = '1.1';

/** How a normalized field is represented in evidence. */
export type FieldUnit =
  /** An integer rate in hundredths of a percent. 250 is 2.50%. */
  | 'basis_points'
  /** An integer count of whole currency units. No sub-unit precision. */
  | 'whole_units'
  /** A non-negative integer tally. */
  | 'count'
  /**
   * An absolute instant, as whole seconds since the Unix epoch.
   *
   * Deliberately an absolute fact rather than an elapsed duration. "Age right
   * now" changes continuously while the provider payload does not, so deriving
   * it here would make the evidence hash depend on wall-clock time. Age is
   * computed at evaluation time from this field plus the evaluation context.
   * See docs/adr/0004-evidence-versus-context.md.
   */
  | 'unix_seconds'
  /** A boolean flag. */
  | 'boolean'
  /** An opaque string, compared only by equality or set membership. */
  | 'identifier';

/** The declaration for one normalized evidence field. */
export interface FieldSpec {
  /** The field name as policies address it. */
  readonly field: string;
  /** How the value is represented. */
  readonly unit: FieldUnit;
  /**
   * Rounding direction for numeric units. Absent for `boolean` and
   * `identifier`, which discard no precision.
   */
  readonly rounding?: RoundingMode;
  /**
   * Power of ten applied to the provider's value, when it differs from the
   * unit's default. Negative divides: `-3` converts the milliseconds
   * DexScreener reports into the seconds this catalog stores.
   *
   * Declaring it here keeps unit conversion in the normalizer rather than
   * leaking it into provider adapters.
   */
  readonly scale?: number;
  /** Why this direction is the fail-closed one. Surfaced in the docs and API. */
  readonly rationale: string;
}

/**
 * The field catalog for normalization v1.0.
 *
 * Only fields listed here can enter evidence. An unrecognised field from a
 * provider is dropped with a recorded issue rather than passed through — an
 * unnormalized field could carry a float, and a policy referencing a field the
 * catalog does not define is almost certainly a typo that should fail loudly.
 */
export const FIELD_CATALOG = [
  {
    field: 'buy_tax_bp',
    unit: 'basis_points',
    rounding: 'ceil',
    rationale:
      'A tax is a cost. Rounding up can only overstate what a swap costs, so a borderline token is blocked rather than allowed on a rounding artefact.',
  },
  {
    field: 'sell_tax_bp',
    unit: 'basis_points',
    rounding: 'ceil',
    rationale:
      'Sell tax is a cost, and an understated exit cost is how a position becomes hard to leave. Rounds up for the same reason as buy tax.',
  },
  {
    field: 'transfer_tax_bp',
    unit: 'basis_points',
    rounding: 'ceil',
    rationale: 'A cost, rounded up so it is never understated.',
  },
  {
    field: 'liquidity_usd',
    unit: 'whole_units',
    rounding: 'floor',
    rationale:
      'Liquidity is a resource a policy requires a minimum of. Rounding down can only understate it, so a pool never clears a threshold it does not genuinely meet.',
  },
  {
    field: 'volume_24h_usd',
    unit: 'whole_units',
    rounding: 'floor',
    rationale: 'A resource used as a minimum threshold, so it rounds down.',
  },
  {
    field: 'market_cap_usd',
    unit: 'whole_units',
    rounding: 'floor',
    rationale: 'A resource used as a minimum threshold, so it rounds down.',
  },
  {
    field: 'holder_count',
    unit: 'count',
    rounding: 'floor',
    rationale:
      'A distribution signal used as a minimum. Rounding down never invents holders that do not exist.',
  },
  {
    field: 'pair_created_at_unix',
    unit: 'unix_seconds',
    rounding: 'ceil',
    // DexScreener reports pair creation in milliseconds.
    scale: -3,
    rationale:
      'An absolute instant, not an elapsed duration, so the evidence hash does not change as time passes. Rounds up (later) because a later creation time makes a pair look younger, which is the conservative reading for any minimum-maturity rule.',
  },
  {
    field: 'is_honeypot',
    unit: 'boolean',
    rationale: 'A risk flag. Never inferred or defaulted; absent when unknown.',
  },
  {
    field: 'contract_verified',
    unit: 'boolean',
    rationale: 'A safety attribute. Never defaulted to true when unknown.',
  },
  {
    field: 'is_mintable',
    unit: 'boolean',
    rationale: 'A risk flag. Absent when unknown rather than assumed false.',
  },
  {
    field: 'is_proxy',
    unit: 'boolean',
    rationale: 'A risk flag. Absent when unknown rather than assumed false.',
  },
  {
    field: 'can_take_back_ownership',
    unit: 'boolean',
    rationale: 'A risk flag. Absent when unknown rather than assumed false.',
  },
  {
    field: 'chain',
    unit: 'identifier',
    rationale: 'An opaque identifier, compared only by equality or membership.',
  },
  {
    field: 'token_symbol',
    unit: 'identifier',
    rationale: 'An opaque identifier, compared only by equality or membership.',
  },
  {
    field: 'owner_address',
    unit: 'identifier',
    rationale: 'An opaque identifier, compared only by equality or membership.',
  },
] as const satisfies readonly FieldSpec[];

/** Every field name the catalog defines. */
export type CatalogField = (typeof FIELD_CATALOG)[number]['field'];

/** Lookup from field name to its specification. */
const SPEC_BY_FIELD: ReadonlyMap<string, FieldSpec> = new Map(
  FIELD_CATALOG.map((spec) => [spec.field, spec]),
);

/** Returns the spec for a field, or `undefined` if the catalog does not define it. */
export function getFieldSpec(field: string): FieldSpec | undefined {
  return SPEC_BY_FIELD.get(field);
}

/** True when the catalog defines this field. */
export function isCatalogField(field: string): field is CatalogField {
  return SPEC_BY_FIELD.has(field);
}

/** Every field name the catalog defines, in declaration order. */
export const CATALOG_FIELDS: readonly string[] = Object.freeze(
  FIELD_CATALOG.map((spec) => spec.field),
);
