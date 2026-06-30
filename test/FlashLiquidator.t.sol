// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {FlashLiquidator} from "../src/FlashLiquidator.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// 定义 Aave 预言机接口，用于我们稍后的“劫持”
interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

contract FlashLiquidatorTest is Test {
    FlashLiquidator public liquidator;

    // --- Aave V3 主网核心合约地址 ---
    address constant POOL_ADDRESSES_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    // AAVE_ORACLE is fetched dynamically
    address constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564; // Uniswap V3
    
    // --- 代币地址 ---
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // 假设一个倒霉的测试用户
    address victim = address(0x1337);

    function setUp() public {
        liquidator = new FlashLiquidator(POOL_ADDRESSES_PROVIDER, SWAP_ROUTER);
    }

    function test_simulatedLiquidation() public {
        // 如果没有输入 fork-url，跳过测试 (我们需要主网的环境)
        if (block.chainid != 1) {
            console.log("Please run with --fork-url <MAINNET_RPC>");
            return;
        }

        console.log("\n[1] Setting up the Victim...");
        
        // 凭空给受害者 10 个 WETH (作弊码)
        deal(WETH, victim, 10 ether);
        
        // 受害者去 Aave 抵押 10 WETH，并借出 15000 USDC
        vm.startPrank(victim);
        IERC20(WETH).approve(POOL, type(uint256).max);
        IPool(POOL).supply(WETH, 10 ether, victim, 0);
        IPool(POOL).borrow(USDC, 5000 * 1e6, 2, 0, victim);
        vm.stopPrank();

        // 检查受害者当前的健康因子 (此时一定是健康的，HF > 1)
        (,,,,, uint256 healthFactorBefore) = IPool(POOL).getUserAccountData(victim);
        console.log("Victim Health Factor (Healthy):", healthFactorBefore);
        require(healthFactorBefore > 1e18, "Should be healthy initially");


        console.log("\n[2] Crashing the Market (Oracle Manipulation)...");
        
        // 动态获取当前的预言机地址
        address currentOracle = IPoolAddressesProvider(POOL_ADDRESSES_PROVIDER).getPriceOracle();

        // 这里是精髓！我们使用 vm.mockCall 强行劫持 Aave 预言机
        // 告诉 Aave：WETH 的价格现在跌到了 $400 块钱！（8位精度）
        uint256 crashedPrice = 400 * 1e8; 
        vm.mockCall(
            currentOracle,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH),
            abi.encode(crashedPrice)
        );

        // 再次检查健康因子，因为抵押品"暴跌"，HF 瞬间跌破 1.0！
        (,,,,, uint256 healthFactorAfter) = IPool(POOL).getUserAccountData(victim);
        console.log("Victim Health Factor (Crashing):", healthFactorAfter);
        require(healthFactorAfter < 1e18, "Should be liquidatable now!");


        console.log("\n[3] Executing Flashloan Liquidation...");
        
        // 打算替他还 2500 USDC 
        // (Aave 规定一次最多清算 50% 债务)
        uint256 debtToCover = 2500 * 1e6;

        // 记录清算前我们手里的 USDC 余额 (应该是 0)
        uint256 botBalanceBefore = IERC20(USDC).balanceOf(address(this));
        
        // 🚀 机器人出动：借闪电贷 -> 清算拿 WETH -> Uniswap 卖出换 USDC -> 还贷
        liquidator.executeLiquidation(
            victim,
            USDC,
            WETH,
            debtToCover,
            false,
            3000,
            0
        );

        uint256 botBalanceAfter = IERC20(USDC).balanceOf(address(this));
        uint256 profit = botBalanceAfter - botBalanceBefore;

        console.log(unicode"\n[4] Liquidation Successful! 🤑");
        console.log("Pure Profit (USDC):", profit / 1e6);
        
        require(profit > 0, "Failed to make profit!");
    }
}
