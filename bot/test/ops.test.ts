/// <reference types="mocha" />
/// <reference types="node" />
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { Logger, LogLevel } from '../src/logger';
import { HealthServer } from '../src/health';

describe('Ops & Resilience (prod-003)', () => {
  const testLogFile = path.join(__dirname, 'test.log');

  afterEach(() => {
    if (fs.existsSync(testLogFile)) {
      fs.unlinkSync(testLogFile);
    }
  });

  describe('Logger', () => {
    it('should write logs to file with correct format', () => {
      const logger = new Logger({ level: LogLevel.DEBUG, file: testLogFile, console: false });
      logger.info('Test info message', { x: 1 });
      logger.error('Test error message', new Error('test err'));

      const content = fs.readFileSync(testLogFile, 'utf8');
      expect(content).to.include('Test info message');
      expect(content).to.include('Test error message');
      expect(content).to.include('test err');
      expect(content).to.include('"x":1');
      expect(content).to.include('INFO');
      expect(content).to.include('ERROR');
    });

    it('should respect log levels', () => {
      const logger = new Logger({ level: LogLevel.WARN, file: testLogFile, console: false });
      logger.debug('This should not be logged');
      logger.info('This should not be logged either');
      logger.warn('This is a warning');

      const content = fs.readFileSync(testLogFile, 'utf8');
      expect(content).to.not.include('This should not be logged');
      expect(content).to.include('This is a warning');
      expect(content).to.include('WARN');
    });
  });

  describe('Health Server', () => {
    let healthServer: HealthServer;
    const port = 18080;

    before(async () => {
      healthServer = new HealthServer(port);
      await healthServer.start();
    });

    after(async () => {
      await healthServer.stop();
    });

    function fetchHttp(url: string): Promise<{ status: number, body: any }> {
      return new Promise((resolve, reject) => {
        http.get(url, (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => data += chunk);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
            } catch (e) {
              resolve({ status: res.statusCode || 500, body: data });
            }
          });
        }).on('error', reject);
      });
    }

    it('should return 200 OK on /health', async () => {
      const res = await fetchHttp(`http://127.0.0.1:${port}/health`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('status', 'ok');
    });

    it('should return metrics on /metrics', async () => {
      healthServer.recordMetric('test_metric', 42);
      const res = await fetchHttp(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('test_metric', 42);
    });
  });
});
