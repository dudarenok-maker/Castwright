// #4098 review pass 1 — the era drops a manuscript save when it is built, and
// the dispatch returns as though it landed. A surface that pairs the edit with a
// second write (resolve review ops, log a boundary_move, mark the book annotated)
// must refuse at click time, before that write. These run the real app store
// (restructure guard + persistence + cast gate) with the analysis era latched and
// pin: nothing resolved, nothing logged or saved, and the read-only toast shows.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';

import { store } from './index';
import { api } from '../lib/api';
import { manuscriptActions } from './manuscript-slice';
import { uiActions } from './ui-slice';
import { castActions } from './cast-slice';
import { chaptersActions } from './chapters-slice';
import { scriptReviewActions, opKey } from './script-review-slice';
import { notificationsActions } from './notifications-slice';
import { CAST_READ_ONLY_DEDUPE_KEY } from './book-busy-slice';
import { ScriptReviewDiff } from '../components/script-review-diff';
import { ReassignLinesModal } from '../modals/reassign-lines';
import { BulkReassignUndoBanner } from '../components/bulk-reassign-undo-banner';

const BOOK = 'era-bk';

function seed() {
  store.dispatch(
    manuscriptActions.hydrateFromBookState({
      state: { bookId: BOOK, manuscriptId: 'm1', title: 'T' } as never,
      sentences: [
        { id: 1, chapterId: 1, characterId: 'egor', text: 'Alpha line.' },
        { id: 2, chapterId: 1, characterId: 'egor', text: 'Beta line.' },
      ] as never,
    }),
  );
  store.dispatch(uiActions.openBook({ id: BOOK, status: 'voices_pending' }));
  store.dispatch(
    castActions.setCharacters([
      { id: 'egor', name: 'Egor' },
      { id: 'anton', name: 'Anton' },
    ] as never),
  );
  store.dispatch(chaptersActions.setChapters([{ id: 1, title: 'One' }] as never));
}

const sentencesNow = () => store.getState().manuscript.sentences.map((s) => [s.id, s.characterId, s.text, s.emotion]);
const toastKeys = () => store.getState().notifications.toasts.map((t) => t.dedupeKey);
const logNow = () => JSON.stringify(store.getState().changeLog);
const latchEra = () => store.dispatch(castActions.latchAnalysisEra({ bookId: BOOK }));
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 700));
  });

let put: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  seed();
  put = vi.spyOn(api, 'putBookState').mockResolvedValue({} as never);
});
afterEach(() => {
  const era = store.getState().cast.analysisEra?.[BOOK];
  if (era) store.dispatch(castActions.clearAnalysisEra({ bookId: BOOK, epoch: era.epoch }));
  store.dispatch(scriptReviewActions.removeChaptersLocally({ bookId: BOOK, chapterIds: [1] }));
  for (const t of store.getState().notifications.toasts) store.dispatch(notificationsActions.dismissToast(t.id));
  vi.restoreAllMocks();
});

describe('Script Review Apply while the book is cast-read-only', () => {
  it('applies nothing, resolves no ops, logs nothing; the suggestions stay and the toast shows', async () => {
    const resolve = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true } as never);
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: BOOK,
        ops: [{ chapterId: 1, id: 2, op: 'fix_emotion', emotion: 'excited', rationale: 'x' }] as never,
        unappliable: [],
        manuscriptId: 'm1',
        versionByChapter: { 1: 1 },
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId={BOOK} />
      </Provider>,
    );
    latchEra();
    const before = sentencesNow();
    const logBefore = logNow();
    put.mockClear();
    fireEvent.click(screen.getByTestId('apply-button'));
    await settle();

    expect(sentencesNow()).toEqual(before);
    expect(resolve).not.toHaveBeenCalled();
    expect(logNow()).toBe(logBefore);
    expect(put).not.toHaveBeenCalled();
    expect(store.getState().scriptReview.byBook[BOOK]?.ops).toHaveLength(1);
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });
});

describe('Reassign lines while the book is cast-read-only', () => {
  it('moves nothing, logs no boundary_move, saves nothing, does not close; the toast shows', async () => {
    const onClose = vi.fn();
    render(
      <Provider store={store}>
        <ReassignLinesModal source={{ kind: 'character', characterId: 'egor' }} onClose={onClose} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'anton' } });
    latchEra();
    const before = sentencesNow();
    const logBefore = logNow();
    put.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^reassign/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await settle();

    expect(sentencesNow()).toEqual(before);
    expect(logNow()).toBe(logBefore);
    expect(put).not.toHaveBeenCalled();
    expect(store.getState().manuscript.lastBulkReassign).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });
});

describe('Bulk reassign Undo while the book is cast-read-only', () => {
  it('reverts nothing and appends no revert event; the toast shows', async () => {
    store.dispatch(
      manuscriptActions.setSentencesCharacterBulk({
        keys: [{ chapterId: 1, sentenceId: 1 }],
        characterId: 'anton',
        targetLabel: 'Anton',
      }),
    );
    render(
      <Provider store={store}>
        <BulkReassignUndoBanner />
      </Provider>,
    );
    await settle();
    latchEra();
    const before = sentencesNow();
    const logBefore = logNow();
    put.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await settle();

    expect(sentencesNow()).toEqual(before);
    expect(logNow()).toBe(logBefore);
    expect(put).not.toHaveBeenCalled();
    expect(store.getState().manuscript.lastBulkReassign).not.toBeNull();
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
  });
});

describe('Script Review proposed batch when the era starts mid-run', () => {
  it('stops before the next op: no apply, no resolve, the ledger op survives, the toast shows', async () => {
    const resolve = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true } as never);
    // The era rises while the SECOND op's create is in flight (the first op has
    // already been applied and resolved by then).
    vi.spyOn(api, 'createCharacter').mockImplementation(async (_bookId, fields) => {
      if (fields.name === 'Sol') latchEra();
      return { character: { id: fields.name.toLowerCase(), name: fields.name, role: 'character' } } as never;
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: BOOK,
        ops: [
          { chapterId: 1, id: 1, op: 'reattribute', proposed: { name: 'Nova' }, rationale: 'x' },
          { chapterId: 1, id: 2, op: 'reattribute', proposed: { name: 'Sol' }, rationale: 'x' },
        ] as never,
        unappliable: [],
        manuscriptId: 'm1',
        versionByChapter: { 1: 1 },
      }),
    );
    store.dispatch(scriptReviewActions.toggleClass({ bookId: BOOK, op: 'reattribute' }));
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId={BOOK} />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('apply-button'));
    fireEvent.click(screen.getByTestId('create-character-submit')); // Nova
    await waitFor(() => expect(screen.getByText(/2 of 2/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('create-character-submit')); // Sol -> era latches in flight
    await settle();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(BOOK, expect.objectContaining({ appliedOpKeys: [opKey(1, 1, 'reattribute')] }));
    const bucket = store.getState().scriptReview.byBook[BOOK];
    expect(bucket?.ops.map((o) => o.id)).toEqual([2]);
    expect(store.getState().manuscript.sentences.find((s) => s.id === 2)?.characterId).toBe('egor');
    expect(toastKeys()).toContain(CAST_READ_ONLY_DEDUPE_KEY);
    expect(toastKeys().filter((k) => k === CAST_READ_ONLY_DEDUPE_KEY)).toHaveLength(1);
  });
});
