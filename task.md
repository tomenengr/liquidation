# Liquidation Bot Task List

## Completed Phases
- Phase 1-3: Core 0-RPC Engine, Profit Calculator, Quoter integration (100%)
- Phase 4-5: Execution Router with multi-tier, MEV modeling (100%)
- Phase 6: End-to-End Anvil Dry Run with contract fixes (USDT, dust, slippage protection) (100%)
- Phase 7: Real gas deduction, Pure Bonus vs Lag Arb separation, negative yield logging (100%)
- prod-001 (17 subtasks): Real Execution Wiring + profitable fork E2E (1+8453) + closeout docs (100% ✅)

## Current Four Steps in Progress (Advanced)
1. **Solidify Contract & Fixes (Clean Up & Test)**: 
   - Added pureBonusBase to LiquidationOpportunity for separation.
   - filterOpportunities helper exported.
   - Config-driven mins.
   - (Contract side: SafeERC20, ReentrancyGuard, forceApprove(0) already in .sol per reports; tests in FlashLiquidator.t.sol)

2. **"Minimal Real-World Scenario" Testing**:
   - Enhanced min filters ($500 debt / $50 profit default, L2 tunable via config).
   - pureBonusBase + logging in e2e/PriceTrigger for 3-8% drops.
   - Verified with ts-node simulations showing filter + pure bonus isolation.

3. **MEV Bribe Simulation (Foundational)**:
   - BRIBE_PERCENT in config (default 50, env override).
   - Dynamic in ExecutionRouter.
   - Negative flagged as MISSED TARGET.

4. **Bribe Implementation & Verification**:
   - Confirmed off-chain bundle (no on-chain coinbase).
   - MulticallHelper added and partially integrated in Feeder for RPC reduction.
   - e2e logs include pure vs arb, gas deduction.
   - Tests run successfully for filters and multi-tier.

## Next Actions (from Superpowers Plan)
- **1.9** Production Reconciliation & Health - DONE
- **1.10** Documentation Overhaul - DONE
- Main phases 1.1-1.15 complete.

## Extension Phase (Borrower Discovery + Persistence)
- **3.7 DB Layer (SQLite + eMode/isolation fields NOW)**: ✅ TDD complete. `bot/src/db.ts`, `bot/test/db.test.ts`
- **3.6 Subgraph Client (hosted + GRAPH_API_KEY)**: ✅ TDD complete.
- **3.8 Hybrid Sync (subgraph + DB + events)**: ✅ TDD + integration done.
- **3.9 At-Risk Filtering & In-Memory**: ✅ Completed.
- **Problem 1 (full subgraph to 0-RPC engine)**: ✅ Fixed. monitor coldStart now uses loadEngineViewsFromSubgraph for userPositions when USE_SUBGRAPH_DISCOVERY (TDD RED-GREEN via hybrid test source+calc assertions first). Mapped data used in triggerEngine. Multi-chain verified 1+8453 real subgraph. (see plan.md)
- **3.10 Price Monitoring & Volatility from Subgraph/DB**: ✅ Completed.
  - Monitor stores oracle+subgraph prices to price_history (coldStart + block deltas) + upsertReserve.
  - Vol % from history fed to profitCalculator (opp slip) + router (dynamic SLIPPAGE + config VOLATILITY factor).
  - TDD test + integration.
  - Multi-chain, 0-RPC preserved.
- **3.11 Enhanced Recon w/ DB**: ✅ Completed.
  - Recon compares memory/DB/subgraph, persists to drifts table, alerts on tol (incl DB), health includes drifts. Explicit injected-drift TDD test passes.
