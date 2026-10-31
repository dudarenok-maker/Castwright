/* #3991 — per-key load-once helper. Concurrent callers for one key share the
   first caller's in-flight promise; a value is remembered after it lands and
   a null/throwing load is remembered as failed (sticky for the loader's
   lifetime, so a retry never re-sends the read). The outcome is recorded
   synchronously before the promise settles, so no caller can ever find the
   cache, the failed set and the in-flight map all empty and start a second
   read. Holds no timers. */
export interface KeyedLoader<T> {
  load(key: string): Promise<T | null>;
}

export function createKeyedLoader<T>(fetchOne: (key: string) => Promise<T | null>): KeyedLoader<T> {
  const cache = new Map<string, T>();
  const failed = new Set<string>();
  const inflight = new Map<string, Promise<T | null>>();
  return {
    load(key) {
      const cached = cache.get(key);
      if (cached !== undefined) return Promise.resolve(cached);
      if (failed.has(key)) return Promise.resolve(null);
      const pending = inflight.get(key);
      if (pending) return pending;
      const started = fetchOne(key)
        .then(
          (value) => value,
          () => null,
        )
        .then((value) => {
          if (value === null) failed.add(key);
          else cache.set(key, value);
          return value;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, started);
      return started;
    },
  };
}
