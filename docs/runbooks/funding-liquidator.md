# Runbook: Funding the Liquidator (Anvil + Prod)

**Status:** Created for prod-001.17 closeout. Follows AGENTS.md (config-driven, no hardcodes, multi-chain).

## Anvil / Fork (test)
- Use `fundAnvilWallet` helper (exported from `bot/src/executor.ts`).
- Called internally in execution harness (bot/test/execution.test.ts) and e2e refactor (001.13).
- Example: `await fundAnvilWallet(provider, walletAddress, 10n * 10n**18n);` (uses anvil_setBalance).
- Detects anvil via url/clientVersion (no chain hardcode).
- Safe no-op on non-anvil (returns false).

## Production / Live
- Fund the executor wallet (from `config.getExecutorWallet()` or PRIVATE_KEY) with ETH on target chain for gas.
- Amount: min 0.05-0.2 ETH mainnet (higher for safety + multiple tx); lower on L2 (cheap gas).
- Use per-chain: `CHAIN_ID=8453` + derived RPC.
- **NEVER fund with real funds until DRY_RUN_EXECUTION=true tests + profitable E2E pass on fork with same CHAIN_ID.**
- Liquidator contract (if pre-deploy): fund separately if it holds tokens, but executor pays gas.
- For FlashLiquidator deploy (if no LIQUIDATOR_ADDRESS_*): deployer=owner must have gas; contract is stateless for funds (flashloan model).

## Multi-Chain Notes
- L2 (Base 8453, Arb 42161): lower gas, use getChainConfig().MIN_* + IS_L2.
- Ethereum: higher gas volatility; consider priority for MEV later.
- Always: `npm run addresses-check`, `CHAIN_ID=... npx ts-node bot/test/execution.test.ts`

## Warnings
- Insufficient gas = tx fail (no profit, gas waste).
- After live txs: monitor actualGasWei vs modeled in executor enrich.
- Use secrets for keys; see .env.example.

Cross-ref: executor.ts (fundAnvilWallet + getLiquidator), config.ts (getExecutor*), README prod checklist, plan.md prod-001.13/16.

Run verification:
```bash
CHAIN_ID=8453 DRY_RUN_EXECUTION=true npx ts-node bot/test/execution.test.ts
```

Last updated: 2026-07-01 (prod-001.17)
