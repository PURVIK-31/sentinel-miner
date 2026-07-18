/**
 * Basescan contract verification adapter.
 *
 * Supplies the on-chain contract attributes: whether source is verified, and
 * whether the contract is a proxy.
 *
 * Basescan uses the Etherscan API conventions, which have two traps:
 *
 * - **Errors arrive as HTTP 200.** A failed lookup returns `status: "0"` with a
 *   message, not a 4xx. Treating the transport status as success would read an
 *   error envelope as data.
 * - **"Not verified" is signalled by a sentinel string,** not by an empty field.
 *   An unverified contract returns `ABI: "Contract source code not verified"`,
 *   which is a perfectly valid non-empty string and would read as verified if
 *   only emptiness were checked.
 *
 * The API key travels as a query parameter, so every URL built here is redacted
 * before it can reach a log or an error message. See `redactUrl` in http.ts.
 */

import { z } from 'zod';
import type { FieldContribution } from '@sentinel/normalizer';
import { contribute, createProvider, type AdapterDeps } from '../base.js';
import type { EvidenceProvider, EvidenceRequest } from '../types.js';

/** Etherscan-family default endpoints, by chain. */
const BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  base: 'https://api.basescan.org',
  ethereum: 'https://api.etherscan.io',
});

/** The exact string Etherscan-family APIs return for an unverified contract. */
const UNVERIFIED_SENTINEL = 'Contract source code not verified';

/** One contract source record. */
const sourceRecordSchema = z
  .object({
    SourceCode: z.string().optional(),
    ABI: z.string().optional(),
    ContractName: z.string().optional(),
    Proxy: z.string().optional(),
    Implementation: z.string().optional(),
  })
  .catchall(z.unknown());

/**
 * The response envelope.
 *
 * `result` is an array on success and a bare string on some error paths, so the
 * schema accepts both rather than rejecting a legitimate error response as
 * malformed.
 */
const responseSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  result: z.union([z.array(sourceRecordSchema), z.string()]).optional(),
});

/** The validated Basescan response. */
export type BasescanResponse = z.infer<typeof responseSchema>;

/** Basescan signals success with status "1". */
const SUCCESS_STATUS = '1';

/** Fields this adapter can supply. */
export const BASESCAN_FIELDS: readonly string[] = Object.freeze(['contract_verified', 'is_proxy']);

/**
 * Decides whether a contract counts as verified.
 *
 * Requires non-empty source **and** an ABI that is not the sentinel. Either
 * alone is insufficient: a proxy can carry an ABI with no source, and the
 * sentinel is a non-empty string that would otherwise pass a naive check.
 */
export function isVerified(record: {
  // `| undefined` is explicit because `exactOptionalPropertyTypes` distinguishes
  // "key absent" from "key present holding undefined", and the parsed payload
  // produces the latter.
  SourceCode?: string | undefined;
  ABI?: string | undefined;
}): boolean {
  const hasSource = (record.SourceCode ?? '').trim().length > 0;
  const abi = (record.ABI ?? '').trim();
  const abiIsReal = abi.length > 0 && abi !== UNVERIFIED_SENTINEL;
  return hasSource && abiIsReal;
}

/** Extracts field claims from a validated Basescan payload. */
export function extractBasescan(payload: BasescanResponse): FieldContribution[] {
  const contributions: FieldContribution[] = [];

  // status "0" is an error envelope delivered over HTTP 200. It contributes
  // nothing rather than being misread as data.
  if (payload.status !== SUCCESS_STATUS || !Array.isArray(payload.result)) {
    return contributions;
  }

  const record = payload.result[0];
  if (record === undefined) {
    return contributions;
  }

  const add = (field: string, value: unknown): void => {
    contribute(contributions, 'basescan', field, value);
  };

  add('contract_verified', isVerified(record));

  // `Proxy` is "1" or "0"; the normalizer maps those to booleans. Anything else
  // is left out rather than guessed at.
  if (record.Proxy === '1' || record.Proxy === '0') {
    add('is_proxy', record.Proxy);
  }

  return contributions;
}

/** Configuration for the Basescan adapter. */
export interface BasescanOptions {
  /** API key. Sent as a query parameter and redacted from all diagnostics. */
  readonly apiKey?: string;
  /** Override the endpoint, e.g. for a different Etherscan-family chain. */
  readonly baseUrl?: string;
}

/** Creates the Basescan evidence provider. */
export function createBasescanProvider(
  deps: AdapterDeps,
  options: BasescanOptions = {},
): EvidenceProvider {
  return createProvider(
    {
      id: 'basescan',
      fields: BASESCAN_FIELDS,
      schema: responseSchema,
      buildUrl(request: EvidenceRequest) {
        const base = options.baseUrl ?? BASE_URLS[request.chain.toLowerCase()] ?? BASE_URLS.base;
        const params = new URLSearchParams({
          module: 'contract',
          action: 'getsourcecode',
          address: request.address,
        });
        // Etherscan-family APIs accept keyless requests at a reduced rate limit,
        // so a missing key degrades throughput rather than breaking the provider.
        if (options.apiKey !== undefined && options.apiKey !== '') {
          params.set('apikey', options.apiKey);
        }
        return `${String(base)}/api?${params.toString()}`;
      },
      extract: extractBasescan,
    },
    deps,
  );
}
