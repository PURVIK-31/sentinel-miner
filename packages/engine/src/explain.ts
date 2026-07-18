/**
 * The explanation engine.
 *
 * Turns a rule outcome into a sentence an operator can act on. Explanations are
 * deliberately **domain-agnostic**: this module knows nothing about tokens,
 * liquidity, or currency, because the engine is meant to outlive its first
 * adapter. Domain-specific rendering (`$4,200` rather than `4200`) belongs in a
 * presentation layer that can map field names to units.
 *
 * Explanations are part of the deterministic output, so they are built from the
 * rule and the evidence alone — no locale, no timezone, no `Intl` formatting.
 */

import type { EvidenceValue } from '@sentinel/shared';
import type { Rule } from '@sentinel/dsl';
import type { RuleOutcome, RuleValue } from './operators.js';

/**
 * Renders a value for display, deterministically.
 *
 * Hand-rolled rather than delegating to `JSON.stringify`: the engine bans that
 * call outright (key order is insertion-dependent, which is a hazard anywhere
 * near hashing), and an explicit formatter lets arrays read as `a, b` instead of
 * a JSON literal.
 */
export function formatValue(value: EvidenceValue | RuleValue | undefined): string {
  if (value === undefined) {
    return 'absent';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    // Escape backslashes before quotes, or the escapes themselves get mangled.
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return `[${value.map((item) => formatValue(item)).join(', ')}]`;
}

/** Names the JavaScript type of a value, for type-mismatch messages. */
function describeType(value: EvidenceValue | undefined): string {
  if (value === undefined) {
    return 'absent';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'list';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'decimal';
  }
  return typeof value;
}

/** Renders the rule's condition, e.g. `<= 500` or `in ["base", "ethereum"]`. */
function describeCondition(operator: string, expected: RuleValue): string {
  return `${operator} ${formatValue(expected)}`;
}

/** Explains an `exists` rule, which reads badly under the generic phrasing. */
function explainExists(
  field: string,
  actual: EvidenceValue | undefined,
  expected: boolean,
): string {
  const present = actual !== undefined && actual !== null;
  if (expected) {
    return present
      ? `${field} is present, as required.`
      : `${field} is required to be present, but it is ${actual === null ? 'null' : 'absent'}.`;
  }
  return present
    ? `${field} is required to be absent, but it is present with value ${formatValue(actual)}.`
    : `${field} is absent, as required.`;
}

/**
 * Produces the human-readable explanation for one evaluated rule.
 *
 * Always returns a sentence, for passes as well as failures — a decision is only
 * fully explainable if you can see why the rules that *did* pass were satisfied.
 */
export function explain(
  rule: Rule,
  actual: EvidenceValue | undefined,
  outcome: RuleOutcome,
): string {
  if (rule.operator === 'exists') {
    return explainExists(rule.field, actual, rule.value);
  }

  const condition = describeCondition(rule.operator, rule.value);

  switch (outcome) {
    case 'PASS':
      return `${rule.field} is ${formatValue(actual)}, which satisfies ${condition}.`;
    case 'FAIL':
      return `${rule.field} is ${formatValue(actual)}, which does not satisfy ${condition}.`;
    case 'MISSING_EVIDENCE':
      return `${rule.field} was not supplied by any evidence provider, so ${condition} could not be checked.`;
    case 'TYPE_MISMATCH':
      return `${rule.field} is ${formatValue(actual)} (${describeType(actual)}), which cannot be compared using ${condition}.`;
  }
}
