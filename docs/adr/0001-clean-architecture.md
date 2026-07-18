# ADR 0001: Clean architecture with a domain-agnostic core

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Sentinel Miner evaluates blockchain actions today, but the value proposition is a
reusable deterministic decision layer — the blockchain adapter is the first
implementation, not the purpose. An architecture that lets provider vocabulary
leak into the engine would make every future domain a rewrite.

A second constraint shapes this: the Telegraph Protocol's public documentation
describes the Rail, Signal, Commodity, and Interface components and the
validator/miner reward model, but **publishes no miner HTTP contract** — no
endpoint list, no request or response schema, no scoring interface. We cannot
conform to a specification we cannot read.

## Decision

Dependencies point inward only:

```
apps/api  ──►  packages/engine  ◄──  packages/dsl
    │                 ▲                    │
    │                 │                    ▼
    └──► providers ──► normalizer ──► packages/shared
```

- `shared` — domain types and errors. No dependencies.
- `dsl` — the policy language: grammar, schemas, validation. Knows nothing of
  evaluation.
- `engine` — evaluation semantics. Pure functions: no I/O, no clock, no
  randomness. Knows nothing of providers or HTTP.
- `normalizer` — provider payloads to deterministic integer evidence.
- `providers` — I/O only. Fetch and cache; never evaluate.
- `apps/api` — transport only. No business logic in route handlers.

The engine's only inputs are a validated `Policy` and a normalized `Evidence`
record. Neither type carries provider or transport vocabulary, so re-targeting
the engine to a new domain means writing a new adapter and field catalog, not
touching the engine.

Telegraph-specific binding is isolated behind an adapter at the API edge, so
conforming to the real miner contract — once available — is a change in one
module rather than a change to the decision path.

## Consequences

**Positive** — the engine is trivially testable with literal objects and no
mocks; a new evidence domain needs no engine change; the Telegraph unknown is
contained.

**Negative** — more packages than a single-module design, and cross-package
changes need TypeScript project references to build in the right order. Accepted
in exchange for the boundaries being enforced by the compiler rather than by
convention.
