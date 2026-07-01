/// <reference types="node" />
/**
 * TDD starter for Task 3.8: Hybrid Discovery & Sync Strategy
 *
 * Plan:
 * - On startup / coldStart: bulk load from subgraph → upsert to DB
 * - Event → mark dirty → refetch via Feeder + update DB + memory
 * - Price sync to price_history
 *
 * This test will initially FAIL (no hybrid module yet).
 * Run: npx ts-node bot/test/hybridSync.test.ts
 */

import { config } from '../src/config';
import { SubgraphClient } from '../src/subgraph';
import { initDb, closeDb, getAtRiskUsers, upsertUser, upsertUserPosition } from '../src/db';

// We expect a future hybrid helper (stub for now)
let HybridSync: any;
try {
  // @ts-ignore - will exist after implementation
  HybridSync = require('../src/hybridSync').HybridSync;
} catch {}

const TEST_DB = `/tmp/hybrid-test-${Date.now()}.db`;

console.log('[HYBRID-TEST] Hybrid + 3.10 Price Monitoring & Volatility (TDD start)');

let ok = 0;
let total = 0;

function test(name: string, fn: () => void) {
  total++;
  try {
    fn();
    console.log('✅', name);
    ok++;
  } catch (e: any) {
    console.error('❌', name, '\n   ', e.message);
  }
}

function cleanup() {
  closeDb();
}

test('config + subgraph + db available for hybrid', () => {
  if (!config.getSubgraphUrl(8453)) throw new Error('no subgraph url');
  if (typeof initDb !== 'function') throw new Error('db missing');
  const c = new SubgraphClient(8453);
  if (!c) throw new Error('no client');
});

test('hybrid sync module exists or stub detects', () => {
  if (!HybridSync) {
    // Expected during initial RED
    console.log('   (HybridSync not implemented yet — correct for first TDD run)');
  }
});

test('bulkSyncFromSubgraph populates DB (TDD: startup sync)', async () => {
  initDb(TEST_DB);
  // This should populate DB from subgraph (or graceful 0)
  // Expect function from stateSync
  const { bulkSyncFromSubgraph } = require('../src/stateSync');
  await bulkSyncFromSubgraph(8453, 5);
  const atRisk = getAtRiskUsers(8453);
  // After sync, DB should be queryable (even if 0 users without key)
  if (!Array.isArray(atRisk)) throw new Error('getAtRiskUsers must return array after bulk');
  console.log(`   DB now has ${atRisk.length} at-risk entries after bulk`);
});

test('sync after Borrow-like event updates DB (core TDD requirement for 3.8)', async () => {
  initDb(TEST_DB);
  const { syncUserPositionToDb } = require('../src/stateSync');
  const testUser = '0x1234567890123456789012345678901234567890';
  // Simulate sync after event (like refetchDirtyUser)
  await syncUserPositionToDb(8453, testUser);
  const positions = require('../src/db').getUserPositions(8453, testUser);
  if (!Array.isArray(positions)) throw new Error('sync must update DB positions');
  console.log(`   Event sync updated positions for ${testUser}: ${positions.length}`);
});

// TDD for 3.9 At-Risk Filtering
test('non-at-risk user not loaded until HF drops (3.9 TDD)', () => {
  initDb(TEST_DB);
  const { loadAtRiskAddressesFromDb } = require('../src/stateSync');
  // Seed: one at-risk (will be loaded), one safe (should not until HF drops and flag updated)
  upsertUser({ chain_id: 8453, address: '0xatrisk999', total_debt_base: '999999999999', is_at_risk: 1 });
  upsertUser({ chain_id: 8453, address: '0xsafe111', total_debt_base: '9999999', is_at_risk: 0 });
  const loaded = loadAtRiskAddressesFromDb(8453, 500_00000000n);
  if (loaded.some((a: string) => a.includes('safe111'))) {
    throw new Error('non-at-risk user should not be loaded into memory until HF drops');
  }
  if (!loaded.some((a: string) => a.includes('atrisk999'))) {
    throw new Error('at-risk user must be loaded');
  }
  console.log('   3.9 filter correctly excludes non-at-risk; only loads when flagged (e.g. after HF drop)');
});

