import { ethers } from "ethers";
import { Feeder } from "../test/Feeder";
import { calculateUserAccountData } from "./engine/calculateUserAccountData";
import { calculateOptimalLiquidation, filterOpportunities } from "./profitCalculator";
import { ReserveDataView, UserPositionView } from "./engine/views";
import { MAX_UINT256 } from "./math/constants";
import { performance } from "perf_hooks";
import { config } from './config';
import { ExecutionRouter } from "./ExecutionRouter";
import { MevBundleSubmitter } from "./mevBundle";
import { LiquidationExecutor } from "./executor";
import { bulkSyncFromSubgraph, syncUserPositionToDb, loadAtRiskAddressesFromDb, getAtRiskUsersForMemory, loadEngineViewsFromSubgraph } from './stateSync';
import { initDb, upsertUserPosition, upsertUser, insertPriceHistory, upsertReserve, getRecentPrices, insertDrift, getRecentDrifts, getAtRiskUsers } from './db';
import { SubgraphClient, extractAssetAddress } from './subgraph';

// Production-ready: use config for RPC
const chainId = config.CHAIN_ID;
const chainCfg = config.getChainConfig();
const RPC_URL = chainCfg.RPC_URL;
const isAnvil = RPC_URL.includes('127.0.0.1') || RPC_URL.includes('localhost');

// Robust WS + RPC (Task 1.15): basic reconnect + fallback
let provider = new ethers.WebSocketProvider(RPC_URL);
let feeder = new Feeder(RPC_URL, chainId);

function setupReconnect() {
  provider.on('error', (err) => {
    console.error('[WS] Error, reconnecting in 2s...', err.message);
    setTimeout(() => {
      try {
        provider = new ethers.WebSocketProvider(RPC_URL);
        feeder = new Feeder(RPC_URL, chainId);
        console.log('[WS] Reconnected');
      } catch (e) { console.error('Reconnect failed', e); }
    }, 2000);
  });
}
setupReconnect();

const ADDRESSES = config.getAddresses();
const POOL_ADDRESS = ADDRESSES.POOL.toLowerCase();
const ORACLE_ADDRESS = ADDRESSES.ORACLE.toLowerCase();

const POOL_ABI = [
    "function getReservesList() view returns (address[])",
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "event ReserveDataUpdated(address indexed reserve, uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex)",
    "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
    "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
    "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
    "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)",
    "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
    "event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user)",
    "event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user)"
];

const ORACLE_ABI = [
    "function getAssetPrice(address asset) view returns (uint256)"
];

const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);
const oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, provider);

// Hybrid DB + Subgraph init (Task 3.8)
initDb();

// 3.10: simple volatility % from recent price_history (feed to slippage/gas)
function getRecentVolatilityPercent(asset: string): number {
  try {
    const hist = getRecentPrices(chainId, asset, 8);
    if (hist.length < 2) return 0;
    const vals = hist.map((h: any) => Number(h.price) / 1e18);
    const mx = Math.max(...vals);
    const mn = Math.min(...vals);
    const avg = (mx + mn) / 2;
    return avg > 0 ? ((mx - mn) / avg) * 100 : 0;
  } catch { return 0; }
}

// Users sourced EXCLUSIVELY from hybrid DB/subgraph (Problem 4 fix).
// No static/hardcoded lists. loadAtRisk... populates; events can dynamically extend.
let USERS: string[] = [];

let reservesConfig = new Map<string, ReserveDataView>();
let userPositions: UserPositionView[] = [];
let currentTimestamp = 0n;

// Throttle recalculations so we don't recalculate 50 times in one block
let recalculationQueued = false;

// Track users currently being refetched to avoid redundant RPC calls
const dirtyUsers = new Set<string>();

