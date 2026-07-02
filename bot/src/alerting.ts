import { config } from "./config";

// ─── 告警级别 ───────────────────────────────────────────────────────────────
export enum AlertLevel {
  INFO     = 'INFO',
  WARN     = 'WARN',
  ERROR    = 'ERROR',
  CRITICAL = 'CRITICAL',  // 不限流，立即发
  SUCCESS  = 'SUCCESS',   // 清算成功，不限流
}

// 每个级别的最小发送间隔 (ms)，CRITICAL/SUCCESS 为 0 = 不限流
const RATE_LIMIT_MS: Record<AlertLevel, number> = {
  [AlertLevel.INFO]:     60_000,   // 1 分钟
  [AlertLevel.WARN]:     30_000,   // 30 秒
  [AlertLevel.ERROR]:    10_000,   // 10 秒
  [AlertLevel.CRITICAL]:      0,   // 不限流
  [AlertLevel.SUCCESS]:       0,   // 不限流
};

// 级别对应的 emoji
const EMOJI: Record<AlertLevel, string> = {
  [AlertLevel.INFO]:     'ℹ️',
  [AlertLevel.WARN]:     '⚠️',
  [AlertLevel.ERROR]:    '❌',
  [AlertLevel.CRITICAL]: '🚨',
  [AlertLevel.SUCCESS]:  '💰',
};

// ─── AlertManager ──────────────────────────────────────────────────────────
export class AlertManager {
  /** per-level 最后发送时间戳 */
  private static lastSent: Partial<Record<AlertLevel, number>> = {};

  /**
   * 发送告警。同时向 Webhook 和 Telegram 发送（二者独立，任一失败不影响另一个）。
   * @param level   告警级别（AlertLevel 枚举）
   * @param message 一行摘要文本
   * @param meta    可选附加 KV（会格式化进消息）
   */
  public static async sendAlert(level: string, message: string, meta?: any): Promise<void> {
    const lvl = (level as AlertLevel) in RATE_LIMIT_MS
      ? (level as AlertLevel)
      : AlertLevel.INFO;

    // 分级限流检查
    const rateMs = RATE_LIMIT_MS[lvl];
    if (rateMs > 0) {
      const last = this.lastSent[lvl] ?? 0;
      if (Date.now() - last < rateMs) return;
    }
    this.lastSent[lvl] = Date.now();

    // 并行发送（互不阻塞）
    await Promise.allSettled([
      this._sendWebhook(lvl, message, meta),
      this._sendTelegram(lvl, message, meta),
    ]);
  }

  // ── 内部：Webhook（Slack / Discord / 飞书通用格式）─────────────────────
  private static async _sendWebhook(level: AlertLevel, message: string, meta?: any): Promise<void> {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL || config.ALERT_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level,
          emoji: EMOJI[level],
          message,
          meta,
          chainId: config.CHAIN_ID,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (e: any) {
      console.error('[AlertManager] Webhook send failed:', e.message);
    }
  }

  // ── 内部：Telegram Bot API (使用 Node.js 内置 https，支持 HTTPS_PROXY) ──────
  private static async _sendTelegram(level: AlertLevel, message: string, meta?: any): Promise<void> {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const chainName = AlertManager._chainName(config.CHAIN_ID);

    // 构建格式化消息（MarkdownV2）
    let text = `${EMOJI[level]} *\\[${AlertManager._esc(chainName)}\\] ${AlertManager._esc(level)}*\n`;
    text += `▸ ${AlertManager._esc(message)}\n`;

    if (meta && typeof meta === 'object') {
      for (const [k, v] of Object.entries(meta)) {
        if (v === undefined || v === null) continue;
        const val = typeof v === 'bigint' ? v.toString() : String(v);
        text += `  • *${AlertManager._esc(k)}*: \`${AlertManager._esc(val)}\`\n`;
      }
    }

    text += `_${AlertManager._esc(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}_`;

    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_notification: level === AlertLevel.INFO,
    });

    try {
      await AlertManager._httpsPost(
        `https://api.telegram.org/bot${token}/sendMessage`,
        body,
      );
    } catch (e: any) {
      console.error('[AlertManager] Telegram send failed:', e.message);
    }
  }

  /**
   * 内置 https POST，自动读取 HTTPS_PROXY / https_proxy 环境变量走代理。
   * Node.js 22 内置 fetch 不读代理环境变量，需要手动实现。
   */
  private static _httpsPost(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const https = require('https') as typeof import('https');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const http  = require('http')  as typeof import('http');
      const { URL } = require('url');

      const target  = new URL(url);
      const proxy   = process.env.HTTPS_PROXY || process.env.https_proxy || '';

      const doRequest = (agent?: import('http').Agent) => {
        const opts: import('https').RequestOptions = {
          hostname: target.hostname,
          port:     target.port || 443,
          path:     target.pathname + target.search,
          method:   'POST',
          headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          agent,
        };
        const req = https.request(opts, (res) => {
          let data = '';
          res.on('data', (c: string) => { data += c; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              console.error(`[AlertManager] Telegram HTTP ${res.statusCode}:`, data);
            }
            resolve(data);
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      };

      if (!proxy) {
        doRequest(); // 无代理，直连
        return;
      }

      // 通过 HTTP CONNECT 隧道走代理
      const proxyUrl  = new URL(proxy);
      const connectReq = http.request({
        hostname: proxyUrl.hostname,
        port:     Number(proxyUrl.port) || 80,
        method:   'CONNECT',
        path:     `${target.hostname}:443`,
      });
      connectReq.on('connect', (_res: any, socket: any) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const tls = require('tls');
        const tlsSocket = tls.connect({ host: target.hostname, socket, rejectUnauthorized: true }, () => {
          const opts: import('https').RequestOptions = {
            hostname: target.hostname,
            port:     443,
            path:     target.pathname + target.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            createConnection: () => tlsSocket,
          };
          const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', (c: string) => { data += c; });
            res.on('end', () => {
              if (res.statusCode && res.statusCode >= 400) {
                console.error(`[AlertManager] Telegram HTTP ${res.statusCode}:`, data);
              }
              resolve(data);
            });
          });
          req.on('error', reject);
          req.write(body);
          req.end();
        });
        tlsSocket.on('error', reject);
      });
      connectReq.on('error', reject);
      connectReq.end();
    });
  }


  // ── 工具方法 ────────────────────────────────────────────────────────────

  /** MarkdownV2 转义（必须转义的特殊字符） */
  private static _esc(s: string): string {
    return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
  }

  private static _chainName(chainId: number): string {
    const names: Record<number, string> = { 1: 'Ethereum', 42161: 'Arbitrum', 8453: 'Base' };
    return names[chainId] ?? `Chain-${chainId}`;
  }
}
