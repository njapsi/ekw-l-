/**
 * A single, lazily-connected Redis client used only for observability reads
 * (health ping + BullMQ queue introspection) from the web process. The worker
 * keeps its own connection for running jobs.
 */
import { Redis } from 'ioredis';

let client: Redis | undefined;

export function getObservabilityRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3_000,
      retryStrategy: () => null,
    });
    // ioredis emits 'error' on an unreachable server; swallow so it does not
    // become an unhandled exception — callers see the failure via pingRedis().
    client.on('error', () => undefined);
  }
  return client;
}

export interface RedisPing {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function pingRedis(timeoutMs = 2_500): Promise<RedisPing> {
  const redis = getObservabilityRedis();
  const started = Date.now();
  try {
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect().catch(() => undefined);
    }
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs),
      ),
    ]);
    return { ok: pong === 'PONG', latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closeObservabilityRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = undefined;
  }
}
