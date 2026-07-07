/**
 * Redis-backed KV client for the DataStore.
 * Production persistence — replaces InMemoryKV when REDIS_URL is set.
 *
 * ioredis is lazily loaded (same pattern as the toolkit's session storage).
 */

import { createRequire } from "node:module";
import type { KVClient } from "./store.js";

export class RedisKV implements KVClient {
  private readonly prefix: string;
  private client: ReturnType<typeof _loadRedis> | null = null;

  constructor(
    private readonly url: string,
    prefix = "reminder:",
  ) {
    this.prefix = prefix;
  }

  private _client(): ReturnType<typeof _loadRedis> {
    if (!this.client) {
      const Redis = _loadRedis();
      this.client = new Redis(this.url, {
        maxRetriesPerRequest: null,
        lazyConnect: false,
      });
    }
    return this.client;
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async get(key: string): Promise<string | null> {
    const val = await this._client().get(this.k(key));
    return val ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this._client().set(this.k(key), value);
  }

  async del(key: string): Promise<void> {
    await this._client().del(this.k(key));
  }
}

function _loadRedis(): new (url: string, opts: Record<string, unknown>) => {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
} {
  const require = createRequire(import.meta.url);
  const ioredis: unknown = require("ioredis");
  const Redis =
    (ioredis as Record<string, unknown>).default ??
    (ioredis as Record<string, unknown>).Redis ??
    ioredis;
  return Redis as never;
}

/**
 * Resolve a KV client: if REDIS_URL is set, return a RedisKV instance;
 * otherwise null (caller falls back to InMemoryKV).
 */
export function resolveKV(env: { REDIS_URL?: string } = process.env): KVClient | null {
  if (env.REDIS_URL) return new RedisKV(env.REDIS_URL);
  return null;
}