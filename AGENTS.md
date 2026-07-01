# AGENTS.md - Instructions for AI Coding Agents

This file provides guidance for agents (like Grok, Claude, Cursor, etc.) working on this liquidation bot.

## Core Principles (Superpowers)

- Always follow the approved design in `docs/superpowers/specs/2026-06-30-liquidation-bot-comprehensive-audit-design.md`
- Use the implementation plan: `docs/superpowers/plans/2026-06-30-liquidation-improvement-plan.md`
- Prioritize Critical → High → Medium tasks in order.
- Every change must be:
  1. TDD (write failing test first when possible)
  2. Multi-chain aware (test on at least Ethereum + one L2)
  3. Preserve the 0-RPC advantage
  4. Use centralized config (`config.ts` + `addresses.ts`)

## Architecture You Must Follow

- **State Management**: `bot/src/monitor.ts` (cold start, dirty refetch, reconciliation, listeners)
- **0-RPC Math**: `bot/src/engine/calculateUserAccountData.ts`
- **Opportunity Discovery**: `calculateOptimalLiquidation` + `filterOpportunities` in `profitCalculator.ts`
- **Verification**: `ExecutionRouter.verifyAndRoute` (real Quoter + gas + bribe when RPC provided + !MOCK_QUOTER; see config for key pattern derive)
- **Clear Flow**: Opportunity → Ticket → Execution Decision (3 explicit stages)
- **Entry Points**:
  - Production: `bot/src/index.ts`
  - Advanced demo: `bot/src/monitor.ts`
  - E2E simulation: `bot/src/e2e.ts` / `bot/src/PriceTrigger.ts`

## Multi-Chain Rules

- Always use `config.getAddresses(chainId)` or `config.getChainConfig(chainId)`
- Supported chains: 1 (Ethereum), 42161 (Arbitrum), 8453 (Base)
- When writing code, consider L2 differences (lower thresholds, different gas, different Quoter)
- Test changes with `CHAIN_ID=8453` (or 42161) when possible

## What You Must NOT Do

- Hardcode addresses (POOL, Quoter, WETH, etc.)
- Hardcode private keys
- Bypass the advanced engine (use direct HF checks only for simple cases)
- Ignore reconciliation / drift detection
- Write code that only works on mainnet

## Recommended Workflow

1. Read the current spec + plan
2. Run relevant checks: `npm run check`, `npm run secrets-check`, `npm run addresses-check`
3. Make change using TDD
4. Verify on at least one L2 config
5. Update docs (README, AGENTS.md, task.md) if behavior changes
6. Run golden tests + reconciliation

## Useful Commands

```bash
npm run check                    # TypeScript
npm run secrets-check
npm run addresses-check
npx ts-node bot/src/index.ts     # Production entry (needs RPC)
forge test --fork-url $RPC       # Contract tests
```

## When in Doubt

- Ask: "Does this preserve the 0-RPC + advanced engine flow?"
- Prefer composition over duplication (use monitor/calc/router)
- Make configuration the source of truth

Last updated: 2026-07-01 (after completing Problem 5 / 3.12 + prod-001 full 17 subtasks via 001.17 closeout: execution wiring + profitable fork E2E (1+8453) + docs (plan/task/README/runbooks/mermaid) + checks/golden. prod-002 MEV start (mevBundle real/sim TDD + config). All TDD + multi-chain + 0-RPC + config verified.)

## Prod Phase Notes (post 3.12 / 001.17)
- prod-001 complete: real exec (executor, dry gate), wiring to monitor/index, fork E2E profitable, funding helper.
- prod-002 start: real MEV in mevBundle.ts (Flashbots ETH, L2 direct priority + MOCK fallback). Add MOCK_MEV to config. TDD required.
- Always follow: Opportunity → Ticket → Execution (executor post profitable) → (cond) bundle.
- Docs: update README with checklist; runbooks in docs/runbooks/ for funding/drifts/go-live.
- Before any prod code: run `npm run check`, secrets/addresses-check, golden on 1+8453.
- For MEV changes: test real vs sim paths on at least 1+8453.