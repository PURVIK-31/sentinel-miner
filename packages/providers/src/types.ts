/**
 * The evidence provider contract.
 *
 * A provider does exactly two things: fetch a payload from an external service,
 * and say which catalog fields that payload claims. It never converts units,
 * never applies a rounding rule, and never evaluates a policy. Conversion belongs
 * to the normalizer (which owns the fail-closed rounding rules) and evaluation
 * belongs to the engine.
 *
 * That separation is what lets a provider be replaced, or a whole domain be
 * re-targeted, without touching the decision path.
 */

import type { FieldContribution, ProviderSnapshot } from '@sentinel/normalizer';

/** What to collect evidence about. */
export interface EvidenceRequest {
  /**
   * Chain identifier, lower case, e.g. `base`. Providers map this to whatever
   * their own API expects — a numeric chain id, a slug, a path segment.
   */
  readonly chain: string;
  /** Contract address of the subject token. */
  readonly address: string;
}

/** What one provider produced for one request. */
export interface ProviderResult {
  /** Stable provider identifier. */
  readonly provider: string;
  /** The raw payload, preserved verbatim for audit. */
  readonly snapshot: ProviderSnapshot;
  /**
   * Field claims extracted from the payload, still in the provider's own units.
   * The normalizer converts and rounds these.
   */
  readonly contributions: readonly FieldContribution[];
  /** True when this result was served from cache rather than fetched. */
  readonly cached: boolean;
}

/**
 * An evidence provider.
 *
 * Implementations must not throw for a partially usable payload — a field that
 * is missing or unparseable is simply not contributed, and the engine fails
 * closed on it. Throwing is reserved for the request as a whole failing: a
 * timeout, a rate limit, a non-2xx response, or a payload that does not match
 * the provider's schema at all.
 */
export interface EvidenceProvider {
  /** Stable identifier, used in precedence ordering and in `sources`. */
  readonly id: string;

  /**
   * The catalog fields this provider can supply. Declared rather than inferred
   * so the collector can report which fields no provider covers, without having
   * to call anything.
   */
  readonly fields: readonly string[];

  /**
   * Fetches evidence for one subject.
   *
   * @throws {ProviderTimeoutError} the provider exceeded its time budget.
   * @throws {ProviderRateLimitError} the provider refused for rate limiting.
   * @throws {ProviderError} any other transport or schema failure.
   */
  fetch(request: EvidenceRequest): Promise<ProviderResult>;
}

/** Minimal JSON-over-HTTP client, injected so providers stay testable. */
export interface HttpClient {
  /**
   * Performs a GET and parses the response as JSON.
   *
   * Implementations are responsible for mapping transport failures onto the
   * Sentinel error taxonomy before they reach a provider.
   */
  getJson(url: string, options?: HttpRequestOptions): Promise<unknown>;
}

/** Per-request HTTP options. */
export interface HttpRequestOptions {
  /** Time budget in milliseconds. Overrides the client default. */
  readonly timeoutMs?: number;
  /** Additional request headers. Never log these; they may carry credentials. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A read-through cache for raw provider payloads. */
export interface PayloadCache {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  /** Number of live entries. Exposed for health reporting and tests. */
  size(): number;
  /** Drops every entry. */
  flush(): void;
}
