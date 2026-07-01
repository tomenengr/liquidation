# Aave V3 Liquidation Bot

High-performance, 0-RPC Aave V3 liquidation bot with real Quoter verification, MEV modeling, and full multi-chain support (Ethereum + Arbitrum + Base).

## Features

- **0-RPC Engine**: Pure BigInt recreation of Aave math (Close Factor, bonuses, indices, stable debt interest).
- **Advanced State Sync**: Monitor with dirty-user refetch, reconciliation, and price/index updates.
- **Opportunity Engine**: Granular per-asset debt/collateral calculation + profit filtering.
- **Execution Router**: Multi fee-tier Uniswap V3 Quoter + gas modeling + builder bribe.
- **Multi-Chain**: Fully configurable via `CHAIN_ID` (1, 42161, 8453). Addresses from @bgd-labs/aave-address-book.
- **Safety**: ReentrancyGuard, SafeERC20, dynamic amountOutMinimum, approval hygiene.
- **Testing**: E2E on Anvil forks, Golden tests vs on-chain, secrets hygiene checks.

## Quick Start (Local Anvil)

```bash
# 1. Install deps
npm install

# 2. Copy env
cp .env.example .env
# Edit .env (use default PRIVATE_KEY for Anvil #0)

# 3. Start Anvil (in another terminal)
anvil

# 4. Build contracts
forge build

# 5. Run E2E (simulates price crash + full pipeline)
npx ts-node bot/src/e2e.ts
```

## Multi-Chain Usage

Set environment variables:

```bash
CHAIN_ID=8453                    # 1=Ethereum, 42161=Arbitrum, 8453=Base
RPC_URL=https://your-rpc-url     # WSS recommended for production
```

Run production entry:

```bash
npx ts-node bot/src/index.ts
```

Or use monitor directly for advanced state sync:

```bash
npx ts-node bot/src/monitor.ts   # (Anvil demo by default)
```

Entry points now use hybrid/DB/subgraph for users (no hardcoded USERS; see AGENTS.md + Problem 4 fix):
- Production: `npx ts-node bot/src/index.ts`
- E2E sim: `npx ts-node bot/src/PriceTrigger.ts` (respects CHAIN_ID for addresses)

### Chain-Specific Thresholds & Config

Lower thresholds on L2 (cheap gas):

- Mainnet: ~$500 debt / $50 profit
- L2: ~$100 debt / $10 profit

All chain-specific values (Quoter, WETH, mins, gas) come from `config.getChainConfig()` + `addresses.ts`.

## Architecture

```
monitor.ts (state + listeners, hybrid subgraph+DB+events)
    ↓ (coldstart/dirty)
calculateUserAccountData (0-RPC math, HF/col/debt)
    ↓
calculateOptimalLiquidation + filterOpportunities (Stage 1: opp)
    ↓
ExecutionRouter.verifyAndRoute (QuoterV2 + gas + bribe; Stage 2: ticket)
    ↓ (if profitable)
LiquidationExecutor.execute (signed tx / deploy/attach; post-tx accounting)  (Stage 3)
    ↓ (if !dry)
MevBundleSubmitter (real/sim; Flashbots ETH, L2 tip fallback)  (MEV)
    ↓
on-chain liquidation + profit
```

See flow diagram (mermaid) below for full incl real exec+MEV.

**Full Flow (Mermaid):**

```mermaid
flowchart TD
    A[monitor.ts: coldStart + dirty listeners + recon] --> B[0-RPC: calculateUserAccountData + profit calc]
    B --> C[Stage 1: calculateOptimalLiquidation + filterOpportunities]
    C --> D[Stage 2: ExecutionRouter.verifyAndRoute\nreal Quoter + gas + bribe\n→ ticket.isProfitable?]
    D -->|yes| E[Stage 3: LiquidationExecutor.execute\nconfig-driven, DRY gate, signed tx\nparse LiquidationExecuted + actuals]
    E --> F{MOCK_MEV or DRY?}
    F -->|sim/dry| G[MevBundleSubmitter: sim + retry logging]
    F -->|real| H[Real MEV: Flashbots relay (ETH) or L2 priority tx]
    G --> I[post-tx: DB update, recon, log]
    H --> I
    I --> J[health heartbeat + opp log]
    style B fill:#e0f2fe
    style D fill:#fef3c7
    style E fill:#dcfce7
```

