// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockAggregator {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, 400 * 1e8, block.timestamp, block.timestamp, 1);
    }

    function latestAnswer() external pure returns (int256) {
        return 400 * 1e8;
    }
    
    function decimals() external pure returns (uint8) {
        return 8;
    }
}
