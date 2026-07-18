/**
 * @packageDocumentation
 * Evidence providers: fetch and cache only.
 *
 * Providers never convert units, never apply rounding, and never evaluate a
 * policy. Conversion belongs to `@sentinel/normalizer`, evaluation to
 * `@sentinel/engine`.
 */

export type {
  EvidenceProvider,
  EvidenceRequest,
  ProviderResult,
  HttpClient,
  HttpRequestOptions,
  PayloadCache,
} from './types.js';

export type { HttpClientOptions } from './http.js';
export { createHttpClient, redactUrl, DEFAULT_TIMEOUT_MS } from './http.js';

export type { PayloadCacheOptions } from './cache.js';
export { createPayloadCache, cacheKey, DEFAULT_TTL_SECONDS } from './cache.js';

export type { AdapterSpec, AdapterDeps } from './base.js';
export { createProvider, contribute } from './base.js';

export type { ProviderFailure, CollectionResult, CollectOptions } from './collector.js';
export { collectEvidence, uncoveredFields, DEFAULT_PRECEDENCE } from './collector.js';

export type { GoPlusResponse } from './adapters/goplus.js';
export {
  createGoPlusProvider,
  extractGoPlus,
  goPlusChainId,
  GOPLUS_FIELDS,
} from './adapters/goplus.js';

export type { DexScreenerResponse, DexScreenerPair } from './adapters/dexscreener.js';
export {
  createDexScreenerProvider,
  extractDexScreener,
  selectPair,
  pairAgeSeconds,
  dexScreenerChainSlug,
  DEXSCREENER_FIELDS,
} from './adapters/dexscreener.js';

export type { BasescanResponse, BasescanOptions } from './adapters/basescan.js';
export {
  createBasescanProvider,
  extractBasescan,
  isVerified,
  BASESCAN_FIELDS,
} from './adapters/basescan.js';
