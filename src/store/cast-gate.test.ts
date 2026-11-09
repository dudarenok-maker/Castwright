/* Plan 291 (#4031), invariant 7 — the per-book cast gate: a book's cast is
   read-only while its analysis runs or while an analysis era is latched for
   it, and the era clears only through a disk re-read issued once busy has no
   `analysis` and the snapshot is not running. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const api = vi.hoisted(() => ({
  getBookBusy: vi.fn(),
  getBookState: vi.fn(),
  putBookState: vi.fn(),
}));
vi.mock('../lib/api', () => ({ api }));

import { castGateMiddleware, selectCastReadOnly, rehydrateCastAfterAnalysis } from './cast-gate';
import { persistenceMiddleware } from './persistence-middleware';
import { castSlice, castActions } from './cast-slice';
import { bookBusySlice } from './book-busy-slice';
import { analysisSlice, analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { manuscriptSlice } from './manuscript-slice';
import { uiSlice, uiActions } from './ui-slice';
import { notificationsSlice } from './notifications-slice';
import { changeLogSlice } from './change-log-slice';
import { bookMetaSlice } from './book-meta-slice';
import { chaptersSlice } from './chapters-slice';
import { resetBookSlices } from './reset-book-slices';
import { createBookStateDisk, type BookStateDisk } from '../test/book-state-disk';
import { ANALYSIS_STREAM_FAILED, ANALYSIS_STREAM_NO_RESULT } from '../lib/analysis-stream-codes';
import type { Character, PutStateRequest } from '../lib/types';

const char = (id: string): Character => ({ id, name: id, role: 'role', color: id, voiceState: 'generated' });

const snap = (bookId: string, over: Partial<AnalysisStreamSnapshot> = {}): AnalysisStreamSnapshot => ({
  bookId,
  manuscriptId: `m-${bookId}`,
  phaseId: 0,
  phaseLabel: 'Detecting characters',
  phaseProgress: 0,
  remainingMs: null,
  lastTickAt: 0,
  state: 'running',
  ...over,
});

function makeStore() {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      chapters: chaptersSlice.reducer,
      analysis: analysisSlice.reducer,
      bookBusy: bookBusySlice.reducer,
      notifications: notificationsSlice.reducer,
      changeLog: changeLogSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
    },
    middleware: (gd) =>
      gd({ serializableCheck: false, immutableCheck: false }).concat(persistenceMiddleware, castGateMiddleware),
  });
}
type Store = ReturnType<typeof makeStore>;

/* What Layout does on opening a book: name it on the stage, reset the
   slices to it, then hydrate its disk cast. */
