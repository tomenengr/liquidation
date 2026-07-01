import { 
  AaveV3Ethereum, 
  AaveV3Arbitrum, 
  AaveV3Base 
} from '@bgd-labs/aave-address-book';

// Centralized multi-chain addresses
// Uses aave-address-book for Aave V3 contracts
// Uniswap addresses defined per chain

export interface ChainAddresses {
  POOL: string;
  POOL_ADDRESSES_PROVIDER: string;
  ORACLE: string;
  UI_POOL_DATA_PROVIDER: string;
  UNISWAP_SWAP_ROUTER: string;
  UNISWAP_QUOTER_V2: string;
  WETH: string; // Common token for reference
  USDC: string; // Common stable for e2e / limited reserves fetch (config-driven, multi-chain)
  WETH_PRICE_FEED?: string; // Aggregator source for WETH price hack in anvil e2e demo (per-chain)
}

export interface EModeCategoryData {
  ltv: bigint;
  liquidationThreshold: bigint;
  liquidationBonus: bigint;
  label?: string;
}

// Centralized E-Mode category parameters per supported chain (from Aave V3 pool config).
// Used by 0-RPC engine (calculateUserAccountData + profit calc) to override per-asset LT/bonus when user eMode matches reserve's eModeCategory.
// Values sourced from @bgd-labs/aave-address-book + verified pool data; extend for new categories as needed.
// Always prefer config-driven, never hardcode in engine.
export const E_MODE_CATEGORIES: Record<number, Record<number, EModeCategoryData>> = {
  // Ethereum (chain 1)
  1: {
    0: { ltv: 0n, liquidationThreshold: 0n, liquidationBonus: 0n }, // none
    1: { ltv: 9300n, liquidationThreshold: 9500n, liquidationBonus: 10100n, label: "ETH correlated (WETH, wstETH, etc.)" }, // mainnet ETH eMode
    // Add more if needed e.g. 2 for stables etc.
  },
  // Arbitrum (42161)
  42161: {
    0: { ltv: 0n, liquidationThreshold: 0n, liquidationBonus: 0n },
    1: { ltv: 9300n, liquidationThreshold: 9500n, liquidationBonus: 10100n, label: "ETH correlated" },
  },
  // Base (8453)
  8453: {
    0: { ltv: 0n, liquidationThreshold: 0n, liquidationBonus: 0n },
    1: { ltv: 9300n, liquidationThreshold: 9500n, liquidationBonus: 10250n, label: "WETH correlated" },
  },
};

export function getEModeCategoryData(chainId: number, categoryId: number): EModeCategoryData | null {
  const chainModes = E_MODE_CATEGORIES[chainId] || E_MODE_CATEGORIES[1];
  const data = chainModes[categoryId];
  if (data) return data;
  // fallback to 0
  return chainModes[0] || null;
}

const UNISWAP_ADDRESSES: Record<number, { SWAP_ROUTER: string; QUOTER_V2: string }> = {
  // Ethereum Mainnet
  1: {
    SWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    QUOTER_V2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  },
  // Arbitrum One
  42161: {
    SWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    QUOTER_V2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // Verify for exact Arb Quoter if different in prod
  },
  // Base
  8453: {
    SWAP_ROUTER: '0x2626664C2603336E57b271c5c0b26f421741eE7e',
    QUOTER_V2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  },
};

const WETH_BY_CHAIN: Record<number, string> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  8453: '0x4200000000000000000000000000000000000006',
};

const USDC_BY_CHAIN: Record<number, string> = {
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

const WETH_PRICE_FEED_BY_CHAIN: Record<number, string> = {
  1: '0x5424384B256154046E9667dDFaaa5e550145215e',
  42161: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
  8453: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
};

export function getAddresses(chainId: number = 1): ChainAddresses {
  let aave: any;

  switch (chainId) {
    case 1:
      aave = AaveV3Ethereum;
      break;
    case 42161:
      aave = AaveV3Arbitrum;
      break;
    case 8453:
      aave = AaveV3Base;
      break;
    default:
      throw new Error(`Unsupported chainId: ${chainId}. Supported: 1, 42161, 8453`);
  }

  const uniswap = UNISWAP_ADDRESSES[chainId];
  if (!uniswap) {
    throw new Error(`No Uniswap addresses configured for chainId ${chainId}`);
  }

  return {
    POOL: aave.POOL,
    POOL_ADDRESSES_PROVIDER: aave.POOL_ADDRESSES_PROVIDER,
    ORACLE: aave.ORACLE || aave.AAVE_ORACLE || '0x54586bE62E3c3580375aE3723C145253060Ca0C2',
    UI_POOL_DATA_PROVIDER: aave.UI_POOL_DATA_PROVIDER || '0x56b7A1012765C285afAC8b8F25C69Bf10ccfE978',
    UNISWAP_SWAP_ROUTER: uniswap.SWAP_ROUTER,
    UNISWAP_QUOTER_V2: uniswap.QUOTER_V2,
    WETH: WETH_BY_CHAIN[chainId],
    USDC: USDC_BY_CHAIN[chainId],
    WETH_PRICE_FEED: WETH_PRICE_FEED_BY_CHAIN[chainId],
  };
}

// Helper to get current chain addresses from config
export function getCurrentAddresses() {
  // Lazy import to avoid circular deps
  const { config } = require('./config');
  return getAddresses(config.CHAIN_ID);
}