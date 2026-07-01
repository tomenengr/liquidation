/// <reference types="mocha" />
import { expect } from 'chai';
import * as sinon from 'sinon';
import { CircuitBreaker, CircuitState, CircuitOpenError } from '../src/circuitBreaker';
import { createProviderPool, isTransientError } from '../src/providerPool';
import { ethers } from 'ethers';
import { dirtyUsers } from '../src/monitor';

describe('Resilience Scenario Tests (prod-003.15)', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('CircuitBreaker under severe latency / 502 Bad Gateway', () => {
    it('should open the circuit after max consecutive errors and prevent further calls', async () => {
      const cb = new CircuitBreaker(3, 1000); // max 3 errors
      const rpcCall = sinon.stub();
      rpcCall.rejects(new Error('502 Bad Gateway'));

      for (let i = 0; i < 3; i++) {
        try {
          await cb.execute(rpcCall);
        } catch (e) {}
      }

      expect(cb.state).to.equal(CircuitState.OPEN);

      let caughtError;
      try {
        await cb.execute(rpcCall);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).to.be.instanceOf(CircuitOpenError);
      expect(rpcCall.callCount).to.equal(3); // The 4th call was blocked by the CircuitBreaker
    });

    it('should handle timeout/latency by rejecting and eventually opening', async () => {
      const cb = new CircuitBreaker(2, 1000);
      const slowRpcCall = sinon.stub().callsFake(async () => {
        throw new Error('timeout');
      });

      try { await cb.execute(slowRpcCall); } catch (e) {}
      try { await cb.execute(slowRpcCall); } catch (e) {}

      expect(cb.state).to.equal(CircuitState.OPEN);
      expect(slowRpcCall.callCount).to.equal(2);
    });
  });

  describe('FallbackProvider with failing endpoints', () => {
    it('should successfully create a FallbackProvider and identify transient errors', () => {
      const provider = createProviderPool('http://localhost:8545', ['http://localhost:8546']);
      expect(provider).to.be.instanceOf(ethers.FallbackProvider);

      expect(isTransientError(new Error('502 Bad Gateway'))).to.be.true;
      expect(isTransientError(new Error('timeout'))).to.be.true;
      expect(isTransientError(new Error('ECONNRESET'))).to.be.true;
      expect(isTransientError(new Error('execution reverted'))).to.be.false;
    });

    it('should not crash when initializing FallbackProvider', () => {
      expect(() => {
        createProviderPool('http://rpc.primary', ['http://rpc.fallback']);
      }).to.not.throw();
    });
  });

  describe('Auto-Dirty Logic', () => {
    it('should be able to add and delete users from the dirty set without crashing', () => {
      const mockUser = '0x1234567890123456789012345678901234567890';
      
      // Ensure it doesn't crash
      expect(() => {
        dirtyUsers.add(mockUser);
      }).to.not.throw();
      
      expect(dirtyUsers.has(mockUser)).to.be.true;
      
      expect(() => {
        dirtyUsers.delete(mockUser);
      }).to.not.throw();
      
      expect(dirtyUsers.has(mockUser)).to.be.false;
    });
  });
});
