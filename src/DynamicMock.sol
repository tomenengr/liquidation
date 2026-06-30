// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract DynamicMock {
    function latestAnswer() external pure returns (uint256) {
        return 149350707812;
    }
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(uint256(149350707812)), 0, 0, 1);
    }
    function getAssetPrice(address) external pure returns (uint256) {
        return 149350707812;
    }
    function decimals() external pure returns (uint8) {
        return 8;
    }
}