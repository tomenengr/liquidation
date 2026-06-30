import { ethers } from "ethers";
import { LiquidationOpportunity } from "./profitCalculator";
import { ReserveDataView } from "./engine/views";

export interface ExecutionTicket {
    opportunity: LiquidationOpportunity;
    quoterAmountOutToken: bigint;
    amountToRepayToken: bigint;
    useMaxCloseFactor: boolean;
    amountOutMinimumToken: bigint; // For actual DEX swap
    poolFee: number;               // Uniswap fee tier
    gasCostToken: bigint;
    bribeToken: bigint;
    netProfitToken: bigint;
    netProfitBase: bigint;
    isProfitable: boolean;
    failReason?: string;
}

const QUOTER_V2_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const QUOTER_V2_ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const FLASHLOAN_FEE_BPS = 5n; // 0.05%
const BPS_DENOMINATOR = 10000n;

export class ExecutionRouter {
    provider: ethers.JsonRpcProvider;
    quoter: ethers.Contract;

    constructor(rpcUrl: string) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.quoter = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_V2_ABI, this.provider);
    }

    async verifyAndRoute(
        opp: LiquidationOpportunity,
        reservesConfig: Map<string, ReserveDataView>
    ): Promise<ExecutionTicket> {
        
        // 1. Calculate required repayment amount (Debt + Flashloan Fee)
        const amountToRepayToken = opp.debtToCoverToken + (opp.debtToCoverToken * FLASHLOAN_FEE_BPS) / BPS_DENOMINATOR;

        // 2. Call Uniswap V3 Quoter to get actual tokens back for the seized collateral
        let quoterAmountOutToken = 0n;
        let swapGasEstimate = 150000n; // Default swap gas
        
        try {
            // We assume a 0.3% fee tier (3000) for this MVP. Production router would check 500, 3000, 10000 tiers.
            const params = {
                tokenIn: opp.collateralAsset,
                tokenOut: opp.debtAsset,
                amountIn: opp.expectedCollateralToken,
                fee: 3000n,
                sqrtPriceLimitX96: 0n
            };
            
            // Note: Since QuoterV2 quoteExactInputSingle modifies state (simulated), it's called statically using callStatic via standard method on v6
            const result = await this.quoter.quoteExactInputSingle.staticCall(params);
            quoterAmountOutToken = BigInt(result[0]);
            swapGasEstimate = BigInt(result[3]);
        } catch (e: any) {
            return this._fail(opp, `Quoter Reverted: ${e.message.split("\\n")[0]}`);
        }

        // 3. Gross Profit Validation
        if (quoterAmountOutToken <= amountToRepayToken) {
            return this._fail(opp, `Slippage Too High. Seized: ${opp.expectedCollateralToken}, SwapOut: ${quoterAmountOutToken}, Needed: ${amountToRepayToken}`);
        }

        const grossProfitToken = quoterAmountOutToken - amountToRepayToken;

        // 4. Gas & Bribe Modeling
        // Assume overall liquidation takes ~400k gas (Flashloan 250k + Swap 150k)
        const totalGasLimit = 250000n + swapGasEstimate;
        const feeData = await this.provider.getFeeData();
        const gasPriceWei = feeData.gasPrice || 20000000000n; // fallback 20 gwei
        const gasCostWei = totalGasLimit * gasPriceWei;

        // Convert Gas Cost (Wei) -> Base Currency -> Debt Token
        const wethKey = Array.from(reservesConfig.keys()).find(k => k.toLowerCase() === WETH_ADDRESS);
        const debtKey = Array.from(reservesConfig.keys()).find(k => k.toLowerCase() === opp.debtAsset.toLowerCase());
        
        const wethConfig = wethKey ? reservesConfig.get(wethKey) : undefined;
        const debtConfig = debtKey ? reservesConfig.get(debtKey) : undefined;
        
        if (!wethConfig || !debtConfig) {
            return this._fail(opp, "Missing WETH or Debt asset config for Gas Conversion");
        }

        const gasCostBase = (gasCostWei * wethConfig.priceInBaseCurrency) / (10n ** 18n);
        const gasCostToken = (gasCostBase * (10n ** debtConfig.decimals)) / debtConfig.priceInBaseCurrency;

        if (grossProfitToken <= gasCostToken) {
            return this._fail(opp, `Unprofitable after Gas. GrossProfit: ${grossProfitToken}, GasCost: ${gasCostToken}`);
        }

        // Bribe Model: Give 50% of the remaining profit to the Builder
        const remainingProfit = grossProfitToken - gasCostToken;
        const bribeToken = remainingProfit / 2n;
        const netProfitToken = remainingProfit - bribeToken;

        const netProfitBase = (netProfitToken * debtConfig.priceInBaseCurrency) / (10n ** debtConfig.decimals);

        // Allow 0.5% dynamic slippage buffer below the quoter's exact quote
        const amountOutMinimumToken = (quoterAmountOutToken * 995n) / 1000n;

        const useMaxCloseFactor = opp.closeFactorBps === 10000n;

        return {
            opportunity: opp,
            quoterAmountOutToken,
            amountToRepayToken,
            useMaxCloseFactor,
            amountOutMinimumToken,
            poolFee: 3000,
            gasCostToken,
            bribeToken,
            netProfitToken,
            netProfitBase,
            isProfitable: true
        };
    }

    private _fail(opp: LiquidationOpportunity, reason: string): ExecutionTicket {
        return {
            opportunity: opp,
            quoterAmountOutToken: 0n,
            amountToRepayToken: 0n,
            useMaxCloseFactor: false,
            amountOutMinimumToken: 0n,
            poolFee: 3000,
            gasCostToken: 0n,
            bribeToken: 0n,
            netProfitToken: 0n,
            netProfitBase: 0n,
            isProfitable: false,
            failReason: reason
        };
    }
}
