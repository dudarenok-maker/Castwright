// Pairs with docs/features/archive/02-upload-paste-or-file.md (existing path)
//       AND docs/features/archive/74-manuscript-diff-on-reupload.md (new path).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  api: {
    importManuscript: vi.fn(async (args: { text?: string; fileName?: string }) => ({
      tempId: 'imp_test',
      candidate: {
        format: 'markdown' as const,
        title: 'Solway Bay',
        author: 'Marin Vale',
        series: 'Northern Coast Trilogy',
        seriesPosition: 1,
        sourceText: args.text ?? '',
        wordCount: (args.text ?? '').trim().split(/\s+/).filter(Boolean).length,
        byteSize: (args.text ?? '').length,
        chapters: [{ id: 1, title: 'Chapter 1' }],
      },
    })),
    loadSample: vi.fn(async () => ({ bookId: 'castwright__standalones__the-coalfall-commission' })),
    getLibrary: vi.fn(async () => ({ authors: [], books: [] })),
  },
  SlugCollisionError: class SlugCollisionError extends Error {},
}));

import { UploadView } from './upload';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { librarySlice } from '../store/library-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { accountSlice } from '../store/account-slice';
import type { LibraryBook, Sentence } from '../lib/types';

function makeStore(opts: {
  reuploadingBookId?: string | null;
  libraryBooks?: LibraryBook[];
  oldSentences?: Sentence[];
  oldSourceText?: string | null;
} = {}) {
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      ui: uiSlice.reducer,
      library: librarySlice.reducer,
      chapters: chaptersSlice.reducer,
      notifications: notificationsSlice.reducer,
      account: accountSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        bookId: opts.reuploadingBookId ?? null,
        sourceText: opts.oldSourceText ?? null,
        sentences: opts.oldSentences ?? manuscriptSlice.getInitialState().sentences,
      },
      ui: {
        ...uiSlice.getInitialState(),
        reuploadingBookId: opts.reuploadingBookId ?? null,
      },
      library: {
        loaded: true,
        authors: [],
        books: opts.libraryBooks ?? [],
        pausedSnapshots: {},
      },
    },
  });
  return store;
}

