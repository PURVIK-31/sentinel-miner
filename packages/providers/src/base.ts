/**
 * Shared plumbing for evidence providers.
 *
 * Every adapter needs the same sequence: build a URL, check the cache, fetch,
 * validate the shape, extract field claims. Only the first, third and last steps
 * differ between providers, so the rest lives here and each adapter reduces to a
 * declaration.
 *
 * Validation of the provider response is not optional. An upstream API is
 * untrusted input: it can change shape without notice, and a payload we
 * misinterpret produces confident evidence that happens to be wrong — which is
 * worse than no evidence at all, because it carries a proof hash.
 */

import { ProviderError } from '@sentinel/shared';
import type { FieldContribution } from '@sentinel/normalizer';
import type { z } from 'zod';
import { cacheKey } from './cache.js';
import type {
  EvidenceProvider,
  EvidenceRequest,
  HttpClient,
  PayloadCache,
  ProviderResult,
} from './types.js';

/** Declarative description of one provider adapter. */
export interface AdapterSpec<T> {
  /** Stable provider identifier. */
  readonly id: string;
  /** Catalog fields this adapter can supply. */
  readonly fields: readonly string[];
  /** Builds the request URL for a subject. */
  buildUrl(request: EvidenceRequest): string;
  /** Schema the response must satisfy. */
  readonly schema: z.ZodType<T>;
  /**
   * Extracts field claims from a validated payload.
   *
   * Must not throw for missing or unusable individual fields — omit them and let
   * the engine fail closed. Values are returned in the provider's own units;
   * conversion and rounding belong to the normalizer.
   */
  extract(payload: T, request: EvidenceRequest): FieldContribution[];
  /** Extra headers, e.g. an API key. Never logged. */
  headers?(): Readonly<Record<string, string>>;
}

/** Dependencies injected into an adapter. */
export interface AdapterDeps {
  readonly http: HttpClient;
  readonly cache: PayloadCache;
}

/**
 * Builds an {@link EvidenceProvider} from a declarative spec.
 *
 * The cache stores the **raw** payload rather than extracted contributions, so a
 * cached entry stays faithful to what the provider actually said. Re-validating
 * and re-extracting on a hit costs microseconds and keeps one code path for both
 * cached and fresh payloads.
 */
export function createProvider<T>(spec: AdapterSpec<T>, deps: AdapterDeps): EvidenceProvider {
  const { http, cache } = deps;

  return {
    id: spec.id,
    fields: spec.fields,

    async fetch(request: EvidenceRequest): Promise<ProviderResult> {
      const key = cacheKey(spec.id, request.chain, request.address);
      const cached = cache.get(key);
      const wasCached = cached !== undefined;

      let payload: unknown;
      if (wasCached) {
        payload = cached;
      } else {
        const url = spec.buildUrl(request);
        const headers = spec.headers?.();
        payload = await http.getJson(url, headers === undefined ? {} : { headers });
        cache.set(key, payload);
      }

      const parsed = spec.schema.safeParse(payload);
      if (!parsed.success) {
        // A shape change is a hard failure for this provider. Reporting the
        // issue paths — but never the payload — keeps the diagnostic useful
        // without echoing upstream content into logs or responses.
        throw new ProviderError(`${spec.id} returned a payload in an unexpected shape.`, {
          details: {
            provider: spec.id,
            issues: parsed.error.issues.slice(0, 5).map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
      }

      return {
        provider: spec.id,
        snapshot: { provider: spec.id, payload },
        contributions: spec.extract(parsed.data, request),
        cached: wasCached,
      };
    },
  };
}

/**
 * Appends a contribution when the value is worth recording.
 *
 * Providers routinely signal "no answer" with `null`, an empty string, or by
 * omitting the key. All three mean the same thing here: contribute nothing, and
 * let the field read as absent so the engine fails closed.
 */
export function contribute(
  into: FieldContribution[],
  provider: string,
  field: string,
  value: unknown,
): void {
  if (value === null || value === undefined || value === '') {
    return;
  }
  into.push({ field, value, provider });
}
