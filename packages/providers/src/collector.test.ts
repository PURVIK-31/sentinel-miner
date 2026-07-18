import { describe, it, expect, vi } from 'vitest';
import { ProviderError, ProviderRateLimitError, ProviderTimeoutError } from '@sentinel/shared';
import { evaluatePolicy } from '@sentinel/engine';
import { parsePolicy } from '@sentinel/dsl';
import { collectEvidence, uncoveredFields, DEFAULT_PRECEDENCE } from './collector.js';
import { createPayloadCache, cacheKey } from './cache.js';
import { createProvider } from './base.js';
import { z } from 'zod';
import type { EvidenceProvider, EvidenceRequest, HttpClient } from './types.js';

const REQUEST: EvidenceRequest = { chain: 'base', address: '0xABC' };

/** A provider stub that answers with fixed contributions. */
const stubProvider = (
  id: string,
  contributions: { field: string; value: unknown }[],
  options: { cached?: boolean } = {},
): EvidenceProvider => ({
  id,
  fields: contributions.map((c) => c.field),
  fetch: vi.fn(async () => ({
    provider: id,
    snapshot: { provider: id, payload: { from: id } },
    contributions: contributions.map((c) => ({ ...c, provider: id })),
    cached: options.cached ?? false,
  })),
});

/** A provider stub that always fails. */
const failingProvider = (id: string, error: Error): EvidenceProvider => ({
  id,
  fields: ['liquidity_usd'],
  fetch: vi.fn(async () => {
    throw error;
  }),
});

describe('collectEvidence — success', () => {
  it('merges contributions from every provider', async () => {
    const result = await collectEvidence(
      [
        stubProvider('goplus', [{ field: 'buy_tax_bp', value: '0.02' }]),
        stubProvider('dexscreener', [{ field: 'liquidity_usd', value: 50_000 }]),
      ],
      REQUEST,
    );
    expect(result.bundle.evidence).toEqual({ buy_tax_bp: 200, liquidity_usd: 50_000 });
    expect(result.providersSucceeded).toEqual(['goplus', 'dexscreener']);
    expect(result.providerErrors).toEqual([]);
  });

  it('preserves a raw snapshot per provider', async () => {
    const result = await collectEvidence(
      [
        stubProvider('goplus', [{ field: 'buy_tax_bp', value: '0.02' }]),
        stubProvider('basescan', [{ field: 'contract_verified', value: true }]),
      ],
      REQUEST,
    );
    expect(result.bundle.raw).toEqual([
      { provider: 'goplus', payload: { from: 'goplus' } },
      { provider: 'basescan', payload: { from: 'basescan' } },
    ]);
  });

  it('reports which providers were served from cache', async () => {
    const result = await collectEvidence(
      [
        stubProvider('goplus', [{ field: 'buy_tax_bp', value: '0.02' }], { cached: true }),
        stubProvider('dexscreener', [{ field: 'liquidity_usd', value: 1 }]),
      ],
      REQUEST,
    );
    expect(result.providersCached).toEqual(['goplus']);
  });

  it('runs providers concurrently rather than in sequence', async () => {
    const slow = (id: string): EvidenceProvider => ({
      id,
      fields: [],
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          provider: id,
          snapshot: { provider: id, payload: {} },
          contributions: [],
          cached: false,
        };
      },
    });
    const started = Date.now();
    await collectEvidence([slow('a'), slow('b'), slow('c')], REQUEST);
    // Sequential would be ~150ms; concurrent should be well under.
    expect(Date.now() - started).toBeLessThan(140);
  });
});

