/* #3437 — per-manuscript analysis run epoch. An in-memory counter per manuscript id is bumped
   every time an analysis job (main or subset) is registered; the job keeps its own fence
   `{ manuscriptId, epoch }` and runs its whole body inside an AsyncLocalStorage context carrying
   it. A write primitive can then ask "is the run that made this call still the newest run for
   this manuscript?" without a parameter threaded through every call site.

   Named `runEpoch` everywhere: state.json's unrelated `editEpoch` (plan 289) is a different thing.
   Leaf module: imports only node:async_hooks. */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RunEpochFence {
  readonly manuscriptId: string;
  readonly epoch: number;
}

const counters = new Map<string, number>();
const als = new AsyncLocalStorage<RunEpochFence>();

/** Bump the counter for this manuscript and return the new fence. */
export function beginRunEpoch(manuscriptId: string): RunEpochFence {
  const epoch = (counters.get(manuscriptId) ?? 0) + 1;
  counters.set(manuscriptId, epoch);
  return { manuscriptId, epoch };
}

/** True when a newer run has begun for the fence's manuscript. No fence = not an analysis run. */
export function isRunEpochStale(fence: RunEpochFence | undefined): boolean {
  if (!fence) return false;
  return (counters.get(fence.manuscriptId) ?? 0) !== fence.epoch;
}

/** Run `fn` with `fence` as the ambient run-epoch fence. */
export function runWithRunEpoch<T>(fence: RunEpochFence, fn: () => Promise<T>): Promise<T> {
  return als.run(fence, fn);
}

/** The ambient fence, or undefined outside an analysis run. */
export function currentRunEpochFence(): RunEpochFence | undefined {
  return als.getStore();
}

/** true = stale: logs one line and the caller must skip its write. false = write. */
export function staleRunWriteDropped(fence: RunEpochFence | undefined, what: string): boolean {
  if (!fence || !isRunEpochStale(fence)) return false;
  const current = counters.get(fence.manuscriptId) ?? 0;
  console.log(
    `[analysis] dropped stale-run write: ${what} manuscript=${JSON.stringify(fence.manuscriptId)} runEpoch=${fence.epoch} current=${current}`,
  );
  return true;
}

export function __resetRunEpochsForTests(): void {
  counters.clear();
}
