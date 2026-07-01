# Runbook: Go-Live Warnings (Production Readiness)

**Created:** prod-001.17 (Docs/Plan Closeout). Read before setting DRY_RUN_EXECUTION=false.

## Pre-Flight (MUST)
1. `npm run check && npm run secrets-check && npm run addresses-check` — ALL GREEN.
2. Golden + harness: `CHAIN_ID=1 ...` and `CHAIN_ID=8453 ...` (MOCK+DRY) pass. Verify profitable fork path (001.16) asserts receipt + profit>0.
3. Full E2E on target fork (Anvil --fork-url yourRpc): hybrid load + price crash finds liq using real subgraph/DB + router ticket + executor (even if dry).
4. Review prod checklist in README.md.
5. Reconciliation clean on real-ish state (no injected drifts > tol).
6. Fund test wallet first (see funding-liquidator.md); verify gas accounting in executor.

## Critical Risks (from design spec)
- **Key Compromise:** Owner/executor has full control. Use hardware/secret manager. DRY first.
- **Math Drift:** 0-RPC vs on-chain can cause bad tickets or missed liqs. Recon + golden mandatory.
- **Bad Ticket (revert/loss):** Always MOCK_QUOTER=false for verify (real Quoter). amountOutMinimum protects.
- **L2 Differences:** Lower thresholds/gas; different Quoter behavior (enable network in Alchemy). Test 8453 explicitly.
- **Subgraph Lag:** Events + Feeder = truth. Subgraph for discovery only. Monitor drifts.
- **MEV Competition:** Bribe modeled (BRIBE_PERCENT); real bundles (prod-002) required for inclusion on ETH.
- **Gas/Profit Delta:** Actuals < modeled -> MISSED logs. Watch negative profit warnings.

## Live Switch
- Set `DRY_RUN_EXECUTION=false` ONLY after all above + profitable real-tx fork E2E (with live-like RPC).
- `LIQUIDATOR_ADDRESS_*` optional (else auto-deploy on first exec - costs gas).
- Start with small profitable cases (use config MIN_*).
- Use WSS RPC for monitor listeners.
- Wrap with supervisor (pm2, systemd, docker restart).

## Monitoring Post-Live
- See monitoring-drifts.md.
- Logs: [LiquidationExecutor] 🚀 LIVE, actual vs ticket, pureBonus.
- Watch for reverts: dust, slippage, close factor, bad debt/collateral.
- Health: add /health if prod-003; tail opp + recon logs.
- Post tx: DB update + recon trigger (001.08).

## Rollback / Emergency
- Set DRY_RUN_EXECUTION=true immediately (env reload or restart).
- Revoke approvals if contract holds (but flash model minimizes).
- Transfer ownership only via secure means (contract has onlyOwner).
- Kill switch: stop process; on-chain liq may still compete.

## Multi-Chain Go-Live Order (rec)
- Validate 8453 (L2 cheap, lower stakes) first.
- Then 1 (mainnet MEV critical).
- Use separate instances / DB per chain (bot-${CHAIN}.db).

## Prod-002 Note (MEV)
- Real MEV not yet: current is sim + post-executor conditional. Do not rely on inclusion until bundles real.
- Flashbots only for ETH; L2 use priority or direct.

## References
- AGENTS.md: "Does this preserve 0-RPC + advanced engine flow?"
- plan.md prod-001/002/005
- config.ts (all gates), executor.ts, monitor.ts, ExecutionRouter.ts
- .env.example (DRY, keys)

**Decision Matrix (is production-ready?):**
- All checks/golden/recon pass on 1+8453? Y/N
- Profitable E2E receipt+profit on fork? Y/N
- DRY gate tested + fund verified? Y/N
- Runbooks read? Y/N
- Only proceed to live if ALL Y + risk owner signoff.

Last updated: 2026-07-01 (prod-001.17)
