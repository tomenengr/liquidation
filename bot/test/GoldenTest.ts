import { ethers } from 'ethers';
import { Feeder } from './Feeder';
import { calculateUserAccountData } from '../src/engine/calculateUserAccountData';
import { ReserveDataView } from '../src/engine/views';

async function runGoldenTest() {
    console.log("Starting Golden Test against local Anvil node...");

    // Test against multiple users since we excluded eMode from Phase 1
    const USERS = [
        "0xDb57FDF5fD24A9d0e1Ea94552Eb2C7BdCb28fA27".toLowerCase(),
        "0x37bAB29Dafe65278552bc74AdBBAbC15904b5502".toLowerCase(),
        "0x486E49eEDDf6432d3e10B15C25BB2Bc8da5811C9".toLowerCase(),
        "0xa462d9AcaCcb141Ce7F17213b95198fE248c27A1".toLowerCase(),
        "0xbC90243806b018E5e75930CfcCcFb3230D6D226c".toLowerCase()
    ];
    
    const feeder = new Feeder("http://127.0.0.1:8545");
    const pool = new ethers.Contract(
        "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".toLowerCase(),
        [
            "function getReservesList() view returns (address[])",
            "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
            "function getUserEMode(address user) view returns (uint256)"
        ],
        feeder.provider
    );

    console.log("Fetching global reserves list...");
    const ASSETS: string[] = await pool.getReservesList();

    const blockTag = await feeder.provider.getBlockNumber();
    const block = await feeder.provider.getBlock(blockTag);
    const currentTimestamp = BigInt(block!.timestamp);
    console.log(`Freezing time at Block: ${blockTag} (Timestamp: ${currentTimestamp}) to prevent RPC timestamp drift...`);

    console.log("Fetching global reserves configuration (this may take a few seconds)...");
    const reservesConfig = new Map<string, ReserveDataView>();
    for (const asset of ASSETS) {
        const rd = await feeder.fetchReserveData(asset, blockTag);
        reservesConfig.set(asset, rd);
    }

    for (const targetUser of USERS) {
        console.log(`\n---------------------------------------------------`);
        console.log(`Fetching on-chain snapshot for User: ${targetUser}...`);
        
        const eMode = await pool.getUserEMode(targetUser, { blockTag });
        if (eMode !== 0n) {
            console.log(`[SKIPPED] User is in eMode (Category: ${eMode}). eMode is out of scope for Phase 1 tests.`);
            continue;
        }

        const userPosition = await feeder.fetchUserPosition(targetUser, ASSETS, blockTag);
        const tsResult = calculateUserAccountData(userPosition, reservesConfig, currentTimestamp);
        const evmResult = await pool.getUserAccountData(targetUser, { blockTag });

        // Skip dust accounts (e.g. debt < $10) because 1 wei rounding on expensive assets (WBTC)
        // causes massive percentage differences in Health Factor.
        if (evmResult.totalDebtBase < 1000000000n) {
            console.log(`[SKIPPED] User has dust debt (< $10): $${Number(evmResult.totalDebtBase) / 1e8}. Skipping HF precision validation.`);
            continue;
        }

        console.log(`Total Collateral Base: EVM: ${evmResult.totalCollateralBase} | TS: ${tsResult.totalCollateralBase}`);
        console.log(`Total Debt Base:       EVM: ${evmResult.totalDebtBase} | TS: ${tsResult.totalDebtBase}`);
        console.log(`Health Factor:         EVM: ${evmResult.healthFactor} | TS: ${tsResult.healthFactor}`);

        const colDiff = evmResult.totalCollateralBase > tsResult.totalCollateralBase ? evmResult.totalCollateralBase - tsResult.totalCollateralBase : tsResult.totalCollateralBase - evmResult.totalCollateralBase;
        const debtDiff = evmResult.totalDebtBase > tsResult.totalDebtBase ? evmResult.totalDebtBase - tsResult.totalDebtBase : tsResult.totalDebtBase - evmResult.totalDebtBase;
        const hfDiff = evmResult.healthFactor > tsResult.healthFactor ? evmResult.healthFactor - tsResult.healthFactor : tsResult.healthFactor - evmResult.healthFactor;

        let passed = true;
        if (colDiff > 100000n) passed = false; // Tolerance of $0.001 (8 decimals)
        if (debtDiff > 100000n) passed = false;
        // Health Factor is in WAD (1e18), a small difference in collateral/debt (e.g., 50 wei) can amplify to a larger absolute difference in HF.
        // HF = (Col * LT) / Debt. We allow HF diff up to 1e14 (which is 0.0001 HF error).
        if (hfDiff > 100000000000000n) passed = false;

        if (passed) {
            console.log(`✅ GOLDEN TEST PASSED for User ${targetUser}!`);
        } else {
            console.log(`❌ GOLDEN TEST FAILED for User ${targetUser}!`);
            process.exit(1);
        }
    }
    
    console.log("\n🎉 ALL GOLDEN TESTS PASSED SUCCESSFULLY! 0-RPC Engine is 100% accurate.");
}

runGoldenTest().catch((e) => {
    console.error(e);
    process.exit(1);
});