describe('collectEvidence — determinism', () => {
  it('orders results by provider declaration, not completion order', async () => {
    // `fast` resolves first but is declared second; output must not reorder.
    const slow: EvidenceProvider = {
      id: 'slow',
      fields: ['buy_tax_bp'],
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          provider: 'slow',
          snapshot: { provider: 'slow', payload: {} },
          contributions: [{ field: 'buy_tax_bp', value: '0.01', provider: 'slow' }],
          cached: false,
        };
      },
    };
    const fast = stubProvider('fast', [{ field: 'liquidity_usd', value: 1 }]);

    const result = await collectEvidence([slow, fast], REQUEST);
    expect(result.providersSucceeded).toEqual(['slow', 'fast']);
    expect(result.bundle.raw.map((s) => s.provider)).toEqual(['slow', 'fast']);
  });

  it('resolves conflicts by precedence regardless of resolution order', async () => {
    const conflicting = [
      stubProvider('dexscreener', [{ field: 'token_symbol', value: 'FROM_DEX' }]),
      stubProvider('goplus', [{ field: 'token_symbol', value: 'FROM_GOPLUS' }]),
    ];
    const result = await collectEvidence(conflicting, REQUEST);
    expect(result.bundle.evidence['token_symbol']).toBe('FROM_GOPLUS');
    expect(result.bundle.superseded).toEqual([
      { field: 'token_symbol', provider: 'dexscreener', winner: 'goplus' },
    ]);
  });

  it('honours a caller-supplied precedence over the default', async () => {
    const conflicting = [
      stubProvider('dexscreener', [{ field: 'token_symbol', value: 'FROM_DEX' }]),
      stubProvider('goplus', [{ field: 'token_symbol', value: 'FROM_GOPLUS' }]),
    ];
    const result = await collectEvidence(conflicting, REQUEST, {
      precedence: ['dexscreener', 'goplus'],
    });
    expect(result.bundle.evidence['token_symbol']).toBe('FROM_DEX');
  });

  it('ranks the specialised providers ahead of the aggregator by default', () => {
    expect([...DEFAULT_PRECEDENCE]).toEqual(['goplus', 'basescan', 'dexscreener']);
  });
});

describe('collectEvidence — partial failure', () => {
  it('keeps the evidence a healthy provider supplied when another fails', async () => {
    const result = await collectEvidence(
      [
        stubProvider('goplus', [{ field: 'is_honeypot', value: '0' }]),
        failingProvider('dexscreener', new ProviderError('dexscreener is down')),
      ],
      REQUEST,
    );
    // The honeypot check still works even though market data is unavailable.
    expect(result.bundle.evidence).toEqual({ is_honeypot: false });
    expect(result.providersSucceeded).toEqual(['goplus']);
  });

  it('reports the failure with its code and retryability', async () => {
    const result = await collectEvidence(
      [failingProvider('dexscreener', new ProviderTimeoutError('too slow'))],
      REQUEST,
    );
    expect(result.providerErrors).toEqual([
      {
        provider: 'dexscreener',
        code: 'PROVIDER_TIMEOUT',
        message: 'too slow',
        retryable: true,
      },
    ]);
  });

  it('marks a rate limit as retryable and a hard failure as not', async () => {
    const result = await collectEvidence(
      [
        failingProvider('a', new ProviderRateLimitError('slow down')),
        failingProvider('b', new ProviderError('broken')),
      ],
      REQUEST,
    );
    expect(result.providerErrors.map((e) => e.retryable)).toEqual([true, false]);
  });

  it('wraps an unexpected throw rather than letting it escape', async () => {
    const result = await collectEvidence(
      [failingProvider('rogue', new TypeError('cannot read property of undefined'))],
      REQUEST,
    );
    expect(result.providerErrors[0]?.code).toBe('INTERNAL');
    // The raw message never reaches the caller; it could carry internals.
    expect(result.providerErrors[0]?.message).not.toContain('cannot read property');
  });

  it('returns empty evidence, not an error, when every provider fails', async () => {
    const result = await collectEvidence(
      [
        failingProvider('a', new ProviderError('down')),
        failingProvider('b', new ProviderError('down')),
      ],
      REQUEST,
    );
    expect(result.bundle.evidence).toEqual({});
    expect(result.providerErrors).toHaveLength(2);
  });

  it('makes total provider failure produce BLOCK with a missing-evidence explanation', async () => {
    // The end-to-end fail-closed property: no evidence must never mean ALLOW.
    const result = await collectEvidence(
      [failingProvider('a', new ProviderError('down'))],
      REQUEST,
    );
    const policy = parsePolicy({
      intent: 'swap',
      rules: [{ field: 'liquidity_usd', operator: '>', value: 10_000 }],
    });
    const decision = evaluatePolicy(policy, result.bundle.evidence);
    expect(decision.decision).toBe('BLOCK');
    expect(decision.summary.missing_evidence).toBe(1);
    expect(decision.rules[0]?.explanation).toContain('not supplied by any evidence provider');
  });
});

