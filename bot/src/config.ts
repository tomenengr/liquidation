import * as dotenv from 'dotenv';
import * as path from 'path';
import { getAddresses, ChainAddresses, getEModeCategoryData, EModeCategoryData } from './addresses';
import { ethers } from 'ethers';

dotenv.config();

/**
 * Derive per-chain RPC URL from a base (e.g. user's Alchemy ETH key URL) using common key pattern.
 * Supports Alchemy: https://eth-mainnet.g.alchemy.com/v2/KEY  -> arb-mainnet / base-mainnet variants.
 * If per-chain explicit set in env, prefer it (no derive).
 * This ensures getChainConfig always returns correct RPC per CHAIN_ID without forcing user to duplicate keys.
 * Preserves 0-RPC paths (no RPC needed for calc itself).
 */
function deriveAlchemyRpc(baseRpc: string, target: 'arb' | 'base'): string {
  if (!baseRpc || !baseRpc.includes('alchemy.com/v2/')) {
    return baseRpc; // non-alchemy, return as-is (user must provide explicit for L2)
  }
  const hostMap: Record<'arb'|'base', string> = {
    arb: 'arb-mainnet.g.alchemy.com',
    base: 'base-mainnet.g.alchemy.com',
  };
  try {
    const u = new URL(baseRpc);
    u.hostname = hostMap[target];
    return u.toString();
  } catch {
    // fallback string replace for robustness
    return baseRpc.replace(/eth-mainnet\.g\.alchemy\.com/g, `${target}-mainnet.g.alchemy.com`);
  }
}

// Centralized configuration for the liquidation bot.
// Values can be overridden via environment variables for different environments (Anvil, mainnet, L2, etc.).
// Use config.getChainConfig(CHAIN_ID) for all access (multi-chain aware).

