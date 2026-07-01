import { ethers } from 'ethers';
import { createProviderPool } from './providerPool';
import { config } from './config';
import { Feeder } from '../test/Feeder';
import { calculateUserAccountData } from './engine/calculateUserAccountData';
import { calculateOptimalLiquidation } from './profitCalculator';
import { ExecutionRouter } from './ExecutionRouter';
import { LiquidationExecutor, fundAnvilWallet } from './executor';
import { ReserveDataView, UserPositionView } from './engine/views';
import fs from 'fs';
import { initDb } from './db';
import { bulkSyncFromSubgraph, loadAtRiskAddressesFromDb } from './stateSync';

const RPC_URL = config.RPC_URL;
const CHAIN_ID = config.CHAIN_ID;
console.log(`[E2E] Using chain ${CHAIN_ID} (L2 mode: ${config.IS_L2}) - ready for mainnet/Arbitrum/Base etc.`);

const ADDRESSES = config.getAddresses(CHAIN_ID);
const POOL_ADDRESS = ADDRESSES.POOL;
const SWAP_ROUTER_ADDRESS = ADDRESSES.UNISWAP_SWAP_ROUTER;

// Load from environment - NEVER hardcode private keys (TDD: secrets-check.test)
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY environment variable is required. Copy .env.example to .env and set it (Anvil default for local testing only).');
}

// NOTE: deployLiquidator removed entirely (prod-001.13/15 cleanup). All paths use shared LiquidationExecutor + config.getAddresses(CHAIN_ID).
// e2e now config-only for addresses (WETH/USDC/WETH_PRICE_FEED pulled).

