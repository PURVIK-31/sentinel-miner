/**
 * JSON-over-HTTP client for evidence providers.
 *
 * Built on the platform `fetch` rather than an HTTP library: Node 20+ ships it,
 * and every feature we need — timeouts via `AbortSignal`, status inspection,
 * JSON parsing — is already there. One fewer dependency in a security component
 * is worth more than the ergonomics of an extra abstraction.
 *
 * Two rules govern this module:
 *
 * 1. **Never leak credentials.** Basescan takes its API key as a query
 *    parameter, so any error that echoed a URL would print the key into logs and
 *    possibly into an API response. Every URL is redacted before it appears in a
 *    message. See {@link redactUrl}.
 * 2. **Always bound the wait.** A provider that never answers must not hold a
 *    request open. Every call carries a timeout, and exceeding it produces a
 *    retryable {@link ProviderTimeoutError}.
 */

import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type SentinelError,
} from '@sentinel/shared';
import type { HttpClient, HttpRequestOptions } from './types.js';

/** Default time budget for a single provider call. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Query parameters whose values must never appear in a log or an error. */
const SECRET_PARAMS: readonly string[] = ['apikey', 'api_key', 'key', 'token', 'access_token'];

/**
 * Replacement written in place of a credential.
 *
 * Deliberately free of punctuation: `URLSearchParams` percent-encodes anything
 * else, so a bracketed marker would surface in logs as `%5Bredacted%5D` — still
 * safe, but hard to read and hard to grep for.
 */
const REDACTION = 'REDACTED';

/**
 * Renders a URL safely for diagnostics.
 *
 * Keeps the origin and path, which is what actually helps when debugging, and
 * replaces the value of any credential-bearing query parameter with `REDACTED`.
 * An unparseable URL degrades to its origin-less form rather than being echoed.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const param of SECRET_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, REDACTION);
      }
    }
    return parsed.toString();
  } catch {
    return '[unparseable url]';
  }
}

/** True when a thrown value is an abort caused by our own timeout. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Builds the right Sentinel error for a non-2xx response. */
function errorForStatus(status: number, url: string, provider: string): SentinelError {
  const safeUrl = redactUrl(url);
  if (status === 429) {
    return new ProviderRateLimitError(`${provider} refused the request for rate limiting.`, {
      details: { provider, status, url: safeUrl },
    });
  }
  // 408 and 504 are the upstream telling us it timed out; treat them as timeouts
  // so they inherit retryability rather than looking like a hard failure.
  if (status === 408 || status === 504) {
    return new ProviderTimeoutError(`${provider} timed out upstream.`, {
      details: { provider, status, url: safeUrl },
    });
  }
  return new ProviderError(`${provider} responded with HTTP ${String(status)}.`, {
    details: { provider, status, url: safeUrl },
  });
}

/** Configuration for {@link createHttpClient}. */
export interface HttpClientOptions {
  /** Default time budget in milliseconds. */
  readonly timeoutMs?: number;
  /** Provider id, used only to attribute errors. */
  readonly provider: string;
  /**
   * Injection point for tests and for a future instrumented client. Defaults to
   * the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Creates a JSON HTTP client bound to one provider.
 *
 * Deliberately does not retry. A retry inside the client would multiply latency
 * against a time budget the caller already set, and the collector's fail-soft
 * behaviour already degrades gracefully when a provider is unavailable. Retry
 * policy, if it is ever wanted, belongs where the budget is owned.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const { provider, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;

  return {
    async getJson(url: string, requestOptions: HttpRequestOptions = {}): Promise<unknown> {
      const budget = requestOptions.timeoutMs ?? timeoutMs;
      let response: Response;

      try {
        response = await fetchImpl(url, {
          method: 'GET',
          signal: AbortSignal.timeout(budget),
          headers: {
            accept: 'application/json',
            ...requestOptions.headers,
          },
        });
      } catch (error) {
        if (isAbort(error)) {
          throw new ProviderTimeoutError(
            `${provider} did not respond within ${String(budget)}ms.`,
            { cause: error, details: { provider, timeoutMs: budget, url: redactUrl(url) } },
          );
        }
        // DNS failures, connection resets, TLS errors. The underlying message can
        // carry the full URL, so it is kept as `cause` for the logger only.
        throw new ProviderError(`${provider} could not be reached.`, {
          cause: error,
          details: { provider, url: redactUrl(url) },
        });
      }

      if (!response.ok) {
        throw errorForStatus(response.status, url, provider);
      }

      try {
        return await response.json();
      } catch (error) {
        throw new ProviderError(`${provider} returned a response that is not valid JSON.`, {
          cause: error,
          details: { provider, url: redactUrl(url) },
        });
      }
    },
  };
}
