import "mocha";
import { expect } from 'chai';
import { isMemoryCritical } from '../src/health';

describe('Memory Guard', () => {
  it('should detect when memory is critical', () => {
    const isCritical = isMemoryCritical();
    expect(typeof isCritical).to.equal('boolean');
    // For a normal test run, it should not be critical immediately
    expect(isCritical).to.be.false;
  });
});
