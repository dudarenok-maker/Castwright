// #3400 pass 7 — the guard middleware refuses a manuscript edit mid-restructure,
// but a refusal no caller could see let the edit's OTHER writes go ahead: Script
// Review resolved ops it never applied, Reassign logged a boundary_move and
// closed as done. These run the real app store (which installs the guard) with
// the restructure flag up and pin: nothing resolved / logged / closed, and the
// control is disabled with a visible reason.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';

import { store } from './index';
import { api } from '../lib/api';
import { manuscriptActions } from './manuscript-slice';
import { uiActions } from './ui-slice';
import { castActions } from './cast-slice';
import { chaptersActions } from './chapters-slice';
import { scriptReviewActions } from './script-review-slice';
import { notificationsActions } from './notifications-slice';
import { RESTRUCTURING_REASON } from './restructure-lock';
import { ScriptReviewDiff } from '../components/script-review-diff';
import { ReassignLinesModal } from '../modals/reassign-lines';

const BOOK = 'flows-bk';

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
const toastKinds = () => store.getState().notifications.toasts.map((t) => t.dedupeKey);

beforeEach(() => {
  seed();
  store.dispatch(uiActions.setRestructuringBook(BOOK));
});
afterEach(() => {
  store.dispatch(uiActions.clearRestructuringBook(BOOK));
  store.dispatch(scriptReviewActions.removeChaptersLocally({ bookId: BOOK, chapterIds: [1] }));
  for (const t of store.getState().notifications.toasts) store.dispatch(notificationsActions.dismissToast(t.id));
  vi.restoreAllMocks();
});

describe('Script Review Apply while the book restructures', () => {
  it('is disabled with a reason; applies nothing, resolves nothing, logs nothing', async () => {
    const resolve = vi
      .spyOn(api, 'resolveScriptReviewOps')
      .mockResolvedValue({ ok: true } as never);
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: BOOK,
        ops: [{ chapterId: 1, id: 2, op: 'fix_emotion', emotion: 'excited', rationale: 'x' }] as never,
        unappliable: [],
        manuscriptId: 'm1',
        versionByChapter: { 1: 1 },
      }),
    );
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId={BOOK} />
      </Provider>,
    );
    const apply = screen.getByTestId('apply-button') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(apply.title).toBe(RESTRUCTURING_REASON);
    fireEvent.click(apply);
    expect(sentencesNow()).toEqual(before);
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getState().changeLog)).toBe(logBefore);
    const bucket = store.getState().scriptReview.byBook[BOOK];
    expect(bucket?.ops).toHaveLength(1);
    expect(bucket?.visible).toBe(true);
  });
});

describe('Reassign lines while the book restructures', () => {
  it('disables Reassign with a reason; moves nothing, logs nothing, does not close', () => {
    const onClose = vi.fn();
    const before = sentencesNow();
    const logBefore = JSON.stringify(store.getState().changeLog);
    render(
      <Provider store={store}>
        <ReassignLinesModal source={{ kind: 'character', characterId: 'egor' }} onClose={onClose} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.change(screen.getByLabelText(/reassign to/i), { target: { value: 'anton' } });
    const btn = screen.getByRole('button', { name: /^reassign/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(RESTRUCTURING_REASON);
    fireEvent.click(btn);
    expect(sentencesNow()).toEqual(before);
    expect(JSON.stringify(store.getState().changeLog)).toBe(logBefore);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the guard backstop', () => {
  it('toasts when it refuses an edit, so a refusal is never silent', () => {
    store.dispatch(
      manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 1, characterId: 'anton' }),
    );
    expect(store.getState().manuscript.sentences[0].characterId).toBe('egor');
    expect(toastKinds()).toContain('restructuring-edit-refused');
  });
});
