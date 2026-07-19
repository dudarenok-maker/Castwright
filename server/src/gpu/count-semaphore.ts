/* CountSemaphore — single-instance FIFO arbitration around a fixed count of
   concurrent slots. This is the plain count core of GpuSemaphore
   (server/src/gpu/semaphore.ts) with the VRAM token/cost weighting removed:
   every acquire takes exactly one slot.

   Hand-rolled (no p-limit / p-queue dep) — the contract is small: acquire
   returns a release function the caller invokes in `finally`. FIFO order is
   preserved by shift()-ing the queue head and granting it as soon as a slot
   frees up. */

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class CountSemaphore {
  private held = 0;
  private capacity: number;
  private readonly queue: Waiter[] = [];

  constructor(max: number) {
    /* Clamp to >= 1 — a max of 0 would deadlock every caller, and negative
       values are nonsensical. Defensive against bad env vars. */
    this.capacity = Math.max(1, Math.floor(max));
  }

  /** Acquire one slot. Resolves with a single-use release function; the
      caller MUST invoke it (typically inside a `finally`) so queued waiters —
      or, if none are queued, the slot counter — can advance. */
  async acquire(opts?: { signal?: AbortSignal }): Promise<() => void> {
    const signal = opts?.signal;
    if (signal?.aborted) {
      throw new DOMException('CountSemaphore acquire aborted', 'AbortError');
    }
    /* Grant immediately only when no one is queued ahead of us AND a slot is
       free. Honouring the queue even when a slot happens to be free
       preserves strict FIFO — a late acquire can't jump a waiting one. */
    if (this.queue.length === 0 && this.held < this.capacity) {
      this.held += 1;
      return this.makeRelease();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false, signal };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return; // already granted — abort is a no-op
          waiter.settled = true;
          const idx = this.queue.indexOf(waiter);
          if (idx !== -1) this.queue.splice(idx, 1); // remove: never granted, no slot to free
          reject(new DOMException('CountSemaphore acquire aborted', 'AbortError'));
          // Removing a head waiter can unblock the next queued waiter that now
          // fits; grant it now rather than stalling it until an unrelated release().
          this.drain();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /** Live-resize the slot count. Growing immediately drains any FIFO waiters
      that now fit; shrinking leaves in-flight holders untouched — `held` may
      briefly exceed the new capacity, and new acquires simply wait until
      releases bring it back under. No-op when unchanged. Clamps to >= 1 (same
      as the constructor). */
  resize(n: number): void {
    const next = Math.max(1, Math.floor(n));
    if (next === this.capacity) return;
    this.capacity = next;
    this.drain(); // a grown max may now admit queued waiters
  }

  /** Build a fresh single-use release function for the slot that just went
      in-flight. When invoked, frees the slot and then drains as many FIFO-head
      waiters as now fit. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held -= 1;
      this.drain();
    };
  }

  /** Grant FIFO-head waiters while slots remain free. */
  private drain(): void {
    while (this.queue.length > 0 && this.held < this.capacity) {
      const next = this.queue.shift()!;
      if (next.settled) continue; // defensive: aborted concurrently (splice usually removed it first)
      next.settled = true;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.held += 1;
      next.resolve(this.makeRelease());
    }
  }

  /** Number of acquires waiting in the FIFO queue. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Number of acquires currently holding a slot. */
  get inFlight(): number {
    return this.held;
  }

  /** Configured slot count. */
  get max(): number {
    return this.capacity;
  }
}
