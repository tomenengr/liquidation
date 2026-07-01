import { ethers } from 'ethers';
import { ReserveDataView, UserPositionView, UserReservePosition } from '../src/engine/views';
import { MulticallHelper } from '../src/multicall';
import { getAddresses } from '../src/addresses';
import { config } from '../src/config';

// Use centralized multi-chain addresses (Task 1.2 + 3.12 for L2/fork tests)
function getChainAddresses(chainId?: number) {
  const id = chainId ?? config.CHAIN_ID ?? 1;
  return getAddresses(id);
}

const POOL_ABI = [
    "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
    "function getUserConfiguration(address user) view returns (tuple(uint256 data))",
    "function getReserveNormalizedIncome(address asset) view returns (uint256)",
    "function getReserveNormalizedVariableDebt(address asset) view returns (uint256)",
    "function getUserEMode(address user) view returns (uint256)"  // for E-Mode support
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
    multicall: MulticallHelper;
    private chainId: number;

    poolAddress: string;
    constructor(rpcUrl: string, chainId?: number) {
        this.chainId = chainId ?? config.CHAIN_ID ?? 1;
        const ADDRESSES = getChainAddresses(this.chainId);
        const POOL_ADDRESS = ADDRESSES.POOL.toLowerCase();
        const ORACLE_ADDRESS = ADDRESSES.ORACLE.toLowerCase();
        const DATA_PROVIDER_ADDRESS = ADDRESSES.UI_POOL_DATA_PROVIDER.toLowerCase();
        this.poolAddress = POOL_ADDRESS;

        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, this.provider);
        this.oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, this.provider);
        this.dataProvider = new ethers.Contract(DATA_PROVIDER_ADDRESS, DATA_PROVIDER_ABI, this.provider);
        this.multicall = new MulticallHelper(this.provider);
    }

    async fetchReserveData(asset: string, blockTag: number): Promise<ReserveDataView> {
        const [
            price,
            configData,
            liquidityIndex,
            variableBorrowIndex,
            rawReserveData
        ] = await Promise.all([
            this.oracle.getAssetPrice(asset, { blockTag }),
            this.dataProvider.getReserveConfigurationData(asset, { blockTag }),
            this.pool.getReserveNormalizedIncome(asset, { blockTag }),
            this.pool.getReserveNormalizedVariableDebt(asset, { blockTag }),
            this.pool.getReserveData(asset, { blockTag }).catch(() => null)
        ]);

        const rawConfig = rawReserveData && rawReserveData[0] ? BigInt(rawReserveData[0]) : 0n;
        const eModeCat = Number((rawConfig >> 168n) & 0xFFn) || 0;  // Aave packed config: eModeCategoryId for override logic

        return {
            asset,
            decimals: BigInt(configData.decimals),
            priceInBaseCurrency: BigInt(price),
            liquidityIndex: BigInt(liquidityIndex),
            variableBorrowIndex: BigInt(variableBorrowIndex),
            liquidationThreshold: BigInt(configData.liquidationThreshold),
            liquidationBonus: BigInt(configData.liquidationBonus),
            eModeCategory: eModeCat
        };
    }

    async fetchUserPosition(user: string, assets: string[], blockTag: number): Promise<UserPositionView> {
        const userConfig = await this.pool.getUserConfiguration(user, { blockTag });
        const configBitmap = BigInt(userConfig.data);

        // E-Mode support: fetch user's current eMode category (0 if none)
        let userEMode = 0;
        try {
            const em = await this.pool.getUserEMode(user, { blockTag });
            userEMode = Number(em) || 0;
        } catch {}

        const reservesData = new Map<string, UserReservePosition>();

        // Use Multicall to batch getReserveData for all assets (major reduction in RPC calls for production scale)
        const reserveResults = await this.multicall.batchGetReservesData(assets, this.pool.interface, this.poolAddress);

        const aTokenAddrs: string[] = [];
        const vTokenAddrs: string[] = [];
        const sTokenAddrs: string[] = [];
        const reserveDataList: any[] = [];

        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            const raw = reserveResults[i];
            if (!raw) {
                aTokenAddrs.push("0x0000000000000000000000000000000000000000");
                vTokenAddrs.push("0x0000000000000000000000000000000000000000");
                sTokenAddrs.push("0x0000000000000000000000000000000000000000");
                reserveDataList.push(null);
                continue;
            }
            const aAddr = raw[8] || raw.aTokenAddress;
            const sAddr = raw[9] || raw.stableDebtTokenAddress;
            const vAddr = raw[10] || raw.variableDebtTokenAddress;
            aTokenAddrs.push(aAddr);
            vTokenAddrs.push(vAddr);
            sTokenAddrs.push(sAddr);
            const rawConfig = raw[0] ? BigInt(raw[0]) : 0n;
            const reserveEModeCat = Number((rawConfig >> 168n) & 0xFFn) || 0;  // Aave config packing: eModeCategoryId at bits 168-175
            reserveDataList.push({ aTokenAddress: aAddr, stableDebtTokenAddress: sAddr, variableDebtTokenAddress: vAddr, id: BigInt(raw[7] || raw.id || 0), eModeCategory: reserveEModeCat });
        }

        // Batch the scaled balances for aTokens and vTokens
        const [scaledATokens, scaledVDebts] = await Promise.all([
            this.multicall.batchScaledBalances(user, aTokenAddrs, new ethers.Interface(SCALED_BALANCE_ABI)),
            this.multicall.batchScaledBalances(user, vTokenAddrs, new ethers.Interface(SCALED_BALANCE_ABI))
        ]);

        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            const rd = reserveDataList[i];
            if (!rd) continue;

            // For stable, we can batch too but for simplicity use parallel single (can extend)
            const sToken = new ethers.Contract(rd.stableDebtTokenAddress, STABLE_DEBT_ABI, this.provider);
            const [principalStable, stableRate, stableUpdated] = await Promise.all([
                sToken.principalBalanceOf(user, { blockTag }),
                sToken.getUserStableRate(user, { blockTag }),
                sToken.getUserLastUpdated(user, { blockTag })
            ]);

            const reserveId = rd.id;
            const isUsingAsCollateral = (configBitmap & (1n << (reserveId * 2n + 1n))) !== 0n;

            reservesData.set(asset, {
                isUsingAsCollateral,
                scaledATokenBalance: scaledATokens[i] || 0n,
                scaledVariableDebt: scaledVDebts[i] || 0n,
                principalStableDebt: BigInt(principalStable),
                stableBorrowRate: BigInt(stableRate),
                stableRateLastUpdated: BigInt(stableUpdated)
            });
        }

        return {
            user,
            eModeCategoryId: userEMode,  // now fetched for full E-Mode override support in calc
            reservesData,
            // isolation info derivable from reserve configs / userConfig bits or subgraph; engine carries if provided
        };
    }
}
