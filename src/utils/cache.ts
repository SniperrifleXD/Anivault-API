import NodeCache from 'node-cache';

const cache = new NodeCache({ useClones: false });

const TTL = {
  mapping: parseInt(process.env.CACHE_TTL_MAPPING || '86400'),   // 24h
  episodes: parseInt(process.env.CACHE_TTL_EPISODES || '3600'),  // 1h
  stream: parseInt(process.env.CACHE_TTL_STREAM || '300'),       // 5min
};

export function cacheGet<T>(key: string): T | null {
  return cache.get<T>(key) ?? null;
}

export function cacheSet(key: string, data: any, type: keyof typeof TTL = 'mapping') {
  cache.set(key, data, TTL[type]);
}

export function cacheDel(key: string) {
  cache.del(key);
}

export function cacheStats() {
  return cache.getStats();
}


// Shared cache helpers for values that must be reused across serverless instances.
// Upstash's REST API is used directly so the API does not need another runtime dependency.
const redisUrl = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function redisHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${redisToken}`,
    'Content-Type': 'text/plain; charset=utf-8',
  };
}

export async function sharedCacheGet<T>(key: string, ttlSeconds = 900): Promise<T | null> {
  const local = cache.get<T>(key);
  if (local !== undefined) return local;
  if (!redisUrl || !redisToken) return null;

  try {
    const response = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, {
      headers: redisHeaders(),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { result?: unknown };
    if (payload.result == null) return null;

    const value = typeof payload.result === 'string'
      ? JSON.parse(payload.result)
      : payload.result;
    cache.set(key, value, ttlSeconds);
    return value as T;
  } catch (error) {
    console.warn('[cache] shared GET failed; continuing without Redis', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function sharedCacheSet(key: string, data: unknown, ttlSeconds = 900): Promise<void> {
  cache.set(key, data, ttlSeconds);
  if (!redisUrl || !redisToken) return;

  try {
    const response = await fetch(`${redisUrl}/set/${encodeURIComponent(key)}?ex=${Math.max(1, Math.floor(ttlSeconds))}`, {
      method: 'POST',
      headers: redisHeaders(),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn('[cache] shared SET failed; continuing with local cache', error instanceof Error ? error.message : error);
  }
}


// Coalesce concurrent work for the same key without caching its result.
// The entry exists only while the operation is pending and is always removed
// after success or failure, so a failed upstream request can be retried.
const inFlight = new Map<string, Promise<unknown>>();

export async function withInflight<T>(
  key: string,
  task: () => Promise<T>,
  label: string = key,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    console.info(`[inflight] joined ${label}`);
    return existing as Promise<T>;
  }

  const pending = Promise.resolve().then(task);
  inFlight.set(key, pending);

  try {
    return await pending;
  } finally {
    if (inFlight.get(key) === pending) {
      inFlight.delete(key);
    }
  }
}
