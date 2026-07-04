import { describe, it, expect } from 'vitest';
import { compareCastRows } from './cast-sort';
import type { Character } from './types';

describe('compareCastRows — cast table ordering', () => {
  const mk = (over: Partial<Character> & { id: string }): Character =>
    ({ name: over.id, role: 'r', color: 'narrator', lines: 0, ...over }) as Character;

  it('sorts by line count descending', () => {
    const out = [mk({ id: 'a', lines: 5 }), mk({ id: 'b', lines: 100 }), mk({ id: 'c', lines: 42 })]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['b', 'c', 'a']);
  });

  it('pins unknown-male and unknown-female last regardless of line count', () => {
    const out = [
      mk({ id: 'unknown-male', name: 'Unknown male', lines: 9999 }),
      mk({ id: 'wren', name: 'Wren', lines: 10 }),
      mk({ id: 'unknown-female', name: 'Unknown female', lines: 8888 }),
      mk({ id: 'narrator', name: 'Narrator', lines: 5 }),
    ]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['wren', 'narrator', 'unknown-male', 'unknown-female']);
  });

  it('orders the two buckets between themselves by line count', () => {
    const out = [
      mk({ id: 'unknown-female', name: 'Unknown female', lines: 3 }),
      mk({ id: 'unknown-male', name: 'Unknown male', lines: 7 }),
    ]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['unknown-male', 'unknown-female']);
  });

  it('breaks line-count ties by name ascending', () => {
    const out = [mk({ id: 'z', name: 'Zed', lines: 10 }), mk({ id: 'a', name: 'Amy', lines: 10 })]
      .sort(compareCastRows)
      .map((c) => c.name);
    expect(out).toEqual(['Amy', 'Zed']);
  });

  it('treats a missing line count as zero', () => {
    const out = [mk({ id: 'has', name: 'Has', lines: 1 }), mk({ id: 'none', name: 'None' })]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['has', 'none']);
  });
});
