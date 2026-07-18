/**
 * @packageDocumentation
 * The deterministic policy evaluation engine.
 *
 * Pure functions only: no I/O, no clock reads, no randomness, no ambient state.
 * The same policy and evidence always produce the same decision.
 */

export type { RuleOutcome, RuleValue, OperatorFn } from './operators.js';
export { OPERATOR_FNS, applyOperator } from './operators.js';

export type { RuleEvaluation, EvaluationSummary, EvaluationResult } from './evaluator.js';
export { evaluatePolicy, failedRules, decisionReason } from './evaluator.js';

export { explain, formatValue } from './explain.js';
