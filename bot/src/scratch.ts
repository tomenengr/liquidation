import { ethers } from 'ethers';
import fs from 'fs';

async function run() {
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

    const AAVE_ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2";
    const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    
    const artifactPath = "../out/MockOracle.sol/MockAggregator.json";
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const mockBytecode = artifact.deployedBytecode.object;

    console.log("Replacing Oracle Bytecode...");
    await provider.send("anvil_setCode", [AAVE_ORACLE, mockBytecode]);
    console.log("Bytecode replaced!");

    const oracleInterface = new ethers.Interface(["function getAssetPrice(address asset) view returns (uint256)"]);
    const oracle = new ethers.Contract(AAVE_ORACLE, oracleInterface, provider);
    
    // Call our mock, which returns 400 * 1e8 = 40000000000 (We named it MockAggregator but we will call getAssetPrice on it)
    // Wait, MockAggregator has `latestRoundData`, not `getAssetPrice`.
    // We need a MockAaveOracle!
}

run().catch(console.error);
