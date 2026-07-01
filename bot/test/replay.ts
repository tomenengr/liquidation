import { rayMul } from '../src/math/WadRayMath';

// Asset: 0xcbB7...
const scaledAToken = 49939941n;
const liquidityIndex = 1000200808340778778949306854n;
const price = 5911011159000n;
const unit = 100000000n;

const actual = rayMul(scaledAToken, liquidityIndex);
const colBase = (actual * price) / unit;

console.log("actual:", actual);
console.log("colBase:", colBase);

// Let's also do WETH
const wethScaled = 75414095409479582483n;
const wethLiq = 1067490733597061204729721117n;
const wethPrice = 158189460528n;
const wethUnit = 10n ** 18n;
const wethActual = rayMul(wethScaled, wethLiq);
const wethBase = (wethActual * wethPrice) / wethUnit;
console.log("wethActual:", wethActual);
console.log("wethBase:", wethBase);

// Sum
const totalCol = colBase + wethBase;
console.log("totalCol:", totalCol);
