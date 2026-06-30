// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MathTest {
    uint256 constant RAY = 1e27;
    uint256 constant HALF_RAY = 0.5e27;

    function rayMul(uint256 a, uint256 b) public pure returns (uint256) {
        return (a * b + HALF_RAY) / RAY;
    }
}
