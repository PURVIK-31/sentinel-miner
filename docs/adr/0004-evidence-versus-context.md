# ADR 0004: Evidence is immutable, context is mutable

- **Status:** Accepted
- **Date:** 2026-07-18
- **Related:** [ADR 0003](0003-fail-closed-normalization.md), [ADR 0005](0005-deterministic-pair-selection.md)

## Context

The first implementation of the DexScreener adapter normalized a field called
`pair_age_seconds` into evidence, computed as `now - pairCreatedAt`.

It was wrong, and the way it was wrong is instructive. Age is not a fact about a
token. It is a fact about a token **and a moment**. Storing it in evidence meant:

- The evidence hash changed every second, even when the provider payload was
  byte-identical and nothing upstream had happened.
- Two evaluations inside the 60-second cache window — which exists precisely to
  guarantee identical evidence — produced different evidence and different
  proofs.
- Extraction had to read the system clock, making a supposedly pure function
  depend on ambient state.

The underlying mistake was conflating two categorically different inputs and
calling both "evidence".

## Decision

Evaluation takes three inputs, not two:

```
Policy  +  Evidence  +  Evaluation Context  →  Decision
```

### Evidence — immutable

Facts about the subject that change only when the world changes.

```
buy_tax_bp            liquidity_usd
is_honeypot           contract_verified
pair_created_at_unix  holder_count
```

Identical provider payloads always normalize to identical evidence. **The
evidence hash is computed only from this.**

### Evaluation Context — mutable

Facts about _this evaluation_, which legitimately differ between two otherwise
identical requests.

```
now_unix    chain    network    policy_version
```

`now_unix` is supplied by the caller, never read from the system clock inside
evaluation. `currentContext()` exists as the single place that reads the clock,
and it is called at the edge — a request handler or a CLI — with the result
passed inward.

### Derived fields — recomputed, never hashed as evidence

Values needing both halves are computed at evaluation time and merged into the
view rules run against:

```
evidence (stable, hashed)  +  context (variable, hashed separately)
        ↓
derived fields (recomputed, not hashed as evidence)
        ↓
evaluation view
```

`pair_age_seconds` is now derived this way, from `pair_created_at_unix` and
`context.now_unix`.

Derived values are deliberately excluded from the evidence hash. They carry no
information the holder of the evidence and context does not already have —
anyone can recompute them exactly — so hashing them would add nothing to verify
while reintroducing the time-dependence this split removes.

The engine is never told which fields are derived. It evaluates rules against the
merged view, staying domain-agnostic and clock-free.

### Timestamps in the proof

The proof still records `evaluated_at_unix`. The distinction is that it describes
**when the evaluation happened** — it is not an input to the evidence. Storing
the context alongside makes any time-dependent decision exactly replayable.

## Consequences

**Positive**

- Identical provider payloads always yield an identical evidence hash. The cache
  window now genuinely guarantees identical evidence, as intended.
- Provider extraction reads no clock and is a pure function of its payload.
- Time-dependent decisions are replayable: same evidence plus same recorded
  context reproduces the decision forever.
- The boundary generalises. Block heights, quote expiry, and rate-limit windows
  are all context, and now have an obvious home.

**Negative**

- Callers must supply `now_unix`. This is deliberate friction — it makes the
  time dependency explicit at the API boundary instead of hiding it in a
  normalizer.
- Two ways to express an age rule now exist (derived `pair_age_seconds`, or a
  precomputed threshold against `pair_created_at_unix`). Both are supported and
  agree; the docs recommend the derived form for readability.
- `NORMALIZATION_VERSION` moved to `1.1`, since removing `pair_age_seconds` and
  adding `pair_created_at_unix` changes the evidence a payload normalizes to.

## Alternatives considered

**Keep `pair_age_seconds` in evidence and record the timestamp in the proof.**
Replay would work, but the evidence hash would still change every second, so two
identical requests inside the cache window would still produce different proofs.
That gives up the strongest available invariant for no gain.

**Expose only `pair_created_at_unix` and require callers to precompute
thresholds.** Simplest possible engine, and still supported. Rejected as the
_only_ option because it pushes arithmetic into every client and makes policies
non-portable across time — a stored policy would encode an absolute instant
rather than the intent "at least one day old".

**Let the engine read the clock when a rule needs time.** Rejected outright. It
would destroy the engine's purity, make evaluation untestable without freezing
time, and make identical inputs produce different outputs.
