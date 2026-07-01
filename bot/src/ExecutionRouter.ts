import { createProviderPool } from "./providerPool";
import { ethers } from "ethers";
import { LiquidationOpportunity, filterOpportunities } from "./profitCalculator";
import { ReserveDataView } from "./engine/views";
import { config } from "./config";
import { getRecentPrices } from "./db";

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

const QUOTER_V2_ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

const BPS_DENOMINATOR = 10000n;

/**
 * ExecutionRouter: Stage 2 verification (after 0-RPC opp discovery).
 * - Calls real UniswapV3 QuoterV2 (multi fee tier) using provided RPC (live or fork) + gas + bribe.
 * - Returns ExecutionTicket for decision (profitable or failReason).
 * - Use real when RPC provided and NOT explicitly MOCK_QUOTER=true (see config).
 * - MOCK only for tests without RPC/fork; real Quoter works on Anvil --fork-url (Quoter contract present in fork state).
 * - Chain specific via centralized config.getChainConfig + addresses.ts (no hardcodes).
 * - Multi-chain: ETH(1), ARB(42161), BASE(8453). L2 uses lower mins, different Quoter addr.
 * - Preserves 0-RPC advantage: Quoter only for final ticket verification, not discovery.
 * - Integrated with subgraph data via loadEngineViewsFromSubgraph in callers/tests.
 */
export class ExecutionRouter {
    provider: ethers.Provider;
    quoter: ethers.Contract;
    wethAddress: string;
    flashloanFeeBps: bigint;
    chainId: number;

    constructor(rpcUrl: string, chainId?: number) {
        const id = chainId ?? config.CHAIN_ID;
        const chainCfg = config.getChainConfig(id);
        const addrs = chainCfg.ADDRESSES || config.getAddresses(id);

        this.chainId = id;
        // Use provided rpcUrl (allows caller to pass anvil fork or live), fallback to chainCfg (which does key pattern derive)
        const effectiveRpc = rpcUrl || chainCfg.RPC_URL || config.RPC_URL;
        this.provider = createProviderPool(effectiveRpc, chainCfg.RPC_FALLBACKS);
        this.quoter = new ethers.Contract(addrs.UNISWAP_QUOTER_V2, QUOTER_V2_ABI, this.provider);
        this.wethAddress = addrs.WETH.toLowerCase();
        this.flashloanFeeBps = chainCfg.FLASHLOAN_FEE_BPS || config.FLASHLOAN_FEE_BPS;
    }

