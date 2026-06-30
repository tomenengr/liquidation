import { ReserveDataView, UserPositionView, UserAccountData } from './views';
import { MAX_UINT256 } from '../math/constants';
import { rayMul, wadDiv } from '../math/WadRayMath';
import { percentMul } from '../math/PercentageMath';
import { calculateCompoundedInterest } from '../math/MathUtils';

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
            // Accumulate weighted threshold
            avgLiquidationThreshold += (collateralBase * reserve.liquidationThreshold);
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