async function refetchDirtyUser(user: string) {
    if (dirtyUsers.has(user)) return; // Already fetching
    dirtyUsers.add(user);
    
    console.log(`\n[STATE SYNC] 🚨 User ${user} mutated on-chain. Marking as DIRTY and refetching...`);
    try {
        const ASSETS = Array.from(reservesConfig.keys());
        // Since Feeder creates a new provider internally, we just use its provider block number
        const blockTag = await feeder.provider.getBlockNumber(); 
        const pos = await feeder.fetchUserPosition(user, ASSETS, blockTag);
        
        const index = userPositions.findIndex(u => u.user === user);
        if (index !== -1) {
            userPositions[index] = pos;
            console.log(`[STATE SYNC] ✅ User ${user} scaled balances successfully overwritten from on-chain truth.`);
            queueRecalculation();
        } else {
            // New user discovered via event (hybrid dynamic)
            userPositions.push(pos);
            USERS = Array.from(new Set([...USERS, user]));
            console.log(`[STATE SYNC] 🆕 New user ${user} added to watch list via event.`);
            queueRecalculation();
        }

        // Task 3.8: Persist the truth to DB after event-driven refetch
        await syncUserPositionToDb(chainId, user);
        console.log(`[STATE SYNC] 💾 Persisted ${user} to DB (hybrid sync after event).`);
    } catch (e) {
        console.error(`[STATE SYNC ERROR] Failed to refetch user ${user}:`, e);
    } finally {
        dirtyUsers.delete(user);
    }
}

function handleUserEvent(userAddress: string) {
    const user = userAddress.toLowerCase();
    // Hybrid: always refetch on relevant event (dynamic discovery via subgraph + events)
    // USERS list managed by loadAtRisk + dynamic adds (no statics, Task 3.8 + Problem 4)
    refetchDirtyUser(user);
}

async function coldStart() {
    console.log("==================================================");
    console.log("❄️ COLD START INITIALIZATION (hybrid subgraph+DB+events 3.8; NO hardcoded USERS - Problem 4)");
    console.log("==================================================");

    const ASSETS: string[] = await pool.getReservesList();
    const blockTag = await feeder.provider.getBlockNumber();
    const block = await feeder.provider.getBlock(blockTag);
    currentTimestamp = BigInt(block!.timestamp);

    console.log(`[1] Pulling Reserve Data (Prices & Indices) at Block ${blockTag}...`);
    for (const asset of ASSETS) {
        const rd = await feeder.fetchReserveData(asset, blockTag);
        reservesConfig.set(asset, rd);
        // 3.10: also upsert reserve prices/indices to DB
        upsertReserve({
          chain_id: chainId,
          asset,
          price_base: rd.priceInBaseCurrency.toString(),
          liquidity_index: rd.liquidityIndex.toString(),
          borrow_index: rd.variableBorrowIndex.toString(),
        });
    }
    console.log(`    -> Loaded ${reservesConfig.size} reserves.`);

    // 3.10: Sync current prices from subgraph to price_history (historical series)
    try {
      const sg = new SubgraphClient(chainId);
      const reserves = await sg.getReserves(20);
      const nowTs = Number(currentTimestamp);
      for (const r of reserves) {
        const price = r.price && r.price.priceInEth ? r.price.priceInEth : '0';
        insertPriceHistory({
          chain_id: chainId,
          asset: extractAssetAddress(r.id),
          ts: nowTs,
          price,
          source: 'subgraph',
          block_number: blockTag,
        });
      }
      console.log(`    -> 3.10: Subgraph prices stored to history for ${reserves.length} reserves.`);
    } catch (e: any) {
      console.warn('[3.10] Subgraph price sync skipped:', e.message);
    }

    // Task 3.8: Hybrid bulk discovery from subgraph -> DB
    if (config.USE_SUBGRAPH_DISCOVERY) {
      try {
        console.log(`[2a] Bulk sync from subgraph (chain ${chainId}, max ${config.MAX_DISCOVERED_USERS}) ...`);
        const syncRes = await bulkSyncFromSubgraph(chainId, config.MAX_DISCOVERED_USERS);
        console.log(`    -> Subgraph sync: ${syncRes.usersLoaded} users, ${syncRes.positionsUpserted} positions upserted to DB.`);
      } catch (e: any) {
        console.warn('[HYBRID] Subgraph bulk skipped or failed (no key?):', e.message);
      }
    }

    // 3.9: At-Risk Filtering - load ONLY at-risk / high-debt from DB into memory for engine.
    // Pure hybrid: no fallback to static list (Problem 4).
    const chainCfg = config.getChainConfig(chainId);
    const dbUsers = loadAtRiskAddressesFromDb(chainId, chainCfg.MIN_DEBT_BASE);
    USERS = (dbUsers.length > 0 ? dbUsers : []).slice(0, config.MAX_DISCOVERED_USERS);
    console.log(`[2b] 3.9 At-risk filter: loaded ${USERS.length} high-risk users from DB/subgraph (minDebt=${chainCfg.MIN_DEBT_BASE}, chain=${chainId})`);

    // Problem 1 fix: conditionally (default when USE_SUBGRAPH_DISCOVERY) load *full engine views* using loadEngineViewsFromSubgraph
    // instead of (or before) Feeder for userPositions. This feeds real subgraph-mapped data (positions + reservesConfig)
    // directly into calculateUserAccountData + triggerEngine (and router) for 0-RPC advantage.
    // On-chain Feeder still used for event dirty refetches (as truth) and reserve data (fresh indices at cold block).
    // Multi-chain via getChainConfig. Fallback if no key / subgraph issue.
    let loadedEngineFromSubgraph = false;
    if (config.USE_SUBGRAPH_DISCOVERY) {
      try {
        console.log(`[3] Loading full engine views from subgraph using loadEngineViewsFromSubgraph + mapSubgraphToEngineViews (for userPositions + mapped reservesConfig)...`);
        const maxU = Math.min(USERS.length || config.MAX_DISCOVERED_USERS || 20, 50);
        const engineViews = await loadEngineViewsFromSubgraph(chainId, maxU);
        // Assign the mapped userPositions so triggerEngine + calc + recon use subgraph data (not just on-chain feeder)
        if (engineViews.userPositions && engineViews.userPositions.length > 0) {
          userPositions = engineViews.userPositions;
          USERS = userPositions.map((p: any) => p.user);  // keep USERS in sync with engine-loaded (for recon etc)
        }
        // Merge mapped reserves (add if not present from on-chain pull; subgraph provides consistent for its users)
        if (engineViews.reservesConfig && engineViews.reservesConfig.size > 0) {
          for (const [k, v] of engineViews.reservesConfig.entries()) {
            const key = (k || '').toLowerCase();
            if (!reservesConfig.has(key)) reservesConfig.set(key, v);
          }
        }
        loadedEngineFromSubgraph = userPositions.length > 0;
        console.log(`    -> Loaded ${userPositions.length} positions + augmented reserves from SUBGRAPH mapped views (0-RPC engine path). Trigger will use them.`);
      } catch (e: any) {
        console.warn('[SUBGRAPH] loadEngineViewsFromSubgraph for engine views failed (fallback to Feeder positions):', e.message?.slice(0, 100));
      }
    }

    if (!loadedEngineFromSubgraph) {
      console.log(`[3] Pulling User Positions (Scaled Balances) ONLY for at-risk watch list (0-RPC via Feeder)...`);
      for (const user of USERS) {
          const pos = await feeder.fetchUserPosition(user, ASSETS, blockTag);
          userPositions.push(pos);
      }
      console.log(`    -> Loaded ${userPositions.length} at-risk borrowers into memory (engine).`);
    }
    console.log("==================================================\n");
}

