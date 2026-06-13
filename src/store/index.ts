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
// Import the ESM build of the storage engine. The CJS `lib/storage` default
// export (`exports.default = createWebStorage('local')`) is left wrapped as a
// namespace by Vite 8 / Rolldown's interop, so `storage.getItem` came back
// undefined and redux-persist threw at rehydrate (fe-19). The `es/` build uses
// a real `export default`, which Rolldown unwraps correctly — and matches how
// the main `redux-persist` import already resolves (its `module` field is es/).
import storage from 'redux-persist/es/storage';
import { uiSlice, type UiState } from './ui-slice';
import { settingsSlice, type SettingsState } from './settings-slice';
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
import { castDesignSlice } from './cast-design-slice';
import { notificationsSlice } from './notifications-slice';
import { listenProgressSlice } from './listen-progress-slice';
import { queueSlice } from './queue-slice';
import { rebaselineSlice } from './rebaseline-slice';
import { upgradeSlice } from './upgrade-slice';
import { spliceSlice } from './splice-slice';
import { configSlice } from './config-slice';
import { tourSlice } from './tour-slice';
import { persistenceMiddleware } from './persistence-middleware';
import { generationStreamMiddleware } from './generation-stream-middleware';
import { analysisStreamMiddleware } from './analysis-stream-middleware';
import { castDesignMiddleware } from './cast-design-stream-middleware';
import { broadcastMiddleware } from './broadcast-middleware';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';
import { spliceRunnerMiddleware } from './splice-runner-middleware';
import { exportPollMiddleware } from './exports-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';

/** Persisted ui-slice keys. Stage so refresh restores the same view +
 *  chapter + drawer; the TTS engine pick so the chosen voice engine
 *  survives boot. Transient overlays (regenChapter, matchDetailFor,
 *  staleAudio, previewRegen, previewMode, ...) are deliberately omitted —
 *  restoring them would re-open dismissed modals on every refresh.
 *
 *  NOTE — the analyzer model selectors (`selectedModel` /
 *  `selectedModelExplicit`) are intentionally NOT persisted. They are a
 *  per-run override; persisting them let an explicit pick (e.g. qwen3.5:4b
 *  chosen to dodge a Gemini recitation block) silently shadow the saved
 *  `analysisEngine`/`defaultAnalysisModel` on every later run, across
 *  reloads and books, with no UI signal. Leaving them transient means a
 *  reload reverts to the saved default; the override badge surfaces it
 *  within a session. See src/store/persist-whitelist.test.ts. */
export const UI_PERSIST_WHITELIST: ReadonlyArray<keyof UiState> = [
  'stage',
  'ttsModelKey',
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
/* v3 — drop the persisted analyzer-model override (selectedModel /
   selectedModelExplicit). The migrate below strips it from existing v2
   blobs so a value stuck from before the fix (e.g. qwen3.5:4b) clears on
   upgrade WITHOUT resetting the still-persisted stage / TTS / theme keys. */
const UI_PERSIST_VERSION = 3;
const MANUSCRIPT_PERSIST_VERSION = 1;

/* fe-2 — the whole settings slice persists device-local (every field is a
   per-browser preference). Bump when the shape changes incompatibly. */
const SETTINGS_PERSIST_VERSION = 1;

const uiPersistConfig: PersistConfig<UiState> = {
  key: 'ui',
  version: UI_PERSIST_VERSION,
  storage,
  /* Cast to mutable to satisfy redux-persist's PersistConfig (it widens
     to string[] internally). */
  whitelist: UI_PERSIST_WHITELIST as unknown as string[],
  /* v2→v3: strip the no-longer-persisted analyzer-model override from any
     existing blob so a pre-fix stuck value (e.g. qwen3.5:4b silently
     shadowing the saved Gemini default) is cleared on first load after the
     upgrade. Returning the same blob minus those two keys preserves the
     other persisted prefs (stage / TTS engine / theme). */
  migrate: (state) => {
    if (state && typeof state === 'object') {
      const s = state as Record<string, unknown>;
      delete s.selectedModel;
      delete s.selectedModelExplicit;
    }
    return Promise.resolve(state);
  },
};

const manuscriptPersistConfig: PersistConfig<ManuscriptState> = {
  key: 'manuscript',
  version: MANUSCRIPT_PERSIST_VERSION,
  storage,
  whitelist: MANUSCRIPT_PERSIST_WHITELIST as unknown as string[],
};

/* No whitelist: every settings field is a persisted preference. */
const settingsPersistConfig: PersistConfig<SettingsState> = {
  key: 'settings',
  version: SETTINGS_PERSIST_VERSION,
  storage,
};

const persistedUiReducer = persistReducer(uiPersistConfig, uiSlice.reducer);
const persistedManuscriptReducer = persistReducer(manuscriptPersistConfig, manuscriptSlice.reducer);
const persistedSettingsReducer = persistReducer(settingsPersistConfig, settingsSlice.reducer);

/* Single shared SSE-stream runner (plan 102 Should #6). Both the
   generation-stream-middleware (same-book opens) and the
   queue-dispatcher-middleware (cross-book opens) drive ONE runner instance,
   so the "only one SSE at a time" invariant + the cross-book activeStream
   snapshot live in exactly one place. The runner needs the store's
   dispatch/getState, which only exist after configureStore returns — so the
   middlewares receive a lazy `getStreamRunner` accessor (called at action
   time, by which point `streamRunnerInstance` is assigned). */
let streamRunnerInstance: StreamRunner | null = null;
const getStreamRunner = (): StreamRunner => {
  if (!streamRunnerInstance) {
    throw new Error('stream runner accessed before store initialisation');
  }
  return streamRunnerInstance;
};

export const store = configureStore({
  reducer: {
    ui: persistedUiReducer,
    settings: persistedSettingsReducer,
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
    castDesign: castDesignSlice.reducer,
    notifications: notificationsSlice.reducer,
    listenProgress: listenProgressSlice.reducer,
    queue: queueSlice.reducer,
    rebaseline: rebaselineSlice.reducer,
    upgrade: upgradeSlice.reducer,
    splice: spliceSlice.reducer,
    config: configSlice.reducer,
    tour: tourSlice.reducer,
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
      generationStreamMiddleware(getStreamRunner),
      analysisStreamMiddleware,
      castDesignMiddleware,
      broadcastMiddleware,
      queueDispatcherMiddleware(getStreamRunner),
      spliceRunnerMiddleware(),
      exportPollMiddleware,
    ),
});

/* Bind the shared runner now that the store (dispatch + getState) exists.
   Safe before the first action dispatches — middleware bodies only call
   `getStreamRunner()` at action time. */
streamRunnerInstance = createStreamRunner(store);

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