function open(store: Store, bookId: string, cast: Character[] = []) {
  store.dispatch(uiActions.openBook({ id: bookId, status: 'voices_pending' }));
  resetBookSlices(store.dispatch, bookId);
  store.dispatch(castActions.hydrateCharacters(cast));
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const era = (store: Store, bookId: string) => store.getState().cast.analysisEra?.[bookId];

/* `GET /busy` answers per book from a mutable table. */
let busy: Record<string, string[]>;
let disk: BookStateDisk;

beforeEach(() => {
  vi.useFakeTimers();
  busy = {};
  disk = createBookStateDisk();
  api.getBookBusy.mockReset().mockImplementation(async (bookId: string) => busy[bookId] ?? []);
  api.putBookState.mockReset().mockImplementation((bookId: string, req: PutStateRequest) => disk.serve(bookId, req));
  api.getBookState.mockReset().mockImplementation(async (bookId: string) => {
    const b = disk.books.get(bookId);
    return b ? { state: b.state, cast: b.cast } : null;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('selectCastReadOnly (invariant 7)', () => {
  it("the snapshot leg requires state==='running'", () => {
    const base = { cast: { analysisEra: {} }, bookBusy: { busyByBook: {} } };
    expect(selectCastReadOnly({ ...base, analysis: { activeStream: snap('A') } }, 'A')).toBe(true);
    expect(selectCastReadOnly({ ...base, analysis: { activeStream: snap('A') } }, 'B')).toBe(false);
    for (const state of ['paused', 'halted'] as const) {
      expect(selectCastReadOnly({ ...base, analysis: { activeStream: snap('A', { state }) } }, 'A')).toBe(false);
    }
    expect(selectCastReadOnly({ ...base, bookBusy: { busyByBook: { A: ['analysis'] } } }, 'A')).toBe(true);
    expect(selectCastReadOnly({ ...base, bookBusy: { busyByBook: { A: ['render'] } } }, 'A')).toBe(false);
    expect(selectCastReadOnly({ ...base, cast: { analysisEra: { A: { epoch: 1 } } } }, 'A')).toBe(true);
    expect(selectCastReadOnly({ ...base, cast: { analysisEra: { A: { epoch: 1 } } } }, 'B')).toBe(false);
    /* A hand-built store with none of the three slices is never read-only. */
    expect(selectCastReadOnly({}, 'A')).toBe(false);
  });
});

describe('the per-book era (B1)', () => {
  it("the era is per book; analysis applies latch only their payload's book", async () => {
    /* R5 — the book is the one the apply names (meta), else the one the
       analysis stream names, else the open book. Payloads carry no bookId. */
    busy = { A: ['analysis'], B: ['analysis'] };
    const store = makeStore();
    open(store, 'A', [char('wren')]);
    store.dispatch(castActions.replaceLiveRoster([char('wren'), char('kestrel')]));
    expect(era(store, 'A')).toEqual({ epoch: 1 });
    expect(era(store, 'B')).toBeUndefined();
    /* A plain mergeCharacters is not an analysis apply. */
    store.dispatch(castActions.mergeCharacters([char('wren')]));
    expect(era(store, 'A')).toEqual({ epoch: 1 });
    store.dispatch(castActions.mergeCharacters([char('wren')], { fromAnalysis: true }));
    expect(era(store, 'A')).toEqual({ epoch: 2 });
    store.dispatch(castActions.hydrateFromAnalysis({ characters: [char('wren')] } as never));
    expect(era(store, 'A')).toEqual({ epoch: 3 });
    /* The stream's book wins over the open one. */
    store.dispatch(analysisActions.applyExternalAnalysisSnapshot(snap('B', { state: 'paused' })));
    store.dispatch(castActions.replaceLiveRoster([char('owl')]));
    expect(era(store, 'B')).toEqual({ epoch: 1 });
    expect(era(store, 'A')).toEqual({ epoch: 3 });
    /* An apply for another book latches that book and never lands in the
       open book's slice. */
    store.dispatch(castActions.mergeCharacters([char('heron')], { fromAnalysis: true, bookId: 'C' }));
    expect(era(store, 'C')).toEqual({ epoch: 1 });
    expect(store.getState().cast.characters.map((c) => c.id)).not.toContain('heron');
    expect(store.getState().cast.characters.map((c) => c.id)).not.toContain('owl');
    await settle();
  });

  it('B1: re-analyse A, open B, then A ends — B is editable, B\'s slice never holds A\'s cast, and no PUT reaches B carrying A\'s roster', async () => {
    disk.seed('A', { state: {}, cast: { characters: [char('wren')] } });
    disk.seed('B', { state: {}, cast: { characters: [char('bee')] } });
    busy = { A: ['analysis'] };
    const store = makeStore();
    open(store, 'A', [char('wren')]);
    store.dispatch(analysisActions.setActiveStream(snap('A')));
    store.dispatch(castActions.replaceLiveRoster([char('wren'), char('kestrel')]));
    expect(selectCastReadOnly(store.getState(), 'A')).toBe(true);

    open(store, 'B', [char('bee')]);
    /* B's resets (hydrateCharacters) neither clear nor move A's era. */
    expect(era(store, 'A')).toEqual({ epoch: 2 });
    expect(era(store, 'B')).toBeUndefined();
    /* From B's hydrate on, B's slice is B's. */
    const bRosters: string[][] = [store.getState().cast.characters.map((c) => c.id)];
    store.subscribe(() => bRosters.push(store.getState().cast.characters.map((c) => c.id)));
    /* A late apply of A's run while B is open. */
    store.dispatch(castActions.mergeCharacters([char('kestrel')], { fromAnalysis: true, bookId: 'A' }));
    expect(selectCastReadOnly(store.getState(), 'B')).toBe(false);
    expect(era(store, 'A')).toBeDefined();

    store.dispatch(castActions.setCharacters([char('bee'), char('wasp')]));
    await vi.advanceTimersByTimeAsync(600);

    /* A ends. */
    busy = {};
    store.dispatch(analysisActions.clearActiveStream());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(selectCastReadOnly(store.getState(), 'B')).toBe(false);
    expect(store.getState().notifications.toasts).toHaveLength(0);
    expect(disk.books.get('B')!.cast).toEqual({ characters: [char('bee'), char('wasp')] });
    for (const put of disk.log.filter((p) => p.bookId === 'B')) {
      const ids = ((put.patch.characters as Character[]) ?? []).map((c) => c.id);
      expect(ids).not.toContain('wren');
      expect(ids).not.toContain('kestrel');
    }
    for (const ids of bRosters) {
      expect(ids).not.toContain('wren');
      expect(ids).not.toContain('kestrel');
    }
    /* A is not open: nothing re-read it, and its era waits for its next open. */
    expect(api.getBookState).not.toHaveBeenCalled();
    expect(era(store, 'A')).toBeDefined();
    expect(era(store, 'B')).toBeUndefined();
  });
});

describe('the release is state-driven (B2)', () => {
  type Exit = { name: string; start?: AnalysisStreamSnapshot; exit: (s: Store) => void; reload?: boolean };
  const exits: Exit[] = [
    { name: 'pause', exit: (s) => s.dispatch(analysisActions.setPaused({ manuscriptId: 'm-A' })) },
    {
      name: 'subset cancel',
      start: snap('A', { kind: 'subset', subsetChapterIds: [3] }),
      exit: (s) => s.dispatch(analysisActions.clearActiveStream()),
    },
    {
      name: 'stream_no_result',
      exit: (s) =>
        s.dispatch(analysisActions.setHalted({ manuscriptId: 'm-A', code: ANALYSIS_STREAM_NO_RESULT, message: 'x' })),
    },
    /* The stream middleware turns an `aborted` stream into setPaused. */
    { name: 'aborted', exit: (s) => s.dispatch(analysisActions.setPaused({ manuscriptId: 'm-A' })) },
    { name: 'reload mid-run', reload: true, exit: (s) => s.dispatch(analysisActions.clearActiveStream()) },
    {
      name: 'a stale paused snapshot',
      exit: (s) => s.dispatch(analysisActions.setActiveStream(snap('A', { state: 'paused' }))),
    },
  ];

  it.each(exits)(
    "pause, subset cancel, stream_no_result, aborted, reload mid-run and a stale paused snapshot each release only once busy has no 'analysis' — $name",
    async ({ start, exit, reload }) => {
      disk.seed('A', { state: {}, cast: { characters: [char('wren'), char('kestrel')] } });
      busy = { A: ['analysis'] };
      const store = makeStore();
      open(store, 'A', [char('wren')]);
      /* A reload sets the server's running snapshot (layout.tsx); a live run
         also streams a roster. */
      store.dispatch(analysisActions.setActiveStream(start ?? snap('A')));
      if (!reload) store.dispatch(castActions.replaceLiveRoster([char('wren'), char('kestrel')]));
      expect(era(store, 'A')).toBeDefined();

      exit(store);
      /* The server still lists the job (it drains after a Pause). */
      await vi.advanceTimersByTimeAsync(15_000);
      expect(api.getBookBusy).toHaveBeenCalled();
      expect(api.getBookState).not.toHaveBeenCalled();
      expect(selectCastReadOnly(store.getState(), 'A')).toBe(true);

      busy = {};
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.getBookState).toHaveBeenCalledTimes(1);
      expect(era(store, 'A')).toBeUndefined();
      expect(selectCastReadOnly(store.getState(), 'A')).toBe(false);
      expect(store.getState().cast.characters.map((c) => c.id)).toEqual(['wren', 'kestrel']);
    },
  );

  it('stream_no_result plus busy [] — the stale running snapshot is halted locally, the gate releases, exactly one read (R30)', async () => {
    disk.seed('A', { state: {}, cast: { characters: [char('wren'), char('kestrel')] } });
    busy = { A: ['analysis'] };
    const store = makeStore();
    open(store, 'A', [char('wren')]);
    /* A confirmed run whose stream closed on stream_no_result: the snapshot
       stays `running`, and no live connection feeds it. */
    store.dispatch(analysisActions.setActiveStream(snap('A', { serverConfirmed: true })));
    store.dispatch(castActions.replaceLiveRoster([char('wren'), char('kestrel')]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(selectCastReadOnly(store.getState(), 'A')).toBe(true);
    expect(store.getState().analysis.activeStream?.state).toBe('running');
    busy = {};
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().analysis.activeStream).toMatchObject({ state: 'halted', haltCode: ANALYSIS_STREAM_FAILED });
    expect(api.getBookState).toHaveBeenCalledTimes(1);
    expect(era(store, 'A')).toBeUndefined();
    expect(selectCastReadOnly(store.getState(), 'A')).toBe(false);
    expect(store.getState().cast.characters.map((c) => c.id)).toEqual(['wren', 'kestrel']);
  });

  it('an unconfirmed running snapshot (the click-to-registration window) is never halted by busy []', async () => {
    const store = makeStore();
    open(store, 'A', [char('wren')]);
    store.dispatch(analysisActions.setActiveStream(snap('A')));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getBookBusy).toHaveBeenCalled();
    expect(store.getState().analysis.activeStream?.state).toBe('running');
    expect(selectCastReadOnly(store.getState(), 'A')).toBe(true);
    expect(api.getBookState).not.toHaveBeenCalled();
  });

  it('an analysis apply after the re-hydrate was issued moves the epoch; the re-hydrate re-runs', async () => {
    disk.seed('A', { state: {}, cast: { characters: [char('wren')] } });
    const store = makeStore();
    open(store, 'A', [char('wren')]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = api.getBookState.getMockImplementation()!;
    api.getBookState.mockImplementationOnce(async (id: string) => {
      await held;
      return first(id);
    });
    store.dispatch(castActions.latchAnalysisEra({ bookId: 'A' }));
    await settle();
    expect(api.getBookState).toHaveBeenCalledTimes(1);

    /* A late apply lands while the read is out, and disk moves on. */
    store.dispatch(castActions.replaceLiveRoster([char('wren'), char('kestrel')]));
    disk.write('A', 'cast', { characters: [char('wren'), char('kestrel'), char('owl')] });
    release();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(api.getBookState).toHaveBeenCalledTimes(2);
    expect(era(store, 'A')).toBeUndefined();
    expect(store.getState().cast.characters.map((c) => c.id)).toEqual(['wren', 'kestrel', 'owl']);
  });

  it('the re-hydrate is single-flight per book, and for a book that is not open only clears its era (R26)', async () => {
    disk.seed('A', { state: {}, cast: { characters: [char('wren')] } });
    const store = makeStore();
    open(store, 'B');
    store.dispatch(castActions.latchAnalysisEra({ bookId: 'A' }));
    const p1 = store.dispatch(rehydrateCastAfterAnalysis('A'));
    const p2 = store.dispatch(rehydrateCastAfterAnalysis('A'));
    expect(p2).toBe(p1);
    await vi.advanceTimersByTimeAsync(1_000);
    await p1;
    expect(era(store, 'A')).toBeUndefined();
    expect(api.getBookState).not.toHaveBeenCalled();
    expect(api.getBookBusy).toHaveBeenCalledTimes(1);
  });
});

describe('the era waits for the open book read (round 1, Important 1)', () => {
  it('while the stage names the book but its full read is still out, the era is not cleared; then exactly one gate read', async () => {
    disk.seed('X', { state: {}, cast: { characters: [char('wren'), char('kestrel')] } });
    const store = makeStore();
    open(store, 'W', [char('owl')]);
    store.dispatch(castActions.latchAnalysisEra({ bookId: 'X' }));
    /* openBook(X): the stage names X; Layout's read of X is still out, so
       the slices hold W. The busy reply is [] meanwhile. */
    store.dispatch(uiActions.openBook({ id: 'X', status: 'voices_pending' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.getBookBusy).toHaveBeenCalledWith('X');
    expect(era(store, 'X')).toBeDefined();
    expect(api.getBookState).not.toHaveBeenCalled();
    expect(selectCastReadOnly(store.getState(), 'X')).toBe(true);
    /* Layout's read lands, carrying a cast from before the job's persist. */
    resetBookSlices(store.dispatch, 'X');
    store.dispatch(castActions.hydrateCharacters([char('wren')]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.getBookState).toHaveBeenCalledTimes(1);
    expect(era(store, 'X')).toBeUndefined();
    expect(store.getState().cast.characters.map((c) => c.id)).toEqual(['wren', 'kestrel']);
  });
});

describe('gate-up flushes, never withholds (B3)', () => {
  it('B3 lands: a unit queued just before the gate flushes and lands before the job registers', async () => {
    disk.seed('A', { state: {}, cast: { characters: [char('wren')] } });
    const store = makeStore();
    open(store, 'A', [char('wren')]);
    store.dispatch(castActions.setCharacters([char('wren'), char('lark')]));
    /* The analysis starts: the gate goes up and the queued unit goes now. */
    store.dispatch(analysisActions.setActiveStream(snap('A')));
    await settle();
    /* The job registers: every later cast PUT is refused. */
    disk.refuseNext('book_busy', (_id, req) => req.slice === 'cast');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(disk.books.get('A')!.cast).toEqual({ characters: [char('wren'), char('lark')] });
    expect(disk.log.filter((p) => p.slice === 'cast').map((p) => p.outcome)).toEqual(['ok']);
  });

  it("B3 409: a unit that meets the job gets the 409 — toast, era latched, and the run's added rows survive the re-hydrate", async () => {
    disk.seed('A', { state: {}, cast: { characters: [char('wren')] } });
    const store = makeStore();
    open(store, 'A', [char('wren')]);
    store.dispatch(castActions.setCharacters([char('wren'), char('lark')]));
    /* The job registered before the flush reached the server. */
    disk.refuseNext('book_busy', (_id, req) => req.slice === 'cast');
    busy = { A: ['analysis'] };
    store.dispatch(analysisActions.setActiveStream(snap('A')));
    await settle();
    expect(disk.log.filter((p) => p.slice === 'cast').map((p) => p.outcome)).toEqual(['refused']);
    expect(store.getState().notifications.toasts).toHaveLength(1);
    expect(era(store, 'A')).toBeDefined();

    /* The run adds a row, then ends. */
    disk.write('A', 'cast', { characters: [char('wren'), char('kestrel')] });
    busy = {};
    store.dispatch(analysisActions.clearActiveStream());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.getState().cast.characters.map((c) => c.id)).toEqual(['wren', 'kestrel']);
    expect(era(store, 'A')).toBeUndefined();
    expect(disk.books.get('A')!.cast).toEqual({ characters: [char('wren'), char('kestrel')] });
    expect(disk.log.filter((p) => p.slice === 'cast')).toHaveLength(1);
  });
});
