const fs = require('fs');
const p = '/home/enengr/.gemini/antigravity-cli/brain/5a2c5c94-0ceb-49a1-9329-52382e34211d/.system_generated/worktrees/subagent-RPC-Failover-Engineer-self-745965a7/bot/src/config.ts';
let c = fs.readFileSync(p, 'utf8');

c = c.replace(
`  // Note: per-chain explicit preferred; getChainConfig will derive from RPC_URL key pattern if unset.
  RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8545',
  ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL || '',
  BASE_RPC_URL: process.env.BASE_RPC_URL || '',`,
`  // Note: per-chain explicit preferred; getChainConfig will derive from RPC_URL key pattern if unset.
  RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:8545',
  ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL || '',
  BASE_RPC_URL: process.env.BASE_RPC_URL || '',

  // RPC Fallbacks (Task 3.04/3.05) - Comma separated lists
  RPC_FALLBACKS: (process.env.RPC_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean),
  RPC_FALLBACKS_ARBITRUM: (process.env.RPC_FALLBACKS_ARBITRUM || '').split(',').map(s => s.trim()).filter(Boolean),
  RPC_FALLBACKS_BASE: (process.env.RPC_FALLBACKS_BASE || '').split(',').map(s => s.trim()).filter(Boolean),`
);

c = c.replace(
`    // Select per-chain RPC URL (use explicit if set, else derive using user's key pattern for Alchemy etc.)
    // This fixes per-CHAIN_ID resolution for ETH/ARB/BASE. Multi-chain aware. Do NOT hardcode.
    let rpcUrl = this.RPC_URL;
    if (id === 42161) {
      rpcUrl = this.ARBITRUM_RPC_URL || deriveAlchemyRpc(this.RPC_URL, 'arb') || this.RPC_URL;
    } else if (id === 8453) {
      rpcUrl = this.BASE_RPC_URL || deriveAlchemyRpc(this.RPC_URL, 'base') || this.RPC_URL;
    }`,
`    // Select per-chain RPC URL (use explicit if set, else derive using user's key pattern for Alchemy etc.)
    // This fixes per-CHAIN_ID resolution for ETH/ARB/BASE. Multi-chain aware. Do NOT hardcode.
    let rpcUrl = this.RPC_URL;
    let rpcFallbacks = this.RPC_FALLBACKS;
    if (id === 42161) {
      rpcUrl = this.ARBITRUM_RPC_URL || deriveAlchemyRpc(this.RPC_URL, 'arb') || this.RPC_URL;
      rpcFallbacks = this.RPC_FALLBACKS_ARBITRUM.length > 0 
        ? this.RPC_FALLBACKS_ARBITRUM 
        : this.RPC_FALLBACKS.map(f => deriveAlchemyRpc(f, 'arb'));
    } else if (id === 8453) {
      rpcUrl = this.BASE_RPC_URL || deriveAlchemyRpc(this.RPC_URL, 'base') || this.RPC_URL;
      rpcFallbacks = this.RPC_FALLBACKS_BASE.length > 0 
        ? this.RPC_FALLBACKS_BASE 
        : this.RPC_FALLBACKS.map(f => deriveAlchemyRpc(f, 'base'));
    }`
);

c = c.replace(
`      CHAIN_ID: id,
      IS_L2: isL2,
      RPC_URL: rpcUrl,
      UNISWAP_QUOTER_V2: addrs.UNISWAP_QUOTER_V2,
      UNISWAP_FEE_TIERS: this.UNISWAP_FEE_TIERS,`,
`      CHAIN_ID: id,
      IS_L2: isL2,
      RPC_URL: rpcUrl,
      RPC_FALLBACKS: rpcFallbacks,
      UNISWAP_QUOTER_V2: addrs.UNISWAP_QUOTER_V2,
      UNISWAP_FEE_TIERS: this.UNISWAP_FEE_TIERS,`
);

fs.writeFileSync(p, c);
console.log('patched config.ts');
