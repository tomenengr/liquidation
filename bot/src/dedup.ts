/**
 * OpportunityCache for deduplicating liquidation attempts.
 * Prevents spamming the same (user, debtAsset) pair within a specified TTL.
 */
export class OpportunityCache {
    private cache: Map<string, number> = new Map();

    constructor(private ttlMs: number = 60000) {}

    private getKey(user: string, debtAsset: string): string {
        return `${user.toLowerCase()}-${debtAsset.toLowerCase()}`;
    }

    /**
     * Checks if the opportunity was recently processed.
     * If not, adds it to the cache and returns false.
     * If it is still in the cache (within TTL), returns true.
     */
    isRecentlyProcessed(user: string, debtAsset: string): boolean {
        const key = this.getKey(user, debtAsset);
        const now = Date.now();
        const timestamp = this.cache.get(key);

        if (timestamp && now - timestamp < this.ttlMs) {
            return true;
        }

        // Add or update the cache
        this.cache.set(key, now);
        this.cleanup();
        return false;
    }

    /**
     * Manually clear an entry (e.g. if transaction failed immediately and we want to retry)
     */
    clearEntry(user: string, debtAsset: string) {
        this.cache.delete(this.getKey(user, debtAsset));
    }

    /**
     * Clean up expired entries to prevent memory leak
     */
    private cleanup() {
        const now = Date.now();
        for (const [key, timestamp] of this.cache.entries()) {
            if (now - timestamp >= this.ttlMs) {
                this.cache.delete(key);
            }
        }
    }
}

// Global singleton for index/monitor to share
export const globalOpportunityCache = new OpportunityCache(60000); // 60s TTL
