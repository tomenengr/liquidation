import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

// 1. 真实的主网 WebSocket RPC (生产环境中 HTTP 轮询太慢，必须用 WSS 实时监听)
// 这里替换为你的 Alchemy WSS 链接 (将 https 换成 wss)
const RPC_URL = "wss://eth-mainnet.g.alchemy.com/v2/EHzHIlUjFLRkUJLVxDN-vh1wJorLrTeM";
const provider = new ethers.WebSocketProvider(RPC_URL);

// 2. Aave V3 核心合约
const POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const POOL_ABI = [
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];
const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);

// 3. 我们要实时监控的大户名单 (生产环境会从数据库读，这里硬编码几个著名的巨鲸地址作为 Demo)
const whales = [
    "0x892a6f9df0147e5f079b0993f486f9aca3c87881", // 某知名 DeFi 巨鲸
    "0x1111111254fb6c44bac0bed2854e76f90643097d"  // 1inch 路由地址 (仅作监听测试)
];

async function main() {
    console.log("🟢 Production Liquidation Bot Started.");
    console.log(`📡 Connected to WebSocket node. Listening for real-time blocks...`);
    
    // 4. 生产级高并发：监听每一个新出的以太坊区块 (约 12 秒一个)
    provider.on("block", async (blockNumber) => {
        console.log(`\n📦 [Block ${blockNumber}] Mined! Scanning ${whales.length} whales...`);
        
        // 5. 并发查询所有监控对象的健康因子
        const checks = whales.map(async (user) => {
            try {
                const data = await pool.getUserAccountData(user);
                const hf = Number(ethers.formatUnits(data.healthFactor, 18));
                
                // 为了演示，如果没获取到，我们过滤掉非常大(type(uint256).max)的初始默认值
                if (hf > 1000) return; 

                // 生产级：只打印危险的，减少控制台 IO，提高性能
                if (hf < 1.1 && hf >= 1.0) {
                   console.log(`⚠️ WARNING: User ${user.slice(0,8)}... HF is dropping: ${hf.toFixed(4)}`);
                }
                
                // 6. 跌破 1.0！立刻触发清算
                if (hf < 1.0) {
                   console.log(`🚨 TARGET LOCKED! User ${user} HF is ${hf.toFixed(4)}!`);
                   console.log(`⚡ Initiating Flashloan transaction...`);
                   // const tx = await liquidatorContract.executeLiquidation(...);
                   // await tx.wait();
                } else {
                   console.log(`User ${user.slice(0,8)}... HF: ${hf.toFixed(4)} (Safe)`);
                }
            } catch (err) {
                // 网络波动导致偶尔查询失败是正常的，catch 掉避免进程崩溃
                console.error(`[Error] Failed to fetch data for ${user.slice(0,8)}`);
            }
        });
        
        await Promise.all(checks);
    });
}

// 捕获异常，防止 WebSocket 断开导致程序退出
process.on('uncaughtException', (err) => {
    console.error("Uncaught Exception:", err);
});

main().catch(console.error);
