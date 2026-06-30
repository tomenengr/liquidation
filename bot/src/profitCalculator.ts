import { ethers } from "ethers";

const PROTOCOL_DATA_PROVIDER = "0x7B4EB56E7CD4b454AA8ac22C3132228E61EE8258"; // Aave V3 ProtocolDataProvider
const DATA_PROVIDER_ABI = [
    "function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)"
];

export async function estimateLiquidationProfit(
    provider: ethers.Provider,
    debtAsset: string,
    collateralAsset: string,
    debtToCoverUsd: number
): Promise<{ netProfitUsd: number, marginPct: number }> {
    const dataProvider = new ethers.Contract(PROTOCOL_DATA_PROVIDER, DATA_PROVIDER_ABI, provider);

    // 1. 获取清算奖励参数
    // Aave 的 bonus 是以 10000 为基数的，比如 10500 代表 5% 的清算奖励
    const config = await dataProvider.getReserveConfigurationData(collateralAsset);
    const liquidationBonus = Number(config.liquidationBonus); 
    const bonusPct = (liquidationBonus / 10000) - 1.0; 

    // 2. 核心经济学计算 (以 USD 计价的理论纯数学模型)
    // 收入：你帮用户还钱，协议按照预言机价格 + 奖励比例，把抵押物给你
    const grossRevenueUsd = debtToCoverUsd * (1 + bonusPct);
    
    // 成本：
    // - 偿还债务的本金 (debtToCoverUsd)
    // - 闪电贷手续费 (Aave V3 是 0.05%)
    // - DEX 卖出抵押物换回债务资产时的滑点 (我们在模型里预估保守一点，算 0.3%)
    // - 链上 Gas 费估算 (假设一笔清算消耗 50万 Gas，GasPrice 20 gwei，ETH=3000刀 -> 约 30刀成本，暂略简化)
    const flashloanFeePct = 0.0005; 
    const dexSlippagePct = 0.003;   
    const costUsd = debtToCoverUsd * (1 + flashloanFeePct + dexSlippagePct);
    
    // 3. 净利润
    const netProfitUsd = grossRevenueUsd - costUsd;
    const marginPct = netProfitUsd / debtToCoverUsd;
    
    return {
        netProfitUsd,
        marginPct
    };
}