function renderUpload(store: ReturnType<typeof makeStore>) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/new']}>
        <Routes>
          <Route path="/new" element={<UploadView />} />
          <Route path="/books/:bookId/listen" element={<div data-testid="listen-stub" />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

const reuploadBook: LibraryBook = {
  bookId: 'bk_a',
  title: 'Solway Bay',
  author: 'Marin Vale',
  series: 'Northern Coast Trilogy',
  seriesPosition: 1,
  isStandalone: false,
  status: 'complete',
  chapterCount: 1,
  completedChapters: 1,
  characterCount: 1,
  voiceCount: 1,
  lastWorkedOn: 'today',
  coverGradient: ['#000', '#fff'],
  tags: [],
};

const oldSentences = (texts: string[]): Sentence[] =>
  texts.map((t, i) => ({ id: i + 1, chapterId: 1, text: t, characterId: 'narrator' }));

beforeEach(() => {
  vi.clearAllMocks();
});

/* Wave 3 — phone viewport contract: the dropzone, model selector, and
   action chips render full-width at 375×667 and the primary tap targets
   (paste-text button, dropzone, model select) hit the ≥44px height the
   touch-equivalence rule in `docs/features/archive/81-mobile-tablet-support.md`
   pins. matchMedia is mocked to "phone" so Tailwind's `sm:` variants
   stay opted-out at the same time. */
function mockPhoneViewport() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: /max-width:\s*640px/.test(query) || /max-width:\s*767px/.test(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('UploadView — phone viewport (375×667, Wave 3)', () => {
  beforeEach(() => {
    mockPhoneViewport();
  });

  it('renders the dropzone full-width with a ≥44px tap target', () => {
    const store = makeStore();
    renderUpload(store);
    const dropzone = screen.getByTestId('dropzone');
    /* class assertion is the deterministic phone-render signal in jsdom
       (jsdom has no layout, so we can't read computed pixels). The
       w-full + min-h-[140px] pair locks both the width + the
       ≥44px-target invariant from plan 81. */
    expect(dropzone.className).toContain('w-full');
    expect(dropzone.className).toContain('min-h-[140px]');
  });

  it('keeps the model-selector touch target ≥44px tall', () => {
    const store = makeStore();
    renderUpload(store);
    const select = screen.getByLabelText(/analysis model/i);
    expect(select.className).toContain('min-h-[44px]');
    expect(select.className).toContain('w-full');
  });

  it('stacks "Try the demo book" / "Paste text" buttons full-width with ≥44px tap targets', () => {
    const store = makeStore();
    renderUpload(store);
    const sample = screen.getByRole('button', { name: /try the demo book/i });
    const paste = screen.getByRole('button', { name: /paste text/i });
    for (const btn of [sample, paste]) {
      expect(btn.className).toContain('w-full');
      expect(btn.className).toContain('min-h-[44px]');
    }
  });
});

describe('UploadView — first-time upload (existing path unchanged)', () => {
  it('on success, sets importCandidate (routes to ConfirmMetadata via the route adapter)', async () => {
    const store = makeStore();
    renderUpload(store);
    const user = userEvent.setup();
    /* Paste-and-upload as the simplest deterministic input. */
    await user.click(screen.getByRole('button', { name: /paste text/i }));
    const textarea = await screen.findByPlaceholderText(/Chapter 1/i);
    await user.type(textarea, 'Hello world.');
    await user.click(screen.getByRole('button', { name: /upload pasted text/i }));
    await waitFor(() => {
      expect(store.getState().manuscript.importCandidate).not.toBeNull();
    });
    /* No pendingReupload was set — this is the first-time path. */
    expect(store.getState().manuscript.pendingReupload).toBeNull();
  });
});

describe('UploadView — Wave 2 brand (on-ramp tagline)', () => {
  it('shows "Any book, fully cast." on the new-project branch', () => {
    const store = makeStore();
    renderUpload(store);
    expect(screen.getByText('Any book, fully cast.')).toBeInTheDocument();
  });
});

describe('UploadView — re-upload mode (plan 74)', () => {
  it('renders the re-upload banner and the book title when reuploadingBookId is set', () => {
    const store = makeStore({
      reuploadingBookId: 'bk_a',
      libraryBooks: [reuploadBook],
      oldSentences: oldSentences(['Original sentence.']),
      oldSourceText: 'Original sentence.',
    });
    renderUpload(store);
    expect(screen.getByText(/Replace manuscript/i)).toBeInTheDocument();
    expect(screen.getByText(/see what changed/i)).toBeInTheDocument();
    expect(screen.getByTestId('reupload-book-title').textContent).toBe('Solway Bay');
  });

  it('on upload, dispatches previewReuploadDiff instead of setImportCandidate', async () => {
    const store = makeStore({
      reuploadingBookId: 'bk_a',
      libraryBooks: [reuploadBook],
      oldSentences: oldSentences(['Original sentence.']),
      oldSourceText: 'Original sentence.',
    });
    renderUpload(store);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /paste text/i }));
    const textarea = await screen.findByPlaceholderText(/Chapter 1/i);
    await user.type(textarea, 'New sentence.');
    await user.click(screen.getByRole('button', { name: /upload pasted text/i }));
    await waitFor(() => {
      expect(store.getState().manuscript.pendingReupload).not.toBeNull();
    });
    /* The first-time path's importCandidate stays null in re-upload mode. */
    expect(store.getState().manuscript.importCandidate).toBeNull();
    const pending = store.getState().manuscript.pendingReupload;
    expect(pending?.bookId).toBe('bk_a');
    expect(pending?.newCandidate.sourceText).toBe('New sentence.');
  });

  it('opens the diff modal with the diff against the existing sentences', async () => {
    const store = makeStore({
      reuploadingBookId: 'bk_a',
      libraryBooks: [reuploadBook],
      oldSentences: oldSentences(['Original sentence.']),
      oldSourceText: 'Original sentence.',
    });
    renderUpload(store);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /paste text/i }));
    const textarea = await screen.findByPlaceholderText(/Chapter 1/i);
    await user.type(textarea, 'New sentence.');
    await user.click(screen.getByRole('button', { name: /upload pasted text/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('manuscript-diff-modal')).toBeInTheDocument();
    });
    /* The diff should surface one `replace` row mapping
       "Original sentence." → "New sentence." */
    expect(screen.getAllByTestId('diff-row-replace')).toHaveLength(1);
  });

  it('Apply commits the new manuscript and navigates back to the book', async () => {
    const store = makeStore({
      reuploadingBookId: 'bk_a',
      libraryBooks: [reuploadBook],
      oldSentences: oldSentences(['Original sentence.']),
      oldSourceText: 'Original sentence.',
    });
    /* Seed the slice directly with a pendingReupload to skip the
       upload round-trip and isolate the Apply behaviour. */
    store.dispatch(
      manuscriptActions.previewReuploadDiff({
        bookId: 'bk_a',
        newSourceText: 'Revised sentence.',
        newSentences: oldSentences(['Revised sentence.']),
        newWordCount: 2,
      }),
    );
    renderUpload(store);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('diff-apply'));
    /* Slice should now reflect the new text and the pending slot
       should be cleared. */
    expect(store.getState().manuscript.sourceText).toBe('Revised sentence.');
    expect(store.getState().manuscript.pendingReupload).toBeNull();
    expect(store.getState().ui.reuploadingBookId).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId('listen-stub')).toBeInTheDocument();
    });
  });

  it('Discard restores the OLD manuscript and navigates back to the book', async () => {
    const store = makeStore({
      reuploadingBookId: 'bk_a',
      libraryBooks: [reuploadBook],
      oldSentences: oldSentences(['Original sentence.']),
      oldSourceText: 'Original sentence.',
    });
    store.dispatch(
      manuscriptActions.previewReuploadDiff({
        bookId: 'bk_a',
        newSourceText: 'Revised sentence.',
        newSentences: oldSentences(['Revised sentence.']),
        newWordCount: 2,
      }),
    );
    renderUpload(store);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('diff-discard'));
    /* Slice retains the OLD text — Discard rolled back. */
    expect(store.getState().manuscript.sourceText).toBe('Original sentence.');
    expect(store.getState().manuscript.pendingReupload).toBeNull();
    expect(store.getState().ui.reuploadingBookId).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId('listen-stub')).toBeInTheDocument();
    });
  });

  it('"Any book, fully cast." tagline absent on re-upload branch (Wave 2 brand)', () => {
    const store = makeStore({
      reuploadingBookId: 'bk_a',
      libraryBooks: [reuploadBook],
    });
    renderUpload(store);
    expect(screen.queryByText('Any book, fully cast.')).not.toBeInTheDocument();
  });

  it('Cancel re-upload returns to the book without showing the diff modal', async () => {
    const store = makeStore({
      reuploadingBookId: 'bk_a',
      libraryBooks: [reuploadBook],
      oldSentences: oldSentences(['Original sentence.']),
      oldSourceText: 'Original sentence.',
    });
    renderUpload(store);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('reupload-cancel'));
    expect(store.getState().ui.reuploadingBookId).toBeNull();
    expect(store.getState().manuscript.pendingReupload).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId('listen-stub')).toBeInTheDocument();
    });
  });
});
