import { describe, it, expect, vi } from 'vitest';
import { createPayloadCache } from '../cache.js';
import { redactUrl } from '../http.js';
import { createGoPlusProvider } from './goplus.js';
import { createDexScreenerProvider } from './dexscreener.js';
import { createBasescanProvider } from './basescan.js';
import { GOPLUS_SAFE_TOKEN, DEXSCREENER_MULTI_PAIR, BASESCAN_VERIFIED } from '../fixtures/index.js';
import type { AdapterDeps } from '../base.js';
import type { EvidenceRequest } from '../types.js';

const WETH = '0x4200000000000000000000000000000000000006';
const REQUEST: EvidenceRequest = { chain: 'base', address: WETH };

/** Captures the URL an adapter requests, replying with a fixture. */
const capturing = (payload: unknown): { deps: AdapterDeps; url: () => string } => {
  let captured = '';
  const deps: AdapterDeps = {
    http: {
      getJson: vi.fn((url: string) => {
        captured = url;
        return Promise.resolve(payload);
      }),
    },
    cache: createPayloadCache(),
  };
  return { deps, url: () => captured };
};

describe('GoPlus provider', () => {
  it('requests the numeric chain id, not the chain name', async () => {
    const { deps, url } = capturing(GOPLUS_SAFE_TOKEN);
    await createGoPlusProvider(deps).fetch(REQUEST);
    expect(url()).toContain('/token_security/8453');
    expect(url()).toContain(`contract_addresses=${WETH}`);
  });

  it('falls back to the raw chain value for an unmapped chain', async () => {
    const { deps, url } = capturing(GOPLUS_SAFE_TOKEN);
    await createGoPlusProvider(deps).fetch({ chain: 'zksync', address: WETH });
    expect(url()).toContain('/token_security/zksync');
  });

  it('declares the fields it supplies', () => {
    const provider = createGoPlusProvider(capturing({}).deps);
    expect(provider.id).toBe('goplus');
    expect(provider.fields).toContain('is_honeypot');
  });

  it('honours a custom base URL', async () => {
    const { deps, url } = capturing(GOPLUS_SAFE_TOKEN);
    await createGoPlusProvider(deps, 'https://mirror.test').fetch(REQUEST);
    expect(url().startsWith('https://mirror.test/')).toBe(true);
  });

  it('returns extracted contributions end to end', async () => {
    const result = await createGoPlusProvider(capturing(GOPLUS_SAFE_TOKEN).deps).fetch(REQUEST);
    expect(result.provider).toBe('goplus');
    expect(result.contributions.map((c) => c.field)).toContain('is_honeypot');
  });
});

describe('DexScreener provider', () => {
  it('requests the token endpoint with the address path-encoded', async () => {
    const { deps, url } = capturing(DEXSCREENER_MULTI_PAIR);
    await createDexScreenerProvider(deps).fetch(REQUEST);
    expect(url()).toBe(`https://api.dexscreener.com/latest/dex/tokens/${WETH}`);
  });

  it('honours a custom base URL', async () => {
    const { deps, url } = capturing(DEXSCREENER_MULTI_PAIR);
    await createDexScreenerProvider(deps, 'https://mirror.test').fetch(REQUEST);
    expect(url().startsWith('https://mirror.test/')).toBe(true);
  });

  it('selects the on-chain pair through the full provider path', async () => {
    const result = await createDexScreenerProvider(capturing(DEXSCREENER_MULTI_PAIR).deps).fetch(
      REQUEST,
    );
    const liquidity = result.contributions.find((c) => c.field === 'liquidity_usd');
    expect(liquidity?.value).toBe(125_000.4482);
  });
});

describe('Basescan provider', () => {
  it('builds an Etherscan-style query for the requested chain', async () => {
    const { deps, url } = capturing(BASESCAN_VERIFIED);
    await createBasescanProvider(deps).fetch(REQUEST);
    expect(url()).toContain('https://api.basescan.org/api?');
    expect(url()).toContain('module=contract');
    expect(url()).toContain('action=getsourcecode');
    expect(url()).toContain(`address=${WETH}`);
  });

  it('routes an ethereum request to the Etherscan endpoint', async () => {
    const { deps, url } = capturing(BASESCAN_VERIFIED);
    await createBasescanProvider(deps).fetch({ chain: 'ethereum', address: WETH });
    expect(url()).toContain('api.etherscan.io');
  });

  it('defaults an unknown chain to the Base endpoint', async () => {
    const { deps, url } = capturing(BASESCAN_VERIFIED);
    await createBasescanProvider(deps).fetch({ chain: 'unknown', address: WETH });
    expect(url()).toContain('api.basescan.org');
  });

  it('includes the API key when one is configured', async () => {
    const { deps, url } = capturing(BASESCAN_VERIFIED);
    await createBasescanProvider(deps, { apiKey: 'SUPERSECRET' }).fetch(REQUEST);
    expect(url()).toContain('apikey=SUPERSECRET');
  });

  it('omits the key entirely when absent or blank, rather than sending an empty one', async () => {
    for (const apiKey of [undefined, '']) {
      const { deps, url } = capturing(BASESCAN_VERIFIED);
      await createBasescanProvider(deps, apiKey === undefined ? {} : { apiKey }).fetch(REQUEST);
      expect(url()).not.toContain('apikey');
    }
  });

  it('keeps the configured key out of any diagnostic rendering of the URL', async () => {
    // The key is in the URL by necessity; redaction is what keeps it out of logs.
    const { deps, url } = capturing(BASESCAN_VERIFIED);
    await createBasescanProvider(deps, { apiKey: 'SUPERSECRET' }).fetch(REQUEST);
    expect(redactUrl(url())).not.toContain('SUPERSECRET');
    expect(redactUrl(url())).toContain('REDACTED');
  });

  it('honours a custom base URL over the chain default', async () => {
    const { deps, url } = capturing(BASESCAN_VERIFIED);
    await createBasescanProvider(deps, { baseUrl: 'https://mirror.test' }).fetch({
      chain: 'ethereum',
      address: WETH,
    });
    expect(url().startsWith('https://mirror.test/api?')).toBe(true);
  });

  it('reports verification through the full provider path', async () => {
    const result = await createBasescanProvider(capturing(BASESCAN_VERIFIED).deps).fetch(REQUEST);
    expect(result.contributions).toContainEqual({
      field: 'contract_verified',
      value: true,
      provider: 'basescan',
    });
  });
});
