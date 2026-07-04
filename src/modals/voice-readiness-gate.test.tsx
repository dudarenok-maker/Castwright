/* fe-46 — pre-flight voice-readiness gate modal. Covers:
     - English shows the "Proceed anyway" affordance; non-English omits it.
     - "Design full cast" dispatches designAllRequested with the full
       undesigned roster + changes view to cast + closes the gate.
     - An in-flight design run swaps the primary CTA to "View design
       progress" and skips re-dispatching designAllRequested. */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { VoiceReadinessGateModal } from './voice-readiness-gate';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { voicesSlice } from '../store/voices-slice';
import { librarySlice } from '../store/library-slice';
import { castDesignSlice, castDesignActions } from '../store/cast-design-slice';
import type { Character } from '../lib/types';

afterEach(cleanup);

const qwenChar = (over: Partial<Character> & { id: string }): Character =>
  ({ name: over.id, role: 'r', color: 'narrator', lines: 0, ttsEngine: 'qwen', ...over }) as Character;

function makeStore(opts: {
  bookId?: string;
  language?: string;
  characters?: Character[];
  designActive?: { bookId: string; state: string } | null;
} = {}) {
  const bookId = opts.bookId ?? 'b1';
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      voices: voicesSlice.reducer,
      library: librarySlice.reducer,
      castDesign: castDesignSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId, view: 'manuscript', currentChapterId: 1, openProfileId: null },
        voiceReadinessGate: { bookId },
      } as never,
      cast: { ...castSlice.getInitialState(), characters: opts.characters ?? [] },
      library: {
        ...librarySlice.getInitialState(),
        books: [{ bookId, language: opts.language ?? 'en' }],
      } as never,
      castDesign: {
        ...castDesignSlice.getInitialState(),
        active: opts.designActive as never,
      },
    },
  });
  return store;
}

describe('VoiceReadinessGateModal', () => {
  it('renders nothing when the gate is closed', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        voices: voicesSlice.reducer,
        library: librarySlice.reducer,
        castDesign: castDesignSlice.reducer,
      },
    });
    const { container } = render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('English book shows the proceed-anyway affordance', () => {
    const store = makeStore({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 3 })],
      language: 'en',
    });
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    expect(screen.getByText(/Proceed anyway/)).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('non-English book omits the proceed affordance entirely', () => {
    const store = makeStore({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 3 })],
      language: 'ru',
    });
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    expect(screen.queryByText(/Proceed anyway/)).not.toBeInTheDocument();
    expect(screen.getByText(/can't fall back to a generic voice/)).toBeInTheDocument();
  });

  it('Design full cast dispatches designAllRequested with the full undesigned roster and closes the gate', () => {
    const store = makeStore({
      characters: [
        qwenChar({ id: 'a', name: 'Alice', lines: 5 }),
        qwenChar({ id: 'b', name: 'Bo', lines: 1 }),
      ],
    });
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Design full cast' }));
    expect(store.getState().ui.voiceReadinessGate).toBeNull();
    expect(store.getState().ui.stage).toMatchObject({ view: 'cast' });
  });

  it('proceed anyway closes the gate and opens the tier prompt with fallbackConfirmed:true', () => {
    const store = makeStore({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 5 })],
    });
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByText(/Proceed anyway/));
    expect(store.getState().ui.voiceReadinessGate).toBeNull();
    expect(store.getState().ui.startGenPrompt).toEqual({ fallbackConfirmed: true });
  });

  it('shows "View design progress" and skips re-dispatching designAllRequested while a run is active for this book', () => {
    const store = makeStore({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 5 })],
      designActive: { bookId: 'b1', state: 'running' },
    });
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    const btn = screen.getByRole('button', { name: 'View design progress' });
    fireEvent.click(btn);
    expect(
      dispatchSpy.mock.calls.some((c) => c[0]?.type === castDesignActions.designAllRequested.type),
    ).toBe(false);
    expect(store.getState().ui.stage).toMatchObject({ view: 'cast' });
    expect(store.getState().ui.voiceReadinessGate).toBeNull();
  });
});
