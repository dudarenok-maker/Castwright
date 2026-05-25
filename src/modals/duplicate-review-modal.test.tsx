/* DuplicateReviewModal — plan 101.

   Coverage:
   - Renders side-by-side cards for the two voices + characters.
   - Default survivor picked via pickMergeSurvivor (longer-named wins).
   - Link path calls api.linkPriorCharacter, dispatches applyManualMatch,
     pushes a toast, and closes.
   - Variant path calls api.notLinkedTo, dispatches applyNotLinked,
     pushes a toast, and closes.
   - Server error leaves modal open and surfaces the error inline. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { castSlice } from '../store/cast-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { DuplicateReviewModal, type DuplicateReviewPair } from './duplicate-review-modal';
import { api } from '../lib/api';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    linkPriorCharacter: vi.fn(),
    notLinkedTo: vi.fn(),
  },
}));

const linkSpy = vi.mocked(api.linkPriorCharacter);
const notLinkedSpy = vi.mocked(api.notLinkedTo);

function makeVoice(opts: { id: string; character: string; bookId: string; bookTitle: string }): Voice {
  return {
    id: opts.id,
    character: opts.character,
    bookTitle: opts.bookTitle,
    bookId: opts.bookId,
    attributes: [],
    usedIn: 1,
    source: 'current',
    gradient: ['#000', '#fff'],
    ttsVoice: { provider: 'gemini', name: 'Kore', description: '' },
  } as Voice;
}

function makeCharacter(id: string, name: string, extra: Partial<Character> = {}): Character {
  return { id, name, role: 'character', color: 'unset', ...extra } as Character;
}

function buildPair(): DuplicateReviewPair {
  return {
    a: {
      voice: makeVoice({
        id: 'v_eliza',
        character: 'Eliza Gray',
        bookId: 'ns',
        bookTitle: 'The Northern Star',
      }),
      character: makeCharacter('v_eliza', 'Eliza Gray'),
    },
    b: {
      voice: makeVoice({
        id: 'v_eliza_sb',
        character: 'Eliza',
        bookId: 'sb',
        bookTitle: 'Solway Bay',
      }),
      character: makeCharacter('v_eliza_sb', 'Eliza'),
    },
  };
}

/* Same pair, but with both Characters unresolved — the shape the modal
   sees while a foreign book's cast is still hydrating. */
function buildUnresolvedPair(): DuplicateReviewPair {
  const p = buildPair();
  return {
    a: { voice: p.a.voice, character: null },
    b: { voice: p.b.voice, character: null },
  };
}

function renderModal(
  pair: DuplicateReviewPair | null = buildPair(),
  onClose = vi.fn(),
  extra: { loading?: boolean; hydrationError?: string | null } = {},
) {
  const store = configureStore({
    reducer: {
      cast: castSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      cast: { characters: pair?.a.character ? [pair.a.character] : [] },
    },
  });
  return {
    store,
    onClose,
    ...render(
      <Provider store={store}>
        <DuplicateReviewModal open pair={pair} onClose={onClose} {...extra} />
      </Provider>,
    ),
  };
}

beforeEach(() => {
  linkSpy.mockReset();
  notLinkedSpy.mockReset();
});

