import * as assert from 'assert';
import { createProviderPool, isTransientError } from '../src/providerPool';
import { ethers } from 'ethers';

async function runTests() {
  console.log('Running ProviderPool tests...');

  // Test 1
  let provider = createProviderPool('http://localhost:8545');
  assert.ok(provider instanceof ethers.JsonRpcProvider, 'Should return JsonRpcProvider when no fallbacks');

  // Test 2
  provider = createProviderPool('http://localhost:8545', ['http://localhost:8546']);
  assert.ok(provider instanceof ethers.FallbackProvider, 'Should return FallbackProvider when fallbacks are provided');

  // Test 3
  assert.ok(isTransientError(new Error('rate limit exceeded')), 'Should identify rate limit');
  assert.ok(isTransientError(new Error('HTTP 429')), 'Should identify 429');
  assert.ok(isTransientError(new Error('timeout')), 'Should identify timeout');
  assert.ok(isTransientError(new Error('500 internal server error')), 'Should identify 500');
  assert.ok(isTransientError({ code: 'TIMEOUT' }), 'Should identify TIMEOUT code');
  assert.ok(!isTransientError(new Error('user reverted transaction')), 'Should not identify revert');

  // Test 4
  let threw = false;
  try {
    createProviderPool('');
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, 'Should throw error when no URLs provided');

  console.log('All tests passed!');
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
