/* Pairs with docs/features/NNN-design-full-cast.md.

   The cast-design slice is a narrow out-of-band snapshot for the third
   top-bar status pill ("Designing"), driven by the server-owned bulk-design
   job via `cast-design-stream-middleware`. Tests cover the reducer surface,
   the cross-book guard (a tick for another book must not move this snapshot),
   and that per-character failures accumulate without bumping `done`. */

import { describe, it, expect } from 'vitest';
import { castDesignSlice, castDesignActions } from './cast-design-slice';

const begin = castDesignActions.begin({
  bookId: 'b1',
  total: 3,
  currentName: 'Wren',
  lastTickAt: 1000,
});

describe('castDesignSlice — active snapshot reducers', () => {
  it('starts with active: null', () => {
    const state = castDesignSlice.reducer(undefined, { type: 'noop' });
    expect(state.active).toBeNull();
  });

  it('begin opens a running snapshot with zeroed counters', () => {
    const s = castDesignSlice.reducer(undefined, begin);
    expect(s.active).toEqual({
      bookId: 'b1',
      kind: 'bulk',
      total: 3,
      done: 0,
      skipped: 0,
      currentName: 'Wren',
      state: 'running',
      lastTickAt: 1000,
      failures: [],
      fallbacks: [],
    });
  });

  it('charDone bumps done; charSkipped bumps skipped; both refresh lastTickAt', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.charDone({ bookId: 'b1', lastTickAt: 1100 }));
    s = castDesignSlice.reducer(s, castDesignActions.charSkipped({ bookId: 'b1', lastTickAt: 1200 }));
    expect(s.active).toMatchObject({ done: 1, skipped: 1, lastTickAt: 1200 });
  });

  it('charFailed records the failure WITHOUT bumping done', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(
      s,
      castDesignActions.charFailed({
        bookId: 'b1',
        characterId: 'c2',
        name: 'Marlow',
        error: 'GEMINI_API_KEY is required',
        lastTickAt: 1300,
      }),
    );
    expect(s.active?.done).toBe(0);
    expect(s.active?.failures).toEqual([
      { characterId: 'c2', name: 'Marlow', error: 'GEMINI_API_KEY is required' },
    ]);
  });

  it('tick advances currentName; heartbeat only refreshes lastTickAt', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(
      s,
      castDesignActions.tick({ bookId: 'b1', currentName: 'Marlow', lastTickAt: 1400 }),
    );
    expect(s.active).toMatchObject({ currentName: 'Marlow', lastTickAt: 1400 });
    s = castDesignSlice.reducer(s, castDesignActions.heartbeat({ bookId: 'b1', lastTickAt: 1500 }));
    expect(s.active).toMatchObject({ currentName: 'Marlow', lastTickAt: 1500 });
  });

  it('settle flips to done + nulls currentName; clear tears down', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.settle({ bookId: 'b1', lastTickAt: 1600 }));
    expect(s.active).toMatchObject({ state: 'done', currentName: null });
    s = castDesignSlice.reducer(s, castDesignActions.clear());
    expect(s.active).toBeNull();
  });

  it('halt flips to halted (catastrophic abort)', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.halt({ bookId: 'b1', lastTickAt: 1700 }));
    expect(s.active).toMatchObject({ state: 'halted', currentName: null });
  });

  it('cross-book guard: a tick for another book is ignored', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.charDone({ bookId: 'OTHER', lastTickAt: 9999 }));
    s = castDesignSlice.reducer(
      s,
      castDesignActions.charFailed({
        bookId: 'OTHER',
        characterId: 'x',
        name: 'X',
        error: 'e',
        lastTickAt: 9999,
      }),
    );
    s = castDesignSlice.reducer(s, castDesignActions.settle({ bookId: 'OTHER', lastTickAt: 9999 }));
    expect(s.active).toMatchObject({ done: 0, state: 'running', lastTickAt: 1000 });
    expect(s.active?.failures).toEqual([]);
  });

  it('designAllRequested + resubscribe are no-op reducers (side effects in middleware)', () => {
    const s0 = castDesignSlice.reducer(undefined, begin);
    const s1 = castDesignSlice.reducer(
      s0,
      castDesignActions.designAllRequested({ bookId: 'b1', characterIds: ['c1'], modelKey: 'k' }),
    );
    expect(s1.active).toEqual(s0.active);
    const s2 = castDesignSlice.reducer(s1, castDesignActions.resubscribe({ bookId: 'b1' }));
    expect(s2.active).toEqual(s0.active);
  });
});

