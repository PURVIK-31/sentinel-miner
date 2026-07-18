import { describe, it, expect } from 'vitest';
import { normalizeEvidence } from '@sentinel/normalizer';
import { extractGoPlus, goPlusChainId } from './goplus.js';
import {
  extractDexScreener,
  selectPair,
  pairAgeSeconds,
  dexScreenerChainSlug,
} from './dexscreener.js';
import { extractBasescan, isVerified } from './basescan.js';
import {
  GOPLUS_SAFE_TOKEN,
  GOPLUS_HONEYPOT,
  GOPLUS_FLOAT_HAZARD,
  GOPLUS_NO_DATA,
  DEXSCREENER_MULTI_PAIR,
  DEXSCREENER_NO_PAIRS,
  DEXSCREENER_SPARSE,
  BASESCAN_VERIFIED,
  BASESCAN_UNVERIFIED,
  BASESCAN_PROXY,
  BASESCAN_ERROR,
} from '../fixtures/index.js';
import type { FieldContribution } from '@sentinel/normalizer';

/** Indexes contributions by field for terse assertions. */
const byField = (contributions: readonly FieldContribution[]): Record<string, unknown> =>
  Object.fromEntries(contributions.map((c) => [c.field, c.value]));

const WETH = '0x4200000000000000000000000000000000000006';

describe('GoPlus adapter', () => {
  it('maps chain names to GoPlus numeric ids', () => {
    expect(goPlusChainId('base')).toBe('8453');
    expect(goPlusChainId('BASE')).toBe('8453');
    expect(goPlusChainId('ethereum')).toBe('1');
    expect(goPlusChainId('nonexistent')).toBeUndefined();
  });

  it('extracts security fields from a safe token', () => {
    const fields = byField(extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH }));
    expect(fields).toMatchObject({
      buy_tax_bp: '0',
      sell_tax_bp: '0',
      is_honeypot: '0',
      token_symbol: 'WETH',
      holder_count: '182043',
    });
  });

  it('passes tax values through as strings, never parsing them to floats', () => {
    // Parsing here would reintroduce the precision loss ADR 0003 prevents.
    const fields = byField(
      extractGoPlus(GOPLUS_FLOAT_HAZARD, {
        chain: 'base',
        address: '0x0000000000000000000000000000000000000007',
      }),
    );
    expect(fields['buy_tax_bp']).toBe('0.07');
    expect(typeof fields['buy_tax_bp']).toBe('string');
  });

  it('produces exact basis points once normalized, end to end', () => {
    const contributions = extractGoPlus(GOPLUS_FLOAT_HAZARD, {
      chain: 'base',
      address: '0x0000000000000000000000000000000000000007',
    });
    const bundle = normalizeEvidence(contributions);
    // The naive float path would give 701 and 5699.
    expect(bundle.evidence['buy_tax_bp']).toBe(700);
    expect(bundle.evidence['sell_tax_bp']).toBe(5700);
  });

  it('extracts honeypot signals', () => {
    const fields = byField(
      extractGoPlus(GOPLUS_HONEYPOT, {
        chain: 'base',
        address: '0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF',
      }),
    );
    expect(fields['is_honeypot']).toBe('1');
    expect(fields['sell_tax_bp']).toBe('0.99');
  });

  it('looks the address up case-insensitively', () => {
    // The request may carry a checksummed address; GoPlus keys by lower case.
    const upper = extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH.toUpperCase() });
    expect(upper.length).toBeGreaterThan(0);
  });

  it('contributes nothing when GoPlus declines to answer', () => {
    expect(extractGoPlus(GOPLUS_NO_DATA, { chain: 'base', address: WETH })).toEqual([]);
  });

  it('contributes nothing for a token absent from the result set', () => {
    expect(extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: '0xother' })).toEqual([]);
  });

  it('omits empty-string fields rather than contributing blanks', () => {
    const fields = byField(extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH }));
    // owner_address is "" in the fixture — a renounced contract.
    expect('owner_address' in fields).toBe(false);
  });

  it('attributes every contribution to goplus', () => {
    const contributions = extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH });
    expect(contributions.every((c) => c.provider === 'goplus')).toBe(true);
  });
});

