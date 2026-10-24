/* CastView — "Design full cast" guard (#3084 W4). The pause-the-render prompt belongs to the
   scope-picker block of the view: it must not outlive that block, and it must only appear when
   the chosen scope will actually generate a persona. */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { castDesignSlice, castDesignActions } from '../store/cast-design-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { accountSlice } from '../store/account-slice';
import { configSlice } from '../store/config-slice';
import { haltActiveGeneration } from '../store/queue-thunks';
import { seedSameCardPersona } from '../test/seed-same-card-persona';
import { CastView } from './cast';
import type { Character, Sentence } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    loadSidecar: vi.fn().mockResolvedValue({}),
    pauseCastDesign: vi.fn().mockResolvedValue(undefined),
    setCastTier: vi.fn().mockResolvedValue({ updated: 0 }),
  },
}));
vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));
vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({ isPlaying: false, currentUrl: null, play: vi.fn(), stop: vi.fn(), pause: vi.fn() }),
}));
/* The guard's Confirm dispatches haltActiveGeneration; stub it to a plain action so the test asserts the call. */
vi.mock('../store/queue-thunks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/queue-thunks')>()),
  haltActiveGeneration: vi.fn(() => ({ type: 'test/haltActiveGeneration' })),
}));

const DIALOG = 'Pause audio generation to design voices?';

const qwenChar = (over: Partial<Character> & { id: string }): Character =>
  ({
    name: over.id,
    role: 'r',
    color: 'mentor',
    lines: 5,
    scenes: 2,
    attributes: [],
    ttsEngine: 'qwen',
    ...over,
  }) as Character;

const needsVoice = qwenChar({ id: 'marrow', name: 'Mr. Marrow' });
const nonQwen = qwenChar({ id: 'plain', name: 'Plain', ttsEngine: 'kokoro' });

function setup(chars: Character[], sentences?: Sentence[]) {
  const actions: Array<{ type: string; payload?: unknown }> = [];
  const recorder = () => (next: (a: unknown) => unknown) => (action: unknown) => {
    actions.push(action as { type: string; payload?: unknown });
    return next(action);
  };
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
      chapters: chaptersSlice.reducer,
      account: accountSlice.reducer,
      config: configSlice.reducer,
    },
    middleware: (g) => g({ serializableCheck: false, immutableCheck: false }).concat(recorder),
  });
  store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'complete' }));
  seedSameCardPersona(store);
  const view = (characters: Character[]) => (
    <Provider store={store}>
      <CastView
        characters={characters}
        sentences={sentences}
        setCharacters={() => {}}
        library={[]}
        title="X"
        onOpenProfile={() => {}}
        onShowMatchDetail={() => {}}
        driftEvents={[]}
        onShowDrift={() => {}}
        onContinueToManuscript={() => {}}
      />
    </Provider>
  );
  const utils = render(view(chars));
  return { actions, rerender: (c: Character[]) => utils.rerender(view(c)) };
}

const designStarted = (actions: Array<{ type: string }>) =>
  actions.some((a) => a.type === castDesignActions.designAllRequested.type);

beforeEach(() => vi.mocked(haltActiveGeneration).mockClear());
afterEach(cleanup);

describe('CastView — design guard prompt lifetime', () => {
  it('a prompt never outlives its host: the picker block going away drops it, and it does not reappear', () => {
    const { actions, rerender } = setup([needsVoice]);
    fireEvent.click(screen.getByTestId('design-full-cast'));
    fireEvent.click(screen.getByTestId('scope-bases'));
    expect(screen.getByText(DIALOG)).toBeInTheDocument();

    /* A non-Qwen cast hides the whole Design full cast block (the dialog's container) by a route that is not Wait. */
    act(() => rerender([nonQwen]));
    expect(screen.queryByTestId('design-full-cast')).toBeNull();
    act(() => rerender([needsVoice]));

    expect(screen.getByTestId('design-full-cast')).toBeInTheDocument();
    expect(screen.queryByText(DIALOG)).not.toBeInTheDocument();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
    expect(designStarted(actions)).toBe(false);
  });
});

describe('CastView — design guard only asks when a persona will be generated', () => {
  const withPersona = (id: string) => qwenChar({ id, name: id, voiceStyle: 'a steady adult voice' });
  /* wren: base designed, no persona on record, an in-use emotion without a variant. */
  const wren = qwenChar({
    id: 'wren',
    name: 'Wren',
    overrideTtsVoices: { qwen: { name: 'qwen-wren', variants: {} } },
  } as Partial<Character> & { id: string });
  const wrenSentences: Sentence[] = [{ id: 10, chapterId: 1, text: 'No!', characterId: 'wren', emotion: 'angry' }];

  it('Variants only builds no base task, so it starts without asking', () => {
    const { actions } = setup([wren], wrenSentences);
    fireEvent.click(screen.getByTestId('design-full-cast'));
    fireEvent.click(screen.getByTestId('scope-variants'));
    expect(screen.queryByText(DIALOG)).not.toBeInTheDocument();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
    expect(designStarted(actions)).toBe(true);
  });

  it('Bases starts without asking when every target already has a persona', () => {
    const { actions } = setup([withPersona('a'), withPersona('b')]);
    fireEvent.click(screen.getByTestId('design-full-cast'));
    fireEvent.click(screen.getByTestId('scope-bases'));
    expect(screen.queryByText(DIALOG)).not.toBeInTheDocument();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
    expect(designStarted(actions)).toBe(true);
  });

  it('Bases asks when one target lacks a persona', () => {
    const { actions } = setup([withPersona('a'), qwenChar({ id: 'b', name: 'b' })]);
    fireEvent.click(screen.getByTestId('design-full-cast'));
    fireEvent.click(screen.getByTestId('scope-bases'));
    expect(screen.getByText(DIALOG)).toBeInTheDocument();
    expect(designStarted(actions)).toBe(false);
  });

  it('Everything asks when a base target lacks a persona, and starts without asking when none does', () => {
    const lacking = setup([withPersona('a'), qwenChar({ id: 'b', name: 'b' }), wren], wrenSentences);
    fireEvent.click(screen.getByTestId('design-full-cast'));
    fireEvent.click(screen.getByTestId('scope-both'));
    expect(screen.getByText(DIALOG)).toBeInTheDocument();
    expect(designStarted(lacking.actions)).toBe(false);
    cleanup();

    const covered = setup([withPersona('a'), wren], wrenSentences);
    fireEvent.click(screen.getByTestId('design-full-cast'));
    fireEvent.click(screen.getByTestId('scope-both'));
    expect(screen.queryByText(DIALOG)).not.toBeInTheDocument();
    expect(designStarted(covered.actions)).toBe(true);
  });
});
