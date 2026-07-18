/**
 * Operator semantics.
 *
 * Every function here is pure and total: given the same operands it returns the
 * same outcome, and it never throws. Failure modes that would be exceptions in a
 * looser design — absent evidence, an operand of the wrong type — are returned as
 * explicit outcomes instead, so a single bad field degrades one rule rather than
 * aborting the whole evaluation.
 *
 * Two rules govern the design:
 *
 * 1. **Fail closed.** Anything other than a definite pass is a non-pass. In
 *    particular `!=` and `not_in` do *not* invert missing evidence into a PASS,
 *    which is the classic way a negated rule silently stops protecting anything.
 * 2. **Never coerce.** All comparisons are strict. JavaScript's `==` and its
 *    relational operators coerce across types (`"10" < 5`, `0 == false`), which
 *    would make outcomes depend on incidental provider typing.
 */

import { isDeterministicNumber, type EvidenceValue } from '@sentinel/shared';
import type { Operator, Rule } from '@sentinel/dsl';

/**
 * The result of applying one operator.
 *
 * Only `PASS` satisfies a rule. The two non-`FAIL` failure outcomes are kept
 * distinct because they mean different things to an operator reading the
 * explanation: `FAIL` is "the evidence was checked and did not qualify", whereas
 * the others indicate the check could not be performed at all.
 */
export type RuleOutcome = 'PASS' | 'FAIL' | 'MISSING_EVIDENCE' | 'TYPE_MISMATCH';

/** The operand a rule compares against, as validated by the DSL. */
export type RuleValue = Rule['value'];

/** Applies one operator to a field's actual value and the rule's expected value. */
export type OperatorFn = (actual: EvidenceValue | undefined, expected: RuleValue) => RuleOutcome;

/** Converts a boolean comparison result into an outcome. */
const verdict = (passed: boolean): RuleOutcome => (passed ? 'PASS' : 'FAIL');

/** True when a value is a single comparable primitive (arrays excluded). */
const isComparableScalar = (value: EvidenceValue): boolean => !Array.isArray(value);

/**
 * Strict equality over the scalar domain.
 *
 * Arrays are rejected rather than compared: `===` on arrays tests reference
 * identity, which would make the outcome depend on object allocation rather than
 * on the evidence itself. A future `set_equals` operator can fill that gap.
 */
const equality: OperatorFn = (actual, expected) => {
  if (actual === undefined) {
    return 'MISSING_EVIDENCE';
  }
  if (!isComparableScalar(actual) || Array.isArray(expected)) {
    return 'TYPE_MISMATCH';
  }
  return verdict(actual === expected);
};

/**
 * Builds an ordered comparison.
 *
 * Both operands must be integers. Strings are refused rather than compared
 * lexicographically, because ordering there depends on collation; floats are
 * refused because the normalizer guarantees integers and their presence signals
 * an upstream bug worth surfacing, not papering over.
 */
const ordered =
  (compare: (a: number, b: number) => boolean): OperatorFn =>
  (actual, expected) => {
    if (actual === undefined) {
      return 'MISSING_EVIDENCE';
    }
    if (!isDeterministicNumber(actual) || !isDeterministicNumber(expected)) {
      return 'TYPE_MISMATCH';
    }
    return verdict(compare(actual, expected));
  };

/**
 * Builds a set-membership check.
 *
 * `null` evidence is treated as a definite non-member rather than an error: the
 * DSL forbids `null` inside a set, so "is null a member" always has the same
 * unambiguous answer. Array evidence *is* an error, since membership of a list
 * within a list is ambiguous (subset? intersection?) and should get its own
 * operator rather than a guessed meaning.
 */
const membership =
  (wantMember: boolean): OperatorFn =>
  (actual, expected) => {
    if (actual === undefined) {
      return 'MISSING_EVIDENCE';
    }
    if (!Array.isArray(expected) || Array.isArray(actual)) {
      return 'TYPE_MISMATCH';
    }
    const isMember = expected.some((candidate) => candidate === actual);
    return verdict(isMember === wantMember);
  };

/**
 * Presence check.
 *
 * "Exists" means present **and** non-null, so a provider that answers with an
 * explicit null is correctly reported as having no value. Note this tests
 * presence, never truthiness: `liquidity_usd: 0` and `symbol: ""` exist.
 *
 * This is the only operator that cannot return `MISSING_EVIDENCE` — absence is
 * precisely the question it answers.
 */
const exists: OperatorFn = (actual, expected) => {
  if (typeof expected !== 'boolean') {
    return 'TYPE_MISMATCH';
  }
  const isPresent = actual !== undefined && actual !== null;
  return verdict(isPresent === expected);
};

/**
 * The operator implementations, keyed by DSL token.
 *
 * Typed as `Record<Operator, OperatorFn>`, which is the drift guard: adding a
 * token to the DSL grammar makes this object fail to typecheck until a matching
 * implementation is supplied. See docs/adr/0002-operator-registry.md.
 */
export const OPERATOR_FNS: Record<Operator, OperatorFn> = Object.freeze({
  '==': equality,
  '!=': (actual, expected) => {
    const result = equality(actual, expected);
    // Only invert a definite comparison. Inverting MISSING_EVIDENCE or
    // TYPE_MISMATCH would turn an unanswerable check into a passing one.
    if (result === 'PASS') {
      return 'FAIL';
    }
    if (result === 'FAIL') {
      return 'PASS';
    }
    return result;
  },
  '<': ordered((a, b) => a < b),
  '<=': ordered((a, b) => a <= b),
  '>': ordered((a, b) => a > b),
  '>=': ordered((a, b) => a >= b),
  in: membership(true),
  not_in: membership(false),
  exists,
});

/**
 * Applies an operator by token.
 *
 * Total and non-throwing: the `Operator` type guarantees the token is
 * implemented, so there is no unknown-operator path here. Unsupported tokens are
 * rejected earlier, at policy validation.
 */
export function applyOperator(
  operator: Operator,
  actual: EvidenceValue | undefined,
  expected: RuleValue,
): RuleOutcome {
  return OPERATOR_FNS[operator](actual, expected);
}
