// Pairs with docs/features/16-generation-stream.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { GenerationView } from './generation';
import type { Chapter, Character, Sentence } from '../lib/types';

const streamGenerationMock = vi.fn();

vi.mock('../lib/api', () => ({
  /* Never-resolving so the ChapterSegmentStrip useEffect doesn't flush a
     setError state update outside React's `act` after the test asserts. */
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return () => {};
    },
    getChapterAudio:  () => new Promise(() => {}),
  },
}));

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  { id: 'keefe',    name: 'Keefe',    role: 'Empath',   color: 'peach' },
];

const sentences: Sentence[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A long room.' },                    // 3 words
  { id: 2, chapterId: 1, characterId: 'keefe',    text: 'Hello there friend!' },             // 3 words
  { id: 3, chapterId: 1, characterId: 'keefe',    text: 'How are you today on this fine evening?' }, // 8 words
  { id: 4, chapterId: 2, characterId: 'narrator', text: 'Elsewhere entirely.' },             // 2 words
];

const chapter1: Chapter = {
  id: 1,
  title: 'Chapter 1',
  duration: '00:49',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done', keefe: 'done' },
};
const chapter2: Chapter = {
  id: 2,
  title: 'Chapter 2',
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued', keefe: 'queued' },
};

function makeStore() {
  const store = configureStore({
    reducer: {
      ui:         uiSlice.reducer,
      chapters:   chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
    },
  });
  store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
  store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
    bookId: 'b1',
    characters,
    chapters: [chapter1, chapter2],
    sentences,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any));
  return store;
}

function renderView() {
  const store = makeStore();
  return render(
    <Provider store={store}>
      <GenerationView
        chapters={[chapter1, chapter2]}
        characters={characters}
        paused
        title="Bonus Keefe Story"
        bookId="b1"
        modelKey="coqui-xtts-v2"
        setPaused={() => {}}
        onRegenerate={() => {}}
        onRegenerateCharacterInChapter={() => {}}
        onPreview={() => {}}
      />
    </Provider>,
  );
}

describe('GenerationView — chapter & character metadata (regression for screenshot bug)', () => {
  beforeEach(() => { /* paused=true so the streamGeneration effect short-circuits */ });

  it('shows manuscript-derived word/line/speaker counts under each chapter title', () => {
    renderView();
    /* Chapter 1: 1 narrator sentence (3 words) + 2 keefe sentences (3 + 8 = 11 words)
       → 14 words, 3 lines, 2 speakers */
    expect(screen.getByText(/14 words · 3 lines · 2 speakers/)).toBeInTheDocument();
    /* Chapter 2: 1 narrator sentence (2 words) → 2 words, 1 line, 1 speaker */
    expect(screen.getByText(/2 words · 1 line · 1 speaker/)).toBeInTheDocument();
  });

  it('renders per-character line + word counts next to each character in the expanded chapter row', () => {
    renderView();
    /* The chapter row toggle is the first button containing "CH 01". */
    fireEvent.click(screen.getByText('Chapter 1'));
    expect(screen.getByText(/1 line · 3 words/)).toBeInTheDocument();   // narrator in ch 1
    expect(screen.getByText(/2 lines · 11 words/)).toBeInTheDocument(); // keefe in ch 1
  });

  it('reports overall progress including Done chapters with no totalLines (the 4 % bug)', () => {
    /* Chapter 1 done (progress 1, 3 sentences in the manuscript), Chapter 2
       queued (progress 0, 1 sentence). Weighted by manuscript sentence count:
       (1 * 3 + 0 * 1) / (3 + 1) = 75 %. Pre-fix it would have shown 0 %
       because both chapters lacked the SSE-supplied totalLines. */
    renderView();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });
});

describe('GenerationView — Pause/Resume regenerate loop (regression)', () => {
  beforeEach(() => { streamGenerationMock.mockClear(); });

  it('clears pendingRegen the instant the SSE opens with it', () => {
    /* The bug: pause aborts the SSE before the server's idle tick arrives,
       so pendingRegen sticks. Resume reopens the SSE with the same
       force:true spec and wipes the in-flight chapter — every Pause→Resume
       is a fresh force-regen of the original target set. The view-level
       fix is to dispatch consumePendingRegen immediately after the open. */
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
    /* Simulate "user clicked Regenerate" — the reducer set this spec and
       bumped regenEpoch. The view will mount, fire its SSE effect, and
       should drain the spec. */
    store.dispatch(chaptersSlice.actions.regenerateChapter({ chapterId: 1, scope: 'this' }));
    expect(store.getState().chapters.pendingRegen).toEqual({ chapterIds: [1], force: true });

    render(
      <Provider store={store}>
        <GenerationView
          chapters={[chapter1, chapter2]}
          characters={characters}
          paused={false}
          title="Bonus Keefe Story"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          setPaused={() => {}}
          onRegenerate={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    /* streamGeneration MUST have been called with the spec (otherwise we'd
       have broken the regenerate path entirely). */
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const callArgs = streamGenerationMock.mock.calls[0]?.[0] as { chapterIds?: unknown; force?: unknown };
    expect(callArgs?.chapterIds).toEqual([1]);
    expect(callArgs?.force).toBe(true);

    /* And after the open, the spec is drained so a later Resume can't replay it. */
    expect(store.getState().chapters.pendingRegen).toBe(null);
  });
});
