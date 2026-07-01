# Liquidation Bot Comprehensive Audit and Improvement Design

**Date:** 2026-06-30  
**Status:** Approved. Detailed implementation plan written (see docs/superpowers/plans/2026-06-30-liquidation-improvement-plan.md). Ready for execution.  
**Process:** Created following the Superpowers `brainstorming` skill (after project exploration, context summary, approach proposal, and design presentation with approval).  
**Next formal step (after this review):** `writing-plans` skill for a detailed, task-by-task implementation plan.

## Executive Summary

This project implements a high-performance Aave V3 liquidation bot emphasizing a **0-RPC engine** (pure BigInt recreation of Aave math), real Uniswap V3 Quoter verification, MEV bribe modeling, flash-loan execution, and Anvil-based E2E dry runs.

**Strengths observed:**
- Excellent layering and "memory-first" design that preserves the 0-RPC advantage.
- Solid contract hygiene (ReentrancyGuard, SafeERC20, approval resets, dynamic `amountOutMinimum`).
- Promising state synchronization and reconciliation patterns in the monitor.
- Realistic simulation of price crashes and pure-bonus vs. arbitrage separation.

**Key risks and gaps:**
- Production readiness is incomplete (hardcoded secrets, incomplete integration of advanced engine into entry points, weak testability outside mainnet forks).
- Centralized control and key management present material fund-safety risks.
- Mathematical fidelity and boundary coverage require more rigorous differential testing.
- Documentation, configuration centralization, and operational resilience lag behind the core engine quality.

**Recommended path:** Address Critical items first (key hygiene, address unification, testability, integration), then systematically close High-priority gaps while preserving the 0-RPC core. All future changes should follow Superpowers disciplines (TDD, systematic debugging, writing-plans, code review).

This document captures the validated design of the audit and the prioritized improvement roadmap. It does **not** contain implementation code or detailed task plans.

## Project Context and Current State

### What the bot does
- Monitors Aave V3 borrowers (via events or watchlists).
- Calculates liquidation opportunities entirely or mostly off-chain using recreated Aave math.
- Validates with on-chain QuoterV2 (multi-fee-tier) + gas + bribe modeling.
- Executes via `FlashLiquidator` contract (flash-loan debt asset → liquidate → swap collateral on Uniswap V3 → repay flash-loan + profit extraction).

### Key components (explored)
- `src/FlashLiquidator.sol` — Core flash-loan + liquidation + swap contract.
- `bot/src/engine/calculateUserAccountData.ts` + `profitCalculator.ts` — 0-RPC HF, close-factor, opportunity calculation (with `pureBonusBase`).
- `bot/src/ExecutionRouter.ts` — Quoter-driven routing, gas/bribe math, final profitability gate.
- `bot/src/monitor.ts`, `Feeder.ts` (Multicall3), `PriceTrigger.ts`, `scanner.ts` — Data acquisition and triggering.
- `bot/src/e2e.ts`, `bot/test/*`, `test/FlashLiquidator.t.sol` — Simulation and testing.
- `bot/src/config.ts` — Partial env/chain support.

### Current maturity (from task.md + walkthrough.md + code + build)
- Phases 1-7 largely complete (0-RPC engine, profit calc, Quoter integration, E2E dry-runs, gas deduction, pure-bonus separation).
- Active focus: realistic scenario testing, MEV bribe simulation (off-chain), L2 prep, multicall completion.
- Build: `forge build` succeeds (minor lint). TS has compile errors. FlashLiquidator tests are mainnet-chainid gated.

## Audit Scope and Success Criteria

**In scope:**
- Architecture, data flow, and layering.
- Security and access control (contracts + bot runtime).
- Mathematical correctness and fidelity of the 0-RPC engine vs. Aave V3 rules.
- Profitability modeling, execution path, and MEV considerations.
- Testing, verification, and simulation quality.
- Operational reliability, configuration, and production readiness.
- Maintainability and documentation.

