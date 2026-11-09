/* Plan 291 (#4031), invariant 7 — "lock until reloaded": the per-book cast
   gate.

   While a book's analysis runs, or while an analysis era is latched for it,
   its cast is read-only: the persistence middleware builds no cast-slice save
   for it (`selectCastReadOnly`). This module latches the era, flushes on the
   way up, and releases it:

   - Latch. An analysis apply (`replaceLiveRoster`, `hydrateFromAnalysis`,
     `mergeCharacters` with `fromAnalysis`) latches the era of the book its
     meta names, else the book the analysis stream names, else the open book
     (R5: payloads carry no bookId). An apply for a book the slices do not
     hold never reaches them. The gate also latches the open book's era when
     it sees an analysis by any other route: a running snapshot (a live run,
     or one set at reload) and another tab's snapshot. A busy reply listing
     `analysis` (book-busy-slice.ts) and a cast PUT answered 409 `book_busy`
     (persistence-middleware.ts) latch it too.
   - Gate-up flushes (B3). When the open book's gate goes up its queued cast
     save is sent at once, never withheld: it lands before the job registers
     or gets the 409, and the re-read below waits for that flight.
   - Release (B2). While the open book is gated and its snapshot is not
     running (no live stream feeds it), `pollBookBusy` asks the server. Once
     busy lists no `analysis` and the snapshot is not running,
     `rehydrateCastAfterAnalysis` re-reads the cast from disk and clears the
     era. No terminal frame and no action releases it on its own.

   "Open" has two senses here, as in open-book.ts: the gate is evaluated for
   the book the stage names (where the persistence middleware sends saves);
   a re-read lands only in slices that hold the book. */

