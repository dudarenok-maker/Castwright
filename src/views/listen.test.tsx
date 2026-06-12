// Pairs with docs/features/archive/18-listen-view.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';

/* CoverPicker's real implementation runs network-y effects on mount
   (findCoverCandidates). Stub it with a marker that surfaces the
   open/initialTab props so the cover-button wiring tests can assert
   *which* tab the parent asked the modal to open with, without
   re-doing the picker's own test coverage. The modal's behaviour is
   pinned by src/modals/cover-picker.test.tsx. */
vi.mock('../modals/cover-picker', () => ({
  CoverPicker: (props: { open: boolean; initialTab?: 'search' | 'upload' }) =>
    props.open ? (
      <div data-testid="cover-picker-stub" data-initial-tab={props.initialTab ?? 'none'} />
    ) : null,
}));

import { ListenView } from './listen';
import { exportsSlice, exportsActions } from '../store/exports-slice';
import { accountSlice } from '../store/account-slice';
import { uiSlice } from '../store/ui-slice';
import { notificationsSlice } from '../store/notifications-slice';
import type { Chapter, Character, Voice, BookExportJob } from '../lib/types';
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
  author: 'Marin Vale',
  series: 'Keefe Side-Stories',
  narratorCredit: 'Anders Vale',
  genre: 'Fantasy',
  publicationDate: '2026-05-09',
  description: null,
  notes: null,
  ...over,
});

