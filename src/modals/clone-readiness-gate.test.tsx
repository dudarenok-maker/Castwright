/* Plan 276 (fs-cast-readiness), Task 7 — the cast-time clone-readiness gate
   modal. Decision 1's CTA table is the contract: a gate offering only
   Proceed and Cancel does not implement it and must fail review, so "CTA
   presence" is asserted per-reason, never generically ("a fix CTA is
   rendered when one exists" is satisfiable by a single always-on button).

   `selectCloneReadinessVerdicts` is mocked — it has its own exhaustive
   suite at `src/store/clone-readiness-selectors.test.ts` (rule 7 silence,
   the C1 regression, the characterHasSlot trap, etc.); this file's job is
   the CONSUMER: given a verdict, does the modal render the right row, the
   right CTA, and nothing else. */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup, waitFor, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { CloneReadinessGateModal } from './clone-readiness-gate';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { voiceLibrarySlice } from '../store/voice-library-slice';
import { settingsSlice } from '../store/settings-slice';
import { DEFAULT_AUTOSAVE_DEBOUNCE_MS } from '../store/settings-slice';
import type { Character } from '../lib/types';
import type { CloneCharacterVerdict } from '../store/clone-readiness-selectors';

afterEach(cleanup);

let mockVerdicts: CloneCharacterVerdict[] = [];
vi.mock('../store/clone-readiness-selectors', () => ({
  selectCloneReadinessVerdicts: () => mockVerdicts,
}));

const patchVoiceLibrary = vi.fn().mockResolvedValue({ voiceUuid: 'v1' });
const retryCloneEngine = vi.fn().mockResolvedValue({ voiceUuid: 'v1' });
vi.mock('../lib/api', () => ({
  api: {
    patchVoiceLibrary: (...a: unknown[]) => patchVoiceLibrary(...a),
    retryCloneEngine: (...a: unknown[]) => retryCloneEngine(...a),
  },
}));

function verdict(over: Partial<CloneCharacterVerdict> & { characterId: string }): CloneCharacterVerdict {
  return {
    characterName: over.characterId,
    engine: 'qwen',
    reason: 'no-transcript',
    castOnEngine: null,
    ...over,
  };
}

function char(over: Partial<Character> & { id: string }): Character {
  return { name: over.id, role: 'r', color: 'narrator', lines: 0, ...over } as Character;
}

function makeStore(opts: { gate?: { bookId: string } | null; characters?: Character[]; autosaveDebounceMs?: number } = {}) {
  const baseSettings = settingsSlice.getInitialState();
  const settingsState = {
    ...baseSettings,
    autosaveDebounceMs: opts.autosaveDebounceMs ?? baseSettings.autosaveDebounceMs,
  };
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      voiceLibrary: voiceLibrarySlice.reducer,
      settings: settingsSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId: 1, openProfileId: null },
        cloneReadinessGate: opts.gate === undefined ? { bookId: 'b1' } : opts.gate,
      } as never,
      cast: { ...castSlice.getInitialState(), characters: opts.characters ?? [] },
      voiceLibrary: voiceLibrarySlice.getInitialState(),
      settings: settingsState,
    },
  });
}

function ctaButtonsIn(row: HTMLElement): string[] {
  return within(row)
    .queryAllByRole('button')
    .map((b) => b.textContent ?? '');
}