async function runE2E() {
    console.log("==================================================");
    console.log("🚀 STARTING E2E DRY RUN (ANVIL EXECUTION) 🚀");
    console.log("==================================================\n");

    const provider = createProviderPool(RPC_URL, config.getChainConfig(CHAIN_ID).RPC_FALLBACKS);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    // prod-001.13: fund gas on anvil (for deploy + exec tx) using shared helper. Multi-chain safe (noop on non-anvil).
    await fundAnvilWallet(provider, await wallet.getAddress());

    // 1. Use shared executor (refactored from inline deploy + direct tx). Executor will deploy (or attach via config) config-driven.
    const executor = new LiquidationExecutor(RPC_URL, CHAIN_ID);
    // Optional early get for logs (will deploy inside execute if needed; respects DRY_RUN via config)
    // const liqForLog = await executor.getLiquidator(wallet); // avoid side effect pre-crash; let execute handle

    const feeder = new Feeder(RPC_URL, CHAIN_ID);
    
    // Use the specific 5 users from our watchlist
    const targetUsers = [
        "0xdb57fdf5fd24a9d0e1ea94552eb2c7bdcb28fa27", // The WETH whale
        "0x486e49eeddf6432d3e10b15c25bb2bc8da5811c9", // A stable user
        "0xbc90243806b018e5e75930cfcccfb3230d6d226c"  // Another user
    ];

    const pool = new ethers.Contract(
        config.getAddresses().POOL.toLowerCase(),
        ["function getReservesList() view returns (address[])"],
        provider
    );

    console.log("[1] Cold Start: Loading Global Reserves List...");
    let ASSETS: string[] = await pool.getReservesList();
    // OPTIMIZATION: Only fetch WETH and USDC (config-driven via getAddresses) to avoid Alchemy free-tier RPC rate limits. Multi-chain.
    const e2eWeth = ADDRESSES.WETH;
    const e2eStable = (ADDRESSES as any).USDC || ADDRESSES.WETH;
    ASSETS = [e2eWeth, e2eStable];
    
    const blockTag = await provider.getBlockNumber();
    const block = await provider.getBlock(blockTag);
    const currentTimestamp = BigInt(block!.timestamp);
    console.log(`    -> Locked to Block: ${blockTag}`);
    
    console.log("[2] Cold Start: Fetching Reserve Data (Prices & Indices)...");
    const reservesConfig = new Map<string, ReserveDataView>();
    for (const asset of ASSETS) {
        const rd = await feeder.fetchReserveData(asset, blockTag);
        reservesConfig.set(asset, rd);
    }
    
    console.log("[3] Cold Start: Loading Target Watchlist Positions...");
    // 3.12: E2E with simulated price crash using DB users from subgraph hybrid (when available)
    initDb();
    try {
      if (config.USE_SUBGRAPH_DISCOVERY) {
        await bulkSyncFromSubgraph(CHAIN_ID, 5);
        const dbUsers = loadAtRiskAddressesFromDb(CHAIN_ID, 1000000000n); // any positive debt users
        if (dbUsers.length > 0) {
          console.log(`[E2E-DB] Using ${dbUsers.length} real users from DB/subgraph for crash sim (instead of hardcoded)`);
          targetUsers.length = 0;
          targetUsers.push(...dbUsers.slice(0, 3));
        }
      }
    } catch (e: any) {
      console.log('[E2E-DB] DB/subgraph users fallback to static:', e.message);
    }
    const userPositions: UserPositionView[] = [];
    for (const user of targetUsers) {
        userPositions.push(await feeder.fetchUserPosition(user, ASSETS, blockTag));
    }

    const router = new ExecutionRouter(RPC_URL, CHAIN_ID);

    console.log("\n🚨🚨🚨 CHAINLINK ORACLE EVENT DETECTED 🚨🚨🚨");
    console.log("WETH Price drops by 5%!\n");

    // CRASH THE PRICE IN MEMORY AND ON-CHAIN
    const WETH = ADDRESSES.WETH.toLowerCase();
    let crashedPrice = 0n;
    for (const [asset, config] of reservesConfig.entries()) {
        if (asset.toLowerCase() === WETH) {
            crashedPrice = (config.priceInBaseCurrency * 95n) / 100n; // 5% drop
            config.priceInBaseCurrency = crashedPrice;
        }
    }

    console.log("\n[4] Hacking WETH Aggregator on Anvil via anvil_setCode...");
    const AAVE_WETH_SOURCE = (ADDRESSES as any).WETH_PRICE_FEED || '0x5424384B256154046E9667dDFaaa5e550145215e'; // pulled to addresses for multi-chain (mainnet/Base feed)
    
    // Dynamically write and compile a Mock contract that returns exactly our crashedPrice
    const mockContractCode = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract DynamicMock {
    function latestAnswer() external pure returns (uint256) {
        return ${crashedPrice};
    }
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(uint256(${crashedPrice})), 0, 0, 1);
    }
    function getAssetPrice(address) external pure returns (uint256) {
        return ${crashedPrice};
    }
    function decimals() external pure returns (uint8) {
        return 8;
    }
}`;
    const fs = require('fs');
    const { execSync } = require('child_process');
    fs.writeFileSync("./src/DynamicMock.sol", mockContractCode);
    console.log("   -> Compiling DynamicMock...");
    execSync("forge build", { cwd: "." });
    const mockOracleArtifactPath = "./out/DynamicMock.sol/DynamicMock.json";
    const mockOracleArtifact = JSON.parse(fs.readFileSync(mockOracleArtifactPath, "utf8"));
    
    await provider.send("anvil_setCode", [AAVE_WETH_SOURCE, mockOracleArtifact.deployedBytecode.object]);
    console.log(`   -> WETH Source (${AAVE_WETH_SOURCE}) Replaced with DynamicMock returning ${crashedPrice}!`);

    // SWEEP & ROUTE
    for (const pos of userPositions) {
        const data = calculateUserAccountData(pos, reservesConfig, currentTimestamp);
        if (data.healthFactor < 1000000000000000000n) { // < 1.0
            console.log(`User ${pos.user}: HF = ${(Number(data.healthFactor) / 1e18).toFixed(4)}`);
            console.log(`  -> 🔪 LIQUIDATION TRIGGERED! HF < 1.0`);
            
            const opportunities = calculateOptimalLiquidation(data, reservesConfig);
            if (opportunities.length > 0) {
                const best = opportunities[0];
                console.log(`\n  -> 🚀 Calling Quoter & Modeling MEV...`);
                
                // Log separation of Pure Liquidation Bonus vs Oracle-Lag Arb (per plan)
                console.log(`     [Pure Bonus (excl. lag arb)]: ${best.pureBonusBase} base`);
                
                // Intentionally run a deliberate failure first, then a success? 
                // We'll just run the real one directly for this script.
                const ticket = await router.verifyAndRoute(best, reservesConfig);
                
                if (ticket.isProfitable) {
                    console.log(`     ✅ EXECUTION APPROVED!`);
                    console.log(`     - Real Swap Output: ${ticket.quoterAmountOutToken}`);
                    console.log(`     - Minimum Output Req: ${ticket.amountOutMinimumToken}`);
                    console.log(`     - Required Repayment: ${ticket.amountToRepayToken}`);
                    console.log(`     - Estimated Pre-Gas Profit: ${ticket.netProfitToken}`);
                    console.log(`     - Pure Bonus Component: ${best.pureBonusBase}`);
                    
                    console.log(`\n  -> 💥 FIRING TRANSACTION TO ANVIL (via shared LiquidationExecutor from 001.04+)...`);
                    
                    try {
                        // prod-001.13: use shared executor (config driven, handles getLiquidator/deploy, signed execute, enrich parse/gas/profit).
                        // debtToCover buffering now via executor.getDebtToCoverForCall internally; pass ticket + reserves for actuals.
                        const execResult = await executor.execute(best, ticket, reservesConfig);

                        if (execResult.dryRun) {
                            console.log(`     🔒 DRY-RUN via executor (config.DRY_RUN_EXECUTION); no tx. reason=${execResult.reason}`);
                        } else {
                            console.log(`     [Tx via Executor] Hash: ${execResult.txHash || 'n/a'}`);
                            const receipt = execResult.receipt;
                            if (receipt) {
                                console.log(`     [Tx Confirmed via executor] Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed}`);
                            }

                            // Use enriched result from executor (001.07 parse of LiquidationExecuted + actual gas deduct + profitBase)
                            // (executor already logs MISSED / negative / pure vs ticket in enrich)
                            const profit = execResult.profit ?? 0n;
                            const amountOut = execResult.amountOut ?? 0n;
                            const debtCovered = execResult.debtCovered ?? 0n;
                            const collateralReceived = execResult.collateralReceived ?? 0n;
                            const gasCostWei = execResult.actualGasWei ?? 0n;
                            // Keep e2e-specific USDT gas approx using the crash sim price (for demo output)
                            const gasCostUSDT = gasCostWei > 0n ? (gasCostWei * crashedPrice) / 100000000000000000000n : 0n;
                            const trueNetProfit = (execResult.actualProfitToken ?? (profit - gasCostUSDT)) as bigint;

                            // Pure Bonus (use opp or fixed 5% for demo; executor already computed attribution logs)
                            const pureBonus = (best as any).pureBonusBase || (debtCovered * 5n) / 100n;
                            const arbProfit = profit - (typeof pureBonus === 'bigint' ? pureBonus : (debtCovered * 5n) / 100n );

                            console.log("\n==================================================");
                            console.log("💰💰💰 TRUE ON-CHAIN RECONCILIATION (via shared executor) 💰💰💰");
                            console.log(`- Liquidated User: ${best.user || pos.user}`);
                            console.log(`- Debt Covered: ${debtCovered}`);
                            console.log(`- Collateral Seized: ${collateralReceived}`);
                            console.log(`- Uniswap AmountOut: ${amountOut}`);
                            console.log(`- On-Chain Profit (Pre-Gas): ${profit}`);
                            console.log(`- Gas Cost (in USDT approx): ${gasCostUSDT}`);
                            console.log(`- TRUE NET PROFIT (post gas from executor): ${trueNetProfit}`);
                            console.log(`- actualProfitBase (enriched): ${execResult.actualProfitBase}`);
                            console.log(`\n--- Profit Attribution ---`);
                            console.log(`- Pure Liquidation Bonus: ${pureBonus}`);
                            console.log(`- Oracle-Lag Arb: ${arbProfit}`);

                            // Bribe simulation (keep e2e demo)
                            const bribe = trueNetProfit > 0n ? trueNetProfit / 2n : 0n;
                            const postBribeProfit = trueNetProfit - bribe;

                            console.log(`\n--- MEV Bribe Simulation (50%) ---`);
                            console.log(`- Builder Bribe: ${bribe}`);
                            console.log(`- Final Post-Bribe Profit: ${postBribeProfit}`);

                            if (postBribeProfit <= 0n) {
                                console.log(`\n🚨 MISSED TARGET: Post-Bribe Profit is Negative/Zero!`);
                            }

                            console.log("==================================================\n");
                        }
                    } catch (err: any) {
                        console.log(`     ❌ TRANSACTION REVERTED (via executor): ${String(err?.message || err).split('\n')[0]}`);
                    }

                } else {
                    console.log(`     ❌ EXECUTION REJECTED: ${ticket.failReason}`);
                }
            } else {
                console.log(`  -> ❌ No profitable liquidation pairs found.`);
            }
        }
    }
}

runE2E().catch(console.error);
