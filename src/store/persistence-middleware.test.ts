// Pairs with docs/features/23-book-state-persistence.md

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', () => ({ api: { putBookState } }));

import { persistenceMiddleware } from './persistence-middleware';

function makeStore(state: Record<string, unknown>) {
  return {
    getState: () => state,
    dispatch: vi.fn(),
  } as unknown as Parameters<typeof persistenceMiddleware>[0];
}

const baseState = (overrides: Record<string, unknown> = {}) => ({
  ui: { stage: { bookId: 'book-1' } },
  cast: { characters: [{ id: 'halloran' }] },
  manuscript: { sentences: [] },
  revisions: { pending: [], drift: [] },
  changeLog: { events: [] },
  bookMeta: { draft: null, saved: {} },
  ...overrides,
});

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  putBookState.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('persistenceMiddleware — gating', () => {
  it('skips persistence when stage has no bookId', async () => {
    const state = baseState({ ui: { stage: {} } });
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(state))(next)({ type: 'cast/setCharacters' });
    await advance(1000);
    expect(putBookState).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through unrelated action types without firing a PUT', async () => {
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(baseState()))(next)({ type: 'something/unrelated' });
    await advance(1000);
    expect(putBookState).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('ignores actions without a type property', async () => {
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(baseState()))(next)({} as { type?: string });
    await advance(1000);
    expect(putBookState).not.toHaveBeenCalled();
  });
});

describe('persistenceMiddleware — debounce', () => {
  it('PUTs once after 500ms for a curated action', async () => {
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(baseState()))(next);

    mw({ type: 'cast/setCharacters' });
    await advance(499);
    expect(putBookState).not.toHaveBeenCalled();

    await advance(1);
    expect(putBookState).toHaveBeenCalledOnce();
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'halloran' }] },
    });
  });

  it('coalesces multiple rapid actions within the debounce window into one PUT', async () => {
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(baseState()))(next);

    mw({ type: 'cast/setCharacters' });
    await advance(200);
    mw({ type: 'cast/updateCharacter' });
    await advance(200);
    mw({ type: 'cast/lockVoice' });
    await advance(500);

    expect(putBookState).toHaveBeenCalledOnce();
    expect(putBookState).toHaveBeenCalledWith('book-1', expect.objectContaining({ slice: 'cast' }));
  });

  it('debounces independently per slice', async () => {
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(baseState()))(next);

    mw({ type: 'cast/setCharacters' });
    mw({ type: 'manuscript/splitSentence' });
    mw({ type: 'revisions/acceptAllPending' });
    mw({ type: 'changeLog/appendLogEvent' });
    mw({ type: 'ui/confirmCast' });

    await advance(500);

    const slices = putBookState.mock.calls.map(([, body]) => (body as { slice: string }).slice).sort();
    expect(slices).toEqual(['cast', 'changeLog', 'manuscript', 'revisions', 'state']);
  });
});

describe('persistenceMiddleware — payload shape', () => {
  it('sends the cast.characters patch for cast actions', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({ cast: { characters: [{ id: 'x' }, { id: 'y' }] } });
    persistenceMiddleware(makeStore(state))(next)({ type: 'cast/applyVoiceMatches' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'x' }, { id: 'y' }] },
    });
  });

  it('sends both pending + drift for revisions actions', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({ revisions: { pending: [{ id: 'r1' }], drift: [{ id: 'd1' }] } });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/dismissDrift' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: { pending: [{ id: 'r1' }], drift: [{ id: 'd1' }] },
    });
  });

  it('sends castConfirmed=true for ui/confirmCast (slice="state")', async () => {
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(baseState()))(next)({ type: 'ui/confirmCast' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'state',
      patch: { castConfirmed: true },
    });
  });

  it('sends the full editable metadata for bookMeta/commitDraft (slice="state")', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      bookMeta: {
        draft: null,
        saved: {
          'book-1': {
            title: 'Renamed',
            author: 'Mike Dudarenok',
            series: 'NCT · Book 2',
            narratorCredit: 'Anders Vale',
            genre: 'Literary fiction',
            publicationDate: '2026-05-09',
          },
        },
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'bookMeta/commitDraft' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'state',
      patch: {
        title: 'Renamed',
        author: 'Mike Dudarenok',
        series: 'NCT · Book 2',
        narratorCredit: 'Anders Vale',
        genre: 'Literary fiction',
        publicationDate: '2026-05-09',
      },
    });
  });
});

describe('persistenceMiddleware — error handling', () => {
  it('logs but does not rethrow when api.putBookState rejects', async () => {
    putBookState.mockRejectedValueOnce(new Error('boom'));
    const next = vi.fn((x) => x);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    persistenceMiddleware(makeStore(baseState()))(next)({ type: 'cast/setCharacters' });
    await advance(500);
    // Let the rejected promise settle.
    await vi.runAllTimersAsync();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
