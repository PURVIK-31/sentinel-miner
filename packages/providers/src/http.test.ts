import { describe, it, expect, vi } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type SentinelError,
} from '@sentinel/shared';
import { createHttpClient, redactUrl } from './http.js';

/** Builds a fetch stub returning one canned response. */
const stubFetch = (init: { status?: number; body?: unknown; text?: string }): typeof fetch =>
  vi.fn(async () => {
    const { status = 200, body, text } = init;
    if (text !== undefined) {
      return new Response(text, { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });

const client = (fetchImpl: typeof fetch) =>
  createHttpClient({ provider: 'testprovider', fetchImpl });

describe('redactUrl', () => {
  it.each(['apikey', 'api_key', 'key', 'token', 'access_token'])(
    'redacts the %s query parameter',
    (param) => {
      const redacted = redactUrl(`https://api.example.com/x?${param}=SUPERSECRET&address=0xabc`);
      expect(redacted).not.toContain('SUPERSECRET');
      expect(redacted).toContain('REDACTED');
    },
  );

  it('keeps the parts that actually help debugging', () => {
    const redacted = redactUrl('https://api.basescan.org/api?module=contract&apikey=SECRET');
    expect(redacted).toContain('api.basescan.org');
    expect(redacted).toContain('module=contract');
  });

  it('leaves a URL without credentials untouched', () => {
    const url = 'https://api.dexscreener.com/latest/dex/tokens/0xabc';
    expect(redactUrl(url)).toBe(url);
  });

  it('does not echo an unparseable URL back', () => {
    expect(redactUrl('not a url at all')).toBe('[unparseable url]');
  });
});

describe('successful requests', () => {
  it('returns the parsed JSON body', async () => {
    const result = await client(stubFetch({ body: { ok: true } })).getJson('https://x.test/a');
    expect(result).toEqual({ ok: true });
  });

  it('sends an accept header and merges caller headers', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    await client(spy).getJson('https://x.test/a', {
      headers: { 'x-api-key': 'abc' },
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['accept']).toBe('application/json');
    expect(headers['x-api-key']).toBe('abc');
  });
});

describe('failure mapping', () => {
  it('maps 429 to a retryable rate-limit error', async () => {
    const error = await client(stubFetch({ status: 429 }))
      .getJson('https://x.test/a')
      .catch((e: unknown) => e as SentinelError);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as SentinelError).retryable).toBe(true);
  });

  it.each([408, 504])('maps upstream timeout status %i to a retryable timeout', async (status) => {
    const error = await client(stubFetch({ status }))
      .getJson('https://x.test/a')
      .catch((e: unknown) => e as SentinelError);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect((error as SentinelError).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 500, 502, 503])(
    'maps status %i to a non-retryable provider error',
    async (status) => {
      const error = await client(stubFetch({ status }))
        .getJson('https://x.test/a')
        .catch((e: unknown) => e as SentinelError);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as SentinelError).retryable).toBe(false);
    },
  );

  it('maps a malformed JSON body to a provider error', async () => {
    const error = await client(stubFetch({ text: 'not json{' }))
      .getJson('https://x.test/a')
      .catch((e: unknown) => e as SentinelError);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as SentinelError).message).toContain('not valid JSON');
  });

  it('maps a transport failure to a provider error, keeping the cause for logs', async () => {
    const cause = new Error('ECONNREFUSED');
    const failing = vi.fn(async () => {
      throw cause;
    }) as unknown as typeof fetch;
    const error = await client(failing)
      .getJson('https://x.test/a')
      .catch((e: unknown) => e as SentinelError);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as SentinelError).cause).toBe(cause);
  });

  it('maps an abort to a timeout error naming the budget', async () => {
    const aborting = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;
    const error = await createHttpClient({
      provider: 'testprovider',
      fetchImpl: aborting,
      timeoutMs: 1234,
    })
      .getJson('https://x.test/a')
      .catch((e: unknown) => e as SentinelError);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect((error as SentinelError).message).toContain('1234ms');
  });

  it('actually aborts when the budget elapses', async () => {
    // Verifies the AbortSignal is wired, not just that we translate errors.
    const slow = ((url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    await expect(
      createHttpClient({ provider: 'slow', fetchImpl: slow, timeoutMs: 20 }).getJson(
        'https://x.test/a',
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('credential safety', () => {
  it('never puts the API key in an error message or details', async () => {
    const url = 'https://api.basescan.org/api?address=0xabc&apikey=SUPERSECRET';
    const error = (await client(stubFetch({ status: 500 }))
      .getJson(url)
      .catch((e: unknown) => e)) as SentinelError;

    const serialized = JSON.stringify({
      message: error.message,
      details: error.details,
      body: error.toPublicJSON(),
    });
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).toContain('REDACTED');
  });

  it('never leaks the key through a transport failure either', async () => {
    const failing = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED api.basescan.org');
    }) as unknown as typeof fetch;
    const error = (await client(failing)
      .getJson('https://api.basescan.org/api?apikey=SUPERSECRET')
      .catch((e: unknown) => e)) as SentinelError;
    expect(JSON.stringify(error.toPublicJSON())).not.toContain('SUPERSECRET');
  });
});
