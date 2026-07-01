/// <reference types="mocha" />
import { expect } from 'chai';
import { CircuitBreaker, CircuitState, CircuitOpenError } from '../src/circuitBreaker';

describe('CircuitBreaker', () => {
  it('should execute successfully when closed', async () => {
    const cb = new CircuitBreaker(3, 1000);
    const result = await cb.execute(async () => 'success');
    expect(result).to.equal('success');
    expect(cb.state).to.equal(CircuitState.CLOSED);
  });

  it('should transition to OPEN after max errors', async () => {
    const cb = new CircuitBreaker(2, 1000);
    const failingFn = async () => { throw new Error('fail'); };

    try { await cb.execute(failingFn); } catch (e) {}
    expect(cb.state).to.equal(CircuitState.CLOSED);

    try { await cb.execute(failingFn); } catch (e) {}
    expect(cb.state).to.equal(CircuitState.OPEN);
  });

  it('should throw CircuitOpenError when OPEN', async () => {
    const cb = new CircuitBreaker(1, 10000);
    const failingFn = async () => { throw new Error('fail'); };

    try { await cb.execute(failingFn); } catch (e) {}
    expect(cb.state).to.equal(CircuitState.OPEN);

    let caughtError;
    try {
      await cb.execute(async () => 'success');
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError).to.be.instanceOf(CircuitOpenError);
  });

  it('should transition to HALF_OPEN after timeout and then to CLOSED on success', async () => {
    const cb = new CircuitBreaker(1, 10);
    const failingFn = async () => { throw new Error('fail'); };

    try { await cb.execute(failingFn); } catch (e) {}
    expect(cb.state).to.equal(CircuitState.OPEN);

    await new Promise(r => setTimeout(r, 15));

    const result = await cb.execute(async () => 'success');
    expect(result).to.equal('success');
    expect(cb.state).to.equal(CircuitState.CLOSED);
  });

  it('should transition to OPEN if HALF_OPEN execution fails', async () => {
    const cb = new CircuitBreaker(1, 10);
    const failingFn = async () => { throw new Error('fail'); };

    try { await cb.execute(failingFn); } catch (e) {}
    expect(cb.state).to.equal(CircuitState.OPEN);

    await new Promise(r => setTimeout(r, 15));

    try { await cb.execute(failingFn); } catch (e) {}
    expect(cb.state).to.equal(CircuitState.OPEN);
  });
});
