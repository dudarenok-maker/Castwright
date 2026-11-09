/* Plan 291 (#4031) — the store-level busy cache: which long jobs the server
   last reported holding each book (`GET /:bookId/busy`), written only by
   `pollBookBusy` (store/cast-gate.ts). With the analysis snapshot and the
   cast slice's per-book `analysisEra` it decides whether a book's cast is
   read-only (`selectCastReadOnly`, below).

   An entry is only as fresh as the latest era latch: latching a book's era
   drops its entry, so the gate's release ("busy has no `analysis`") is
   always judged on a reply issued after the analysis it is releasing. A
   reply listing `analysis` latches the era itself (the poll dispatches the
   latch first, then the reply).

   The selector lives here rather than in cast-gate.ts so the persistence
   middleware can read it without importing the gate (which imports the
   middleware's own action creators); cast-gate.ts re-exports it. */

import { createSlice, type PayloadAction, type ThunkAction, type UnknownAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { castActions, type CastState } from './cast-slice';
import type { AnalysisStreamSnapshot } from './analysis-slice';

export type BookBusyKinds = Awaited<ReturnType<typeof api.getBookBusy>>;

export interface BookBusyState {
  busyByBook: Record<string, BookBusyKinds>;
}

const initialState: BookBusyState = { busyByBook: {} };

export const bookBusySlice = createSlice({
  name: 'bookBusy',
  initialState,
  reducers: {
    setBusy: (s, a: PayloadAction<{ bookId: string; kinds: BookBusyKinds }>) => {
      s.busyByBook[a.payload.bookId] = a.payload.kinds;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(castActions.latchAnalysisEra, (s, a) => {
      delete s.busyByBook[a.payload.bookId];
    });
  },
});

export const bookBusyActions = bookBusySlice.actions;

/* The toast every refused or withheld cast change raises while a book is
   read-only (one key, so a burst of edits shows one toast). */
export const CAST_READ_ONLY_MESSAGE = "Re-analysis running — that change wasn't saved";
export const CAST_READ_ONLY_DEDUPE_KEY = 'cast-read-only';

/* Ask the cast gate to re-read `bookId`'s cast once its analysis has ended
   (the persistence middleware's 409 `book_busy` handler). Not a reducer
   action: the gate middleware runs `rehydrateCastAfterAnalysis` on it. */
export const REQUEST_CAST_REHYDRATE = 'bookBusy/requestCastRehydrate';
export const requestCastRehydrate = (bookId: string) => ({ type: REQUEST_CAST_REHYDRATE, payload: bookId });

/* Structural, so hand-built test stores that lack a slice still read as
   not read-only. */
export interface CastGateState {
  cast?: Pick<CastState, 'analysisEra'>;
  bookBusy?: BookBusyState;
  analysis?: { activeStream: AnalysisStreamSnapshot | null };
}

/** Invariant 7 — `bookId`'s cast is read-only while the analysis snapshot
    names it AND is running, while the busy cache lists `analysis` for it, or
    while an analysis era is latched for it. */
export function selectCastReadOnly(state: CastGateState, bookId: string): boolean {
  return (
    snapshotRunning(state, bookId) ||
    (state.bookBusy?.busyByBook?.[bookId]?.includes('analysis') ?? false) ||
    !!state.cast?.analysisEra?.[bookId]
  );
}

/** The snapshot leg: the analysis snapshot names `bookId` and is running. A
    paused or halted snapshot is not a run (B2). */
export function snapshotRunning(state: CastGateState, bookId: string): boolean {
  const snap = state.analysis?.activeStream;
  return !!snap && snap.bookId === bookId && snap.state === 'running';
}

/* What the poll reads besides the gate: the book the stage names. */
export interface BusyPollState extends CastGateState {
  ui?: { stage: unknown };
}

export const stageBookId = (state: BusyPollState): string | null =>
  (state.ui?.stage as { bookId?: string } | undefined)?.bookId ?? null;

const eraEpochOf = (state: CastGateState, bookId: string) => state.cast?.analysisEra?.[bookId]?.epoch;

/* B2 — the gaps before each re-ask while a book stays gated: 1 s, 3 s, 9 s,
   27 s, then every 30 s while it is open. */
export const BUSY_POLL_DELAYS_MS = [1000, 3000, 9000, 27000] as const;
export const BUSY_POLL_STEADY_MS = 30_000;
export const busyPollDelay = (attempt: number): number => BUSY_POLL_DELAYS_MS[attempt] ?? BUSY_POLL_STEADY_MS;

/* One flight per book per store (keyed by the store's getState, so test
   stores never share one). */
const pollFlights = new WeakMap<object, Map<string, Promise<BookBusyKinds>>>();

/** Ask the server which jobs hold `bookId` and cache the answer, then keep
    asking (`busyPollDelay`) while the book is open, gated and not running a
    snapshot of its own, until a reply lists no `analysis`. Single-flight per
    book: a call while one runs returns that one. A reply listing `analysis`
    latches the book's era; a reply issued before the era last moved is
    dropped and asked again at once. Resolves with the last reply; rejects
    only when no request answered. */
export function pollBookBusy(
  bookId: string,
): ThunkAction<Promise<BookBusyKinds>, BusyPollState, unknown, UnknownAction> {
  return (dispatch, getState) => {
    let flights = pollFlights.get(getState);
    if (!flights) pollFlights.set(getState, (flights = new Map()));
    const running = flights.get(bookId);
    if (running) return running;
    const keepAsking = () => {
      const s = getState();
      return stageBookId(s) === bookId && selectCastReadOnly(s, bookId) && !snapshotRunning(s, bookId);
    };
    const loop = async (): Promise<BookBusyKinds> => {
      /* Registered before anything runs, so a re-entrant call finds it. */
      await Promise.resolve();
      let last: BookBusyKinds | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; ; ) {
        const issuedAt = eraEpochOf(getState(), bookId);
        let kinds: BookBusyKinds | null = null;
        try {
          kinds = await api.getBookBusy(bookId);
        } catch (err) {
          lastErr = err;
          console.warn('[book-busy] busy check failed:', (err as Error)?.message);
        }
        if (kinds && eraEpochOf(getState(), bookId) !== issuedAt) continue;
        if (kinds) {
          if (kinds.includes('analysis')) dispatch(castActions.latchAnalysisEra({ bookId }));
          dispatch(bookBusyActions.setBusy({ bookId, kinds }));
          last = kinds;
          if (!kinds.includes('analysis')) return kinds;
        }
        if (!keepAsking()) break;
        await new Promise<void>((resolve) => setTimeout(resolve, busyPollDelay(attempt++)));
        if (!keepAsking()) break;
      }
      if (last) return last;
      throw lastErr ?? new Error('busy check did not answer');
    };
    const flight = loop().finally(() => {
      if (flights!.get(bookId) === flight) flights!.delete(bookId);
    });
    flights.set(bookId, flight);
    return flight;
  };
}