describe('uncoveredFields', () => {
  const providers = [
    stubProvider('goplus', [{ field: 'buy_tax_bp', value: 1 }]),
    stubProvider('dexscreener', [{ field: 'liquidity_usd', value: 1 }]),
  ];

  it('names fields no provider can supply', () => {
    expect([...uncoveredFields(providers, ['buy_tax_bp', 'holder_count'])]).toEqual([
      'holder_count',
    ]);
  });

  it('returns nothing when every field is covered', () => {
    expect(uncoveredFields(providers, ['buy_tax_bp', 'liquidity_usd'])).toEqual([]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(uncoveredFields(providers, ['x']))).toBe(true);
  });
});

describe('provider caching', () => {
  /** Builds a real provider over a counting HTTP stub. */
  const countingProvider = (): { provider: EvidenceProvider; calls: () => number } => {
    let calls = 0;
    const http: HttpClient = {
      getJson: async () => {
        calls += 1;
        return { value: 'x' };
      },
    };
    const provider = createProvider(
      {
        id: 'counting',
        fields: ['token_symbol'],
        schema: z.object({ value: z.string() }),
        buildUrl: () => 'https://x.test/a',
        extract: (payload) => [
          { field: 'token_symbol', value: payload.value, provider: 'counting' },
        ],
      },
      { http, cache: createPayloadCache({ ttlSeconds: 60 }) },
    );
    return { provider, calls: () => calls };
  };

  it('fetches once and serves the repeat from cache', async () => {
    const { provider, calls } = countingProvider();
    const first = await provider.fetch(REQUEST);
    const second = await provider.fetch(REQUEST);

    expect(calls()).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('produces identical evidence within the TTL window', async () => {
    // The property that makes repeated evaluations reproducible.
    const { provider } = countingProvider();
    const first = await collectEvidence([provider], REQUEST);
    const second = await collectEvidence([provider], REQUEST);
    expect(second.bundle.evidence).toEqual(first.bundle.evidence);
  });

  it('treats address casing as the same subject', async () => {
    const { provider, calls } = countingProvider();
    await provider.fetch({ chain: 'base', address: '0xABC' });
    await provider.fetch({ chain: 'base', address: '0xabc' });
    // Checksum casing is presentation, not identity; a miss here would halve the hit rate.
    expect(calls()).toBe(1);
  });

  it('does not confuse different subjects or chains', async () => {
    const { provider, calls } = countingProvider();
    await provider.fetch({ chain: 'base', address: '0xABC' });
    await provider.fetch({ chain: 'base', address: '0xDEF' });
    await provider.fetch({ chain: 'ethereum', address: '0xABC' });
    expect(calls()).toBe(3);
  });
});

describe('cacheKey', () => {
  it('namespaces by provider so two providers never collide', () => {
    expect(cacheKey('goplus', 'base', '0xA')).not.toBe(cacheKey('basescan', 'base', '0xA'));
  });

  it('lower-cases chain and address', () => {
    expect(cacheKey('goplus', 'BASE', '0xABC')).toBe('goplus:base:0xabc');
  });
});

describe('payload cache', () => {
  it('stores and retrieves values', () => {
    const cache = createPayloadCache();
    cache.set('k', { a: 1 });
    expect(cache.get('k')).toEqual({ a: 1 });
    expect(cache.size()).toBe(1);
  });

  it('returns undefined for a key it does not hold', () => {
    expect(createPayloadCache().get('absent')).toBeUndefined();
  });

  it('expires entries once the TTL elapses', async () => {
    const cache = createPayloadCache({ ttlSeconds: 1 });
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // Across the TTL boundary the cache guarantees nothing, by design.
    expect(cache.get('k')).toBeUndefined();
  });

  it('flushes every entry', () => {
    const cache = createPayloadCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.flush();
    expect(cache.size()).toBe(0);
  });

  it('degrades rather than throwing when the key limit is reached', () => {
    // A full cache is a capacity concern, never a correctness one.
    const cache = createPayloadCache({ maxKeys: 2 });
    expect(() => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
    }).not.toThrow();
    expect(cache.get('c')).toBeUndefined();
  });
});
