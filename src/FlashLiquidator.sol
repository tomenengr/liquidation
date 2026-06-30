// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

contract FlashLiquidator is IFlashLoanSimpleReceiver {
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;
    ISwapRouter public immutable SWAP_ROUTER;
    address public owner;

    event LiquidationExecuted(address indexed user, uint256 profit);

    constructor(
        address _addressProvider,
        address _swapRouter
    ) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    /**
     * @dev 触发清算流程
     * @param user 被清算用户的地址
     * @param debtAsset 用户借出的代币 (我们用闪电贷借的)
     * @param collateralAsset 用户的抵押品代币 (我们要拿到的)
     * @param debtToCover 替他还多少金额
     */
    function executeLiquidation(
        address user,
        address debtAsset,
        address collateralAsset,
        uint256 debtToCover
    ) external onlyOwner {
        // 传递给闪电贷回调函数的参数
        bytes memory params = abi.encode(user, collateralAsset);

        // 发起闪电贷
        POOL.flashLoanSimple(
            address(this), // 接收者
            debtAsset,     // 借什么
            debtToCover,   // 借多少
            params,        // 传给 executeOperation 的参数
            0              // referral code
        );
    }

    /**
     * @dev Aave 闪电贷的回调函数
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Caller must be pool");
        require(initiator == address(this), "Initiator must be this");

        // 1. 解析参数
        (address user, address collateralAsset) = abi.decode(params, (address, address));

        // 2. 授权 Aave 扣减我们将要用于清算的资金
        IERC20(asset).approve(address(POOL), amount);

        // 3. 执行清算 (替用户还清 debtAsset，拿走 collateralAsset)
        uint256 collateralBefore = IERC20(collateralAsset).balanceOf(address(this));
        
        POOL.liquidationCall(
            collateralAsset,
            asset,
            user,
            amount,
            false // receiveAToken = false (直接接收底层代币，不要 aToken)
        );

        uint256 collateralReceived = IERC20(collateralAsset).balanceOf(address(this)) - collateralBefore;
        require(collateralReceived > 0, "Liquidation failed or zero collateral");

        // 4. 将抵押品在 Uniswap 换回借出的资产
        // 授权 Uniswap 路由扣减我们的抵押品
        IERC20(collateralAsset).approve(address(SWAP_ROUTER), collateralReceived);

        // 这里为了简化演示，使用 ExactInputSingle
        // 实际生产中应动态计算或传入 fee tier 和 path
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: collateralAsset,
            tokenOut: asset,
            fee: 500, // 0.05% WETH/USDC pool has best liquidity
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: collateralReceived,
            amountOutMinimum: 0, // 在实际生产中必须通过链下计算并传入此值，防止三明治攻击！
            sqrtPriceLimitX96: 0
        });

        uint256 amountOut = SWAP_ROUTER.exactInputSingle(swapParams);

        // 5. 检查是否足以偿还闪电贷 (本金 + 0.05% 手续费)
        uint256 amountToRepay = amount + premium;
        require(
            IERC20(asset).balanceOf(address(this)) >= amountToRepay,
            "Not enough to repay flashloan" // 重点：如果不够还，整个交易回滚，不会损失本金
        );

        // 6. 授权 Aave 扣除欠款 (Aave 会在此函数执行完毕后自动从我们账户扣钱)
        IERC20(asset).approve(address(POOL), amountToRepay);

        // 7. 计算纯利润并转移
        uint256 profit = IERC20(asset).balanceOf(address(this)) - amountToRepay;
        if (profit > 0) {
            IERC20(asset).transfer(owner, profit);
            emit LiquidationExecuted(user, profit);
        }

        return true;
    }

    // 提供给机器人的紧急提取资金通道
    function withdrawToken(address token) external onlyOwner {
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }
}