See:
- `bot/src/monitor.ts` - advanced state sync (hybrid DB/subgraph)
- `bot/src/index.ts` and `bot/src/PriceTrigger.ts` - now fully use hybrid/DB/subgraph discovery (no static USERS lists; config-driven multi-chain)
- `bot/src/engine/calculateUserAccountData.ts` - math
- `bot/src/profitCalculator.ts` - opportunity discovery
- `bot/src/ExecutionRouter.ts` - verification
- `bot/src/config.ts` + `addresses.ts` - multi-chain
- `bot/src/executor.ts` - real exec
- `bot/src/mevBundle.ts` - bundle (sim + real start)

**Real Quoter vs MOCK:**
- Default: real QuoterV2 (via RPC_URL or derived per CHAIN_ID using your Alchemy key pattern). Works on live RPC or Anvil `--fork-url $RPC` (Quoter present in fork).
- Set `MOCK_QUOTER=true` only for no-RPC unit tests or calc-only runs (bypasses real verification).
- See ExecutionRouter + config comments. For multi-chain (Base/Arbitrum), ensure your Alchemy key/app has the network enabled (dashboard.alchemy.com).

## Environment Variables

See `.env.example` for full list.

Key ones:
- `CHAIN_ID`
- `RPC_URL` (WSS for prod)
- `PRIVATE_KEY` (never hardcode)
- `MIN_DEBT_BASE` / `MIN_NET_PROFIT_BASE` (override per chain)

## Testing

```bash
# Unit / golden (requires fork or Anvil with state)
npx ts-node bot/test/GoldenTest.ts

# Secrets hygiene
npm run secrets-check

# Addresses
npm run addresses-check

# Forge tests (with fork)
npm run test:mainnet
npm run test:arbitrum
npm run test:base
```

Golden tests compare TS 0-RPC output vs on-chain `getUserAccountData`.

## Security Notes

- Never commit real private keys (`.env` is gitignored).
- All approvals are force-reset after use.
- AmountOutMinimum protects against sandwich.
- Reconciliation loop detects math drift.

## Development

See `task.md` and `walkthrough.md` for current status and next steps.

Follow Superpowers methodology:
- Brainstorm → write plans → TDD → review

## License

MIT (as per original template + project).

## Running in Production

1. Set secure `RPC_URL` (WSS) and `PRIVATE_KEY` (via secrets manager). Never commit.
2. Choose `CHAIN_ID` (1/42161/8453). All via `config.getChainConfig(CHAIN_ID)` + `getAddresses`.
3. (Optional) Set `DRY_RUN_EXECUTION=false` + fund liquidator wallet only after testing. Default=true (safe).
4. Run `npx ts-node bot/src/index.ts` (or pm2/systemd wrapped).
5. Monitor: reconciliation.log, opportunities.log, health (if extended), stderr for drifts/alerts.

**3-Chain Quickstart (production hints):**
- Ethereum (1): higher MIN_* thresholds; use Flashbots for MEV (prod-002).
- Arbitrum (42161) / Base (8453): lower mins (~$100 debt / $10 profit); use high-priority fee or L2 builder tx (graceful fallback to public mempool).
- Always test first with `CHAIN_ID=8453 DRY_RUN_EXECUTION=true MOCK_QUOTER=true npx ts-node bot/src/PriceTrigger.ts` or execution harness.
- Subgraph: set GRAPH_API_KEY for real discovery (hosted).

**Production Checklist (post prod-001):**
- [ ] All npm run check / secrets-check / addresses-check pass.
- [ ] Golden + execution harness green on target chain (1 + at least 8453).
- [ ] DRY_RUN_EXECUTION=true first; profitable fork E2E run (receipt + profit>0) before live.
- [ ] Fund executor via `fundAnvilWallet` (Anvil) or prod faucet/bridge (min gas + buffer).
- [ ] Recon tolerance set; DB persists; subgraph enabled.
- [ ] Private key in secure env/secret store; no .env in git.
- [ ] Review runbooks below before go-live.
- [ ] Real MEV only after prod-002 complete + bundle sim vs landed verified.

**Runbooks Hints:** See `docs/runbooks/` (funding-liquidator.md, monitoring-drifts.md, go-live-warnings.md). Created in 001.17.

For real MEV: prod-002 (Flashbots ETH + L2 direct/priority). See plan.md.