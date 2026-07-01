import { describe, it } from 'mocha';
import { expect } from 'chai';
import { validateStartup } from '../src/startup';

describe('Startup Validation', () => {
  it('should pass with valid dry-run configuration', () => {
    const mockConfig = {
      CHAIN_ID: 1,
      RPC_URL: 'http://localhost:8545',
      DRY_RUN_EXECUTION: true,
      MOCK_MEV: true,
    };
    expect(() => validateStartup(mockConfig as any)).to.not.throw();
  });

  it('should throw if RPC_URL is missing', () => {
    const mockConfig = {
      CHAIN_ID: 1,
      RPC_URL: '',
      DRY_RUN_EXECUTION: true,
      MOCK_MEV: true,
    };
    expect(() => validateStartup(mockConfig as any)).to.throw(/RPC_URL is missing/);
  });

  it('should throw if CHAIN_ID is unsupported', () => {
    const mockConfig = {
      CHAIN_ID: 999,
      RPC_URL: 'http://localhost:8545',
      DRY_RUN_EXECUTION: true,
      MOCK_MEV: true,
    };
    expect(() => validateStartup(mockConfig as any)).to.throw(/Unsupported CHAIN_ID/);
  });

  it('should throw if DRY_RUN_EXECUTION is false but PRIVATE_KEY is missing', () => {
    const mockConfig = {
      CHAIN_ID: 1,
      RPC_URL: 'http://localhost:8545',
      DRY_RUN_EXECUTION: false,
      PRIVATE_KEY: '',
      MOCK_MEV: true,
    };
    expect(() => validateStartup(mockConfig as any)).to.throw(/PRIVATE_KEY is missing/);
  });

  it('should pass if DRY_RUN_EXECUTION is false and PRIVATE_KEY is present', () => {
    const mockConfig = {
      CHAIN_ID: 1,
      RPC_URL: 'http://localhost:8545',
      DRY_RUN_EXECUTION: false,
      PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      MOCK_MEV: true,
    };
    expect(() => validateStartup(mockConfig as any)).to.not.throw();
  });

  it('should throw if MOCK_MEV is false and MEV_RELAY_URL is missing on Ethereum', () => {
    const mockConfig = {
      CHAIN_ID: 1,
      RPC_URL: 'http://localhost:8545',
      DRY_RUN_EXECUTION: true,
      MOCK_MEV: false,
      MEV_RELAY_URL: '',
    };
    expect(() => validateStartup(mockConfig as any)).to.throw(/MEV_RELAY_URL is missing/);
  });
});