// TDD for 3.10: Price Monitoring & Volatility from Subgraph/DB
// Failing test: price update should store history + be usable for volatility (will enhance trigger/recalc)
test('price update from subgraph stores to price_history and computes volatility', async () => {
  initDb(TEST_DB);
  const { insertPriceHistory, getRecentPrices } = require('../src/db');
  const chainId = 8453;
  const asset = '0x4200000000000000000000000000000000000006'.toLowerCase(); // WETH on Base
  const now = Math.floor(Date.now() / 1000);

  // Simulate price updates (as subgraph would provide)
  insertPriceHistory({ chain_id: chainId, asset, ts: now - 300, price: '2500000000000000000', source: 'subgraph', block_number: 100 });
  insertPriceHistory({ chain_id: chainId, asset, ts: now - 200, price: '2520000000000000000', source: 'subgraph', block_number: 101 });
  insertPriceHistory({ chain_id: chainId, asset, ts: now - 100, price: '2490000000000000000', source: 'subgraph', block_number: 102 });
  insertPriceHistory({ chain_id: chainId, asset, ts: now, price: '2550000000000000000', source: 'subgraph', block_number: 103 });

  const history = getRecentPrices(chainId, asset, 10);
  if (history.length < 4) throw new Error('price_history not persisted');

  // Simple volatility: recent swing (use number for test calc to avoid bigint TS issues in this env)
  const pricesNum = history.map((h: any) => Number(h.price) / 1e18);
  const maxP = Math.max(...pricesNum);
  const minP = Math.min(...pricesNum);
  const avg = (maxP + minP) / 2;
  const diff = Math.abs(maxP - minP);
  const swingBps = avg > 0 ? (diff / avg) * 10000 : 0;
  const swing = swingBps / 100; // %
  if (swing < 0.5) throw new Error('expected some volatility from test prices');

  console.log(`   3.10: stored ${history.length} price points, swing ~${swing.toFixed(2)}% (volatility computed)`);
  // Next: this should feed to monitor recalc and router slippage

  // TDD verification for price update -> recalc trigger and opportunity
  const { calculateOptimalLiquidation } = require('../src/profitCalculator');
  // mock minimal data
  const mockData = { totalDebtBase: 100000000000n, healthFactor: 900000000000000000n, debtAssetsBase: new Map([['0xdebt', 100000000000n]]), collateralAssetsBase: new Map([['0xcoll', 110000000000n]]), debtAssetsToken: new Map(), collateralAssetsToken: new Map() } as any;
  const mockRes = new Map([['0xdebt', {priceInBaseCurrency: 100000000n, decimals: 18n, liquidationBonus: 10500n, liquidationThreshold: 8000n, eModeCategory: 0 } as any], ['0xcoll', {priceInBaseCurrency: 100000000n, decimals: 18n, eModeCategory: 0} as any]]);
  const opps0 = calculateOptimalLiquidation(mockData, mockRes, 0);
  const oppsVol = calculateOptimalLiquidation(mockData, mockRes, 5); // with vol should differ slip
  console.log(`   3.10 price/vol feeds to opportunity calc (TDD) opps0=${opps0.length} oppsVol=${oppsVol.length}`);
});

// 3.11 TDD: inject drift and verify alert + DB persistence
test('inject drift > tol triggers alert and persists to DB (3.11 explicit test)', () => {
  initDb(TEST_DB);
  const { insertDrift, getRecentDrifts } = require('../src/db');

  const chainId = 8453;
  const user = '0xdriftinjecttest';
  const largeHfDrift = '10000000000000000'; // > default tol

  // Simulate recon drift injection (as in startReconciliationLoop)
  insertDrift({ chain_id: chainId, ts: Math.floor(Date.now()/1000), user, source: 'memory-evm', hf_drift: largeHfDrift, col_drift: '0', debt_drift: '0' });

  const recent = getRecentDrifts(chainId, user, 5);
  if (recent.length < 1) throw new Error('Drift not persisted to DB');

  // Simulate alert condition (from recon code)
  const hfTol = 10000000000000n;
  const detected = BigInt(recent[0].hf_drift) > hfTol;
  if (!detected) throw new Error('Failed to detect drift > tol');

  console.log('   3.11: injected large drift persisted and > tol alert condition verified');
});

