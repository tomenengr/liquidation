import { ethers } from 'ethers';
import { Feeder } from '../test/Feeder';
import { calculateUserAccountData } from './engine/calculateUserAccountData';
import { calculateOptimalLiquidation } from './profitCalculator';
import { ExecutionRouter } from './ExecutionRouter';
import { ReserveDataView, UserPositionView } from './engine/views';
import fs from 'fs';

const RPC_URL = "http://127.0.0.1:8545";
const POOL_ADDRESS = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // V3 SwapRouter (V1)
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil #0

async function deployLiquidator(wallet: ethers.Wallet): Promise<ethers.Contract> {
    const artifactPath = "./out/FlashLiquidator.sol/FlashLiquidator.json";
    if (!fs.existsSync(artifactPath)) {
        throw new Error(`Artifact not found at ${artifactPath}. Run 'forge build' first.`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    
    console.log("Deploying FlashLiquidator...");
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
    const ADDRESS_PROVIDER = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";
    const liquidator = await factory.deploy(ADDRESS_PROVIDER, SWAP_ROUTER_ADDRESS);
    await liquidator.waitForDeployment();
    const address = await liquidator.getAddress();
    console.log(`FlashLiquidator deployed at: ${address}`);

    return liquidator as ethers.Contract;
}

async function runE2E() {
    console.log("==================================================");
    console.log("🚀 STARTING E2E DRY RUN (ANVIL EXECUTION) 🚀");
    console.log("==================================================\n");

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    // 1. Deploy Smart Contract
    const liquidator = await deployLiquidator(wallet);

    const feeder = new Feeder(RPC_URL);
    
    // Use the specific 5 users from our watchlist
    const targetUsers = [
        "0xdb57fdf5fd24a9d0e1ea94552eb2c7bdcb28fa27", // The WETH whale
        "0x486e49eeddf6432d3e10b15c25bb2bc8da5811c9", // A stable user
        "0xbc90243806b018e5e75930cfcccfb3230d6d226c"  // Another user
    ];

    const pool = new ethers.Contract(
        "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".toLowerCase(),
        ["function getReservesList() view returns (address[])"],
        provider
    );

    console.log("[1] Cold Start: Loading Global Reserves List...");
    const ASSETS: string[] = await pool.getReservesList();
    
    const blockTag = await provider.getBlockNumber();
    const block = await provider.getBlock(blockTag);
    const currentTimestamp = BigInt(block!.timestamp);
    console.log(`    -> Locked to Block: ${blockTag}`);
    
    console.log("[2] Cold Start: Fetching Reserve Data (Prices & Indices)...");
    const reservesConfig = new Map<string, ReserveDataView>();
    for (const asset of ASSETS) {
        const rd = await feeder.fetchReserveData(asset, blockTag);
        reservesConfig.set(asset, rd);
    }
    
    console.log("[3] Cold Start: Loading Target Watchlist Positions...");
    const userPositions: UserPositionView[] = [];
    for (const user of targetUsers) {
        userPositions.push(await feeder.fetchUserPosition(user, ASSETS, blockTag));
    }

    const router = new ExecutionRouter(RPC_URL);

    console.log("\n🚨🚨🚨 CHAINLINK ORACLE EVENT DETECTED 🚨🚨🚨");
    console.log("WETH Price drops by 40%!\n");

    // CRASH THE PRICE IN MEMORY AND ON-CHAIN
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();
    let crashedPrice = 0n;
    for (const [asset, config] of reservesConfig.entries()) {
        if (asset.toLowerCase() === WETH) {
            crashedPrice = (config.priceInBaseCurrency * 60n) / 100n;
            config.priceInBaseCurrency = crashedPrice;
        }
    }

    console.log("\n[4] Hacking WETH Aggregator on Anvil via anvil_setCode...");
    const AAVE_WETH_SOURCE = "0x5424384B256154046E9667dDFaaa5e550145215e";
    
    // Dynamically write and compile a Mock contract that returns exactly our crashedPrice
    const mockContractCode = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract DynamicMock {
    function latestAnswer() external pure returns (uint256) {
        return ${crashedPrice};
    }
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(uint256(${crashedPrice})), 0, 0, 1);
    }
    function getAssetPrice(address) external pure returns (uint256) {
        return ${crashedPrice};
    }
    function decimals() external pure returns (uint8) {
        return 8;
    }
}`;
    const fs = require('fs');
    const { execSync } = require('child_process');
    fs.writeFileSync("./src/DynamicMock.sol", mockContractCode);
    console.log("   -> Compiling DynamicMock...");
    execSync("forge build", { cwd: "." });
    const mockOracleArtifactPath = "./out/DynamicMock.sol/DynamicMock.json";
    const mockOracleArtifact = JSON.parse(fs.readFileSync(mockOracleArtifactPath, "utf8"));
    
    await provider.send("anvil_setCode", [AAVE_WETH_SOURCE, mockOracleArtifact.deployedBytecode.object]);
    console.log(`   -> WETH Source (${AAVE_WETH_SOURCE}) Replaced with DynamicMock returning ${crashedPrice}!`);

    // SWEEP & ROUTE
    for (const pos of userPositions) {
        const data = calculateUserAccountData(pos, reservesConfig, currentTimestamp);
        if (data.healthFactor < 1000000000000000000n) { // < 1.0
            console.log(`User ${pos.user}: HF = ${(Number(data.healthFactor) / 1e18).toFixed(4)}`);
            console.log(`  -> 🔪 LIQUIDATION TRIGGERED! HF < 1.0`);
            
            const opportunities = calculateOptimalLiquidation(data, reservesConfig);
            if (opportunities.length > 0) {
                const best = opportunities[0];
                console.log(`\n  -> 🚀 Calling Quoter & Modeling MEV...`);
                
                // Intentionally run a deliberate failure first, then a success? 
                // We'll just run the real one directly for this script.
                const ticket = await router.verifyAndRoute(best, reservesConfig);
                
                if (ticket.isProfitable) {
                    console.log(`     ✅ EXECUTION APPROVED!`);
                    console.log(`     - Real Swap Output: ${ticket.quoterAmountOutToken}`);
                    console.log(`     - Minimum Output Req: ${ticket.amountOutMinimumToken}`);
                    console.log(`     - Required Repayment: ${ticket.amountToRepayToken}`);
                    console.log(`     - Estimated Profit: ${ticket.netProfitToken}`);
                    
                    console.log(`\n  -> 💥 FIRING TRANSACTION TO ANVIL...`);
                    
                    try {
                        const debtToCover = ticket.useMaxCloseFactor 
                            ? (best.debtToCoverToken * 101n) / 100n 
                            : best.debtToCoverToken;

                        const tx = await (liquidator as any).executeLiquidation(
                            pos.user,
                            best.debtAsset,
                            best.collateralAsset,
                            debtToCover,
                            ticket.useMaxCloseFactor,
                            ticket.poolFee,
                            ticket.amountOutMinimumToken, 
                            { gasLimit: 3000000 }
                        );
                        
                        console.log(`     [Tx Sent] Hash: ${tx.hash}`);
                        const receipt = await tx.wait();
                        
                        console.log(`     [Tx Confirmed] Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed}`);
                        
                        // Parse LiquidationExecuted Event
                        // event LiquidationExecuted(address indexed user, address debtAsset, address collateralAsset, uint256 debtCovered, uint256 collateralReceived, uint256 amountOut, uint256 profit);
                        
                        // Since we just want the profit, let's filter logs by the contract address
                        for (const log of receipt.logs) {
                            if (log.address.toLowerCase() === (await liquidator.getAddress()).toLowerCase()) {
                                try {
                                    // Interface setup to parse the event
                                    const iface = new ethers.Interface([
                                        "event LiquidationExecuted(address indexed user, address debtAsset, address collateralAsset, uint256 debtCovered, uint256 collateralReceived, uint256 amountOut, uint256 profit)"
                                    ]);
                                    const parsedLog = iface.parseLog(log);
                                    if (parsedLog && parsedLog.name === "LiquidationExecuted") {
                                        console.log("\n==================================================");
                                        console.log("💰💰💰 TRUE ON-CHAIN RECONCILIATION 💰💰💰");
                                        console.log(`- Liquidated User: ${parsedLog.args.user}`);
                                        console.log(`- Debt Covered: ${parsedLog.args.debtCovered}`);
                                        console.log(`- Collateral Seized: ${parsedLog.args.collateralReceived}`);
                                        console.log(`- Uniswap AmountOut: ${parsedLog.args.amountOut}`);
                                        console.log(`- Final True Profit: ${parsedLog.args.profit}`);
                                        console.log(`\n- Off-Chain Quoter vs True AmountOut Delta: ${ticket.quoterAmountOutToken - parsedLog.args.amountOut}`);
                                        console.log("==================================================\n");
                                    }
                                } catch (e) {
                                    // ignore non-matching logs
                                }
                            }
                        }

                    } catch (err: any) {
                        console.log(`     ❌ TRANSACTION REVERTED: ${err.message.split("\\n")[0]}`);
                    }

                } else {
                    console.log(`     ❌ EXECUTION REJECTED: ${ticket.failReason}`);
                }
            } else {
                console.log(`  -> ❌ No profitable liquidation pairs found.`);
            }
        }
    }
}

runE2E().catch(console.error);
