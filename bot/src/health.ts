import * as http from 'http';

export const MEMORY_CRITICAL_THRESHOLD_MB = 500;

export function isMemoryCritical(): boolean {
  const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;
  return heapUsedMB > MEMORY_CRITICAL_THRESHOLD_MB;
}

export class HealthServer {
  private port: number;
  private server: http.Server | null = null;
  private metrics: Record<string, any> = {};
  public isShuttingDown: boolean = false;

  constructor(port: number) {
    this.port = port;
  }

  public recordMetric(key: string, value: any) {
    this.metrics[key] = value;
  }

  public setShuttingDown() {
    this.isShuttingDown = true;
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          if (this.isShuttingDown) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'shutting_down', timestamp: Date.now() }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
          }
        } else if (req.method === 'GET' && req.url === '/metrics') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.metrics));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
