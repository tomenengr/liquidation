# Resilience & Operations Runbook

The liquidation bot is designed to handle network instability, API rate limits, and transient errors gracefully. This runbook details the ops architecture and resilience features.

## Health Check & Metrics Port
The bot exposes an HTTP server (default port `8080`) that provides readiness and liveness endpoints. 
- `/health`: Returns a `200 OK` status with system health summary if the bot is running normally, or a `503` if there are critical errors.
- `/metrics`: (Optional) Prom-compatible metrics for scraping by Prometheus.
You can monitor this with tools like Datadog, UptimeRobot, or Kubernetes probes.

## Circuit Breakers
To prevent cascading failures or aggressive retry storms, the bot uses `CircuitBreaker` logic:
- **Quoter & Subgraph**: If these endpoints return 502/503 or timeout repeatedly, the circuit breaker opens, pausing requests to them for a cooling period (default 30 seconds).
- **Bundle Submit**: Failed MEV bundle submissions trigger backoff logic.
Configure the threshold using `CIRCUIT_BREAKER_MAX_ERRORS` in `.env` (default is 5).

## RPC Fallbacks (Provider Pool)
The bot uses an intelligent `FallbackProvider` pool:
- Configure multiple RPCs by setting `RPC_FALLBACKS` (comma-separated URLs).
- Transient errors (e.g., rate limits, HTTP 429, timeouts) automatically trigger a failover to the next available provider.
- `Auto-Dirty` Logic: If a user is marked "dirty" due to a blockchain event (e.g., Borrow, Repay), the bot refetches their state immediately using the robust provider pool without crashing on rate limits.

## Memory Guards & Backpressure
- Only users categorized as "at-risk" are loaded into the primary memory engine via DB queries.
- `BACKPRESSURE_MAX_PER_BLOCK`: Limits how many recalculations or full state syncs are executed in a single block to prevent OOM (Out Of Memory) issues.

## Process Supervisor
We strongly recommend running the bot via PM2 or Systemd to ensure it automatically restarts on fatal errors. See the [supervisor.md](./supervisor.md) runbook.
