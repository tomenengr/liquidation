import { RAY, SECONDS_PER_YEAR } from './constants';
import { rayMul } from './WadRayMath';

export function calculateCompoundedInterest(
    rate: bigint,
    lastUpdateTimestamp: bigint,
    currentTimestamp: bigint
): bigint {
    const exp = currentTimestamp - lastUpdateTimestamp;

    if (exp === 0n) {
        return RAY;
    }

    const expMinusOne = exp - 1n;
    const expMinusTwo = exp > 2n ? exp - 2n : 0n;

    const ratePerSecond = rate / SECONDS_PER_YEAR;

    const basePowerTwo = rayMul(ratePerSecond, ratePerSecond);
    const basePowerThree = rayMul(basePowerTwo, ratePerSecond);

    const secondTerm = (exp * expMinusOne * basePowerTwo) / 2n;
    const thirdTerm = (exp * expMinusOne * expMinusTwo * basePowerThree) / 6n;

    return RAY + (ratePerSecond * exp) + secondTerm + thirdTerm;
}