**Out of scope (unless explicitly expanded later):**
- Full Flashbots bundle implementation code.
- New DEX integrations.
- Complete rewrite or new language migration.

**Success criteria (how we know the audit + design is good):**
- All major findings are backed by specific code, test, or runtime evidence.
- Problems are risk-rated (probability × impact).
- Every recommendation includes "why it matters" and high-level suggested approach.
- The roadmap is prioritized and scoped so it can be turned into a single focused `writing-plans` output.
- The design is internally consistent, free of major ambiguity, and appropriately bounded.

## Architecture and Data Flow Assessment

**Positive patterns:**
- Strong separation: pure calculation (0-RPC) → filtering → verified execution ticket (Quoter + gas + bribe) → on-chain execution.
- Memory snapshot approach (`PriceTrigger.ts`, monitor) correctly protects the 0-RPC advantage.
- Early use of Multicall3 for scale.
- Good use of granular token + base-currency outputs to avoid dust reverts.

**Issues:**
- `bot/src/index.ts` remains an early simple listener and is not wired to the advanced engine.
- Addresses, ABIs, and constants are duplicated across files (POOL, ORACLE, SWAP_ROUTER, QUOTER, tokens, etc.).
- Dev (Anvil + hardcoded users) and production paths are not clearly separated.
- No persistent storage for discovered borrowers or executed opportunities. (Addressed via subgraph + local DB in extension).

## Extension: Subgraph + Local DB for Borrower Discovery, Price Monitoring & Persistence (Post 1.15)

**Decisions incorporated (2026-07-01 user input):**
- Hosted (managed) The Graph subgraph only.
- `GRAPH_API_KEY` in `.env` (never commit; config injects into hosted queries).
- eMode / isolation fields added **NOW** to schema/queries (e_mode_category_id, is_isolated, isolation_mode_asset, isolation_mode_total_debt, etc.).
- Other open questions follow doc recommendations: retention default 30 days; no pre-computed HF in DB (compute on load via engine); fallback = periodic top-N Feeder scan of DB high-debt users.

### Updated Schema (SQLite, per user decision + plan)
```sql
CREATE TABLE users (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  last_hf TEXT,                    -- snapshot only; compute live via engine
  total_debt_base TEXT,
  is_at_risk INTEGER DEFAULT 0,
  last_update_block INTEGER,
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE user_positions (
  chain_id INTEGER NOT NULL,
  user_address TEXT NOT NULL,
  asset TEXT NOT NULL,
  collateral_scaled TEXT,
  debt_var_scaled TEXT,
  debt_stable_scaled TEXT,
  e_mode_category_id INTEGER DEFAULT 0,   -- NOW
  is_isolated INTEGER DEFAULT 0,          -- NOW
  isolation_mode_asset TEXT,              -- NOW
  isolation_mode_total_debt TEXT DEFAULT '0', -- NOW
  PRIMARY KEY (chain_id, user_address, asset)
);

CREATE TABLE reserves (
  chain_id INTEGER NOT NULL,
  asset TEXT NOT NULL,
  price_base TEXT,
  liquidity_index TEXT,
  borrow_index TEXT,
  -- ... other config
  PRIMARY KEY (chain_id, asset)
);

CREATE TABLE price_history (
  chain_id INTEGER NOT NULL,
  asset TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price TEXT,
  source TEXT DEFAULT 'subgraph',
  block_number INTEGER,
  PRIMARY KEY (chain_id, asset, ts)
);

-- Indexes for at-risk / fast queries
CREATE INDEX IF NOT EXISTS idx_users_at_risk ON users(chain_id, is_at_risk, total_debt_base DESC);
CREATE INDEX IF NOT EXISTS idx_pos_user ON user_positions(chain_id, user_address);
```