const baseHandlers = () => ({
  setCurrentTrack: vi.fn(),
  onRegenerate: vi.fn(),
  onEnterPreview: vi.fn(),
  onFixLine: vi.fn(),
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
      notifications: notificationsSlice.reducer,
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

  it('defaults to Castwright when no explicit credit', () => {
    renderView({ meta: baseMeta({ narratorCredit: null }) });
    /* When no explicit narratorCredit, the brand default "Castwright" is shown
       rather than the cast narrator character's name. */
    expect(screen.getByText('Castwright')).toBeInTheDocument();
    expect(screen.queryByText('Anders Vale')).not.toBeInTheDocument();
  });

  it('paints the cover with the book gradient passed in props', () => {
    renderView({ gradient: ['#abcdef', '#123456'] });
    const cover = screen.getByTestId('listen-cover-art');
    /* jsdom 29 canonicalises hex colours to rgb() in the CSSOM (and in the
       serialised `style` attribute) — #abcdef → rgb(171, 205, 239),
       #123456 → rgb(18, 52, 86) — so we assert against the rgb() forms the
       browser also computes rather than the source hex literals. */
    const background = (cover as HTMLElement).style.background;
    expect(background).toContain('linear-gradient(135deg');
    expect(background).toContain('rgb(171, 205, 239)'); // #abcdef
    expect(background).toContain('rgb(18, 52, 86)'); // #123456
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

  it('typing into the Description textarea dispatches setDraftField (plan 33)', () => {
    const h = renderView();
    const descInput = screen.getByTestId('meta-description') as HTMLTextAreaElement;
    expect(descInput.tagName).toBe('TEXTAREA');
    fireEvent.change(descInput, {
      target: { value: 'A long-form summary of this audiobook.' },
    });
    expect(h.onEditMetaField).toHaveBeenCalledWith(
      'description',
      'A long-form summary of this audiobook.',
    );
  });

  it('clearing the Description textarea dispatches null (matches other nullable fields)', () => {
    const h = renderView({ meta: baseMeta({ description: 'existing text' }) });
    const descInput = screen.getByTestId('meta-description') as HTMLTextAreaElement;
    expect(descInput.value).toBe('existing text');
    fireEvent.change(descInput, { target: { value: '' } });
    expect(h.onEditMetaField).toHaveBeenCalledWith('description', null);
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

  /* Plan 67 — Notes textarea in the metadata editor. Mirrors the
     Description field: plain textarea, no markdown toolbar, trim-empty
     dispatches null. */
  it('typing into the Notes textarea dispatches setDraftField (plan 67)', () => {
    const h = renderView();
    const notesInput = screen.getByTestId('meta-notes') as HTMLTextAreaElement;
    expect(notesInput.tagName).toBe('TEXTAREA');
    fireEvent.change(notesInput, {
      target: { value: 'Source: public-domain edition.\nNarration intent: warm, slow.' },
    });
    expect(h.onEditMetaField).toHaveBeenCalledWith(
      'notes',
      'Source: public-domain edition.\nNarration intent: warm, slow.',
    );
  });

  it('clearing the Notes textarea dispatches null', () => {
    const h = renderView({ meta: baseMeta({ notes: 'old notes' }) });
    const notesInput = screen.getByTestId('meta-notes') as HTMLTextAreaElement;
    expect(notesInput.value).toBe('old notes');
    fireEvent.change(notesInput, { target: { value: '' } });
    expect(h.onEditMetaField).toHaveBeenCalledWith('notes', null);
  });

  it('whitespace-only Notes input dispatches null (no empty-string round-trip)', () => {
    const h = renderView();
    const notesInput = screen.getByTestId('meta-notes') as HTMLTextAreaElement;
    fireEvent.change(notesInput, { target: { value: '   \n  ' } });
    expect(h.onEditMetaField).toHaveBeenCalledWith('notes', null);
  });
});

describe('ListenView — collapsible Notes card (plan 67)', () => {
  it('does not render the Notes card when notes is null', () => {
    renderView({ meta: baseMeta({ notes: null }) });
    expect(screen.queryByTestId('listen-notes-card')).not.toBeInTheDocument();
  });

  it('does not render the Notes card when notes is whitespace-only', () => {
    renderView({ meta: baseMeta({ notes: '   \n\n  ' }) });
    expect(screen.queryByTestId('listen-notes-card')).not.toBeInTheDocument();
  });

  it('renders the Notes card collapsed by default with the first line as preview', () => {
    renderView({
      meta: baseMeta({ notes: 'First line is the preview.\nSecond line is hidden.' }),
    });
    const card = screen.getByTestId('listen-notes-card');
    expect(card).toBeInTheDocument();
    /* Collapsed: preview shows first line only; body is absent. */
    expect(within(card).getByText('First line is the preview.')).toBeInTheDocument();
    expect(screen.queryByTestId('listen-notes-body')).not.toBeInTheDocument();
    const toggle = screen.getByTestId('listen-notes-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands the Notes body when the toggle is clicked, preserving line breaks via whitespace-pre-wrap', () => {
    const notesText = 'Line one.\nLine two.\n\nLine four.';
    renderView({ meta: baseMeta({ notes: notesText }) });
    fireEvent.click(screen.getByTestId('listen-notes-toggle'));
    const body = screen.getByTestId('listen-notes-body');
    expect(body).toBeInTheDocument();
    /* The exact text (with embedded \n characters) lands in the DOM —
       whitespace-pre-wrap renders them as visible line breaks. */
    const para = body.querySelector('p');
    expect(para).not.toBeNull();
    expect(para!.textContent).toBe(notesText);
    expect(para!.className).toContain('whitespace-pre-wrap');
    expect(screen.getByTestId('listen-notes-toggle').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ListenView — coming-soon affordances', () => {
  it('renders PocketBook among the listener-app cards', () => {
    renderView();
    expect(screen.getByTestId('listener-app-pocketbook')).toBeInTheDocument();
  });

  it('all six listener-app tiles are now live (no deferred tiles remaining)', () => {
    renderView();
    /* Apple Books joined the live set (wired to M4B download tab). All six
       tiles now have an enabled action button. */
    for (const id of [
      'pocketbook',
      'voice',
      'smart_audiobook',
      'bookplayer',
      'audiobookshelf',
      'apple_books',
    ]) {
      expect(screen.getByTestId(`listener-app-action-${id}`)).not.toBeDisabled();
    }
  });

  it('drops the Plex tile, leaving six listener-app cards', () => {
    renderView();
    expect(screen.queryByTestId('listener-app-plex')).toBeNull();
    const liveAndDeferred = [
      'pocketbook',
      'voice',
      'smart_audiobook',
      'bookplayer',
      'audiobookshelf',
      'apple_books',
    ];
    for (const id of liveAndDeferred) {
      expect(screen.getByTestId(`listener-app-${id}`)).toBeInTheDocument();
    }
  });

  it('surfaces the Castwright Companion banner above the third-party grid', () => {
    renderView();
    expect(screen.getByTestId('companion-app-banner')).toBeInTheDocument();
    expect(screen.getByTestId('companion-store-google-play')).toBeInTheDocument();
    expect(screen.getByTestId('companion-store-app-store')).toBeInTheDocument();
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

  it('omits the Soon badge on all six live listener-app tiles', () => {
    renderView();
    /* All six tiles are now live — apple_books joined the live set (M4B
       download tab). No listener-app card should show a coming-soon badge. */
    for (const id of [
      'pocketbook',
      'voice',
      'smart_audiobook',
      'bookplayer',
      'audiobookshelf',
      'apple_books',
    ]) {
      const card = screen.getByTestId(`listener-app-${id}`);
      expect(within(card).queryByTestId('coming-soon-badge')).toBeNull();
    }
  });

  it('enables all four download tiles after plan 75 wires the portable bundle tile', () => {
    renderView();
    /* Plan 57 wired the M4B + MP3 ZIP tiles to the export modal via
       `prefill`. Plan 67 wires the streaming-link tile to
       POST /api/books/:bookId/share + the ShareLinkModal. Plan 75 wires
       the Portable bundle tile to GET /api/books/:bookId/export/portable.
       All four Download buttons are now enabled. */
    const downloads = screen.getAllByRole('button', { name: /^Download$/ });
    expect(downloads.length).toBe(4);
    expect(screen.getByTestId('download-tile-m4b').querySelector('button')).toBeEnabled();
    expect(screen.getByTestId('download-tile-mp3-zip').querySelector('button')).toBeEnabled();
    expect(screen.getByTestId('download-tile-streaming').querySelector('button')).toBeEnabled();
    expect(screen.getByTestId('download-tile-portable').querySelector('button')).toBeEnabled();
    const disabled = downloads.filter((b) => b.hasAttribute('disabled'));
    expect(disabled.length).toBe(0);
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

describe('ListenView — export-queue per-row actions (plan 18a)', () => {
  /* The Copy link button writes to navigator.clipboard and fires an info
     toast. The Remove button dispatches exportsActions.exportDismissed
     so the live row leaves the rail. Mock-fallback rows (design-system
     fixtures with synthetic ids) dispatch the same action but with no
     matching entry in `byBookId`, so the dispatch is a no-op visually —
     that's an acceptable mock-mode degradation since real exports
     replace the fixture entirely. */

  it('Copy link button on a URL row writes to clipboard and pushes an info toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    const store = configureStore({
      reducer: {
        exports: exportsSlice.reducer,
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    /* Seed one live export job. downloadUrl is what the adapter maps to
       ExportQueueItem.url, which the row uses to render the Copy button
       (instead of the Download button). */
    const job: BookExportJob = {
      id: 'job-1',
      bookId: 'demo__sa__test',
      status: 'done',
      format: 'm4b',
      destination: 'download',
      downloadUrl: 'https://example.com/listen/abc',
      createdAt: new Date().toISOString(),
      progress: 1,
      filename: 'Demo — Full audiobook.m4b',
      sizeBytes: 1234,
    };
    store.dispatch(exportsActions.exportStarted(job));

    const handlers = baseHandlers();
    render(
      <Provider store={store}>
        <ListenView
          bookId="demo__sa__test"
          chapters={chapters}
          characters={characters}
          library={voices}
          currentTrack={null}
          bookMeta={baseMeta()}
          bookCoverGradient={['#2C7A4B', '#0F3A23']}
          bookCoverImageUrl={null}
          isMetaDirty={false}
          {...handlers}
        />
      </Provider>,
    );

    fireEvent.click(screen.getByTitle('Copy link'));

    // Wait one microtask for the await writeText() to resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('https://example.com/listen/abc');
    const toasts = store.getState().notifications.toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/copied/i);
    expect(toasts[0].kind).toBe('info');
  });

  it('Remove button on a live row dispatches exportDismissed', () => {
    const store = configureStore({
      reducer: {
        exports: exportsSlice.reducer,
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    const job: BookExportJob = {
      id: 'job-2',
      bookId: 'demo__sa__test',
      status: 'done',
      format: 'm4b',
      destination: 'download',
      downloadUrl: 'https://example.com/file.m4b',
      createdAt: new Date().toISOString(),
      progress: 1,
      filename: 'Demo — Full audiobook.m4b',
      sizeBytes: 1234,
    };
    store.dispatch(exportsActions.exportStarted(job));

    expect(store.getState().exports.byBookId['demo__sa__test']).toHaveLength(1);

    const handlers = baseHandlers();
    render(
      <Provider store={store}>
        <ListenView
          bookId="demo__sa__test"
          chapters={chapters}
          characters={characters}
          library={voices}
          currentTrack={null}
          bookMeta={baseMeta()}
          bookCoverGradient={['#2C7A4B', '#0F3A23']}
          bookCoverImageUrl={null}
          isMetaDirty={false}
          {...handlers}
        />
      </Provider>,
    );

    fireEvent.click(screen.getByTitle('Remove'));

    expect(store.getState().exports.byBookId['demo__sa__test']).toHaveLength(0);
  });
});

describe('ListenView — metadata-editor cover buttons (plan 18a)', () => {
  /* Before plan 18a these two buttons rendered as disabled "Coming soon"
     stubs. Now they open the CoverPicker; Replace routes to Upload tab,
     Regenerate to Search tab. The modal's own behaviour is covered in
     cover-picker.test.tsx; here we pin the parent's open/route wiring. */

  it('cover Replace button is enabled and opens the picker on Upload tab', () => {
    renderView();
    const replace = screen.getByTestId('meta-cover-replace');
    expect(replace).not.toBeDisabled();
    /* Modal is unmounted before click. */
    expect(screen.queryByTestId('cover-picker-stub')).not.toBeInTheDocument();

    fireEvent.click(replace);

    const stub = screen.getByTestId('cover-picker-stub');
    expect(stub.getAttribute('data-initial-tab')).toBe('upload');
  });

  it('cover Regenerate button is enabled and opens the picker on Search tab', () => {
    renderView();
    const regenerate = screen.getByTestId('meta-cover-regenerate');
    expect(regenerate).not.toBeDisabled();
    expect(screen.queryByTestId('cover-picker-stub')).not.toBeInTheDocument();

    fireEvent.click(regenerate);

    const stub = screen.getByTestId('cover-picker-stub');
    expect(stub.getAttribute('data-initial-tab')).toBe('search');
  });
});
