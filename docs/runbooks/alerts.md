# Alerts & Monitoring Runbook

This runbook outlines how to configure, receive, and respond to alerts from the bot.

## Webhook Alerts
The bot is equipped with a lightweight `AlertManager` that can post to Slack, Discord, or generic Webhooks.
To enable it:
1. Set `ALERT_WEBHOOK_URL` in your `.env` to a valid Slack/Discord/custom webhook.
2. The bot will automatically send JSON payloads when critical events occur.

## Alert Types and Responses

### 1. `CRITICAL_DRIFT` (Reconciliation Alert)
- **Condition**: The off-chain computed health factor or debt deviates from the true on-chain state beyond `RECONCILIATION_HF_TOLERANCE`.
- **Impact**: The bot might attempt invalid liquidations or miss profitable ones.
- **Action**: Check RPC sync status. The bot will auto-mark the user as dirty and refetch their state to heal the drift. If the error persists, investigate the `calculateUserAccountData` logic.

### 2. `CRITICAL_DB_DRIFT`
- **Condition**: The local SQLite DB state is drastically out of sync with the EVM state.
- **Impact**: Filtering logic might fail to load at-risk users into memory.
- **Action**: A restart of the bot will trigger a `coldStart` full sync. Consider deleting the DB file to force a fresh pull from the Subgraph.

### 3. `RPC_FAILOVER` / `CIRCUIT_OPEN`
- **Condition**: The primary RPC or a critical API (like the Subgraph) has failed repeatedly.
- **Impact**: The bot relies on fallbacks or degraded logic. Profitability might be reduced due to missed events.
- **Action**: Review your API quotas. Check the status pages of your RPC providers.

### 4. `EXECUTION_FAILED`
- **Condition**: A real liquidation transaction or MEV bundle failed on-chain or timed out.
- **Impact**: Wasted gas fees (if not reverted early) and missed profit.
- **Action**: Analyze the `bot.log` or the transaction hash. Ensure gas parameters (`BASE_GAS_LIMIT`, slippage) are calibrated correctly for the current network conditions.
