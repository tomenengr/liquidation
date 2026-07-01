/// <reference types="mocha" />
/// <reference types="node" />
import { expect } from 'chai';
import { HealthServer } from '../src/health';
import * as http from 'http';
import { setupGracefulShutdown } from '../src/shutdown';

describe('Graceful Shutdown & HealthServer', () => {
  let healthServer: HealthServer;
  const port = 8081;

  beforeEach(async () => {
    healthServer = new HealthServer(port);
    await healthServer.start();
  });

  afterEach(async () => {
    await healthServer.stop();
  });

  it('should return 200 OK by default', (done) => {
    http.get(`http://localhost:${port}/health`, (res: any) => {
      expect(res.statusCode).to.equal(200);
      done();
    });
  });

  it('should return 503 after being marked for shutdown', (done) => {
    healthServer.setShuttingDown();
    http.get(`http://localhost:${port}/health`, (res: any) => {
      expect(res.statusCode).to.equal(503);
      done();
    });
  });
});
