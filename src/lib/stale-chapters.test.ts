import { describe, it, expect } from 'vitest';
import { renderedChaptersForCharacter } from './stale-chapters';
import type { Chapter } from './types';

const ch = (id: number, state: string, characters: Record<string, unknown> | null): Chapter =>
  ({ id, title: `c${id}`, slug: `c${id}`, state, characters } as unknown as Chapter);

describe('renderedChaptersForCharacter', () => {
  it('returns ids of done chapters the character speaks in', () => {
    const chapters = [
      ch(1, 'done', { sophie: 10, keefe: 4 }),
      ch(2, 'done', { keefe: 2 }), // sophie absent
      ch(3, 'queued', { sophie: 5 }), // not done
      ch(4, 'done', { sophie: 1 }),
    ];
    expect(renderedChaptersForCharacter('sophie', chapters)).toEqual([1, 4]);
  });

  it('returns [] when the character speaks in no done chapter', () => {
    expect(renderedChaptersForCharacter('ghost', [ch(1, 'done', { sophie: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('sophie', [ch(1, 'queued', { sophie: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('sophie', [ch(1, 'done', null)])).toEqual([]);
  });
});