import type { Middleware, ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { castActions, type CastApplyMeta } from './cast-slice';
import { analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { beginFullRead, castWrittenSince, flushBookPersistence } from './persistence-middleware';
import {
  REQUEST_CAST_REHYDRATE,
  busyPollDelay,
  pollBookBusy,
  selectCastReadOnly,
  snapshotRunning,
  stageBookId,
  type BusyPollState,
} from './book-busy-slice';

export { selectCastReadOnly, pollBookBusy } from './book-busy-slice';

interface GateState extends BusyPollState {
  manuscript?: { bookId?: string | null };
}

type GateThunk<R> = ThunkAction<R, GateState, unknown, UnknownAction>;

const eraEpochOf = (s: GateState, bookId: string) => s.cast?.analysisEra?.[bookId]?.epoch;
/* The slices hold `bookId` (the manuscript slice's identity, as the
   persistence middleware's #3624 gate reads it). */
const holdsBook = (s: GateState, bookId: string) => (s.manuscript?.bookId ?? null) === bookId;

/* A cast save could post-date the read this many times in a row before the
   re-read gives up (the next state change re-issues it). */
const MAX_OVERTAKEN_READS = 3;

const rehydrateFlights = new WeakMap<object, Map<string, Promise<void>>>();

/** Re-read `bookId`'s cast once its analysis has ended, then clear its era.
    Single-flight per book. Records the era's epoch; waits until busy lists
    no `analysis` and the snapshot is not running (polling when it must);
    sends and waits for the book's queued saves (`castWrittenSince`); reads
    the book and hydrates the cast only when the slices hold it; then clears
    the era for that epoch. An analysis apply that moved the epoch meanwhile
    runs it again. For a book the slices do not hold it only clears the era
    and reads nothing: the layout's next full read of it is the reload (R26).
    Never rejects. */
export function rehydrateCastAfterAnalysis(bookId: string): GateThunk<Promise<void>> {
  return (dispatch, getState) => {
    let flights = rehydrateFlights.get(getState);
    if (!flights) rehydrateFlights.set(getState, (flights = new Map()));
    const running = flights.get(bookId);
    if (running) return running;
    const loop = async (): Promise<void> => {
      await Promise.resolve();
      let overtaken = 0;
      let failures = 0;
      for (;;) {
        const s = getState();
        if (snapshotRunning(s, bookId)) return;
        const epoch = eraEpochOf(s, bookId);
        const cached = s.bookBusy?.busyByBook?.[bookId];
        if (!cached || cached.includes('analysis')) {
          let kinds;
          try {
            kinds = await dispatch(pollBookBusy(bookId));
          } catch {
            return;
          }
          if (kinds.includes('analysis') || snapshotRunning(getState(), bookId)) return;
          if (eraEpochOf(getState(), bookId) !== epoch) continue;
        }
        if (!holdsBook(getState(), bookId)) {
          if (epoch !== undefined) dispatch(castActions.clearAnalysisEra({ bookId, epoch }));
          return;
        }
        const writes = dispatch(flushBookPersistence(bookId)) as unknown;
        if (writes instanceof Promise) await writes;
        const readSeq = dispatch(beginFullRead(bookId)) as unknown as number;
        let res;
        try {
          res = await api.getBookState(bookId);
        } catch (err) {
          console.warn('[cast-gate] cast re-read failed:', (err as Error)?.message);
          if (!holdsBook(getState(), bookId)) return;
          await new Promise<void>((resolve) => setTimeout(resolve, busyPollDelay(failures++)));
          continue;
        }
        if (eraEpochOf(getState(), bookId) !== epoch) continue;
        if ((dispatch(castWrittenSince(bookId, readSeq) as never) as unknown) === true) {
          if (++overtaken < MAX_OVERTAKEN_READS) continue;
          return;
        }
        if (res && holdsBook(getState(), bookId)) {
          dispatch(castActions.hydrateCharacters(res.cast?.characters ?? []));
        }
        if (epoch !== undefined) dispatch(castActions.clearAnalysisEra({ bookId, epoch }));
        return;
      }
    };
    const flight = loop().finally(() => {
      if (flights!.get(bookId) === flight) flights!.delete(bookId);
    });
    flights.set(bookId, flight);
    return flight;
  };
}

const APPLY_TYPES = new Set<string>([
  castActions.replaceLiveRoster.type,
  castActions.hydrateFromAnalysis.type,
  castActions.mergeCharacters.type,
]);

export const castGateMiddleware: Middleware = (store) => {
  const run = <R>(thunk: GateThunk<R>): R => (store.dispatch as unknown as (t: GateThunk<R>) => R)(thunk);
  const getState = () => store.getState() as GateState;
  /* The open book and whether it was gated after the previous action. */
  let last: { bookId: string | null; gated: boolean } = { bookId: null, gated: false };

  return (next) => (action) => {
    const a = action as { type?: string; payload?: unknown; meta?: CastApplyMeta };
    if (
      a.type &&
      APPLY_TYPES.has(a.type) &&
      (a.type !== castActions.mergeCharacters.type || a.meta?.fromAnalysis === true)
    ) {
      const s = getState();
      const held = s.manuscript?.bookId ?? null;
      const target = a.meta?.bookId ?? s.analysis?.activeStream?.bookId ?? held ?? stageBookId(s);
      if (target) {
        store.dispatch(castActions.latchAnalysisEra({ bookId: target }));
        /* Another book's roster never lands in these slices (B1). */
        if (held !== null && target !== held) return action;
      }
    }

    const result = next(action);

    if (a.type === REQUEST_CAST_REHYDRATE && typeof a.payload === 'string') {
      void run(rehydrateCastAfterAnalysis(a.payload));
      return result;
    }

    const open = stageBookId(getState());
    if (!open) {
      last = { bookId: null, gated: false };
      return result;
    }
    /* Item 8 — an analysis seen by any route latches the open book's era:
       another tab's snapshot (even a paused one), or a running snapshot. */
    if (a.type === analysisActions.applyExternalAnalysisSnapshot.type) {
      const snap = a.payload as AnalysisStreamSnapshot | null;
      if (snap?.bookId === open) store.dispatch(castActions.latchAnalysisEra({ bookId: open }));
    }
    const running = snapshotRunning(getState(), open);
    if (running && eraEpochOf(getState(), open) === undefined) {
      store.dispatch(castActions.latchAnalysisEra({ bookId: open }));
    }

    const s = getState();
    const gated = selectCastReadOnly(s, open);
    const rose = gated && !(last.bookId === open && last.gated);
    last = { bookId: open, gated };
    /* B3 — flush, never withhold. */
    if (rose) store.dispatch(flushBookPersistence(open));
    if (gated && !running) {
      const kinds = s.bookBusy?.busyByBook?.[open];
      if (kinds && !kinds.includes('analysis')) void run(rehydrateCastAfterAnalysis(open));
      else void run(pollBookBusy(open)).catch(() => {});
    }
    return result;
  };
};
