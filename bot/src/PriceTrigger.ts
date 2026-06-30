import { ethers } from 'ethers';
import { Feeder } from '../test/Feeder';
import { calculateUserAccountData } from './engine/calculateUserAccountData';
import { calculateOptimalLiquidation } from './profitCalculator';
import { ExecutionRouter } from './ExecutionRouter';
import { ReserveDataView, UserPositionView } from './engine/views';
import { performance } from 'perf_hooks';

async function runPriceTrigger() {
    console.log("==================================================");
    console.log("🚀 STARTING ZERO-RPC PRICE TRIGGER SIMULATION 🚀");
    console.log("==================================================\n");

    const USERS = [
        "0xDb57FDF5fD24A9d0e1Ea94552Eb2C7BdCb28fA27".toLowerCase(),
        "0x37bAB29Dafe65278552bc74AdBBAbC15904b5502".toLowerCase(),
        "0x486E49eEDDf6432d3e10B15C25BB2Bc8da5811C9".toLowerCase(),
        "0xa462d9AcaCcb141Ce7F17213b95198fE248c27A1".toLowerCase(),
        "0xbC90243806b018E5e75930CfcCcFb3230D6D226c".toLowerCase()
    ];
    
    // WETH address on Mainnet
    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
    // WBTC address on Mainnet
    const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599".toLowerCase();

    const feeder = new Feeder("http://127.0.0.1:8545");
    const pool = new ethers.Contract(
        "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".toLowerCase(),
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

    console.log("\n[3] Cold Start: Loading Target Watchlist Positions (Simulating Event Sourcing)...");
    const userPositions: UserPositionView[] = [];
    for (const user of USERS) {
        const pos = await feeder.fetchUserPosition(user, ASSETS, blockTag);
        userPositions.push(pos);
    }
    console.log(`    -> Loaded ${userPositions.length} massive borrowers into memory.`);

    console.log("\n==================================================");
    console.log("🧠 MEMORY SNAPSHOT READY. ALL RPC CONNECTIONS DROPPED.");
    console.log("==================================================\n");

    // Instantiate the async ExecutionRouter
    const router = new ExecutionRouter("http://127.0.0.1:8545");

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

    // 1. Update the price in memory instantly
    const wethKey = Array.from(reservesConfig.keys()).find(k => k.toLowerCase() === WETH);
    if (!wethKey) throw new Error("WETH not found in reservesConfig");
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
                if (opportunities.length > 0) {
                    const best = opportunities[0];
                    console.log(`  -> 💡 Stage 1 (0-RPC): Paper Profit optimal pair: Repay [${best.debtAsset}] to seize [${best.collateralAsset}]`);
                    console.log(`     - Base Debt to Cover: $${(Number(best.debtToCoverBase) / 1e8).toFixed(2)}`);
                    console.log(`     - Base Expected Collateral: $${(Number(best.grossRevenueBase) / 1e8).toFixed(2)} (Includes ${(Number(best.liquidationBonus) / 100 - 100).toFixed(2)}% Bonus)`);
                    console.log(`     - Theoretical Net Profit: $${(Number(best.estimatedNetProfitBase) / 1e8).toFixed(2)}`);
                    
                    console.log(`\n  -> 🚀 Stage 2 (Async): Calling Quoter & Modeling MEV...`);
                    // IMPORTANT: To keep the trigger fast, we don't await in the critical loop in production, 
                    // but for this script we await to print the ticket sequentially.
                    const ticket = await router.verifyAndRoute(best, reservesConfig);
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