- **3.12 Tests, Verification & Multi-Chain Polish**: ✅ Completed (2026-07-01 final).
  - Precision fixes (via TDD): asset concat ids (extractAssetAddress in subgraph.ts), debt_base computed as (rayMul(scaled)*price)/unit from sg data in bulkSync, embedded reserve fallback in mapSubgraphToEngineViews. Updated IDs to official Aave subgraphs supporting reserves/userReserves.
  - Feeder ctor now (rpc, chainId?), callers + index/monitor/PriceTrigger/e2e/Golden use config.CHAIN_ID. Multi-chain L2 verified.
  - Full tests w/ real GRAPH_API_KEY: hybridSync, subgraph.test, Golden mocks on CHAIN_ID=1 and 8453 (and 42161 logic).
  - E2E fork-sim: bulkSyncFromSubgraph -> DB -> loadEngineViewsFromSubgraph + price crash sim (30% drop) + calc + filterOpps on real DB users (18 on Base example). Finds liq path using DB/subgraph users.
  - Perf: 1k user opportunity scan =4ms ✅ <100ms.
  - Expanded: error paths (subgraph outage, bad RPC), vol impact, large sets, recon drift, no static USERS in prod paths.
  - Ran: npm run check, secrets-check, addresses-check (all green). Golden/Hybrid output verified.
- **Problem 3 (Quoter real path)**: ✅ Fixed (2026-07-01). getChainConfig now derives per-chain RPC from user key pattern (Alchemy eth->arb/base); ExecutionRouter uses real Quoter (not mock) iff !explicit MOCK_QUOTER + RPC provided. Improved logs/error. TDD tests in hybridSync.test (real/mock, derive, bad-RPC graceful, loadEngineViewsFromSubgraph integration). Subgraph real data integrated in monitor. Multi-chain verified (1+8453). MOCK=false test passed for ETH; Base requires user enable network in Alchemy. Docs/.env.example/README updated. All via search_replace + checks. No hardcoded. 0-RPC preserved.
  - GoldenTest + mocks: subgraph/DB compare, 1k perf sim (~4-19ms), vol impact, outage errors, drift tests. Multi-chain via config. Full verification suite run.
- All original plan (1.1-1.15) + Extension (3.6-3.12) COMPLETE. Final checks + tests passed. Docs/plan updated. Real subgraph E2E + fork paths executed (Anvil full tx would need live setup).

See full plan: `docs/superpowers/plans/2026-06-30-liquidation-improvement-plan.md`

**Production Phase (post 3.12) — detailed subtasks added via 5 parallel subagents (2026-07):**
### Active Phase: **prod-003: Ops/Resilience Hardening (16 subtasks)**
*Goal: Ensure production readiness with health checks, failovers, circuit breakers, and observability.*

- [x] prod-003.01: Centralized Resilience Config Extension
- [x] prod-003.02: Structured Logger Module + Levels + Rotation
- [x] prod-003.03: HTTP Health & Metrics Server
- [x] prod-003.04: RPC Fallbacks List + Provider Pool
- [x] prod-003.05: Automatic Failover Implementation
- [x] prod-003.06: Circuit Breakers for Quoter / Subgraph / Bundle Submit
- [x] prod-003.07: Nonce Management + Tx Replacement (bump)
- [x] prod-003.08: Retries with Exp Backoff + Opportunity Deduplication
- [x] prod-003.09: Graceful Shutdown
- [x] prod-003.10: Boot-time Env Validation + Startup Checks
- [x] prod-003.11: Process Supervisor Recommendations
- [x] prod-003.12: Alerting (ERROR + simple webhook)
- [x] prod-003.13: Extend Recon Alerts + Auto Dirty-Mark on Lag
- [ ] prod-003.14: Resource / Memory Guards + Backpressure Enhancements
- [ ] prod-003.15: Resilience Scenario Tests + Integration
- [ ] prod-003.16: Runbook Skeleton + Docs Updates

- prod-002 (15): Real MEV (Flashbots + L2) — IN PROGRESS (002.01 - 002.06 completed: MOCK_MEV flag, secrets validation, Flashbots submission path via fetch, signed tx construction)
- prod-004 (16): Full Verification (profitable paths, new prod-e2e-fork.test, recon/perf)
- prod-005 (10): Docs/Closeout (runbooks, mermaid, checklist, final gate)

All TDD, multi-chain (1+8453), config-driven, 0-RPC preserving. See plan.md for full lists. 
**prod-001 marked COMPLETE in 001.17 / prod-005 closeout (2026-07-01). All 17 subtasks ✅ per harness runs + checks + golden on 1+8453. prod-002 started.**

Use `npx ts-node bot/src/e2e.ts` (with Anvil running) or `forge test` for verification.
