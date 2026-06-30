// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";

contract MathTest is Test {
    uint256 constant RAY = 1e27;
    uint256 constant HALF_RAY = 0.5e27;

    function rayMul(uint256 a, uint256 b) public pure returns (uint256) {
        return (a * b + HALF_RAY) / RAY;
    }

    function testMath() public {
        uint256 a = 59822137;
        uint256 b = 1000039347057290486489927543;
        uint256 c = rayMul(a, b);
        console.log("Result:", c);
    }
}
