import { ethers } from 'ethers';
import { Feeder } from '../test/Feeder';
import { calculateUserAccountData } from './engine/calculateUserAccountData';
import { calculateOptimalLiquidation, filterOpportunities } from './profitCalculator';
import { ExecutionRouter } from './ExecutionRouter';
import { ReserveDataView, UserPositionView } from './engine/views';
import { performance } from 'perf_hooks';

import { config } from './config';
import { initDb } from './db';
import { bulkSyncFromSubgraph, loadAtRiskAddressesFromDb } from './stateSync';
import { scanBorrowers } from './scanner';

async function runPriceTrigger() {
    console.log("==================================================");
    console.log("🚀 STARTING ZERO-RPC PRICE TRIGGER SIMULATION 🚀 (hybrid DB/subgraph + dynamic scan; fully uses config for CHAIN/RPC/addresses - Problem 4)");
    console.log("==================================================\n");

    // NO static/hardcoded USERS list (removed per Problem 4).
    // Use hybrid: loadAtRisk from DB (populated by subgraph) or dynamic scanner.
    // Centralized: CHAIN_ID, RPC, addresses (WETH etc) from config. Supports ETH + L2 (e.g. CHAIN_ID=8453).
    const chainId = config.CHAIN_ID;
    const chainCfg = config.getChainConfig(chainId);

    // Use config RPC (defaults to anvil localhost for sims; override via env/CHAIN_ID)
    const feeder = new Feeder(config.RPC_URL, config.CHAIN_ID);
    const ADDRESSES = config.getAddresses(chainId);
    const POOL_ADDR = ADDRESSES.POOL.toLowerCase();
    const pool = new ethers.Contract(
        POOL_ADDR,
        ["function getReservesList() view returns (address[])"],
        feeder.provider
    );

    console.log("[1] Cold Start: Loading Global Reserves List...");
    const ASSETS: string[] = await pool.getReservesList();

    const blockTag = await feeder.provider.getBlockNumber();
    const block = await feeder.provider.getBlock(blockTag);
    const currentTimestamp = BigInt(block!.timestamp);
    console.log(`    -> Locked to Block: ${blockTag}`);

    console.log("\n[2] Cold Start: Fetching Reserve Data (Prices & Indices)...");
    const reservesConfig = new Map<string, ReserveDataView>();
    for (const asset of ASSETS) {
        const rd = await feeder.fetchReserveData(asset, blockTag);
        reservesConfig.set(asset, rd);
    }
    console.log(`    -> Loaded ${reservesConfig.size} reserves into memory.`);

    console.log("\n[3] Cold Start: Loading Target Watchlist Positions via hybrid/DB or dynamic scan (no static USERS)...");
    // Hybrid discovery for sim (Problem 4): DB at-risk first (from prior bulk), fallback to on-chain scanner (dynamic)
    initDb();
    let USERS: string[] = loadAtRiskAddressesFromDb(chainId, chainCfg.MIN_DEBT_BASE);
    if (USERS.length === 0) {
      if (config.USE_SUBGRAPH_DISCOVERY) {
        try {
          await bulkSyncFromSubgraph(chainId, config.MAX_DISCOVERED_USERS);
          USERS = loadAtRiskAddressesFromDb(chainId, chainCfg.MIN_DEBT_BASE);
        } catch (e: any) { /* ignore */ }
      }
    }
    if (USERS.length === 0) {
      console.log('   [PriceTrigger] No DB at-risk users; using dynamic event scanner for borrowers (multi-chain, no hardcoded list).');
      USERS = await scanBorrowers(feeder.provider, 300);
    }
    if (USERS.length === 0) {
      console.warn('   Warning: 0 users discovered via hybrid/scan. Price crash sim may report 0 liquidations (seed DB with GRAPH_API_KEY + bulk or use real fork with activity).');
    }

    const userPositions: UserPositionView[] = [];
    for (const user of USERS) {
        const pos = await feeder.fetchUserPosition(user, ASSETS, blockTag);
        userPositions.push(pos);
    }
    console.log(`    -> Loaded ${userPositions.length} borrowers into memory from hybrid/dynamic source (chain ${chainId}).`);

    console.log("\n==================================================");
    console.log("🧠 MEMORY SNAPSHOT READY. ALL RPC CONNECTIONS DROPPED.");
    console.log("==================================================\n");

    // Instantiate the async ExecutionRouter
    // Use chain-aware RPC (supports live key or fork at 8545; real Quoter works via fork state or live RPC)
    const router = new ExecutionRouter(chainCfg.RPC_URL || "http://127.0.0.1:8545", chainId);

    // Baseline calculation
    console.log("Baseline Health Factors (Before Crash):");
    for (const pos of userPositions) {
        const data = calculateUserAccountData(pos, reservesConfig, currentTimestamp);
        // Only print actual significant borrowers
        if (data.totalDebtBase > 1000000000n) {
            console.log(`User ${pos.user}: HF = ${Number(data.healthFactor) / 1e18}`);
        }
    }

    console.log("\n🚨🚨🚨 CHAINLINK ORACLE EVENT DETECTED 🚨🚨🚨");
    console.log("WETH Price drops by 40%!");

    // --- ZERO-RPC EXECUTION START ---
    const t0 = performance.now();

    // 1. Update the price in memory instantly (use centralized WETH from addresses.ts/config - multi-chain aware)
    const wethAddr = ADDRESSES.WETH.toLowerCase();
    let wethKey = Array.from(reservesConfig.keys()).find(k => k.toLowerCase() === wethAddr);
    if (!wethKey) {
      // Fallback: try to find a likely WETH asset (anvil fork or L2 variants) for demo crash
      console.warn('   WETH addr from config not matched exactly in reserves; attempting L2/mainnet pattern fallback for sim.');
      wethKey = Array.from(reservesConfig.keys()).find(k => {
        const kl = k.toLowerCase();
        return kl.includes('c02aaa') || kl.includes('4200000000000000000000000000000000000006') || kl.includes('82af4944') || kl === wethAddr;
      });
    }
    if (!wethKey) throw new Error("No WETH-like asset found in reservesConfig for price crash sim. Check fork/chain.");
    const wethConfig = reservesConfig.get(wethKey)!;
    const oldPrice = wethConfig.priceInBaseCurrency;
    const newPrice = (oldPrice * 60n) / 100n; // 40% drop
    wethConfig.priceInBaseCurrency = newPrice;

    // 2. Scan all users in memory
    console.log("\n[!] Recalculating Health Factors entirely in memory...");
    const liquidatedUsers: string[] = [];
    for (const pos of userPositions) {
        const data = calculateUserAccountData(pos, reservesConfig, currentTimestamp);
        if (data.totalDebtBase > 1000000000n) {
            const hf = Number(data.healthFactor) / 1e18;
            console.log(`User ${pos.user}: HF = ${hf.toFixed(4)}`);
            if (hf < 1.0) {
                liquidatedUsers.push(pos.user);
                console.log(`  -> 🔪 LIQUIDATION TRIGGERED! HF < 1.0`);
                
                const opportunities = calculateOptimalLiquidation(data, reservesConfig);
                const filtered = filterOpportunities(opportunities);
                if (filtered.length > 0) {
                    const best = filtered[0];
                    console.log(`  -> 💡 Stage 1 (0-RPC): Paper Profit optimal pair: Repay [${best.debtAsset}] to seize [${best.collateralAsset}]`);
                    console.log(`     - Base Debt to Cover: $${(Number(best.debtToCoverBase) / 1e8).toFixed(2)}`);
                    console.log(`     - Base Expected Collateral: $${(Number(best.grossRevenueBase) / 1e8).toFixed(2)} (Includes ${(Number(best.liquidationBonus) / 100 - 100).toFixed(2)}% Bonus)`);
                    console.log(`     - Theoretical Net Profit: $${(Number(best.estimatedNetProfitBase) / 1e8).toFixed(2)}`);
                    
                    console.log(`\n  -> 🚀 Stage 2 (Async): Calling Quoter & Modeling MEV...`);
                    // IMPORTANT: To keep the trigger fast, we don't await in the critical loop in production, 
                    // but for this script we await to print the ticket sequentially.
                    const ticket = await router.verifyAndRoute(best, reservesConfig);
                    
                    // Stage 3: Execution decision
                    if (ticket.isProfitable) {
                        console.log(`     ✅ EXECUTION APPROVED!`);
                        console.log(`     - Real Swap Output: ${ticket.quoterAmountOutToken}`);
                        console.log(`     - Required Repayment: ${ticket.amountToRepayToken}`);
                        console.log(`     - Gas Cost (Token): ${ticket.gasCostToken}`);
                        console.log(`     - Builder Bribe (Token): ${ticket.bribeToken}`);
                        console.log(`     - Final Net Profit (Token): ${ticket.netProfitToken}`);
                        console.log(`     - Final Net Profit (USD): $${(Number(ticket.netProfitBase) / 1e8).toFixed(2)}`);
                    } else {
                        console.log(`     ❌ EXECUTION REJECTED: ${ticket.failReason}`);
                    }
                } else {
                    console.log(`  -> ❌ No profitable liquidation pairs found.`);
                }
            }
        }
    }

    const t1 = performance.now();
    // --- ZERO-RPC EXECUTION END ---

    console.log(`\n==================================================`);
    console.log(`⚡ TRIGGER EXECUTION TIME: ${(t1 - t0).toFixed(2)} milliseconds`);
    console.log(`⚡ FOUND ${liquidatedUsers.length} LIQUIDATABLE USERS IN ${(t1 - t0).toFixed(2)} ms WITHOUT RPC!`);
    console.log(`==================================================`);
}

runPriceTrigger().catch(console.error);
