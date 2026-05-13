import { describe, it, expect, vi } from 'vitest';
import { sortEvidence } from './analysis.js';
import type { CharacterOutput } from '../handoff/schemas.js';

describe('sortEvidence', () => {
  it('sorts each character\'s evidence by quote length descending', () => {
    const chars: CharacterOutput[] = [
      {
        id: 'a', name: 'A', role: 'r', color: 'c',
        evidence: [
          { quote: 'short' },                                // 5
          { quote: 'this is a much longer evidence quote' }, // 36
          { quote: 'medium length quote here' },             // 24
        ],
      },
    ];

    sortEvidence(chars);

    const lengths = chars[0].evidence!.map(e => e.quote.length);
    expect(lengths).toEqual([36, 24, 5]);
  });

  it('preserves note and other fields when sorting', () => {
    const chars: CharacterOutput[] = [
      {
        id: 'a', name: 'A', role: 'r', color: 'c',
        evidence: [
          { quote: 'shortie', note: 'tag-short' },
          { quote: 'a notably longer one', note: 'tag-long' },
        ],
      },
    ];

    sortEvidence(chars);

    expect(chars[0].evidence).toEqual([
      { quote: 'a notably longer one', note: 'tag-long' },
      { quote: 'shortie', note: 'tag-short' },
    ]);
  });

  it('is a no-op when evidence is missing or length ≤ 1', () => {
    const chars: CharacterOutput[] = [
      { id: 'a', name: 'A', role: 'r', color: 'c' },
      { id: 'b', name: 'B', role: 'r', color: 'c', evidence: [] },
      { id: 'c', name: 'C', role: 'r', color: 'c', evidence: [{ quote: 'solo' }] },
    ];

    expect(() => sortEvidence(chars)).not.toThrow();
    expect(chars[1].evidence).toEqual([]);
    expect(chars[2].evidence).toEqual([{ quote: 'solo' }]);
  });

  it('warns when a character has fewer than 3 evidence entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chars: CharacterOutput[] = [
      { id: 'thin', name: 'Thin', role: 'r', color: 'c', evidence: [{ quote: 'one' }, { quote: 'two' }] },
      { id: 'rich', name: 'Rich', role: 'r', color: 'c', evidence: [{ quote: 'one' }, { quote: 'two' }, { quote: 'three' }] },
    ];

    sortEvidence(chars);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('thin');
    expect(warn.mock.calls[0][0]).toContain('2');
    warn.mockRestore();
  });
});
