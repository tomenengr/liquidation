import { HealthServer } from './health';

export function setupGracefulShutdown(healthServer: HealthServer, drainWaitMs: number = 5000, callbacks: (() => Promise<void>)[] = []) {
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}. Initiating graceful shutdown...`);
    healthServer.setShuttingDown();
    console.log(`[Shutdown] Health endpoint marked as 503. Waiting ${drainWaitMs}ms for connections to drain...`);
    
    setTimeout(async () => {
      console.log('[Shutdown] Drain period complete. Running cleanup callbacks...');
      try {
        for (const cb of callbacks) {
          await cb();
        }
        console.log('[Shutdown] Cleanup complete. Exiting.');
        process.exit(0);
      } catch (err) {
        console.error('[Shutdown] Error during cleanup:', err);
        process.exit(1);
      }
    }, drainWaitMs);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
