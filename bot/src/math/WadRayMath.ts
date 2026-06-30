import { WAD, HALF_WAD, RAY, HALF_RAY, WAD_RAY_RATIO, MAX_UINT256 } from './constants';

export function wadMul(a: bigint, b: bigint): bigint {
    if (a === 0n || b === 0n) return 0n;
    if (a > (MAX_UINT256 - HALF_WAD) / b) throw new Error("MATH_MULTIPLICATION_OVERFLOW");
    return (a * b + HALF_WAD) / WAD;
}

export function wadDiv(a: bigint, b: bigint): bigint {
    if (b === 0n) throw new Error("MATH_DIVISION_BY_ZERO");
    const halfB = b / 2n;
    if (a > (MAX_UINT256 - halfB) / WAD) throw new Error("MATH_MULTIPLICATION_OVERFLOW");
    return (a * WAD + halfB) / b;
}

export function rayMul(a: bigint, b: bigint): bigint {
    if (a === 0n || b === 0n) return 0n;
    if (a > (MAX_UINT256 - HALF_RAY) / b) throw new Error("MATH_MULTIPLICATION_OVERFLOW");
    return (a * b + HALF_RAY) / RAY;
}

export function rayDiv(a: bigint, b: bigint): bigint {
    if (b === 0n) throw new Error("MATH_DIVISION_BY_ZERO");
    const halfB = b / 2n;
    if (a > (MAX_UINT256 - halfB) / RAY) throw new Error("MATH_MULTIPLICATION_OVERFLOW");
    return (a * RAY + halfB) / b;
}

export function rayToWad(a: bigint): bigint {
    const b = a / WAD_RAY_RATIO;
    const remainder = a % WAD_RAY_RATIO;
    if (remainder >= WAD_RAY_RATIO / 2n) {
        return b + 1n;
    }
    return b;
}

export function wadToRay(a: bigint): bigint {
    return a * WAD_RAY_RATIO;
}
