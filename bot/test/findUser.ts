import { ethers } from 'ethers';

async function find() {
    console.log("Searching for a valid non-eMode user with active debt...");
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const pool = new ethers.Contract("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", [
        "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
        "function getUserEMode(address user) view returns (uint256)",
        "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
    ], provider);

    const latest = await provider.getBlockNumber();
    console.log(`Latest block: ${latest}. Querying last 50000 blocks...`);
    const events = await pool.queryFilter(pool.filters.Borrow(), latest - 50000, latest);
    
    console.log(`Found ${events.length} Borrow events. Filtering...`);
    
    for (const e of events) {
        // @ts-ignore
        const user = e.args[2]; // onBehalfOf
        const eMode = await pool.getUserEMode(user);
        if (eMode === 0n) {
            const data = await pool.getUserAccountData(user);
            if (data.totalDebtBase > 0n && data.totalCollateralBase > 0n) {
                console.log(`\n✅ FOUND VALID USER: ${user}`);
                console.log(`Collateral: ${data.totalCollateralBase}`);
                console.log(`Debt: ${data.totalDebtBase}`);
                console.log(`HF: ${data.healthFactor}`);
                return;
            }
        }
    }
    console.log("No valid user found in this block range.");
}

find().catch(console.error);
