import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { manuscriptSlice } from '../store/manuscript-slice';
import { SentenceEmotionControl } from './sentence-emotion-control';
import type { Character } from '../lib/types';

/* fe-31 — the preview path delegates to playEmotionVariantSample; mock it so the
   component test stays off the live sample machinery and asserts the wiring. */
const playEmotionVariantSample = vi.fn();
vi.mock('../lib/play-emotion-variant', async () => {
  const actual = await vi.importActual<typeof import('../lib/play-emotion-variant')>(
    '../lib/play-emotion-variant',
  );
  return {
    ...actual,
    playEmotionVariantSample: (...args: unknown[]) => playEmotionVariantSample(...args),
  };
});

function makeStore(sentences: any[]) {
  return configureStore({
    reducer: { manuscript: manuscriptSlice.reducer },
    preloadedState: { manuscript: { ...manuscriptSlice.getInitialState(), sentences } },
  });
}

const qwenChar = {
  id: 'marrow',
  name: 'Marrow Todd',
  role: 'PoV',
  color: 'narrator',
  voiceId: 'marrow',
  ttsEngine: 'qwen',
  overrideTtsVoices: {
    qwen: { name: 'qwen-marrow', variants: { angry: { name: 'qwen-marrow-angry' } } },
  },
} as unknown as Character;

beforeEach(() => {
  vi.clearAllMocks();
  playEmotionVariantSample.mockResolvedValue({ fellBackToBase: false });
});

describe('fs-25 — SentenceEmotionControl', () => {
  it('renders a discoverable trigger and dispatches a chosen emotion to the store', () => {
    const store = makeStore([{ id: 2, chapterId: 1, characterId: 'wren', text: 'Stop.' }]);
    render(
      <Provider store={store}>
        <SentenceEmotionControl chapterId={1} sentenceId={2} />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('emotion-chip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Angry' }));
    expect(store.getState().manuscript.sentences[0].emotion).toBe('angry');
  });

  it('renders the variant menu as an opaque elevated surface (picker-surface, not bg-canvas)', () => {
    const store = makeStore([{ id: 2, chapterId: 1, characterId: 'wren', text: 'Stop.' }]);
    render(
      <Provider store={store}>
        <SentenceEmotionControl chapterId={1} sentenceId={2} />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('emotion-chip'));
    /* The menu must use the opaque picker-surface elevation so manuscript text
       behind it never shows through (the dark-mode bg-canvas blended into the
       page canvas → unreadable). */
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('picker-surface');
    expect(menu.className).not.toContain('bg-canvas');
  });

  it('shows the current emotion and clears it via Neutral', () => {
    const store = makeStore([
      { id: 2, chapterId: 1, characterId: 'wren', text: 'Stop.', emotion: 'angry' },
    ]);
    render(
      <Provider store={store}>
        <SentenceEmotionControl chapterId={1} sentenceId={2} emotion="angry" />
      </Provider>,
    );
    // current emotion is surfaced on the trigger label.
    expect(screen.getByTestId('emotion-chip').getAttribute('aria-label')).toMatch(/angry/i);
    fireEvent.click(screen.getByTestId('emotion-chip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Neutral' }));
    expect(store.getState().manuscript.sentences[0].emotion).toBeUndefined();
  });
});

describe('fe-31 — emotion preview from the chip', () => {
  function renderWithChar(char: Character | undefined, emotion = 'angry') {
    const store = makeStore([{ id: 2, chapterId: 1, characterId: char?.id, text: 'Stop.', emotion }]);
    return render(
      <Provider store={store}>
        <SentenceEmotionControl chapterId={1} sentenceId={2} emotion={emotion as any} character={char} />
      </Provider>,
    );
  }

  it('previews the designed variant for a Qwen speaker', async () => {
    renderWithChar(qwenChar);
    const preview = screen.getByTestId('emotion-preview');
    expect(preview).toBeEnabled();
    fireEvent.click(preview);
    await waitFor(() => expect(playEmotionVariantSample).toHaveBeenCalledTimes(1));
    expect(playEmotionVariantSample.mock.calls[0][0]).toMatchObject({ id: 'marrow' });
    expect(playEmotionVariantSample.mock.calls[0][1]).toBe('angry');
    /* No fallback → no "renders neutral" note. */
    expect(screen.queryByTestId('emotion-preview-note')).toBeNull();
  });

  it('shows a "renders neutral" note when the Qwen speaker has no variant', async () => {
    playEmotionVariantSample.mockResolvedValue({ fellBackToBase: true });
    const noVariant = {
      ...qwenChar,
      overrideTtsVoices: { qwen: { name: 'qwen-marrow' } },
    } as unknown as Character;
    renderWithChar(noVariant, 'sad');
    fireEvent.click(screen.getByTestId('emotion-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('emotion-preview-note').textContent).toMatch(
        /no sad variant for Marrow — renders neutral/i,
      ),
    );
  });

  it('disables the preview for a non-Qwen speaker', () => {
    const kokoroChar = { ...qwenChar, ttsEngine: 'kokoro' } as unknown as Character;
    renderWithChar(kokoroChar);
    const preview = screen.getByTestId('emotion-preview');
    expect(preview).toBeDisabled();
    expect(preview.getAttribute('aria-label')).toMatch(/only audible on Qwen/i);
    fireEvent.click(preview);
    expect(playEmotionVariantSample).not.toHaveBeenCalled();
  });

  it('renders no preview affordance when no character is resolved', () => {
    renderWithChar(undefined);
    expect(screen.queryByTestId('emotion-preview')).toBeNull();
  });
});
