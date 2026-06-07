/* Pipelined two-model analyzer — phase watermark + back-pressure semaphore
   (plan 88).

   The "Phase 0 (cast detection) → Phase 1 (attribution)" boundary used
   to be a hard wall: Phase 1 didn't start until every Phase 0 chapter
   had finished and Phase 0b had merged them into the final roster.

   With per-phase model selection (`ANALYZER_PHASE0_MODEL` /
   `ANALYZER_PHASE1_MODEL`) we want Phase 1 chapter K to dispatch as
   soon as Phase 0 chapter `K + LAG - 1` is done — i.e. while Gemma is
   still working on later chapters, Gemini starts attributing the
   earliest ones against a rolling-roster snapshot.

   The back-pressure semantics matter as much as the lag itself. If
   Gemini ever catches up (Gemma rate-limited; Gemini finishing
   already-dispatched chapters fast), the next Gemini chapter MUST
   block until Gemma's watermark advances by another chapter — never
   attribute against a roster that lags Gemma's view by less than the
   minimum.

   This module is the pure seam: a per-job factory returning an
   object with three methods. No globals — every analysis job gets a
   fresh watermark. The route layer (`server/src/routes/analysis.ts`)
   wires `markPhase0ChapterComplete` into the cast-pool worker and
   `awaitPhase1Dispatch` into the attribution-pool worker. The Phase
   0b consolidation step calls `markPhase0AllDone()` so any remaining
   Phase 1 chapters release immediately against the final roster.

   The watermark seam is short-circuited (degrades to today's
   sequential phase gate) when the new env vars are unset — the
   non-pipelined default runs both phases through one model. */

export interface PhaseWatermarkOptions {
  /** Minimum number of Phase 0 chapters Gemma must have completed
      ahead of any Phase 1 chapter Gemini is about to dispatch.
      `awaitPhase1Dispatch(K)` resolves when `watermark >= K + minLag`.
      Set to `0` to release the lag — Phase 1 chapter K then dispatches
      as soon as Phase 0 chapter K is marked complete. */
  minLagChapters: number;
}

export interface PhaseWatermark {
  /** Phase 0 worker calls this on each per-chapter completion.
      Monotonic — out-of-order completions are tolerated; the watermark
      only advances, never regresses. Returns the new watermark value. */
  markPhase0ChapterComplete(chapterIndex: number): number;
  /** Phase 0b consolidation calls this after the final roster merge.
      Releases ALL pending Phase 1 waiters immediately, regardless of
      the current watermark. Idempotent — calling twice is a no-op. */
  markPhase0AllDone(): void;
  /** Phase 1 worker awaits this before dispatching its attribution
      call. Resolves when `watermark >= chapterIndex + minLagChapters`
      OR `phase0Done === true`. If the condition is already met at call
      time, resolves on the next microtask. Otherwise parks on an
      internal listener; re-evaluated on every watermark advance. */
  awaitPhase1Dispatch(chapterIndex: number): Promise<void>;
  /** Current watermark value — handy for telemetry / log lines. */
  readonly watermark: number;
  /** True once `markPhase0AllDone()` has fired. */
  readonly phase0Done: boolean;
}

/** Construct a per-job watermark. Pass a real `minLagChapters` from
    `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` env (default 10). */
export function createPhaseWatermark(opts: PhaseWatermarkOptions): PhaseWatermark {
  /* Internal mutable state — captured in closure so each job's watermark
     is isolated from every other job. No process globals. */
  let watermark = -1; // before any chapter completes; -1 < 0 + lag for any lag>=1
  let phase0Done = false;
  const waiters = new Set<() => void>();

  const minLag = opts.minLagChapters;

  /* Re-evaluate every parked waiter. Each waiter's own predicate is
     captured in its closure; we just kick them all and let each
     decide whether to resolve. Failed predicates re-add themselves. */
  const notifyAll = (): void => {
    /* Snapshot to a list before iterating — resolving a waiter removes
       it from the set, which would otherwise mutate-during-iteration. */
    const snapshot = Array.from(waiters);
    for (const wake of snapshot) wake();
  };

  return {
    markPhase0ChapterComplete(chapterIndex: number): number {
      /* Monotonic: tolerate out-of-order completion (worker N+2 finishes
         before worker N because chapter sizes vary or one chapter
         rate-limits). Never regress. */
      if (chapterIndex > watermark) {
        watermark = chapterIndex;
        notifyAll();
      }
      return watermark;
    },

    markPhase0AllDone(): void {
      if (phase0Done) return; // idempotent
      phase0Done = true;
      notifyAll();
    },

    awaitPhase1Dispatch(chapterIndex: number): Promise<void> {
      /* Predicate captured per-call so each waiter checks its own
         chapter's lag requirement. `phase0Done === true` shortcuts —
         once Phase 0b has finalised, ALL remaining Phase 1 chapters
         can dispatch against the final roster. */
      const ready = (): boolean => phase0Done || watermark >= chapterIndex + minLag;

      if (ready()) {
        /* Resolve on next microtask so the caller always gets an async
           hop even on synchronous-ready waiters. Keeps the contract
           uniform and avoids surprise re-entrancy where the dispatch
           runs inside the worker that just incremented the watermark. */
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        const wake = (): void => {
          if (ready()) {
            waiters.delete(wake);
            resolve();
          }
        };
        waiters.add(wake);
      });
    },

    get watermark() {
      return watermark;
    },
    get phase0Done() {
      return phase0Done;
    },
  };
}

/** Stub watermark used when the pipeline must collapse to today's
    sequential phase-gate behaviour: none of the three new env vars are
    set (legacy single-model / non-pipelined case).

    Behaves as an infinite lag — `awaitPhase1Dispatch` only resolves
    after `markPhase0AllDone()` fires. Drop-in compatible with the real
    watermark so the route layer doesn't branch on engine. */
export function createSequentialWatermark(): PhaseWatermark {
  let phase0Done = false;
  const waiters = new Set<() => void>();

  return {
    markPhase0ChapterComplete(_chapterIndex: number): number {
      /* No-op for the sequential stub — Phase 1 waits for Phase 0b
         regardless of how many Phase 0 chapters have completed. */
      return -1;
    },
    markPhase0AllDone(): void {
      if (phase0Done) return;
      phase0Done = true;
      const snapshot = Array.from(waiters);
      for (const wake of snapshot) wake();
    },
    awaitPhase1Dispatch(_chapterIndex: number): Promise<void> {
      if (phase0Done) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const wake = (): void => {
          if (phase0Done) {
            waiters.delete(wake);
            resolve();
          }
        };
        waiters.add(wake);
      });
    },
    get watermark() {
      return -1;
    },
    get phase0Done() {
      return phase0Done;
    },
  };
}
