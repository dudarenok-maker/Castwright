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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { CloneReadinessGateModal } from './clone-readiness-gate';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { voiceLibrarySlice } from '../store/voice-library-slice';
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

function makeStore(opts: { gate?: { bookId: string } | null; characters?: Character[] } = {}) {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      voiceLibrary: voiceLibrarySlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId: 1, openProfileId: null },
        cloneReadinessGate: opts.gate === undefined ? { bookId: 'b1' } : opts.gate,
      } as never,
      cast: { ...castSlice.getInitialState(), characters: opts.characters ?? [] },
      voiceLibrary: voiceLibrarySlice.getInitialState(),
    },
  });
}

/* Every button label this modal can ever render, across all six reasons —
   used to assert "renders its own CTA and no other" by checking every OTHER
   label is absent from a given row. */
const ALL_CTA_LABELS = ['Add transcript', 'Retry derive', 'Assign a different voice'];

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
    expect(within(row).getByRole('button', { name: 'Add transcript' })).toBeInTheDocument();
    for (const label of ALL_CTA_LABELS.filter((l) => l !== 'Add transcript')) {
      expect(within(row).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
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
    expect(within(row).getByRole('button', { name: 'Retry derive' })).toBeInTheDocument();
    for (const label of ALL_CTA_LABELS.filter((l) => l !== 'Retry derive')) {
      expect(within(row).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
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
    expect(within(row).getByRole('button', { name: 'Assign a different voice' })).toBeInTheDocument();
    for (const label of ALL_CTA_LABELS.filter((l) => l !== 'Assign a different voice')) {
      expect(within(row).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
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

  it('Proceed anyway closes the gate and does NOT dispatch openStartGenPrompt', () => {
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
    expect(store.getState().ui.startGenPrompt).toBeNull();
    expect(store.getState().ui.cloneReadinessGate).toBeNull();
  });

  it('Cancel closes the gate without starting generation', () => {
    mockVerdicts = [verdict({ characterId: 'c1', reason: 'revoked' })];
    const store = makeStore({ characters: [char({ id: 'c1' })] });
    render(
      <Provider store={store}>
        <CloneReadinessGateModal />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store.getState().ui.cloneReadinessGate).toBeNull();
  });
});
