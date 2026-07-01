# Liquidation Bot Walkthrough

## Overview
This bot implements a high-performance Aave V3 liquidation system with 0-RPC detection, real Quoter integration, and Anvil dry-run execution.

## Key Features (Current State)
- **0-RPC Engine**: Pure BigInt recreation of Aave math (Close Factor, bonuses, indices).
- **Granular Opportunities**: Per-asset debt/collateral in base + token units.
- **Profit Calculator**: Filters min debt/profit, pureBonusBase for lag arb separation.
- **ExecutionRouter**: Multi fee-tier Quoter calls (500/3000/10000), gas modeling,  configurable bribe %.
- **Multicall Integration**: Reduces RPC calls in Feeder for production scale.
- **Config**: Centralized, supports env + L2/chain overrides.
- **Contract**: Dynamic amountOutMinimum, poolFee, useMaxCloseFactor, SafeERC20, reentrancy, allowance reset.
- **E2E**: Simulates crashes, logs pure vs arb, real gas deduction, profit reconciliation.

## Running Tests / Simulations
- Unit: npx ts-node bot/test/WadRayMath.test.ts or similar.
- Filter/Multi-tier test: See ts-node commands in dev logs.
- Full E2E (requires Anvil): npx ts-node bot/src/e2e.ts (with 5% drop simulation and pureBonus logs).
- Contract: forge test (FlashLiquidator.t.sol covers fixes).

## Production Prep (Four Steps Advanced)
1. Contract solid: Tests + fixes done.
2. Realistic testing: 5% drops with separation enabled.
3. Bribe sim: Config-driven, off-chain.
4. Verification: Multicall, config L2, logs updated.

See task.md for checklist.

## Next (Superpowers Plan - Phase 3 Medium)
- Real MEV bundle submission (Flashbots or L2 equivalent).
- Improved live gas/slippage modeling.
- Operational features (structured logs, persistence, health).
- Expanded test coverage + WS/RPC robustness.

Multi-chain is now fully supported via CHAIN_ID.

See full plan in docs/superpowers/plans/ and AGENTS.md.
