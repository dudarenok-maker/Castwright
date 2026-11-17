// #4098 review pass 2 — one case per click-time refusal against the real app
// store with the analysis era latched AFTER the control is open (the era rises
// between render and click, so the control cannot have disabled itself). Each
// pins that the edit AND its paired side write are refused and the read-only
// toast shows. Reverting any refusal to the restructure-only `refuseIfEditsLocked`
// (or removing it) turns its case red — including the five ManuscriptView sites
// that share its own `refuseIfLocked` (boundary pointer-down, commitBoundaryMove,
// reassignSegment, assignSelectionTo, onReassignSentence), one case each at the
// bottom of this file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';

import { store } from './index';
import { api } from '../lib/api';
import { manuscriptActions } from './manuscript-slice';
import { uiActions } from './ui-slice';
import { castActions } from './cast-slice';
import { chaptersActions } from './chapters-slice';
import { scriptReviewActions } from './script-review-slice';
import { notificationsActions } from './notifications-slice';
import { CAST_READ_ONLY_DEDUPE_KEY } from './book-busy-slice';
import { ScriptReviewDiff } from '../components/script-review-diff';
import { PromoteFirstSentenceButton } from '../components/promote-first-sentence-button';
import { SentenceEmotionControl } from '../components/sentence-emotion-control';
import { SentenceInstructControl } from '../components/sentence-instruct-control';
import { ManuscriptView } from '../views/manuscript';
import type { Chapter, Character } from '../lib/types';

const BOOK = 'era-surf-bk';
const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  { id: 'egor', name: 'Egor', role: 'Lead', color: 'amber' } as Character,
  { id: 'anton', name: 'Anton', role: 'Lead', color: 'blue' } as Character,
];
const chapter: Chapter = { id: 1, title: 'One', duration: '00:10', state: 'queued', progress: 0, characters: {} };

function seed(sentences: unknown[]) {
  store.dispatch(
    manuscriptActions.hydrateFromBookState({
      state: { bookId: BOOK, manuscriptId: 'm1', title: 'T' } as never,
      sentences: sentences as never,
    }),
  );
  store.dispatch(uiActions.openBook({ id: BOOK, status: 'voices_pending' }));
  store.dispatch(castActions.setCharacters(characters as never));
  store.dispatch(chaptersActions.setChapters([{ id: 1, title: 'One' }] as never));
}

const sentencesNow = () => store.getState().manuscript.sentences.map((s) => ({ ...s }));
const toastKeys = () => store.getState().notifications.toasts.map((t) => t.dedupeKey);
const latchEra = () => act(() => void store.dispatch(castActions.latchAnalysisEra({ bookId: BOOK })));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

beforeEach(() => {
  vi.spyOn(api, 'putBookState').mockResolvedValue({} as never);
  vi.spyOn(api, 'getScriptReviewState').mockResolvedValue({ kind: 'ledger', entries: {} } as never);
});
afterEach(() => {
  const era = store.getState().cast.analysisEra?.[BOOK];
  if (era) store.dispatch(castActions.clearAnalysisEra({ bookId: BOOK, epoch: era.epoch }));
  store.dispatch(scriptReviewActions.removeChaptersLocally({ bookId: BOOK, chapterIds: [1] }));
  for (const t of store.getState().notifications.toasts) store.dispatch(notificationsActions.dismissToast(t.id));
  vi.restoreAllMocks();
});

describe('click-time refusals while the book is cast-read-only', () => {
  it('Script Review advanceGroup: no reassign, no op resolved, no boundary_move', async () => {
    seed([{ id: 1, chapterId: 1, characterId: 'egor', text: 'Alpha line.' }]);
    const resolve = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true } as never);
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: BOOK,
        // a proposed name that matches the roster: the form offers "Reattribute to «Anton»",
        // which is a live (unpaused) control and goes through advanceGroup.
        ops: [{ chapterId: 1, id: 1, op: 'reattribute', proposed: { name: 'Anton' }, rationale: 'x' }] as never,
        unappliable: [],
        manuscriptId: 'm1',
        versionByChapter: { 1: 1 },
      }),
    );
    store.dispatch(scriptReviewActions.toggleClass({ bookId: BOOK, op: 'reattribute' }));
    render(<Provider store={store}><ScriptReviewDiff bookId={BOOK} /></Provider>);
    fireEvent.click(screen.getByTestId('apply-button'));
    expect(screen.getByTestId('create-character-submit')).toHaveTextContent('Reattribute to «Anton»');
    latchEra();
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    fireEvent.click(screen.getByTestId('create-character-submit'));
    await settle();

    expect(sentencesNow()).toEqual(before);
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getState().changeLog)).toBe(logBefore);
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });

  it('promote first line as title: api.renameChapter is NOT sent and the sentence stays', async () => {
    seed([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'The Title.' }, { id: 2, chapterId: 1, characterId: 'narrator', text: 'Body.' }]);
    const rename = vi.spyOn(api, 'renameChapter').mockResolvedValue({} as never);
    const first = store.getState().manuscript.sentences[0];
    render(
      <Provider store={store}>
        <PromoteFirstSentenceButton bookId={BOOK} chapterId={1} firstSentence={first} isOnlySentence={false} />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('promote-first-sentence-button'));
    latchEra();
    const before = sentencesNow();
    fireEvent.click(screen.getByTestId('promote-first-sentence-confirm'));
    await settle();

    expect(rename).not.toHaveBeenCalled();
    expect(sentencesNow()).toEqual(before);
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });

  it('emotion control: the emotion is not set', async () => {
    seed([{ id: 1, chapterId: 1, characterId: 'egor', text: 'Get down!' }]);
    render(<Provider store={store}><SentenceEmotionControl chapterId={1} sentenceId={1} /></Provider>);
    fireEvent.click(screen.getByTestId('emotion-chip'));
    latchEra();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Angry' }));
    await settle();

    expect(store.getState().manuscript.sentences[0].emotion).toBeUndefined();
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });

  it('instruct control: the delivery direction is not set', async () => {
    seed([{ id: 1, chapterId: 1, characterId: 'egor', text: 'Get down!' }]);
    render(<Provider store={store}><SentenceInstructControl chapterId={1} sentenceId={1} /></Provider>);
    fireEvent.click(screen.getByTestId('instruct-chip'));
    fireEvent.change(screen.getByLabelText('Enter delivery direction'), { target: { value: 'a sharp whisper' } });
    latchEra();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();

    expect(store.getState().manuscript.sentences[0].instruct).toBeUndefined();
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });

  it('manuscript view re-include: the excluded line stays excluded', async () => {
    seed([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'First line.' },
      { id: 2, chapterId: 1, characterId: 'egor', text: 'Second line.', excludeFromSynthesis: true },
    ]);
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={store.getState().manuscript.sentences}
        />
      </Provider>,
    );
    await waitFor(() => expect(screen.getByTestId('reinclude-toggle-2')).toBeEnabled());
    latchEra();
    fireEvent.click(screen.getByTestId('reinclude-toggle-2'));
    await settle();

    expect(store.getState().manuscript.sentences.find((s) => s.id === 2)?.excludeFromSynthesis).toBe(true);
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });
});

