import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { uiSlice } from '../store/ui-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { castSlice } from '../store/cast-slice';
import { scriptReviewSlice, scriptReviewActions, opKey } from '../store/script-review-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { notificationsSlice, type Toast } from '../store/notifications-slice';
import { api } from '../lib/api';
import { ScriptReviewDiff } from './script-review-diff';

function makeStore() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      cast: castSlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
      changeLog: changeLogSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: {
          kind: 'ready',
          bookId: 'book-A',
          view: 'manuscript',
          currentChapterId: 1,
          openProfileId: null,
        } as never,
      },
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        sentences: [
          { id: 1, chapterId: 1, text: '<em>Hello world</em>', characterId: 'narr' },
          { id: 2, chapterId: 1, text: 'She laughed.', characterId: 'narr' },
        ] as never,
      },
    },
  });

  // Seed the review bucket with two ops: one strip_tag and one fix_emotion
  store.dispatch(
    scriptReviewActions.setReview({
      bookId: 'book-A',
      ops: [
        {
          id: 1,
          op: 'strip_tag',
          newText: 'Hello world',
          rationale: 'remove tag',
          chapterId: 1,
        },
        {
          id: 2,
          op: 'fix_emotion',
          emotion: 'excited',
          rationale: 'energy up',
          chapterId: 1,
        },
      ],
      unappliable: [],
    }),
  );

  return store;
}

