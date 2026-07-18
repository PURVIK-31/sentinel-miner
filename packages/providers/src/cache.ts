/**
 * Raw payload cache for the provider layer.
 *
 * The cache lives here, and only here. The engine must never see a cache — it is
 * a pure function of policy and evidence, and giving it any time-varying input
 * would break that. Caching raw payloads at the provider boundary keeps the
 * determinism guarantee where it belongs.
 *
 * ## What the cache does and does not guarantee
 *
 * Within the TTL, repeated evaluations of the same subject see byte-identical
 * evidence and therefore produce identical proofs. That is the property that
 * makes a demo reproducible and stops a burst of requests from exhausting a rate
 * limit.
 *
 * Across the TTL boundary it guarantees nothing, and it should not. Two
 * evaluations 61 seconds apart can legitimately return different evidence,
 * because the world changed — liquidity moved, a contract was verified. The
 * resulting proofs differ, and that is correct behaviour, not a determinism
 * failure: the engine's guarantee is that *the same evidence* always yields the
 * same decision, not that evidence is frozen forever. Proofs therefore record
 * the evidence they were computed from, so an archived decision stays verifiable
 * even once the underlying facts have moved on.
 */

import NodeCache from 'node-cache';
import type { PayloadCache } from './types.js';

/** Default entry lifetime, per the specification. */
export const DEFAULT_TTL_SECONDS = 60;

/** Configuration for {@link createPayloadCache}. */
export interface PayloadCacheOptions {
  /** Entry lifetime in seconds. */
  readonly ttlSeconds?: number;
  /**
   * Maximum entries retained. Bounded so a long-running miner cannot grow
   * without limit under a stream of distinct subjects.
   */
  readonly maxKeys?: number;
}

/**
 * Builds the cache key for one provider and subject.
 *
 * The provider id is part of the key so two providers caching the same subject
 * never collide. Chain and address are lower-cased because address casing is
 * checksum presentation, not identity — `0xABC` and `0xabc` are the same token,
 * and treating them as different keys would silently halve the hit rate.
 */
export function cacheKey(provider: string, chain: string, address: string): string {
  return `${provider}:${chain.toLowerCase()}:${address.toLowerCase()}`;
}

/**
 * Creates a bounded TTL cache for raw provider payloads.
 *
 * `useClones` is disabled: payloads are treated as immutable once cached, and
 * cloning every read would copy a large JSON structure on every request for no
 * benefit. Nothing downstream mutates a payload — the normalizer only reads.
 */
export function createPayloadCache(options: PayloadCacheOptions = {}): PayloadCache {
  const { ttlSeconds = DEFAULT_TTL_SECONDS, maxKeys = 5000 } = options;

  const cache = new NodeCache({
    stdTTL: ttlSeconds,
    checkperiod: Math.max(1, Math.floor(ttlSeconds / 2)),
    useClones: false,
    maxKeys,
  });

  return {
    get(key: string): unknown {
      return cache.get(key);
    },
    set(key: string, value: unknown): void {
      try {
        cache.set(key, value);
      } catch {
        // NodeCache throws once maxKeys is reached. A full cache is a
        // performance concern, never a correctness one: the caller simply
        // fetches again. Failing the request here would turn a capacity limit
        // into an outage.
      }
    },
    size(): number {
      return cache.keys().length;
    },
    flush(): void {
      cache.flushAll();
    },
  };
}
