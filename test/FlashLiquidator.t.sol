// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {FlashLiquidator} from "../src/FlashLiquidator.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

contract FlashLiquidatorTest is Test {
    FlashLiquidator public liquidator;

    // Addresses loaded in setUp from env (with mainnet defaults).
    // This allows the same test file to work on different forks.
    address POOL_ADDRESSES_PROVIDER;
    address POOL;
    address SWAP_ROUTER;
    address USDT;
    address WETH;

    address victim = address(0x1337);

    bool isForkTest;

    function setUp() public {
        // Multi-chain fork support (Task 1.4)
        // Run with:
        //   forge test --fork-url $MAINNET_RPC_URL
        //   forge test --fork-url $ARBITRUM_RPC_URL
        //   forge test --fork-url $BASE_RPC_URL
        //
        // Inside the test you can also do dynamic forking with vm.createSelectFork

        // Load addresses from env with safe defaults (mainnet)
        POOL_ADDRESSES_PROVIDER = _envOrAddress("AAVE_POOL_ADDRESSES_PROVIDER", "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e");
        POOL = _envOrAddress("AAVE_POOL", "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
        SWAP_ROUTER = _envOrAddress("UNISWAP_SWAP_ROUTER", "0xE592427A0AEce92De3Edee1F18E0157C05861564");
        USDT = _envOrAddress("USDT_ADDRESS", "0xdAC17F958D2ee523a2206206994597C13D831ec7");
        WETH = _envOrAddress("WETH_ADDRESS", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");

        // Fork selection (if FORK_URL provided)
        string memory forkUrl = vm.envOr("FORK_URL", string(""));
        if (bytes(forkUrl).length > 0) {
            vm.createSelectFork(forkUrl);
        }

        isForkTest = block.chainid != 31337;  // plain `forge test` is usually Anvil (31337)

        // Deploy inside try so local non-fork runs don't hard-fail the suite
        try this.deployLiquidator() returns (FlashLiquidator l) {
            liquidator = l;
        } catch {
            // test functions below will skip
        }
    }

    function deployLiquidator() external returns (FlashLiquidator) {
        return new FlashLiquidator(POOL_ADDRESSES_PROVIDER, SWAP_ROUTER);
    }

    function _envOrAddress(string memory key, string memory defaultValue) internal view returns (address) {
        string memory val = vm.envOr(key, defaultValue);
        return vm.parseAddress(val);
    }

    function _setupVictimAndCrash() internal {
        // Give victim WETH
        deal(WETH, victim, 10 ether);
        
        // Victim supplies WETH and borrows USDT (USDT has no return on approve)
        vm.startPrank(victim);
        IERC20(WETH).approve(POOL, type(uint256).max);
        IPool(POOL).supply(WETH, 10 ether, victim, 0);
        IPool(POOL).borrow(USDT, 5000 * 1e6, 2, 0, victim);
        vm.stopPrank();

        (,,,,, uint256 healthFactorBefore) = IPool(POOL).getUserAccountData(victim);
        require(healthFactorBefore > 1e18, "Should be healthy initially");

        // Crash Oracle
        address currentOracle = IPoolAddressesProvider(POOL_ADDRESSES_PROVIDER).getPriceOracle();
        uint256 crashedPrice = 400 * 1e8; 
        vm.mockCall(
            currentOracle,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH),
            abi.encode(crashedPrice)
        );

        (,,,,, uint256 healthFactorAfter) = IPool(POOL).getUserAccountData(victim);
        require(healthFactorAfter < 1e18, "Should be liquidatable now!");
    }

    // 1. Test SafeERC20 compatibility with USDT
    function test_usdtSafeERC20() public {
        if (!isForkTest) vm.skip(true, "Requires a fork. Use --fork-url or FORK_URL env");
        _setupVictimAndCrash();

        uint256 debtToCover = 2500 * 1e6;
        uint256 botBalanceBefore = IERC20(USDT).balanceOf(address(this));
        
        // Liquidate
        liquidator.executeLiquidation(
            victim,
            USDT,
            WETH,
            debtToCover,
            false, // useMaxCloseFactor = false
            3000,
            0 // amountOutMinimum = 0
        );

        uint256 botBalanceAfter = IERC20(USDT).balanceOf(address(this));
        uint256 profit = botBalanceAfter - botBalanceBefore;
        
        require(profit > 0, "Failed to make profit!");
    }

    // 2. Test slippage protection reverts when MEV sandwiched
    function test_amountOutMinimum_revert() public {
        if (!isForkTest) vm.skip(true, "Requires a fork. Use --fork-url or FORK_URL env");
        _setupVictimAndCrash();

        uint256 debtToCover = 2500 * 1e6;
        
        // Expect revert due to impossible amountOutMinimum (TooLittleReceived from Uniswap)
        vm.expectRevert();
        liquidator.executeLiquidation(
            victim,
            USDT,
            WETH,
            debtToCover,
            false,
            3000,
            type(uint256).max // Impossible minimum required output
        );
    }

    // 3. Test dust clearing via type(uint256).max
    function test_useMaxCloseFactor() public {
        if (!isForkTest) vm.skip(true, "Requires a fork. Use --fork-url or FORK_URL env");
        _setupVictimAndCrash();

        // 100% liquidation via MaxCloseFactor
        uint256 debtToCover = 5000 * 1e6; // Requesting exactly 5000

        // Because Aave interest accrued since the borrow, the true debt is > 5000
        // We simulate a 1% buffer borrowed from Flashloan to cover interest
        uint256 bufferedFlashloan = (debtToCover * 101) / 100;
        
        uint256 botBalanceBefore = IERC20(USDT).balanceOf(address(this));

        // When useMaxCloseFactor = true, it clears the exact actual debt, keeping the remainder of the buffer
        liquidator.executeLiquidation(
            victim,
            USDT,
            WETH,
            bufferedFlashloan,
            true, // useMaxCloseFactor = true
            3000,
            0
        );

        uint256 botBalanceAfter = IERC20(USDT).balanceOf(address(this));
        uint256 profit = botBalanceAfter - botBalanceBefore;
        
        require(profit > 0, "Failed to make profit with MaxCloseFactor");
    }
}
