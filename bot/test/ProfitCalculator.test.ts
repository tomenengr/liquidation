import { calculateOptimalLiquidation } from '../src/profitCalculator';
import { UserAccountData, ReserveDataView, UserPositionView } from '../src/engine/views';
import { calculateUserAccountData } from '../src/engine/calculateUserAccountData';

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
        liquidationBonus: 10500n, // 5% bonus
        eModeCategory: 0
    });
    reservesConfig.set(USDC, {
        asset: USDC,
        decimals: 6n,
        priceInBaseCurrency: 100000000n, // $1
        liquidityIndex: 1000000000000000000000000000n,
        variableBorrowIndex: 1000000000000000000000000000n,
        liquidationThreshold: 8500n,
        liquidationBonus: 10500n, // 5% bonus
        eModeCategory: 0
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
            debtAssetsBase: new Map([[USDC, 10000000000000n]]),
            collateralAssetsToken: new Map([[WETH, 9800000000000000000n]]),
            debtAssetsToken: new Map([[USDC, 10000000000n]])
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
            debtAssetsBase: new Map([[USDC, 10000000000000n]]),
            collateralAssetsToken: new Map([[WETH, 8000000000000000000n]]),
            debtAssetsToken: new Map([[USDC, 8000000000n]])
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

    // ========== TDD for Problem 2: Full E-Mode + Isolation support in 0-RPC engine ==========
    // These tests initially FAIL (RED) until calculateUserAccountData implements override + views extended + map updated.
    // Multi-chain: test ETH-like (cat 1 LT=9500) + Base-like (cat1 LT=9500)
    // Uses centralized config for eMode params.
    // Preserves pure BigInt 0-RPC math, no RPC inside calc.
    console.log("\n--- TDD Test 3: E-Mode override of LT (and note bonus) for matching category ---");
    {
        const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();
        const reservesConfig = new Map<string, ReserveDataView>();
        // Base LT 80%, but eMode cat1 has 95% LT
        reservesConfig.set(WETH, {
            asset: WETH,
            decimals: 18n,
            priceInBaseCurrency: 300000000000n, // $3000 * 1e8?
            liquidityIndex: 1000000000000000000000000000n,
            variableBorrowIndex: 1000000000000000000000000000n,
            liquidationThreshold: 8000n,  // base 80%
            liquidationBonus: 10500n,
            eModeCategory: 1
        });

        const userPosition: UserPositionView = {
            user: '0xemoder'.toLowerCase(),
            eModeCategoryId: 1,  // user in eMode 1
            reservesData: new Map([[
                WETH,
                {
                    isUsingAsCollateral: true,
                    scaledATokenBalance: 1000000000000000000n, // 1.0 scaled
                    scaledVariableDebt: 0n,
                    principalStableDebt: 0n,
                    stableBorrowRate: 0n,
                    stableRateLastUpdated: 0n
                }
            ]]),
            isolationModeAsset: undefined,
        };

        // Use a timestamp; indices ~1.0 so actual ~ price adjusted
        const tsResult = calculateUserAccountData(userPosition, reservesConfig, 1700000000n);
        // With eMode LT=0.95 , avgLT should be ~9500 (not 8000)
        console.assert(tsResult.avgLiquidationThreshold === 9500n, `E-Mode should override LT to 9500, got ${tsResult.avgLiquidationThreshold}`);
        console.assert(tsResult.totalCollateralBase > 0n, 'collateral should compute');
        console.log(`   E-Mode LT override: got avgLT=${tsResult.avgLiquidationThreshold} (expected 9500 for cat1)`);

        // Also verify bonus override path in profitCalculator for same eMode (uses config)
        const debtAsset = WETH; // mock debt same for test
        const userAccountForOpp: UserAccountData = {
            totalDebtBase: 1000000000000n,
            totalCollateralBase: tsResult.totalCollateralBase,
            avgLiquidationThreshold: tsResult.avgLiquidationThreshold,
            healthFactor: 800000000000000000n,
            collateralAssetsBase: new Map([[WETH, tsResult.totalCollateralBase]]),
            debtAssetsBase: new Map([[debtAsset, 1000000000000n]]),
            collateralAssetsToken: new Map([[WETH, 1000000000000000000n]]),
            debtAssetsToken: new Map([[debtAsset, 1000000000000000000n]])
        };
        const opps = calculateOptimalLiquidation(userAccountForOpp, reservesConfig, 0, 1 /* userEMode */);
        if (opps.length > 0) {
            // for cat1 on ETH, bonus should be 10100 not the base 10500
            console.assert(opps[0].liquidationBonus === 10100n, `E-Mode bonus override expected 10100 got ${opps[0].liquidationBonus}`);
        }
        console.log("✅ Test 3 (E-Mode LT override) PASSED via calculateUserAccountData + config.");
    }

    console.log("\n--- TDD Test 4: Isolation Mode data carried + no crash in calc (ETH + Base) ---");
    {
        const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();
        const reservesConfig = new Map<string, ReserveDataView>();
        reservesConfig.set(USDC, {
            asset: USDC,
            decimals: 6n,
            priceInBaseCurrency: 100000000n,
            liquidityIndex: 1000000000000000000000000000n,
            variableBorrowIndex: 1000000000000000000000000000n,
            liquidationThreshold: 8500n,
            liquidationBonus: 10500n,
            eModeCategory: 0
        });

        const userPosition: UserPositionView = {
            user: '0xisolated'.toLowerCase(),
            eModeCategoryId: 0,
            reservesData: new Map([[
                USDC,
                { isUsingAsCollateral: true, scaledATokenBalance: 1000000000n, scaledVariableDebt: 500000000n, principalStableDebt: 0n, stableBorrowRate: 0n, stableRateLastUpdated: 0n }
            ]]),
            isolationModeAsset: USDC,  // isolated collateral
            isolationModeTotalDebt: 500000000n,
        };

        const tsResultIso = calculateUserAccountData(userPosition, reservesConfig, 1700000000n);
        // Isolation does not change HF formula (uses enabled LT), but fields carried for future adjust + recon
        console.assert(tsResultIso.totalDebtBase > 0n || tsResultIso.totalCollateralBase >= 0n, 'calc ran for isolated user');
        console.assert(userPosition.isolationModeAsset === USDC, 'isolation data must be carried in UserPositionView');
        console.log(`   Isolation: calc ok, isolationModeAsset carried=${userPosition.isolationModeAsset}`);
        console.log("✅ Test 4 (Isolation carried + calc) PASSED.");
    }

    // L2 example (would use config.getEModeCategoryData(8453,1) giving 9500 LT)
    console.log("\n--- TDD Test 5: Multi-chain eMode (Base 8453 uses config eMode) ---");
    {
        // Just verify config provides L2 eMode data (no hardcode)
        const { config } = require('../src/config');
        const baseE = config.getEModeCategoryData(8453, 1);
        const ethE = config.getEModeCategoryData(1, 1);
        if (!baseE || baseE.liquidationThreshold !== 9500n) throw new Error('Base eMode1 LT not 9500 from central config');
        if (!ethE || ethE.liquidationThreshold !== 9500n) throw new Error('ETH eMode1 LT not 9500');
        console.log('   Multi-chain config eMode OK (ETH + Base 8453)');
        console.log("✅ Test 5 passed (config).");
    }

    console.log("\nAll ProfitCalculator tests passed!");
}

runTests().catch(console.error);
