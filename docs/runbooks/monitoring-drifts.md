# Runbook: Monitoring Drifts + Reconciliation

**For:** prod-001.17 closeout. Preserves 0-RPC + advanced engine per AGENTS.md.

## How Reconciliation Works
- In `bot/src/monitor.ts`: startReconciliationLoop (interval from config.RECONCILIATION_INTERVAL_MS).
- Compares: in-memory state + DB + subgraph snapshot vs on-chain (via Feeder).
- Tolerances (config):
  - RECONCILIATION_HF_TOLERANCE
  - RECONCILIATION_COL_DEBT_TOLERANCE
- On drift > tol: log + persist to DB drifts table + console alert + health.
- Enhanced (3.11): includes DB drifts; explicit injected-drift TDD test in hybridSync.test.ts / execution harness.

## Running + Watching
- Default log: `reconciliation.log` (config.RECONCILIATION_LOG_FILE).
- Structured: enable STRUCTURED_LOG.
- Heartbeat: periodic in monitor (includes driftCount, lastBlock).
- Command (while bot runs):
  ```bash
  tail -f reconciliation.log
  # or grep for 'DRIFT|drift|alert'
  ```

## TDD / Verification
- `bot/test/hybridSync.test.ts` + `execution.test.ts` have "injected drift > tol triggers alert".
- Run golden: `CHAIN_ID=1 npx ts-node bot/test/GoldenTest.ts` (includes recon mocks).
- Inject test drift via DB or memory to validate.

## Multi-Chain
- Per CHAIN_ID (1+8453 verified).
- L2: tighter timing (faster blocks); adjust RECONCILIATION_* via env.
- Subgraph lag common source of "drift" - events are truth.

## Alerts / Ops
- Watch for: "🚨 MISSED", "drift", "WARNING: actual profit negative".
- From executor: profit delta vs ticket.netProfitBase (post gas).
- If recurring drift: check Feeder/rpc lag, price_index update, subgraph staleness. Mark dirty user.
- DB table: drifts (chain_id, ts, user, source, diff fields).

## Go-Live
- Before live: run with DRY, force recon with known positions.
- Post live tx: verify actuals from LiquidationExecuted event match modeled (see enrich* in executor.ts).

Cross-refs: monitor.ts (recon loop), db.ts (drifts), config.ts, plan.md (Task 2.4/3.11), AGENTS "reconciliation / drift detection".

Run:
```bash
npm run check
CHAIN_ID=8453 npx ts-node bot/test/execution.test.ts | grep -i drift
```

Last updated: 2026-07-01 (prod-001.17)
