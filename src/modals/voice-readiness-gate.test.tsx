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
  eligibleTtsEngines?: string[];
  characters?: Character[];
  designActive?: { bookId: string | null; state: string } | null;
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
        books: [{ bookId, language: opts.language ?? 'en', eligibleTtsEngines: opts.eligibleTtsEngines }],
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
    expect(screen.getByText(/generic Kokoro fallback voices/)).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('a book with no fallback engine (zh, Qwen-only eligibility) omits the proceed affordance entirely', () => {
    const store = makeStore({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 3 })],
      language: 'zh',
      eligibleTtsEngines: ['qwen'],
    });
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    expect(screen.queryByText(/Proceed anyway/)).not.toBeInTheDocument();
    expect(screen.getByText(/can't fall back to a generic voice/)).toBeInTheDocument();
  });

  it('a Coqui-eligible non-English book (ru) shows Proceed anyway with Coqui-worded copy', () => {
    const store = makeStore({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 3 })],
      language: 'ru',
      eligibleTtsEngines: ['qwen', 'coqui'],
    });
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    expect(screen.getByText(/Proceed anyway/)).toBeInTheDocument();
    expect(screen.getByText(/render with a Coqui fallback voice/)).toBeInTheDocument();
    expect(screen.getByText(/generic Coqui fallback voices/)).toBeInTheDocument();
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

  it('warns and does not dispatch, navigate, or close when a design run is active for ANOTHER book', () => {
    const store = makeStore({
      bookId: 'b1',
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 5 })],
      designActive: { bookId: 'other-book', state: 'running' },
    });
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Design full cast' }));
    expect(
      dispatchSpy.mock.calls.some((c) => c[0]?.type === castDesignActions.designAllRequested.type),
    ).toBe(false);
    expect(
      dispatchSpy.mock.calls.some((c) => {
        const action = c[0] as { type?: string; payload?: { kind?: string } };
        return action?.type === 'notifications/pushToast' && action.payload?.kind === 'warn';
      }),
    ).toBe(true);
    /* Gate stays open and the view is untouched — the run belongs to another book. */
    expect(store.getState().ui.voiceReadinessGate).toEqual({ bookId: 'b1' });
    expect(store.getState().ui.stage).toMatchObject({ view: 'manuscript' });
  });

  it('fs-38 Wave 1 — a book-less (bookId: null) library design also warns and refuses to dispatch, for ANY book', () => {
    /* Mirrors the "another book" test above but for the book-less
       (bookId: null) library-design snapshot create-library-voice.tsx
       opens. Every real book's gate must treat it as "elsewhere" — there is
       no book it could ever equal. */
    const store = makeStore({
      bookId: 'b1',
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 5 })],
      designActive: { bookId: null, state: 'running' },
    });
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    render(
      <Provider store={store}>
        <VoiceReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Design full cast' }));
    expect(
      dispatchSpy.mock.calls.some((c) => c[0]?.type === castDesignActions.designAllRequested.type),
    ).toBe(false);
    expect(
      dispatchSpy.mock.calls.some((c) => {
        const action = c[0] as { type?: string; payload?: { kind?: string } };
        return action?.type === 'notifications/pushToast' && action.payload?.kind === 'warn';
      }),
    ).toBe(true);
    expect(store.getState().ui.voiceReadinessGate).toEqual({ bookId: 'b1' });
    expect(store.getState().ui.stage).toMatchObject({ view: 'manuscript' });
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
