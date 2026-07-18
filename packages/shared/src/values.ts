/**
 * The value domain that flows through the deterministic engine.
 *
 * Determinism constraints that the whole system depends on:
 *
 * - Every numeric value is an **integer**. Taxes are basis points, money is whole
 *   units. Floating point is rejected at the normalizer boundary so the engine can
 *   compare numbers without worrying about `0.1 + 0.2 !== 0.3` or platform-specific
 *   rounding. See {@link isDeterministicNumber}.
 * - Values are JSON primitives or flat arrays of primitives. No nested objects, no
 *   dates, no class instances — anything with a non-canonical serialization would
 *   destabilise the proof hashes.
 * - `undefined` is never a value. A field is either present with a value (possibly
 *   `null`) or absent from the record entirely. That distinction is what the
 *   `exists` operator tests, so it must be preserved exactly.
 */

/** A single comparable primitive. */
export type Scalar = string | number | boolean;

/**
 * A value as it appears in normalized evidence.
 *
 * `null` models "the provider answered, and the answer is empty". An absent key
 * models "no provider supplied this field at all". They are not interchangeable.
 */
export type EvidenceValue = Scalar | null | readonly Scalar[];

/**
 * Normalized evidence: a flat, readonly map of field name to value.
 *
 * Flatness is deliberate. A flat namespace keeps the DSL's `field` addressing
 * trivial (no path parsing, no traversal into prototypes) and keeps canonical
 * serialization cheap and unambiguous.
 */
export type Evidence = Readonly<Record<string, EvidenceValue>>;

/** The only two outcomes the engine can produce. */
export type Decision = 'ALLOW' | 'BLOCK';

/**
 * Returns true for numbers the engine is allowed to reason about.
 *
 * Rejects `NaN`, `±Infinity`, and any non-integer. `-0` is deliberately allowed
 * but callers should normalize it to `0`; `Object.is(-0, 0)` is false, which
 * would otherwise be an invisible source of hash instability.
 */
export function isDeterministicNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Narrows an unknown to a {@link Scalar}. */
export function isScalar(value: unknown): value is Scalar {
  const t = typeof value;
  return t === 'string' || t === 'boolean' || isDeterministicNumber(value);
}

/** Narrows an unknown to an {@link EvidenceValue}. */
export function isEvidenceValue(value: unknown): value is EvidenceValue {
  if (value === null || isScalar(value)) {
    return true;
  }
  return Array.isArray(value) && value.every(isScalar);
}

/**
 * Field names that must never be used as evidence or policy fields.
 *
 * Writing to any of these on a plain object mutates shared prototype state. The
 * engine reads evidence with `Object.hasOwn` and builds records with a null
 * prototype, so this is defence in depth rather than the only barrier — but
 * rejecting them at validation time produces a far clearer error than a silent
 * lookup miss deep inside evaluation.
 */
export const FORBIDDEN_FIELD_NAMES: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

/** True when a field name is safe to use as an evidence or policy field. */
export function isSafeFieldName(field: string): boolean {
  return field.length > 0 && !FORBIDDEN_FIELD_NAMES.includes(field);
}

/**
 * Reads a field from evidence without ever consulting the prototype chain.
 *
 * Returns `undefined` only when the field is genuinely absent, which is the
 * signal the `exists` operator relies on.
 */
export function readField(evidence: Evidence, field: string): EvidenceValue | undefined {
  return Object.hasOwn(evidence, field) ? evidence[field] : undefined;
}
