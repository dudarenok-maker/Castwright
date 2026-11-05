/* srv-16 / #4029 -- serialise every server-side `.queue.json` read-modify-write through
   one promise chain. There's no file-level lock, and the server mutates the queue from
   several concurrent contexts (the queue routes, per-chapter completion, the srv-12
   orphan-recovery reset, the recycle-storm pause, the book-delete prune), so without this
   two near-simultaneous mutations could each read the same snapshot and the later write
   would drop the earlier one (a lost `/start` flip, a clear that erases a fresh enqueue).
   The chain swallows errors so one failed mutation can't wedge the next.

   LEAF: process-local, holds nothing but the queue-file read/write it wraps. A holder must
   never acquire a book / cast / design lock, and must never call `serializeQueueMutation`
   itself (it would wait on its own tail). Callers that hold a book lock may wait on it:
   nothing inside it waits on them. Slow, non-queue prep (the gate-file retry, enqueue's
   engine stamp) belongs OUTSIDE the span; the gate check that decides a write belongs INSIDE
   it, against the same snapshot the write is made from. */
let queueMutationChain: Promise<unknown> = Promise.resolve();

export function serializeQueueMutation<T>(mutate: () => Promise<T>): Promise<T> {
  const next = queueMutationChain.then(mutate, mutate);
  queueMutationChain = next.catch(() => undefined);
  return next;
}