// The five ManuscriptView sites guarded by its own `refuseIfLocked`. Each is
// driven through the real view; a refused edit must leave the sentences AND the
// changeLog (`bumpBoundaryMove`) untouched, send no save, and toast read-only.
describe('ManuscriptView refusals while the book is cast-read-only', () => {
  const twoSegments = () => [
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'Opening narration line.' },
    { id: 2, chapterId: 1, characterId: 'egor', text: 'Egor speaks a long line.' },
    { id: 3, chapterId: 1, characterId: 'egor', text: 'Egor speaks once more.' },
  ];
  const renderView = () =>
    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[chapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={store.getState().manuscript.sentences}
        />
      </Provider>,
    );
  const expectRefused = (before: unknown[], logBefore: string) => {
    expect(sentencesNow()).toEqual(before);
    expect(JSON.stringify(store.getState().changeLog)).toBe(logBefore);
    // seeding the roster saves the `cast` slice on its own; a refused edit saves nothing else
    const saved = vi.mocked(api.putBookState).mock.calls.map((c) => (c[1] as { slice: string }).slice);
    expect(saved.filter((sl) => sl !== 'cast')).toEqual([]);
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  };

  afterEach(() => {
    document.body.classList.remove('dragging-boundary');
  });

  it('boundary pointer-down: no drag starts', async () => {
    seed(twoSegments());
    renderView();
    const handle = document.querySelector('[data-tour-id="chapter-boundary"]') as HTMLElement;
    latchEra();
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    fireEvent.pointerDown(handle);
    await settle();

    expect(document.body.classList.contains('dragging-boundary')).toBe(false);
    expectRefused(before, logBefore);
  });

  it('commitBoundaryMove: the drop moves no boundary and logs no boundary_move', async () => {
    seed(twoSegments());
    renderView();
    const handle = document.querySelector('[data-tour-id="chapter-boundary"]') as HTMLElement;
    const target = document.querySelector('[data-sentence-idx="0"]') as HTMLElement;
    const elementFromPoint = vi.fn(() => target);
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = elementFromPoint;
    fireEvent.pointerDown(handle); // the drag starts while the book is still editable
    expect(document.body.classList.contains('dragging-boundary')).toBe(true);
    fireEvent(window, new Event('pointermove'));
    await settle();
    expect(elementFromPoint).toHaveBeenCalled();
    latchEra(); // ... and the era rises mid-drag
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    fireEvent(window, new Event('pointerup'));
    await settle();

    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    expectRefused(before, logBefore);
  });

  it('reassignSegment: the whole segment keeps its speaker', async () => {
    seed(twoSegments());
    renderView();
    fireEvent.click(screen.getByText('Opening narration line.'));
    fireEvent.click(screen.getByText(/Change…/));
    const picker = screen.getByRole('dialog', { name: /reassign speaker/i });
    latchEra();
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    fireEvent.click(within(picker).getByRole('option', { name: /Anton/ }));
    await settle();

    expectRefused(before, logBefore);
  });

  it('assignSelectionTo: the highlighted text is not split off', async () => {
    seed(twoSegments());
    renderView();
    const textNode = (document.querySelector('[data-sentence-id="1"] [data-text-offset]') as HTMLElement)
      .firstChild as Text;
    const fakeRange = {
      startContainer: textNode,
      endContainer: textNode,
      startOffset: 0,
      endOffset: 7,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => fakeRange,
    } as unknown as Selection);
    act(() => void fireEvent(document, new Event('selectionchange')));
    const popover = screen.getByText(/assign selection to/i).parentElement as HTMLElement;
    latchEra();
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    fireEvent.mouseDown(within(popover).getByRole('button', { name: /Anton/ }));
    await settle();

    expectRefused(before, logBefore);
  });

  it('onReassignSentence: the single line keeps its speaker', async () => {
    seed(twoSegments());
    renderView();
    fireEvent.click(screen.getByText('Egor speaks a long line.'));
    fireEvent.click(screen.getAllByRole('button', { name: /Reassign just this one/ })[0]);
    const picker = screen.getByRole('dialog');
    latchEra();
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    fireEvent.click(within(picker).getByRole('option', { name: /Anton/ }));
    await settle();

    expectRefused(before, logBefore);
  });
});
