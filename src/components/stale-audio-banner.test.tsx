/* StaleAudioBanner — fires after a voice-edit Save when a character's
   voice/identity has drifted from the audio already on disk. Tests the
   render conditions + the regenerate dispatch chain. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { StaleAudioBanner } from './stale-audio-banner';
import type { Character } from '../lib/types';

vi.mock('../store', async () => {
  const actual = await vi.importActual<typeof import('../store')>('../store');
  return {
    ...actual,
    useAppDispatch: () => sharedStore.dispatch,
    useAppSelector: <T,>(sel: (s: ReturnType<typeof sharedStore.getState>) => T): T =>
      sel(sharedStore.getState()),
  };
});

let sharedStore: ReturnType<typeof makeStore>;

function makeStore() {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      chapters: chaptersSlice.reducer,
      changeLog: changeLogSlice.reducer,
    },
  });
}

const halloran: Character = {
  id: 'halloran',
  name: 'Halloran',
  role: 'PoV',
  color: 'narrator',
};

beforeEach(() => {
  sharedStore = makeStore();
  sharedStore.dispatch(castSlice.actions.setCharacters([halloran]));
  /* Seed chapters with halloran in their character map and a 'done' state
     so the chapters slice's regenerateCharacter loop has something to
     flip to 'in_progress' + populate pendingRegen with. */
  sharedStore.dispatch(
    chaptersSlice.actions.setChapters([
      {
        id: 1,
        title: 'Ch 1',
        duration: '00:30',
        state: 'done',
        progress: 1,
        characters: { halloran: 'done' },
      },
      {
        id: 2,
        title: 'Ch 2',
        duration: '00:30',
        state: 'done',
        progress: 1,
        characters: { halloran: 'done' },
      },
      {
        id: 3,
        title: 'Ch 3',
        duration: '00:30',
        state: 'done',
        progress: 1,
        characters: { halloran: 'done' },
      },
    ]),
  );
});

function renderBanner() {
  return render(
    <Provider store={sharedStore}>
      <StaleAudioBanner />
    </Provider>,
  );
}

describe('StaleAudioBanner', () => {
  it('renders nothing when ui.staleAudio is null', () => {
    const { container } = renderBanner();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when chapterIds is empty (no audio at risk)', () => {
    sharedStore.dispatch(
      uiSlice.actions.setStaleAudio({
        characterId: 'halloran',
        characterName: 'Halloran',
        chapterIds: [],
      }),
    );
    const { container } = renderBanner();
    expect(container.firstChild).toBeNull();
  });

  it('renders character name and chapter count when set', () => {
    sharedStore.dispatch(
      uiSlice.actions.setStaleAudio({
        characterId: 'halloran',
        characterName: 'Halloran',
        chapterIds: [1, 2, 3],
      }),
    );
    renderBanner();
    expect(screen.getByTestId('stale-audio-banner')).toBeInTheDocument();
    expect(screen.getByText(/Halloran/)).toBeInTheDocument();
    expect(screen.getByText(/3 chapters/)).toBeInTheDocument();
  });

  it('uses singular "chapter" for n=1', () => {
    sharedStore.dispatch(
      uiSlice.actions.setStaleAudio({
        characterId: 'halloran',
        characterName: 'Halloran',
        chapterIds: [1],
      }),
    );
    renderBanner();
    expect(screen.getByText(/1 chapter\b/)).toBeInTheDocument();
  });

  it('Regenerate now dispatches regenerateCharacter + clears banner + switches to generate view', () => {
    sharedStore.dispatch(
      uiSlice.actions.setStaleAudio({
        characterId: 'halloran',
        characterName: 'Halloran',
        chapterIds: [1, 3],
      }),
    );
    /* Need a ready stage for changeView to actually change anything;
       set one explicitly. */
    sharedStore.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'complete' }));
    sharedStore.dispatch(
      uiSlice.actions.setStaleAudio({
        characterId: 'halloran',
        characterName: 'Halloran',
        chapterIds: [1, 3],
      }),
    );

    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /Regenerate now/i }));

    const state = sharedStore.getState();
    /* Slice state confirms the dispatch chain landed: stale cleared,
       chapters slice carries pendingRegen for the right chapters, change
       log captured the event. */
    expect(state.ui.staleAudio).toBeNull();
    expect(state.chapters.pendingRegen?.chapterIds).toEqual([1, 3]);
    expect(state.chapters.pendingRegen?.force).toBe(true);
    expect(
      state.changeLog.events.some((e) => e.type === 'regenerate' && e.title?.includes('Halloran')),
    ).toBe(true);
    expect((state.ui.stage as { view?: string }).view).toBe('generate');
  });

  it('Dismiss clears the slice flag without dispatching regenerate', () => {
    sharedStore.dispatch(
      uiSlice.actions.setStaleAudio({
        characterId: 'halloran',
        characterName: 'Halloran',
        chapterIds: [1, 2],
      }),
    );
    renderBanner();
    fireEvent.click(screen.getByLabelText('Dismiss stale-audio banner'));

    const state = sharedStore.getState();
    expect(state.ui.staleAudio).toBeNull();
    expect(state.chapters.pendingRegen).toBeNull();
    expect(state.changeLog.events.some((e) => e.type === 'regenerate')).toBe(false);
  });
});
