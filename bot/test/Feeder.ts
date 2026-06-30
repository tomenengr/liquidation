import { ethers } from 'ethers';
import { ReserveDataView, UserPositionView, UserReservePosition } from '../src/engine/views';

// Contract Addresses on Mainnet
const POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".toLowerCase();
const ORACLE_ADDRESS = "0x54586bE62E3c3580375aE3723C145253060Ca0C2".toLowerCase();
const DATA_PROVIDER_ADDRESS = "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD".toLowerCase();

const POOL_ABI = [
    "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
    "function getUserConfiguration(address user) view returns (tuple(uint256 data))",
    "function getReserveNormalizedIncome(address asset) view returns (uint256)",
    "function getReserveNormalizedVariableDebt(address asset) view returns (uint256)"
];

const ORACLE_ABI = [
    "function getAssetPrice(address asset) view returns (uint256)"
];

const DATA_PROVIDER_ABI = [
    "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)"
];

const SCALED_BALANCE_ABI = [
    "function scaledBalanceOf(address user) view returns (uint256)"
];

const STABLE_DEBT_ABI = [
    "function principalBalanceOf(address user) view returns (uint256)",
    "function getUserStableRate(address user) view returns (uint256)",
    "function getUserLastUpdated(address user) view returns (uint40)"
];

export class Feeder {
    provider: ethers.JsonRpcProvider;
    pool: ethers.Contract;
    oracle: ethers.Contract;
    dataProvider: ethers.Contract;

    constructor(rpcUrl: string) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, this.provider);
        this.oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, this.provider);
        this.dataProvider = new ethers.Contract(DATA_PROVIDER_ADDRESS, DATA_PROVIDER_ABI, this.provider);
    }

    async fetchReserveData(asset: string, blockTag: number): Promise<ReserveDataView> {
        const [
            price,
            configData,
            liquidityIndex,
            variableBorrowIndex
        ] = await Promise.all([
            this.oracle.getAssetPrice(asset, { blockTag }),
            this.dataProvider.getReserveConfigurationData(asset, { blockTag }),
            this.pool.getReserveNormalizedIncome(asset, { blockTag }),
            this.pool.getReserveNormalizedVariableDebt(asset, { blockTag })
        ]);

        return {
            asset,
            decimals: BigInt(configData.decimals),
            priceInBaseCurrency: BigInt(price),
            liquidityIndex: BigInt(liquidityIndex),
            variableBorrowIndex: BigInt(variableBorrowIndex),
            liquidationThreshold: BigInt(configData.liquidationThreshold),
            liquidationBonus: BigInt(configData.liquidationBonus)
        };
    }

    async fetchUserPosition(user: string, assets: string[], blockTag: number): Promise<UserPositionView> {
        const userConfig = await this.pool.getUserConfiguration(user, { blockTag });
        const configBitmap = BigInt(userConfig.data);

        const reservesData = new Map<string, UserReservePosition>();

        for (const asset of assets) {
            const reserveData = await this.pool.getReserveData(asset, { blockTag });
            const aToken = new ethers.Contract(reserveData.aTokenAddress, SCALED_BALANCE_ABI, this.provider);
            const vToken = new ethers.Contract(reserveData.variableDebtTokenAddress, SCALED_BALANCE_ABI, this.provider);
            const sToken = new ethers.Contract(reserveData.stableDebtTokenAddress, STABLE_DEBT_ABI, this.provider);

            const [scaledAToken, scaledVDebt, principalStable, stableRate, stableUpdated] = await Promise.all([
                aToken.scaledBalanceOf(user, { blockTag }),
                vToken.scaledBalanceOf(user, { blockTag }),
                sToken.principalBalanceOf(user, { blockTag }),
                sToken.getUserStableRate(user, { blockTag }),
                sToken.getUserLastUpdated(user, { blockTag })
            ]);

            // Aave UserConfigurationMap logic: isUsingAsCollateral is at bit index (id * 2 + 1)
            const reserveId = BigInt(reserveData.id);
            const isUsingAsCollateral = (configBitmap & (1n << (reserveId * 2n + 1n))) !== 0n;

            reservesData.set(asset, {
                isUsingAsCollateral,
                scaledATokenBalance: BigInt(scaledAToken),
                scaledVariableDebt: BigInt(scaledVDebt),
                principalStableDebt: BigInt(principalStable),
                stableBorrowRate: BigInt(stableRate),
                stableRateLastUpdated: BigInt(stableUpdated)
            });
        }

        return {
            user,
            reservesData
        };
    }
}
