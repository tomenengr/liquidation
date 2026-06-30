import { ethers } from 'ethers';
import { Feeder } from './Feeder';
import { calculateUserAccountData } from '../src/engine/calculateUserAccountData';
import { ReserveDataView } from '../src/engine/views';
import { rayMul } from '../src/math/WadRayMath';

async function dump() {
    const user = "0xdb57fdf5fd24a9d0e1ea94552eb2c7bdcb28fa27";
    const feeder = new Feeder("http://127.0.0.1:8545");
    const pool = new ethers.Contract(
        "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        [
            "function getReservesList() view returns (address[])",
            "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"
        ],
        feeder.provider
    );

    const blockTag = await feeder.provider.getBlockNumber();
    console.log(`Dumping for block: ${blockTag}`);

    const ASSETS: string[] = await pool.getReservesList({ blockTag });
    
    let totalColEVM = 0n;
    let totalDebtEVM = 0n;

    for (const asset of ASSETS) {
        const rd = await feeder.fetchReserveData(asset, blockTag);
        const up = await feeder.fetchUserPosition(user, [asset], blockTag);
        
        const info = up.reservesData.get(asset);
        if (!info) continue;

        if (info.scaledATokenBalance > 0n || info.scaledVariableDebt > 0n) {
            console.log(`\nAsset: ${asset}`);
            console.log(`  Price: ${rd.priceInBaseCurrency} | Decimals: ${rd.decimals}`);
            console.log(`  LiquidityIndex: ${rd.liquidityIndex}`);
            console.log(`  BorrowIndex:    ${rd.variableBorrowIndex}`);
            console.log(`  Scaled AToken:  ${info.scaledATokenBalance}`);
            console.log(`  Scaled VDebt:   ${info.scaledVariableDebt}`);
            
            const unit = 10n ** rd.decimals;
            if (info.scaledATokenBalance > 0n && info.isUsingAsCollateral) {
                const actualCollateral = rayMul(info.scaledATokenBalance, rd.liquidityIndex);
                const colBase = (actualCollateral * rd.priceInBaseCurrency) / unit;
                console.log(`  => Actual AToken: ${actualCollateral}`);
                console.log(`  => Col Base:      ${colBase}`);
            }
            if (info.scaledVariableDebt > 0n) {
                const actualDebt = rayMul(info.scaledVariableDebt, rd.variableBorrowIndex);
                const debtBase = (actualDebt * rd.priceInBaseCurrency) / unit;
                console.log(`  => Actual VDebt:  ${actualDebt}`);
                console.log(`  => Debt Base:     ${debtBase}`);
            }
        }
    }

    const evm = await pool.getUserAccountData(user, { blockTag });
    console.log(`\nEVM Final:`);
    console.log(`  Col Base:  ${evm[0]}`);
    console.log(`  Debt Base: ${evm[1]}`);
}

dump().catch(console.error);
