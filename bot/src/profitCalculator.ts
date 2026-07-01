import { ReserveDataView, UserAccountData } from "./engine/views";
import { config } from "./config";

export interface LiquidationOpportunity {
    user?: string;                // the borrower address (for execution; populated from position in caller)
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
    pureBonusBase: bigint;        // Pure liquidation bonus value (for separation from arb)
}

// Aave V3 Constants (using basis points for pure BigInt math)
const CLOSE_FACTOR_HF_THRESHOLD = 950000000000000000n; // 0.95e18
const DEFAULT_LIQUIDATION_CLOSE_FACTOR_BPS = 5000n; // 50.00%
const MAX_LIQUIDATION_CLOSE_FACTOR_BPS = 10000n; // 100.00%


/**
 * Calculates viable liquidation opportunities for a user.
 * Applies hard filters for minimum debt size and minimum expected net profit
 * to avoid wasting time/gas on dust positions and unprofitable trades.
 */
export function calculateOptimalLiquidation(
    userAccountData: UserAccountData,
    reservesConfig: Map<string, ReserveDataView>,
    volPercent: number = 0,
    userEModeCategoryId: number = 0  // E-Mode support: pass user's eMode if known (from UserPositionView) for correct bonus/LT in eMode. Default 0 (no override).
): LiquidationOpportunity[] {
    const chainCfg = config.getChainConfig();
    const flashloanFeeBps = chainCfg.FLASHLOAN_FEE_BPS || config.FLASHLOAN_FEE_BPS;
    // 3.10: feed volatility into slippage estimate for opportunity calc
    const baseSlip = 30;
    const volAdj = Math.min(Math.floor(volPercent * 5), 100);
    const SLIPPAGE_ESTIMATE_BPS = BigInt(baseSlip + volAdj);
    const BPS_DENOMINATOR = 10000n;

    const opportunities: LiquidationOpportunity[] = [];

    // 1. Determine Close Factor based on Health Factor
    const closeFactorBps = userAccountData.healthFactor > CLOSE_FACTOR_HF_THRESHOLD 
        ? DEFAULT_LIQUIDATION_CLOSE_FACTOR_BPS 
        : MAX_LIQUIDATION_CLOSE_FACTOR_BPS;

    // 2. Calculate Max Liquidatable Debt in Base Currency (Applies to TOTAL DEBT)
    // Use pure BigInt to avoid precision loss on large positions
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

            // E-Mode: override bonus (and conceptually LT) if collateral's eMode matches user's.
            // Uses centralized config (multi-chain). Preserves 0-RPC.
            let liquidationBonus = collateralConfig.liquidationBonus; // e.g. 10500
            const collEModeCat = collateralConfig.eModeCategory || 0;
            if (userEModeCategoryId > 0 && collEModeCat === userEModeCategoryId) {
                const emData = config.getEModeCategoryData(undefined, userEModeCategoryId);
                if (emData && emData.liquidationBonus > 0n) {
                    liquidationBonus = emData.liquidationBonus;
                }
            }

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
            const flashloanFeeBase = (debtToCoverBase * flashloanFeeBps) / BPS_DENOMINATOR;
            const slippageBase = (seizedCollateralBase * SLIPPAGE_ESTIMATE_BPS) / BPS_DENOMINATOR;
            
            // Note: Gas Cost omitted for this mathematical iteration (would be dynamic in ExecutionRouter)
            const estimatedCostBase = debtToCoverBase + flashloanFeeBase + slippageBase;
            
            const estimatedNetProfitBase = grossRevenueBase - estimatedCostBase;

            const expectedCollateralBaseBeforeBonus = (seizedCollateralBase * BPS_DENOMINATOR) / liquidationBonus;

            // Pure Liquidation Bonus (the extra value from bonus, excluding the debt repaid value)
            const pureBonusBase = (seizedCollateralBase * (liquidationBonus - BPS_DENOMINATOR)) / BPS_DENOMINATOR;

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
                liquidationBonus,
                pureBonusBase
            });
        }
    }

    // Apply production filters to avoid dust and unprofitable work
    // These are the first line of defense; router has secondary checks.
    const c = config.getChainConfig();
    const filtered = opportunities.filter(o =>
        o.debtToCoverBase >= c.MIN_DEBT_BASE &&
        o.estimatedNetProfitBase >= c.MIN_NET_PROFIT_BASE
    );

    // Sort by Net Profit (Descending)
    return filtered.sort((a, b) => {
        if (b.estimatedNetProfitBase > a.estimatedNetProfitBase) return 1;
        if (b.estimatedNetProfitBase < a.estimatedNetProfitBase) return -1;
        return 0;
    });
}

/**
 * Helper to apply the same min filters outside the calculator (e.g. in router for safety).
 */
export function filterOpportunities(opps: LiquidationOpportunity[]): LiquidationOpportunity[] {
    const c = config.getChainConfig();
    return opps.filter(o =>
        o.debtToCoverBase >= c.MIN_DEBT_BASE &&
        o.estimatedNetProfitBase >= c.MIN_NET_PROFIT_BASE
    ).sort((a, b) => {
        if (b.estimatedNetProfitBase > a.estimatedNetProfitBase) return 1;
        if (b.estimatedNetProfitBase < a.estimatedNetProfitBase) return -1;
        return 0;
    });
}
