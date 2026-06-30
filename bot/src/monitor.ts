import { ethers } from "ethers";
import { Feeder } from "../test/Feeder";
import { calculateUserAccountData } from "./engine/calculateUserAccountData";
import { ReserveDataView, UserPositionView } from "./engine/views";
import { MAX_UINT256 } from "./math/constants";
import { performance } from "perf_hooks";

// We use Anvil's WebSocket for listening to events in real-time
const WSS_URL = "ws://127.0.0.1:8545";
const provider = new ethers.WebSocketProvider(WSS_URL);
const feeder = new Feeder("http://127.0.0.1:8545");

const POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".toLowerCase();
const ORACLE_ADDRESS = "0x54586bE62E3c3580375aE3723C145253060Ca0C2".toLowerCase();

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

const USERS = [
    "0xDb57FDF5fD24A9d0e1Ea94552Eb2C7BdCb28fA27".toLowerCase(),
    "0x37bAB29Dafe65278552bc74AdBBAbC15904b5502".toLowerCase(),
    "0x486E49eEDDf6432d3e10B15C25BB2Bc8da5811C9".toLowerCase(),
    "0xa462d9AcaCcb141Ce7F17213b95198fE248c27A1".toLowerCase(),
    "0xbC90243806b018E5e75930CfcCcFb3230D6D226c".toLowerCase()
];

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
        }
    } catch (e) {
        console.error(`[STATE SYNC ERROR] Failed to refetch user ${user}:`, e);
    } finally {
        dirtyUsers.delete(user);
    }
}

function handleUserEvent(userAddress: string) {
    const user = userAddress.toLowerCase();
    if (USERS.includes(user)) {
        refetchDirtyUser(user);
    }
}

async function coldStart() {
    console.log("==================================================");
    console.log("❄️ COLD START INITIALIZATION");
    console.log("==================================================");

    const ASSETS: string[] = await pool.getReservesList();
    const blockTag = await feeder.provider.getBlockNumber();
    const block = await feeder.provider.getBlock(blockTag);
    currentTimestamp = BigInt(block!.timestamp);

    console.log(`[1] Pulling Reserve Data (Prices & Indices) at Block ${blockTag}...`);
    for (const asset of ASSETS) {
        const rd = await feeder.fetchReserveData(asset, blockTag);
        reservesConfig.set(asset, rd);
    }
    console.log(`    -> Loaded ${reservesConfig.size} reserves.`);

    console.log(`[2] Pulling User Positions (Scaled Balances)...`);
    for (const user of USERS) {
        const pos = await feeder.fetchUserPosition(user, ASSETS, blockTag);
        userPositions.push(pos);
    }
    console.log(`    -> Loaded ${userPositions.length} massive borrowers.`);
    console.log("==================================================\n");
}

function queueRecalculation() {
    if (recalculationQueued) return;
    recalculationQueued = true;
    setTimeout(() => {
        recalculationQueued = false;
        triggerEngine();
    }, 50); // debounce by 50ms
}

function triggerEngine() {
    const t0 = performance.now();
    let liquidatedCount = 0;

    for (const pos of userPositions) {
        const data = calculateUserAccountData(pos, reservesConfig, currentTimestamp);
        
        // Skip dust
        if (data.totalDebtBase < 1000000000n) continue;

        const hf = Number(data.healthFactor) / 1e18;
        if (hf < 1.0) {
            liquidatedCount++;
            console.log(`[!] 🔪 LIQUIDATION TRIGGERED: User ${pos.user} HF=${hf.toFixed(4)}`);
        } else if (hf < 1.05) {
            console.log(`[!] ⚠️ WARNING: User ${pos.user} HF=${hf.toFixed(4)} is approaching liquidation!`);
        }
    }
    const t1 = performance.now();
    
    if (liquidatedCount > 0) {
        console.log(`⚡ TRIGGER EXECUTION TIME: ${(t1 - t0).toFixed(2)} ms for ${userPositions.length} users.`);
    }
}

async function startReconciliationLoop() {
    console.log("🔄 Starting Reconciliation Loop (60s heartbeat)...");
    
    setInterval(async () => {
        // Pick a random user from the watchlist
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
        const hfDiff = evmResult.healthFactor > tsResult.healthFactor ? evmResult.healthFactor - tsResult.healthFactor : tsResult.healthFactor - evmResult.healthFactor;

        // Since we inherited Aave's truncation, HF drift should be minimal (e.g. 0-2 wei)
        console.log(`[SYNC CHECK] User ${targetUser} | HF Drift: ${hfDiff} wei | Col Drift: ${colDiff} wei`);
        
        if (hfDiff > 100000000000000n) {
            console.log(`❌ [FATAL] State Sync drifted beyond acceptable tolerance! HF Diff: ${hfDiff}`);
        }
    }, 10000); // 10 seconds for testing demonstration purposes (normally 60s)
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
            }
        }

        if (priceChanged) {
            queueRecalculation();
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

startMonitor();
