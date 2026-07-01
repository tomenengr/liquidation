import { config } from "./config";

export class AlertManager {
  private static lastAlertTime: number = 0;
  private static readonly RATE_LIMIT_MS = 10000;

  public static async sendAlert(level: string, message: string, meta?: any) {
    const webhookUrl = config.getChainConfig().ALERT_WEBHOOK_URL || config.ALERT_WEBHOOK_URL;
    if (!webhookUrl) return;

    const now = Date.now();
    if (now - this.lastAlertTime < this.RATE_LIMIT_MS) {
      return;
    }
    
    this.lastAlertTime = now;

    try {
      const payload = {
        level,
        message,
        meta,
        timestamp: new Date().toISOString()
      };

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e: any) {
      console.error("[AlertManager] Failed to send alert:", e.message);
    }
  }
}
