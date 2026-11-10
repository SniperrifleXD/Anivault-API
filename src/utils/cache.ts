import NodeCache from 'node-cache';
import { randomUUID } from 'crypto';

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


// Distributed single-flight for cacheable work. A short Redis lock prevents
// separate serverless instances from all performing the same cold lookup.
export async function withSharedInflight<T>(
  key: string,
  task: () => Promise<T>,
  ttlSeconds = 900,
  waitMs = 6000,
): Promise<T> {
  return withInflight(`shared:${key}`, async () => {
    const cached = await sharedCacheGet<T>(key, ttlSeconds);
    if (cached !== null) {
      console.info(`[inflight] shared cache hit ${key}`);
      return cached;
    }

    // Without Redis, retain the existing process-local behavior and cache the
    // result locally. Redis failures also fall back to this safe path.
    if (!redisUrl || !redisToken) {
      const result = await task();
      if (!(Array.isArray(result) && result.length === 0)) {
        await sharedCacheSet(key, result, ttlSeconds);
      }
      return result;
    }

    const lockKey = `${key}:lock`;
    const token = randomUUID();
    let acquired = false;

    try {
      const response = await fetch(`${redisUrl}/set/${encodeURIComponent(lockKey)}?nx&px=15000`, {
        method: 'POST',
        headers: redisHeaders(),
        body: token,
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { result?: unknown };
      acquired = payload.result === 'OK';
    } catch (error) {
      console.warn('[cache] shared lock failed; continuing without distributed coordination', error instanceof Error ? error.message : error);
      const result = await task();
      if (!(Array.isArray(result) && result.length === 0)) {
        await sharedCacheSet(key, result, ttlSeconds);
      }
      return result;
    }

    if (!acquired) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const result = await sharedCacheGet<T>(key, ttlSeconds);
        if (result !== null) return result;
      }

      console.warn(`[cache] shared lock wait timed out for ${key}; allowing a fallback lookup`);
      const result = await task();
      if (!(Array.isArray(result) && result.length === 0)) {
        await sharedCacheSet(key, result, ttlSeconds);
      }
      return result;
    }

    try {
      // Recheck after acquiring the lock in case another instance populated
      // the cache between our first GET and the successful SET NX.
      const secondCheck = await sharedCacheGet<T>(key, ttlSeconds);
      if (secondCheck !== null) return secondCheck;

      const result = await task();
      if (!(Array.isArray(result) && result.length === 0)) {
        await sharedCacheSet(key, result, ttlSeconds);
      }
      return result;
    } finally {
      // Compare-and-delete prevents this invocation from releasing a newer
      // lock if its own lock expired while the upstream request was running.
      const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
      try {
        const response = await fetch(
          `${redisUrl}/eval/${encodeURIComponent(script)}/1/${encodeURIComponent(lockKey)}/${encodeURIComponent(token)}`,
          { headers: redisHeaders(), signal: AbortSignal.timeout(2500) },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        console.warn('[cache] shared lock release failed', error instanceof Error ? error.message : error);
      }
    }
  }, `shared operation ${key}`);
}
