import { WAD, RAY } from '../src/math/constants';
import { wadMul, wadDiv, rayMul, rayDiv, rayToWad, wadToRay } from '../src/math/WadRayMath';
import { percentMul, percentDiv } from '../src/math/PercentageMath';

function assertEqual(actual: bigint, expected: bigint, message: string) {
    if (actual !== expected) {
        throw new Error(`Assertion Failed: ${message}\nExpected: ${expected}\nActual:   ${actual}`);
    }
}

function runTests() {
    try {
        console.log("Running Math Library Tests...");

        // WadRayMath tests
        assertEqual(wadMul(WAD, WAD), WAD, "WAD * WAD should equal WAD");
        assertEqual(rayMul(RAY, RAY), RAY, "RAY * RAY should equal RAY");

        const halfWad = WAD / 2n;
        const quarterWad = WAD / 4n;
        assertEqual(wadMul(halfWad, halfWad), quarterWad, "0.5 WAD * 0.5 WAD should equal 0.25 WAD");

        assertEqual(wadDiv(WAD, WAD), WAD, "WAD / WAD should equal WAD");
        assertEqual(rayDiv(RAY, RAY), RAY, "RAY / RAY should equal RAY");

        // PercentageMath tests
        // 1000 * 50% = 500 (5000 bps)
        assertEqual(percentMul(1000n, 5000n), 500n, "1000 * 50% should equal 500");
        // 500 / 50% = 1000
        assertEqual(percentDiv(500n, 5000n), 1000n, "500 / 50% should equal 1000");

        console.log("✅ All basic Math tests passed successfully!");
    } catch (e) {
        console.error("❌ Test Failed:", e);
    }
}

runTests();