describe('single-design snapshot', () => {
  it('beginSingle opens a kind:single snapshot with phase freeing-vram', () => {
    const s = castDesignSlice.reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'first', lastTickAt: 10,
    }));
    expect(s.active).toMatchObject({
      kind: 'single', bookId: 'b1', characterId: 'c1', currentName: 'Aria',
      total: 1, done: 0, mode: 'first', phase: 'freeing-vram', state: 'running',
    });
  });

  it('setPhase advances the phase (guarded by character)', () => {
    let s = castDesignSlice.reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'first', lastTickAt: 10,
    }));
    s = castDesignSlice.reducer(s, castDesignActions.setPhase({ bookId: 'b1', characterId: 'c1', phase: 'rendering', lastTickAt: 20 }));
    expect(s.active!.phase).toBe('rendering');
    // wrong character is ignored
    s = castDesignSlice.reducer(s, castDesignActions.setPhase({ bookId: 'b1', characterId: 'cX', phase: 'designing', lastTickAt: 30 }));
    expect(s.active!.phase).toBe('rendering');
  });

  it('previewReady flips to ready-to-compare carrying the preview payload', () => {
    let s = castDesignSlice.reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'redesign', lastTickAt: 10,
    }));
    s = castDesignSlice.reducer(s, castDesignActions.previewReady({
      bookId: 'b1', characterId: 'c1',
      previewVoiceId: 'qwen-c1-preview', previewUrl: '/x.mp3', persona: 'warm', lastTickAt: 20,
    }));
    expect(s.active).toMatchObject({
      state: 'ready-to-compare',
      preview: { characterId: 'c1', previewVoiceId: 'qwen-c1-preview', previewUrl: '/x.mp3', persona: 'warm' },
    });
  });

  /* srv-43: previewReady with voiceUuid — the slice must persist it so the
     drawer can resolve the uuid-keyed sample-cache entry before a cast refetch. */
  it('previewReady persists voiceUuid in the preview payload', () => {
    let s = castDesignSlice.reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'redesign', lastTickAt: 10,
    }));
    s = castDesignSlice.reducer(s, castDesignActions.previewReady({
      bookId: 'b1', characterId: 'c1',
      previewVoiceId: 'qwen-c1-preview', previewUrl: '/x.mp3', persona: 'warm',
      voiceUuid: 'uuid-c1-abc123', lastTickAt: 20,
    }));
    expect(s.active?.preview?.voiceUuid).toBe('uuid-c1-abc123');
  });

  it('previewReady without voiceUuid leaves voiceUuid undefined', () => {
    let s = castDesignSlice.reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'redesign', lastTickAt: 10,
    }));
    s = castDesignSlice.reducer(s, castDesignActions.previewReady({
      bookId: 'b1', characterId: 'c1',
      previewVoiceId: 'qwen-c1-preview', previewUrl: '/x.mp3', persona: 'warm', lastTickAt: 20,
    }));
    expect(s.active?.preview?.voiceUuid).toBeUndefined();
  });

  it('beginSingle seeds the lowest phase so early phases still show', () => {
    const s = castDesignSlice.reducer(
      undefined,
      castDesignActions.beginSingle({ bookId: 'b', characterId: 'c', name: 'N', mode: 'first', lastTickAt: 0 }),
    );
    expect(s.active?.phase).toBe('freeing-vram');
  });

  it('setPhase advances forward through the real phase order but never rewinds', () => {
    let s = castDesignSlice.reducer(
      undefined,
      castDesignActions.beginSingle({ bookId: 'b', characterId: 'c', name: 'N', mode: 'first', lastTickAt: 0 }),
    );
    s = castDesignSlice.reducer(s, castDesignActions.setPhase({ bookId: 'b', characterId: 'c', phase: 'loading-model', lastTickAt: 1 }));
    expect(s.active?.phase).toBe('loading-model'); // advances from the freeing-vram seed
    s = castDesignSlice.reducer(s, castDesignActions.setPhase({ bookId: 'b', characterId: 'c', phase: 'designing', lastTickAt: 2 }));
    expect(s.active?.phase).toBe('designing');
    // a late, duplicated/out-of-order lower-rank POST must be ignored (AR5)
    s = castDesignSlice.reducer(s, castDesignActions.setPhase({ bookId: 'b', characterId: 'c', phase: 'loading-model', lastTickAt: 3 }));
    expect(s.active?.phase).toBe('designing');
    s = castDesignSlice.reducer(s, castDesignActions.setPhase({ bookId: 'b', characterId: 'c', phase: 'rendering', lastTickAt: 4 }));
    expect(s.active?.phase).toBe('rendering');
  });
});

describe('variantFellBack reducer', () => {
  const reducer = castDesignSlice.reducer;

  it('records a fallback variant in the active snapshot', () => {
    let s = reducer(undefined, castDesignActions.begin({ bookId: 'b', total: 1, currentName: 'Mara', lastTickAt: 1 }));
    s = reducer(s, castDesignActions.variantFellBack({ bookId: 'b', characterId: 'c', emotion: 'angry', lastTickAt: 2 }));
    expect(s.active?.fallbacks).toEqual([{ characterId: 'c', emotion: 'angry' }]);
  });

  it('ignores a fallback for a different book', () => {
    let s = reducer(undefined, castDesignActions.begin({ bookId: 'b', total: 1, currentName: null, lastTickAt: 1 }));
    s = reducer(s, castDesignActions.variantFellBack({ bookId: 'OTHER', characterId: 'c', emotion: 'angry', lastTickAt: 2 }));
    expect(s.active?.fallbacks).toEqual([]);
  });
});
