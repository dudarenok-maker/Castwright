/* Generic per-key promise-chain mutex. Same idiom as tts/design-lock.ts's
   withDesignLock, but keyed on an arbitrary string so callers (e.g. the
   listen-stats read-modify-write) get isolation without coupling to the
   voice-design busy registry. */
const chains = new Map<string, Promise<unknown>>();

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  chains.set(key, prior.then(() => gate, () => gate));
  await prior.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === gate) chains.delete(key);
  }
}
