/* Plan 81 Wave 3 — Listen-view responsive render smoke tests.

   Pins that the three Listen sub-components mount without throwing at
   a 375x667 phone viewport (mobile-first invariant). matchMedia is
   stubbed to a phone-sized viewport so any `useMediaQuery`-style hook
   added later still resolves; the CSS-only `md:` / `lg:` responsive
   utilities don't read it (Tailwind compiles to fixed media queries),
   but the mock guards against jsdom's default `matchMedia: undefined`
   tripping consumers.

   This is a smoke gate — the visual / layout regression bar lives in
   the Playwright mobile-chrome project. Here we only assert that the
   tree renders, the WCAG 2.5.5 touch-target idiom (min-h-[44px] or
   w-11 h-11) survived the responsive rewrite, and the chapter row's
   stacked-on-mobile reshape didn't drop the data-testid hooks that
   listen.test.tsx + the LUFS badge spec rely on. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { ListenHeader } from './listen-header';
import { ListenPlayerRegion } from './listen-player-region';
import { ListenDownloadSection } from './listen-download-section';
import { listenProgressSlice } from '../../store/listen-progress-slice';
import type { Chapter } from '../../lib/types';

/* matchMedia shim: every query resolves as if the viewport were 375 px
   wide (phone). Components that don't query matchMedia at all are
   unaffected; this just stops `window.matchMedia(...)` from being
   undefined in jsdom. */
function installPhoneMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      /* Tailwind's md = 768 px, lg = 1024 px. At 375 we match
         `max-width: 767px` style queries and reject `min-width: 768px`. */
      const matchesMin = /min-width:\s*(\d+)px/i.exec(query);
      const matchesMax = /max-width:\s*(\d+)px/i.exec(query);
      let matches = false;
      if (matchesMin) matches = 375 >= Number(matchesMin[1]);
      else if (matchesMax) matches = 375 <= Number(matchesMax[1]);
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function makeStore() {
  return configureStore({
    reducer: { listenProgress: listenProgressSlice.reducer },
  });
}

