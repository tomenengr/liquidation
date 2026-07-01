import { ethers } from 'ethers';

/**
 * NonceManager tracks and caches the nonce for a given wallet address.
 * It helps in submitting multiple transactions or replacements (bumping fees)
 * without fetching from the RPC each time.
 */
export class NonceManager {
    private nonce: number | null = null;

    constructor(private provider: ethers.Provider, private address: string) {}

    /**
     * Fetches the current nonce, caching it for subsequent calls.
     */
    async getNonce(forceFetch: boolean = false): Promise<number> {
        if (this.nonce === null || forceFetch) {
            this.nonce = await this.provider.getTransactionCount(this.address, 'pending');
        }
        return this.nonce;
    }

    /**
     * Returns the next nonce and increments the internal cache.
     * Useful for submitting consecutive transactions.
     */
    async getAndIncrementNonce(): Promise<number> {
        const current = await this.getNonce();
        this.nonce = current + 1;
        return current;
    }

    /**
     * Increments the nonce (useful after successful submission).
     */
    incrementNonce() {
        if (this.nonce !== null) {
            this.nonce++;
        }
    }

    /**
     * Replaces the current nonce (e.g. for replacement transactions)
     */
    setNonce(newNonce: number) {
        this.nonce = newNonce;
    }
}
