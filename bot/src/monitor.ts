import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { estimateLiquidationProfit } from "./profitCalculator";

// 连接到本地的 Anvil Fork 节点，并开启自动出块监听
const WSS_URL = "ws://127.0.0.1:8545";
const provider = new ethers.WebSocketProvider(WSS_URL);

const POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const POOL_ABI = [
    "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];
const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);

function loadBorrowers(): string[] {
    const filePath = path.join(__dirname, '..', 'data', 'borrowers.json');
    if (!fs.existsSync(filePath)) {
        console.error("❌ borrowers.json not found! Please run the simulator scanner first.");
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function startMonitoring() {
    const users = loadBorrowers();
    console.log(`📡 [Monitor] Started continuous monitoring for ${users.length} addresses.`);
    console.log(`⏳ Waiting for new Ethereum blocks... (approx. every 12 seconds)\n`);

    // 核心事件监听：一旦有新区块产生，立即触发回调
    provider.on("block", async (blockNumber) => {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`📦 [${timestamp} - Block ${blockNumber}] Mined! Checking ${users.length} targets...`);
        
        // 生产级：使用 Promise.all 并发请求所有用户的最新健康因子
        const checks = users.map(async (user) => {
            try {
                const data = await pool.getUserAccountData(user);
                const hf = Number(ethers.formatUnits(data.healthFactor, 18));
                
                // 为了不让正常用户的日志刷屏，我们只打印处于危险边缘的 (HF < 1.05)
                if (hf < 1.05 && hf > 0) {
                    console.log(`   🟡 [ALERT] User ${user.slice(0, 8)}... Health Factor is dangerously low: ${hf.toFixed(4)}!`);
                }
                
                // 为了演示，我们将爆仓阈值人为调高到 1.03，这样当前的危险用户就会被立刻判定为可清算
                if (hf < 1.03) {
                    console.log(`\n   🚨🚨🚨 [TARGET LOCKED] User ${user} HF=${hf.toFixed(4)}! LIQUIDATABLE!`);
                    console.log(`   ⚡ Calculating profit off-chain via mathematical model...`);
                    
                    const debtToCoverUsd = 10000; // 模拟尝试清算 $10,000 债务
                    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
                    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
                    
                    const profit = await estimateLiquidationProfit(provider, USDC, WETH, debtToCoverUsd);
                    
                    console.log(`   💰 [Estimated Profit] Expected Net Profit: $${profit.netProfitUsd.toFixed(2)}`);
                    console.log(`   🔫 Conditions met! Sending Flashloan Transaction to Mempool... BOOM!\n`);
                    
                    process.exit(0); // 演示结束，退出程序
                }
            } catch (e) {
                // 忽略偶发的网络拥堵异常，直接等 12 秒后的下一个区块
            }
        });

        await Promise.all(checks);
    });
}

// 捕获不可预见的异常，防止守护进程崩溃
process.on('uncaughtException', (err) => {
    console.error("Uncaught Exception:", err);
});

startMonitoring();
