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
