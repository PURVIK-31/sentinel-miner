/**
 * Derived fields: values computed from evidence plus evaluation context.
 *
 * A derived field is one that cannot be stated as a fact about the subject
 * alone. `pair_age_seconds` is the motivating case — it is a fact about a pair
 * *and a moment*, so it belongs neither in evidence (which would make the
 * evidence hash change every second) nor in the provider layer (which would make
 * extraction read a clock).
 *
 * ## Where derived values sit in the model
 *
 * ```
 * evidence        (stable, hashed)
 *    +
 * context         (variable, hashed separately)
 *    ↓
 * derived fields  (recomputed, never hashed as evidence)
 *    ↓
 * evaluation view (what rules are evaluated against)
 * ```
 *
 * Derived values are deliberately **not** part of the evidence hash. They carry
 * no new information: anyone holding the evidence and the context can recompute
 * them exactly. Hashing them would add nothing to verify while reintroducing the
 * time-dependence the split exists to remove.
 *
 * The engine never learns which fields are derived. It evaluates rules against
 * the merged view, so it stays domain-agnostic and clock-free.
 */

import { isValidInstant, type Evidence, type EvaluationContext } from '@sentinel/shared';

/** Declares a field computed from evidence and context rather than supplied. */
export interface DerivedFieldSpec {
  /** The field name as policies address it. */
  readonly field: string;
  /** Evidence fields this derivation reads. */
  readonly requires: readonly string[];
  /** What the field means, and how it is computed. */
  readonly rationale: string;
  /**
   * Computes the value, or returns `undefined` when it cannot be derived.
   *
   * Returning `undefined` leaves the field absent, so the engine fails closed on
   * any rule that needed it — the same behaviour as evidence no provider supplied.
   */
  compute(evidence: Evidence, context: EvaluationContext): number | undefined;
}

/**
 * Elapsed seconds since a pair was created.
 *
 * Computed rather than stored, because age changes continuously while the
 * provider payload does not. Floors the result, matching the fail-closed
 * direction for a minimum-maturity rule: a pair never looks older, and therefore
 * safer, than it is.
 *
 * A creation time in the future yields `undefined` rather than a negative age.
 * That happens with clock skew between the provider and the caller's reference
 * instant, and a negative "age" would be meaningless to compare against.
 */
const pairAgeSeconds: DerivedFieldSpec = {
  field: 'pair_age_seconds',
  requires: ['pair_created_at_unix'],
  rationale:
    'Elapsed seconds since pair creation, computed from pair_created_at_unix and the evaluation context. Not stored as evidence because age is a fact about a pair and a moment, not about a pair.',
  compute(evidence, context) {
    const createdAt = evidence.pair_created_at_unix;
    if (!isValidInstant(createdAt) || !isValidInstant(context.now_unix)) {
      return undefined;
    }
    const age = context.now_unix - createdAt;
    return age < 0 ? undefined : age;
  },
};

/** Every derived field, in declaration order. */
export const DERIVED_FIELDS: readonly DerivedFieldSpec[] = Object.freeze([pairAgeSeconds]);

/** Names of every derived field. */
export const DERIVED_FIELD_NAMES: readonly string[] = Object.freeze(
  DERIVED_FIELDS.map((spec) => spec.field),
);

/** True when a field is derived rather than supplied by a provider. */
export function isDerivedField(field: string): boolean {
  return DERIVED_FIELD_NAMES.includes(field);
}

/**
 * Builds the field space rules are evaluated against.
 *
 * Merges stable evidence with the fields derived from it and the context.
 * Evidence always wins a name collision: a provider-supplied fact is never
 * silently overwritten by a computed one.
 *
 * The returned record has a null prototype and is frozen, matching the evidence
 * it extends, so nothing downstream can mutate the view mid-evaluation.
 */
export function buildEvaluationView(evidence: Evidence, context: EvaluationContext): Evidence {
  const view = Object.assign(Object.create(null) as Record<string, unknown>, evidence);

  for (const spec of DERIVED_FIELDS) {
    if (Object.hasOwn(view, spec.field)) {
      continue;
    }
    const value = spec.compute(evidence, context);
    if (value !== undefined) {
      view[spec.field] = value;
    }
  }

  return Object.freeze(view);
}
