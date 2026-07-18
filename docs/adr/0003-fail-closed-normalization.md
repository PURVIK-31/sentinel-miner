# ADR 0003: Fail-closed normalization with exact decimal arithmetic

- **Status:** Accepted
- **Date:** 2026-07-18
- **Supersedes:** none
- **Related:** [ADR 0001](0001-clean-architecture.md), [ADR 0002](0002-operator-registry.md)

## Context

The policy engine compares integers only. Provider payloads do not cooperate:

| Provider    | Field           | Form                                    |
| ----------- | --------------- | --------------------------------------- |
| GoPlus      | `buy_tax`       | decimal string fraction, e.g. `"0.025"` |
| DexScreener | `liquidity.usd` | JSON number, e.g. `125000.4482`         |
| Basescan    | `holder_count`  | decimal string, e.g. `"1820"`           |

Converting these to integers forces two decisions that change decisions, not just
representations:

1. **Which direction to round** when precision must be discarded.
2. **How to perform the conversion** without introducing error of our own.

Both are security decisions. A tax understated by one basis point, or liquidity
overstated by one dollar, can flip an evaluation from BLOCK to ALLOW at a
threshold boundary.

## Decision

### 1. Round fail-closed, by field category

Every numeric field declares a rounding direction in a versioned catalog
(`packages/normalizer/src/fields.ts`). The direction is chosen so that discarded
precision always makes the policy **harder** to satisfy:

- **Costs and risks round up (`ceil`)** — `buy_tax_bp`, `sell_tax_bp`,
  `transfer_tax_bp`. Rounding up can only overstate what an action costs.
- **Resources and safety margins round down (`floor`)** — `liquidity_usd`,
  `volume_24h_usd`, `market_cap_usd`, `holder_count`, `pair_age_seconds`.
  Rounding down can only understate what is available.

Booleans and identifiers discard no precision and declare no rounding. Risk flags
are **never defaulted**: an unrecognised value is dropped rather than coerced to
`false`, because guessing on a honeypot flag is exactly the failure this system
exists to prevent.

### 2. Never perform arithmetic on floats

The obvious implementation is wrong:

```ts
Math.ceil(parseFloat('0.07') * 10000); // 701 — not 700
```

`0.07 * 10000` evaluates to `700.0000000000001` in IEEE-754. Ceiling that
fabricates a basis point, turning a 7% tax into 7.01% — enough to block a
legitimate token at a 700bp threshold. Rounding the other way fails
symmetrically: `0.57 * 10000` is `5699.999999999999`, which floors to 5699.

So `toScaledInteger` performs no float arithmetic at all. It parses the input
into its exact decimal digits, _moves_ the decimal point by the scale factor,
inspects the discarded digits to decide rounding, and carries magnitudes in
`BigInt`. The result is range-checked against `Number.MAX_SAFE_INTEGER` before
being returned.

Values are read from the string form wherever possible. A provider that sends
`"0.07"` has stated exactly what it means; a JSON number has already been through
a float before we ever see it.

### 3. Keep raw and normalized strictly apart

`normalizeEvidence` returns a bundle with two separate fields:

- `evidence` — integers, booleans, and opaque strings. **The only input the
  policy engine ever receives.**
- `raw` — provider payloads preserved verbatim, for audit and debugging, hashed
  into the proof but never read during evaluation.

The engine's signature accepts `Evidence`, so a raw payload cannot reach it by
construction. `isDeterministicEvidence` is available as a runtime assertion at
the trust boundary, since evidence originates in parsed JSON.

### 4. Version the ruleset

`NORMALIZATION_VERSION` is stamped into every bundle and carried into the proof.
Changing any field's unit, type, or rounding direction changes decisions and
therefore proof hashes, so an archived proof is only reproducible against the
ruleset version that produced it.

### 5. Fail soft on the field, closed on the decision

Normalization never throws for a bad field. An unusable value is omitted and an
issue is recorded, so the field reads as **absent** to the engine — which fails
closed to BLOCK rather than substituting a guess. One malformed field degrades
one rule instead of aborting the whole evaluation.

## Consequences

**Positive**

- Rounding can never flip a decision in the permissive direction.
- Conversions are exact; the float regression cases are covered by tests that
  assert against the specific values that break the naive implementation.
- Decisions stay reproducible: evidence is a pure function of the inputs, with
  provider precedence resolved explicitly rather than by response arrival order.
- Raw payloads remain available for debugging without any path into evaluation.

**Negative**

- Reported evidence will not always exactly match the upstream API. A pool with
  `$10,000.99` is reported as `10000`. This is intentional and documented, but it
  means the miner's evidence and a provider's dashboard can differ by up to one
  unit.
- Exact decimal parsing is slower than a float multiply. It is not on a hot path
  — a handful of fields per request — and correctness dominates here.
- The catalog must be extended before a new field can enter evidence. This is
  deliberate: an unnormalized passthrough field could carry a float.

## Alternatives considered

**Round half to even (banker's rounding).** Standard for accounting, wrong here.
It minimises aggregate bias across many values, but a policy decision is a single
comparison at a threshold, where the question is not "what is closest" but "which
direction is safe to be wrong in".

**Preserve exact values as decimal strings.** Rejected. It pushes the comparison
problem into the engine, which would then need decimal-aware operators, and the
DSL's integer thresholds would no longer be directly comparable. The engine's
determinism guarantee rests on integers.

**Scale everything to a fixed high precision (e.g. 18 decimals).** Rejected as
premature. It preserves more precision than any provider reports, at the cost of
numbers that immediately exceed the safe-integer range and force `BigInt`
throughout the engine and the DSL.

**Let the last provider win on conflicts.** Rejected. It makes evidence depend on
which network request resolved first, which would make proofs non-reproducible.
Precedence is explicit and ordered.
