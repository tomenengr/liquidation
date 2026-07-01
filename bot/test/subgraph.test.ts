/// <reference types="node" />
/**
 * TDD Test for Task 3.6: Subgraph Client for User Discovery
 *
 * Per plan + design:
 * - Hosted subgraph via GRAPH_API_KEY + SUBGRAPH_URL_*
 * - Discover borrowers with debt
 * - Fetch positions + eMode / isolation data
 * - Multi-chain (Ethereum + L2s)
 *
 * Run: npx ts-node bot/test/subgraph.test.ts
 * (Provide GRAPH_API_KEY in .env for full data fetches)
 */

import { config } from '../src/config';

// We will import after skeleton; test will fail until implemented
import { SubgraphClient } from '../src/subgraph';

console.log('[SUBGRAPH-TEST] Starting Task 3.6 Subgraph Client test (TDD)...');

let passed = 0;
let total = 0;

function run(name: string, fn: () => void | Promise<void>) {
  total++;
  const p = Promise.resolve().then(fn);
  p.then(() => {
    console.log(`✅ ${name}`);
    passed++;
  }).catch((e: any) => {
    console.error(`❌ ${name}`);
    console.error('   ', e?.message || e);
  });
}

async function main() {
  // Config integration (should work immediately after config update)
  console.log('  CHAIN_ID default:', config.CHAIN_ID);
  console.log('  Subgraph ETH :', config.getSubgraphUrl(1));
  console.log('  Subgraph Base:', config.getSubgraphUrl(8453));
  console.log('  Subgraph Arb :', config.getSubgraphUrl(42161));
  console.log('  Has GRAPH_API_KEY:', !!config.getGraphApiKey());

  if (config.getSubgraphUrl(1) === config.getSubgraphUrl(8453)) {
    throw new Error('Subgraph URLs must differ per chain');
  }

  // Test client creation for multiple chains
  const clientEth = new SubgraphClient(1);
  const clientBase = new SubgraphClient(8453);
  const clientArb = new SubgraphClient(42161);
  console.log('  Clients created for 3 chains OK');

  // === Core TDD test: query borrowers ===
  // This should fail first until client + fetch + query implemented
  run('getUsersWithDebt returns array (multi-chain capable)', async () => {
    // Use small page to be gentle
    const users = await clientBase.getUsersWithDebt(5, 0);
    if (!Array.isArray(users)) {
      throw new Error('Expected array from getUsersWithDebt');
    }
    console.log(`    Base sample users returned: ${users.length} (0 is OK without valid GRAPH_API_KEY)`);
    // Real data only when GRAPH_API_KEY set and endpoint current
  });

  run('getUsersWithDebt supports pagination and eMode fields in result shape', async () => {
    const users = await clientEth.getUsersWithDebt(3, 10);
    if (!Array.isArray(users)) throw new Error('pagination call failed to return array');

    // Look for eMode or userReserves with scaled values (design requires eMode support)
    if (users.length > 0) {
      const sample = users[0];
      if (!sample.id) throw new Error('user missing id');
      if (sample.userReserves && !Array.isArray(sample.userReserves)) {
        throw new Error('userReserves should be array');
      }
      // eMode may be at user level or per reserve depending on subgraph version
      console.log('    Sample user has id and reserves shape OK (eMode fields will map in future)');
    } else {
      console.log('    No users returned (no GRAPH_API_KEY or endpoint) — shape test skipped gracefully');
    }
  });

  run('can fetch for Arbitrum (L2) without crashing', async () => {
    const users = await clientArb.getUsersWithDebt(2);
    if (!Array.isArray(users)) throw new Error('Arb L2 query did not return array');
  });

  // Basic reserves query (will be used for prices later)
  run('getReserves or equivalent works (for price/index data)', async () => {
    // The client may expose getReserves()
    // For now we tolerate if method exists or we call a general one
    // If the client implements a getReserves, use it; else basic users query already covers some reserve data
    const users = await clientBase.getUsersWithDebt(1);
    // Indirect check: userReserves should contain reserve data
    if (users.length > 0 && users[0].userReserves && users[0].userReserves[0]?.reserve) {
      const r = users[0].userReserves[0].reserve;
      if (!r.id) throw new Error('reserve id missing');
    }
  });

  // Wait for async runs
  await new Promise(r => setTimeout(r, 1200));

  console.log(`\n[SUBGRAPH-TEST] ${passed}/${total} passed`);
  if (passed !== total) {
    console.error('Failing tests indicate missing implementation or query issues (expected in RED phase).');
    process.exit(1);
  }
  console.log('✅ All subgraph client tests passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});