describe('CloneReadinessGateModal', () => {
  it('renders nothing when the gate is closed', () => {
    const store = makeStore({ gate: null });
    const { container } = render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the character and the engine the render will use', () => {
    mockVerdicts = [verdict({ characterId: 'c1', characterName: 'Alice', engine: 'qwen', reason: 'derive-failed' })];
    const store = makeStore({ characters: [char({ id: 'c1', name: 'Alice' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(within(row).getByText('Alice')).toBeInTheDocument();
    expect(within(row).getByText('Qwen')).toBeInTheDocument();
  });

  it('no-transcript renders "Add transcript" and no other CTA', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'no-transcript', engine: 'qwen' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(ctaButtonsIn(row)).toEqual(['Add transcript']);
  });

  it('derive-failed renders "Retry derive" and no other CTA', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'derive-failed', engine: 'coqui' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(ctaButtonsIn(row)).toEqual(['Retry derive']);
  });

  it('missing-entry renders "Assign a different voice" and no other CTA', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'missing-entry', engine: 'kokoro' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(ctaButtonsIn(row)).toEqual(['Assign a different voice']);
  });

  it('unresolvable-uuid renders "Assign a different voice" and no other CTA — reuses missing-entry\'s CTA per the repo owner\'s decision', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'unresolvable-uuid', engine: 'kokoro' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(ctaButtonsIn(row)).toEqual(['Assign a different voice']);
  });

  it('revoked renders explanatory copy and NO CTA at all', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'revoked', engine: 'qwen' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(ctaButtonsIn(row)).toEqual([]);
    expect(within(row).getByText(/withdrawn consent/i)).toBeInTheDocument();
  });

  it('missing-master renders explanatory copy and NO CTA at all', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'missing-master', engine: 'qwen' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(ctaButtonsIn(row)).toEqual([]);
    expect(within(row).getByText(/missing its original recording/i)).toBeInTheDocument();
  });

  it('wrong-engine with a non-null castOnEngine renders a "Cast on <engine>" button that NAMES that engine', () => {
    mockVerdicts = [
      verdict({ characterId: 'c1', reason: 'wrong-engine', engine: 'kokoro', castOnEngine: 'coqui' }),
    ];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(within(row).getByRole('button', { name: 'Cast on Coqui' })).toBeInTheDocument();
    /* Not the OTHER clone-capable engine — the blind-swap bug this replaced. */
    expect(within(row).queryByRole('button', { name: 'Cast on Qwen' })).not.toBeInTheDocument();
  });

  it('wrong-engine with castOnEngine: null renders NO re-cast button', () => {
    mockVerdicts = [
      verdict({ characterId: 'c1', reason: 'wrong-engine', engine: 'kokoro', castOnEngine: null }),
    ];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row = screen.getByTestId('clone-readiness-row-c1');
    expect(within(row).queryByRole('button', { name: /^Cast on/ })).not.toBeInTheDocument();
    expect(ctaButtonsIn(row)).toEqual([]);
  });

  it('"Cast on <engine>" sets character.ttsEngine to castOnEngine', () => {
    mockVerdicts = [
      verdict({ characterId: 'c1', reason: 'wrong-engine', engine: 'kokoro', castOnEngine: 'coqui' }),
    ];
    const store = makeStore({ characters: [char({ id: 'c1', name: 'Alice' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cast on Coqui' }));
    expect(store.getState().cast.characters[0].ttsEngine).toBe('coqui');
  });

  it('"Retry derive" calls retryCloneEngine with the voiceUuid and the character\'s ROUTED engine (Decision 7)', async () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'derive-failed', engine: 'coqui' })];
    const store = makeStore({
      characters: [
        char({
          id: 'c1',
          overrideTtsVoices: { coqui: { name: 'v1', libraryUuid: 'lib-uuid-1', provenance: 'cloned' } },
        }),
      ],
    });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry derive' }));
    await waitFor(() => expect(retryCloneEngine).toHaveBeenCalledWith('lib-uuid-1', 'coqui'));
  });

  it('"Save transcript" PATCHes the library with the typed transcript (Decision 6)', async () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'no-transcript', engine: 'qwen' })];
    const store = makeStore({
      characters: [
        char({
          id: 'c1',
          overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'lib-uuid-2', provenance: 'cloned' } },
        }),
      ],
    });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add transcript' }));
    const row = screen.getByTestId('clone-readiness-row-c1');
    fireEvent.change(within(row).getByRole('textbox', { name: 'transcript' }), {
      target: { value: 'A brand new transcript.' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Save transcript' }));
    await waitFor(() =>
      expect(patchVoiceLibrary).toHaveBeenCalledWith('lib-uuid-2', {
        transcript: 'A brand new transcript.',
      }),
    );
  });

  it('multiple characters with different reasons each render their own row and CTA', () => {
    mockVerdicts = [
      verdict({ characterId: 'c1', characterName: 'Alice', reason: 'no-transcript', engine: 'qwen' }),
      verdict({ characterId: 'c2', characterName: 'Bo', reason: 'derive-failed', engine: 'coqui' }),
    ];
    const store = makeStore({ characters: [char({ id: 'c1', name: 'Alice' }), char({ id: 'c2', name: 'Bo' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    const row1 = screen.getByTestId('clone-readiness-row-c1');
    const row2 = screen.getByTestId('clone-readiness-row-c2');
    expect(within(row1).getByText('Alice')).toBeInTheDocument();
    expect(within(row1).getByRole('button', { name: 'Add transcript' })).toBeInTheDocument();
    expect(within(row2).getByText('Bo')).toBeInTheDocument();
    expect(within(row2).getByRole('button', { name: 'Retry derive' })).toBeInTheDocument();
  });

  it('Proceed anyway closes the gate, dispatches requestStartGeneration, and does NOT dispatch openStartGenPrompt', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'revoked' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Proceed anyway' }));
    expect(
      dispatchSpy.mock.calls.some((c) => c[0]?.type === uiActions.openStartGenPrompt({}).type),
    ).toBe(false);
    /* The positive half — Decision 1's warn-and-ALLOW only holds if
       "Proceed anyway" actually starts generation. Asserting only the
       negative (above) is what let this regress to warn-and-BLOCK silently:
       deleting the `requestStartGeneration` dispatch from `onProceedAnyway`
       still passes a suite that only checks `openStartGenPrompt` is absent. */
    expect(
      dispatchSpy.mock.calls.some((c) => c[0]?.type === uiActions.requestStartGeneration().type),
    ).toBe(true);
    expect(store.getState().ui.startGenPrompt).toBeNull();
    expect(store.getState().ui.cloneReadinessGate).toBeNull();
  });

  it('Cancel closes the gate without starting generation', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'revoked' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store.getState().ui.cloneReadinessGate).toBeNull();
    expect(
      dispatchSpy.mock.calls.some((c) => c[0]?.type === uiActions.requestStartGeneration().type),
    ).toBe(false);
  });

  describe('cast-pending gate mechanism (fs-38 / #2068)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('Proceed anyway is disabled while cast-on-engine write is pending, with DEFAULT debounce (500ms)', () => {
      mockVerdicts = [
        verdict({
          characterId: 'c1',
          characterName: 'Alice',
          reason: 'wrong-engine',
          engine: 'qwen',
          castOnEngine: 'coqui',
        }),
      ];
      const store = makeStore({
        characters: [char({ id: 'c1', ttsEngine: 'qwen' })],
        autosaveDebounceMs: DEFAULT_AUTOSAVE_DEBOUNCE_MS, // 500ms
      });
      const dispatchSpy = vi.spyOn(store, 'dispatch');
      render(
        <Provider store={store}>
          <CloneReadinessGateModal />
        </Provider>,
      );

      const castButton = screen.getByRole('button', { name: 'Cast on Coqui' });
      const proceedButton = screen.getByRole('button', { name: 'Proceed anyway' });

      // Initially enabled
      expect(proceedButton).not.toBeDisabled();

      // Click Cast on engine – this should trigger pending state
      fireEvent.click(castButton);

      // Button should immediately become disabled
      expect(proceedButton).toBeDisabled();
      expect(proceedButton).toHaveTextContent('Waiting for cast save');

      // Immediate second click should NOT dispatch requestStartGeneration
      fireEvent.click(proceedButton);
      expect(
        dispatchSpy.mock.calls.some((c) => c[0]?.type === uiActions.requestStartGeneration().type),
      ).toBe(false);

      // Advance time: at 500ms (debounce window), button should still be disabled
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(proceedButton).toBeDisabled();

      // Advance time: at 600ms (debounce + 100ms buffer), button should be re-enabled
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(proceedButton).not.toBeDisabled();
      expect(proceedButton).toHaveTextContent('Proceed anyway');

      // Now clicking should work
      fireEvent.click(proceedButton);
      expect(
        dispatchSpy.mock.calls.some((c) => c[0]?.type === uiActions.requestStartGeneration().type),
      ).toBe(true);
    });

    it('Proceed anyway stays disabled long enough with NON-DEFAULT debounce (2000ms)', () => {
      mockVerdicts = [
        verdict({
          characterId: 'c1',
          characterName: 'Alice',
          reason: 'wrong-engine',
          engine: 'qwen',
          castOnEngine: 'coqui',
        }),
      ];
      const store = makeStore({
        characters: [char({ id: 'c1', ttsEngine: 'qwen' })],
        autosaveDebounceMs: 2000, // Non-default: 2000ms, 4× the old hardcoded buffer
      });
      const dispatchSpy = vi.spyOn(store, 'dispatch');
      render(
        <Provider store={store}>
          <CloneReadinessGateModal />
        </Provider>,
      );

      const castButton = screen.getByRole('button', { name: 'Cast on Coqui' });
      const proceedButton = screen.getByRole('button', { name: 'Proceed anyway' });

      // Initially enabled
      expect(proceedButton).not.toBeDisabled();

      // Click Cast on engine
      fireEvent.click(castButton);
      expect(proceedButton).toBeDisabled();

      // At 1500ms (below debounce), still disabled
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(proceedButton).toBeDisabled();

      // At 2000ms (debounce reached), still disabled (need the 100ms buffer)
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(proceedButton).toBeDisabled();

      // At 2100ms (debounce + 100ms), finally enabled
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(proceedButton).not.toBeDisabled();

      // Clicking now works
      fireEvent.click(proceedButton);
      expect(
        dispatchSpy.mock.calls.some((c) => c[0]?.type === uiActions.requestStartGeneration().type),
      ).toBe(true);
    });

    it('overlapping clicks clear prior timeout and restart the timer', () => {
      mockVerdicts = [
        verdict({
          characterId: 'c1',
          characterName: 'Alice',
          reason: 'wrong-engine',
          engine: 'qwen',
          castOnEngine: 'coqui',
        }),
      ];
      const store = makeStore({
        characters: [char({ id: 'c1', ttsEngine: 'qwen' })],
        autosaveDebounceMs: 500,
      });
      render(
        <Provider store={store}>
          <CloneReadinessGateModal />
        </Provider>,
      );

      const castButton = screen.getByRole('button', { name: 'Cast on Coqui' });
      const proceedButton = screen.getByRole('button', { name: 'Proceed anyway' });

      // First click at t=0
      fireEvent.click(castButton);
      expect(proceedButton).toBeDisabled();

      // Advance 300ms (partway through the debounce)
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(proceedButton).toBeDisabled();

      // Second click at t=300ms — this should RESTART the timer
      fireEvent.click(castButton);

      // At t=700ms from start (400ms after second click), timer still pending
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(proceedButton).toBeDisabled();

      // At t=900ms from start (600ms after second click = debounce + 100ms), finally enabled
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(proceedButton).not.toBeDisabled();
    });
  });
});
