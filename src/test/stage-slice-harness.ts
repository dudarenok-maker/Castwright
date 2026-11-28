/* #3519 — a harness that moves the stage and the slices independently.

   The stage names a book at once; the cast, chapters and manuscript slices hold
   one only once its read lands. `moveStage` moves the first, `holdBook` the
   second, so a test can settle a late async result between any two of those
   states. The store is built from the app's real slice reducers.

   Every fixture book shares its character, chapter and sentence ids with every
   other (as books of one series do), so a write meant for one book is visible
   when it lands on another's rows. Titles, names and text carry the book id. */

import {
  combineReducers,
  configureStore,
  type Middleware,
  type ThunkDispatch,
  type UnknownAction,
} from '@reduxjs/toolkit';
import { expect } from 'vitest';
import { uiSlice, uiActions } from '../store/ui-slice';
import { settingsSlice } from '../store/settings-slice';
import { accountSlice } from '../store/account-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { bookBusySlice } from '../store/book-busy-slice';
import { chaptersSlice, chaptersActions } from '../store/chapters-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { loadedBookSlice } from '../store/loaded-book-slice';
import { librarySlice } from '../store/library-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { exportsSlice } from '../store/exports-slice';
import { analysisSlice } from '../store/analysis-slice';
import { castDesignSlice } from '../store/cast-design-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { listenProgressSlice } from '../store/listen-progress-slice';
import { queueSlice } from '../store/queue-slice';
import { rebaselineSlice } from '../store/rebaseline-slice';
import { upgradeSlice } from '../store/upgrade-slice';
import { spliceSlice } from '../store/splice-slice';
import { qaRepairSlice } from '../store/qa-repair-slice';
import { configSlice } from '../store/config-slice';
import { tourSlice } from '../store/tour-slice';
import { continueListeningSlice } from '../store/continue-listening-slice';
import { scriptReviewSlice } from '../store/script-review-slice';
import { prosodySlice } from '../store/prosody-slice';
import { voiceLibrarySlice } from '../store/voice-library-slice';
import type { RootState } from '../store';
import type { Chapter, Character, Sentence, Stage } from '../lib/types';

const reducer = combineReducers({
  ui: uiSlice.reducer,
  settings: settingsSlice.reducer,
  account: accountSlice.reducer,
  cast: castSlice.reducer,
  bookBusy: bookBusySlice.reducer,
  chapters: chaptersSlice.reducer,
  revisions: revisionsSlice.reducer,
  manuscript: manuscriptSlice.reducer,
  loadedBook: loadedBookSlice.reducer,
  library: librarySlice.reducer,
  voices: voicesSlice.reducer,
  changeLog: changeLogSlice.reducer,
  bookMeta: bookMetaSlice.reducer,
  exports: exportsSlice.reducer,
  analysis: analysisSlice.reducer,
  castDesign: castDesignSlice.reducer,
  notifications: notificationsSlice.reducer,
  listenProgress: listenProgressSlice.reducer,
  queue: queueSlice.reducer,
  rebaseline: rebaselineSlice.reducer,
  upgrade: upgradeSlice.reducer,
  splice: spliceSlice.reducer,
  qaRepair: qaRepairSlice.reducer,
  config: configSlice.reducer,
  tour: tourSlice.reducer,
  continueListening: continueListeningSlice.reducer,
  scriptReview: scriptReviewSlice.reducer,
  prosody: prosodySlice.reducer,
  voiceLibrary: voiceLibrarySlice.reducer,
});

/** The fixture manuscript id of a book. */
export const manuscriptIdOf = (bookId: string): string => `m-${bookId}`;

