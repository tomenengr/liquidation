import { ethers } from 'ethers';
import { rayMul } from '../src/math/WadRayMath';

async function check() {
    const user = "0xdb57fdf5fd24a9d0e1ea94552eb2c7bdcb28fa27";
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const blockTag = await provider.getBlockNumber();

    const pool = new ethers.Contract("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", [
        "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
        "function getReserveNormalizedIncome(address asset) view returns (uint256)"
    ], provider);

    // LDO
    const asset = "0x8236a87084f8B84306f72007F36F2618A5634494";
    const reserveData = await pool.getReserveData(asset, { blockTag });
    const aToken = new ethers.Contract(reserveData.aTokenAddress, [
        "function scaledBalanceOf(address user) view returns (uint256)",
        "function balanceOf(address user) view returns (uint256)"
    ], provider);

    const scaled = await aToken.scaledBalanceOf(user, { blockTag });
    const balance = await aToken.balanceOf(user, { blockTag });
    const index = await pool.getReserveNormalizedIncome(asset, { blockTag });

    const tsBalance = rayMul(BigInt(scaled), BigInt(index));

    console.log("Scaled:", scaled);
    console.log("Index:", index);
    console.log("EVM Balance:", balance);
    console.log("TS  Balance:", tsBalance);
}

check().catch(console.error);