    async verifyAndRoute(
        opp: LiquidationOpportunity,
        reservesConfig: Map<string, ReserveDataView>
    ): Promise<ExecutionTicket> {
        
        const chainCfg = config.getChainConfig(this.chainId);
        const feeTiers = chainCfg.UNISWAP_FEE_TIERS || config.UNISWAP_FEE_TIERS;

        // 3.10: compute simple recent volatility from price_history DB (subgraph/oracle)
        let volPercent = 0;
        try {
          const h1 = getRecentPrices(this.chainId, opp.collateralAsset.toLowerCase(), 6);
          const vals = h1.length > 0 ? h1.map((h: any) => Number(h.price) / 1e18) : [];
          if (vals.length >= 2) {
            const mx = Math.max(...vals); const mn = Math.min(...vals);
            const av = (mx + mn) / 2;
            volPercent = av > 0 ? Math.abs(mx - mn) / av * 100 : 0;
          }
        } catch {}

        // 1. Calculate required repayment amount (Debt + Flashloan Fee)
        const amountToRepayToken = opp.debtToCoverToken + (opp.debtToCoverToken * this.flashloanFeeBps) / BPS_DENOMINATOR;

        // 2. Call Uniswap V3 QuoterV2 (or mock for testing without RPC)
        // Decision: real when RPC provided and NOT explicitly mocked. Improves on always-fallback.
        // Updated error handling + logging. Use MOCK_QUOTER=true only to bypass (no live/fork RPC needed then).
        let quoterAmountOutToken = 0n;
        let swapGasEstimate = 150000n;
        let bestFee = 3000n;

        const explicitMock = (chainCfg.MOCK_QUOTER === true) || (process.env.MOCK_QUOTER === 'true');
        const useMock = explicitMock;
        if (useMock) {
            // Mock: estimate using prices (assume 1:1 for simplicity + slippage buffer)
            const collateralPrice = reservesConfig.get(opp.collateralAsset.toLowerCase())?.priceInBaseCurrency || 100000000n;
            const debtPrice = reservesConfig.get(opp.debtAsset.toLowerCase())?.priceInBaseCurrency || 100000000n;
            quoterAmountOutToken = (opp.expectedCollateralToken * collateralPrice) / debtPrice;
            quoterAmountOutToken = (quoterAmountOutToken * 98n) / 100n; // conservative 2% buffer
            console.log(`[ExecutionRouter] [MOCK QUOTER] chain=${this.chainId} (explicit MOCK=true). For real Quoter set MOCK_QUOTER=false and use live RPC or anvil --fork-url.`);
        } else {
            console.log(`[ExecutionRouter] Using REAL QuoterV2 (chain=${this.chainId}, feeTiers=${feeTiers.join(',')}) on RPC provided (not explicitly mocked).`);
            try {
                for (const fee of feeTiers) {
                    const params = {
                        tokenIn: opp.collateralAsset,
                        tokenOut: opp.debtAsset,
                        amountIn: opp.expectedCollateralToken,
                        fee,
                        sqrtPriceLimitX96: 0n
                    };
                    const result = await this.quoter.quoteExactInputSingle.staticCall(params);
                    const out = BigInt(result[0]);
                    if (out > quoterAmountOutToken) {
                        quoterAmountOutToken = out;
                        swapGasEstimate = BigInt(result[3]);
                        bestFee = fee;
                    }
                }
                if (quoterAmountOutToken === 0n) {
                    return this._fail(opp, "Quoter returned zero output across all fee tiers");
                }
            } catch (e: any) {
                const shortMsg = (e && e.message) ? e.message.split('\n')[0] : String(e);
                console.warn(`[ExecutionRouter] REAL Quoter call failed on chain ${this.chainId}: ${shortMsg} (returning non-profitable ticket; use MOCK only if intended)`);
                return this._fail(opp, `Quoter Reverted: ${shortMsg}`);
            }
        }

        // 3. Gross Profit Validation
        if (quoterAmountOutToken <= amountToRepayToken) {
            return this._fail(opp, `Slippage Too High. Seized: ${opp.expectedCollateralToken}, SwapOut: ${quoterAmountOutToken}, Needed: ${amountToRepayToken}`);
        }

        const grossProfitToken = quoterAmountOutToken - amountToRepayToken;

        // 4. Gas & Bribe Modeling (per-chain, enhanced with live data for Task 1.12)
        let totalGasLimit = (chainCfg.BASE_GAS_LIMIT || config.BASE_GAS_LIMIT) + swapGasEstimate;
        const feeData = await this.provider.getFeeData();
        let gasPriceWei = feeData.gasPrice || 20000000000n;

        // Enhance: fetch recent blocks for better gas estimate (live on-chain data)
        try {
            const latestBlock = await this.provider.getBlock('latest');
            if (latestBlock && latestBlock.baseFeePerGas) {
                gasPriceWei = latestBlock.baseFeePerGas * 12n / 10n; // 1.2x base for priority
            }
            // Sample recent blocks for avg gas used if available (light sim)
            const recent = await this.provider.getBlockNumber();
            // For simplicity, use current + buffer
        } catch (e) {
            // fallback to feeData
        }

        const gasCostWei = totalGasLimit * gasPriceWei;

        // Convert Gas Cost (Wei) -> Base Currency -> Debt Token
        const wethKey = Array.from(reservesConfig.keys()).find(k => k.toLowerCase() === this.wethAddress);
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

        // Secondary defense: re-apply min profit filter using the shared helper
        const dummyOpps = [{
            ...opp,
            estimatedNetProfitBase: (grossProfitToken - gasCostToken) * debtConfig.priceInBaseCurrency / (10n ** debtConfig.decimals)
        } as any];
        const chainMins = config.getChainConfig(this.chainId);
        if (filterOpportunities(dummyOpps).length === 0 || (chainMins.MIN_NET_PROFIT_BASE && dummyOpps[0].estimatedNetProfitBase < chainMins.MIN_NET_PROFIT_BASE)) {
            return this._fail(opp, `Below minimum net profit threshold after Quoter + Gas`);
        }

        // Bribe Model: Give BRIBE_PERCENT of the remaining profit to the Builder (off-chain)
        const remainingProfit = grossProfitToken - gasCostToken;
        const bribePercent = BigInt(chainCfg.BRIBE_PERCENT || config.BRIBE_PERCENT);
        const bribeToken = (remainingProfit * bribePercent) / 100n;
        const netProfitToken = remainingProfit - bribeToken;

        const netProfitBase = (netProfitToken * debtConfig.priceInBaseCurrency) / (10n ** debtConfig.decimals);

        // 3.10: Dynamic slippage using volatility from price history (higher vol = wider)
        const baseSlip = Number(chainCfg.SLIPPAGE_BPS || 50);
        const volFactor = Number(chainCfg.VOLATILITY_SLIP_ADJ_FACTOR || 4);
        const volAdj = Math.min(Math.floor(volPercent * volFactor), 150); // e.g. 3% vol adds ~12bps
        const effectiveSlipBps = BigInt(baseSlip + volAdj);
        const slippageBps = effectiveSlipBps;
        const amountOutMinimumToken = (quoterAmountOutToken * (10000n - slippageBps)) / 10000n;

        const useMaxCloseFactor = opp.closeFactorBps === 10000n;

        return {
            opportunity: opp,
            quoterAmountOutToken,
            amountToRepayToken,
            useMaxCloseFactor,
            amountOutMinimumToken,
            poolFee: Number(bestFee),
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
