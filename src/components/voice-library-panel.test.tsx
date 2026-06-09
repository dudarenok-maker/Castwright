/* Cast-view interaction regression: clicking a voice card in the Voice
   Library panel must open the profile drawer for the character that uses
   that voice, and clicking the swatch bubble must trigger a voice sample
   for that character. Pre-fix the panel was drag-only. */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import { VoiceCard, VoiceLibraryPanel } from './voice-library-panel';
import type { Character, Voice } from '../lib/types';

const makeVoice = (id: string, character: string, overrides: Partial<Voice> = {}): Voice => ({
  id,
  character,
  bookTitle: 'Bonus Keefe Story',
  bookId: 'bks',
  attributes: ['Warm'],
  gradient: ['#A43C6C', '#3C194F'],
  usedIn: 1,
  source: 'current',
  ttsVoice: { provider: 'coqui', name: 'Claribel Dervla', description: '' },
  ...overrides,
});

const makeCharacter = (
  id: string,
  voiceId: string,
  overrides: Partial<Character> = {},
): Character => ({
  id,
  name: id,
  role: 'role',
  color: id,
  voiceState: 'generated',
  voiceId,
  ...overrides,
});

describe('VoiceLibraryPanel — Cast-view interactions', () => {
  it('opens the profile drawer for the character that uses the clicked voice', () => {
    const onOpenProfile = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_keefe', 'Keefe'), makeVoice('v_ro', 'Ro')]}
        characters={[makeCharacter('keefe', 'v_keefe'), makeCharacter('ro', 'v_ro')]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Keefe').closest('[role="button"]')!);
    expect(onOpenProfile).toHaveBeenCalledWith('keefe');
  });

  it('plays a voice sample (not opens the drawer) when the swatch bubble is clicked', () => {
    const onOpenProfile = vi.fn();
    const onPlaySample = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_keefe', 'Keefe')]}
        characters={[makeCharacter('keefe', 'v_keefe')]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={onPlaySample}
      />,
    );
    const card = screen.getByText('Keefe').closest('[role="button"]')!;
    fireEvent.click(within(card as HTMLElement).getAllByRole('button')[0]);
    expect(onPlaySample).toHaveBeenCalledTimes(1);
    expect(onPlaySample.mock.calls[0][0].id).toBe('keefe');
    expect(onPlaySample.mock.calls[0][1].id).toBe('v_keefe');
    /* The swatch click must NOT bubble to the card root and double-fire
       onOpenProfile — the panel's user expectation is "bubble plays,
       card opens" as two distinct actions. */
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('stays drag-only for series voices with no character in the current book', () => {
    const onOpenProfile = vi.fn();
    const onPlaySample = vi.fn();
    /* A voice from another book in the series — no character in the
       current book uses it, so the panel should not synthesise a drawer
       or sample target. It's `inCurrentSeries` so the panel defaults to the
       "Series" tab and the card is visible without switching tabs. */
    render(
      <VoiceLibraryPanel
        library={[
          makeVoice('v_series', 'Other-book speaker', {
            source: 'library',
            inCurrentSeries: true,
            bookTitle: 'Earlier Book',
            bookId: 'eb',
          }),
        ]}
        characters={[]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={onPlaySample}
      />,
    );
    const card = screen.getByText('Other-book speaker').closest('div.group')!;
    expect(card.getAttribute('role')).toBeNull();
    fireEvent.click(card);
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('matches voices to characters by character.id when voiceId is unset (fresh-analysis regression)', () => {
    /* Real bug: the analyzer never emits voiceId on a character, and the
       server derives Voice.id from `character.voiceId ?? character.id`. So
       for a freshly-analysed book Voice.id === character.id, and a
       voiceId-only match always misses — leaving every panel card inert.
       Pin the fallback so the regression can't reappear silently. */
    const onOpenProfile = vi.fn();
    const onPlaySample = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('keefe', 'Keefe')]} /* Voice.id mirrors character.id */
        characters={[makeCharacter('keefe', '')]} /* character has no voiceId */
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={onPlaySample}
      />,
    );
    const card = screen.getByText('Keefe').closest('[role="button"]')!;
    fireEvent.click(card);
    expect(onOpenProfile).toHaveBeenCalledWith('keefe');
    fireEvent.click(within(card as HTMLElement).getAllByRole('button')[0]);
    expect(onPlaySample.mock.calls[0][0].id).toBe('keefe');
  });

  it('prefers an explicit voiceId match over the character.id fallback', () => {
    /* Two characters: one whose id collides with another character's
       voiceId. The explicit voiceId mapping must win — otherwise reused
       library voices would open the wrong drawer. */
    const onOpenProfile = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_shared', 'Shared voice')]}
        characters={[
          makeCharacter('different-char', 'v_shared') /* explicit voiceId match */,
          makeCharacter('v_shared', '') /* id collides with the voice id */,
        ]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Shared voice').closest('[role="button"]')!);
    expect(onOpenProfile).toHaveBeenCalledWith('different-char');
  });

  it('falls back to drag-only behaviour when no callbacks are supplied (Library view path)', () => {
    /* The Voices/Library view reuses VoiceCard without the Cast-view
       handlers. Without callbacks, the card must not present itself as
       a button — otherwise screen readers announce a non-interactive
       affordance. */
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_keefe', 'Keefe')]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
      />,
    );
    const card = screen.getByText('Keefe').closest('div.group')!;
    expect(card.getAttribute('role')).toBeNull();
  });

  it('fires onSelect(voice) when the card is clicked even without a matching character (Voices view path)', () => {
    /* The global Voices page renders VoiceCards without the
       character/onOpenProfile pair — the click handler instead navigates
       to the voice's source book. The `onSelect` prop unlocks that path:
       any voice card becomes interactive (role="button" + Enter/Space)
       and fires the callback with the clicked voice. */
    const onSelect = vi.fn();
    const voice = makeVoice('v_keefe', 'Keefe');
    render(
      <VoiceCard
        voice={voice}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onSelect={onSelect}
      />,
    );
    const card = screen.getByText('Keefe').closest('[role="button"]')!;
    expect(card).not.toBeNull();
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('v_keefe');
    /* Keyboard activation must also work — the card advertises role="button"
       so screen-reader users expect Enter/Space to fire the same action. */
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(card, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it('renders the multi-select checkbox only when both `selected` and `onToggleSelect` are passed (plan 22a)', () => {
    /* With only the legacy props the card MUST stay drag-only with no
       checkbox surface — otherwise the Cast-view drawer would show a stray
       selection control. The "selectable" mode requires both `selected` AND
       `onToggleSelect`; either alone keeps the legacy DOM. */
    const voice = makeVoice('v_keefe', 'Keefe');
    const { rerender } = render(
      <VoiceCard voice={voice} draggingVoiceId={null} setDraggingVoiceId={vi.fn()} />,
    );
    expect(screen.queryByLabelText(/Select voice for compare|Deselect voice/)).toBeNull();

    /* Only `selected` set — still no checkbox. */
    rerender(
      <VoiceCard
        voice={voice}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        selected={false}
      />,
    );
    expect(screen.queryByLabelText(/Select voice for compare|Deselect voice/)).toBeNull();

    /* Both set — checkbox appears. */
    rerender(
      <VoiceCard
        voice={voice}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        selected={false}
        onToggleSelect={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Select voice for compare')).toBeInTheDocument();
  });

  it('fires onToggleSelect — not onSelect — when the checkbox is clicked (plan 22a)', () => {
    /* The checkbox sits on a parallel hit zone to the card body. Clicking
       it must toggle selection AND `e.stopPropagation()` so the card-body
       `onSelect` (the profile/navigation handler) never fires. */
    const onToggleSelect = vi.fn();
    const onSelect = vi.fn();
    const voice = makeVoice('v_keefe', 'Keefe');
    render(
      <VoiceCard
        voice={voice}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        selected={false}
        onToggleSelect={onToggleSelect}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select voice for compare'));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onToggleSelect.mock.calls[0][0].id).toBe('v_keefe');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('paints the card with bg-peach tint when selected (plan 22a — mirrors cast.tsx:~199)', () => {
    const voice = makeVoice('v_keefe', 'Keefe');
    const { rerender } = render(
      <VoiceCard
        voice={voice}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        selected={false}
        onToggleSelect={vi.fn()}
      />,
    );
    const card = screen.getByText('Keefe').closest('div.group')!;
    expect(card.className).not.toMatch(/bg-peach/);
    rerender(
      <VoiceCard
        voice={voice}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        selected={true}
        onToggleSelect={vi.fn()}
      />,
    );
    /* The peach tint variant is `bg-peach/4` — same DOM rule as
       cast.tsx for the selected-row highlight. */
    expect(card.className).toMatch(/bg-peach/);
  });

  it('wraps the voice list in the inset-scrollbar utility so the thumb clears the card corners', () => {
    /* The panel's outer is `rounded-3xl overflow-hidden`. The scrollable
       inner sits flush with the card's bottom rounded corner, so without
       `scrollbar-thin` the system scrollbar bleeds past the curve. */
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_keefe', 'Keefe')]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
      />,
    );
    const scroller = screen.getByTestId('voice-library-scroll');
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/scrollbar-thin/);
  });
});

describe('VoiceLibraryPanel — search', () => {
  const lib: Voice[] = [
    makeVoice('v_keefe', 'Keefe Sencen', { bookTitle: 'Keeper of the Lost Cities' }),
    makeVoice('v_elwin', 'Elwin', { bookTitle: 'Keeper of the Lost Cities' }),
    makeVoice('v_ro', 'Ro', { bookTitle: 'Flashback' }),
  ];

  it('filters cards by character name as the user types', () => {
    render(
      <VoiceLibraryPanel library={lib} draggingVoiceId={null} setDraggingVoiceId={vi.fn()} />,
    );
    expect(screen.getByText('Keefe Sencen')).toBeInTheDocument();
    expect(screen.getByText('Elwin')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search voices'), {
      target: { value: 'keefe' },
    });
    expect(screen.getByText('Keefe Sencen')).toBeInTheDocument();
    expect(screen.queryByText('Elwin')).toBeNull();
    expect(screen.queryByText('Ro')).toBeNull();
  });

  it('also matches on book title', () => {
    render(
      <VoiceLibraryPanel library={lib} draggingVoiceId={null} setDraggingVoiceId={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search voices'), {
      target: { value: 'flashback' },
    });
    expect(screen.getByText('Ro')).toBeInTheDocument();
    expect(screen.queryByText('Keefe Sencen')).toBeNull();
  });

  it('applies the tab filter before the query (tab wins first)', () => {
    /* Keefe is "current", Ro is a "library"/series voice. On the Series tab
       only Ro is eligible, so searching "keefe" finds nothing even though
       the name matches — the tab filter runs before the query. */
    const mixed: Voice[] = [
      makeVoice('v_keefe', 'Keefe Sencen', { source: 'current' }),
      makeVoice('v_ro', 'Ro', {
        source: 'library',
        inCurrentSeries: true,
        bookTitle: 'Flashback',
        bookId: 'fb',
      }),
    ];
    render(
      <VoiceLibraryPanel library={mixed} draggingVoiceId={null} setDraggingVoiceId={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Series' }));
    expect(screen.getByText('Ro')).toBeInTheDocument();
    expect(screen.queryByText('Keefe Sencen')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search voices'), {
      target: { value: 'keefe' },
    });
    expect(screen.getByText(/No voices match/)).toBeInTheDocument();
    expect(screen.queryByText('Keefe Sencen')).toBeNull();
  });

  it('restores the full tab-filtered list when the query is cleared', () => {
    render(
      <VoiceLibraryPanel library={lib} draggingVoiceId={null} setDraggingVoiceId={vi.fn()} />,
    );
    const input = screen.getByPlaceholderText('Search voices');
    fireEvent.change(input, { target: { value: 'keefe' } });
    expect(screen.queryByText('Elwin')).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Keefe Sencen')).toBeInTheDocument();
    expect(screen.getByText('Elwin')).toBeInTheDocument();
    expect(screen.getByText('Ro')).toBeInTheDocument();
  });

  it('shows an empty-state line when no voice matches the query', () => {
    render(
      <VoiceLibraryPanel library={lib} draggingVoiceId={null} setDraggingVoiceId={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search voices'), {
      target: { value: 'zzzznope' },
    });
    expect(screen.getByText(/No voices match/)).toBeInTheDocument();
    expect(screen.queryByText('Keefe Sencen')).toBeNull();
  });
});

describe('VoiceLibraryPanel — Series tab scoping & default tab', () => {
  /* The cast view's "Series" tab must scope to the open book's series
     (`source === 'library' && inCurrentSeries`), not every other book in the
     workspace. The default tab is context-aware: a series book opens on
     "Series", a standalone opens on "This book". */
  const thisBook = makeVoice('v_self', 'Captain Halloran', { source: 'current' });
  const sibling = makeVoice('v_sib', 'Series Sibling', {
    source: 'library',
    inCurrentSeries: true,
    bookTitle: 'Solway Bay',
    bookId: 'sb',
  });
  const otherSeries = makeVoice('v_other', 'Unrelated Voice', {
    source: 'library',
    bookTitle: 'Some Other Book',
    bookId: 'xx',
  });

  it('hides the Series tab and defaults to "This book" for a standalone (no series voices)', () => {
    render(
      <VoiceLibraryPanel
        library={[thisBook, otherSeries]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
      />,
    );
    /* No series voices → no Series tab. */
    expect(screen.queryByRole('button', { name: 'Series' })).toBeNull();
    /* Defaults to "This book": shows the current-book voice, hides the
       unrelated workspace voice (which only lives under "All"). */
    expect(screen.getByText('Captain Halloran')).toBeInTheDocument();
    expect(screen.queryByText('Unrelated Voice')).toBeNull();
    /* The "All" tab still surfaces every workspace voice. */
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Unrelated Voice')).toBeInTheDocument();
  });

  it('shows the Series tab and defaults to it for a series book', () => {
    render(
      <VoiceLibraryPanel
        library={[thisBook, sibling, otherSeries]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Series' })).toBeInTheDocument();
    /* Defaults to "Series": shows only the in-series sibling, not the
       current-book voice nor the unrelated-series voice. */
    expect(screen.getByText('Series Sibling')).toBeInTheDocument();
    expect(screen.queryByText('Captain Halloran')).toBeNull();
    expect(screen.queryByText('Unrelated Voice')).toBeNull();
  });

  it('keeps an out-of-series library voice off the Series tab', () => {
    render(
      <VoiceLibraryPanel
        library={[thisBook, sibling, otherSeries]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
      />,
    );
    /* Already on Series by default — the unrelated workspace voice must not
       appear even though it's a `source: 'library'` voice. */
    expect(screen.queryByText('Unrelated Voice')).toBeNull();
    /* It IS reachable from the "All" tab. */
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Unrelated Voice')).toBeInTheDocument();
  });

  it('respects a manual tab pick even after the auto-default would change', () => {
    /* User clicks "This book" on a series book; the panel must not yank them
       back to "Series". */
    render(
      <VoiceLibraryPanel
        library={[thisBook, sibling]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'This book' }));
    expect(screen.getByText('Captain Halloran')).toBeInTheDocument();
    expect(screen.queryByText('Series Sibling')).toBeNull();
  });
});
