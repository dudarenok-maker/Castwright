/* Store wiring — composes slices into a single Redux Toolkit store. The
   URL ↔ ui.stage sync lives in src/components/layout.tsx and
   src/routes/index.tsx now (via react-router's createHashRouter).

   Persistence: `ui` and `manuscript` slices are wrapped via redux-persist
   so a page refresh keeps the user where they were instead of bouncing
   back to Books with an empty manuscript title. Whitelists are narrow on
   purpose — only the fields that survive the live-data churn well are
   persisted; sentences / sourceText / transient overlays (regen modal,
   stale-audio banner, etc.) intentionally don't round-trip. See
   `uiPersistConfig` / `manuscriptPersistConfig` below for the full list. */

import { configureStore } from '@reduxjs/toolkit';
import {
  useDispatch,
  useSelector,
  shallowEqual,
  type TypedUseSelectorHook,
} from 'react-redux';
import {
  persistReducer,
  persistStore,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  type PersistConfig,
} from 'redux-persist';
import storage from 'redux-persist/lib/storage';
import { uiSlice, type UiState } from './ui-slice';
import { accountSlice } from './account-slice';
import { castSlice } from './cast-slice';
import { chaptersSlice } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { manuscriptSlice, type ManuscriptState } from './manuscript-slice';
import { librarySlice } from './library-slice';
import { voicesSlice } from './voices-slice';
import { changeLogSlice } from './change-log-slice';
import { bookMetaSlice } from './book-meta-slice';
import { exportsSlice } from './exports-slice';
import { analysisSlice } from './analysis-slice';
import { notificationsSlice } from './notifications-slice';
import { listenProgressSlice } from './listen-progress-slice';
import { queueSlice } from './queue-slice';
import { persistenceMiddleware } from './persistence-middleware';
import { generationStreamMiddleware } from './generation-stream-middleware';
import { analysisStreamMiddleware } from './analysis-stream-middleware';
import { broadcastMiddleware } from './broadcast-middleware';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';

/** Persisted ui-slice keys. Stage so refresh restores the same view +
 *  chapter + drawer; model selectors so the user's per-session picks
 *  survive boot. Transient overlays (handoffApp, regenChapter,
 *  matchDetailFor, staleAudio, batchRegenIds, previewMode, ...) are
 *  deliberately omitted — restoring them would re-open dismissed
 *  modals on every refresh. */
export const UI_PERSIST_WHITELIST: ReadonlyArray<keyof UiState> = [
  'stage',
  'selectedModel',
  'ttsModelKey',
  'selectedModelExplicit',
  'ttsModelKeyExplicit',
  'themeOverride',
];

/** Persisted manuscript-slice keys. Just enough to render the top-bar
 *  + chapter header consistently before the per-book hydrate effect
 *  resolves; sentences / sourceText / importCandidate stay transient
 *  (server-sourced; persisting them risks stale wrong-book data
 *  briefly visible until hydrate completes). */
export const MANUSCRIPT_PERSIST_WHITELIST: ReadonlyArray<keyof ManuscriptState> = [
  'bookId',
  'manuscriptId',
  'title',
  'format',
  'wordCount',
];

/** Bump this when a future change to the persisted shape would mis-load
 *  an older blob (added required field, changed semantics of an existing
 *  field, etc.). Bumping the version causes redux-persist to ignore the
 *  old blob instead of merging it — the slice falls back to its
 *  initialState, which is the safe outcome for storage we don't know how
 *  to migrate. Pair with a `migrate:` config entry to do a real
 *  field-level migration when one is needed. */
const UI_PERSIST_VERSION = 2;
const MANUSCRIPT_PERSIST_VERSION = 1;

const uiPersistConfig: PersistConfig<UiState> = {
  key: 'ui',
  version: UI_PERSIST_VERSION,
  storage,
  /* Cast to mutable to satisfy redux-persist's PersistConfig (it widens
     to string[] internally). */
  whitelist: UI_PERSIST_WHITELIST as unknown as string[],
};

const manuscriptPersistConfig: PersistConfig<ManuscriptState> = {
  key: 'manuscript',
  version: MANUSCRIPT_PERSIST_VERSION,
  storage,
  whitelist: MANUSCRIPT_PERSIST_WHITELIST as unknown as string[],
};

const persistedUiReducer = persistReducer(uiPersistConfig, uiSlice.reducer);
const persistedManuscriptReducer = persistReducer(manuscriptPersistConfig, manuscriptSlice.reducer);

export const store = configureStore({
  reducer: {
    ui: persistedUiReducer,
    account: accountSlice.reducer,
    cast: castSlice.reducer,
    chapters: chaptersSlice.reducer,
    revisions: revisionsSlice.reducer,
    manuscript: persistedManuscriptReducer,
    library: librarySlice.reducer,
    voices: voicesSlice.reducer,
    changeLog: changeLogSlice.reducer,
    bookMeta: bookMetaSlice.reducer,
    exports: exportsSlice.reducer,
    analysis: analysisSlice.reducer,
    notifications: notificationsSlice.reducer,
    listenProgress: listenProgressSlice.reducer,
    queue: queueSlice.reducer,
  },
  middleware: (getDefault) =>
    getDefault({
      /* redux-persist dispatches lifecycle actions whose payload includes
       the persistor instance + a `rehydrate` callback — both non-
       serializable by design. Add the canonical action types to the
       ignore list so RTK's default serializableCheck doesn't fire a
       warning on every persisted slice's REHYDRATE. */
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }).concat(
      persistenceMiddleware,
      generationStreamMiddleware,
      analysisStreamMiddleware,
      broadcastMiddleware,
      queueDispatcherMiddleware,
    ),
});

/** Persistor for the store. Wrap the app in `<PersistGate>` from
 *  `redux-persist/integration/react` if you want to delay first render
 *  until rehydration completes; mounting without a gate is also
 *  supported (the slice starts at `initialState`, then redux-persist
 *  dispatches REHYDRATE which merges the persisted blob in). The latter
 *  is what `main.tsx` does today — the rehydrate ticks in fast enough
 *  that the user doesn't see the unpersisted initial state in
 *  practice. */
export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

/** Shallow-equal variant of `useAppSelector` (plan 89 C3). Wraps `useSelector`
 *  with react-redux's `shallowEqual` so a selector that returns an array /
 *  object only causes a re-render when at least one element / key changes
 *  identity — not on every parent dispatch.
 *
 *  Use this for selectors that read large slice arrays (e.g. `cast.characters`,
 *  `chapters.chapters`, `library.books`) or per-book sub-slices (e.g.
 *  `exports.byBookId[bookId]`). Do NOT use for scalar / single-value reads —
 *  the default referential equality is already optimal there.
 *
 *  Conversion sites (capped at five per plan 89):
 *  - `src/views/listen.tsx:122` — `s.exports.byBookId[bookId] ?? []` (Listen view's export-queue read; the array is recomputed on every other-book export tick).
 *  - `src/components/layout.tsx:82` — `s.cast.characters` (re-render on every reducer dispatch when array identity is stable).
 *  - `src/components/layout.tsx:83` — `s.chapters.chapters` (same — Layout is mounted on every route).
 *  - `src/components/layout.tsx:479` — `s.library.books` (large; drift-poll fan-out churns this every 30 / 120 s).
 *  - `src/routes/index.tsx:497` — `s.chapters.chapters` in ReadyViewSwitch (sister to layout but scoped to ready stage). */
export const useAppSelectorShallow: TypedUseSelectorHook<RootState> = (selector) =>
  useSelector(selector, shallowEqual);