### Updated Subgraph Queries (hosted, with eMode)
Example (GraphQL, using hosted The Graph + GRAPH_API_KEY from .env):
```graphql
query UsersWithDebt($threshold: BigDecimal!, $first: Int!, $skip: Int!, $chainSpecificFilter: ...) {
  users(
    where: { borrowedReservesCount_gte: $threshold }  # or post-filter debt
    first: $first
    skip: $skip
  ) {
    id
    userReserves {
      scaledATokenBalance
      scaledVariableDebt
      principalStableDebt
      stableRateLastUpdated
      reserve { 
        id 
        price { priceInEth }  # or assetPriceUSD
        liquidityIndex
        variableBorrowIndex
      }
    }
    # eMode / isolation where available in user or userReserve
  }
  reserves { ... }  # for prices/indices
}
```

Fetch eModeCategoryId, isIsolated, etc., where present in the schema (map to UserPositionView extensions or extra fields for future engine).

Hosted URL construction in config (injected with GRAPH_API_KEY from .env):
- Ethereum: https://api.thegraph.com/subgraphs/name/aave/protocol-v3 (or exact deployment ID)
- Similar for Arbitrum/Base (see plan for IDs).

### Hybrid Sync & Integration (as recommended)
- Startup: bulk from hosted subgraph (paginated users with debt > min) → upsert DB.
- Events: dirty → Feeder refetch (truth) + DB update.
- Periodic: delta price/reserve refresh from subgraph + history to DB.
- At-risk: query DB `WHERE is_at_risk=1 OR total_debt_base >= ?` → lazy load to memory for engine (unchanged calculate*).
- Fallback (per rec): if lag/outage, periodic top-N (e.g. 500) high-debt Feeder scan from DB.
- Price: subgraph + events → DB history (30d retention) → volatility for 1.12 models.
- Recon (enhanced): compare mem/DB vs on-chain vs subgraph snapshot; persist drifts; alerts.
- No change to 0-RPC engine or core Opportunity→Ticket→Decision.
- Config: add `GRAPH_API_KEY`, `SUBGRAPH_URLS` (hosted), `PRICE_HISTORY_RETENTION_DAYS=30`, `USE_SUBGRAPH_DISCOVERY=true` (flag for rollout).

See full details in temp design doc `/tmp/grok-design-doc-e3d7b895.md` (produced via design skill; includes Mermaid, full queries, PR plan, scale notes, TDD guidance).

**Next per Superpowers**: TDD implement (start with DB schema + hosted client in 3.7/3.6 order), test on CHAIN_ID=8453, update actual spec with this, run E2E + recon.

All user decisions incorporated exactly. Design ready for execution.
- Reconciliation exists but is demo-grade (hardcoded intervals, limited users).

**Target architecture direction:** Keep the layered model. Introduce a single source of truth for addresses/config, a clear "Trigger → Opportunity → Ticket → Execute" orchestration layer, and explicit dev/prod boundaries.

## Detailed Findings

### Security and Access Control

**Findings:**
- Contract uses simple `onlyOwner` + `transferOwnership`. Owner can execute liquidations and withdraw any token.
- `e2e.ts` contains a hardcoded Anvil default private key in source.
- Authorization hygiene in the contract is strong (forceApprove + explicit zero resets after use).
- No multi-sig, timelock, or role-based access.
- Flash-loan callback has proper caller checks, but the overall system trusts the owner EOA completely.
- No on-chain validation of Quoter output beyond `amountOutMinimum` (off-chain Quoter result is trusted for decisioning).

**Risk:** Critical (direct fund loss or theft if key is leaked or owner is compromised).

**Suggested direction:** Eliminate all secrets from source. Move execution authorization to a multi-sig or governed contract for production. Add minimum delay or explicit approval flows for large withdrawals.

### Mathematical Correctness and 0-RPC Fidelity

**Findings:**
- `WadRayMath.ts`, `PercentageMath.ts`, and `calculateUserAccountData.ts` faithfully recreate Aave formulas (scaled balances, variable + stable debt, health factor).
- `profitCalculator.ts` correctly applies close factor, theoretical seize amounts, and introduces useful `pureBonusBase`.
- Reconciliation loop in monitor compares on-chain vs. in-memory results (good discipline).
- Gaps: limited coverage of Isolation Mode, E-Mode, extreme interest accrual, and stable-rate edge cases. Tests are mostly mainnet-fork dependent.

