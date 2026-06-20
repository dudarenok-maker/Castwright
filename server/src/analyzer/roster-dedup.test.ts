import { dedupeRosterByName, composeRewrites } from './roster-dedup.js';

const c = (over: { id: string; name: string; role?: string; color?: string; gender?: string; [key: string]: unknown }) =>
  ({ id: over.id, name: over.name, role: over.role ?? 'r', color: over.color ?? 'c', ...over });
const sent = (characterId: string, n = 1) => Array.from({ length: n }, () => ({ characterId }));

describe('dedupeRosterByName Tier-1 (exact name)', () => {
  it('collapses olga + ольга to one entry with canonical id ольга', () => {
    const chars = [c({ id: 'olga', name: 'Ольга', gender: 'female' }), c({ id: 'ольга', name: 'Ольга', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [...sent('olga', 8), ...sent('ольга', 203)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('ольга');
    expect(r.rewrites).toEqual({ olga: 'ольга' });
  });

  it('does NOT merge two same-name people of different gender', () => {
    const chars = [c({ id: 'ivan', name: 'Иван', gender: 'male' }), c({ id: 'ivan2', name: 'Иван', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [...sent('ivan'), ...sent('ivan2')]);
    expect(r.characters).toHaveLength(2);
  });

  it('never merges the narrator, even with a non-narrator group named "Narrator"', () => {
    const chars = [c({ id: 'narrator', name: 'Narrator', color: 'unset' }), c({ id: 'narrator-2', name: 'Narrator' })];
    const r = dedupeRosterByName(chars as any, [...sent('narrator'), ...sent('narrator-2')]);
    // narrator row untouched; the non-narrator "Narrator" group must NOT remap onto id 'narrator'
    expect(r.characters.find((x) => x.id === 'narrator')).toBeDefined();
    expect(Object.values(r.rewrites)).not.toContain('narrator');
  });
});

describe('dedupeRosterByName Tier-2a (full vs short)', () => {
  it('auto-merges Антон into Антон Городецкий, survivor = more lines, short name aliased', () => {
    const chars = [c({ id: 'anton', name: 'Антон', gender: 'male' }), c({ id: 'anton-gorodetsky', name: 'Антон Городецкий', gender: 'male' })];
    const r = dedupeRosterByName(chars as any, [...sent('anton', 3), ...sent('anton-gorodetsky', 50)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('anton-gorodetsky');
    expect(r.characters[0].aliases).toContain('Антон');
    expect(r.rewrites).toEqual({ anton: 'anton-gorodetsky' });
  });

  it('Tier-2a tie on equal lines → earlier roster entry survives', () => {
    const chars = [c({ id: 'anton', name: 'Антон', gender: 'male' }), c({ id: 'anton-gorodetsky', name: 'Антон Городецкий', gender: 'male' })];
    const r = dedupeRosterByName(chars as any, [...sent('anton', 5), ...sent('anton-gorodetsky', 5)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('anton'); // earlier-in-roster wins the tie
    expect(r.rewrites).toEqual({ 'anton-gorodetsky': 'anton' });
  });

  it('does NOT merge when two longer names both contain the short name (ambiguous)', () => {
    const chars = [
      c({ id: 'anton', name: 'Антон', gender: 'male' }),
      c({ id: 'ag', name: 'Антон Городецкий', gender: 'male' }),
      c({ id: 'ai', name: 'Антон Иванов', gender: 'male' }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('anton'), ...sent('ag'), ...sent('ai')]);
    expect(r.characters).toHaveLength(3);
  });
});

describe('dedupeRosterByName Tier-2b (diminutive suggestions)', () => {
  it('emits a suggestion for Оля + Ольга without merging', () => {
    const chars = [c({ id: 'olya', name: 'Оля', gender: 'female' }), c({ id: 'ольга', name: 'Ольга', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [...sent('olya', 4), ...sent('ольга', 30)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
    expect(r.suggestions).toEqual([{ sourceId: 'olya', targetId: 'ольга', reason: expect.any(String) }]);
  });

  it('does NOT suggest a multi-gender diminutive when genders are unset', () => {
    const chars = [c({ id: 's1', name: 'Саша' }), c({ id: 's2', name: 'Александр' })];
    const r = dedupeRosterByName(chars as any, [...sent('s1'), ...sent('s2')]);
    expect(r.suggestions).toEqual([]);
  });
});

describe('composeRewrites', () => {
  it('chains two maps transitively', () => {
    const result = composeRewrites({ olga: 'ольга' }, { 'ольга': 'unknown-female' });
    expect(result).toEqual({ olga: 'unknown-female', 'ольга': 'unknown-female' });
  });

  it('returns empty map when maps do not chain', () => {
    const result = composeRewrites({ a: 'b' }, { c: 'd' });
    // No chaining, no identity entries, just both individual mappings
    expect(result).toEqual({ a: 'b', c: 'd' });
  });
});
