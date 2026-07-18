/**
 * Evaluation context: the mutable half of an evaluation's inputs.
 *
 * The architecture draws a hard line between two kinds of input:
 *
 * ```
 * Policy  +  Evidence  +  Evaluation Context  →  Decision
 * ```
 *
 * **Evidence is immutable.** It states facts about the subject that do not
 * change unless the world changes: `buy_tax_bp`, `liquidity_usd`,
 * `pair_created_at_unix`. Identical provider payloads always normalize to
 * identical evidence, so the evidence hash is stable and a stored proof stays
 * meaningful.
 *
 * **Context is mutable.** It states facts about *this evaluation*: when it ran,
 * which chain was asked about, which policy version applied. It varies between
 * two otherwise identical requests, and that is expected.
 *
 * The distinction exists because mixing them corrupts the proof semantics. An
 * earlier iteration normalized `pair_age_seconds` into evidence, which meant the
 * evidence hash changed every second even though no provider had said anything
 * new. Age is not a fact about a token; it is a fact about a token *and a
 * moment*. Moving the moment into context restores the invariant that identical
 * provider payloads produce an identical evidence hash, and makes any
 * time-dependent value reproducible by replaying the recorded context.
 *
 * See docs/adr/0004-evidence-versus-context.md.
 */

/**
 * The context an evaluation runs in.
 *
 * Everything here is an explicit input. The engine never reads a clock, so a
 * decision can always be reproduced by supplying the same context — which the
 * proof records.
 */
export interface EvaluationContext {
  /**
   * The reference instant, in whole seconds since the Unix epoch.
   *
   * Supplied by the caller rather than read from the system clock. That is what
   * makes any time-derived comparison deterministic and replayable: given the
   * same evidence and the same `now_unix`, the decision is identical forever.
   */
  readonly now_unix: number;

  /** The chain the request asked about, e.g. `base`. */
  readonly chain?: string;

  /** Network qualifier, e.g. `mainnet`. */
  readonly network?: string;

  /** Identifier of the policy applied, when it came from the built-in library. */
  readonly policy_version?: string;
}

/** True when a value is a usable reference instant. */
export function isValidInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Builds a context for the current moment.
 *
 * The **only** place in the system that reads the clock, and it is never called
 * from inside evaluation — a caller invokes it at the edge and passes the result
 * in, so everything downstream stays a pure function of explicit inputs.
 */
export function currentContext(
  overrides: Omit<Partial<EvaluationContext>, 'now_unix'> = {},
): EvaluationContext {
  return {
    now_unix: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}
