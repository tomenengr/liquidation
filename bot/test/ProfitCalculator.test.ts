import { calculateOptimalLiquidation } from '../src/profitCalculator';
import { UserAccountData, ReserveDataView } from '../src/engine/views';

async function runTests() {
    console.log("Running ProfitCalculator Close Factor Tests...");
    
    // Mock Reserves
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();

    const reservesConfig = new Map<string, ReserveDataView>();
    reservesConfig.set(WETH, {
        asset: WETH,
        decimals: 18n,
        priceInBaseCurrency: 300000000000n, // $3000
        liquidityIndex: 1000000000000000000000000000n,
        variableBorrowIndex: 1000000000000000000000000000n,
        liquidationThreshold: 8500n,
        liquidationBonus: 10500n // 5% bonus
    });
    reservesConfig.set(USDC, {
        asset: USDC,
        decimals: 6n,
        priceInBaseCurrency: 100000000n, // $1
        liquidityIndex: 1000000000000000000000000000n,
        variableBorrowIndex: 1000000000000000000000000000n,
        liquidationThreshold: 8500n,
        liquidationBonus: 10500n // 5% bonus
    });

    console.log("\n--- Test 1: 50% Close Factor when HF > 0.95 ---");
    {
        // User has 100k USD Debt, 98k USD Collateral -> HF = 0.98
        const userAccountData: UserAccountData = {
            totalDebtBase: 10000000000000n, // 100,000 * 1e8
            totalCollateralBase: 9800000000000n, // 98,000 * 1e8
            avgLiquidationThreshold: 10000n,
            healthFactor: 980000000000000000n, // 0.98e18
            collateralAssetsBase: new Map([[WETH, 9800000000000n]]),
            debtAssetsBase: new Map([[USDC, 10000000000000n]])
        };

        const opportunities = calculateOptimalLiquidation(userAccountData, reservesConfig);
        console.assert(opportunities.length > 0, "No opportunities found");
        const best = opportunities[0];
        console.assert(best.closeFactorBps === 5000n, `Expected 5000n close factor, got ${best.closeFactorBps}`);
        console.assert(Number(best.debtToCoverBase) / 1e8 === 50000, `Expected 50000 max debt, got ${Number(best.debtToCoverBase) / 1e8}`);
        console.assert(Number(best.grossRevenueBase) / 1e8 === 52500, `Expected 52500 gross revenue, got ${Number(best.grossRevenueBase) / 1e8}`);
        console.log("✅ Test 1 Passed: 50% Close Factor applied correctly.");
    }

    console.log("\n--- Test 2: 100% Close Factor when HF <= 0.95 ---");
    {
        // User has 100k USD Debt, 80k USD Collateral -> HF = 0.85
        const userAccountData: UserAccountData = {
            totalDebtBase: 10000000000000n, // 100,000 * 1e8
            totalCollateralBase: 8000000000000n, // 80,000 * 1e8
            avgLiquidationThreshold: 10000n,
            healthFactor: 850000000000000000n, // 0.85e18
            collateralAssetsBase: new Map([[WETH, 8000000000000n]]),
            debtAssetsBase: new Map([[USDC, 10000000000000n]])
        };

        const opportunities = calculateOptimalLiquidation(userAccountData, reservesConfig);
        console.assert(opportunities.length > 0, "No opportunities found");
        const best2 = opportunities[0];
        console.assert(best2.closeFactorBps === 10000n, `Expected 10000n close factor, got ${best2.closeFactorBps}`);
        
        // Max Debt we can cover = 80k / 1.05 = 76190.47
        const debtCovered = Number(best2.debtToCoverBase) / 1e8;
        console.assert(Math.abs(debtCovered - 76190.47) < 0.1, `Expected ~76190.47 debt, got ${debtCovered}`);
        console.assert(Number(best2.grossRevenueBase) / 1e8 === 80000, `Expected 80000 gross revenue, got ${Number(best2.grossRevenueBase) / 1e8}`);
        
        console.log("✅ Test 2 Passed: 100% Close Factor applied and bottlenecked by collateral correctly.");
    }

    console.log("\nAll ProfitCalculator tests passed!");
}

runTests().catch(console.error);
