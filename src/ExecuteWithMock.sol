// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FlashLiquidator} from "./FlashLiquidator.sol";

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IVm {
    function mockCall(address where, bytes calldata data, bytes calldata returnData) external;
}

contract ExecuteWithMock {
    FlashLiquidator public liquidator;
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant AAVE_ORACLE = 0x54586bE62E3c3580375aE3723C145253060Ca0C2;

    constructor(address _liquidator) {
        liquidator = FlashLiquidator(_liquidator);
    }

    function executeWithPriceCrash(
        address weth,
        uint256 crashedPrice,
        address user,
        address debtAsset,
        address collateralAsset,
        uint256 debtToCover,
        uint24 poolFee,
        uint256 amountOutMinimum
    ) external {
        // 1. Mock the Oracle for the duration of this transaction
        vm.mockCall(
            AAVE_ORACLE,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, weth),
            abi.encode(crashedPrice)
        );

        // 2. Fire the liquidation
        liquidator.executeLiquidation(
            user,
            debtAsset,
            collateralAsset,
            debtToCover,
            false,
            poolFee,
            amountOutMinimum
        );
    }
}