describe('fs-58 — ScriptReviewDiff', () => {
  it('returns null when there is no active review', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    const { container } = render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows an explicit empty state (not a blank body) when there are zero suggestions', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    /* A review that produced no ops still opens the modal (the bucket exists).
       Before the fix this rendered a blank body; now it must show a clear
       "No suggestions found" empty state. */
    store.dispatch(scriptReviewActions.setReview({ bookId: 'book-A', ops: [], unappliable: [] }));
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.getByText('Script review suggestions')).toBeTruthy();
    expect(screen.getByTestId('script-review-empty')).toBeInTheDocument();
    expect(screen.getByText('No suggestions found')).toBeInTheDocument();
  });

  it('applies selected ops and skips deselected ops on Apply', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    // Verify the modal is rendered with both ops shown
    expect(screen.getByText('Script review suggestions')).toBeTruthy();

    // Toggle op 2 (fix_emotion) OFF by clicking its checkbox
    const op2key = opKey(1, 2, 'fix_emotion');
    const checkbox = screen.getByTestId(`op-toggle-${op2key}`);
    fireEvent.click(checkbox);

    // Verify op2 is now deselected
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    // Click Apply
    fireEvent.click(screen.getByTestId('apply-button'));

    // fs-58 persistence Task 13 — hideReview fires (NOT clearReview), so the
    // bucket persists (just hidden). makeStore() doesn't seed versionByChapter,
    // so resolveAppliedOps has no ledger entry to resolve chapter 1 against and
    // skips its server call/local resolve — the persisted-resolve path (which
    // DOES remove a resolved op from the bucket) is covered by the dedicated
    // Task 13 tests below.
    const bucketAfterApply = store.getState().scriptReview.byBook['book-A'];
    expect(bucketAfterApply).toBeDefined();
    expect(bucketAfterApply?.visible).toBe(false);

    // strip_tag (op 1) WAS selected → sentence id=1 text updated
    const sentences = store.getState().manuscript.sentences;
    const sent1 = sentences.find((s) => s.chapterId === 1 && s.id === 1);
    expect(sent1?.text).toBe('Hello world');

    // fix_emotion (op 2) was DESELECTED → sentence id=2 emotion NOT set to excited
    const sent2 = sentences.find((s) => s.chapterId === 1 && s.id === 2);
    expect(sent2?.emotion).not.toBe('excited');

    // bumpBoundaryMove should have fired (op 1 applied → boundary_move event)
    const events = store.getState().changeLog.events;
    const boundaryEvent = events.find((e) => e.type === 'boundary_move');
    expect(boundaryEvent).toBeTruthy();
    expect(events[0]?.type).toBe('boundary_move');
  });

  /* fs-58 persistence Task 12 — this is now a TWO-step flow: "Dismiss all"
     opens a confirm prompt (no discard yet); the discard only fires once the
     operator explicitly confirms it. Nothing is applied either way. */
  it('dismisses all without applying, but only after confirming Dismiss all', async () => {
    const discardSpy = vi.spyOn(api, 'discardScriptReview').mockResolvedValue(undefined);
    const store = makeStore();
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('dismiss-button'));

    // Confirm prompt shown; nothing discarded yet.
    expect(screen.getByTestId('dismiss-confirm')).toBeInTheDocument();
    expect(discardSpy).not.toHaveBeenCalled();
    expect(store.getState().scriptReview.byBook['book-A']).toBeDefined();

    fireEvent.click(screen.getByTestId('dismiss-confirm-yes'));

    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith('book-A', [1]));
    await waitFor(() =>
      expect(store.getState().scriptReview.byBook['book-A']).toBeUndefined(),
    );

    // No sentence changes applied
    const sentences = store.getState().manuscript.sentences;
    const sent1 = sentences.find((s) => s.chapterId === 1 && s.id === 1);
    expect(sent1?.text).toBe('<em>Hello world</em>');

    discardSpy.mockRestore();
  });

  it('Cancel on the Dismiss-all confirm prompt keeps the bucket and never discards', () => {
    const discardSpy = vi.spyOn(api, 'discardScriptReview').mockResolvedValue(undefined);
    const store = makeStore();
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('dismiss-button'));
    fireEvent.click(screen.getByTestId('dismiss-confirm-cancel'));

    expect(screen.queryByTestId('dismiss-confirm')).toBeNull();
    expect(discardSpy).not.toHaveBeenCalled();
    expect(store.getState().scriptReview.byBook['book-A']).toBeDefined();

    discardSpy.mockRestore();
  });

  /* confirmDismissAll must derive chapterIds from the CURRENT ops array
     (dedup'd), not a stale or hardcoded list — cover a bucket spanning
     multiple chapters, including a repeated chapterId, to pin the dedupe. */
  it('confirming Dismiss all discards every chapter present in the bucket\'s ops, deduped', async () => {
    const discardSpy = vi.spyOn(api, 'discardScriptReview').mockResolvedValue(undefined);
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: { ...manuscriptSlice.getInitialState() },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [
          { id: 1, op: 'strip_tag', newText: 'x', rationale: 'r', chapterId: 1 },
          { id: 2, op: 'fix_emotion', emotion: 'angry', rationale: 'r', chapterId: 3 },
          // Same chapter as the first op — must not produce a duplicate entry.
          { id: 3, op: 'fix_emotion', emotion: 'sad', rationale: 'r', chapterId: 1 },
          { id: 4, op: 'flag_nonstory', rationale: 'r', chapterId: 2 },
        ],
        unappliable: [],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('dismiss-button'));
    fireEvent.click(screen.getByTestId('dismiss-confirm-yes'));

    await waitFor(() => expect(discardSpy).toHaveBeenCalledTimes(1));
    const [calledBookId, calledChapterIds] = discardSpy.mock.calls[0];
    expect(calledBookId).toBe('book-A');
    expect([...calledChapterIds].sort()).toEqual([1, 2, 3]);

    discardSpy.mockRestore();
  });

  /* This is the regression test for the reported data-loss bug: closing the
     modal (X button or backdrop) must never discard the findings the user
     hasn't acted on yet. */
  it('the X button dispatches hideReview, not a discard', () => {
    const discardSpy = vi.spyOn(api, 'discardScriptReview').mockResolvedValue(undefined);
    const store = makeStore();
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('close-button'));

    // Bucket data survives; only `visible` flips.
    const bucket = store.getState().scriptReview.byBook['book-A'];
    expect(bucket).toBeDefined();
    expect(bucket?.visible).toBe(false);
    expect(bucket?.ops).toHaveLength(2);
    expect(discardSpy).not.toHaveBeenCalled();

    discardSpy.mockRestore();
  });

  it('clicking the backdrop dispatches hideReview, not a discard — this is the regression test for the reported data-loss bug', () => {
    const discardSpy = vi.spyOn(api, 'discardScriptReview').mockResolvedValue(undefined);
    const store = makeStore();
    const { container } = render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    const backdrop = container.querySelector('.fixed.inset-0.bg-ink\\/40');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as Element);

    const bucket = store.getState().scriptReview.byBook['book-A'];
    expect(bucket).toBeDefined();
    expect(bucket?.visible).toBe(false);
    expect(bucket?.ops).toHaveLength(2);
    expect(discardSpy).not.toHaveBeenCalled();

    discardSpy.mockRestore();
  });

  it('renders the unappliable notice when bucket.unappliable is non-empty', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: { ...manuscriptSlice.getInitialState() },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [{ id: 1, op: 'fix_emotion', emotion: 'angry', rationale: 'r', chapterId: 1 }],
        unappliable: [
          {
            op: { id: 99, op: 'strip_tag', anchor: 'x', newText: 'x', rationale: 'r', chapterId: 1 },
            reason: 'anchor not found',
          },
        ],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    const notice = screen.getByTestId('unappliable-notice');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain("1 suggestion couldn't be applied");
  });

  it('renders a validate_instruct row with the Instruct heading and before → after', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [
            { id: 1, chapterId: 1, text: 'She spoke.', characterId: 'narr', instruct: 'shouting' },
          ] as never,
        },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [
          {
            id: 1,
            op: 'validate_instruct',
            newInstruct: 'a calm tone',
            rationale: 'tone mismatch',
            chapterId: 1,
          },
        ],
        unappliable: [],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.getByText('Instruct', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/shouting/)).toBeInTheDocument();
    expect(screen.getByText(/a calm tone/)).toBeInTheDocument();
  });

  it('does not render the unappliable notice when bucket.unappliable is empty', () => {
    const store = makeStore(); // makeStore seeds unappliable: []
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.queryByTestId('unappliable-notice')).toBeNull();
  });

  it('renders a reattribute row (not a silent blank) (fs-58 Unit B)', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [
            { id: 10, chapterId: 1, text: 'She said something.', characterId: 'narr' },
          ] as never,
        },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [
          {
            id: 10,
            op: 'reattribute',
            characterId: 'ferra',
            rationale: 'wrong speaker',
            chapterId: 1,
          },
        ],
        unappliable: [],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.getByText(/ferra/i)).toBeInTheDocument();
  });

  it('renders a flag_nonstory row struck (fs-58 Unit B)', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [
            { id: 42, chapterId: 1, text: 'p. 42', characterId: 'narr' },
          ] as never,
        },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [
          {
            id: 42,
            op: 'flag_nonstory',
            rationale: 'page number artifact',
            chapterId: 1,
          },
        ],
        unappliable: [],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.getByText('p. 42')).toHaveClass('line-through');
  });

  /* fs-58 Unit B — off-roster reattribute confirm queue.
     Two proposed ops with the SAME name, confirmed through the queue, must
     produce EXACTLY ONE api.createCharacter call (the dedupe guarantee) and
     reassign BOTH sentences to the single created character. */
  function makeProposedStore(
    ops: Array<{ id: number; chapterId: number; proposed: { name: string } }>,
    sentences: Array<{ id: number; chapterId: number; text: string; characterId: string }>,
    bookId = 'book-A',
    versionByChapter: Record<number, number> = {},
  ) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId,
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: sentences as never,
        },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId,
        ops: ops.map((o) => ({
          id: o.id,
          chapterId: o.chapterId,
          op: 'reattribute' as const,
          proposed: o.proposed,
          rationale: 'off-roster speaker',
        })),
        unappliable: [],
        versionByChapter,
      }),
    );
    // reattribute defaults to UNSELECTED — select the class so Apply picks them up.
    store.dispatch(scriptReviewActions.toggleClass({ bookId, op: 'reattribute' }));
    return store;
  }

  let createSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Mock the create endpoint: return a FULL Character envelope keyed off the
    // submitted name (no network). Mirrors mockCreateCharacter's slug shape.
    createSpy = vi.spyOn(api, 'createCharacter').mockImplementation(async (_bookId, fields) => {
      const slug =
        fields.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') ||
        'character';
      return {
        character: {
          id: slug,
          name: fields.name.trim(),
          role: 'character',
          color: 'unset',
          voiceState: 'generated',
        },
      } as never;
    });
  });
  afterEach(() => {
    createSpy.mockRestore();
  });

  it('two same-name proposed ops create EXACTLY one character through the queue (dedupe)', async () => {
    // fs-58 persistence Task 14 — seed a ledger version so the per-op
    // onOpApplied → resolveAppliedOps wiring has something to resolve
    // against; mock the resolve endpoint so both ops (the newly-created one
    // AND the deduped one that reused its id) get resolved server-side.
    const resolveSpy = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true });
    const store = makeProposedStore(
      [
        { id: 5, chapterId: 1, proposed: { name: 'Ferra' } },
        { id: 7, chapterId: 1, proposed: { name: 'ferra ' } },
      ],
      [
        { id: 5, chapterId: 1, text: 'Line five.', characterId: 'narr' },
        { id: 7, chapterId: 1, text: 'Line seven.', characterId: 'narr' },
      ],
      'book-A',
      { 1: 1 },
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('apply-button'));

    // Confirm op 1 of 2 — the form is pre-filled with «Ferra».
    expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('create-character-submit'));

    // Confirm op 2 of 2 — pre-filled with «ferra ».
    await waitFor(() => expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('create-character-submit'));

    // Both ops resolve per-op (including the deduped one, which never calls
    // createCharacter) → bucket ends up empty → deleted by resolveOpsLocally.
    await waitFor(() =>
      expect(store.getState().scriptReview.byBook['book-A']).toBeUndefined(),
    );
    expect(resolveSpy).toHaveBeenCalledWith('book-A', {
      chapterId: 1,
      version: 1,
      appliedOpKeys: [opKey(1, 5, 'reattribute')],
    });
    expect(resolveSpy).toHaveBeenCalledWith('book-A', {
      chapterId: 1,
      version: 1,
      appliedOpKeys: [opKey(1, 7, 'reattribute')],
    });

    // EXACTLY one create despite two same-name ops.
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Both sentences reassigned to the one created id; one character added.
    const created = store.getState().cast.characters;
    expect(created).toHaveLength(1);
    const newId = created[0].id;
    const sentences = store.getState().manuscript.sentences;
    expect(sentences.find((s) => s.id === 5)?.characterId).toBe(newId);
    expect(sentences.find((s) => s.id === 7)?.characterId).toBe(newId);

    resolveSpy.mockRestore();
  });

  it('a failed create surfaces a toast, closes the confirm dialog, and keeps the review for retry (#1122)', async () => {
    createSpy.mockRejectedValueOnce(new Error('boom'));
    const store = makeProposedStore(
      [{ id: 5, chapterId: 1, proposed: { name: 'Ferra' } }],
      [{ id: 5, chapterId: 1, text: 'Line five.', characterId: 'narr' }],
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('apply-button'));
    expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('create-character-submit'));

    // Error toast surfaced. This is the ONLY assertion here that distinguishes
    // fixed-vs-unfixed — the two below pass pre-fix too (the dialog closes on
    // queue-exhaust regardless, and the throw already skips clearReview).
    await waitFor(() => {
      const toasts: Toast[] = store.getState().notifications.toasts;
      expect(toasts.some((t) => t.kind === 'error' && /couldn't create character/i.test(t.message))).toBe(
        true,
      );
    });
    // Confirm dialog closed.
    expect(screen.queryByTestId('confirm-reattribute')).toBeNull();
    // Review bucket retained for retry (NOT cleared).
    expect(store.getState().scriptReview.byBook['book-A']).toBeDefined();
  });

  it('cancelling mid-confirm creates NO not-yet-confirmed member and hides (not discards) the review', async () => {
    const store = makeProposedStore(
      [
        { id: 5, chapterId: 1, proposed: { name: 'Ferra' } },
        { id: 7, chapterId: 1, proposed: { name: 'Gus' } },
      ],
      [
        { id: 5, chapterId: 1, text: 'Line five.', characterId: 'narr' },
        { id: 7, chapterId: 1, text: 'Line seven.', characterId: 'narr' },
      ],
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('apply-button'));
    expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument();

    // Cancel on the FIRST op — Gus is never even reached.
    fireEvent.click(screen.getByText('Cancel'));

    // No character created; confirm dialog closed.
    expect(createSpy).not.toHaveBeenCalled();
    expect(store.getState().cast.characters).toHaveLength(0);
    expect(screen.queryByTestId('confirm-reattribute')).toBeNull();

    // fs-58 persistence Task 14 — cancel HIDES, it does not discard: the
    // bucket (both proposed ops, still unresolved) survives, just hidden.
    const bucket = store.getState().scriptReview.byBook['book-A'];
    expect(bucket).toBeDefined();
    expect(bucket?.visible).toBe(false);
    expect(bucket?.ops.map((o) => o.id)).toEqual([5, 7]);
  });

  /* fs-58 persistence Task 14 — the async off-roster reattribute confirm
     queue gets the same per-op resolve treatment Task 13 gave the
     synchronous Apply path: a batch-tail failure or a mid-batch cancel must
     never discard an op that was never actually applied (or already
     resolved). */
  it('a partially-failing off-roster reattribute batch resolves only the ops that succeeded', async () => {
    // First proposed name creates successfully; the second (queued after it
    // in the confirm sequence) rejects, aborting the rest of the batch.
    createSpy.mockResolvedValueOnce({
      character: {
        id: 'nova-id',
        name: 'Nova',
        role: 'character',
        color: 'unset',
        voiceState: 'generated',
      },
    } as never);
    createSpy.mockRejectedValueOnce(new Error('boom'));
    const resolveSpy = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true });

    const store = makeProposedStore(
      [
        { id: 5, chapterId: 1, proposed: { name: 'Nova' } },
        { id: 7, chapterId: 1, proposed: { name: 'Sol' } },
      ],
      [
        { id: 5, chapterId: 1, text: 'Line five.', characterId: 'narr' },
        { id: 7, chapterId: 1, text: 'Line seven.', characterId: 'narr' },
      ],
      'book-A',
      { 1: 1 },
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('apply-button'));
    expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('create-character-submit')); // Nova

    await waitFor(() => expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument());
    // The confirm form's Name field is uncontrolled-from-props (useState(initial)
    // with no key on the wrapper, so it doesn't reset between confirm-queue
    // steps) — mirror what an operator actually does and retype the name for
    // op 2 so it submits «Sol», not the stale «Nova» left over from op 1.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sol' } });
    fireEvent.click(screen.getByTestId('create-character-submit')); // Sol → rejects

    await waitFor(() => {
      const toasts: Toast[] = store.getState().notifications.toasts;
      expect(
        toasts.some((t) => t.kind === 'error' && /couldn't create character/i.test(t.message)),
      ).toBe(true);
    });

    const novaKey = opKey(1, 5, 'reattribute');
    const solKey = opKey(1, 7, 'reattribute');
    // Nova (the op that actually applied) was resolved server-side — exactly once.
    expect(resolveSpy).toHaveBeenCalledWith('book-A', {
      chapterId: 1,
      version: 1,
      appliedOpKeys: [novaKey],
    });
    // Sol never applied (the create for it rejected) — never resolved.
    expect(resolveSpy).not.toHaveBeenCalledWith(
      'book-A',
      expect.objectContaining({ appliedOpKeys: [solKey] }),
    );

    // Nova is gone from the bucket (resolved + removed); Sol is still there,
    // still visible in the list, for the operator to retry.
    await waitFor(() => {
      const bucket = store.getState().scriptReview.byBook['book-A'];
      expect(bucket?.ops.map((o) => o.id)).toEqual([7]);
    });
    expect(screen.getByText(/#7/)).toBeInTheDocument();

    resolveSpy.mockRestore();
  });

  /* PR-review fix (Finding 1) — regression test for the reattribute-to-
     existing-roster-member path never resolving server-side. Modeled on the
     'two same-name proposed ops create EXACTLY one character' test above,
     but the typed/proposed name matches an EXISTING cast member, so
     CreateCharacterForm routes through onReattributeExisting instead of
     onSubmit. */
  it('reattribute-to-an-existing-cast-member op resolves server-side (Finding 1 regression)', async () => {
    const resolveSpy = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true });
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        cast: castSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [{ id: 5, chapterId: 1, text: 'Line five.', characterId: 'narr' }] as never,
        },
        cast: {
          ...castSlice.getInitialState(),
          characters: [{ id: 'ferra-id', name: 'Ferra' }] as never,
        },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [
          {
            id: 5,
            chapterId: 1,
            op: 'reattribute',
            proposed: { name: 'Ferra' },
            rationale: 'off-roster speaker, name matches an existing cast member',
          },
        ],
        unappliable: [],
        versionByChapter: { 1: 3 },
      }),
    );
    // reattribute defaults to UNSELECTED — select the class so Apply picks it up.
    store.dispatch(scriptReviewActions.toggleClass({ bookId: 'book-A', op: 'reattribute' }));

    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('apply-button'));

    // Confirm dialog is pre-filled with "Ferra", which matches the existing
    // roster member — the submit button switches to the reattribute-existing
    // label/handler instead of create.
    expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument();
    expect(screen.getByTestId('create-character-submit')).toHaveTextContent('Reattribute to «Ferra»');
    fireEvent.click(screen.getByTestId('create-character-submit'));

    // Manuscript mutation applies immediately (this part already worked pre-fix).
    await waitFor(() => {
      const sentences = store.getState().manuscript.sentences;
      expect(sentences.find((s) => s.id === 5)?.characterId).toBe('ferra-id');
    });
    expect(createSpy).not.toHaveBeenCalled();

    // Previously this op was applied but NEVER resolved server-side, so it
    // stayed in the bucket/ledger forever. It must now be resolved exactly
    // like any other applied op.
    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith('book-A', {
        chapterId: 1,
        version: 3,
        appliedOpKeys: [opKey(1, 5, 'reattribute')],
      });
    });
    await waitFor(() => {
      expect(store.getState().scriptReview.byBook['book-A']).toBeUndefined();
    });

    resolveSpy.mockRestore();
  });

  it('cancelling the confirm queue mid-batch hides rather than discards', async () => {
    const discardSpy = vi.spyOn(api, 'discardScriptReview').mockResolvedValue(undefined);
    const store = makeProposedStore(
      [{ id: 5, chapterId: 1, proposed: { name: 'Nova' } }],
      [{ id: 5, chapterId: 1, text: 'Line five.', characterId: 'narr' }],
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('apply-button'));
    expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));

    // Modal's confirm overlay is gone; nothing was discarded server-side.
    expect(screen.queryByTestId('confirm-reattribute')).toBeNull();
    expect(discardSpy).not.toHaveBeenCalled();

    const bucket = store.getState().scriptReview.byBook['book-A'];
    expect(bucket).toBeDefined();
    expect(bucket?.visible).toBe(false);
    expect(bucket?.ops.map((o) => o.id)).toEqual([5]);

    // Reopening (the badge/"Review existing" path — showReview) flips
    // visible back and the op is still there; cancel never discarded it.
    store.dispatch(scriptReviewActions.showReview({ bookId: 'book-A' }));
    const reopened = store.getState().scriptReview.byBook['book-A'];
    expect(reopened?.visible).toBe(true);
    expect(reopened?.ops.map((o) => o.id)).toEqual([5]);

    discardSpy.mockRestore();
  });

  /* fs-58 persistence Task 13 — Apply now resolves the applied ops server-side
     (design spec §6.5) instead of wiping the whole bucket via clearReview.
     This is the regression coverage for the Critical bug Round 3 review
     caught: the old tail's `clearReview` deleted every op in the bucket,
     including ones the user left unchecked — on the single most common Apply
     path (a partial selection). Real slice reducers throughout, matching this
     file's other tests; `api.*` is spied per-test (this file's convention —
     see the discardScriptReview/createCharacter spies above) rather than a
     module-level `vi.mock`. */
  describe('fs-58 persistence Task 13 — resolve applied ops server-side, sync selection state', () => {
    function makeResolvableStore(bookId = 'book-1') {
      const store = configureStore({
        reducer: {
          ui: uiSlice.reducer,
          manuscript: manuscriptSlice.reducer,
          cast: castSlice.reducer,
          scriptReview: scriptReviewSlice.reducer,
          changeLog: changeLogSlice.reducer,
        },
        preloadedState: {
          ui: {
            ...uiSlice.getInitialState(),
            stage: {
              kind: 'ready',
              bookId,
              view: 'manuscript',
              currentChapterId: 1,
              openProfileId: null,
            } as never,
          },
          manuscript: {
            ...manuscriptSlice.getInitialState(),
            sentences: [
              { id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' },
              { id: 2, chapterId: 2, text: 'Other.', characterId: 'c1' },
            ] as never,
          },
          cast: {
            ...castSlice.getInitialState(),
            characters: [{ id: 'c1', name: 'Ada' }] as never,
          },
        },
      });
      store.dispatch(
        scriptReviewActions.setReview({
          bookId,
          ops: [
            { id: 1, chapterId: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' },
            { id: 2, chapterId: 2, op: 'fix_emotion', emotion: 'sad', rationale: 'r' },
          ],
          unappliable: [],
          versionByChapter: { 1: 5, 2: 7 },
        }),
      );
      // setReview's DEFAULT_OFF set only covers reattribute/flag_nonstory, so
      // both ops default selected. Deselect the chapter-2 op to simulate the
      // user leaving it unchecked — the scenario the Critical bug lost.
      store.dispatch(scriptReviewActions.toggleOp({ bookId, key: opKey(2, 2, 'fix_emotion') }));
      return store;
    }

    it("Apply calls resolveScriptReviewOps with exactly the applied ops' keys, grouped per chapter", async () => {
      const resolveSpy = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true });
      const store = makeResolvableStore('book-1');
      render(
        <Provider store={store}>
          <ScriptReviewDiff bookId="book-1" />
        </Provider>,
      );

      fireEvent.click(screen.getByTestId('apply-button'));

      await waitFor(() => {
        expect(resolveSpy).toHaveBeenCalledWith('book-1', {
          chapterId: 1,
          version: 5,
          appliedOpKeys: [opKey(1, 1, 'strip_tag')],
        });
      });
      expect(resolveSpy).not.toHaveBeenCalledWith(
        'book-1',
        expect.objectContaining({ chapterId: 2 }),
      );

      resolveSpy.mockRestore();
    });

    it('unselected ops remain in the bucket after Apply — regression test for the prior discard-everything behavior', async () => {
      const resolveSpy = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: true });
      const store = makeResolvableStore('book-1');
      render(
        <Provider store={store}>
          <ScriptReviewDiff bookId="book-1" />
        </Provider>,
      );

      fireEvent.click(screen.getByTestId('apply-button'));

      await waitFor(() => {
        expect(resolveSpy).toHaveBeenCalled();
      });
      // The chapter-2 op was left unselected — it must still be in the store,
      // not wiped by a whole-bucket clearReview call.
      await waitFor(() => {
        const bucket = store.getState().scriptReview.byBook['book-1'];
        expect(bucket?.ops).toEqual([
          expect.objectContaining({ id: 2, chapterId: 2, op: 'fix_emotion' }),
        ]);
      });

      resolveSpy.mockRestore();
    });

    it("toggling a checkbox schedules a debounced selection PATCH with the chapter's version", () => {
      vi.useFakeTimers();
      const patchSpy = vi.spyOn(api, 'patchScriptReviewSelection').mockResolvedValue({ ok: true });
      const store = makeResolvableStore('book-1');
      render(
        <Provider store={store}>
          <ScriptReviewDiff bookId="book-1" />
        </Provider>,
      );

      const key = opKey(1, 1, 'strip_tag');
      fireEvent.click(screen.getByTestId(`op-toggle-${key}`));

      // No PATCH yet — still inside the debounce window.
      expect(patchSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(500);

      expect(patchSpy).toHaveBeenCalledWith('book-1', {
        chapterId: 1,
        version: 5,
        selected: { [key]: false },
      });

      patchSpy.mockRestore();
      vi.useRealTimers();
    });

    /* PR-review fix (Finding 3) — a stale server-side ledger version (e.g. a
       second tab already resolved this chapter) must surface a warning toast
       instead of silently swallowing the failure, and must NOT remove the op
       from the local bucket (the manuscript mutation already happened, so
       dropping it silently risks a duplicate re-apply on a second click). */
    it('a stale-version resolve failure surfaces a warn toast and keeps the op in the bucket', async () => {
      const resolveSpy = vi.spyOn(api, 'resolveScriptReviewOps').mockResolvedValue({ ok: false });
      const store = configureStore({
        reducer: {
          ui: uiSlice.reducer,
          manuscript: manuscriptSlice.reducer,
          cast: castSlice.reducer,
          scriptReview: scriptReviewSlice.reducer,
          changeLog: changeLogSlice.reducer,
          notifications: notificationsSlice.reducer,
        },
        preloadedState: {
          ui: {
            ...uiSlice.getInitialState(),
            stage: {
              kind: 'ready',
              bookId: 'book-1',
              view: 'manuscript',
              currentChapterId: 1,
              openProfileId: null,
            } as never,
          },
          manuscript: {
            ...manuscriptSlice.getInitialState(),
            sentences: [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }] as never,
          },
          cast: {
            ...castSlice.getInitialState(),
            characters: [{ id: 'c1', name: 'Ada' }] as never,
          },
        },
      });
      store.dispatch(
        scriptReviewActions.setReview({
          bookId: 'book-1',
          ops: [{ id: 1, chapterId: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }],
          unappliable: [],
          versionByChapter: { 1: 5 },
        }),
      );
      render(
        <Provider store={store}>
          <ScriptReviewDiff bookId="book-1" />
        </Provider>,
      );

      fireEvent.click(screen.getByTestId('apply-button'));

      // The manuscript mutation already happened (dispatchAcceptedOps runs
      // before the async resolve call), regardless of the resolve outcome.
      await waitFor(() => {
        const sentences = store.getState().manuscript.sentences;
        expect(sentences.find((s) => s.id === 1)?.text).toBe('Hi');
      });

      await waitFor(() => expect(resolveSpy).toHaveBeenCalled());

      // Warn toast surfaced instead of silently swallowing the failure.
      await waitFor(() => {
        const toasts: Toast[] = store.getState().notifications.toasts;
        expect(
          toasts.some((t) => t.kind === 'warn' && /changed elsewhere/i.test(t.message)),
        ).toBe(true);
      });

      // The op is NOT removed from the bucket — resolveOpsLocally must never
      // fire on a failed resolve.
      const bucket = store.getState().scriptReview.byBook['book-1'];
      expect(bucket).toBeDefined();
      expect(bucket?.ops.map((o) => o.id)).toEqual([1]);

      resolveSpy.mockRestore();
    });
  });
});
