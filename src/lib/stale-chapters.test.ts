import { describe, it, expect } from 'vitest';
import { renderedChaptersForCharacter } from './stale-chapters';
import type { Chapter } from './types';

const ch = (id: number, state: string, characters: Record<string, unknown> | null): Chapter =>
  ({ id, title: `c${id}`, slug: `c${id}`, state, characters } as unknown as Chapter);

describe('renderedChaptersForCharacter', () => {
  it('returns ids of done chapters the character speaks in', () => {
    const chapters = [
      ch(1, 'done', { Wren: 10, Marlow: 4 }),
      ch(2, 'done', { Marlow: 2 }), // Wren absent
      ch(3, 'queued', { Wren: 5 }), // not done
      ch(4, 'done', { Wren: 1 }),
    ];
    expect(renderedChaptersForCharacter('Wren', chapters)).toEqual([1, 4]);
  });

  it('returns [] when the character speaks in no done chapter', () => {
    expect(renderedChaptersForCharacter('ghost', [ch(1, 'done', { Wren: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('Wren', [ch(1, 'queued', { Wren: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('Wren', [ch(1, 'done', null)])).toEqual([]);
  });
});
