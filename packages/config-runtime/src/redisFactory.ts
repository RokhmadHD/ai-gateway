import { Redis, type RedisOptions } from "ioredis";

/**
 * Minimal Redis-like surface used by the proxy for rotation cursors.
 * Implemented by ioredis but declared here so consumers don't need to
 * depend on ioredis directly.
 */
export interface CursorRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: string, listener: (err: unknown) => void): unknown;
  connect(): Promise<void>;
}

/** Create a Redis client from URL. Lazily connected — caller must `.connect()`. */
export function createRedisClient(url: string, opts: RedisOptions = {}): CursorRedis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    ...opts,
  });
  return client as unknown as CursorRedis;
}
