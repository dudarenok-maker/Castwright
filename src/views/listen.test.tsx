// Pairs with docs/features/18-listen-view.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { ListenView } from './listen';
import { exportsSlice } from '../store/exports-slice';
import { accountSlice } from '../store/account-slice';
import { uiSlice } from '../store/ui-slice';
import type { Chapter, Character, Voice } from '../lib/types';
import type { EditableBookMeta } from '../store/book-meta-slice';

const chapters: Chapter[] = [
  {
    id: 1,
    title: 'The Approach',
    duration: '08:32',
    state: 'done',
    characters: { narrator: 'voiced' as never },
    progress: 1,
  } as Chapter,
  {
    id: 2,
    title: 'Into the Fog',
    duration: '12:14',
    state: 'done',
    characters: { narrator: 'voiced' as never },
    progress: 1,
  } as Chapter,
];

const characters: Character[] = [
  { id: 'narrator', name: 'Anders Vale', role: 'Narrator', color: 'narrator' } as Character,
  { id: 'halloran', name: 'Cpt. Halloran', role: 'Captain', color: 'magenta' } as Character,
];

const voices: Voice[] = [];

const baseMeta = (over: Partial<EditableBookMeta> = {}): EditableBookMeta => ({
  title: 'Bonus Keefe Story',
  author: 'Mike Dudarenok',
  series: 'Keefe Side-Stories',
  narratorCredit: 'Anders Vale',
  genre: 'Fantasy',
  publicationDate: '2026-05-09',
  ...over,
});

const baseHandlers = () => ({
  setCurrentTrack: vi.fn(),
  onSendApp: vi.fn(),
  onRegenerate: vi.fn(),
  onEnterPreview: vi.fn(),
  onEditMetaField: vi.fn(),
  onCommitMeta: vi.fn(),
  onCancelMeta: vi.fn(),
});

beforeEach(() => vi.clearAllMocks());

function makeStore() {
  return configureStore({
    reducer: {
      exports: exportsSlice.reducer,
      account: accountSlice.reducer,
      ui: uiSlice.reducer,
    },
  });
}

function renderView(
  overrides: {
    meta?: EditableBookMeta | null;
    gradient?: [string, string] | null;
    isDirty?: boolean;
    currentTrack?: number | null;
    coverImageUrl?: string | null;
    coverFraming?: { offsetX: number; offsetY: number; zoom: number };
  } = {},
) {
  const handlers = baseHandlers();
  render(
    <Provider store={makeStore()}>
      <ListenView
        bookId="demo__sa__test"
        chapters={chapters}
        characters={characters}
        library={voices}
        currentTrack={overrides.currentTrack ?? null}
        bookMeta={overrides.meta === undefined ? baseMeta() : overrides.meta}
        bookCoverGradient={overrides.gradient ?? ['#2C7A4B', '#0F3A23']}
        bookCoverImageUrl={overrides.coverImageUrl ?? null}
        bookCoverFraming={overrides.coverFraming}
        isMetaDirty={overrides.isDirty ?? false}
        {...handlers}
      />
    </Provider>,
  );
  return handlers;
}

describe('ListenView — top section reads from bookMeta', () => {
  it('renders the book title from bookMeta, not from a hardcoded fixture', () => {
    renderView({ meta: baseMeta({ title: 'A Custom Manuscript' }) });
    // The h1 in the header and the cover-art h2 should both show the user title.
    expect(screen.getAllByText('A Custom Manuscript').length).toBeGreaterThan(0);
    expect(screen.queryByText('The Northern Star')).toBeNull();
  });

  it('renders the author and narrator credit from bookMeta', () => {
    renderView({ meta: baseMeta({ author: 'Jane Q. Writer', narratorCredit: 'Sam Voice' }) });
    expect(screen.getByText('Jane Q. Writer')).toBeInTheDocument();
    expect(screen.getByText('Sam Voice')).toBeInTheDocument();
  });

  it('falls back to the cast narrator when narratorCredit is blank', () => {
    renderView({ meta: baseMeta({ narratorCredit: null }) });
    /* Anders Vale comes from the cast (id === "narrator"). */
    expect(screen.getByText('Anders Vale')).toBeInTheDocument();
  });

  it('paints the cover with the book gradient passed in props', () => {
    renderView({ gradient: ['#abcdef', '#123456'] });
    const cover = screen.getByTestId('listen-cover-art');
    expect((cover as HTMLElement).style.background).toContain('#abcdef');
    expect((cover as HTMLElement).style.background).toContain('#123456');
  });

  it('renders a loading shell when bookMeta is null', () => {
    renderView({ meta: null });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Loading metadata…')).toBeInTheDocument();
  });
});

