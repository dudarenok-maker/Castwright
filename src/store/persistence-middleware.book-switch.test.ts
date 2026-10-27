// Regression for #3624: a persisted edit made while the slices still hold
// another book must not be written into the stage book's state files.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', () => ({ api: { putBookState } }));

import { persistenceMiddleware, PERSISTED_ACTION_TYPES } from './persistence-middleware';

const EXEMPT = 'bookMeta/commitDraft';
const SENTINELS = ['b-only', 'b-ev', 'B-ONLY', 'B-KEY', 'B title'];

function makeStore(state: Record<string, unknown>) {
  return {
    getState: () => state,
    dispatch: vi.fn(),
  } as unknown as Parameters<typeof persistenceMiddleware>[0];
}

const meta = (title: string) => ({
  title,
  author: '',
  series: '',
  narratorCredit: '',
  genre: '',
  publicationDate: '',
  description: '',
  notes: '',
});

const state = (stageBookId: string, heldBookId: string | null) => ({
  ui: { stage: { bookId: stageBookId } },
  cast: { characters: [{ id: 'b-only' }] },
  manuscript: {
    bookId: heldBookId,
    sentences: [{ id: 1, chapterId: 1, text: 'B-ONLY' }],
    mergedAwayKeys: ['B-KEY'],
  },
  changeLog: { events: [{ id: 'b-ev' }] },
  bookMeta: {
    draft: null,
    saved: { A: meta('A title'), B: meta('B title') },
    /* A details commit sends the fields typed since the last accepted save
       (#3784 review pass 9), keyed by book like `saved`. */
    lastCommitted: {
      A: { saved: meta('A old'), draft: { title: 'A title' } },
      B: { saved: meta('B old'), draft: { title: 'B title' } },
    },
  },
});

const fire = async (s: Record<string, unknown>, type: string) => {
  persistenceMiddleware(makeStore(s))((x) => x)({ type });
  await vi.advanceTimersByTimeAsync(1000);
};

const callsTo = (bookId: string) => putBookState.mock.calls.filter((c) => c[0] === bookId);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  putBookState.mockClear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('persistenceMiddleware — book-switch gate (#3624)', () => {
  it('covers a non-trivial set of persisted action types', () => {
    expect(PERSISTED_ACTION_TYPES.length).toBeGreaterThan(20);
    expect(PERSISTED_ACTION_TYPES).toContain(EXEMPT);
  });

  describe('(a) mismatch: slices hold B, stage is A', () => {
    it.each(PERSISTED_ACTION_TYPES)('%s never writes B content into A', async (type) => {
      await fire(state('A', 'B'), type);
      for (const c of callsTo('A')) {
        const json = JSON.stringify(c);
        for (const sentinel of SENTINELS) expect(json).not.toContain(sentinel);
      }
      if (type !== EXEMPT) {
        expect(putBookState).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(type));
      }
    });
  });

  it('(b) the book-keyed bookMeta/commitDraft still saves A', async () => {
    await fire(state('A', 'B'), EXEMPT);
    const calls = callsTo('A');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].slice).toBe('state');
    expect(calls[0][1].patch).toEqual({ title: 'A title' });
  });

  it('(c) control: matching book persists every type without a warning', async () => {
    for (const type of PERSISTED_ACTION_TYPES) {
      putBookState.mockClear();
      await fire(state('A', 'A'), type);
      expect(callsTo('A'), type).toHaveLength(1);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['cast/updateCharacter', 'manuscript/setSentenceCharacter', 'changeLog/appendLogEvent'])(
    '(d) control: no recorded identity still persists %s',
    async (type) => {
      await fire(state('A', null), type);
      expect(callsTo('A')).toHaveLength(1);
    },
  );

  it('(e) race shape: B edit persists to B, post-openBook edit does not reach A', async () => {
    await fire(state('B', 'B'), 'cast/updateCharacter');
    expect(callsTo('B')).toHaveLength(1);
    await fire(state('A', 'B'), 'cast/updateCharacter');
    expect(callsTo('A')).toHaveLength(0);
  });
});
