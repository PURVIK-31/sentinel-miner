# ADR 0002: Split the operator grammar from its semantics

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

The DSL defines nine operators. Two things must stay in sync forever: what the
policy language _accepts_, and what the engine _does_ with it. If they drift, a
policy can validate successfully and then hit an unimplemented operator at
evaluation time — a runtime failure in the decision path, which is the one place
it is least acceptable.

Putting both in one module would couple the language to the engine and force the
DSL package to depend on evaluation logic it has no business knowing about.

## Decision

Split them, and make the compiler enforce the correspondence.

`packages/dsl/src/operators.ts` owns the **grammar**: the operator tokens, the
operand shape each accepts (`scalar`, `ordinal`, `set`, `presence`), and their
descriptions. It exports `Operator` as a literal union derived from the
declaration list.

`packages/engine/src/operators.ts` owns the **semantics**, as
`Record<Operator, OperatorFn>`. Because the record is keyed by the union, adding
a token to the grammar makes the engine fail to compile until an implementation
exists. Drift is caught at build time, not in production.

Two supporting rules follow from this:

- **Operators are total.** They return `MISSING_EVIDENCE` and `TYPE_MISMATCH`
  outcomes instead of throwing, so `applyOperator` needs no unknown-operator
  branch and one bad field degrades one rule.
- **The `Operator` union must stay literal.** This was violated once during
  implementation: a helper typed as `[string, ...string[]]` widened
  `Rule['operator']` to `string`, which silently stopped `ruleSchema` from being
  a real discriminated union — `rule.operator === 'exists'` no longer narrowed
  `rule.value` to `boolean`. The test suite passed, because Vitest transpiles
  without typechecking; only `tsc --build` caught it. A `expectTypeOf` regression
  test now pins the union.

## Consequences

**Positive** — impossible to ship a validated operator with no implementation;
the DSL stays free of evaluation logic; `GET /version` can enumerate operators
from the grammar alone.

**Negative** — an operator is added in two files rather than one. The compiler
names the second file, so the cost is small and the failure mode is a build
error rather than a runtime one.