beforeEach(() => {
  installPhoneMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ListenHeader — phone viewport render (plan 81 wave 3)', () => {
  it('renders without throwing at 375x667 and keeps the action buttons', () => {
    render(
      <ListenHeader
        title="the Coalfall Commission"
        author="Marin Vale"
        narratorName="Anders Vale"
        voiceCount={3}
        totalSec={3600}
        chapterCount={12}
        completedCount={12}
        hasListenable
        firstListenableId={1}
        bookCoverGradient={['#2C7A4B', '#0F3A23']}
        effectiveCoverUrl={null}
        coverLoadFailed={false}
        onCoverLoadFailed={vi.fn()}
        onChangeCover={vi.fn()}
        onPlayFromStart={vi.fn()}
        onOpenExportModal={vi.fn()}
        onEnterPreview={vi.fn()}
        onOpenRestructure={vi.fn()}
        onReplaceManuscript={vi.fn()}
        notes={null}
      />,
    );
    /* Title + primary actions stay reachable. (h1 + cover-art h2 both
       carry the title, so the assertion uses getAllByText to tolerate
       both render sites.) */
    expect(screen.getAllByText('the Coalfall Commission').length).toBeGreaterThan(0);
    expect(screen.getByTestId('open-export-modal')).toBeInTheDocument();
    expect(screen.getByTestId('listen-replace-manuscript')).toBeInTheDocument();
    /* Touch-target invariant: the export button declares min-h-[44px]
       (WCAG 2.5.5) so phone taps stay reliable. */
    expect(screen.getByTestId('open-export-modal').className).toMatch(/min-h-\[44px\]/);
  });

  it('renders the collapsible Notes card with a touch-friendly toggle', () => {
    render(
      <ListenHeader
        title="Test Book"
        author="Author"
        narratorName={null}
        voiceCount={0}
        totalSec={0}
        chapterCount={0}
        completedCount={0}
        hasListenable={false}
        firstListenableId={null}
        bookCoverGradient={null}
        effectiveCoverUrl={null}
        coverLoadFailed={false}
        onCoverLoadFailed={vi.fn()}
        onChangeCover={vi.fn()}
        onPlayFromStart={vi.fn()}
        onOpenExportModal={vi.fn()}
        onEnterPreview={vi.fn()}
        onOpenRestructure={vi.fn()}
        notes={'First line of notes.\nSecond line stays collapsed.'}
      />,
    );
    const toggle = screen.getByTestId('listen-notes-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle.className).toMatch(/min-h-\[44px\]/);
  });
});

describe('ListenPlayerRegion — phone viewport render (plan 81 wave 3)', () => {
  function makeChapter(id: number, overrides: Partial<Chapter> = {}): Chapter {
    return {
      id,
      title: `Chapter ${id}`,
      duration: '10:00',
      state: 'done',
      progress: 1,
      characters: {},
      ...overrides,
    } as Chapter;
  }

  it('renders the chapter list at 375 px without horizontal-overflow inducing classes', () => {
    const chapters = [makeChapter(1), makeChapter(2), makeChapter(3)];
    render(
      <Provider store={makeStore()}>
        <ListenPlayerRegion
          bookId="test-book"
          chapters={chapters}
          listenable={chapters}
          characters={[]}
          currentTrack={null}
          onPlayChapter={vi.fn()}
          onRegenerate={vi.fn()}
          onSeekMarker={vi.fn()}
          onDeleteMarker={vi.fn()}
          onSetMarkerKind={vi.fn()}
          onFixLine={vi.fn()}
        />
      </Provider>,
    );
    /* The chapter rows should still expose the testids that drive
       playback, share-clip, and rename interactions. The grid that
       enforces a 524 px minimum on desktop must NOT appear without
       the md: prefix (or the row would horizontally overflow at
       375 px). */
    expect(screen.getByTestId('chapter-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('chapter-row-1-rename')).toBeInTheDocument();
    expect(screen.getByTestId('chapter-row-1-share-clip')).toBeInTheDocument();
    /* The action buttons hit WCAG 2.5.5: w-11 h-11 on phone, w-8 on
       desktop. Inspect the class to confirm the responsive pair lives
       on the button. */
    const renameBtn = screen.getByTestId('chapter-row-1-rename');
    expect(renameBtn.className).toMatch(/w-11/);
    expect(renameBtn.className).toMatch(/md:w-8/);
  });

  it('the row container does NOT pin a fixed wide grid template without an md: gate', () => {
    /* Regression guard: prior to plan 81 wave 3 the chapter row used
       `grid grid-cols-[40px_60px_1fr_220px_100px_104px]` unconditionally
       — that pins the row to ~520 px and overflows a 375 px viewport.
       The mobile-first rewrite keeps that template behind `md:` only. */
    const chapters = [makeChapter(1)];
    render(
      <Provider store={makeStore()}>
        <ListenPlayerRegion
          bookId="test-book"
          chapters={chapters}
          listenable={chapters}
          characters={[]}
          currentTrack={null}
          onPlayChapter={vi.fn()}
          onRegenerate={vi.fn()}
          onSeekMarker={vi.fn()}
          onDeleteMarker={vi.fn()}
          onSetMarkerKind={vi.fn()}
          onFixLine={vi.fn()}
        />
      </Provider>,
    );
    const row = screen.getByTestId('chapter-row-1');
    /* The fixed-width grid template lives inside the row but must be
       prefixed with md:. Look up the descendant tree for any element
       that declares the desktop grid template — every match must be
       guarded by md:. */
    const desktopGrid = row.querySelector('[class*="grid-cols-[40px_60px_1fr_220px_100px_104px]"]');
    if (desktopGrid) {
      const cls = desktopGrid.className;
      expect(cls).toMatch(/md:grid-cols-\[40px_60px_1fr_220px_100px_104px\]/);
      expect(cls).not.toMatch(/(^| )grid-cols-\[40px_60px_1fr_220px_100px_104px\]/);
    }
  });
});

describe('ListenDownloadSection — phone viewport render (plan 81 wave 3)', () => {
  it('renders the download tiles in a single column-friendly layout', () => {
    render(
      <ListenDownloadSection
        queueItems={[]}
        onOpenPocketBookExport={vi.fn()}
        onOpenVoiceExport={vi.fn()}
        onOpenSmartAudiobookExport={vi.fn()}
        onOpenBookplayerExport={vi.fn()}
        onOpenAudiobookshelfExport={vi.fn()}
        onOpenAppleBooksExport={vi.fn()}
        onOpenM4bExport={vi.fn()}
        onOpenMp3ZipExport={vi.fn()}
        onOpenStreamingLink={vi.fn()}
        onPortableBundleExport={vi.fn()}
        onCopyExportLink={vi.fn()}
        onRemoveExport={vi.fn()}
      />,
    );
    expect(screen.getByTestId('download-tile-m4b')).toBeInTheDocument();
    expect(screen.getByTestId('download-tile-mp3-zip')).toBeInTheDocument();
    expect(screen.getByTestId('download-tile-streaming')).toBeInTheDocument();
    expect(screen.getByTestId('download-tile-portable')).toBeInTheDocument();
    /* Tile download button is WCAG-2.5.5 compliant on phone. */
    const tile = screen.getByTestId('download-tile-m4b');
    const btn = tile.querySelector('button')!;
    expect(btn.className).toMatch(/min-h-\[44px\]/);
  });
});
