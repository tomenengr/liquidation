import { PERCENTAGE_FACTOR, HALF_PERCENTAGE_FACTOR, MAX_UINT256 } from './constants';

export function percentMul(value: bigint, percentage: bigint): bigint {
    if (value === 0n || percentage === 0n) return 0n;
    if (value > (MAX_UINT256 - HALF_PERCENTAGE_FACTOR) / percentage) throw new Error("MATH_MULTIPLICATION_OVERFLOW");
    return (value * percentage + HALF_PERCENTAGE_FACTOR) / PERCENTAGE_FACTOR;
}

export function percentDiv(value: bigint, percentage: bigint): bigint {
    if (percentage === 0n) throw new Error("MATH_DIVISION_BY_ZERO");
    const halfPercentage = percentage / 2n;
    if (value > (MAX_UINT256 - halfPercentage) / PERCENTAGE_FACTOR) throw new Error("MATH_MULTIPLICATION_OVERFLOW");
    return (value * PERCENTAGE_FACTOR + halfPercentage) / percentage;
}
