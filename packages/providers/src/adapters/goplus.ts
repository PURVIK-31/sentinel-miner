/**
 * GoPlus token security adapter.
 *
 * GoPlus is the richest source of contract risk signals: honeypot detection,
 * taxes, mintability, proxy status, ownership. Its response shape has two
 * characteristics worth knowing about:
 *
 * - **Everything is a string.** Taxes arrive as decimal fractions like `"0.025"`,
 *   and booleans as `"1"` / `"0"`. The strings are passed through untouched;
 *   the normalizer converts them, because that is where the fail-closed rounding
 *   rules live. Parsing `"0.025"` to a float here would reintroduce exactly the
 *   precision loss ADR 0003 exists to prevent.
 * - **Results are keyed by lower-cased address.** The request echoes the address
 *   back as an object key, not as an array entry, so the lookup must lower-case.
 */

import { z } from 'zod';
import type { FieldContribution } from '@sentinel/normalizer';
import { contribute, createProvider, type AdapterDeps } from '../base.js';
import type { EvidenceProvider, EvidenceRequest } from '../types.js';

/** GoPlus addresses chains by numeric id. */
const CHAIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  ethereum: '1',
  base: '8453',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  optimism: '10',
  avalanche: '43114',
});

/** Resolves a chain name to the id GoPlus expects. */
export function goPlusChainId(chain: string): string | undefined {
  return CHAIN_IDS[chain.toLowerCase()];
}

/**
 * The subset of the GoPlus token result we consume.
 *
 * Deliberately permissive: every field is optional, because GoPlus omits keys it
 * has no data for and adds new ones over time. Only the envelope is required.
 * `catchall` keeps unknown keys in the parsed payload so the raw snapshot stays
 * complete for audit.
 */
const tokenResultSchema = z
  .object({
    buy_tax: z.string().optional(),
    sell_tax: z.string().optional(),
    transfer_tax: z.string().optional(),
    is_honeypot: z.string().optional(),
    is_mintable: z.string().optional(),
    is_proxy: z.string().optional(),
    can_take_back_ownership: z.string().optional(),
    owner_address: z.string().optional(),
    token_symbol: z.string().optional(),
    holder_count: z.string().optional(),
  })
  .catchall(z.unknown());

/** The GoPlus response envelope. */
const responseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  result: z.record(z.string(), tokenResultSchema).optional(),
});

/** The validated GoPlus response. */
export type GoPlusResponse = z.infer<typeof responseSchema>;

/** GoPlus signals success with code 1. */
const SUCCESS_CODE = 1;

/** Fields this adapter can supply. */
export const GOPLUS_FIELDS: readonly string[] = Object.freeze([
  'buy_tax_bp',
  'sell_tax_bp',
  'transfer_tax_bp',
  'is_honeypot',
  'is_mintable',
  'is_proxy',
  'can_take_back_ownership',
  'owner_address',
  'token_symbol',
  'holder_count',
]);

/** Extracts field claims from a validated GoPlus payload. */
export function extractGoPlus(
  payload: GoPlusResponse,
  request: EvidenceRequest,
): FieldContribution[] {
  const contributions: FieldContribution[] = [];

  // A non-success code means GoPlus declined to answer. That is not a transport
  // failure — it contributes nothing, and the engine fails closed on the fields
  // this provider would have covered.
  if (payload.code !== SUCCESS_CODE || payload.result === undefined) {
    return contributions;
  }

  const token = payload.result[request.address.toLowerCase()];
  if (token === undefined) {
    return contributions;
  }

  const add = (field: string, value: unknown): void => {
    contribute(contributions, 'goplus', field, value);
  };

  // Taxes stay as the provider's decimal strings; the normalizer converts them
  // to basis points with exact arithmetic and ceil rounding.
  add('buy_tax_bp', token.buy_tax);
  add('sell_tax_bp', token.sell_tax);
  add('transfer_tax_bp', token.transfer_tax);

  add('is_honeypot', token.is_honeypot);
  add('is_mintable', token.is_mintable);
  add('is_proxy', token.is_proxy);
  add('can_take_back_ownership', token.can_take_back_ownership);

  add('owner_address', token.owner_address);
  add('token_symbol', token.token_symbol);
  add('holder_count', token.holder_count);

  return contributions;
}

/** Creates the GoPlus evidence provider. */
export function createGoPlusProvider(
  deps: AdapterDeps,
  baseUrl = 'https://api.gopluslabs.io',
): EvidenceProvider {
  return createProvider(
    {
      id: 'goplus',
      fields: GOPLUS_FIELDS,
      schema: responseSchema,
      buildUrl(request) {
        // An unmapped chain still produces a request; GoPlus answers with a
        // non-success code, which degrades to "no contribution" rather than an
        // exception. Guessing an id would be worse than asking and being told no.
        const chainId = goPlusChainId(request.chain) ?? request.chain;
        const address = encodeURIComponent(request.address);
        return `${baseUrl}/api/v1/token_security/${encodeURIComponent(chainId)}?contract_addresses=${address}`;
      },
      extract: extractGoPlus,
    },
    deps,
  );
}
