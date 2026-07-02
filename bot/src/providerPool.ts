import { ethers } from 'ethers';

/**
 * Creates a robust provider pool with automatic failover.
 * Wraps ethers.FallbackProvider for ethers v6.
 * It assigns priority to providers in the order they are passed,
 * ensuring the primary RPC is preferred.
 *
 * Key design decisions:
 * - quorum=1: Accept the FIRST successful response from ANY provider.
 *   This prevents "quorum not met" errors when free-tier nodes (Infura/Alchemy)
 *   return rate-limit errors (-32005 / -32016) alongside a successful response.
 * - stallTimeout: Primary gets a tight 1500ms window; fallbacks get progressively
 *   longer timeouts so the pool races them in priority order without blocking.
 */
export function createProviderPool(primaryUrl: string, fallbackUrls: string[] = []): ethers.Provider {
  const urls = [primaryUrl, ...fallbackUrls].filter(u => u && u.trim() !== '');
  
  if (urls.length === 0) {
    throw new Error('No RPC URLs provided to provider pool');
  }

  // If only one URL, return a standard JsonRpcProvider to save overhead
  if (urls.length === 1) {
    return new ethers.JsonRpcProvider(urls[0]);
  }

  const providers = urls.map((url, index) => {
    return {
      provider: new ethers.JsonRpcProvider(url),
      // priority: lower number = higher priority. primary (index=0) gets priority 1.
      priority: index + 1,
      // weight=1 for all; quorum=1 so weight only affects tie-breaking
      weight: 1,
      // Primary: tight 1500ms. Each fallback: +1s, max 6s.
      // This lets FallbackProvider race providers in priority order and skip slow/rate-limited ones.
      stallTimeout: Math.min(1500 + index * 1000, 6000),
    };
  });

  // quorum=1: any single successful response is accepted immediately.
  // This is the CRITICAL setting — without it, FallbackProvider requires quorum
  // responses to agree, which fails when some providers return rate-limit errors.
  return new ethers.FallbackProvider(providers, undefined, { quorum: 1 });
}

/**
 * Custom error handler to determine if an error is transient and should trigger manual failover
 * if we were building a manual wrapper. FallbackProvider handles most of this natively.
 */
export function isTransientError(err: any): boolean {
  if (!err) return false;
  const msg = err.message || err.toString();
  return (
    msg.includes('rate limit') || 
    msg.includes('429') || 
    msg.includes('timeout') || 
    msg.includes('500') || 
    msg.includes('502') || 
    msg.includes('503') || 
    msg.includes('504') ||
    msg.includes('could not detect network') ||
    msg.includes('network error') ||
    msg.includes('ECONNRESET') ||
    err.code === 'NETWORK_ERROR' ||
    err.code === 'TIMEOUT' ||
    err.code === 'SERVER_ERROR'
  );
}