describe('DuplicateReviewModal — mount', () => {
  it('renders side-by-side cards for each voice', () => {
    renderModal();
    expect(screen.getAllByText('Eliza Gray').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Eliza').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('The Northern Star')).toBeInTheDocument();
    expect(screen.getByText('Solway Bay')).toBeInTheDocument();
  });

  it('null-renders when open is false', () => {
    const store = configureStore({
      reducer: { cast: castSlice.reducer, notifications: notificationsSlice.reducer },
    });
    const { container } = render(
      <Provider store={store}>
        <DuplicateReviewModal open={false} pair={buildPair()} onClose={vi.fn()} />
      </Provider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('null-renders when pair is null', () => {
    const { container } = renderModal(null);
    expect(container.firstChild).toBeNull();
  });

  it('picks the longer-named side as default survivor', () => {
    renderModal();
    expect(screen.getByText(/Survivor:/)).toHaveTextContent('Eliza Gray');
  });
});

describe('DuplicateReviewModal — hydration states', () => {
  it('disables both actions and shows a loading hint while casts hydrate', () => {
    renderModal(buildUnresolvedPair(), vi.fn(), { loading: true });
    expect(screen.getByText(/Loading both books/i)).toBeInTheDocument();
    /* The misleading "open both books" copy is gone. */
    expect(screen.queryByText(/Open both books/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Loading casts/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Different on purpose/i })).toBeDisabled();
  });

  it('surfaces a hydration failure and keeps actions disabled', () => {
    renderModal(buildUnresolvedPair(), vi.fn(), {
      hydrationError: 'Couldn’t load one book’s cast — try again later, or use Cancel.',
    });
    expect(screen.getByText(/load one book/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Same character — link them/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Different on purpose/i })).toBeDisabled();
  });

  it('enables both actions once both characters resolve', () => {
    renderModal(buildPair());
    expect(screen.getByRole('button', { name: /Same character — link them/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Different on purpose/i })).toBeEnabled();
  });

  it('flips from loading to enabled and recomputes the survivor when casts land', () => {
    const store = configureStore({
      reducer: { cast: castSlice.reducer, notifications: notificationsSlice.reducer },
    });
    const { rerender } = render(
      <Provider store={store}>
        <DuplicateReviewModal open pair={buildUnresolvedPair()} onClose={vi.fn()} loading />
      </Provider>,
    );
    expect(screen.getByRole('button', { name: /Loading casts/i })).toBeDisabled();
    rerender(
      <Provider store={store}>
        <DuplicateReviewModal open pair={buildPair()} onClose={vi.fn()} loading={false} />
      </Provider>,
    );
    expect(screen.getByRole('button', { name: /Same character — link them/i })).toBeEnabled();
    expect(screen.getByText(/Survivor:/)).toHaveTextContent('Eliza Gray');
  });
});

describe('DuplicateReviewModal — link path', () => {
  it('calls api.linkPriorCharacter with the loser→survivor pair and closes', async () => {
    linkSpy.mockResolvedValue({
      matchedFrom: {
        bookId: 'ns',
        characterId: 'v_eliza',
        bookTitle: 'The Northern Star',
        confidence: 1,
      },
      voiceId: 'v_eliza',
    });
    const onClose = vi.fn();
    const { store } = renderModal(buildPair(), onClose);
    fireEvent.click(screen.getByRole('button', { name: /Same character — link them/i }));
    await waitFor(() => {
      expect(linkSpy).toHaveBeenCalledWith({
        bookId: 'sb',
        sourceCharacterId: 'v_eliza_sb',
        targetBookId: 'ns',
        targetCharacterId: 'v_eliza',
      });
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(store.getState().notifications.toasts).toHaveLength(1);
  });

  it('leaves the modal open and surfaces inline error on API failure', async () => {
    linkSpy.mockRejectedValue(new Error('Series guard failed'));
    const onClose = vi.fn();
    renderModal(buildPair(), onClose);
    fireEvent.click(screen.getByRole('button', { name: /Same character — link them/i }));
    await waitFor(() => {
      expect(screen.getByText('Series guard failed')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('DuplicateReviewModal — variant path', () => {
  it('calls api.notLinkedTo with the pair and dispatches applyNotLinked', async () => {
    notLinkedSpy.mockResolvedValue({
      pair: {
        a: { bookId: 'ns', characterId: 'v_eliza' },
        b: { bookId: 'sb', characterId: 'v_eliza_sb' },
      },
    });
    const onClose = vi.fn();
    const { store } = renderModal(buildPair(), onClose);
    fireEvent.click(screen.getByRole('button', { name: /Different on purpose/i }));
    await waitFor(() => {
      expect(notLinkedSpy).toHaveBeenCalledWith({
        bookId: 'ns',
        characterId: 'v_eliza',
        otherBookId: 'sb',
        otherCharacterId: 'v_eliza_sb',
      });
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    const eliza = store.getState().cast.characters.find((c) => c.id === 'v_eliza');
    expect(eliza?.notLinkedTo).toEqual([{ bookId: 'sb', characterId: 'v_eliza_sb' }]);
  });

  it('leaves the modal open and surfaces inline error on API failure', async () => {
    notLinkedSpy.mockRejectedValue(new Error('Cross-series rejected'));
    const onClose = vi.fn();
    renderModal(buildPair(), onClose);
    fireEvent.click(screen.getByRole('button', { name: /Different on purpose/i }));
    await waitFor(() => {
      expect(screen.getByText('Cross-series rejected')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('DuplicateReviewModal — cancel', () => {
  it('does not call api when Cancel is clicked', () => {
    const onClose = vi.fn();
    renderModal(buildPair(), onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(linkSpy).not.toHaveBeenCalled();
    expect(notLinkedSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
