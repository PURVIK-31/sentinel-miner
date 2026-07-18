/**
 * The operator grammar.
 *
 * This module defines *what operators exist* and *what operand shapes they accept*.
 * It deliberately contains no evaluation logic — the engine owns semantics. The two
 * are kept in sync by construction: the engine implements
 * `Record<Operator, OperatorFn>`, so adding a name here fails the engine's build
 * until a matching implementation exists. See docs/adr/0002-operator-registry.md.
 */

/**
 * The operand shape an operator expects, which determines how a rule's `value`
 * is validated.
 *
 * - `scalar`   — a single string, integer, or boolean (`==`, `!=`)
 * - `ordinal`  — a single integer; only ordered comparisons (`<`, `<=`, `>`, `>=`)
 * - `set`      — a non-empty array of scalars (`in`, `not_in`)
 * - `presence` — a boolean asserting the field is or is not present (`exists`)
 */
export type OperandKind = 'scalar' | 'ordinal' | 'set' | 'presence';

/** Static description of a single operator in the language. */
export interface OperatorSpec {
  /** The token as it appears in policy JSON. */
  readonly symbol: string;
  /** The operand shape the rule's `value` must satisfy. */
  readonly operand: OperandKind;
  /** Human-readable summary, surfaced by `GET /version` and the docs. */
  readonly description: string;
}

/**
 * Every operator in DSL v1.0, in canonical order.
 *
 * Ordered comparisons accept **integers only**. Allowing them on strings would
 * make results depend on locale and collation, which breaks determinism across
 * hosts; allowing them on floats would reintroduce the rounding problems the
 * normalizer exists to eliminate.
 */
export const OPERATOR_SPECS = [
  {
    symbol: '==',
    operand: 'scalar',
    description: 'Strict equality against a scalar or null.',
  },
  {
    symbol: '!=',
    operand: 'scalar',
    description: 'Strict inequality against a scalar or null.',
  },
  {
    symbol: '<',
    operand: 'ordinal',
    description: 'Actual integer is strictly less than the expected integer.',
  },
  {
    symbol: '<=',
    operand: 'ordinal',
    description: 'Actual integer is less than or equal to the expected integer.',
  },
  {
    symbol: '>',
    operand: 'ordinal',
    description: 'Actual integer is strictly greater than the expected integer.',
  },
  {
    symbol: '>=',
    operand: 'ordinal',
    description: 'Actual integer is greater than or equal to the expected integer.',
  },
  {
    symbol: 'in',
    operand: 'set',
    description: 'Actual scalar is a member of the expected set.',
  },
  {
    symbol: 'not_in',
    operand: 'set',
    description: 'Actual scalar is not a member of the expected set.',
  },
  {
    symbol: 'exists',
    operand: 'presence',
    description:
      'Field presence. `true` requires the field to be present and non-null; `false` requires it to be absent or null.',
  },
] as const satisfies readonly OperatorSpec[];

/** The union of every supported operator token. */
export type Operator = (typeof OPERATOR_SPECS)[number]['symbol'];

/** Every supported operator token, in canonical order. */
export const OPERATORS: readonly Operator[] = Object.freeze(
  OPERATOR_SPECS.map((spec) => spec.symbol),
);

/** Lookup from token to its specification. */
const SPEC_BY_SYMBOL: ReadonlyMap<string, OperatorSpec> = new Map(
  OPERATOR_SPECS.map((spec) => [spec.symbol, spec]),
);

/** Returns the spec for an operator token, or `undefined` if unsupported. */
export function getOperatorSpec(symbol: string): OperatorSpec | undefined {
  return SPEC_BY_SYMBOL.get(symbol);
}

/** Narrows an arbitrary string to a supported {@link Operator}. */
export function isOperator(symbol: string): symbol is Operator {
  return SPEC_BY_SYMBOL.has(symbol);
}

/**
 * Operand kind by operator token.
 *
 * A total `Record` keyed by the `Operator` union rather than a `Map` lookup, so
 * {@link operandKindOf} needs no non-null assertion and no unreachable
 * "operator not found" branch that could never be tested.
 */
const OPERAND_KIND_BY_SYMBOL = Object.fromEntries(
  OPERATOR_SPECS.map((spec) => [spec.symbol, spec.operand]),
) as Record<Operator, OperandKind>;

/** Returns the operand shape an operator expects. */
export function operandKindOf(operator: Operator): OperandKind {
  return OPERAND_KIND_BY_SYMBOL[operator];
}
