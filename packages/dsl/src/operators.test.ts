import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  OPERATOR_SPECS,
  OPERATORS,
  getOperatorSpec,
  isOperator,
  operandKindOf,
  type OperandKind,
  type Operator,
} from './operators.js';
import type { Rule } from './schema.js';

describe('operator grammar', () => {
  it('supports exactly the nine operators in the specification', () => {
    expect([...OPERATORS]).toEqual(['==', '!=', '<', '<=', '>', '>=', 'in', 'not_in', 'exists']);
  });

  it('declares no duplicate symbols', () => {
    expect(new Set(OPERATORS).size).toBe(OPERATORS.length);
  });

  it('gives every operator a non-empty description for GET /version', () => {
    for (const spec of OPERATOR_SPECS) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it('exposes OPERATORS as a frozen array so callers cannot mutate the grammar', () => {
    expect(Object.isFrozen(OPERATORS)).toBe(true);
  });

  it('populates every operand kind, which the schema builder relies on', () => {
    // symbolsWithOperand() asserts a non-empty tuple; an empty kind would break it.
    const kinds: OperandKind[] = ['scalar', 'ordinal', 'set', 'presence'];
    for (const kind of kinds) {
      expect(OPERATOR_SPECS.filter((spec) => spec.operand === kind).length).toBeGreaterThan(0);
    }
  });
});

describe('type-level guarantees', () => {
  it('keeps Rule["operator"] a literal union, not a widened string', () => {
    // Regression guard. When this widened to `string`, `ruleSchema` stopped being
    // a real discriminated union and `rule.operator === 'exists'` silently failed
    // to narrow `rule.value` to boolean. The build caught it; this pins it.
    expectTypeOf<Rule['operator']>().toEqualTypeOf<Operator>();
  });

  it('narrows a rule to a boolean operand once the operator is exists', () => {
    const rule = { field: 'a', operator: 'exists', value: true } as Rule;
    if (rule.operator === 'exists') {
      expectTypeOf(rule.value).toEqualTypeOf<boolean>();
    }
  });

  it('narrows ordered comparisons to a numeric operand', () => {
    const rule = { field: 'a', operator: '<', value: 1 } as Rule;
    if (rule.operator === '<') {
      expectTypeOf(rule.value).toEqualTypeOf<number>();
    }
  });
});

describe('operand classification', () => {
  it.each([
    ['==', 'scalar'],
    ['!=', 'scalar'],
    ['<', 'ordinal'],
    ['<=', 'ordinal'],
    ['>', 'ordinal'],
    ['>=', 'ordinal'],
    ['in', 'set'],
    ['not_in', 'set'],
    ['exists', 'presence'],
  ] as const)('classifies %s as %s', (symbol, kind) => {
    expect(operandKindOf(symbol)).toBe(kind);
    expect(getOperatorSpec(symbol)?.operand).toBe(kind);
  });
});

describe('isOperator', () => {
  it.each([...OPERATORS])('accepts the supported operator %s', (symbol) => {
    expect(isOperator(symbol)).toBe(true);
  });

  it.each(['~=', '===', 'IN', 'exists ', '', 'contains', 'toString'])(
    'rejects the unsupported token %s',
    (symbol) => {
      expect(isOperator(symbol)).toBe(false);
    },
  );

  it('is case sensitive, so NOT_IN is not silently accepted', () => {
    expect(isOperator('NOT_IN')).toBe(false);
  });
});

describe('getOperatorSpec', () => {
  it('returns undefined for unsupported tokens', () => {
    expect(getOperatorSpec('~=')).toBeUndefined();
  });

  it('does not resolve inherited Object.prototype keys as operators', () => {
    expect(getOperatorSpec('constructor')).toBeUndefined();
    expect(getOperatorSpec('__proto__')).toBeUndefined();
  });
});