describe('ListenView — CoverArt cover-image overlay', () => {
  it('does not render the cover <img> when no coverImageUrl is set (gradient-only fallback)', () => {
    renderView({ coverImageUrl: null });
    expect(screen.queryByTestId('listen-cover-art-image')).not.toBeInTheDocument();
    /* Title block stays visible as the gradient-skeleton label. */
    expect(screen.getAllByText('Bonus Keefe Story').length).toBeGreaterThan(0);
  });

  it('renders the cover <img> with the provided URL when present', () => {
    renderView({ coverImageUrl: '/api/books/bk_test/cover' });
    const img = screen.getByTestId('listen-cover-art-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/books/bk_test/cover');
  });

  it('applies coverFraming to the <img> when set (plan 40)', () => {
    renderView({
      coverImageUrl: '/api/books/bk_test/cover',
      coverFraming: { offsetX: 50, offsetY: -50, zoom: 2 },
    });
    const img = screen.getByTestId('listen-cover-art-image') as HTMLImageElement;
    expect(img.style.objectPosition).toBe('75% 25%');
    expect(img.style.transform).toContain('scale(2)');
  });

  it('emits no extra style when coverFraming is absent (legacy / pre-plan-40 books)', () => {
    renderView({ coverImageUrl: '/api/books/bk_test/cover' });
    const img = screen.getByTestId('listen-cover-art-image') as HTMLImageElement;
    expect(img.style.objectPosition).toBe('');
    expect(img.style.transform).toBe('');
  });
});

describe('ListenView — metadata editor wiring', () => {
  it('typing into a MetaField dispatches setDraftField with the new value', () => {
    const h = renderView();
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'New Title' } });
    expect(h.onEditMetaField).toHaveBeenCalledWith('title', 'New Title');
  });

  it('clearing the Genre field dispatches null (not empty string)', () => {
    const h = renderView({ meta: baseMeta({ genre: 'Fantasy' }) });
    const genreInput = screen.getByLabelText('Genre') as HTMLInputElement;
    fireEvent.change(genreInput, { target: { value: '' } });
    expect(h.onEditMetaField).toHaveBeenCalledWith('genre', null);
  });

  it('Save and Cancel are disabled when the form is clean', () => {
    renderView({ isDirty: false });
    const save = screen.getByRole('button', { name: /save changes/i });
    const cancel = screen.getByTestId('meta-cancel');
    expect(save).toBeDisabled();
    expect(cancel).toBeDisabled();
  });

  it('Save and Cancel are enabled and dispatch when the form is dirty', () => {
    const h = renderView({ isDirty: true });
    const save = screen.getByRole('button', { name: /save changes/i });
    const cancel = screen.getByTestId('meta-cancel');
    expect(save).not.toBeDisabled();
    expect(cancel).not.toBeDisabled();
    fireEvent.click(save);
    expect(h.onCommitMeta).toHaveBeenCalledOnce();
    fireEvent.click(cancel);
    expect(h.onCancelMeta).toHaveBeenCalledOnce();
  });
});

