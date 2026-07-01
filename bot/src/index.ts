import { globalOpportunityCache } from './dedup';
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

import { config } from './config';
import { Feeder } from '../test/Feeder';
import { calculateUserAccountData } from './engine/calculateUserAccountData';
import { calculateOptimalLiquidation, filterOpportunities } from './profitCalculator';
import { ExecutionRouter } from './ExecutionRouter';
import { ReserveDataView, UserPositionView } from './engine/views';
import { MevBundleSubmitter } from './mevBundle';
import { LiquidationExecutor } from './executor';
import * as fs from 'fs';
import * as path from 'path';
import { initDb } from './db';
import { bulkSyncFromSubgraph, loadAtRiskAddressesFromDb } from './stateSync';
import { HealthServer } from './health';
import { setupGracefulShutdown } from './shutdown';

// Production Liquidation Bot - Advanced Engine Integration (Task 1.5 + Problem 4)
// Uses: advanced state (hybrid DB/subgraph users like monitor) + 0-RPC calc + ExecutionRouter
// All user discovery via loadAtRiskAddressesFromDb / stateSync; centralized config only.

const RPC_URL = config.RPC_URL;
const CHAIN_ID = config.CHAIN_ID;
// Robust WS + RPC (1.15): reconnect + fallback + rate limit
let provider = new ethers.WebSocketProvider(RPC_URL);
let feeder = new Feeder(RPC_URL, CHAIN_ID);

function setupRobustProvider() {
  provider.on('error', (err) => {
    console.error('[WS] Error, attempting reconnect...');
    setTimeout(() => {
      try {
        provider = new ethers.WebSocketProvider(RPC_URL);
        feeder = new Feeder(RPC_URL, CHAIN_ID);
        console.log('[WS] Reconnected');
      } catch (e) { console.error('Reconnect fail', e); }
    }, 2000);
  });
  // Simple rate limit backoff for calls
  const originalGetBlock = provider.getBlock.bind(provider);
  (provider as any).getBlock = async (block: any, prefetchTxs?: any) => {
    try {
      return await originalGetBlock(block, prefetchTxs);
    } catch (e: any) {
      if (e.code === 'RATE_LIMIT' || (e.message && e.message.includes('rate'))) {
        await new Promise(r => setTimeout(r, 1000));
        return originalGetBlock(block, prefetchTxs);
      }
      throw e;
    }
  };
}
setupRobustProvider();
const ADDRESSES = config.getAddresses();
const POOL_ADDRESS = ADDRESSES.POOL;

const POOL_ABI = [
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const ORACLE_ADDRESS = ADDRESSES.ORACLE;
const ORACLE_ABI = ["function getAssetPrice(address asset) view returns (uint256)"];

const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);
const oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, provider);

// Users now loaded exclusively via hybrid DB/subgraph (no static/hardcoded lists).
// Uses loadAtRiskAddressesFromDb + optional bulkSyncFromSubgraph per Task 3.8 / Problem 4.
// Multi-chain via config.getChainConfig() / CHAIN_ID.

let reservesConfig = new Map<string, ReserveDataView>();
let userPositions: UserPositionView[] = [];
let currentTimestamp = 0n;
let recalculationQueued = false;

const router = new ExecutionRouter(RPC_URL, config.CHAIN_ID);
// bundleSubmitter creation deduped to per-ticket inside conditional real path (prod-001.10/12)

