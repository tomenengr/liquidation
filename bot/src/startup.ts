import { BotConfig } from './config';

export function validateStartup(cfg: Partial<ReturnType<BotConfig['getChainConfig']>>) {
  if (!cfg.CHAIN_ID || ![1, 42161, 8453].includes(cfg.CHAIN_ID)) {
    throw new Error(`Unsupported CHAIN_ID: ${cfg.CHAIN_ID}`);
  }

  if (!cfg.RPC_URL) {
    throw new Error('RPC_URL is missing');
  }

  if (cfg.DRY_RUN_EXECUTION === false) {
    if (!cfg.PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY is missing but DRY_RUN_EXECUTION is false. Cannot execute real transactions.');
    }
  }

  if (cfg.MOCK_MEV === false) {
    // On Ethereum, Flashbots requires MEV_RELAY_URL
    if (cfg.CHAIN_ID === 1 && !cfg.MEV_RELAY_URL) {
      throw new Error('MEV_RELAY_URL is missing. Required for Flashbots on Ethereum when MOCK_MEV is false.');
    }
    // On L2, maybe check if we want anything else, but MEV_RELAY_URL can be optional if direct tipping is used.
  }
}