function queueRecalculation() {
    if (recalculationQueued) return;
    recalculationQueued = true;
    setTimeout(async () => {
        recalculationQueued = false;
        try {
            await triggerEngine();
        } catch (e) {
            console.error("Error in triggerEngine:", e);
        }
    }, 50); // debounce by 50ms
}

async function triggerEngine() {
    const t0 = performance.now();
    let opportunitiesFound = 0;

    // Clear "opportunity → ticket → execution decision" orchestration (Task 1.7)
    for (const pos of userPositions) {
        const data = calculateUserAccountData(pos, reservesConfig, currentTimestamp);
        
        // Skip dust
        if (data.totalDebtBase < 1000000000n) continue;

        const hf = Number(data.healthFactor) / 1e18;

        // 3.9: Update DB at-risk flag based on computed HF (so cold start / load filters correctly next time)
        // Non at-risk are not loaded into memory until their HF drops.
        const tChainCfg = config.getChainConfig(chainId);
        const isAtRiskNow = hf < 1.5 || data.totalDebtBase >= tChainCfg.MIN_DEBT_BASE;
        try {
          upsertUser({
            chain_id: chainId,
            address: pos.user,
            is_at_risk: isAtRiskNow ? 1 : 0,
            total_debt_base: data.totalDebtBase.toString(),
            last_hf: data.healthFactor.toString(),
          });
        } catch (e) { /* best effort */ }

        if (hf < 1.0) {
            console.log(`[!] 🔪 LIQUIDATION TRIGGERED: User ${pos.user} HF=${hf.toFixed(4)}`);
            
            // Stage 1: Opportunity discovery (0-RPC)
            const vol = getRecentVolatilityPercent( Array.from(reservesConfig.keys())[0] || '' );
            const opportunities = calculateOptimalLiquidation(data, reservesConfig, vol);
            const filtered = filterOpportunities(opportunities);
            
            if (filtered.length > 0) {
                const best = filtered[0];
                opportunitiesFound++;
                console.log(`  -> 💡 Stage 1 (0-RPC): Optimal pair Repay [${best.debtAsset}] seize [${best.collateralAsset}]`);
                console.log(`     Base Debt: $${(Number(best.debtToCoverBase)/1e8).toFixed(2)} | Gross: $${(Number(best.grossRevenueBase)/1e8).toFixed(2)}`);

                // Stage 2: Ticket verification (real Quoter + gas + MEV)
                // Pass chainId to use correct per-chain RPC (derive/key pattern) + Quoter addr from config/addresses.
                console.log(`  -> 🚀 Stage 2: Verifying with Quoter + MEV model...`);
                const router = new ExecutionRouter(tChainCfg.RPC_URL || config.RPC_URL, chainId);
                try {
                    const ticket = await router.verifyAndRoute(best, reservesConfig);

                    // Stage 3: Execution decision
                    if (ticket.isProfitable) {
                        console.log(`     ✅ EXECUTION APPROVED! Net Profit: $${(Number(ticket.netProfitBase)/1e8).toFixed(2)}`);
                        console.log(`     Ticket: repay=${ticket.amountToRepayToken} fee=${ticket.poolFee} bribe=${ticket.bribeToken}`);

                        // prod-001.11: Wire executor (post-ticket after if (ticket.isProfitable))
                        // Stage 3: Execution (config-driven, respects DRY_RUN_EXECUTION, multi-chain via getChainConfig/CHAIN_ID)
                        // Uses executor.execute(best, ticket); passes reserves for post-tx accounting. Keep stages (opp1/ticket2/exec3).
                        const executor = new LiquidationExecutor(tChainCfg.RPC_URL || config.RPC_URL, chainId);
                        const execRes = await executor.execute(best, ticket, reservesConfig);
                        console.log(`     Stage 3 (executor): ${execRes.dryRun ? 'DRY-RUN only (no tx)' : (execRes.success ? 'SUCCESS' : 'FAILED')} ${execRes.txHash ? 'tx=' + execRes.txHash : ''}${execRes.reason || execRes.error ? ' ' + (execRes.reason || execRes.error) : ''}`);

                        // prod-001.10: conditional real path for bundle (after executor). Keep sim for dry/MOCK.
                        if (!execRes.dryRun) {
                          // Stage 4: MEV Bundle submission (Task 1.11) -- conditional real (sim kept)
                          const bundleSubmitter = new MevBundleSubmitter(tChainCfg.RPC_URL || config.RPC_URL, chainId);
                          const bundleRes = await bundleSubmitter.submitBundle(best, ticket);
                          console.log(`     Bundle: ${bundleRes.success ? '✅ SUCCESS' : '❌ FAILED'} after ${bundleRes.attempts} attempts`);

                          // prod-002.14: MEV Metrics, Landed Profit Accounting
                          if (bundleRes.success && (bundleRes as any).receipt) {
                            try {
                              const liquidator = await executor.getLiquidator();
                              const enriched = executor.enrichWithParsedEventAndActuals((bundleRes as any).receipt, liquidator, best, ticket, reservesConfig);
                              console.log(`     [MEV Metrics] Actual Profit USD=$${(Number(enriched.actualProfitBase)/1e8).toFixed(2)}, Pure Bonus=$${(Number((best as any).pureBonusBase)/1e8).toFixed(2)}, Gas Wei=${enriched.actualGasWei}`);
                            } catch (e: any) {
                              console.log(`     [MEV] ⚠️ Failed to enrich MEV receipt: ${e.message}`);
                            }
                          }
                        } else {
                          console.log(`     Bundle: skipped (dry-run/MOCK; sim kept in MevBundleSubmitter)`);
                        }
                    } else {
                        console.log(`     ❌ EXECUTION REJECTED: ${ticket.failReason}`);
                    }
                } catch (e: any) {
                    console.log(`     ❌ Router error: ${e.message}`);
                }
            } else {
                console.log(`  -> ❌ No profitable pairs after filters.`);
            }
        } else if (hf < 1.05) {
            console.log(`[!] ⚠️ WARNING: User ${pos.user} HF=${hf.toFixed(4)} is approaching liquidation!`);
        }
    }
    const t1 = performance.now();
    
    if (opportunitiesFound > 0) {
        console.log(`⚡ TRIGGER ENGINE TIME: ${(t1 - t0).toFixed(2)} ms`);
    }
}