describe('DexScreener adapter', () => {
  it('maps chain names to slugs, passing unknown ones through', () => {
    expect(dexScreenerChainSlug('base')).toBe('base');
    expect(dexScreenerChainSlug('BASE')).toBe('base');
    expect(dexScreenerChainSlug('unknown-chain')).toBe('unknown-chain');
  });

  it('selects the deepest pool on the requested chain', () => {
    const pair = selectPair(DEXSCREENER_MULTI_PAIR.pairs, 'base');
    expect(pair?.liquidity?.usd).toBe(125_000.4482);
  });

  it('never selects a pair from a different chain, however deep', () => {
    // The ethereum pair has 9M liquidity; the base request must ignore it.
    const pair = selectPair(DEXSCREENER_MULTI_PAIR.pairs, 'base');
    expect(pair?.chainId).toBe('base');
  });

  it('breaks a liquidity tie deterministically by pair address', () => {
    // Two base pairs report identical liquidity. Without the tie-break the
    // winner would depend on upstream array order, and proofs would vary.
    const pair = selectPair(DEXSCREENER_MULTI_PAIR.pairs, 'base');
    expect(pair?.pairAddress).toBe('0xAAAA000000000000000000000000000000000000');
  });

  it('selects the same pair regardless of the order pairs arrive in', () => {
    const forward = selectPair(DEXSCREENER_MULTI_PAIR.pairs, 'base');
    const reversed = selectPair([...DEXSCREENER_MULTI_PAIR.pairs].reverse(), 'base');
    expect(reversed?.pairAddress).toBe(forward?.pairAddress);
  });

  it('does not sum liquidity across pools', () => {
    // Summing would flatter a token by counting dust pools toward a threshold.
    const fields = byField(
      extractDexScreener(DEXSCREENER_MULTI_PAIR, { chain: 'base', address: WETH }, 0),
    );
    expect(fields['liquidity_usd']).toBe(125_000.4482);
  });

  it('returns nothing when the token has no pair on the chain', () => {
    expect(selectPair(DEXSCREENER_MULTI_PAIR.pairs, 'solana')).toBeUndefined();
    expect(extractDexScreener(DEXSCREENER_NO_PAIRS, { chain: 'base', address: WETH }, 0)).toEqual(
      [],
    );
  });

  it('contributes only the fields a sparse pair actually reports', () => {
    const fields = byField(
      extractDexScreener(DEXSCREENER_SPARSE, { chain: 'base', address: WETH }, 0),
    );
    expect('liquidity_usd' in fields).toBe(false);
    expect(fields['token_symbol']).toBe('THIN');
  });

  it('falls back to fdv when marketCap is absent', () => {
    const payload = {
      pairs: [{ chainId: 'base', pairAddress: '0xa', fdv: 999, liquidity: { usd: 1 } }],
    };
    const fields = byField(extractDexScreener(payload, { chain: 'base', address: WETH }, 0));
    expect(fields['market_cap_usd']).toBe(999);
  });
});

describe('pairAgeSeconds', () => {
  const created = 1_700_000_000_000;

  it('computes whole seconds of age', () => {
    expect(pairAgeSeconds(created, created + 90_000)).toBe(90);
  });

  it('floors partial seconds', () => {
    expect(pairAgeSeconds(created, created + 1_999)).toBe(1);
  });

  it('returns zero for a pair created this instant', () => {
    expect(pairAgeSeconds(created, created)).toBe(0);
  });

  it('returns undefined for a future timestamp rather than a negative age', () => {
    // A negative count would be rejected downstream; absent is the honest answer.
    expect(pairAgeSeconds(created, created - 5_000)).toBeUndefined();
  });

  it('returns undefined when no creation time is reported', () => {
    expect(pairAgeSeconds(undefined, created)).toBeUndefined();
    expect(pairAgeSeconds(Number.NaN, created)).toBeUndefined();
  });
});

