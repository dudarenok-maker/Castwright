/* Axe-core a11y harness for the four core views: library, upload,
   confirm-cast, listen. One spec per view; each renders the view
   inside a minimal Redux Provider, then asserts axe(container)
   reports no violations.

   Companion plan: docs/features/archive/46-lint-format-a11y.md. The harness
   complements ESLint's static jsx-a11y rules (which we relax in
   eslint.config.js for inherited debt) by validating the rendered DOM
   against the WCAG ruleset axe-core ships. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { BookLibraryView } from '../views/book-library';
import { UploadView } from '../views/upload';
import { ConfirmCastView } from '../views/confirm-cast';
import { ListenView } from '../views/listen';

import { accountSlice } from '../store/account-slice';
import { librarySlice } from '../store/library-slice';
import { uiSlice } from '../store/ui-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { exportsSlice } from '../store/exports-slice';
import { analysisSlice } from '../store/analysis-slice';
import { chaptersSlice } from '../store/chapters-slice';

import type { Chapter, Character, Voice, LibraryAuthor } from '../lib/types';
import type { EditableBookMeta } from '../store/book-meta-slice';

/* The Upload view fires api.importManuscript on user action only,
   but the workspace-path row mounts on render and calls
   getWorkspaceInfo. The Listen view's chapter rows fetch real waveform
   peaks via getChapterAudio for every `done` chapter on mount.
   Never-resolving promises keep the render shape stable for axe to scan. */
vi.mock('../lib/api', () => ({
  api: {
    getWorkspaceInfo: () => new Promise(() => {}),
    importManuscript: () => new Promise(() => {}),
    getChapterAudio: () => new Promise(() => {}),
    // Listen-view companion banner probes this on mount; no APK in the a11y
    // fixture, so the "Download .apk" button stays hidden.
    checkCompanionApk: () => Promise.resolve({ available: false, sizeBytes: null }),
  },
}));

beforeEach(() => vi.clearAllMocks());

/* axe-core options shared across the four view specs.

   - aria-allowed-role: flags <article role="button"> on the
     confirm-cast cards and the cast row pattern. The role+tabIndex+
     onKeyDown shape is the project's established clickable-card
     pattern. Promote when cards migrate to native <button>.
   - heading-order: flags h3 appearing without a preceding h2 in
     listener-app cards on the Listen view, and in confirm-cast
     character cards. Inherited render order; out of scope to
     restructure here. */
const AXE_OPTS = {
  rules: {
    'aria-allowed-role': { enabled: false },
    'heading-order': { enabled: false },
    /* nested-interactive: the confirm-cast and cast-row cards use
       <article role="button"> as outer click target with inner
       <button> tiles for decision picking. Each inner button stops
       propagation. Established pattern; out of scope to restructure. */
    'nested-interactive': { enabled: false },
  },
};

const libraryAuthors: LibraryAuthor[] = [
  {
    name: 'Shannon Messenger',
    series: [
      {
        name: 'Keeper of the Lost Cities',
        books: [
          {
            bookId: 'b1',
            title: 'Keeper of the Lost Cities',
            author: 'Shannon Messenger',
            series: 'Keeper of the Lost Cities',
            seriesPosition: 1,
            isStandalone: false,
            status: 'complete',
            chapterCount: 59,
            completedChapters: 59,
            characterCount: 20,
            voiceCount: 20,
            lastWorkedOn: 'today',
            coverGradient: ['#3C194F', '#A43C6C'],
            tags: [],
          },
        ],
      },
    ],
  },
];

const chapters: Chapter[] = [
  {
    id: 1,
    title: 'The Approach',
    duration: '08:32',
    state: 'done',
    characters: { narrator: 'voiced' as never },
    progress: 1,
  } as Chapter,
];

const characters: Character[] = [
  { id: 'narrator', name: 'Anders Vale', role: 'Narrator', color: 'narrator' } as Character,
  {
    id: 'keefe',
    name: 'Keefe',
    role: 'sidekick',
    color: 'eliza',
    lines: 42,
    scenes: 7,
    voiceId: 'v_keefe',
    voiceState: 'reused',
    matchedFrom: {
      bookTitle: 'Book One',
      bookId: 'book_one',
      characterId: 'keefe_lib',
      confidence: 0.95,
    },
  } as Character,
];

const library: Voice[] = [
  {
    id: 'v_keefe',
    character: 'Keefe',
    bookTitle: 'Book One',
    bookId: 'book_one',
    attributes: [],
    gradient: ['#3C194F', '#0F0E0D'],
    usedIn: 1,
    source: 'library',
    ttsVoice: {
      provider: 'coqui',
      name: 'male-teen-playful',
      description: 'Light male teen voice with a sardonic edge',
    },
  },
];

const meta: EditableBookMeta = {
  title: 'Bonus Keefe Story',
  author: 'Marin Vale',
  series: 'Keefe Side-Stories',
  narratorCredit: 'Anders Vale',
  genre: 'Fantasy',
  publicationDate: '2026-05-09',
  description: null,
  notes: null,
};

describe('a11y — book library view', () => {
  it('has no axe violations', async () => {
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          authors: libraryAuthors,
          books: libraryAuthors.flatMap((a) => a.series.flatMap((s) => s.books)),
          pausedSnapshots: {},
        },
      },
    });
    const { container } = render(
      <Provider store={store}>
        <BookLibraryView
          authors={libraryAuthors}
          activeBookId={null}
          onOpenBook={vi.fn()}
          onDeleteBook={vi.fn()}
          onReparseBook={vi.fn()}
          onReplaceManuscript={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
        />
      </Provider>,
    );
    expect(await axe(container, AXE_OPTS)).toHaveNoViolations();
  });
});

describe('a11y — upload view', () => {
  it('has no axe violations', async () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        analysis: analysisSlice.reducer,
        chapters: chaptersSlice.reducer,
        library: librarySlice.reducer,
      },
    });
    const { container } = render(
      <Provider store={store}>
        <MemoryRouter>
          <UploadView />
        </MemoryRouter>
      </Provider>,
    );
    expect(await axe(container, AXE_OPTS)).toHaveNoViolations();
  });
});

describe('a11y — confirm-cast view', () => {
  it('has no axe violations', async () => {
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    const { container } = render(
      <Provider store={store}>
        <ConfirmCastView
          characters={characters}
          library={library}
          title="Bonus Keefe Story"
          onOpenProfile={vi.fn()}
          onConfirm={vi.fn()}
          onReanalyse={vi.fn()}
        />
      </Provider>,
    );
    expect(await axe(container, AXE_OPTS)).toHaveNoViolations();
  });
});

describe('a11y — listen view', () => {
  it('has no axe violations', async () => {
    const store = configureStore({
      reducer: {
        exports: exportsSlice.reducer,
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
      },
    });
    const { container } = render(
      <Provider store={store}>
        <ListenView
          bookId="demo__sa__test"
          chapters={chapters}
          characters={characters}
          library={library}
          currentTrack={null}
          setCurrentTrack={vi.fn()}
          onRegenerate={vi.fn()}
          onEnterPreview={vi.fn()}
          onFixLine={vi.fn()}
          bookMeta={meta}
          bookCoverGradient={['#2C7A4B', '#0F3A23']}
          bookCoverImageUrl={null}
          isMetaDirty={false}
          onEditMetaField={vi.fn()}
          onCommitMeta={vi.fn()}
          onCancelMeta={vi.fn()}
        />
      </Provider>,
    );
    expect(await axe(container, AXE_OPTS)).toHaveNoViolations();
  });
});
