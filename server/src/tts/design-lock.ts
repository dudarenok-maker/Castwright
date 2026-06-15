/* Per-book voice-design serialization + a cross-operation busy registry.

   The "Design full cast" bulk job (server/src/routes/cast-design.ts) and the
   single-voice design route (server/src/routes/qwen-voice.ts) both call the
   sidecar's `/qwen/design-voice` for a STABLE derived voiceId
   (`deriveQwenVoiceId`). If two designs for the same book ran at once they
   would clobber each other's sidecar `.pt`/`.json` embedding AND the shared
   audition-cache file (both keyed deterministically). `withDesignLock(bookDir)`
   serializes them — only one design per book at a time.

   The busy registry guards the OTHER destructive interaction: a re-analysis
   rewrites the whole cast.json, so it must not run concurrently with a bulk
   design (which writes per-character overrides). Analysis ref-counts its busy
   state (a main + a subset job can coexist); design is single-job-per-book.
   Everything keys on `bookDir` — the one identifier both routes hold (the
   analysis route works in manuscriptId, the design routes in bookId, but both
   resolve a bookDir). */

/* Per-bookDir promise chain — the same idiom as generation's
   `serializeQueueMutation`. A waiter chains onto the tail; the lock is released
   when its critical section settles. */
const designChains = new Map<string, Promise<unknown>>();

/** Run `fn` while holding the per-book design lock. Awaits any in-flight design
    for the same book first, so two designs for one book never overlap. */
export async function withDesignLock<T>(bookDir: string, fn: () => Promise<T>): Promise<T> {
  const prior = designChains.get(bookDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  /* The next waiter chains onto `gate` (resolved in our finally), so it can't
     start until we're done. Swallow prior rejections so one failed design
     doesn't reject the whole chain. */
  designChains.set(
    bookDir,
    prior.then(() => gate, () => gate),
  );
  await prior.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    /* Tidy up when we're the chain tail, so the map doesn't grow unbounded. */
    if (designChains.get(bookDir) === gate) designChains.delete(bookDir);
  }
}

/* ── Cross-operation busy registry (mutual exclusion) ───────────────────── */

const analysisBusy = new Map<string, number>(); // bookDir → ref count (main + subset)
const designBusy = new Set<string>(); // bookDir of an active bulk-design job

export function markAnalysisBusy(bookDir: string): void {
  analysisBusy.set(bookDir, (analysisBusy.get(bookDir) ?? 0) + 1);
}
export function clearAnalysisBusy(bookDir: string): void {
  const n = (analysisBusy.get(bookDir) ?? 0) - 1;
  if (n <= 0) analysisBusy.delete(bookDir);
  else analysisBusy.set(bookDir, n);
}
export function isAnalysisBusy(bookDir: string): boolean {
  return (analysisBusy.get(bookDir) ?? 0) > 0;
}

export function markDesignBusy(bookDir: string): void {
  designBusy.add(bookDir);
}
export function clearDesignBusy(bookDir: string): void {
  designBusy.delete(bookDir);
}
export function isDesignBusy(bookDir: string): boolean {
  return designBusy.has(bookDir);
}

/** True when ANY book has a bulk voice-design job in flight. Used by the
    accelerator-profile switch (AMD phase 2) to refuse a venv rebuild mid-design. */
export function isAnyDesignBusy(): boolean {
  return designBusy.size > 0;
}

/** True when ANY book has an analysis job in flight (main or subset). */
export function isAnyAnalysisBusy(): boolean {
  return analysisBusy.size > 0;
}
