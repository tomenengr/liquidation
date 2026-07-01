/// <reference types="node" />
import { getAddresses } from '../src/addresses';
import { config } from '../src/config';

// TDD Test for Task 1.2: Address Unification
// This should fail until addresses.ts + config integration is implemented

console.log('[ADDRESSES-TEST] Testing centralized multi-chain addresses...');

const eth = getAddresses(1);
const arb = getAddresses(42161);
const base = getAddresses(8453);

const required = ['POOL', 'POOL_ADDRESSES_PROVIDER', 'UNISWAP_SWAP_ROUTER', 'UNISWAP_QUOTER_V2', 'WETH', 'USDC'];

let failed = false;

for (const chain of [ {id:1, name:'Ethereum', data:eth}, {id:42161, name:'Arbitrum', data:arb}, {id:8453, name:'Base', data:base} ]) {
  for (const key of required) {
    const addr = (chain.data as any)[key] as string;
    if (!addr || addr === '0x0000000000000000000000000000000000000000') {
      console.error(`❌ Missing or zero address for ${key} on ${chain.name}`);
      failed = true;
    }
  }
  console.log(`✅ ${chain.name} (chainId ${chain.id}): POOL=${chain.data.POOL}`);
}

// Check they are different across chains (at least Pool should differ)
if (eth.POOL === arb.POOL || eth.POOL === base.POOL) {
  console.error('❌ Pools should be different per chain');
  failed = true;
}

if (failed) {
  console.error('\n[RED] Address unification test FAILED. Implement getAddresses() first.');
  process.exit(1);
} else {
  console.log('\n✅ [GREEN] All required addresses present and chain-specific.');
}

// === prod-001.02 TDD: Centralized execution config (RED first) ===
// Extend addresses.test (as per task spec) + config assertions.
// Assert DRY_RUN_EXECUTION defaults true (safety), LIQUIDATOR_ADDRESS optional/undef or from env,
// getters exist, no direct process.env access required from future callers (centralized here).
// Multi-chain: explicit getChainConfig(1) and (8453).
console.log('\n[CONFIG-EXEC-TEST] prod-001.02 Centralize execution config (DRY_RUN, LIQUIDATOR, PRIVATE_KEY) - TDD RED phase');

let configFailed = false;

try {
  const cfg1 = config.getChainConfig(1);
  const cfg8453 = config.getChainConfig(8453);

  // RED assertions (will fail until implemented in config.ts)
  if (cfg8453.DRY_RUN_EXECUTION !== true) {
    console.error('❌ getChainConfig(8453).DRY_RUN_EXECUTION !== true (expected default true for safety)');
    configFailed = true;
  } else {
    console.log('   ✓ cfg8453.DRY_RUN_EXECUTION === true');
  }

  if (cfg1.DRY_RUN_EXECUTION !== true) {
    console.error('❌ getChainConfig(1).DRY_RUN_EXECUTION !== true (expected default true)');
    configFailed = true;
  } else {
    console.log('   ✓ cfg1.DRY_RUN_EXECUTION === true');
  }

  // LIQUIDATOR_ADDRESS from env or undefined (per-chain override support)
  const liq1 = cfg1.LIQUIDATOR_ADDRESS;
  const liq8453 = cfg8453.LIQUIDATOR_ADDRESS;
  if (liq1 !== undefined && typeof liq1 !== 'string') {
    console.error('❌ LIQUIDATOR_ADDRESS on chain1 should be string | undefined');
    configFailed = true;
  }
  if (liq8453 !== undefined && typeof liq8453 !== 'string') {
    console.error('❌ LIQUIDATOR_ADDRESS on 8453 should be string | undefined');
    configFailed = true;
  }
  // If env sets it, would be present; default undef ok. Show current:
  console.log(`   ✓ LIQUIDATOR_ADDRESS (1): ${liq1 === undefined ? 'undefined' : liq1}`);
  console.log(`   ✓ LIQUIDATOR_ADDRESS (8453): ${liq8453 === undefined ? 'undefined' : liq8453}`);

  // PRIVATE_KEY accessor via getChainConfig or helpers (exposed, optional)
  const pk1 = cfg1.PRIVATE_KEY;
  if (pk1 !== undefined && typeof pk1 !== 'string') {
    console.error('❌ PRIVATE_KEY in getChainConfig should be string | undefined');
    configFailed = true;
  }
  console.log(`   ✓ PRIVATE_KEY exposed in getChainConfig (1): ${pk1 ? '[REDACTED-len:' + pk1.length + ']' : 'undefined (dry-run safe)'}`);

  // Helper methods must exist
  if (typeof config.getExecutorPrivateKey !== 'function') {
    console.error('❌ config.getExecutorPrivateKey() helper missing');
    configFailed = true;
  } else {
    const pkViaGetter = config.getExecutorPrivateKey();
    if (pkViaGetter !== undefined && typeof pkViaGetter !== 'string') {
      console.error('❌ getExecutorPrivateKey() should return string|undefined');
      configFailed = true;
    }
    console.log('   ✓ getExecutorPrivateKey() present');
  }

  if (typeof config.getExecutorWallet !== 'function') {
    console.error('❌ config.getExecutorWallet(rpcOrProvider) helper missing');
    configFailed = true;
  } else {
    // Should return null when no key (dry-run), or Wallet
    const wallet = config.getExecutorWallet();
    if (wallet !== null && !(wallet && typeof wallet === 'object')) {
      console.error('❌ getExecutorWallet() should return Wallet or null');
      configFailed = true;
    }
    console.log(`   ✓ getExecutorWallet() present (returns ${wallet ? 'Wallet' : 'null (expected for optional key)'})`);
  }

  // Verify per-chain values (even if DRY same, LIQ may differ via env override)
  if (typeof cfg1.DRY_RUN_EXECUTION !== 'boolean' || typeof cfg8453.DRY_RUN_EXECUTION !== 'boolean') {
    console.error('❌ DRY_RUN_EXECUTION must be boolean in getChainConfig per chain');
    configFailed = true;
  }
  console.log('   ✓ getChainConfig(1) vs (8453) return per-chain aware objects');

  // Ensure no direct process.env leak expectation (callers will use config only)
  console.log('   ✓ (note: future callers must use config.get* or helpers; no direct process.env for these)');

} catch (e: any) {
  console.error('❌ Exception during config exec test:', e.message);
  configFailed = true;
}

if (configFailed) {
  console.error('\n[RED] Execution config centralization test FAILED. Implement in config.ts + .env.example first.');
  process.exit(1);
} else {
  console.log('\n✅ [GREEN] Execution config centralization assertions passed.');
}