// Simple structured logger + opportunity persistence (1.13)
const logOpp = (msg: string, data?: any) => {
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ''}\n`;
  if (config.STRUCTURED_LOG) console.log(line.trim());
  else console.log(msg);
  try {
    fs.appendFileSync(config.OPPORTUNITY_LOG_FILE, line);
  } catch (e) {}
};

async function coldStart() {
  console.log("❄️ [Prod] Cold start - loading reserves & hybrid users (DB/subgraph, no hardcoded)...");
  const ASSETS: string[] = await pool.getReservesList();
  const blockTag = await provider.getBlockNumber();
  const block = await provider.getBlock(blockTag);
  currentTimestamp = BigInt(block!.timestamp);

  for (const asset of ASSETS) {
    const rd = await feeder.fetchReserveData(asset, blockTag);
    reservesConfig.set(asset, rd);
  }

  // Hybrid discovery (Problem 4 / 3.8): use centralized config + stateSync
  const chainId = config.CHAIN_ID;
  initDb();
  const chainCfg = config.getChainConfig(chainId);
  if (config.USE_SUBGRAPH_DISCOVERY) {
    try {
      const syncRes = await bulkSyncFromSubgraph(chainId, config.MAX_DISCOVERED_USERS);
      console.log(`    -> Subgraph bulk: ${syncRes.usersLoaded} users upserted to DB.`);
    } catch (e: any) {
      console.warn('[HYBRID] bulkSyncFromSubgraph skipped (no GRAPH_API_KEY?):', e.message);
    }
  }
  let loadedUsers: string[] = loadAtRiskAddressesFromDb(chainId, chainCfg.MIN_DEBT_BASE);
  const USERS = loadedUsers.slice(0, config.MAX_DISCOVERED_USERS);
  if (USERS.length === 0) {
    console.warn('[index] 0 users from hybrid DB/subgraph. Production should provide GRAPH_API_KEY or seed via events/scans. Proceeding with empty watchlist.');
  }

  for (const user of USERS) {
    const pos = await feeder.fetchUserPosition(user, ASSETS, blockTag);
    userPositions.push(pos);
  }
  console.log(`✅ Loaded ${reservesConfig.size} reserves, ${userPositions.length} hybrid users (chainId=${chainId})`);
}

function queueRecalculation() {
  if (recalculationQueued) return;
  recalculationQueued = true;
  setTimeout(() => {
    recalculationQueued = false;
    triggerEngine();
  }, 50);
}

async function triggerEngine() {
  const t0 = performance.now();
  let processed = 0;
  const maxPerBlock = config.BACKPRESSURE_MAX_PER_BLOCK;

  for (const pos of userPositions) {
    if (processed >= maxPerBlock) {
      logOpp('Back-pressure: skipped remaining for this tick');
      break;
    }
    const data = calculateUserAccountData(pos, reservesConfig, currentTimestamp);
    if (data.totalDebtBase < 1000000000n) continue;

    const hf = Number(data.healthFactor) / 1e18;
    if (hf < 1.0) {
      logOpp(`LIQUIDATION TRIGGERED: ${pos.user} HF=${hf.toFixed(4)}`);

      const opportunities = calculateOptimalLiquidation(data, reservesConfig);
      const filtered = filterOpportunities(opportunities);
      if (filtered.length === 0) {
        logOpp('No profitable opportunities after filters.');
        continue;
      }

      const best = filtered[0];
      if (globalOpportunityCache.isRecentlyProcessed(pos.user, best.debtAsset)) {
        logOpp(`SKIPPED (recently processed): ${pos.user} - ${best.debtAsset}`);
        continue;
      }
      logOpp(`Optimal: repay ${best.debtAsset} seize ${best.collateralAsset}`);

      const ticket = await router.verifyAndRoute(best, reservesConfig);
      
      // Stage 3: Execution decision (clear orchestration)
      if (ticket.isProfitable) {
        logOpp(`APPROVED - Net Profit (USD): $${(Number(ticket.netProfitBase) / 1e8).toFixed(2)}`, {ticket: {repay: ticket.amountToRepayToken.toString(), bribe: ticket.bribeToken.toString()}});

        // prod-001.12: Wire executor into index.ts (minimal, similar to monitor, post-ticket)
        // Uses config-driven ctor (CHAIN_ID), passes reserves for accounting. Stages preserved.
        const executor = new LiquidationExecutor(RPC_URL, CHAIN_ID);
        const execRes = await executor.execute(best, ticket, reservesConfig);
        logOpp(`     Stage 3 (executor): ${execRes.dryRun ? 'DRY-RUN only (no tx)' : (execRes.success ? 'SUCCESS' : 'FAILED')} ${execRes.txHash ? 'tx=' + execRes.txHash : ''}${execRes.reason || execRes.error ? ' ' + (execRes.reason || execRes.error) : ''}`);

        // prod-001.10: conditional real path for bundle after executor. Keep sim for dry/MOCK. Deduped (create inside; top-level bundleSubmitter removed).
        if (!execRes.dryRun) {
          logOpp('Submitting MEV bundle (sim + retry, real path post-executor)...');
          const bundleSubmitter = new MevBundleSubmitter(RPC_URL, CHAIN_ID);
          const bundleResult = await bundleSubmitter.submitBundle(best, ticket);
          logOpp(`Bundle: ${bundleResult.success ? 'SUCCESS' : 'FAILED'} after ${bundleResult.attempts} attempts`, bundleResult);

          // prod-002.14: MEV Metrics, Landed Profit Accounting
          if (bundleResult.success && (bundleResult as any).receipt) {
            try {
              const liquidator = await executor.getLiquidator();
              const enriched = executor.enrichWithParsedEventAndActuals((bundleResult as any).receipt, liquidator, best, ticket, reservesConfig);
              Object.assign(bundleResult, enriched);
              logOpp(`MEV Landed Metrics: Actual Profit USD=$${(Number(enriched.actualProfitBase)/1e8).toFixed(2)}, Pure Bonus=$${(Number((best as any).pureBonusBase)/1e8).toFixed(2)}, Gas Wei=${enriched.actualGasWei}`);
            } catch (e: any) {
              console.log(`[MEV] ⚠️ Failed to enrich MEV receipt: ${e.message}`);
            }
          }

          // Persistence for opportunities (1.13)
          try {
            const oppLog = {time: new Date().toISOString(), user: pos.user, ticket, bundle: bundleResult};
            fs.appendFileSync(config.OPPORTUNITY_LOG_FILE, JSON.stringify(oppLog) + '\n');
          } catch(e) {}
        } else {
          logOpp('Bundle skipped (dry-run; sim kept in MevBundleSubmitter for MOCK/dry)');
        }
      } else {
        logOpp(`REJECTED: ${ticket.failReason}`);
      }
      processed++;
    } else if (hf < 1.05) {
      logOpp(`Approaching liquidation: ${pos.user} HF=${hf.toFixed(4)}`);
    }
  }

  const t1 = performance.now();
  logOpp(`Engine tick: ${(t1 - t0).toFixed(1)}ms`);
}

async function startProduction() {
  await coldStart();

  console.log("🟢 [Prod] Advanced Liquidation Bot started (using monitor + calc + router)");

  const healthServer = new HealthServer(config.HEALTH_PORT);
  await healthServer.start();
  console.log(`[Prod] Health server running on port ${config.HEALTH_PORT}`);

  setupGracefulShutdown(healthServer, 3000, [
    async () => {
      await healthServer.stop();
      console.log('[Prod] Health server stopped.');
    }
  ]);


  // Listen for on-chain updates (same pattern as advanced monitor)
  pool.on("ReserveDataUpdated", () => queueRecalculation());

  provider.on("block", async (blockNumber) => {
    const block = await provider.getBlock(blockNumber);
    currentTimestamp = BigInt(block!.timestamp);

    // Simple price poll on every block (prod would use Chainlink oracles)
    const assets = Array.from(reservesConfig.keys());
    try {
      const prices = await Promise.all(assets.map(a => oracle.getAssetPrice(a)));
      let changed = false;
      prices.forEach((p, i) => {
        const asset = assets[i];
        const cfg = reservesConfig.get(asset)!;
        const newP = BigInt(p);
        if (cfg.priceInBaseCurrency !== newP) {
          cfg.priceInBaseCurrency = newP;
          changed = true;
        }
      });
      if (changed) queueRecalculation();
    } catch (e) {
      // ignore transient errors
    }
  });

  // Simple periodic reconciliation (prod would be more robust)
  setInterval(async () => {
    if (userPositions.length === 0) return;
    const sample = userPositions[0];
    try {
      const onchain = await pool.getUserAccountData(sample.user);
      const ts = calculateUserAccountData(sample, reservesConfig, currentTimestamp);
      const drift = Math.abs(Number(onchain.healthFactor) - Number(ts.healthFactor));
      if (drift > 1e14) {
        console.log(`[RECON] Noticeable HF drift for ${sample.user}`);
      }
    } catch {}
  }, 30000);
}

// Error handling
process.on('uncaughtException', (err) => console.error("Uncaught:", err));

startProduction().catch(console.error);
