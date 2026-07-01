import "mocha";
import { expect } from "chai";
import { AlertManager } from "../src/alerting";
import { config } from "../src/config";

describe("AlertManager", () => {
  let originalFetch: any;
  let fetchCalls = 0;

  before(() => {
    originalFetch = global.fetch;
    global.fetch = async (url: any, options: any) => {
      fetchCalls++;
      return { ok: true } as any;
    };
  });

  after(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchCalls = 0;
    (AlertManager as any).lastAlertTime = 0;
  });

  it("should not send if no webhook URL", async () => {
    const originalUrl = config.ALERT_WEBHOOK_URL;
    (config as any).ALERT_WEBHOOK_URL = "";
    await AlertManager.sendAlert("ERROR", "test", {});
    expect(fetchCalls).to.equal(0);
    (config as any).ALERT_WEBHOOK_URL = originalUrl;
  });

  it("should send alert if webhook URL is configured", async () => {
    const originalUrl = config.ALERT_WEBHOOK_URL;
    (config as any).ALERT_WEBHOOK_URL = "http://mock.webhook";
    await AlertManager.sendAlert("ERROR", "test alert", {});
    expect(fetchCalls).to.equal(1);
    
    // rate limit test
    await AlertManager.sendAlert("ERROR", "test alert 2", {});
    expect(fetchCalls).to.equal(1);

    (config as any).ALERT_WEBHOOK_URL = originalUrl;
  });
});