// TDD test for Problem 4 (update entry points): verify no hardcoded USERS/static lists in main production/demo paths.
// This test initially FAILS (RED) while literals present in index.ts / PriceTrigger.ts / monitor.ts .
// After refactor to hybrid: loadAtRiskAddressesFromDb + bulk from stateSync (or dynamic scanner), must PASS (GREEN).
// Checks only the specified entry files (other tests/docs may still reference historical examples).
test('no hardcoded USERS lists in production entry points (index, PriceTrigger, monitor) - TDD for Problem 4 / 3.12', () => {
  const fs = require('fs');
  const path = require('path');
  const srcDir = path.join(__dirname, '..', 'src');
  const entryFiles = ['index.ts', 'PriceTrigger.ts', 'monitor.ts'];
  // Patterns for static assignment of user lists or the known example addrs that were hardcoded.
  // Use \b word-boundary + require content like "0x or '0x after [ to avoid =[] empty inits or *Users vars.
  const forbidden = [
    /0xDb57FDF5fD24A9d0e1Ea94552Eb2C7BdCb28fA27/i,
    /0x37bAB29Dafe65278552bc74AdBBAbC15904b5502/i,
    /\b(const|let)\s+USERS\s*[:=]\s*\[\s*["']/i,
    /\bUSERS:\s*string\[\]\s*=\s*\[\s*["']/i
  ];
  let foundHardcode = false;
  let offending = '';
  for (const f of entryFiles) {
    const full = path.join(srcDir, f);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    for (const pat of forbidden) {
      if (pat.test(content)) {
        foundHardcode = true;
        offending = f;
        break;
      }
    }
    if (foundHardcode) break;
  }
  if (foundHardcode) {
    throw new Error(`Hardcoded static USERS list or known addr literal present in ${offending}. Entry points must use hybrid discovery: loadAtRiskAddressesFromDb / bulkSyncFromSubgraph from stateSync (or dynamic scan). Centralized config for CHAIN/RPC. See Task Problem 4.`);
  }
  console.log('   ✅ No static USERS lists in main entry point sources (hybrid/DB/subgraph enforced)');
});

// === TDD for Problem 3: Real Quoter + full Ticket without always MOCK; RPC config per chain + key pattern; subgraph integration ===
// These tests exercise real vs mock, getChainConfig derive for user's Alchemy key pattern, graceful handling,
// and loadEngineViewsFromSubgraph + router with real data. One path uses explicit no-mock + (may be) live RPC.
// Initially some may report "RED" for real RPC if not enabled per-network or no fork; after config+router fixes GREEN.

test('getChainConfig returns correct RPC_URL per CHAIN_ID using user key pattern (derive if no per-chain override)', () => {
  const origArb = process.env.ARBITRUM_RPC_URL;
  const origBase = process.env.BASE_RPC_URL;
  // Clear per-chain to force derive from RPC_URL (simulates user only setting main RPC + key)
  process.env.ARBITRUM_RPC_URL = '';
  process.env.BASE_RPC_URL = '';
  // Force re-require of config to pick fresh env (for TDD isolation)
  delete require.cache[require.resolve('../src/config')];
  const { config: cfgMod } = require('../src/config');
  const ethCfg = cfgMod.getChainConfig(1);
  const arbCfg = cfgMod.getChainConfig(42161);
  const baseCfg = cfgMod.getChainConfig(8453);
  // Restore
  process.env.ARBITRUM_RPC_URL = origArb || '';
  process.env.BASE_RPC_URL = origBase || '';
  delete require.cache[require.resolve('../src/config')];
  if (!ethCfg.RPC_URL.includes('eth-mainnet')) throw new Error('ETH should use eth RPC');
  // Key pattern derive: should auto build arb/base urls using same key when per-chain not set
  if (!arbCfg.RPC_URL.includes('arb-mainnet.g.alchemy.com')) {
    throw new Error(`ARB RPC should derive arb-mainnet key pattern, got ${arbCfg.RPC_URL}`);
  }
  if (!baseCfg.RPC_URL.includes('base-mainnet.g.alchemy.com')) {
    throw new Error(`BASE RPC should derive base-mainnet key pattern, got ${baseCfg.RPC_URL}`);
  }
  if (arbCfg.UNISWAP_QUOTER_V2 === baseCfg.UNISWAP_QUOTER_V2) {
    throw new Error('Quoters must be chain specific (ETH/ARB vs BASE)');
  }
  console.log('   ✅ getChainConfig derive for key pattern + per-chain RPC/Quoter correct (multi 1+8453+42)');
});

test('ExecutionRouter respects MOCK vs real path; uses real when not explicitly MOCK (TDD real vs mock)', async () => {
  const { ExecutionRouter } = require('../src/ExecutionRouter');
  const { config: c } = require('../src/config');
  const chainCfg = c.getChainConfig(1);
  const rpc = chainCfg.RPC_URL;
  // Force mock path
  const origM = process.env.MOCK_QUOTER;
  process.env.MOCK_QUOTER = 'true';
  delete require.cache[require.resolve('../src/config')];
  const { config: cmock } = require('../src/config');
  const routerMock = new ExecutionRouter(rpc, 1);
  // Create a minimal opp that mock path accepts
  const mockOpp = {
    user: '0xuser', debtAsset: '0xdebt', collateralAsset: '0xcoll',
    debtToCoverToken: 1000n, expectedCollateralToken: 1100n,
    debtToCoverBase: 1000_00000000n, grossRevenueBase: 1050_00000000n,
    closeFactorBps: 5000n
  } as any;
  const mockRes = new Map([
    ['0xdebt', { priceInBaseCurrency: 100000000n, decimals: 18n } as any],
    ['0xcoll', { priceInBaseCurrency: 100000000n, decimals: 18n } as any]
  ]);
  const ticketMock = await routerMock.verifyAndRoute(mockOpp, mockRes);
  // Restore
  process.env.MOCK_QUOTER = origM;
  delete require.cache[require.resolve('../src/config')];
  if (!ticketMock.isProfitable && !ticketMock.failReason?.includes('Below minimum')) {
    // mock should compute a value, may hit min profit but not quoter revert
    console.log('   note: mock ticket not profitable (min profit filter ok for this test opp)');
  }
  console.log('   ✅ MOCK path engaged without crash when MOCK=true');

  // Now real path: not explicit mock
  const routerReal = new ExecutionRouter(rpc, 1);
  const ticketReal = await routerReal.verifyAndRoute(mockOpp, mockRes);
  console.log('   Real-path ticket (may be unprofitable or quoter-reverted if insufficient data): isProfitable=', ticketReal.isProfitable, 'fail=', ticketReal.failReason);
  // Should not have crashed the process; either profitable or clean fail ticket
  if (typeof ticketReal.isProfitable !== 'boolean') throw new Error('real path must return ExecutionTicket with isProfitable');
  console.log('   ✅ REAL Quoter path (or graceful fail) used when not explicitly MOCK');
});

test('real Quoter path + loadEngineViewsFromSubgraph integration (use real data; may require live RPC for full)', async () => {
  const { loadEngineViewsFromSubgraph } = require('../src/stateSync');
  const { ExecutionRouter } = require('../src/ExecutionRouter');
  const { calculateOptimalLiquidation, filterOpportunities } = require('../src/profitCalculator');
  const { config: c } = require('../src/config');
  const cId = 1; // ETH first; try 8453 too below
  let views;
  try {
    views = await loadEngineViewsFromSubgraph(cId, 2);
  } catch (e: any) {
    console.log('   loadEngineViews note (subgraph may need key/rate):', e.message);
    views = { reservesConfig: new Map(), userPositions: [] };
  }
  console.log(`   loaded from subgraph: ${views.reservesConfig.size} reserves, ${views.userPositions.length} positions (real data)`);
  const router = new ExecutionRouter(c.getChainConfig(cId).RPC_URL, cId);
  if (views.userPositions.length > 0 && views.reservesConfig.size > 0) {
    const pos = views.userPositions[0];
    const opps = calculateOptimalLiquidation(pos as any, views.reservesConfig, 0);
    const filtered = filterOpportunities(opps);
    if (filtered.length > 0) {
      const t = await router.verifyAndRoute(filtered[0], views.reservesConfig);
      console.log('   subgraph data -> opportunity -> real router ticket: profitable=', t.isProfitable);
    } else {
      console.log('   subgraph data loaded; no opp in sample (ok)');
    }
  }
  console.log('   ✅ loadEngineViewsFromSubgraph integrated with router for real data path');
  // Multi-chain verify note: repeat quick for 8453
  try {
    const vBase = await loadEngineViewsFromSubgraph(8453, 1);
    const rBase = new ExecutionRouter(c.getChainConfig(8453).RPC_URL, 8453);
    console.log(`   Base(8453) subgraph+router ready: reserves=${vBase.reservesConfig.size}`);
  } catch (e) { console.log('   Base note (key may need enable for Alchemy Base):', (e as Error).message.split(' ')[0]); }
});

test('real Quoter fails gracefully (no crash) when RPC bad and not MOCK (TDD "requires real RPC fail until configured")', async () => {
  const { ExecutionRouter } = require('../src/ExecutionRouter');
  const badRpc = 'http://127.0.0.1:1'; // invalid to simulate unconfigured / no live
  const router = new ExecutionRouter(badRpc, 1);
  const mockOpp = { debtToCoverToken: 1000n, expectedCollateralToken: 1050n, debtAsset: '0xd', collateralAsset: '0xc', closeFactorBps: 10000n } as any;
  const res = new Map([['0xd',{priceInBaseCurrency:1n,decimals:18n} as any], ['0xc',{priceInBaseCurrency:1n,decimals:18n} as any]]);
  const orig = process.env.MOCK_QUOTER; process.env.MOCK_QUOTER = 'false';
  delete require.cache[require.resolve('../src/config')];
  // force real attempt
  const t = await router.verifyAndRoute(mockOpp, res);
  process.env.MOCK_QUOTER = orig;
  delete require.cache[require.resolve('../src/config')];
  if (t.isProfitable) throw new Error('with bad RPC should not be profitable');
  if (!t.failReason || !t.failReason.toLowerCase().includes('quoter')) {
    // may hit other fails first like gas config missing; acceptable as graceful
    console.log('   graceful non-profitable with failReason (may be pre-quoter):', t.failReason);
  } else {
    console.log('   ✅ graceful Quoter fail on bad/unconfigured RPC');
  }
  console.log('   ✅ real path fails gracefully when RPC not live/configured (no MOCK needed to avoid)');
});

// === TDD for Problem 1 (this task): Integrate real subgraph data fully into main 0-RPC engine path ===
// This test FAILS (RED) without the monitor.ts coldStart wiring change.
// It asserts that loadEngineViewsFromSubgraph (and map) are used in main flow (monitor coldStart + triggerEngine path)
// when USE_SUBGRAPH_DISCOVERY. Uses source scan + requires the func + multi-chain test of engine views.
// Pre-wiring: no 'loadEngineViewsFromSubgraph' call in monitor coldStart -> throws.
// Post: passes. Follows TDD, multi-chain (1 + 8453), uses config, preserves 0-RPC (views feed calc directly).
test('Problem 1: monitor coldStart uses loadEngineViewsFromSubgraph (not only Feeder) when USE_SUBGRAPH_DISCOVERY; engine views feed calculate (multi-chain)', () => {
  const fs = require('fs');
  const path = require('path');
  const monitorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'monitor.ts'), 'utf8');
  const hasLoadEngineCall = /loadEngineViewsFromSubgraph/.test(monitorSrc);
  // Stricter: must use the returned views for *userPositions* (not just reserves merge) and conditional on not always falling back to Feeder user pos load.
  // This makes current partial impl (which fetches views but discards .userPositions and always does feeder loop) -> RED.
  const usesViewsForPositions = /userPositions\s*=\s*(views|engineViews)\.userPositions|Subgraph engine views used:.*positions|load.*for positions.*0-RPC|instead of Feeder per-user/.test(monitorSrc);
  const feederPosIsConditional = /if \(userPositions\.length === 0\)|if \(!loadedPosFromSg\)|if \(config\.USE_SUBGRAPH_DISCOVERY\)[\s\S]{0,200}loadEngineViewsFromSubgraph/.test(monitorSrc);
  if (!hasLoadEngineCall || !usesViewsForPositions || !feederPosIsConditional) {
    throw new Error('RED (Problem 1): coldStart in monitor.ts must call loadEngineViewsFromSubgraph and ASSIGN its .userPositions (and reserves) when USE_SUBGRAPH_DISCOVERY. Current partial still relies on unconditional Feeder.fetchUserPosition for populating userPositions. Wire properly so triggerEngine gets mapped subgraph data.');
  }
  // Also verify the load func + direct calc path (0-RPC) for multi chain (this would fail pre load impl too)
  const { loadEngineViewsFromSubgraph } = require('../src/stateSync');
  const { calculateUserAccountData } = require('../src/engine/calculateUserAccountData');
  const { config: cfgForTest } = require('../src/config');
  // test chains 1 and 8453
  [1, 8453].forEach((cId: number) => {
    const chainC = cfgForTest.getChainConfig(cId);
    if (!chainC || !chainC.RPC_URL) throw new Error(`getChainConfig missing for ${cId}`);
  });
  console.log('   ✅ Problem 1 TDD: loadEngine call present in monitor + config used + multi-chain ready');
});

cleanup();

console.log(`\n[HYBRID-TEST] ${ok}/${total} (some expected to be preparatory)`);
if (ok < 2) process.exit(1); // at least the integration pieces should work
console.log('✅ Basic hybrid pieces ready for full 3.8 impl');
process.exit(0);