**Risk:** High (subtle drift can cause either missed liquidations or bad execution tickets that revert or lose money).

**Suggested direction:** Add systematic differential/golden tests against live Aave state (fork + on-chain calls). Increase boundary test coverage. Keep the reconciliation loop and make its tolerance + alerting production-grade.

### Testing and Verification

**Findings:**
- E2E scripts (`e2e.ts`, `PriceTrigger.ts`) are the strongest part — they simulate realistic price drops, run the full pipeline (calc → Quoter → modeling), and log profit reconciliation.
- Unit tests exist but are sparse.
- Forge tests for the liquidator are gated behind `block.chainid == 1` and currently fail or skip in normal environments.
- TS compile is currently broken (`simulator.ts` references removed export).

**Risk:** Medium-High (inability to run tests locally/CI slows iteration and hides regressions).

**Suggested direction:** Make contract tests fork-aware or unconditionally runnable with a provided fork. Fix TS. Expand E2E coverage to more asset pairs, stable debt, and failure modes. Add CI jobs for both forge and key TS scripts.

### Profitability Modeling and Execution

**Findings:**
- `ExecutionRouter` performs real multi-fee Quoter calls, estimates gas, models builder bribe (`BRIBE_PERCENT`), and applies secondary profit filters.
- Dynamic `amountOutMinimum` (≈0.5% buffer below Quoter) is a correct anti-sandwich measure.
- Profit calc layer still uses a static 0.3% slippage estimate for early filtering (acceptable because router re-validates).
- No live bundle submission or robust failure/partial-fill handling yet.
- Gas modeling is reasonable but pessimistic/static.

**Risk:** Medium (missed profitable opportunities or over-estimated profits leading to failed bundles).

**Suggested direction:** Keep the two-stage (0-RPC fast path + verified router) model. Improve gas estimation with recent blocks or simulation. Add a real (or well-simulated) bundle submission path with clear success/failure accounting.

### Operations, Reliability, and Production Readiness

**Findings:**
- Monitor implements event-driven index updates, dirty-user refetch, debounce, and price polling on blocks (reasonable MVP).
- WebSocket usage lacks explicit reconnection, fallback RPCs, or circuit breakers.
- Config supports some L2 overrides but address/Quoter values are still duplicated and not fully driven by `getChainConfig`.
- No structured logging, metrics, alerting, or bot health heartbeat.
- `bot/config/` directory exists but is empty in the explored state.

**Risk:** High for production (silent failure, stale state, inability to operate at scale).

**Suggested direction:** Centralize configuration (addresses, thresholds, RPC endpoints). Add robust WS handling + health endpoints or periodic self-checks. Introduce structured logging and basic alerting on reconciliation drift or missed blocks.

### Maintainability, Configuration, and Documentation

**Findings:**
- `README.md` is the default Foundry boilerplate — useless for this project.
- `task.md` and `walkthrough.md` are useful internal notes but not sufficient as project documentation.
- No architecture overview, threat model, runbook, or contribution guide.
- No `docs/` directory existed before this audit process.
- Hardcoded values and duplicated ABIs reduce maintainability.

**Risk:** Medium (slow onboarding, accidental drift, difficulty handing off or scaling the project).

**Suggested direction:** Produce a real README (setup, run modes, architecture diagram, how to add assets). Centralize addresses. Adopt Superpowers practices (AGENTS.md, project rules) for future work.

## Prioritized Improvement Roadmap

### Critical (address first — direct safety or blocking issues)
1. Remove all hardcoded private keys and secrets from source code. Establish `.env.example` + secret management.
2. Unify address and configuration management (single source, driven by `config.ts` + @bgd-labs/aave-address-book) for Ethereum + Arbitrum + Base.
3. Fix TypeScript compilation errors so all scripts are runnable.
4. Make FlashLiquidator tests executable in local/CI environments (remove or make conditional the strict mainnet chainid gate; provide fork guidance).
5. Wire the advanced engine (`calculateOptimalLiquidation` + `ExecutionRouter` + `Feeder`) into a production-grade entry point (replace or evolve `index.ts`).

