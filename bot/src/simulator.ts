import { ethers } from "ethers";
import { scanBorrowers } from "./scanner";
import { estimateLiquidationProfit } from "./profitCalculator";

const RPC_URL = "https://eth-mainnet.g.alchemy.com/v2/EHzHIlUjFLRkUJLVxDN-vh1wJorLrTeM";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const POOL_ABI = [
    "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];
const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);

// 常见的资产地址
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

async function runSimulator() {
    console.log("=========================================================");
    console.log("🚀 LIQUIDATION BOT SIMULATOR (PRODUCTION EDITION) 🚀");
    console.log("=========================================================\n");
    
    // 第一步：动态获取主网真实的活跃借款人
    const users = await scanBorrowers(provider, 1000);
    
    // 第二步：评估健康因子
    console.log(`\n📊 [Evaluator] Evaluating Health Factors for active positions...`);
    let riskyUsers = 0;
    
    for (const user of users) {
        try {
            const data = await pool.getUserAccountData(user);
            const hf = Number(ethers.formatUnits(data.healthFactor, 18));
            
            // 我们只关注健康因子在危险边缘的用户 (HF < 1.5)
            if (hf < 1.5 && hf > 0) {
                console.log(`   🟡 User: ${user} | Health Factor: ${hf.toFixed(4)}`);
                
                if (hf < 1.0) {
                    console.log(`   🚨 LIQUIDATABLE TARGET FOUND!`);
                    riskyUsers++;
                    
                    // 第三步：在链下预估利润 (假设他欠了 10,000 刀)
                    const assumedDebtUsd = 10000;
                    const profit = await estimateLiquidationProfit(provider, USDC, WETH, assumedDebtUsd);
                    console.log(`      💰 [Off-chain Math] Expected Gross Profit for $10k debt: $${profit.netProfitUsd.toFixed(2)} (Margin: ${(profit.marginPct * 100).toFixed(2)}%)`);
                }
            }
        } catch (e) {
            // ignore
        }
    }
    
    if (riskyUsers === 0) {
        console.log(`\n✅ [Status] Network is currently healthy. No liquidatable positions found in this sample.`);
        console.log(`💡 [Next Step] To fully simulate a liquidation, we will next use Anvil to locally fork the network, inject a mock price crash to force one of these users below HF 1.0, and execute the actual smart contract against them!`);
    }
}

runSimulator().catch(console.error);