export const config = {
  // RPC (primary, can be overridden per chain)
  // Note: per-chain explicit preferred; getChainConfig will derive from RPC_URL key pattern if unset.
  RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8545',
  ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL || '',
  BASE_RPC_URL: process.env.BASE_RPC_URL || '',

  // RPC Fallbacks (Task 3.04/3.05) - Comma separated lists
  RPC_FALLBACKS: (process.env.RPC_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean),
  RPC_FALLBACKS_ARBITRUM: (process.env.RPC_FALLBACKS_ARBITRUM || '').split(',').map(s => s.trim()).filter(Boolean),
  RPC_FALLBACKS_BASE: (process.env.RPC_FALLBACKS_BASE || '').split(',').map(s => s.trim()).filter(Boolean),

  // Chain (for multi-chain / L2 support)
  CHAIN_ID: Number(process.env.CHAIN_ID || 1), // 1=mainnet, 42161=arbitrum, 8453=base etc.
  IS_L2: process.env.IS_L2 === 'true' || false,

  // Uniswap (Quoter addresses may differ per chain; override per env for L2)
  UNISWAP_QUOTER_V2: process.env.UNISWAP_QUOTER_V2 || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  UNISWAP_FEE_TIERS: [500n, 3000n, 10000n], // 0.05%, 0.3%, 1% — tried in order of preference for best quote

  // Production filters (in base currency with 8 decimals, e.g. $500 = 500_00000000n)
  // Tunable via env for different chains (lower on L2 due to cheap gas)
  MIN_DEBT_BASE: BigInt(process.env.MIN_DEBT_BASE || 500_00000000),       // $500 minimum debt
  MIN_NET_PROFIT_BASE: BigInt(process.env.MIN_NET_PROFIT_BASE || 50_00000000), // $50 minimum net profit (after fees/slippage)

  // MEV / Execution
  BRIBE_PERCENT: Number(process.env.BRIBE_PERCENT || 50), // % of net profit to allocate as builder bribe (off-chain)
  FLASHLOAN_FEE_BPS: 5n, // 0.05% — Aave V3 standard

  // Gas modeling (pessimistic defaults; can be chain-specific)
  BASE_GAS_LIMIT: 250000n,

  // DB for persistence (Task 3.7)
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', `bot-${process.env.CHAIN_ID || 1}.db`),

  // Subgraph (hosted The Graph, Task 3.6)
  // Set GRAPH_API_KEY in .env for authenticated queries (higher rate limits)
  GRAPH_API_KEY: process.env.GRAPH_API_KEY || '',
  SUBGRAPH_URL_ETHEREUM: process.env.SUBGRAPH_URL_ETHEREUM || 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3',
  SUBGRAPH_URL_ARBITRUM: process.env.SUBGRAPH_URL_ARBITRUM || 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
  SUBGRAPH_URL_BASE: process.env.SUBGRAPH_URL_BASE || 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-base',

  // Hybrid sync (Task 3.8)
  USE_SUBGRAPH_DISCOVERY: process.env.USE_SUBGRAPH_DISCOVERY === 'true' || true, // default on for extension
  MAX_DISCOVERED_USERS: Number(process.env.MAX_DISCOVERED_USERS || 200),

  // 3.10 price vol
  VOLATILITY_SLIP_ADJ_FACTOR: Number(process.env.VOLATILITY_SLIP_ADJ_FACTOR || 4),

  // For testing full link without live/fork RPC or to bypass Quoter (Task 3.12 + limitations).
  // Default=false: use REAL QuoterV2 via provided RPC (live or Anvil fork) for verifyAndRoute.
  // Set MOCK_QUOTER=true ONLY to force mock (e.g. pure offchain calc test, or no RPC).
  // ExecutionRouter uses real when RPC provided AND not explicitly mocked. See ExecutionRouter.ts.
  MOCK_QUOTER: process.env.MOCK_QUOTER === 'true' || false,

  // prod-002 start (MEV): MOCK_MEV (default true for safety/sim compat). Set false for real bundle paths.
  // Per-chain MEV_RELAY (Flashbots for ETH; L2 builders/direct via high tip or specific RPC).
  // Added minimal; exposed in getChainConfig. TDD for bundle logic.
  MOCK_MEV: process.env.MOCK_MEV !== 'false', // default true = sim only
  MEV_RELAY_ETHEREUM: process.env.MEV_RELAY_ETHEREUM || 'https://relay.flashbots.net',
  MEV_RELAY_ARBITRUM: process.env.MEV_RELAY_ARBITRUM || '',
  MEV_RELAY_BASE: process.env.MEV_RELAY_BASE || '',
  FLASHBOTS_AUTH_KEY: process.env.FLASHBOTS_AUTH_KEY || undefined,

  // Reconciliation & Health (Task 1.9)
  RECONCILIATION_INTERVAL_MS: Number(process.env.RECONCILIATION_INTERVAL_MS || 30000),
  RECONCILIATION_HF_TOLERANCE: BigInt(process.env.RECONCILIATION_HF_TOLERANCE || '10000000000000'),
  RECONCILIATION_COL_DEBT_TOLERANCE: BigInt(process.env.RECONCILIATION_COL_DEBT_TOLERANCE || '100000'),
  RECONCILIATION_LOG_FILE: process.env.RECONCILIATION_LOG_FILE || 'reconciliation.log',

  // Operational (1.13)
  OPPORTUNITY_LOG_FILE: process.env.OPPORTUNITY_LOG_FILE || 'opportunities.log',
  STRUCTURED_LOG: process.env.STRUCTURED_LOG === 'true' || false,
  BACKPRESSURE_MAX_PER_BLOCK: Number(process.env.BACKPRESSURE_MAX_PER_BLOCK || 5),

  // Execution config (prod-001.02 - CRITICAL centralization):
  // DRY_RUN_EXECUTION (default true for safety) - set false to allow real execution.
  // LIQUIDATOR_ADDRESS (optional per-chain override) - used by future executor.
  // PRIVATE_KEY accessor (never hardcoded; supports dry-run when absent).
  // All access via config.getChainConfig(...) or helpers below. Exposes in getChainConfig return.
  // Multi-chain aware: LIQUIDATOR per-chain via LIQUIDATOR_ADDRESS_*, PRIVATE_KEY/DRY shared (or override in env before switch).
  // Preserves: optional for dry-run paths; secrets-check guards git.
  DRY_RUN_EXECUTION: process.env.DRY_RUN_EXECUTION !== 'false',
  LIQUIDATOR_ADDRESS: process.env.LIQUIDATOR_ADDRESS || undefined,
  PRIVATE_KEY: process.env.PRIVATE_KEY || undefined,

  // Methods (centralized, config-driven)
  getChainConfig(chainId?: number) {
    const id = chainId ?? this.CHAIN_ID;
    const isL2 = id === 42161 || id === 8453;
    const addrs = this.getAddresses(id);

    // Select per-chain RPC URL (use explicit if set, else derive using user's key pattern for Alchemy etc.)
    // This fixes per-CHAIN_ID resolution for ETH/ARB/BASE. Multi-chain aware. Do NOT hardcode.
    let rpcUrl = this.RPC_URL;
    let rpcFallbacks = this.RPC_FALLBACKS;
    if (id === 42161) {
      rpcUrl = this.ARBITRUM_RPC_URL || deriveAlchemyRpc(this.RPC_URL, 'arb') || this.RPC_URL;
      rpcFallbacks = this.RPC_FALLBACKS_ARBITRUM.length > 0 
        ? this.RPC_FALLBACKS_ARBITRUM 
        : this.RPC_FALLBACKS.map(f => deriveAlchemyRpc(f, 'arb'));
    } else if (id === 8453) {
      rpcUrl = this.BASE_RPC_URL || deriveAlchemyRpc(this.RPC_URL, 'base') || this.RPC_URL;
      rpcFallbacks = this.RPC_FALLBACKS_BASE.length > 0 
        ? this.RPC_FALLBACKS_BASE 
        : this.RPC_FALLBACKS.map(f => deriveAlchemyRpc(f, 'base'));
    }

    // Per-chain defaults (can be overridden via env)
    const minDebt = isL2
      ? BigInt(process.env.MIN_DEBT_BASE || 100_00000000)
      : this.MIN_DEBT_BASE;
    const minProfit = isL2
      ? BigInt(process.env.MIN_NET_PROFIT_BASE || 10_00000000)
      : this.MIN_NET_PROFIT_BASE;

    // Per-chain execution config resolution (prod-001.02)
    // DRY_RUN defaults safe (true); LIQUIDATOR supports per-chain env override e.g. LIQUIDATOR_ADDRESS_BASE
    // PRIVATE_KEY is optional (null wallet for pure dry-run / 0-key paths)
    const dryRunExecution = process.env.DRY_RUN_EXECUTION !== 'false';
    let liquidatorAddress: string | undefined = process.env.LIQUIDATOR_ADDRESS;
    if (id === 1) {
      liquidatorAddress = process.env.LIQUIDATOR_ADDRESS_ETHEREUM || process.env.LIQUIDATOR_ADDRESS || undefined;
    } else if (id === 42161) {
      liquidatorAddress = process.env.LIQUIDATOR_ADDRESS_ARBITRUM || process.env.LIQUIDATOR_ADDRESS || undefined;
    } else if (id === 8453) {
      liquidatorAddress = process.env.LIQUIDATOR_ADDRESS_BASE || process.env.LIQUIDATOR_ADDRESS || undefined;
    }
    const privateKeyForExecutor = process.env.PRIVATE_KEY || undefined;

    return {
      CHAIN_ID: id,
      IS_L2: isL2,
      RPC_URL: rpcUrl,
      RPC_FALLBACKS: rpcFallbacks,
      UNISWAP_QUOTER_V2: addrs.UNISWAP_QUOTER_V2,
      UNISWAP_FEE_TIERS: this.UNISWAP_FEE_TIERS,
      MIN_DEBT_BASE: minDebt,
      MIN_NET_PROFIT_BASE: minProfit,
      BRIBE_PERCENT: this.BRIBE_PERCENT,
      FLASHLOAN_FEE_BPS: this.FLASHLOAN_FEE_BPS,
      BASE_GAS_LIMIT: this.BASE_GAS_LIMIT,
      ADDRESSES: addrs,
      SLIPPAGE_BPS: BigInt(process.env.SLIPPAGE_BPS || (isL2 ? 30 : 50)),
      DB_PATH: this.DB_PATH,
      SUBGRAPH_URL: this.getSubgraphUrl(id),
      GRAPH_API_KEY: this.GRAPH_API_KEY,
      USE_SUBGRAPH_DISCOVERY: this.USE_SUBGRAPH_DISCOVERY,
      MAX_DISCOVERED_USERS: this.MAX_DISCOVERED_USERS,
      VOLATILITY_SLIP_ADJ_FACTOR: this.VOLATILITY_SLIP_ADJ_FACTOR,
      MOCK_QUOTER: this.MOCK_QUOTER,

      // prod-002: MEV flags (minimal; per-chain relay; MOCK_MEV default sim)
      MOCK_MEV: this.MOCK_MEV,
      MEV_RELAY_URL: (id === 1 ? this.MEV_RELAY_ETHEREUM : id === 42161 ? this.MEV_RELAY_ARBITRUM : id === 8453 ? this.MEV_RELAY_BASE : '') || this.MEV_RELAY_ETHEREUM,
      FLASHBOTS_AUTH_KEY: this.FLASHBOTS_AUTH_KEY,

      // prod-001.02 execution fields (centralized, exposed via getChainConfig for all prod paths)
      DRY_RUN_EXECUTION: dryRunExecution,
      LIQUIDATOR_ADDRESS: liquidatorAddress,
      PRIVATE_KEY: privateKeyForExecutor,
    };
  },

  getAddresses(chainId?: number): ChainAddresses {
    const id = chainId ?? this.CHAIN_ID;
    return getAddresses(id);
  },

  getSubgraphUrl(chainId?: number): string {
    const id = chainId ?? this.CHAIN_ID;
    if (id === 1) return this.SUBGRAPH_URL_ETHEREUM;
    if (id === 42161) return this.SUBGRAPH_URL_ARBITRUM;
    if (id === 8453) return this.SUBGRAPH_URL_BASE;
    throw new Error(`No subgraph configured for chainId ${id}`);
  },

  // Convenience for subgraph client
  getGraphApiKey(): string {
    return this.GRAPH_API_KEY;
  },

  // E-Mode support (centralized, for 0-RPC engine override of LT/bonus in E-Mode)
  // Multi-chain: different categories possible per chain (e.g. Base vs ETH)
  getEModeCategoryData(chainId?: number, categoryId?: number): EModeCategoryData | null {
    const id = chainId ?? this.CHAIN_ID;
    const cat = categoryId ?? 0;
    return getEModeCategoryData(id, cat);
  },

  // Execution helpers (prod-001.02): central accessors. Never direct process.env in consumers.
  // getExecutorPrivateKey(): returns PRIVATE_KEY or undefined (for dry-run support).
  // getExecutorWallet(rpcOrProvider?): returns ethers.Wallet | null. Pass provider or rpc string; returns null if no key.
  getExecutorPrivateKey(): string | undefined {
    return process.env.PRIVATE_KEY || undefined;
  },

  getExecutorWallet(rpcOrProvider?: string | ethers.Provider): ethers.Wallet | null {
    const pk = this.getExecutorPrivateKey();
    if (!pk) {
      return null; // safe for dry-run / no-key cases
    }
    try {
      if (rpcOrProvider) {
        let provider: ethers.Provider;
        if (typeof rpcOrProvider === 'string') {
          const { createProviderPool } = require('./providerPool');
          provider = createProviderPool(rpcOrProvider);
        } else {
          provider = rpcOrProvider;
        }
        return new ethers.Wallet(pk, provider);
      }
      return new ethers.Wallet(pk);
    } catch {
      return null;
    }
  },
} as const;

export type BotConfig = typeof config;