### High (foundation for reliable profitable operation)
6. Strengthen mathematical fidelity testing: add fork-based golden tests, expand boundary cases (stable debt, E-Mode, isolation, high interest accrual).
7. Complete monitor/PriceTrigger integration with the router and add clear "opportunity → ticket → execution decision" orchestration.
8. Centralize and harden configuration for full multi-chain support (Ethereum mainnet + Arbitrum + Base): chain-specific addresses (via @bgd-labs/aave-address-book), thresholds, Quoter, gas models, and Uniswap contracts.
9. Upgrade reconciliation to production quality (tunable tolerance, structured alerts, persistence of drift history).
10. Improve documentation: real README, architecture overview, threat model for liquidation bot, runbook for Anvil vs. production.

### Medium (scale, MEV, resilience)
11. Add real (or high-fidelity simulated) Flashbots/other builder bundle submission with proper gas/bribe accounting and retry logic.
12. Enhance gas estimation and slippage modeling using recent on-chain data or lightweight simulation.
13. Add basic operational features: structured logging, health checks, opportunity persistence, back-pressure on high-volume blocks.
14. Increase test coverage for error paths, partial fills, and multi-asset scenarios in E2E.
15. Implement robust WebSocket + RPC resilience (reconnect, multiple providers, rate-limit handling).

### Low / Future
- Visual dashboards for opportunities and bot health.
- Broader asset/universe scanning automation.
- Integration with more Superpowers skills for ongoing development (TDD, systematic-debugging, subagent-driven work).
- Formal verification or advanced static analysis on the contract (longer term).

Each item above should be expanded into concrete, small, verifiable tasks only during the `writing-plans` phase.

## Addendum: Multi-Chain Support Design (Ethereum + Arbitrum + Base)

**Requirement:** Extend the bot to simultaneously support Ethereum mainnet + Arbitrum + Base (three chains).

### Recommended Architecture
- **Single codebase with strong configuration abstraction** (not per-chain forks).
- Heavy use of `@bgd-labs/aave-address-book` (already a dependency) for all Aave V3 contracts:
  - Ethereum: Pool `0x87870Bca...`, Provider `0x2f39d218...`
  - Arbitrum: Pool `0x794a6135...`, Provider `0xa97684ea...`
  - Base: Pool `0xA238Dd80...`, Provider `0xe20fCBdB...`
- Maintain a small per-chain map (or extend `config.ts`) for Uniswap V3 contracts (SwapRouter + QuoterV2), as they are not in the Aave book.
- All data layers (Feeder, monitor, PriceTrigger, scanner) and deployment paths become chain-aware via `CHAIN_ID` + `RPC_URL`.
- The 0-RPC math engine (`calculateUserAccountData`, `profitCalculator`, WadRayMath) remains chain-agnostic.
- `FlashLiquidator` contract is already portable (accepts addresses at construction).

### Configuration Strategy
- Extend `getChainConfig()` and introduce `getAddresses(chainId)`.
- Per-chain overrides for:
  - MIN_DEBT_BASE / MIN_NET_PROFIT_BASE (aggressively lower on L2s).
  - Gas estimation base and gas price source.
  - BRIBE_PERCENT and MEV modeling (Arbitrum/Base have different priority/builder dynamics; bribe often less critical than mainnet).
  - Fee tiers and Quoter behavior.
- Runtime selection: `CHAIN_ID=1|42161|8453` + corresponding RPC (supports running separate instances per chain for isolation).

