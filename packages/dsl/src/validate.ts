/**
 * The policy validation boundary.
 *
 * Everything entering the engine passes through here. Callers get either a fully
 * typed {@link Policy} or a {@link PolicyValidationError} carrying every problem
 * found — not just the first — so a policy author can fix a whole file in one pass.
 */

import type { z } from 'zod';
import { PolicyValidationError } from '@sentinel/shared';
import { policySchema, policyInputSchema, type Policy } from './schema.js';
import { isOperator, OPERATORS } from './operators.js';

/** A single problem found in a candidate policy. */
export interface PolicyIssue {
  /** Dotted path to the offending value, e.g. `rules.2.value`. */
  readonly path: string;
  /** What is wrong, phrased for a policy author. */
  readonly message: string;
}

/** Converts a ZodError into stable, client-safe issue records. */
function toIssues(error: z.ZodError): PolicyIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Produces a clearer message when the failure is an unsupported operator.
 *
 * Zod reports a discriminated-union miss as "invalid discriminator", which tells a
 * policy author nothing useful. Detecting the case explicitly lets us name the
 * offending token and list what is actually supported.
 */
function describeUnsupportedOperators(candidate: unknown): PolicyIssue[] {
  if (typeof candidate !== 'object' || candidate === null) {
    return [];
  }
  const rules: unknown = Array.isArray(candidate)
    ? candidate
    : (candidate as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    return [];
  }
  const issues: PolicyIssue[] = [];
  rules.forEach((rule, index) => {
    if (typeof rule !== 'object' || rule === null) {
      return;
    }
    const operator: unknown = (rule as { operator?: unknown }).operator;
    if (typeof operator === 'string' && !isOperator(operator)) {
      issues.push({
        path: `rules.${String(index)}.operator`,
        message: `Unsupported operator '${operator}'. Supported operators: ${OPERATORS.join(', ')}.`,
      });
    }
  });
  return issues;
}

/**
 * Validates a candidate policy in canonical object form.
 *
 * @throws {PolicyValidationError} with `details.issues` listing every problem.
 */
export function parsePolicy(candidate: unknown): Policy {
  const result = policySchema.safeParse(candidate);
  if (result.success) {
    return result.data;
  }
  const operatorIssues = describeUnsupportedOperators(candidate);
  const issues = operatorIssues.length > 0 ? operatorIssues : toIssues(result.error);
  throw new PolicyValidationError('Policy failed validation.', {
    details: { issues },
  });
}

/**
 * Validates a candidate policy in either canonical or shorthand-array form.
 *
 * @param candidate  The policy object or bare rules array.
 * @param intent     Intent to apply when the shorthand array form is used.
 * @throws {PolicyValidationError} with `details.issues` listing every problem.
 */
export function parsePolicyInput(candidate: unknown, intent: string): Policy {
  const result = policyInputSchema(intent).safeParse(candidate);
  if (result.success) {
    return result.data;
  }
  const operatorIssues = describeUnsupportedOperators(candidate);
  const issues = operatorIssues.length > 0 ? operatorIssues : toIssues(result.error);
  throw new PolicyValidationError('Policy failed validation.', {
    details: { issues },
  });
}

/**
 * Non-throwing variant, for callers that treat invalid policies as data —
 * the benchmark runner and the `/policies` self-check both do.
 */
export function safeParsePolicy(
  candidate: unknown,
): { ok: true; policy: Policy } | { ok: false; issues: PolicyIssue[] } {
  const result = policySchema.safeParse(candidate);
  if (result.success) {
    return { ok: true, policy: result.data };
  }
  const operatorIssues = describeUnsupportedOperators(candidate);
  return { ok: false, issues: operatorIssues.length > 0 ? operatorIssues : toIssues(result.error) };
}

/** Every distinct field a policy reads. Used to check evidence completeness. */
export function referencedFields(policy: Policy): readonly string[] {
  return Object.freeze([...new Set(policy.rules.map((rule) => rule.field))]);
}
