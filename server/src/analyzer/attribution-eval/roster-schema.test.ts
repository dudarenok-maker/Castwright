import { describe, it, expect } from 'vitest';
import { parseRosterSnapshot } from './roster-schema.js';

describe('parseRosterSnapshot', () => {
  it('accepts a well-formed roster', () => {
    const r = parseRosterSnapshot({
      characters: [
        { id: 'narrator', name: 'Narrator' },
        { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female', aliases: ['Val'] },
      ],
    });
    expect(r.characters).toHaveLength(2);
    expect(r.characters[1].gender).toBe('female');
  });

  it('rejects a character missing id', () => {
    expect(() => parseRosterSnapshot({ characters: [{ name: 'x' }] })).toThrow();
  });
});
