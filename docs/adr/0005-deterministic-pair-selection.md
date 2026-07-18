# ADR 0005: Deterministic pair selection for market evidence

- **Status:** Accepted
- **Date:** 2026-07-18
- **Related:** [ADR 0003](0003-fail-closed-normalization.md), [ADR 0004](0004-evidence-versus-context.md)

## Context

DexScreener returns **every** trading pair for a token: across chains, across
DEXs, and across wildly different pool depths. A token commonly has a deep pool
on one venue and dust pools on several others.

`liquidity_usd` is a single number in the evidence schema, so exactly one pair
must be chosen. That choice determines what the field _means_, and two hazards
follow from it:

1. **Semantic.** Reading the wrong pool answers a different question than the
   policy asked. "Is there $10k of liquidity" is a question about whether a trade
   can actually execute.
2. **Determinism.** If selection depends on the order the upstream array happens
   to arrive in, evidence — and therefore the proof hash — varies between
   identical requests. The API makes no ordering guarantee.

## Decision

> When multiple valid pools exist on the requested chain, Sentinel Miner selects
> the pool with the **greatest reported liquidity**. If multiple pools report
> identical liquidity, the pool with the **lexicographically smallest
> `pairAddress`** is chosen.

Concretely:

1. Filter to pairs whose `chainId` matches the requested chain. A deeper pool on
   another chain is irrelevant to a swap on this one and is never considered.
2. Sort by `liquidity.usd` descending; a missing figure sorts as zero.
3. Break ties on `pairAddress` ascending.
4. Take the first. If no pair remains, contribute **no** market evidence, so the
   engine fails closed on any rule that needed it.

Liquidity is deliberately **not summed** across pools. A policy asking for
$10,000 of liquidity is asking whether a trade can execute against a real pool;
summing dust across venues answers a more flattering question and would let a
token clear a threshold no single pool supports.

The tie-break is not decoration — it is the load-bearing part. Without it, two
pools reporting equal liquidity are ordered by the upstream response, and the
proof hash becomes a function of the provider's internal ordering rather than of
the facts. `pairAddress` is an intrinsic, stable, unique key, which makes the
resulting order a property of the data rather than of the transport.

A fixture in `packages/providers/src/fixtures` deliberately contains two base
pairs with identical liquidity, and a test asserts that reversing the array does
not change the selection.

## Consequences

**Positive**

- Selection is a pure function of the payload. Identical payloads always select
  the same pair, so evidence and proofs stay reproducible.
- The chosen pool is the one an aggregator would realistically route through.
- The rule is short enough to state in the API documentation, so a consumer can
  predict which pool a decision was based on.

**Negative**

- A token whose liquidity is genuinely split across several pools is reported
  more conservatively than the market-wide total. This is the fail-closed
  direction and is consistent with ADR 0003, but it can understate a mature
  token with several deep venues.
- Selecting on reported liquidity inherits any error in the provider's figure.
  There is no independent measurement to cross-check against.
- The evidence records one pool while `volume_24h_usd` and `market_cap_usd` are
  read from that same pool, so a tie-break can change reported volume even when
  liquidity is identical. Consistency within a single pool is preferable to
  mixing metrics across pools.

## Alternatives considered

**Sum liquidity across all pools on the chain.** Rejected: answers a different
question than the policy asks, and inflates a token whose depth is fragmented
into unusable pieces.

**Select the most recently active pool.** Rejected: activity recency is
time-dependent, which would drag a context dependency back into evidence — the
exact problem ADR 0004 removes.

**Return every pool and let policies quantify.** Rejected for v1. It requires
array-valued evidence and quantifier operators (`any` / `all`), which is a real
DSL extension rather than a selection rule. Worth revisiting if multi-pool
policies are actually wanted; the DSL version field exists to gate it.
