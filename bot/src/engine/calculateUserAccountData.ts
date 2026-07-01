import { ReserveDataView, UserPositionView, UserAccountData } from './views';
import { MAX_UINT256 } from '../math/constants';
import { rayMul, wadDiv } from '../math/WadRayMath';
import { percentMul } from '../math/PercentageMath';
import { calculateCompoundedInterest } from '../math/MathUtils';
import { config } from '../config';  // centralized for E-Mode params (multi-chain aware, no hardcodes in engine)

export function calculateUserAccountData(
    userPosition: UserPositionView,
    reservesConfig: Map<string, ReserveDataView>,
    currentTimestamp: bigint
): UserAccountData {
    let totalCollateralBase = 0n;
    let totalDebtBase = 0n;
    let avgLiquidationThreshold = 0n;

    const collateralAssetsBase = new Map<string, bigint>();
    const debtAssetsBase = new Map<string, bigint>();
    const collateralAssetsToken = new Map<string, bigint>();
    const debtAssetsToken = new Map<string, bigint>();

    for (const [asset, userReserveInfo] of userPosition.reservesData.entries()) {
        const reserve = reservesConfig.get(asset);
        if (!reserve) {
            throw new Error(`Reserve config missing for asset: ${asset}`);
        }

        const unit = 10n ** reserve.decimals;

        // 1. Calculate Collateral
        if (userReserveInfo.scaledATokenBalance > 0n && userReserveInfo.isUsingAsCollateral) {
            // Revert scaled balance back to actual balance using the liquidity index
            const actualCollateral = rayMul(userReserveInfo.scaledATokenBalance, reserve.liquidityIndex);
            // Convert to base currency (USD/ETH depending on oracle base)
            const collateralBase = (actualCollateral * reserve.priceInBaseCurrency) / unit;
            
            totalCollateralBase += collateralBase;
            collateralAssetsBase.set(asset, collateralBase);
            collateralAssetsToken.set(asset, actualCollateral);

            // E-Mode override (full support): if user's eModeCategoryId > 0 AND this reserve belongs to same category,
            // use the E-Mode's liquidationThreshold (higher for correlated assets) instead of reserve base LT.
            // Same principle applies to liquidationBonus (used in profitCalculator for seize amounts).
            // Uses centralized config.getEModeCategoryData for params (supports ETH/ARB/Base different cats).
            // Isolation note: does not override LT/bonus here; affects only which collateral(s) enabled (via isUsingAsCollateral from userConfig)
            // and borrow caps (debtCeiling vs isolationModeTotalDebt). HF uses enabled collaterals only.
            let effectiveLT = reserve.liquidationThreshold;
            const userEMode = userPosition.eModeCategoryId || 0;
            if (userEMode > 0 && reserve.eModeCategory === userEMode) {
                const emData = config.getEModeCategoryData(undefined, userEMode);
                if (emData && emData.liquidationThreshold > 0n) {
                    effectiveLT = emData.liquidationThreshold;
                }
            }
            // Accumulate weighted threshold (use effective)
            avgLiquidationThreshold += (collateralBase * effectiveLT);
        }

        let assetDebtBase = 0n;
        let assetDebtToken = 0n;

        // 2. Calculate Variable Debt
        if (userReserveInfo.scaledVariableDebt > 0n) {
            const actualDebt = rayMul(userReserveInfo.scaledVariableDebt, reserve.variableBorrowIndex);
            assetDebtToken += actualDebt;
            assetDebtBase += (actualDebt * reserve.priceInBaseCurrency) / unit;
        }

        // 3. Calculate Stable Debt
        if (userReserveInfo.principalStableDebt > 0n) {
            const cumulatedInterest = calculateCompoundedInterest(
                userReserveInfo.stableBorrowRate,
                userReserveInfo.stableRateLastUpdated,
                currentTimestamp
            );
            const actualStableDebt = rayMul(userReserveInfo.principalStableDebt, cumulatedInterest);
            assetDebtToken += actualStableDebt;
            assetDebtBase += (actualStableDebt * reserve.priceInBaseCurrency) / unit;
        }

        if (assetDebtBase > 0n) {
            totalDebtBase += assetDebtBase;
            debtAssetsBase.set(asset, assetDebtBase);
            debtAssetsToken.set(asset, assetDebtToken);
        }
    }

    // Average out the liquidation threshold based on the total collateral
    if (totalCollateralBase > 0n) {
        avgLiquidationThreshold = avgLiquidationThreshold / totalCollateralBase;
    }

    let healthFactor = MAX_UINT256;

    // Calculate Health Factor
    // HF = (TotalCollateralBase * AvgLT) / TotalDebtBase
    if (totalDebtBase !== 0n) {
        const collateralWithThreshold = percentMul(totalCollateralBase, avgLiquidationThreshold);
        healthFactor = wadDiv(collateralWithThreshold, totalDebtBase);
    }

    // E-Mode + Isolation handled above for LT (via effective + config). See views + addresses for data flow.
    // Full bonus override applied at opportunity time if needed (profitCalculator can use similar logic).
    // 0-RPC pure math preserved. Multi-chain via config (test CHAIN_ID=8453 +1).

    return {
        totalCollateralBase,
        totalDebtBase,
        avgLiquidationThreshold,
        healthFactor,
        collateralAssetsBase,
        debtAssetsBase,
        collateralAssetsToken,
        debtAssetsToken
    };
}
