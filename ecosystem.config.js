module.exports = {
  apps: [{
    name: "liquidation-bot",
    script: "./node_modules/.bin/ts-node",
    args: "bot/src/index.ts",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    log_date_format: "YYYY-MM-DD HH:mm Z",
    error_file: "logs/err.log",
    out_file: "logs/out.log",
    merge_logs: true,
    env: {
      NODE_ENV: "development",
      CHAIN_ID: 1,
      MOCK_QUOTER: true,
      DRY_RUN_EXECUTION: true
    },
    env_production: {
      NODE_ENV: "production",
      CHAIN_ID: 1,
      MOCK_QUOTER: false,
      DRY_RUN_EXECUTION: false
    },
    env_arbitrum: {
      NODE_ENV: "production",
      CHAIN_ID: 42161,
      MOCK_QUOTER: false,
      DRY_RUN_EXECUTION: false
    },
    env_base: {
      NODE_ENV: "production",
      CHAIN_ID: 8453,
      MOCK_QUOTER: false,
      DRY_RUN_EXECUTION: false
    }
  }]
};
