/* GpuSemaphore — single-instance FIFO arbitration around heavy-GPU work,
   weighted by VRAM cost. Two parallel Claude Code sessions on the same dev
   box can both kick off `/analyse` (Ollama) or `/synthesize` (TTS sidecar)
   at once; on an 8 GB GPU the second op spills into shared system RAM and
   BOTH runs slow by 5-10x. Arbitrating at the Node layer keeps the GPU from
   overcommitting and lets a waiting session show a "Queued (N ahead)" pill
   instead of silently thrashing.

   Earlier this was a flat *count* semaphore (max from GPU_CONCURRENCY). It's
   now a *token budget*: each caller takes `cost` tokens — the VRAM weight of
   its engine (see server/src/tts/engine-vram-cost.ts). Two cheap engines can
   run concurrently while a heavy one serialises, so we never overcommit the
   GPU and never needlessly serialise two ops that genuinely fit together.

   Backward-compat: when GPU_VRAM_BUDGET is unset, the budget falls back to
   GPU_CONCURRENCY (default 1) and every caller's default cost is 1 — so the
   weighted semaphore behaves byte-identically to the old count semaphore.

   Hand-rolled (no p-limit / p-queue dep) — the contract is small: acquire
   returns a release function the caller invokes in `finally`. FIFO order is
   preserved by shift()-ing the queue head and granting it as soon as enough
   tokens free up.

   Wired into:
     - server/src/analyzer/ollama.ts  — wraps the /api/chat fetch.
     - server/src/tts/sidecar.ts      — wraps the /synthesize fetch +
                                        arrayBuffer() read so a single
                                        release covers the full GPU op.
     - server/src/routes/gpu-queue.ts — exposes inFlight + depth + budget +
                                        usedTokens to the frontend pill via
                                        GET /api/gpu/queue. */

type Waiter = { cost: number; resolve: (release: () => void) => void };

export class GpuSemaphore {
  private used = 0;
  private holders = 0;
  private readonly capacity: number;
  private readonly queue: Waiter[] = [];

  constructor(budget: number) {
    /* Clamp to >= 1 — a budget of 0 would deadlock every caller, and
       negative values are nonsensical. Defensive against bad env vars. */
    this.capacity = Math.max(1, Math.floor(budget));
  }

  /** Acquire `cost` GPU tokens. Resolves with a single-use release function;
      the caller MUST invoke it (typically inside a `finally`) so queued
      waiters — or, if none are queued, the token counter — can advance.

      `cost` is clamped into [1, budget]: a cost above the budget would
      otherwise deadlock forever (no release can ever free enough tokens), so
      it's pinned to the full budget and runs alone; a cost below 1 is pinned
      to 1 so every acquire consumes at least one token. */
  async acquire(cost = 1): Promise<() => void> {
    const want = this.clampCost(cost);
    /* Grant immediately only when no one is queued ahead of us AND the
       tokens are free. Honouring the queue even when tokens happen to be
       free preserves strict FIFO — a late cheap acquire can't jump a
       waiting expensive one. */
    if (this.queue.length === 0 && this.used + want <= this.capacity) {
      this.used += want;
      this.holders += 1;
      return this.makeRelease(want);
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push({ cost: want, resolve });
    });
  }

  private clampCost(cost: number): number {
    const c = Math.floor(cost);
    if (!Number.isFinite(c) || c < 1) return 1;
    if (c > this.capacity) return this.capacity;
    return c;
  }

  /** Build a fresh single-use release function for the `cost` tokens that
      just went in-flight. When invoked, frees the tokens and then drains as
      many FIFO-head waiters as now fit. */
  private makeRelease(cost: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= cost;
      this.holders -= 1;
      this.drain();
    };
  }

  /** Grant the FIFO head while it fits in the freed tokens. Strictly
      head-of-line: a waiter that doesn't fit blocks the ones behind it even
      if a later (cheaper) waiter would fit — that's what keeps wake order
      FIFO and starvation-free. */
  private drain(): void {
    while (this.queue.length > 0 && this.used + this.queue[0].cost <= this.capacity) {
      const next = this.queue.shift()!;
      this.used += next.cost;
      this.holders += 1;
      next.resolve(this.makeRelease(next.cost));
    }
  }

  /** Number of acquires waiting in the FIFO queue. Drives the
      "Queued (N ahead) ·" pill prefix in the frontend layout. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Number of acquires currently holding tokens. Exposed so the gpu-queue
      route can surface it for diagnostics. */
  get inFlight(): number {
    return this.holders;
  }

  /** Total token budget. Returned by `maxConcurrency` too, so
      `synthesise-chapter.ts`'s poolWidth default (budget 1 ⇒ serial) is
      preserved across the count→token migration. */
  get budget(): number {
    return this.capacity;
  }

  /** Tokens currently committed across all in-flight holders. */
  get usedTokens(): number {
    return this.used;
  }

  /** Configured token budget. Alias of `budget` retained for the existing
      poolWidth default in synthesise-chapter.ts. */
  get maxConcurrency(): number {
    return this.capacity;
  }
}

import { configValue } from '../config/resolver.js';

/* Singleton — both call sites (analyzer + sidecar) import this so a queue
   depth of 1 in the analyzer is visible to a sidecar caller and vice versa.
   Budget comes from gpu.vramBudget when set (non-zero); otherwise it falls
   back to gpu.concurrency (default 1) so single-engine boxes that never set
   the new var keep the exact old behaviour.
   NOTE: resolved once at module-load. The semaphore is a stateful singleton;
   re-creating it mid-run would drop the queue. Changing concurrency/budget
   requires a server restart (apply: 'restart-server' in the registry). */
function resolveGpuBudget(): number {
  const budget = configValue<number>('gpu.vramBudget');
  if (budget > 0) return budget;
  const concurrency = configValue<number>('gpu.concurrency');
  return concurrency > 0 ? concurrency : 1;
}
export const gpuSemaphore = new GpuSemaphore(resolveGpuBudget());