describe('Basescan adapter', () => {
  it('reports a verified contract', () => {
    const fields = byField(extractBasescan(BASESCAN_VERIFIED));
    expect(fields['contract_verified']).toBe(true);
    expect(fields['is_proxy']).toBe('0');
  });

  it('does not mistake the unverified sentinel for a real ABI', () => {
    // "Contract source code not verified" is a non-empty string; an emptiness
    // check alone would report this contract as verified.
    expect(isVerified({ SourceCode: '', ABI: 'Contract source code not verified' })).toBe(false);
    expect(byField(extractBasescan(BASESCAN_UNVERIFIED))['contract_verified']).toBe(false);
  });

  it('requires both source and a real ABI', () => {
    expect(isVerified({ SourceCode: 'contract X {}', ABI: '[]' })).toBe(true);
    expect(isVerified({ SourceCode: 'contract X {}', ABI: '' })).toBe(false);
    expect(isVerified({ SourceCode: '   ', ABI: '[]' })).toBe(false);
    expect(isVerified({})).toBe(false);
  });

  it('reports a proxy contract', () => {
    const fields = byField(extractBasescan(BASESCAN_PROXY));
    expect(fields['is_proxy']).toBe('1');
    expect(fields['contract_verified']).toBe(true);
  });

  it('contributes nothing for an error envelope delivered over HTTP 200', () => {
    // status "0" with a string result must not be read as data.
    expect(extractBasescan(BASESCAN_ERROR)).toEqual([]);
  });

  it('contributes nothing for an empty result array', () => {
    expect(extractBasescan({ status: '1', result: [] })).toEqual([]);
  });

  it('omits is_proxy when the flag is not a recognised value', () => {
    const fields = byField(
      extractBasescan({
        status: '1',
        result: [{ SourceCode: 'x', ABI: '[]', Proxy: 'maybe' }],
      }),
    );
    expect('is_proxy' in fields).toBe(false);
    expect(fields['contract_verified']).toBe(true);
  });
});

describe('adapters feed the normalizer correctly', () => {
  it('produces integer evidence from a full provider sweep', () => {
    const contributions = [
      ...extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH }),
      ...extractDexScreener(DEXSCREENER_MULTI_PAIR, { chain: 'base', address: WETH }, 0),
      ...extractBasescan(BASESCAN_VERIFIED),
    ];
    const bundle = normalizeEvidence(contributions, [], ['goplus', 'basescan', 'dexscreener']);

    expect(bundle.evidence).toMatchObject({
      buy_tax_bp: 0,
      sell_tax_bp: 0,
      is_honeypot: false,
      contract_verified: true,
      holder_count: 182043,
      // 125000.4482 floored — liquidity never rounds up.
      liquidity_usd: 125000,
      // Read from the tie-break winner (0xAAAA), whose 24h volume is 1000.
      volume_24h_usd: 1000,
      chain: 'base',
    });
  });

  it('resolves the token_symbol conflict in favour of the higher-precedence provider', () => {
    // Both GoPlus and DexScreener report a symbol.
    const contributions = [
      ...extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH }),
      ...extractDexScreener(DEXSCREENER_MULTI_PAIR, { chain: 'base', address: WETH }, 0),
    ];
    const bundle = normalizeEvidence(contributions, [], ['goplus', 'dexscreener']);
    expect(bundle.sources['token_symbol']).toBe('goplus');
  });

  it('records no normalization issues for well-formed fixtures', () => {
    const contributions = [
      ...extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH }),
      ...extractBasescan(BASESCAN_VERIFIED),
    ];
    const bundle = normalizeEvidence(contributions, [], ['goplus', 'basescan']);
    expect(bundle.issues).toEqual([]);
  });

  it('reports GoPlus winning is_proxy over Basescan as supersession, not a problem', () => {
    // Both providers legitimately report is_proxy; the more specialised one wins.
    const contributions = [
      ...extractGoPlus(GOPLUS_SAFE_TOKEN, { chain: 'base', address: WETH }),
      ...extractBasescan(BASESCAN_VERIFIED),
    ];
    const bundle = normalizeEvidence(contributions, [], ['goplus', 'basescan']);
    expect(bundle.issues).toEqual([]);
    expect(bundle.superseded).toEqual([
      { field: 'is_proxy', provider: 'basescan', winner: 'goplus' },
    ]);
  });
});
