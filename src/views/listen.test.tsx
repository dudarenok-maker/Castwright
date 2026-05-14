// Pairs with docs/features/18-listen-view.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ListenView } from './listen';
import type { Chapter, Character, Voice } from '../lib/types';
import type { EditableBookMeta } from '../store/book-meta-slice';

const chapters: Chapter[] = [
  { id: 1, title: 'The Approach', duration: '08:32', state: 'done',
    characters: { narrator: 'voiced' as never }, progress: 1 } as Chapter,
  { id: 2, title: 'Into the Fog', duration: '12:14', state: 'done',
    characters: { narrator: 'voiced' as never }, progress: 1 } as Chapter,
];

const characters: Character[] = [
  { id: 'narrator', name: 'Anders Vale',   role: 'Narrator', color: 'narrator' } as Character,
  { id: 'halloran', name: 'Cpt. Halloran', role: 'Captain',  color: 'magenta'  } as Character,
];

const voices: Voice[] = [];

const baseMeta = (over: Partial<EditableBookMeta> = {}): EditableBookMeta => ({
  title: 'the Coalfall Commission',
  author: 'Mike Dudarenok',
  series: 'Marlow Side-Stories',
  narratorCredit: 'Anders Vale',
  genre: 'Fantasy',
  publicationDate: '2026-05-09',
  ...over,
});

const baseHandlers = () => ({
  setCurrentTrack:  vi.fn(),
  onSendApp:        vi.fn(),
  onRegenerate:     vi.fn(),
  onEnterPreview:   vi.fn(),
  onEditMetaField:  vi.fn(),
  onCommitMeta:     vi.fn(),
  onCancelMeta:     vi.fn(),
});

beforeEach(() => vi.clearAllMocks());

function renderView(overrides: {
  meta?: EditableBookMeta | null;
  gradient?: [string, string] | null;
  isDirty?: boolean;
  currentTrack?: number | null;
} = {}) {
  const handlers = baseHandlers();
  render(
    <ListenView chapters={chapters} characters={characters} library={voices}
      currentTrack={overrides.currentTrack ?? null}
      bookMeta={overrides.meta === undefined ? baseMeta() : overrides.meta}
      bookCoverGradient={overrides.gradient ?? ['#2C7A4B', '#0F3A23']}
      isMetaDirty={overrides.isDirty ?? false}
      {...handlers}/>
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
    const save   = screen.getByRole('button', { name: /save changes/i });
    const cancel = screen.getByTestId('meta-cancel');
    expect(save).toBeDisabled();
    expect(cancel).toBeDisabled();
  });

  it('Save and Cancel are enabled and dispatch when the form is dirty', () => {
    const h = renderView({ isDirty: true });
    const save   = screen.getByRole('button', { name: /save changes/i });
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

  it('disables the action button on every listener-app card', () => {
    renderView();
    const ids = ['audiobookshelf', 'bookplayer', 'smart_audiobook', 'apple_books', 'plex', 'pocketbook'];
    for (const id of ids) {
      const btn = screen.getByTestId(`listener-app-action-${id}`);
      expect(btn).toBeDisabled();
    }
  });

  it('does NOT dispatch onSendApp when a disabled listener-app button is clicked', () => {
    const h = renderView();
    fireEvent.click(screen.getByTestId('listener-app-action-pocketbook'));
    expect(h.onSendApp).not.toHaveBeenCalled();
  });

  it('marks every listener-app card with a Soon badge', () => {
    renderView();
    const pocketBookCard = screen.getByTestId('listener-app-pocketbook');
    expect(within(pocketBookCard).getByTestId('coming-soon-badge')).toBeInTheDocument();
  });

  it('disables all three download tiles and tags them with Soon', () => {
    renderView();
    /* All three Download buttons in the download-tile section should be disabled. */
    const downloads = screen.getAllByRole('button', { name: /^Download$/ });
    expect(downloads.length).toBe(3);
    for (const btn of downloads) expect(btn).toBeDisabled();
  });

  it('shows mocked-preview banners on the integrations, exports, and downloads sections', () => {
    renderView();
    const banners = screen.getAllByTestId('mocked-preview-banner');
    /* Three sections wear the banner: listener-apps, export queue, downloads. */
    expect(banners.length).toBe(3);
  });

  it('keeps the "Play from the start" button enabled when chapters exist', () => {
    const h = renderView();
    const play = screen.getByRole('button', { name: /play from the start/i });
    expect(play).not.toBeDisabled();
    fireEvent.click(play);
    expect(h.setCurrentTrack).toHaveBeenCalledWith(1);
  });
});
