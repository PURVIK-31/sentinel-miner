/**
 * @packageDocumentation
 * The Sentinel policy DSL: operator grammar, Zod schemas, and validation.
 * Defines the language only — evaluation semantics live in `@sentinel/engine`.
 */

export type { OperandKind, OperatorSpec, Operator } from './operators.js';
export {
  OPERATOR_SPECS,
  OPERATORS,
  getOperatorSpec,
  isOperator,
  operandKindOf,
} from './operators.js';

export type { Rule, Policy } from './schema.js';
export { DSL_VERSION, ruleSchema, policySchema, policyInputSchema } from './schema.js';

export type { PolicyIssue } from './validate.js';
export { parsePolicy, parsePolicyInput, safeParsePolicy, referencedFields } from './validate.js';
