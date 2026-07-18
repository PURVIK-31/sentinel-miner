/**
 * Recorded provider payloads.
 *
 * These mirror the shapes the live APIs return, including their quirks: GoPlus
 * sending every value as a string, Basescan delivering errors over HTTP 200,
 * DexScreener returning pairs across several chains at once.
 *
 * Tests replay these rather than calling the network, so the suite is
 * deterministic, needs no API key, and cannot fail because an upstream service
 * is rate limiting. A separate opt-in script re-checks the fixtures against the
 * live APIs; see docs/Development.md.
 */

/** A safe, verified token with low taxes and deep liquidity. */
export const GOPLUS_SAFE_TOKEN = {
  code: 1,
  message: 'OK',
  result: {
    '0x4200000000000000000000000000000000000006': {
      buy_tax: '0',
      sell_tax: '0',
      transfer_tax: '0',
      is_honeypot: '0',
      is_mintable: '0',
      is_proxy: '0',
      can_take_back_ownership: '0',
      owner_address: '',
      token_symbol: 'WETH',
      holder_count: '182043',
      is_open_source: '1',
    },
  },
} as const;

/** A honeypot: high taxes, cannot sell, ownership retained. */
export const GOPLUS_HONEYPOT = {
  code: 1,
  message: 'OK',
  result: {
    '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef': {
      buy_tax: '0.05',
      // 99% sell tax — the classic honeypot signature.
      sell_tax: '0.99',
      is_honeypot: '1',
      is_mintable: '1',
      is_proxy: '0',
      can_take_back_ownership: '1',
      owner_address: '0x1234567890123456789012345678901234567890',
      token_symbol: 'SCAM',
      holder_count: '12',
    },
  },
} as const;

/**
 * A token with a tax that is exactly representable but breaks float conversion.
 *
 * `0.07` is the case where `parseFloat(x) * 10000` yields `700.0000000000001`.
 * Kept as a fixture so the regression is covered end to end, not only in the
 * normalizer's unit tests.
 */
export const GOPLUS_FLOAT_HAZARD = {
  code: 1,
  message: 'OK',
  result: {
    '0x0000000000000000000000000000000000000007': {
      buy_tax: '0.07',
      sell_tax: '0.57',
      is_honeypot: '0',
      token_symbol: 'HAZARD',
    },
  },
} as const;

/** GoPlus declining to answer — an unsupported chain, or an unknown token. */
export const GOPLUS_NO_DATA = {
  code: 4,
  message: 'Contract address not supported',
  result: {},
} as const;

/** DexScreener listing pairs on several chains, with a deliberate liquidity tie. */
export const DEXSCREENER_MULTI_PAIR = {
  pairs: [
    {
      chainId: 'ethereum',
      pairAddress: '0xETH000000000000000000000000000000000000AA',
      liquidity: { usd: 9_000_000 },
      volume: { h24: 500_000 },
      marketCap: 42_000_000,
      pairCreatedAt: 1_600_000_000_000,
      baseToken: { symbol: 'WETH' },
    },
    {
      chainId: 'base',
      pairAddress: '0xBASE00000000000000000000000000000000000BB',
      liquidity: { usd: 125_000.4482 },
      volume: { h24: 88_000.91 },
      marketCap: 12_500_000,
      pairCreatedAt: 1_700_000_000_000,
      baseToken: { symbol: 'WETH' },
    },
    {
      // Same chain, same liquidity as the pair above it in this array. Only the
      // pairAddress tie-break makes the selection deterministic.
      chainId: 'base',
      pairAddress: '0xAAAA000000000000000000000000000000000000',
      liquidity: { usd: 125_000.4482 },
      volume: { h24: 1_000 },
      marketCap: 12_500_000,
      pairCreatedAt: 1_700_000_000_000,
      baseToken: { symbol: 'WETH' },
    },
    {
      // A dust pool on the requested chain: must not be selected.
      chainId: 'base',
      pairAddress: '0xDUST00000000000000000000000000000000000CC',
      liquidity: { usd: 42.5 },
      volume: { h24: 3 },
      baseToken: { symbol: 'WETH' },
    },
  ],
} as const;

/** A token that trades nowhere. */
export const DEXSCREENER_NO_PAIRS = { pairs: null } as const;

/** A pair with no liquidity figure reported at all. */
export const DEXSCREENER_SPARSE = {
  pairs: [
    {
      chainId: 'base',
      pairAddress: '0xSPARSE000000000000000000000000000000000DD',
      baseToken: { symbol: 'THIN' },
    },
  ],
} as const;

/** A verified, non-proxy contract. */
export const BASESCAN_VERIFIED = {
  status: '1',
  message: 'OK',
  result: [
    {
      SourceCode: '{{ "language": "Solidity", "sources": { "src/Token.sol": {} } }}',
      ABI: '[{"inputs":[],"name":"name","outputs":[{"type":"string"}],"type":"function"}]',
      ContractName: 'Token',
      Proxy: '0',
      Implementation: '',
    },
  ],
} as const;

/**
 * An unverified contract.
 *
 * Note `ABI` carries the sentinel string rather than being empty — a naive
 * emptiness check would report this contract as verified.
 */
export const BASESCAN_UNVERIFIED = {
  status: '1',
  message: 'OK',
  result: [
    {
      SourceCode: '',
      ABI: 'Contract source code not verified',
      ContractName: '',
      Proxy: '0',
      Implementation: '',
    },
  ],
} as const;

/** A verified proxy contract. */
export const BASESCAN_PROXY = {
  status: '1',
  message: 'OK',
  result: [
    {
      SourceCode: 'contract Proxy {}',
      ABI: '[{"type":"fallback"}]',
      ContractName: 'ERC1967Proxy',
      Proxy: '1',
      Implementation: '0x1111111111111111111111111111111111111111',
    },
  ],
} as const;

/** An error envelope delivered over HTTP 200. */
export const BASESCAN_ERROR = {
  status: '0',
  message: 'NOTOK',
  result: 'Invalid API Key',
} as const;
