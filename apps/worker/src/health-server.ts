import { createServer, type Server } from 'node:http';
import { observability } from '@growth-agent/services';
import { logger } from './logger.js';
import { connection } from './queues.js';
import { WORKER_ID, jobCounters } from './observability.js';

/**
 * A tiny HTTP listener so an orchestrator (k8s, compose healthcheck) can probe
 * the worker, and a Prometheus scraper can read its metrics. `/healthz` is 200
 * when Redis is reachable, 503 otherwise; `/metrics` is the in-process registry.
 */
export function startHealthServer(port = Number(process.env.WORKER_HEALTH_PORT ?? 9090)): Server {
  const bootAt = Date.now();

  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url.startsWith('/healthz') || url === '/') {
      const redisReady = connection.status === 'ready';
      const body = JSON.stringify({
        status: redisReady ? 'ok' : 'degraded',
        worker: WORKER_ID,
        redis: connection.status,
        uptimeSec: Math.round((Date.now() - bootAt) / 1000),
        jobs: jobCounters(),
      });
      res.writeHead(redisReady ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (url.startsWith('/metrics')) {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(observability.renderProm());
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });

  server.listen(port, () => logger.info({ port }, 'worker health server listening'));
  server.on('error', (err) => logger.error({ err: err.message }, 'worker health server error'));
  return server;
}
