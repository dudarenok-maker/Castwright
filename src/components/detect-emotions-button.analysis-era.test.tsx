// #4098 review pass 2 — the manual "Detect emotions" run against the real app
// store (persistence gate + cast gate). While an analysis era is latched the gate
// drops every manuscript save, so a run must refuse at click time (nothing spent,
// nothing reported tagged), and an era that rises mid-stream must count the
// annotations as skipped and end through the unfinished mark, not the success path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';

import { store } from '../store';
import { api } from '../lib/api';
import { manuscriptActions } from '../store/manuscript-slice';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { notificationsActions } from '../store/notifications-slice';
import { CAST_READ_ONLY_DEDUPE_KEY } from '../store/book-busy-slice';
import { DetectEmotionsButton } from './detect-emotions-button';

const BOOK = 'detect-era-bk';

const latchEra = () => store.dispatch(castActions.latchAnalysisEra({ bookId: BOOK }));
const toasts = () => store.getState().notifications.toasts;

let put: ReturnType<typeof vi.spyOn>;
let detectEmotions: ReturnType<typeof vi.spyOn>;
let detectInstruct: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store.dispatch(
    manuscriptActions.hydrateFromBookState({
      state: { bookId: BOOK, manuscriptId: 'm1', title: 'T' } as never,
      sentences: [{ id: 1, chapterId: 3, characterId: 'egor', text: 'Get down!' }] as never,
    }),
  );
  store.dispatch(uiActions.openBook({ id: BOOK, status: 'voices_pending' }));
  put = vi.spyOn(api, 'putBookState').mockResolvedValue({} as never);
  detectInstruct = vi.spyOn(api, 'detectInstruct').mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 } as never);
  detectEmotions = vi.spyOn(api, 'detectEmotions');
});
afterEach(() => {
  const era = store.getState().cast.analysisEra?.[BOOK];
  if (era) store.dispatch(castActions.clearAnalysisEra({ bookId: BOOK, epoch: era.epoch }));
  for (const t of toasts()) store.dispatch(notificationsActions.dismissToast(t.id));
  vi.restoreAllMocks();
});

describe('Detect emotions while the book is cast-read-only', () => {
  it('refuses at click time: no analyzer call, the read-only toast shows, no "Tagged" status', async () => {
    detectEmotions.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 } as never);
    render(<Provider store={store}><DetectEmotionsButton /></Provider>);
    latchEra();
    fireEvent.click(screen.getByTestId('detect-emotions-button'));
    await new Promise((r) => setTimeout(r, 30));

    expect(detectEmotions).not.toHaveBeenCalled();
    expect(detectInstruct).not.toHaveBeenCalled();
    expect(toasts().map((t) => t.dedupeKey)).toContain(CAST_READ_ONLY_DEDUPE_KEY);
    expect(screen.queryByTestId('detect-emotions-done')).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it('an era that rises mid-stream counts the annotations as skipped: read-only toast, book left unfinished, nothing reported tagged', async () => {
    detectEmotions.mockImplementation(async (_id: string, opts?: any) => {
      latchEra();
      opts.onAnnotation({ chapterId: 3, annotations: [{ sentenceId: 1, emotion: 'angry' }] });
      return { annotatedChapters: 1, totalAnnotations: 1 } as never;
    });
    render(<Provider store={store}><DetectEmotionsButton /></Provider>);
    fireEvent.click(screen.getByTestId('detect-emotions-button'));

    await waitFor(() => expect(put).toHaveBeenCalledWith(BOOK, { slice: 'state', patch: { prosodyAnnotated: false } }));
    const messages = toasts().map((t) => t.message).join(' | ');
    expect(messages).toMatch(/re-analysis is running/i);
    expect(messages).not.toMatch(/left the book/i);
    expect(store.getState().manuscript.sentences[0].emotion).toBeUndefined();
    expect(screen.queryByTestId('detect-emotions-done')).toBeNull();
  });
});
