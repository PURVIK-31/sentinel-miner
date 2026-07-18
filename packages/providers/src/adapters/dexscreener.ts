/**
 * DexScreener market data adapter.
 *
 * Supplies the market-side evidence: liquidity, volume, market cap, and the
 * instant the pair was created.
 *
 * Extraction reads no clock. The pair's *creation time* is a stable fact and is
 * contributed as evidence; its *age* is derived at evaluation time from the
 * evaluation context. See docs/adr/0004-evidence-versus-context.md.
 *
 * ## The pair-selection problem
 *
 * DexScreener returns *every* trading pair for a token, across every chain and
 * every DEX. A token routinely has a deep pool on one venue and a dust pool on
 * another. Which pair we read decides what `liquidity_usd` means, so the choice
 * has to be both principled and deterministic.
 *
 * The rule here: filter to the requested chain, then take the pair with the
 * greatest liquidity, breaking ties on `pairAddress` ascending.
 *
 * - *Greatest liquidity* is the honest reading of "how deep is this market",
 *   and it is the pool an aggregator would actually route through.
 * - *The tie-break is not decoration.* Without it, two pairs reporting equal
 *   liquidity would be ordered by however the upstream array happened to arrive,
 *   and evidence — and therefore the proof hash — would vary between identical
 *   requests. Sorting on a stable intrinsic key removes that.
 *
 * Note this deliberately does **not** sum liquidity across pairs. A policy asking
 * "is there $10k of liquidity" is asking whether a trade can be executed against
 * a real pool, and summing dust pools across venues would answer a different,
 * more flattering question.
 */

import { z } from 'zod';
import type { FieldContribution } from '@sentinel/normalizer';
import { contribute, createProvider, type AdapterDeps } from '../base.js';
import type { EvidenceProvider, EvidenceRequest } from '../types.js';

/** DexScreener identifies chains by slug. */
const CHAIN_SLUGS: Readonly<Record<string, string>> = Object.freeze({
  ethereum: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  avalanche: 'avalanche',
});

/** Resolves a chain name to the DexScreener slug. */
export function dexScreenerChainSlug(chain: string): string {
  return CHAIN_SLUGS[chain.toLowerCase()] ?? chain.toLowerCase();
}

/** One trading pair. Every metric is optional; DexScreener omits what it lacks. */
const pairSchema = z
  .object({
    chainId: z.string().optional(),
    pairAddress: z.string().optional(),
    liquidity: z.object({ usd: z.number().optional() }).partial().optional(),
    volume: z.object({ h24: z.number().optional() }).partial().optional(),
    marketCap: z.number().optional(),
    fdv: z.number().optional(),
    /** Pair creation time, milliseconds since epoch. */
    pairCreatedAt: z.number().optional(),
    baseToken: z.object({ symbol: z.string().optional() }).partial().optional(),
  })
  .catchall(z.unknown());

/** The DexScreener response envelope. `pairs` is null when nothing is listed. */
const responseSchema = z.object({
  pairs: z.array(pairSchema).nullable().optional(),
});

/** The validated DexScreener response. */
export type DexScreenerResponse = z.infer<typeof responseSchema>;

/** One validated pair. */
export type DexScreenerPair = z.infer<typeof pairSchema>;

/** Fields this adapter can supply. */
export const DEXSCREENER_FIELDS: readonly string[] = Object.freeze([
  'liquidity_usd',
  'volume_24h_usd',
  'market_cap_usd',
  'pair_created_at_unix',
  'chain',
  'token_symbol',
]);

/**
 * Selects the pair that best represents the token's market on the requested chain.
 *
 * Returns `undefined` when the token has no pair on that chain, which contributes
 * no market evidence at all — the correct outcome for a token that does not
 * trade there.
 */
export function selectPair(
  pairs: readonly DexScreenerPair[],
  chain: string,
): DexScreenerPair | undefined {
  const slug = dexScreenerChainSlug(chain);
  const onChain = pairs.filter((pair) => pair.chainId?.toLowerCase() === slug);
  if (onChain.length === 0) {
    return undefined;
  }

  return [...onChain].sort((a, b) => {
    const byLiquidity = (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
    if (byLiquidity !== 0) {
      return byLiquidity;
    }
    // Deterministic tie-break. Without it, equal-liquidity pairs would be
    // ordered by upstream array order, and proofs would vary between runs.
    return (a.pairAddress ?? '').localeCompare(b.pairAddress ?? '');
  })[0];
}

/** Extracts field claims from a validated DexScreener payload. */
export function extractDexScreener(
  payload: DexScreenerResponse,
  request: EvidenceRequest,
): FieldContribution[] {
  const contributions: FieldContribution[] = [];
  const pair = selectPair(payload.pairs ?? [], request.chain);
  if (pair === undefined) {
    return contributions;
  }

  const add = (field: string, value: unknown): void => {
    contribute(contributions, 'dexscreener', field, value);
  };

  add('liquidity_usd', pair.liquidity?.usd);
  add('volume_24h_usd', pair.volume?.h24);
  // `marketCap` is the reported figure; `fdv` is the fully-diluted fallback.
  add('market_cap_usd', pair.marketCap ?? pair.fdv);
  // The raw millisecond instant. The normalizer converts it to seconds; age is
  // derived at evaluation time from the context, never stored as evidence.
  add('pair_created_at_unix', pair.pairCreatedAt);
  add('chain', pair.chainId);
  add('token_symbol', pair.baseToken?.symbol);

  return contributions;
}

/** Creates the DexScreener evidence provider. */
export function createDexScreenerProvider(
  deps: AdapterDeps,
  baseUrl = 'https://api.dexscreener.com',
): EvidenceProvider {
  return createProvider(
    {
      id: 'dexscreener',
      fields: DEXSCREENER_FIELDS,
      schema: responseSchema,
      buildUrl(request) {
        return `${baseUrl}/latest/dex/tokens/${encodeURIComponent(request.address)}`;
      },
      extract: extractDexScreener,
    },
    deps,
  );
}
