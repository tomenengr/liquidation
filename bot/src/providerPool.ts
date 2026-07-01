import { ethers } from 'ethers';

/**
 * Creates a robust provider pool with automatic failover.
 * Wraps ethers.FallbackProvider for ethers v6.
 * It assigns priority to providers in the order they are passed,
 * ensuring the primary RPC is preferred.
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
      // priority: lower number = higher priority. primary gets 1.
      priority: index + 1,
      weight: 1,
      stallTimeout: 1500 + (index * 500) // Increase stall timeout for fallbacks
    };
  });

  // Quorum 1 means we accept the first successful response
  return new ethers.FallbackProvider(providers);
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