async function startReconciliationLoop() {
    const reconCfg = config;
    console.log(`🔄 Starting Production Reconciliation Loop (interval=${reconCfg.RECONCILIATION_INTERVAL_MS}ms, persistence=${reconCfg.RECONCILIATION_LOG_FILE})...`);
    
    setInterval(async () => {
        // Pick a random user from the watchlist (hybrid loaded)
        if (USERS.length === 0) {
          // nothing to recon yet
          return;
        }
        const targetUser = USERS[Math.floor(Math.random() * USERS.length)];
        
        // Get on-chain truth
        const evmResult = await pool.getUserAccountData(targetUser);
        
        // Get TS Memory calculation
        const userPos = userPositions.find(u => u.user === targetUser)!;
        const tsResult = calculateUserAccountData(userPos, reservesConfig, currentTimestamp);

        // Skip dust accounts comparison
        if (evmResult.totalDebtBase < 1000000000n) {
            console.log(`[SYNC CHECK] User ${targetUser} is dust. Skipping drift check.`);
            return;
        }

        const colDiff = evmResult.totalCollateralBase > tsResult.totalCollateralBase ? evmResult.totalCollateralBase - tsResult.totalCollateralBase : tsResult.totalCollateralBase - evmResult.totalCollateralBase;
        const debtDiff = evmResult.totalDebtBase > tsResult.totalDebtBase ? evmResult.totalDebtBase - tsResult.totalDebtBase : tsResult.totalDebtBase - evmResult.totalDebtBase;
        const hfDiff = evmResult.healthFactor > tsResult.healthFactor ? evmResult.healthFactor - tsResult.healthFactor : tsResult.healthFactor - evmResult.healthFactor;

        const logLine = `[SYNC CHECK] ${new Date().toISOString()} | User ${targetUser} | HF Drift: ${hfDiff} wei | Col Drift: ${colDiff} wei | Debt Drift: ${debtDiff} wei\n`;

        // Persistence: append to log file
        try {
            const fs = require('fs');
            fs.appendFileSync(reconCfg.RECONCILIATION_LOG_FILE, logLine);
        } catch (e) {
            console.error('Failed to write reconciliation log:', e);
        }

        // Structured log
        console.log(logLine.trim());

        // 3.11: Compare to DB state
        let dbHfDiff = 0n;
        try {
          const dbRows = getAtRiskUsers(chainId);
          const dbRow = dbRows.find(r => r.address === targetUser);
          if (dbRow && dbRow.last_hf) {
            const dbHf = BigInt(dbRow.last_hf);
            dbHfDiff = evmResult.healthFactor > dbHf ? evmResult.healthFactor - dbHf : dbHf - evmResult.healthFactor;
            insertDrift({ chain_id: chainId, ts: Math.floor(Date.now()/1000), user: targetUser, source: 'db', hf_drift: dbHfDiff.toString() });
          }
        } catch {}

        // 3.11: Compare to subgraph snapshot
        try {
          const sg = new SubgraphClient(chainId);
          const sgU = await sg.getUser(targetUser);
          if (sgU) {
            // rough, no full hf in sg, use debt count or skip detailed
            insertDrift({ chain_id: chainId, ts: Math.floor(Date.now()/1000), user: targetUser, source: 'subgraph', hf_drift: '0' /* placeholder */ });
          }
        } catch {}

        // Store main memory vs onchain drift
        insertDrift({ chain_id: chainId, ts: Math.floor(Date.now()/1000), user: targetUser, source: 'memory-evm', hf_drift: hfDiff.toString(), col_drift: colDiff.toString(), debt_drift: debtDiff.toString() });

        // Alerts on drift (tunable)
        const hfTol = reconCfg.RECONCILIATION_HF_TOLERANCE;
        const tol = reconCfg.RECONCILIATION_COL_DEBT_TOLERANCE;
        if (hfDiff > hfTol || colDiff > tol || debtDiff > tol) {
            console.error(`❌ [ALERT] State Sync drifted beyond tolerance! HF:${hfDiff} Col:${colDiff} Debt:${debtDiff}`);
            // 3.11: could alert more
        }
        if (dbHfDiff > hfTol) {
          console.error(`❌ [ALERT] DB drift > tol: ${dbHfDiff}`);
        }
    }, reconCfg.RECONCILIATION_INTERVAL_MS);

    // Periodic health heartbeat (3.11 include DB)
    setInterval(() => {
        const health = {
            timestamp: new Date().toISOString(),
            usersTracked: userPositions.length,
            reserves: reservesConfig.size,
            lastReconciliation: 'see log',
            recentDrifts: getRecentDrifts(chainId, USERS[0] || 'none', 3).length,
        };
        console.log(`[HEALTH] Bot health: ${JSON.stringify(health)}`);
    }, 60000);
}

