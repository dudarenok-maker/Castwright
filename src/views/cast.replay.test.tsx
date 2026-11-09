/* Plan 291 (#4031), Task 17 — component half of the snapshot-time replay: the
   server-recorded cast-update frames (src/test-fixtures/analysis-cast-update-
   frames.json) are replayed into the real store (persistence + cast-gate
   middleware) under a running snapshot, then the Cast view and the profile
   drawer render from it. Save, rename and voice-assign must be aria-disabled
   and the paused banner present. The voiced, locked prior is test-seeded (the
   frames carry no voice fields); it mirrors `LEAD_WREN` in
   server/src/routes/analysis.single-matcher.test.ts. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent } from '@testing-library/react';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { castDesignSlice } from '../store/cast-design-slice';
import { analysisSlice, analysisActions } from '../store/analysis-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { bookBusySlice } from '../store/book-busy-slice';
import { voicesSlice } from '../store/voices-slice';
import { librarySlice } from '../store/library-slice';
import { voiceLibrarySlice } from '../store/voice-library-slice';
import { persistenceMiddleware } from '../store/persistence-middleware';
import { castGateMiddleware } from '../store/cast-gate';
import { resetBookSlices } from '../store/reset-book-slices';
import { CastView } from './cast';
import { ProfileDrawer } from '../modals/profile-drawer';
import fixture from '../test-fixtures/analysis-cast-update-frames.json';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    loadSidecar: vi.fn().mockResolvedValue({}),
    pauseCastDesign: vi.fn().mockResolvedValue(undefined),
    setCastTier: vi.fn().mockResolvedValue({ updated: 0 }),
    listMergeSuggestions: vi.fn().mockResolvedValue([]),
    listVoiceLibrary: vi.fn().mockResolvedValue({ voices: [] }),
    /* The run is live: busy lists the analysis and nothing re-reads the cast. */
    getBookBusy: vi.fn().mockResolvedValue(['analysis']),
    getBookState: vi.fn().mockResolvedValue(null),
    putBookState: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
  playBaseVoiceSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));
vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({ isPlaying: false, currentUrl: null, play: vi.fn(), stop: vi.fn(), pause: vi.fn() }),
}));

const BOOK = 'book-replay';
const frames = fixture.frames as Array<{ kind: 'cast-update'; characters: Character[] }>;

const PRIOR_CAST: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', voiceId: 'v-narrator', voiceState: 'generated', lines: 0, scenes: 0 },
  {
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
  },
];

const library: Voice[] = [
  {
    id: 'v-narrator-lib',
    character: 'Narrator',
    bookId: 'b-prev',
    bookTitle: 'Earlier Book',
    attributes: [],
    gradient: ['#E5B69C', '#C77B5C'],
    usedIn: 1,
    source: 'library',
    inCurrentSeries: true,
    ttsVoice: { provider: 'coqui', name: 'Aaron Dreschner', description: 'narrator' },
  },
];

function replayedStore() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      analysis: analysisSlice.reducer,
      notifications: notificationsSlice.reducer,
      bookBusy: bookBusySlice.reducer,
      voices: voicesSlice.reducer,
      library: librarySlice.reducer,
      voiceLibrary: voiceLibrarySlice.reducer,
    },
    middleware: (gd) =>
      gd({ serializableCheck: false, immutableCheck: false }).concat(persistenceMiddleware, castGateMiddleware),
  });
  store.dispatch(uiActions.openBook({ id: BOOK, status: 'voices_pending' }));
  resetBookSlices(store.dispatch, BOOK);
  store.dispatch(castActions.hydrateCharacters(PRIOR_CAST));
  store.dispatch(
    analysisActions.setActiveStream({
      bookId: BOOK,
      manuscriptId: `m-${BOOK}`,
      phaseId: 0,
      phaseLabel: 'Detecting characters',
      phaseProgress: 0,
      remainingMs: null,
      lastTickAt: 0,
      state: 'running',
    }),
  );
  for (const frame of frames) store.dispatch(castActions.replaceLiveRoster(frame.characters, { bookId: BOOK }));
  return store;
}

describe('replay (during run) - component', () => {
  it("component: with the replayed store, the Cast view's Save, rename and voice-assign controls render aria-disabled and the banner is present", () => {
    const store = replayedStore();
    const characters = store.getState().cast.characters;
    const wren = characters.find((c) => c.id === 'w2')!;
    expect(wren.name).toBe('Wren');
    const onSave = vi.fn();
    const onRename = vi.fn();
    render(
      <Provider store={store}>
        <CastView
          characters={characters}
          setCharacters={() => {}}
          library={library}
          title="Replay"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
          onContinueToManuscript={() => {}}
        />
        <ProfileDrawer
          character={wren}
          bookId={BOOK}
          voice={undefined}
          onClose={() => {}}
          onSave={onSave}
          onLock={() => {}}
          onRename={onRename}
        />
      </Provider>,
    );

    /* the visible banner, on the Cast view and on the drawer */
    const banners = screen.getAllByTestId('cast-edits-paused-banner');
    expect(banners.length).toBeGreaterThanOrEqual(2);
    for (const b of banners) expect(b).toHaveTextContent('Re-analysis running — cast edits are paused');

    /* voice-assign */
    const assign = screen.getAllByRole('button', { name: /^Assign Narrator to a character$/ })[0];
    expect(assign).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(assign);
    expect(screen.queryByTestId('tap-assign-banner')).toBeNull();

    /* Save and rename */
    const save = screen.getByRole('button', { name: /^Save changes$/ });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    const rename = screen.getByRole('button', { name: 'Rename character' });
    expect(rename).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(rename);
    expect(screen.queryByRole('textbox', { name: 'Character name' })).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});
