/**
 * Evidence collection across providers.
 *
 * Queries every configured provider concurrently, tolerates individual failures,
 * and hands the surviving contributions to the normalizer.
 *
 * ## Why a failed provider does not fail the request
 *
 * Providers are independent external services with independent failure modes. If
 * one outage aborted the whole evaluation, the miner's availability would be the
 * product of every upstream's availability, and a DexScreener hiccup would take
 * down honeypot detection that GoPlus answered perfectly well.
 *
 * Instead, a failed provider contributes nothing. The fields it would have
 * supplied read as absent, and the engine fails closed on any rule that needed
 * them — BLOCK, with an explanation naming the missing field. The failure is
 * reported in `providerErrors` so an operator can distinguish "the token is
 * risky" from "we could not find out", which are very different situations that
 * both correctly produce BLOCK.
 */

import { toSentinelError, type SentinelError } from '@sentinel/shared';
import {
  normalizeEvidence,
  type FieldContribution,
  type NormalizedBundle,
  type ProviderSnapshot,
} from '@sentinel/normalizer';
import type { EvidenceProvider, EvidenceRequest } from './types.js';

/** A provider that did not answer. */
export interface ProviderFailure {
  readonly provider: string;
  readonly code: string;
  readonly message: string;
  /** Whether retrying the same request unchanged could plausibly succeed. */
  readonly retryable: boolean;
}

/** The outcome of collecting evidence from every provider. */
export interface CollectionResult {
  /** Normalized evidence plus raw payloads, ready for the engine. */
  readonly bundle: NormalizedBundle;
  /** Providers that answered successfully. */
  readonly providersSucceeded: readonly string[];
  /** Providers that failed, with the reason for each. */
  readonly providerErrors: readonly ProviderFailure[];
  /** Providers whose answer was served from cache. */
  readonly providersCached: readonly string[];
}

/** Options for {@link collectEvidence}. */
export interface CollectOptions {
  /**
   * Provider precedence, most trusted first, used to resolve conflicting claims
   * about the same field. Defaults to {@link DEFAULT_PRECEDENCE}.
   */
  readonly precedence?: readonly string[];
}

/**
 * Default precedence, most trusted first.
 *
 * Ordered by how close each provider is to the fact it reports: GoPlus performs
 * dedicated contract security analysis, Basescan reads verification state
 * directly from the chain explorer, and DexScreener aggregates market data whose
 * token metadata is incidental to its purpose. Where two providers claim the
 * same field, the more specialised source wins.
 */
export const DEFAULT_PRECEDENCE: readonly string[] = Object.freeze([
  'goplus',
  'basescan',
  'dexscreener',
]);

/**
 * Collects evidence from every provider.
 *
 * Providers run concurrently — they are independent network calls, and running
 * them in sequence would make latency the sum rather than the maximum. Results
 * are then reassembled in the providers' declared order so that collection is a
 * pure function of its inputs, never of which request happened to resolve first.
 */
export async function collectEvidence(
  providers: readonly EvidenceProvider[],
  request: EvidenceRequest,
  options: CollectOptions = {},
): Promise<CollectionResult> {
  // Each task carries its own provider, so reassembly needs no index lookup —
  // which also means no unreachable "provider not found" branch to defend.
  const outcomes = await Promise.all(
    providers.map(async (provider) => {
      try {
        return { provider, result: await provider.fetch(request) };
      } catch (error: unknown) {
        return { provider, error: toSentinelError(error) };
      }
    }),
  );

  const contributions: FieldContribution[] = [];
  const snapshots: ProviderSnapshot[] = [];
  const providersSucceeded: string[] = [];
  const providersCached: string[] = [];
  const providerErrors: ProviderFailure[] = [];

  // Iterate in provider declaration order, not completion order.
  for (const outcome of outcomes) {
    if ('result' in outcome) {
      const { result } = outcome;
      contributions.push(...result.contributions);
      snapshots.push(result.snapshot);
      providersSucceeded.push(result.provider);
      if (result.cached) {
        providersCached.push(result.provider);
      }
      continue;
    }

    const error: SentinelError = outcome.error;
    providerErrors.push({
      provider: outcome.provider.id,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }

  return {
    bundle: normalizeEvidence(contributions, snapshots, options.precedence ?? DEFAULT_PRECEDENCE),
    providersSucceeded,
    providerErrors,
    providersCached,
  };
}

/**
 * Catalog fields that no configured provider claims to supply.
 *
 * Lets the API warn at configuration time that a policy references a field
 * nothing can answer — a permanent BLOCK that would otherwise only surface as a
 * puzzling missing-evidence result at request time.
 */
export function uncoveredFields(
  providers: readonly EvidenceProvider[],
  fields: readonly string[],
): readonly string[] {
  const covered = new Set(providers.flatMap((provider) => provider.fields));
  return Object.freeze(fields.filter((field) => !covered.has(field)));
}
