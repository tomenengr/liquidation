/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';

// TDD Test: Detect hardcoded private keys / secrets in source code
// This test should FAIL (RED) until we remove the hardcoded key from e2e.ts

const ROOT_DIR = path.join(__dirname, '..', '..');
const EXCLUDE_DIRS = ['node_modules', 'lib', 'out', 'cache', '.git'];
const INCLUDE_EXTS = ['.ts', '.sol', '.js', '.md', '.json'];
const PRIVATE_KEY_PATTERN = /0x[a-fA-F0-9]{64}/g;  // Typical 32-byte private key hex

function scanForSecrets(dir: string): string[] {
  const issues: string[] = [];
  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);

    if (file.isDirectory()) {
      if (EXCLUDE_DIRS.includes(file.name)) continue;
      issues.push(...scanForSecrets(fullPath));
    } else if (INCLUDE_EXTS.some(ext => file.name.endsWith(ext))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const matches = content.match(PRIVATE_KEY_PATTERN) || [];

      // Check for hardcoded API keys / RPC URLs containing secret tokens (Alchemy / Infura / Zan.top / etc.)
      const rpcKeyPattern = /(https?:\/\/[^\s"'`]+(?:alchemy\.com\/v2\/|infura\.io\/v3\/|zan\.top\/[^\s"'`]+\/)[a-zA-Z0-9_-]{16,})/g;
      const rpcMatches = content.match(rpcKeyPattern) || [];

      for (const rpcMatch of rpcMatches) {
        // Only flag in bot/src or bot/test (excluding config fallback examples or standard tests)
        if (fullPath.includes('bot/src')) {
          issues.push(`HARDCODED RPC API KEY in ${fullPath}: ${rpcMatch}`);
        }
      }

      for (const match of matches) {
        // Allow known test keys in forge-std or obvious dummy test keys
        if (fullPath.includes('forge-std') || fullPath.includes('ox/')) continue;
        if (match === '0x1234567890123456789012345678901234567890123456789012345678901234') continue;
        if (match === '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') continue; // Anvil #0
        
        // If the file is in bot/src or test and has a real-looking key
        if (fullPath.includes('bot/src') || fullPath.includes('bot/test')) {
          issues.push(`POTENTIAL HARDCODED PRIVATE KEY in ${fullPath}: ${match}`);
        }
      }
    }
  }
  return issues;
}

console.log('[SECRETS-CHECK] Scanning for hardcoded private keys...');
const issues = scanForSecrets(ROOT_DIR);

import { config } from '../src/config';

console.log('[MEV-CONFIG-VALIDATION] Checking MEV settings...');
const chainCfg = config.getChainConfig(1); // test with mainnet
if (!chainCfg.MOCK_MEV) {
  if (!chainCfg.FLASHBOTS_AUTH_KEY) {
    console.log('⚠️  [WARNING] MOCK_MEV is false but FLASHBOTS_AUTH_KEY is not set. A random key will be used for Flashbots reputation.');
  }
}

if (issues.length > 0) {
  console.error('\n❌ [RED] Secrets hygiene test FAILED:');
  issues.forEach(i => console.error('  ' + i));
  console.error('\nRun this test with: npx ts-node bot/test/secrets-check.ts');
  process.exit(1);
} else {
  console.log('✅ [GREEN] No hardcoded private keys found in source.');
}

console.log('Secrets check complete.');