/**
 * The deterministic evaluator.
 *
 * Takes a validated policy and normalized evidence and produces a decision with a
 * per-rule breakdown. Pure: no I/O, no clock, no randomness. Rule order in the
 * output always mirrors rule order in the policy, so two evaluations of the same
 * input are byte-identical once serialized — which is what makes the proof hashes
 * reproducible.
 */

import { readField, type Decision, type Evidence, type EvidenceValue } from '@sentinel/shared';
import type { Operator, Policy, Rule } from '@sentinel/dsl';
import { applyOperator, type RuleOutcome, type RuleValue } from './operators.js';
import { explain } from './explain.js';

/** The evaluation of a single rule. */
export interface RuleEvaluation {
  /** Evidence field the rule read. */
  readonly field: string;
  /** Operator applied. */
  readonly operator: Operator;
  /** The rule's threshold, verbatim, for machine consumers. */
  readonly expected: RuleValue;
  /**
   * The evidence value that was compared. Omitted entirely when the field was
   * absent — distinguishing "absent" from "present and null", which the `exists`
   * operator depends on.
   */
  readonly actual?: EvidenceValue;
  /** Whether the rule was satisfied. Only a `PASS` outcome counts. */
  readonly passed: boolean;
  /** Why it passed or failed, at machine granularity. */
  readonly outcome: RuleOutcome;
  /** Human-readable explanation, always present. */
  readonly explanation: string;
  /** The policy author's own note, when the rule carried one. */
  readonly description?: string;
}

/** Counts of each outcome across the policy. */
export interface EvaluationSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly missing_evidence: number;
  readonly type_mismatch: number;
}

/** The complete result of evaluating one policy against one evidence set. */
export interface EvaluationResult {
  /** ALLOW only when every rule passed. */
  readonly decision: Decision;
  /** Per-rule breakdown, in policy order. */
  readonly rules: readonly RuleEvaluation[];
  /** Outcome tallies. */
  readonly summary: EvaluationSummary;
  /**
   * Fields the policy required that evidence did not supply. Empty on a complete
   * evaluation; drives the evidence-completeness metric in the benchmark runner.
   */
  readonly missing_fields: readonly string[];
}

/** Evaluates a single rule against evidence. */
function evaluateRule(rule: Rule, evidence: Evidence): RuleEvaluation {
  const actual = readField(evidence, rule.field);
  const outcome = applyOperator(rule.operator, actual, rule.value);

  return {
    field: rule.field,
    operator: rule.operator,
    expected: rule.value,
    // Omit `actual` rather than sending `undefined`, so the serialized output has
    // one unambiguous representation of "no value was present".
    ...(actual === undefined ? {} : { actual }),
    passed: outcome === 'PASS',
    outcome,
    explanation: explain(rule, actual, outcome),
    ...(rule.description === undefined ? {} : { description: rule.description }),
  };
}

/** Tallies outcomes into a summary. */
function summarize(evaluations: readonly RuleEvaluation[]): EvaluationSummary {
  let passed = 0;
  let failed = 0;
  let missingEvidence = 0;
  let typeMismatch = 0;

  for (const evaluation of evaluations) {
    switch (evaluation.outcome) {
      case 'PASS':
        passed += 1;
        break;
      case 'FAIL':
        failed += 1;
        break;
      case 'MISSING_EVIDENCE':
        missingEvidence += 1;
        break;
      case 'TYPE_MISMATCH':
        typeMismatch += 1;
        break;
    }
  }

  return {
    total: evaluations.length,
    passed,
    failed,
    missing_evidence: missingEvidence,
    type_mismatch: typeMismatch,
  };
}

/**
 * Evaluates a policy against evidence.
 *
 * The decision rule is conjunction: **ALLOW only when every rule passes**. That
 * makes the engine fail closed — missing evidence, an unusable value, or any
 * failed threshold all produce BLOCK. A policy with no rules cannot reach this
 * function; the DSL rejects it, precisely because it would vacuously ALLOW.
 *
 * @param policy   A policy already validated by `@sentinel/dsl`.
 * @param evidence Normalized, integer-valued evidence.
 */
export function evaluatePolicy(policy: Policy, evidence: Evidence): EvaluationResult {
  const rules = policy.rules.map((rule) => evaluateRule(rule, evidence));
  const summary = summarize(rules);

  const missingFields = [
    ...new Set(
      rules.filter((rule) => rule.outcome === 'MISSING_EVIDENCE').map((rule) => rule.field),
    ),
  ];

  return {
    decision: summary.passed === summary.total ? 'ALLOW' : 'BLOCK',
    rules,
    summary,
    missing_fields: missingFields,
  };
}

/** Convenience view: the rules that did not pass, in policy order. */
export function failedRules(result: EvaluationResult): readonly RuleEvaluation[] {
  return result.rules.filter((rule) => !rule.passed);
}

/** A one-line summary of why a decision came out the way it did. */
export function decisionReason(result: EvaluationResult): string {
  const failures = failedRules(result);
  if (failures.length === 0) {
    return `ALLOW: all ${String(result.summary.total)} rules passed.`;
  }
  const noun = failures.length === 1 ? 'rule' : 'rules';
  return `BLOCK: ${String(failures.length)} of ${String(result.summary.total)} ${noun} failed. ${failures
    .map((failure) => failure.explanation)
    .join(' ')}`;
}