### Key Changes Required
1. Remove **all** hardcoded mainnet addresses across TS files (Feeder, monitor, e2e, PriceTrigger, tests, etc.) and deployment scripts.
2. Implement chain-aware address resolution in `config.ts` + helper module.
3. Update `ExecutionRouter` gas modeling and Quoter selection to be chain-specific.
4. Make E2E, Golden tests, and Foundry tests support multiple forks (add Arbitrum and Base RPC/fork configs).
5. Adjust reconciliation and price polling logic if oracle behavior differs.
6. Update documentation (README, runbook) with per-chain launch instructions.
7. Validate liquidation parameters (bonus, close factor) are correctly fetched dynamically per reserve (they already are in the engine).

### Trade-offs
- **Single codebase + config** (recommended): Lower long-term maintenance, easier to add more chains later (Optimism, etc.).
- Per-chain forks: Faster initial port but leads to duplication and drift — rejected.
- Scope: Start with full support for the three chains in one go. Thresholds, gas, and Quoter must be tuned per chain in the implementation phase.

### Impact on Roadmap
This requirement elevates multi-chain work:
- Item 2 (address unification) and item 8 (configuration) become the foundation for all three chains.
- New explicit Critical/High tasks will be detailed in the implementation plan for address centralization, Uniswap per-chain config, gas/MEV adaptation, and test coverage across forks.

### Risks Specific to Multi-Chain
- Incorrect addresses or Quoter on L2 can cause failed executions or bad profit calculations.
- Different MEV landscapes (especially Base) may require different bribe strategies or even no bribe in some cases.
- Gas estimation errors are more impactful on L2 due to higher frequency of small liquidations.
- Oracle/price feed differences must be validated (though dynamic fetching mitigates most of this).

This Addendum was added after user approval of the expanded design during brainstorming.

## Risks and Assumptions

**Key risks if improvements are not made:**
- Key compromise or owner mistake leads to loss of funds or missed profitable liquidations turned into losses.
- Subtle math drift causes either false negatives (missed revenue) or bad tickets (reverts + wasted gas).
- Operational fragility causes the bot to go silent during high-volatility windows (the only windows that matter).
- Poor testability leads to slow, risky changes.

**Assumptions:**
- The primary goal is a reliable, profitable production liquidation bot (not a pure research prototype) with simultaneous support for Ethereum mainnet + Arbitrum + Base.
- The 0-RPC + layered verification architecture should be preserved and strengthened across all supported chains.
- Future implementation work will follow Superpowers methodology (brainstorming → writing-plans → TDD / systematic-debugging → code review).
- User will review this spec before authorizing detailed planning or code changes.

## Validation and Next Steps

### Spec self-review (performed after multi-chain update)
- No "TBD", "TODO", or placeholders remain in core sections.
- Scope now explicitly includes simultaneous support for Ethereum + Arbitrum + Base (consistent with user requirement).
- No contradictions between sections (Addendum aligns with updated roadmap items 2 and 8).
- Ambiguities (e.g., exact per-chain bribe tuning, Uniswap address source) are intentionally left high-level — they will be resolved in planning if the user chooses to implement.
- Focus remains on audit + roadmap rather than premature design of specific code changes.
- Multi-chain design preserves the 0-RPC advantage and existing layering.

**Revision Note:** 2026-06-30 — Updated with user-approved multi-chain requirement (simultaneous support for Ethereum mainnet + Arbitrum + Base). Added dedicated Multi-Chain Design section and revised roadmap.

**This document is now written to the canonical location.**

**File:** `docs/superpowers/specs/2026-06-30-liquidation-bot-comprehensive-audit-design.md`

---

**Please review this updated spec document (includes multi-chain Addendum for Ethereum + Arbitrum + Base).**

Reply with any requested changes, questions, or explicit approval such as:

- "Looks good, proceed to writing-plans."
- "Change X and Y, then re-write the spec."
- Specific feedback on any section.

Once you approve (or after we iterate to your satisfaction), we will move to the next Superpowers step: invoking the `writing-plans` skill to produce a detailed, prioritized, verifiable implementation plan.

This disciplined approach (design first, user-validated spec, then plan) is exactly what makes Superpowers effective. Thank you for following the process.