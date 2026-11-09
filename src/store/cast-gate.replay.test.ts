/* Plan 291 (#4031), Task 17 — snapshot-time client replay: the cast-update
   frames the server recorded for a re-analysis (Task 16's fixture) are fed to
   the client's per-book cast gate the way the analysing view feeds them.

   `cast-update` frames are view-only (the stream middleware does not consume
   them, analysis-stream-middleware.ts), so the replay dispatches the view's own
   action per committed frame: `replaceLiveRoster(frame.characters, { bookId })`,
   exactly as `analysing.tsx` does, under a running analysis snapshot.

   The frames are live-view rosters: they carry no voice and no lock. The
   voiced, locked prior below is therefore TEST-SEEDED, not read from the
   fixture; it mirrors `LEAD_WREN` in
   server/src/routes/analysis.single-matcher.test.ts (the prior the server
   joins by name to the fixture's `w2` / "Wren" row, alias "Wren Ashby"). That is
   the hazard the gate exists for: before it, a voiceless live roster could be
   saved over the user's voiced, locked prior. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

/* Every api call is recorded; the three the cast path uses are served. */
const requests = vi.hoisted(() => [] as Array<{ name: string; args: unknown[] }>);
const api = vi.hoisted(() => ({
  getBookBusy: vi.fn(),
  getBookState: vi.fn(),
  putBookState: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  api: new Proxy(api, {
    get(target, name: string) {
      const fn = target[name as keyof typeof target];
      if (!fn) return fn;
      return (...args: unknown[]) => {
        requests.push({ name, args });
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    },
  }),
}));

import { castGateMiddleware, selectCastReadOnly } from './cast-gate';
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
import fixture from '../test-fixtures/analysis-cast-update-frames.json';
import type { Character, PutStateRequest } from '../lib/types';

const BOOK = 'book-replay';
const frames = fixture.frames as Array<{ kind: 'cast-update'; characters: Character[] }>;

/* The voiced, locked prior (test-seeded; see the header). */
const PRIOR_WREN: Character = {
  id: 'w2',
  name: 'Wren',
  role: 'lead',
  color: '#111111',
  gender: 'female',
  aliases: ['Wren Ashby'],
  voiceId: 'v-wren-locked',
  voiceState: 'locked',
  ttsEngine: 'qwen',
  overrideTtsVoices: { qwen: { name: 'qwen-wren-locked' } },
  lines: 0,
  scenes: 0,
};
const PRIOR_NARRATOR: Character = {
  id: 'narrator',
  name: 'Narrator',
  role: 'narrator',
  color: 'narrator',
  voiceId: 'v-narrator',
  voiceState: 'generated',
  lines: 0,
  scenes: 0,
};
const PRIOR_CAST = [PRIOR_NARRATOR, PRIOR_WREN];
const VOICE_MARKERS = ['v-wren-locked', 'qwen-wren-locked'];

const snap = (over: Partial<AnalysisStreamSnapshot> = {}): AnalysisStreamSnapshot => ({
  bookId: BOOK,
  manuscriptId: `m-${BOOK}`,
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

/* What Layout does on opening a book: name it on the stage, reset the slices
   to it, hydrate its disk cast. */
function openWithPrior(store: Store) {
  store.dispatch(uiActions.openBook({ id: BOOK, status: 'voices_pending' }));
  resetBookSlices(store.dispatch, BOOK);
  store.dispatch(castActions.hydrateCharacters(PRIOR_CAST));
}

let busy: string[];
let disk: BookStateDisk;

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  busy = ['analysis'];
  disk = createBookStateDisk();
  disk.seed(BOOK, { state: {}, cast: { characters: PRIOR_CAST } });
  api.getBookBusy.mockReset().mockImplementation(async () => busy);
  api.putBookState.mockReset().mockImplementation((bookId: string, req: PutStateRequest) => disk.serve(bookId, req));
  api.getBookState.mockReset().mockImplementation(async (bookId: string) => {
    const b = disk.books.get(bookId);
    return b ? { state: b.state, cast: b.cast } : null;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const puts = () => requests.filter((r) => r.name === 'putBookState');
const castPuts = () => puts().filter((r) => (r.args[1] as PutStateRequest).slice === 'cast');

/* Every cast edit action, aimed at a row of the frame just replayed. */
function editEveryWay(store: Store, row: Character) {
  store.dispatch(castActions.renameCharacter({ characterId: row.id, name: `${row.name} (renamed)` }));
  store.dispatch(castActions.updateCharacter({ ...row, role: 'edited' }));
  store.dispatch(castActions.setCharacters([{ ...row, name: 'Set by user' }]));
  store.dispatch(
    castActions.applyVoiceMatches({
      matches: [
        {
          characterId: row.id,
          candidates: [
            {
              voiceId: 'v-other',
              fromBookId: 'b-other',
              fromCharacterId: 'c-other',
              fromBookTitle: 'Other',
              score: 0.9,
              factors: [],
            },
          ],
        },
      ],
    } as never),
  );
  store.dispatch(castActions.lockVoice(row.id));
  store.dispatch(castActions.declineMatch(row.id));
}

describe('replay (during run)', () => {
  it('after each frame, every cast edit action (rename, updateCharacter, setCharacters, applyVoiceMatches, lockVoice, declineMatch) produces no request and one deduped toast', async () => {
    expect(frames).toHaveLength(4);
    const store = makeStore();
    openWithPrior(store);
    store.dispatch(analysisActions.setActiveStream(snap()));
    const before = requests.length;

    for (const frame of frames) {
      store.dispatch(castActions.replaceLiveRoster(frame.characters, { bookId: BOOK }));
      expect(selectCastReadOnly(store.getState(), BOOK)).toBe(true);
      const row = store.getState().cast.characters.find((c) => c.role === 'lead')!;
      editEveryWay(store, row);
      await vi.advanceTimersByTimeAsync(2000);
      expect(puts()).toHaveLength(0);
      expect(castPuts()).toHaveLength(0);
      const toasts = store.getState().notifications.toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({ message: "Re-analysis running — that change wasn't saved", dedupeKey: 'cast-read-only' });
    }
    /* Nothing but the gate's own reads: no write of any kind. */
    expect(requests.slice(before).filter((r) => r.name !== 'getBookBusy')).toEqual([]);
  });

  it('a voiced, locked, name-joined prior is never sent anywhere', async () => {
    const store = makeStore();
    openWithPrior(store);
    store.dispatch(analysisActions.setActiveStream(snap()));

    for (const frame of frames) {
      store.dispatch(castActions.replaceLiveRoster(frame.characters, { bookId: BOOK }));
      editEveryWay(store, store.getState().cast.characters.find((c) => c.role === 'lead')!);
    }
    /* The last frame is the name-joined one: the prior's id, the analyzer's
       own name kept as an alias. */
    const last = frames[frames.length - 1].characters.find((c) => c.id === PRIOR_WREN.id)!;
    expect(last.name).toBe(PRIOR_WREN.name);
    expect(last.aliases).toContain('Wren Ashby');

    /* Run the clock well past every debounce, retry and flush. */
    await vi.advanceTimersByTimeAsync(60_000);
    expect(castPuts()).toHaveLength(0);
    const sent = JSON.stringify(requests.map((r) => r.args));
    for (const marker of VOICE_MARKERS) expect(sent).not.toContain(marker);
    /* ...nor did the prior on disk change. */
    expect(disk.books.get(BOOK)!.cast).toEqual({ characters: PRIOR_CAST });

    /* Positive control: once the gate releases, the prior is re-read from disk
       and an ordinary edit DOES send a cast PUT carrying its voice and lock, so
       the recorder above is able to see such a save. */
    busy = [];
    store.dispatch(analysisActions.clearActiveStream());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(selectCastReadOnly(store.getState(), BOOK)).toBe(false);
    expect(store.getState().cast.characters.find((c) => c.id === 'w2')).toMatchObject({
      voiceId: 'v-wren-locked',
      voiceState: 'locked',
    });
    expect(castPuts()).toHaveLength(0);
    store.dispatch(castActions.renameCharacter({ characterId: 'w2', name: 'Wren B' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(castPuts().length).toBeGreaterThan(0);
    const body = JSON.stringify(castPuts().map((r) => r.args[1]));
    expect(body).toContain('v-wren-locked');
    expect(body).toContain('qwen-wren-locked');
    expect(body).toContain('"voiceState":"locked"');
  });
});