describe('ListenView — coming-soon affordances', () => {
  it('renders PocketBook among the listener-app cards', () => {
    renderView();
    expect(screen.getByTestId('listener-app-pocketbook')).toBeInTheDocument();
  });

  it('disables non-live listener-app cards while five tiles are live', () => {
    renderView();
    /* After plan 34 B4, Audiobookshelf joins the live set, leaving two
       mocked-handoff tiles (Apple Books, Plex). */
    const stillDeferred = ['apple_books', 'plex'];
    for (const id of stillDeferred) {
      expect(screen.getByTestId(`listener-app-action-${id}`)).toBeDisabled();
    }
    for (const id of ['pocketbook', 'voice', 'smart_audiobook', 'bookplayer', 'audiobookshelf']) {
      expect(screen.getByTestId(`listener-app-action-${id}`)).not.toBeDisabled();
    }
  });

  it('opens the export modal in Smart AudioBook Player mode when its tile is clicked (plan 34 B2)', () => {
    renderView();
    expect(screen.queryByTestId('export-audiobook-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('listener-app-action-smart_audiobook'));
    /* Tile-mode modal: no destination tab strip, no format toggle, and
       the per-tile body renders in place of the generic SyncFolderTab. */
    expect(screen.getByTestId('export-audiobook-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('export-tab-download')).toBeNull();
    expect(screen.queryByTestId('export-tab-sync-folder')).toBeNull();
    expect(screen.queryByTestId('export-format-m4b')).toBeNull();
    expect(screen.queryByTestId('export-format-mp3-zip')).toBeNull();
    expect(screen.getByTestId('export-tile-body-smart_audiobook')).toBeInTheDocument();
  });

  it('opens the export modal in BookPlayer mode when its tile is clicked (plan 34 B3)', () => {
    renderView();
    fireEvent.click(screen.getByTestId('listener-app-action-bookplayer'));
    expect(screen.getByTestId('export-audiobook-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('export-tab-download')).toBeNull();
    expect(screen.queryByTestId('export-tab-sync-folder')).toBeNull();
    expect(screen.queryByTestId('export-format-m4b')).toBeNull();
    expect(screen.queryByTestId('export-format-mp3-zip')).toBeNull();
    expect(screen.getByTestId('export-tile-body-bookplayer')).toBeInTheDocument();
  });

  it('opens the export modal in Audiobookshelf mode when its tile is clicked (plan 34 B4)', () => {
    renderView();
    fireEvent.click(screen.getByTestId('listener-app-action-audiobookshelf'));
    expect(screen.getByTestId('export-audiobook-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('export-tab-download')).toBeNull();
    expect(screen.queryByTestId('export-tab-sync-folder')).toBeNull();
    expect(screen.queryByTestId('export-format-m4b')).toBeNull();
    expect(screen.queryByTestId('export-format-mp3-zip')).toBeNull();
    expect(screen.getByTestId('export-tile-body-audiobookshelf')).toBeInTheDocument();
  });

  it('opens the export modal when the PocketBook tile is clicked', () => {
    renderView();
    expect(screen.queryByTestId('export-audiobook-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('listener-app-action-pocketbook'));
    expect(screen.getByTestId('export-audiobook-modal')).toBeInTheDocument();
  });

  it('opens the export modal in Voice mode when the Voice tile is clicked', () => {
    renderView();
    expect(screen.queryByTestId('export-audiobook-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('listener-app-action-voice'));
    /* Voice-mode modal: no destination tab strip, no format toggle, and
       the Voice-specific body is rendered in place of the SyncFolderTab. */
    expect(screen.getByTestId('export-audiobook-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('export-tab-download')).toBeNull();
    expect(screen.queryByTestId('export-tab-sync-folder')).toBeNull();
    expect(screen.queryByTestId('export-format-m4b')).toBeNull();
    expect(screen.queryByTestId('export-format-mp3-zip')).toBeNull();
    expect(screen.getByTestId('export-voice-body')).toBeInTheDocument();
  });

  it('opens the export modal when the "Export audiobook" pill is clicked', () => {
    renderView();
    fireEvent.click(screen.getByTestId('open-export-modal'));
    expect(screen.getByTestId('export-audiobook-modal')).toBeInTheDocument();
  });

  it('marks deferred listener-app cards with a Soon badge but omits it on live tiles', () => {
    renderView();
    /* All five live tiles drop the badge; the remaining two
       (apple_books, plex) still wear it. */
    for (const id of ['pocketbook', 'voice', 'smart_audiobook', 'bookplayer', 'audiobookshelf']) {
      const card = screen.getByTestId(`listener-app-${id}`);
      expect(within(card).queryByTestId('coming-soon-badge')).toBeNull();
    }
    const appleBooksCard = screen.getByTestId('listener-app-apple_books');
    expect(within(appleBooksCard).getByTestId('coming-soon-badge')).toBeInTheDocument();
  });

  it('disables the two remaining "Or download a file" tiles and tags them with Soon', () => {
    renderView();
    /* Phase A removed the per-chapter MP3 zip tile — the modal supersedes it.
       Two future-affordance tiles remain (M4B + streaming link). */
    const downloads = screen.getAllByRole('button', { name: /^Download$/ });
    expect(downloads.length).toBe(2);
    for (const btn of downloads) expect(btn).toBeDisabled();
  });

  it('shows the one remaining mocked-preview banner (listener apps)', () => {
    renderView();
    const banners = screen.getAllByTestId('mocked-preview-banner');
    /* The exports rail + the download-tile section both lost their banners
       once the export pipeline went live; only the non-PocketBook listener-
       app handoffs still wear the placeholder. */
    expect(banners.length).toBe(1);
  });

  it('keeps the "Play from the start" button enabled when chapters exist', () => {
    const h = renderView();
    const play = screen.getByRole('button', { name: /play from the start/i });
    expect(play).not.toBeDisabled();
    fireEvent.click(play);
    expect(h.setCurrentTrack).toHaveBeenCalledWith(1);
  });
});

describe('ListenView — excluded chapters are filtered out of the listen rail', () => {
  /* Excluded chapters (front/back-matter the user opted out of at the
     confirm-metadata stage) have no audio, so they'd otherwise surface as
     00:00 rows in the "ready to listen" card and bloat the chapter total. */
  const mixedChapters: Chapter[] = [
    {
      id: 1,
      title: 'Dedication',
      duration: '00:00',
      state: 'done',
      excluded: true,
      characters: { narrator: 'voiced' as never },
      progress: 1,
    } as Chapter,
    {
      id: 2,
      title: 'Preface',
      duration: '00:00',
      state: 'done',
      excluded: true,
      characters: { narrator: 'voiced' as never },
      progress: 1,
    } as Chapter,
    {
      id: 3,
      title: 'Chapter One',
      duration: '11:32',
      state: 'done',
      characters: { narrator: 'voiced' as never },
      progress: 1,
    } as Chapter,
    {
      id: 4,
      title: 'Chapter Two',
      duration: '06:35',
      state: 'done',
      characters: { narrator: 'voiced' as never },
      progress: 1,
    } as Chapter,
  ];

  function renderWithMix() {
    const handlers = baseHandlers();
    render(
      <Provider store={makeStore()}>
        <ListenView
          bookId="demo__sa__test"
          chapters={mixedChapters}
          characters={characters}
          library={voices}
          currentTrack={null}
          bookMeta={baseMeta()}
          bookCoverGradient={['#2C7A4B', '#0F3A23']}
          isMetaDirty={false}
          {...handlers}
        />
      </Provider>,
    );
    return handlers;
  }

  it('hides excluded chapter rows from the chapter list', () => {
    renderWithMix();
    const scroller = screen.getByTestId('listen-chapters-scroll');
    expect(within(scroller).queryByText('Dedication')).toBeNull();
    expect(within(scroller).queryByText('Preface')).toBeNull();
    expect(within(scroller).getByText('Chapter One')).toBeInTheDocument();
    expect(within(scroller).getByText('Chapter Two')).toBeInTheDocument();
  });

  it('omits excluded chapters from the header chapter count and runtime', () => {
    renderWithMix();
    /* Header span renders as "<2> chapters" with the count in a nested
       <span>. Match against the combined textContent so we don't catch
       the CH-XX badges in the row list. 18:07 is the runtime sum of the
       two non-excluded chapters (11:32 + 06:35). */
    const headerLine = screen.getByText(
      (_, el) => el?.tagName === 'SPAN' && /^2 chapters$/.test(el.textContent ?? ''),
    );
    expect(headerLine).toBeInTheDocument();
    expect(
      screen.queryByText(
        (_, el) => el?.tagName === 'SPAN' && /^4 chapters$/.test(el.textContent ?? ''),
      ),
    ).toBeNull();
    expect(screen.getByText('18:07')).toBeInTheDocument();
  });

  it('"Play from the start" jumps to the first non-excluded chapter, not the first slot', () => {
    const h = renderWithMix();
    fireEvent.click(screen.getByRole('button', { name: /play from the start/i }));
    /* First listenable chapter is id 3 (Chapter One), not id 1 (Dedication). */
    expect(h.setCurrentTrack).toHaveBeenCalledWith(3);
  });
});

describe('ListenView — chapter list scroll cap', () => {
  /* Long books (59 chapters in Keeper of the Lost Cities) would otherwise
     stretch the chapters card across pages. The list is wrapped in a
     capped, scrollable inner div so the rest of the Listen view stays
     reachable. */
  it('wraps the chapter list in a max-height scroll container with the inset thumb', () => {
    renderView();
    const scroller = screen.getByTestId('listen-chapters-scroll');
    expect(scroller.className).toMatch(/max-h-\[560px\]/);
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/scrollbar-thin/);
  });

  it('still renders every chapter row inside the scroller', () => {
    renderView();
    const scroller = screen.getByTestId('listen-chapters-scroll');
    expect(within(scroller).getByText('The Approach')).toBeInTheDocument();
    expect(within(scroller).getByText('Into the Fog')).toBeInTheDocument();
  });
});