async function startMonitor() {
    await coldStart();

    console.log("📡 [Monitor] Thin State Sync MVP Running...");
    
    // 1. Listen for ReserveDataUpdated
    pool.on("ReserveDataUpdated", (reserve, liquidityRate, stableBorrowRate, variableBorrowRate, liquidityIndex, variableBorrowIndex) => {
        const configKey = Array.from(reservesConfig.keys()).find(k => k.toLowerCase() === reserve.toLowerCase());
        const config = configKey ? reservesConfig.get(configKey) : undefined;
        if (config) {
            config.liquidityIndex = BigInt(liquidityIndex);
            config.variableBorrowIndex = BigInt(variableBorrowIndex);
            // We only care about index updates for triggering recalculations
            queueRecalculation();
        }
    });

    // 2. Poll Prices on new blocks (Fallback for MVP instead of tracking all Chainlink aggregators)
    provider.on("block", async (blockNumber) => {
        const block = await provider.getBlock(blockNumber);
        currentTimestamp = BigInt(block!.timestamp);

        // Fetch new prices for all loaded assets (this is MVP shortcut, production would use Chainlink events)
        const assets = Array.from(reservesConfig.keys());
        
        const pricePromises = assets.map(asset => oracle.getAssetPrice(asset));
        const newPrices = await Promise.all(pricePromises);

        let priceChanged = false;
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            const config = reservesConfig.get(asset)!;
            const newPrice = BigInt(newPrices[i]);

            if (config.priceInBaseCurrency !== newPrice) {
                config.priceInBaseCurrency = newPrice;
                priceChanged = true;

                // 3.10: Store price update to history (for volatility tracking)
                insertPriceHistory({
                  chain_id: chainId,
                  asset: asset.toLowerCase(),
                  ts: Number(currentTimestamp),
                  price: newPrice.toString(),
                  source: 'oracle',
                  block_number: blockNumber,
                });
            }
        }

        if (priceChanged) {
            const sample = assets[0] || '';
            const v = getRecentVolatilityPercent(sample);
            if (v > 0.1) console.log(`[3.10] Recent vol ${sample.slice(0,6)}... ~${v.toFixed(1)}% (will widen slippage in router)`);
            queueRecalculation();
        }

        // 3.10: subgraph deltas for price history (monitor via subgraph)
        try {
          const sg = new SubgraphClient(chainId);
          const sReserves = await sg.getReserves(5);
          for (const r of sReserves) {
            const asset = extractAssetAddress(r.id);
            const priceStr = r.price && r.price.priceInEth ? r.price.priceInEth : '0';
            insertPriceHistory({
              chain_id: chainId,
              asset,
              ts: Number(currentTimestamp),
              price: priceStr,
              source: 'subgraph-delta',
              block_number: blockNumber,
            });
          }
        } catch (e: any) {
          // silent, subgraph optional
        }
    });

    // 3. Listen for User Position Mutations (Phase 3: Dirty Flag + Async Refetch)
    pool.on("Supply", (reserve, user, onBehalfOf) => handleUserEvent(onBehalfOf));
    pool.on("Withdraw", (reserve, user) => handleUserEvent(user));
    pool.on("Borrow", (reserve, user, onBehalfOf) => handleUserEvent(onBehalfOf));
    pool.on("Repay", (reserve, user) => handleUserEvent(user));
    pool.on("LiquidationCall", (collateral, debt, user) => handleUserEvent(user));
    pool.on("ReserveUsedAsCollateralEnabled", (reserve, user) => handleUserEvent(user));
    pool.on("ReserveUsedAsCollateralDisabled", (reserve, user) => handleUserEvent(user));

    startReconciliationLoop();
}

// 捕获不可预见的异常
process.on('uncaughtException', (err) => {
    console.error("Uncaught Exception:", err);
});

// startMonitor();   // Commented: use bot/src/index.ts as the production entry point (Task 1.5)
// If you want the old Anvil demo, uncomment the line above or run directly.
