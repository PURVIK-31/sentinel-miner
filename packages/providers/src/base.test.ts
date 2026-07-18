import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ProviderError, type SentinelError } from '@sentinel/shared';
import { createProvider, contribute } from './base.js';
import { createPayloadCache } from './cache.js';
import type { FieldContribution } from '@sentinel/normalizer';
import type { EvidenceRequest, HttpClient } from './types.js';

const REQUEST: EvidenceRequest = { chain: 'base', address: '0xABC' };

const schema = z.object({ symbol: z.string(), tax: z.string().optional() });

/** Builds a provider over a canned payload. */
const providerFor = (payload: unknown, spy = vi.fn()) => {
  const http: HttpClient = {
    getJson: async (url, options) => {
      spy(url, options);
      return payload;
    },
  };
  return createProvider(
    {
      id: 'test',
      fields: ['token_symbol'],
      schema,
      buildUrl: (request) => `https://x.test/${request.address}`,
      extract: (parsed) => [{ field: 'token_symbol', value: parsed.symbol, provider: 'test' }],
    },
    { http, cache: createPayloadCache() },
  );
};

describe('response validation', () => {
  it('extracts from a payload that matches the schema', async () => {
    const result = await providerFor({ symbol: 'WETH' }).fetch(REQUEST);
    expect(result.contributions).toEqual([
      { field: 'token_symbol', value: 'WETH', provider: 'test' },
    ]);
  });

  it('rejects a payload whose shape changed upstream', async () => {
    // An unvalidated shape change would produce confident, wrong evidence.
    await expect(providerFor({ unexpected: true }).fetch(REQUEST)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('reports the offending paths without echoing the payload', async () => {
    const error = (await providerFor({ symbol: 42, secret: 'do-not-log' })
      .fetch(REQUEST)
      .catch((e: unknown) => e)) as SentinelError;

    const serialized = JSON.stringify(error.toPublicJSON());
    expect(serialized).toContain('symbol');
    expect(serialized).not.toContain('do-not-log');
  });

  it('caps the number of reported issues', async () => {
    const wide = z.object(
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${String(i)}`, z.string()])),
    );
    const provider = createProvider(
      {
        id: 'wide',
        fields: [],
        schema: wide,
        buildUrl: () => 'https://x.test/a',
        extract: () => [],
      },
      { http: { getJson: async () => ({}) }, cache: createPayloadCache() },
    );
    const error = (await provider.fetch(REQUEST).catch((e: unknown) => e)) as SentinelError;
    const details = error.details as { issues: unknown[] };
    expect(details.issues.length).toBeLessThanOrEqual(5);
  });
});

describe('snapshot fidelity', () => {
  it('preserves the raw payload, including keys the schema ignores', async () => {
    const payload = { symbol: 'WETH', extra: { nested: true } };
    const result = await providerFor(payload).fetch(REQUEST);
    expect(result.snapshot.payload).toEqual(payload);
  });

  it('caches the raw payload, so a cached result stays faithful', async () => {
    const payload = { symbol: 'WETH', extra: 'kept' };
    const provider = providerFor(payload);
    await provider.fetch(REQUEST);
    const cached = await provider.fetch(REQUEST);
    expect(cached.cached).toBe(true);
    expect(cached.snapshot.payload).toEqual(payload);
    expect(cached.contributions).toEqual([
      { field: 'token_symbol', value: 'WETH', provider: 'test' },
    ]);
  });
});

describe('request construction', () => {
  it('passes adapter headers through to the HTTP client', async () => {
    const spy = vi.fn();
    const http: HttpClient = {
      getJson: async (url, options) => {
        spy(url, options);
        return { symbol: 'X' };
      },
    };
    const provider = createProvider(
      {
        id: 'keyed',
        fields: [],
        schema,
        buildUrl: () => 'https://x.test/a',
        extract: () => [],
        headers: () => ({ 'x-api-key': 'secret' }),
      },
      { http, cache: createPayloadCache() },
    );
    await provider.fetch(REQUEST);
    expect(spy).toHaveBeenCalledWith('https://x.test/a', { headers: { 'x-api-key': 'secret' } });
  });

  it('builds the URL from the request', async () => {
    const spy = vi.fn();
    await providerFor({ symbol: 'X' }, spy).fetch(REQUEST);
    expect(spy).toHaveBeenCalledWith('https://x.test/0xABC', {});
  });
});

describe('contribute', () => {
  it('appends a usable value', () => {
    const into: FieldContribution[] = [];
    contribute(into, 'p', 'f', 'v');
    expect(into).toEqual([{ field: 'f', value: 'v', provider: 'p' }]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('skips %s, all of which mean "no answer"', (_label, value) => {
    const into: FieldContribution[] = [];
    contribute(into, 'p', 'f', value);
    expect(into).toEqual([]);
  });

  it('keeps falsy values that are real answers', () => {
    // 0 liquidity and false flags are data, not absence.
    const into: FieldContribution[] = [];
    contribute(into, 'p', 'a', 0);
    contribute(into, 'p', 'b', false);
    expect(into).toHaveLength(2);
  });
});
