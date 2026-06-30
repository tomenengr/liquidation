import { ReserveDataView, UserAccountData } from "./engine/views";

export interface LiquidationOpportunity {
    debtAsset: string;
    collateralAsset: string;
    debtToCoverBase: bigint;      // Base currency (USD, 8 decimals)
    debtToCoverToken: bigint;     // Token units (e.g. 18 decimals for WETH, 6 for USDC)
    expectedCollateralBase: bigint; // Expected return in Base Currency before bonus
    expectedCollateralToken: bigint; // Expected return in Token units
    grossRevenueBase: bigint;     // Base currency (includes bonus)
    estimatedCostBase: bigint;    // Base currency (Flashloan fee + slippage)
    estimatedNetProfitBase: bigint; // Base currency
    closeFactorBps: bigint;       // 5000n or 10000n
    liquidationBonus: bigint;     // e.g. 10500 for 5%
}

// Aave V3 Constants (using basis points for pure BigInt math)
const CLOSE_FACTOR_HF_THRESHOLD = 950000000000000000n; // 0.95e18
const DEFAULT_LIQUIDATION_CLOSE_FACTOR_BPS = 5000n; // 50.00%
const MAX_LIQUIDATION_CLOSE_FACTOR_BPS = 10000n; // 100.00%
const FLASHLOAN_FEE_BPS = 5n; // 0.05%
const SLIPPAGE_ESTIMATE_BPS = 30n; // 0.30%
const BPS_DENOMINATOR = 10000n;

export function calculateOptimalLiquidation(
    userAccountData: UserAccountData,
    reservesConfig: Map<string, ReserveDataView>
): LiquidationOpportunity[] {
    const opportunities: LiquidationOpportunity[] = [];

    // 1. Determine Close Factor based on Health Factor
    const closeFactorBps = userAccountData.healthFactor > CLOSE_FACTOR_HF_THRESHOLD 
        ? DEFAULT_LIQUIDATION_CLOSE_FACTOR_BPS 
        : MAX_LIQUIDATION_CLOSE_FACTOR_BPS;

    // 2. Calculate Max Liquidatable Debt in Base Currency (Applies to TOTAL DEBT)
    const maxLiquidatableDebtBase = (userAccountData.totalDebtBase * closeFactorBps) / BPS_DENOMINATOR;

    // Iterate N x M pairs
    for (const [debtAsset, userDebtBalanceBase] of userAccountData.debtAssetsBase.entries()) {
        if (userDebtBalanceBase === 0n) continue;

        // You can repay a specific debt asset up to maxLiquidatableDebtBase OR its own balance
        const actualMaxDebtToCoverBase = userDebtBalanceBase > maxLiquidatableDebtBase ? maxLiquidatableDebtBase : userDebtBalanceBase;

        for (const [collateralAsset, userCollateralBalanceBase] of userAccountData.collateralAssetsBase.entries()) {
            if (userCollateralBalanceBase === 0n) continue;

            const collateralConfig = reservesConfig.get(collateralAsset);
            const debtConfig = reservesConfig.get(debtAsset);
            if (!collateralConfig || !debtConfig) continue;

            const liquidationBonus = collateralConfig.liquidationBonus; // e.g. 10500

            // Calculate how much collateral we would seize if we paid ALL the actualMaxDebtToCoverBase
            const theoreticalMaxSeizableCollateralBase = (actualMaxDebtToCoverBase * liquidationBonus) / BPS_DENOMINATOR;

            let debtToCoverBase: bigint;
            let seizedCollateralBase: bigint;
            let debtToCoverToken: bigint;
            let expectedCollateralToken: bigint;

            // Does the user have enough collateral to cover this max debt repayment + bonus?
            if (userCollateralBalanceBase >= theoreticalMaxSeizableCollateralBase) {
                // User has enough collateral. We repay the maximum debt possible.
                debtToCoverBase = actualMaxDebtToCoverBase;
                seizedCollateralBase = theoreticalMaxSeizableCollateralBase;
                
                // If we are repaying 100% of this specific debt asset, use its EXACT token balance to avoid dust reverts!
                if (actualMaxDebtToCoverBase === userDebtBalanceBase) {
                    debtToCoverToken = userAccountData.debtAssetsToken.get(debtAsset) || 
                        (debtToCoverBase * (10n ** debtConfig.decimals)) / debtConfig.priceInBaseCurrency;
                } else {
                    debtToCoverToken = (debtToCoverBase * (10n ** debtConfig.decimals)) / debtConfig.priceInBaseCurrency;
                }
                expectedCollateralToken = (seizedCollateralBase * (10n ** collateralConfig.decimals)) / collateralConfig.priceInBaseCurrency;
            } else {
                // User does NOT have enough collateral. We are bottlenecked by collateral.
                seizedCollateralBase = userCollateralBalanceBase;
                // Calculate how much debt we can cover using all their collateral
                debtToCoverBase = (userCollateralBalanceBase * BPS_DENOMINATOR) / liquidationBonus;
                
                // If we are seizing 100% of this collateral, use its EXACT token balance
                expectedCollateralToken = userAccountData.collateralAssetsToken.get(collateralAsset) || 
                    (seizedCollateralBase * (10n ** collateralConfig.decimals)) / collateralConfig.priceInBaseCurrency;
                debtToCoverToken = (debtToCoverBase * (10n ** debtConfig.decimals)) / debtConfig.priceInBaseCurrency;
            }

            // --- Cost & Revenue Analysis (in Base Currency) ---
            const grossRevenueBase = seizedCollateralBase;
            
            // Cost = Debt repaid + Flashloan Fee + Slippage
            const flashloanFeeBase = (debtToCoverBase * FLASHLOAN_FEE_BPS) / BPS_DENOMINATOR;
            const slippageBase = (seizedCollateralBase * SLIPPAGE_ESTIMATE_BPS) / BPS_DENOMINATOR;
            
            // Note: Gas Cost omitted for this mathematical iteration (would be dynamic in ExecutionRouter)
            const estimatedCostBase = debtToCoverBase + flashloanFeeBase + slippageBase;
            
            const estimatedNetProfitBase = grossRevenueBase - estimatedCostBase;

            const expectedCollateralBaseBeforeBonus = (seizedCollateralBase * BPS_DENOMINATOR) / liquidationBonus;

            opportunities.push({
                debtAsset,
                collateralAsset,
                debtToCoverBase,
                debtToCoverToken,
                expectedCollateralBase: expectedCollateralBaseBeforeBonus,
                expectedCollateralToken,
                grossRevenueBase,
                estimatedCostBase,
                estimatedNetProfitBase,
                closeFactorBps,
                liquidationBonus
            });
        }
    }

    // Sort by Net Profit (Descending)
    return opportunities.sort((a, b) => {
        if (b.estimatedNetProfitBase > a.estimatedNetProfitBase) return 1;
        if (b.estimatedNetProfitBase < a.estimatedNetProfitBase) return -1;
        return 0;
    });
}
