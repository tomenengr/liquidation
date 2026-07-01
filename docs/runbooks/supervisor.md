# Supervisor Runbook

This runbook details how to run the liquidation bot using a process supervisor like PM2 or systemd.

## Using PM2 (Recommended for Node.js)

PM2 is a production process manager for Node.js applications with a built-in load balancer.

### Setup
1. Install PM2 globally:
   ```bash
   npm install pm2@latest -g
   ```
2. The project contains an `ecosystem.config.js` file pre-configured for the bot.

### Running the Bot
To start the bot in production mode on Ethereum Mainnet:
```bash
pm2 start ecosystem.config.js --env production
```

To start on Arbitrum:
```bash
pm2 start ecosystem.config.js --env arbitrum
```

To start on Base:
```bash
pm2 start ecosystem.config.js --env base
```

### Management Commands
- Check status: `pm2 status`
- View logs: `pm2 logs liquidation-bot`
- Restart bot: `pm2 restart liquidation-bot`
- Stop bot: `pm2 stop liquidation-bot`
- Delete from PM2: `pm2 delete liquidation-bot`

### Persistence Across Reboots
To ensure PM2 restarts the bot when the server reboots:
```bash
pm2 startup
pm2 save
```

## Using Systemd (Alternative)

If you prefer using native Linux systemd, you can create a service file.

1. Create a file at `/etc/systemd/system/liquidation-bot.service` with the following content (replace paths and user):
   ```ini
   [Unit]
   Description=Liquidation Bot
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/path/to/liquidation-bot
   ExecStart=/usr/bin/npm run e2e:eth
   Restart=on-failure
   RestartSec=5
   Environment=NODE_ENV=production
   Environment=CHAIN_ID=1
   # Add your RPC URLs and secrets here or load from .env

   [Install]
   WantedBy=multi-user.target
   ```

2. Enable and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable liquidation-bot
   sudo systemctl start liquidation-bot
   ```

3. View logs:
   ```bash
   journalctl -u liquidation-bot -f
   ```
