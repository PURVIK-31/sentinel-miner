/**
 * Zod schemas for the Sentinel policy DSL.
 *
 * Parsing is strict everywhere: unknown keys are rejected rather than ignored, so
 * a typo like `operatr` fails loudly instead of silently dropping a security rule.
 * That trade — rejecting forward-compatible policies — is intentional for a
 * security component, and is why the DSL carries an explicit version.
 */

import { z } from 'zod';
import { isSafeFieldName } from '@sentinel/shared';
import { OPERATOR_SPECS, type Operator, type OperandKind } from './operators.js';

/** The DSL version this package implements. */
export const DSL_VERSION = '1.0';

/** The operator tokens declared with a given operand kind, as a literal union. */
type SymbolsFor<K extends OperandKind> = Extract<
  (typeof OPERATOR_SPECS)[number],
  { operand: K }
>['symbol'];

/**
 * Operator tokens for one operand kind, derived from the single source of truth.
 *
 * The return type is a non-empty tuple of *literal* types rather than `string[]`.
 * That matters: `z.enum` propagates those literals into `Rule['operator']`, which
 * is what makes `ruleSchema` a genuine discriminated union — without it the
 * operator field widens to `string` and narrowing on `rule.operator === 'exists'`
 * silently stops working downstream.
 *
 * The assertion is safe because every operand kind has at least one operator, and
 * a unit test in operators.test.ts holds that invariant.
 */
const symbolsWithOperand = <K extends OperandKind>(
  kind: K,
): [SymbolsFor<K>, ...SymbolsFor<K>[]] => {
  const symbols = OPERATOR_SPECS.filter((spec) => spec.operand === kind).map((spec) => spec.symbol);
  return symbols as [SymbolsFor<K>, ...SymbolsFor<K>[]];
};

/**
 * A single integer within the safe range.
 *
 * Zod's `.int()` enforces safe-integer bounds as well as integrality, so this one
 * check covers both failure modes: a float would reintroduce the rounding problems
 * the normalizer exists to eliminate, and a value beyond ±(2^53 - 1) cannot be
 * compared or round-tripped reliably. Both are non-determinism, so both share a
 * message that names the remedy.
 */
const integerSchema = z
  .number()
  .int(
    'Expected an integer within the safe range (±2^53 - 1). Use basis points for rates and whole units for money.',
  );

/** A comparable primitive: string, safe integer, or boolean. */
const scalarSchema = z.union([z.string(), integerSchema, z.boolean()]);

/** A field name that is safe to address in evidence. */
const fieldNameSchema = z.string().min(1, 'Field name must not be empty.').refine(isSafeFieldName, {
  message:
    'Field name is reserved. `__proto__`, `constructor`, and `prototype` are rejected to prevent prototype pollution.',
});

/** Optional free-text annotation carried through to the rule evaluation output. */
const descriptionSchema = z.string().max(512).optional();

/** Rules using `==` / `!=`: compare against a scalar, or against null. */
const scalarRuleSchema = z.strictObject({
  field: fieldNameSchema,
  operator: z.enum(symbolsWithOperand('scalar')),
  value: z.union([scalarSchema, z.null()]),
  description: descriptionSchema,
});

/** Rules using `<` / `<=` / `>` / `>=`: integers only, for locale-free ordering. */
const ordinalRuleSchema = z.strictObject({
  field: fieldNameSchema,
  operator: z.enum(symbolsWithOperand('ordinal')),
  value: integerSchema,
  description: descriptionSchema,
});

/** Rules using `in` / `not_in`: a non-empty set of scalars. */
const setRuleSchema = z.strictObject({
  field: fieldNameSchema,
  operator: z.enum(symbolsWithOperand('set')),
  value: z
    .array(scalarSchema)
    .min(1, 'Set operators require at least one member; an empty set makes the rule constant.'),
  description: descriptionSchema,
});

/** Rules using `exists`: a boolean presence assertion. */
const presenceRuleSchema = z.strictObject({
  field: fieldNameSchema,
  operator: z.enum(symbolsWithOperand('presence')),
  value: z.boolean(),
  description: descriptionSchema,
});

/**
 * A single policy rule.
 *
 * Dispatch is on `operator`, so an unsupported token produces one clear error
 * rather than four parallel "did not match" branches.
 */
export const ruleSchema = z.discriminatedUnion('operator', [
  scalarRuleSchema,
  ordinalRuleSchema,
  setRuleSchema,
  presenceRuleSchema,
]);

/** A validated rule. */
export type Rule = z.infer<typeof ruleSchema>;

/** The canonical policy object. */
export const policySchema = z.strictObject({
  /**
   * DSL version. Defaults to the current version so short hand-written policies
   * stay readable; pinning it explicitly is recommended for stored policies.
   */
  dsl_version: z.literal(DSL_VERSION).default(DSL_VERSION),
  /** Stable identifier, required for built-in policies. */
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'Policy id must be lower_snake_case.')
    .max(64)
    .optional(),
  /** Human-readable name. */
  name: z.string().min(1).max(128).optional(),
  /** What the policy is for. */
  description: z.string().max(1024).optional(),
  /**
   * The action being evaluated, e.g. `swap`. Carried into the proof so a decision
   * cannot be replayed as evidence for a different action.
   */
  intent: z.string().min(1).max(64),
  /**
   * The rules. Every rule must pass for the decision to be ALLOW.
   *
   * v1.0 supports conjunction only. Disjunction and nested groups are deliberately
   * deferred — see docs/DSL.md for the planned `{ all: [...] } | { any: [...] }`
   * extension, which the version field exists to gate.
   */
  rules: z.array(ruleSchema).min(1, 'A policy must contain at least one rule.'),
});

/** A validated policy in canonical object form. */
export type Policy = z.infer<typeof policySchema>;

/**
 * Accepts either the canonical policy object or the bare-array shorthand.
 *
 * The shorthand (`"policy": [ ...rules ]`) matches the specification's worked
 * example and is convenient for ad-hoc requests. It is normalized to the object
 * form immediately, so nothing downstream — evaluation, hashing, storage — ever
 * sees two shapes. The synthesized policy uses the intent supplied alongside it.
 */
export function policyInputSchema(fallbackIntent: string): z.ZodType<Policy> {
  return z.union([
    policySchema,
    z
      .array(ruleSchema)
      .min(1, 'A policy must contain at least one rule.')
      .transform((rules): Policy => ({
        dsl_version: DSL_VERSION,
        intent: fallbackIntent,
        rules,
      })),
  ]);
}

/** Re-exported for consumers that need the operator union at the type level. */
export type { Operator };
