import { expect } from 'chai';
import { NonceManager } from '../src/nonceManager';
import { OpportunityCache } from '../src/dedup';
import { ethers } from 'ethers';

describe('NonceManager', () => {
    let mockProvider: any;
    let getTransactionCountCallCount = 0;

    beforeEach(() => {
        getTransactionCountCallCount = 0;
        mockProvider = {
            getTransactionCount: async (address: string, tag: string) => {
                getTransactionCountCallCount++;
                return 10;
            }
        };
    });

    it('should fetch nonce from provider on first call', async () => {
        const manager = new NonceManager(mockProvider as ethers.Provider, '0x123');
        const nonce = await manager.getNonce();
        expect(nonce).to.equal(10);
        expect(getTransactionCountCallCount).to.equal(1);
    });

    it('should cache nonce on subsequent calls', async () => {
        const manager = new NonceManager(mockProvider as ethers.Provider, '0x123');
        await manager.getNonce();
        const nonce2 = await manager.getNonce();
        expect(nonce2).to.equal(10);
        expect(getTransactionCountCallCount).to.equal(1);
    });

    it('should force fetch when requested', async () => {
        const manager = new NonceManager(mockProvider as ethers.Provider, '0x123');
        await manager.getNonce();
        await manager.getNonce(true);
        expect(getTransactionCountCallCount).to.equal(2);
    });

    it('should increment nonce correctly', async () => {
        const manager = new NonceManager(mockProvider as ethers.Provider, '0x123');
        const nonce1 = await manager.getAndIncrementNonce();
        const nonce2 = await manager.getNonce();
        expect(nonce1).to.equal(10);
        expect(nonce2).to.equal(11);
        expect(getTransactionCountCallCount).to.equal(1);
    });
});

describe('OpportunityCache (Dedup)', () => {
    let cache: OpportunityCache;

    beforeEach(() => {
        cache = new OpportunityCache(50); // 50ms TTL for testing
    });

    it('should return false for new opportunities and add to cache', () => {
        const result = cache.isRecentlyProcessed('user1', 'asset1');
        expect(result).to.be.false;
    });

    it('should return true for recently processed opportunities', () => {
        cache.isRecentlyProcessed('user1', 'asset1');
        const result = cache.isRecentlyProcessed('user1', 'asset1');
        expect(result).to.be.true;
    });

    it('should handle different users/assets independently', () => {
        cache.isRecentlyProcessed('user1', 'asset1');
        const result = cache.isRecentlyProcessed('user2', 'asset1');
        expect(result).to.be.false;
    });

    it('should expire entries after TTL', async () => {
        cache.isRecentlyProcessed('user1', 'asset1');
        await new Promise(resolve => setTimeout(resolve, 60));
        const result = cache.isRecentlyProcessed('user1', 'asset1');
        expect(result).to.be.false;
    });

    it('should allow manual clearing of entries', () => {
        cache.isRecentlyProcessed('user1', 'asset1');
        cache.clearEntry('user1', 'asset1');
        const result = cache.isRecentlyProcessed('user1', 'asset1');
        expect(result).to.be.false;
    });
});