/** The fixture roster: the same ids in every book, names carrying the book id. */
export function bookCast(bookId: string): Character[] {
  const row = (id: string, name: string, extra: Partial<Character> = {}): Character => ({
    id,
    name: `${name} of ${bookId}`,
    role: 'Supporting',
    color: 'peach',
    voiceId: `v-${id}`,
    ...extra,
  });
  return [
    row('narrator', 'Narrator', { role: 'Narrator' }),
    /* A designed Qwen voice from My voices, an emotion variant, an alias, a
       "not the same person" mark and no persona: each is something a writer
       changes or removes. */
    row('wren', 'Wren', {
      ttsEngine: 'qwen',
      overrideTtsVoices: {
        qwen: {
          name: 'qwen-v-wren',
          libraryUuid: 'lib1',
          provenance: 'designed',
          variants: { angry: { name: 'qwen-v-wren__angry' } },
        },
      },
      aliases: ['Birdie'],
      notLinkedTo: [{ bookId: 'prior', characterId: 'p-wren' }],
    } as Partial<Character>),
    row('moss', 'Moss', {
      matchedFrom: { bookId: 'prior', characterId: 'p-moss', bookTitle: 'Prior', confidence: 0.9 },
    }),
  ];
}

/** Both orphan ids carry a rejection against `wren`, so undo has one to clear. */
const bookOrphans = () => ({
  ghost: {
    resolution: 'unresolved' as const,
    segments: 2,
    audioCurrent: 'false' as const,
    rejectedAgainst: ['wren'],
  },
});

export function bookChapters(bookId: string): Chapter[] {
  return [1, 2, 3].map(
    (id) =>
      ({
        id,
        title: `Chapter ${id} of ${bookId}`,
        slug: `0${id}`,
        duration: '1:00',
        /* 1 rendered, 2 excluded (the Include button), 3 queued (Cancel's hold). */
        state: id === 3 ? 'queued' : 'done',
        progress: id === 3 ? 0 : 1,
        excluded: id === 2,
        characters: { narrator: 'done', wren: 'done' },
      }) as unknown as Chapter,
  );
}

export function bookSentences(bookId: string): Sentence[] {
  return [
    { id: 1, chapterId: 1, characterId: 'narrator', text: `Opening of ${bookId}.` },
    { id: 2, chapterId: 1, characterId: 'wren', text: `Wren speaks in ${bookId}.` },
    { id: 1, chapterId: 2, characterId: 'moss', text: `Moss speaks in ${bookId}.` },
  ] as Sentence[];
}

export function createStageSliceHarness(opts: { middleware?: Middleware[] } = {}) {
  const base = configureStore({
    reducer,
    middleware: (getDefault) =>
      getDefault({ serializableCheck: false, immutableCheck: false }).concat(
        opts.middleware ?? [],
      ),
  });
  const store = base as Omit<typeof base, 'getState' | 'dispatch'> & {
    getState: () => RootState;
    dispatch: ThunkDispatch<RootState, undefined, UnknownAction>;
  };

  /** Make the three slices hold `bookId`, the way the layout's full read does:
      the real manuscript hydrate first (it moves the loaded-book pair), then the
      cast and chapters hydrates in the same tick. */
  function holdBook(bookId: string, manuscriptId: string = manuscriptIdOf(bookId)): void {
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId, manuscriptId, title: `Book ${bookId}` },
        sentences: bookSentences(bookId),
      } as unknown as Parameters<typeof manuscriptActions.hydrateFromBookState>[0]),
    );
    store.dispatch(castActions.hydrateCharacters(bookCast(bookId)));
    store.dispatch(castActions.setRenderedFallback({}));
    store.dispatch(castActions.setOrphanedCharacterFallbacks(bookOrphans()));
    store.dispatch(chaptersActions.setChapters(bookChapters(bookId)));
    store.dispatch(chaptersActions.setCurrentBookId(bookId));
  }

  /** Move the stage only; the slices keep whatever they hold. */
  function moveStage(stage: Stage): void {
    store.dispatch(uiActions.hydrateFromUrl(stage));
  }

  /** The held book's content in the three slices. Left out: the maps keyed by
      their own book id (a background run's progress pill, an analysis latch),
      which a late result for another book may rightly move. */
  function snapshot() {
    const { cast, chapters, manuscript } = store.getState();
    const { analysisEra: _era, ...castRows } = cast;
    const { activeStreams: _streams, scoringProgress: _scoring, ...chapterRows } = chapters;
    return structuredClone({ cast: castRows, chapters: chapterRows, manuscript });
  }

  function expectUnchanged(before: ReturnType<typeof snapshot>): void {
    expect(snapshot()).toEqual(before);
  }

  return { store, holdBook, moveStage, snapshot, expectUnchanged };
}

export type StageSliceHarness = ReturnType<typeof createStageSliceHarness>;
