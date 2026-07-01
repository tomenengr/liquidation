/// <reference types="node" />
/**
 * TDD Test for Task 3.7: Local SQLite DB Layer
 * 
 * Write failing test FIRST (per Superpowers TDD).
 * Run: npx ts-node bot/test/db.test.ts
 *
 * Covers:
 * - Schema with eMode + isolation fields (added NOW)
 * - Upsert + query users/positions across chains
 * - At-risk filtering
 * - Reserves + price history
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  initDb,
  closeDb,
  upsertUser,
  upsertUserPosition,
  getAtRiskUsers,
  getUserPositions,
  upsertReserve,
  insertPriceHistory,
  getRecentPrices,
  UserRow,
  UserPositionRow,
} from '../src/db';

const TEST_DB = path.join(__dirname, '..', 'data', `test-db-${Date.now()}.db`);

function fail(msg: string) {
  console.error('❌', msg);
  process.exit(1);
}

function pass(msg: string) {
  console.log('✅', msg);
}

let testsRun = 0;
let testsPassed = 0;

function runTest(name: string, fn: () => void) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`✅ ${name}`);
  } catch (e: any) {
    console.error(`❌ ${name}`);
    console.error('   ', e?.message || e);
    // Continue to report all, but will exit 1 at end
  }
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB)) {
    try { fs.unlinkSync(TEST_DB); } catch {}
  }
}

console.log('[DB-TEST] Starting Task 3.7 DB layer test (eMode/isolation first) ...');

// RED expectation: these will fail until schema + methods implemented correctly
cleanup();
initDb(TEST_DB);

// Test 1: Schema contains eMode + isolation columns (must be added NOW)
runTest('schema contains e_mode_category_id + is_isolated + isolation fields', () => {
  const db = initDb(TEST_DB);
  const cols = (db.prepare("PRAGMA table_info(user_positions)").all() as any[]).map(c => c.name);
  if (!cols.includes('e_mode_category_id')) throw new Error('Missing e_mode_category_id');
  if (!cols.includes('is_isolated')) throw new Error('Missing is_isolated');
  if (!cols.includes('isolation_mode_asset')) throw new Error('Missing isolation_mode_asset');
  if (!cols.includes('isolation_mode_total_debt')) throw new Error('Missing isolation_mode_total_debt');
});

// Test 2: Roundtrip user + eMode position + isolated position (L2)
runTest('upsert + query positions with eMode + isolation (Base 8453)', () => {
  const chainId = 8453;
  const userAddr = '0x1234567890123456789012345678901234567890'.toLowerCase();

  upsertUser({
    chain_id: chainId,
    address: userAddr,
    last_hf: '980000000000000000',
    total_debt_base: '123456789000',
    is_at_risk: 1,
    last_update_block: 999999,
  } as UserRow);

  upsertUserPosition({
    chain_id: chainId,
    user_address: userAddr,
    asset: '0x4200000000000000000000000000000000000006'.toLowerCase(),
    collateral_scaled: '12300000000000000000',
    debt_var_scaled: '4500000000000000000',
    debt_stable_scaled: '0',
    e_mode_category_id: 1,
    is_isolated: 0,
    isolation_mode_asset: undefined,
    isolation_mode_total_debt: '0',
  } as UserPositionRow);

  upsertUserPosition({
    chain_id: chainId,
    user_address: userAddr,
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'.toLowerCase(),
    collateral_scaled: '5000000000',
    debt_var_scaled: '0',
    debt_stable_scaled: '3000000000',
    e_mode_category_id: 0,
    is_isolated: 1,
    isolation_mode_asset: '0x4200000000000000000000000000000000000006'.toLowerCase(),
    isolation_mode_total_debt: '2900000000',
  } as UserPositionRow);

  const atRisk = getAtRiskUsers(chainId, 100_00000000n);
  if (atRisk.length < 1) throw new Error('Expected at least 1 at-risk user');
  if (atRisk[0].address.toLowerCase() !== userAddr) throw new Error('Wrong user returned');

  const positions = getUserPositions(chainId, userAddr);
  if (positions.length !== 2) throw new Error(`Expected 2 positions, got ${positions.length}`);

  const eModeOne = positions.find(p => p.e_mode_category_id === 1);
  if (!eModeOne) throw new Error('eMode position not stored/retrieved');
  if (eModeOne.is_isolated !== 0) throw new Error('eMode pos should not be isolated');

  const isoOne = positions.find(p => p.is_isolated === 1);
  if (!isoOne) throw new Error('Isolation position not stored/retrieved');
  if (!isoOne.isolation_mode_asset || !isoOne.isolation_mode_asset.toLowerCase().includes('4200')) {
    throw new Error('isolation_mode_asset not persisted correctly');
  }
});

// Test 3: Multi-chain separation (chain_id filter works)
runTest('chain_id isolation works (Ethereum vs Base)', () => {
  const ethAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'.toLowerCase();
  upsertUser({ chain_id: 1, address: ethAddr, total_debt_base: '777777777777', is_at_risk: 1 } as UserRow);

  const baseAtRisk = getAtRiskUsers(8453);
  const ethAtRisk = getAtRiskUsers(1);

  const foundInBase = baseAtRisk.some(u => u.address.toLowerCase() === ethAddr);
  if (foundInBase) throw new Error('Ethereum user leaked into Base query');

  if (ethAtRisk.length < 1) throw new Error('Ethereum user should be queryable on chain 1');
});

// Test 4: min debt filter + price history
runTest('getAtRiskUsers minDebt filter + price history roundtrip', () => {
  const c = 42161;
  upsertUser({ chain_id: c, address: '0xaaa', total_debt_base: '12300000000', is_at_risk: 0 } as UserRow); // below
  upsertUser({ chain_id: c, address: '0xbbb', total_debt_base: '99900000000', is_at_risk: 1 } as UserRow); // above

  const filtered = getAtRiskUsers(c, 500_00000000n);
  if (filtered.length !== 1 || !filtered[0].address.includes('bbb')) {
    throw new Error('minDebt filter failed');
  }

  const now = Math.floor(Date.now() / 1000);
  insertPriceHistory({ chain_id: c, asset: '0x82af', ts: now - 100, price: '123' });
  insertPriceHistory({ chain_id: c, asset: '0x82af', ts: now, price: '456' });

  const hist = getRecentPrices(c, '0x82af', 10);
  if (hist.length < 2) throw new Error('Price history not persisted');
});

cleanup();

console.log(`\n[DB-TEST] ${testsPassed}/${testsRun} passed`);
if (testsPassed !== testsRun) {
  console.error('Some tests failed.');
  process.exit(1);
}
console.log('✅ All DB layer tests passed (eMode + isolation + multi-chain)');
process.exit(0);
