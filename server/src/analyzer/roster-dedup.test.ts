import { describe, expect, it } from 'vitest';
import { dedupeRosterByName, composeRewrites, pruneSuggestionsToRoster } from './roster-dedup.js';

const c = (over: { id: string; name: string; role?: string; color?: string; gender?: string; [key: string]: unknown }) =>
  ({ role: 'r', color: 'c', ...over });
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

describe('pruneSuggestionsToRoster', () => {
  it('drops a suggestion whose sourceId is absent from the roster', () => {
    const suggestions = [{ sourceId: 'olya', targetId: 'ольга', reason: 'Diminutive of «Ольга»' }];
    const roster = [{ id: 'ольга' }];
    expect(pruneSuggestionsToRoster(suggestions, roster)).toEqual([]);
  });

  it('drops a suggestion whose targetId is absent from the roster', () => {
    const suggestions = [{ sourceId: 'olya', targetId: 'ольга', reason: 'Diminutive of «Ольга»' }];
    const roster = [{ id: 'olya' }];
    expect(pruneSuggestionsToRoster(suggestions, roster)).toEqual([]);
  });

  it('keeps a suggestion when both ids are present in the roster', () => {
    const suggestions = [{ sourceId: 'olya', targetId: 'ольга', reason: 'Diminutive of «Ольга»' }];
    const roster = [{ id: 'olya' }, { id: 'ольга' }];
    expect(pruneSuggestionsToRoster(suggestions, roster)).toEqual(suggestions);
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

describe('dedupeRosterByName Tier-3 (alias coreference — strong merge)', () => {
  it('collapses шеф ↔ Борис Игнатьевич ↔ Гесер (mutual links) to one row, real name survives', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['Гесер', 'шеф'] }),
      c({ id: 'geser', name: 'Гесер', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    // шеф has the MOST lines, yet the multi-token real name must win the survivor.
    const r = dedupeRosterByName(chars as any, [...sent('boss', 100), ...sent('boris', 10), ...sent('geser', 5)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
    expect(r.characters[0].name).toBe('Борис Игнатьевич');
    expect(r.characters[0].aliases).toEqual(expect.arrayContaining(['шеф', 'Гесер']));
    expect(r.rewrites).toEqual({ boss: 'boris', geser: 'boris' });
    expect(r.suggestions).toEqual([]);
  });

  it('prefers the real name over a higher-line role word in a 2-way merge', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 80), ...sent('boris', 2)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
  });

  it('auto-merges a one-sided MULTI-token name link (directional)', () => {
    const chars = [
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male' }), // no aliases
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boris', 5), ...sent('boss', 5)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
    expect(r.rewrites).toEqual({ boss: 'boris' });
  });

  it('does NOT auto-merge a one-sided SINGLE-token (bare-word) link', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }), // no alias back
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 3), ...sent('boris', 30)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
  });

  it('auto-merges a MUTUAL single-token link (tokens tie → more lines wins survivor)', () => {
    const chars = [
      c({ id: 'rex', name: 'Рекс', gender: 'male', aliases: ['Пёс'] }),
      c({ id: 'pyos', name: 'Пёс', gender: 'male', aliases: ['Рекс'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('rex', 20), ...sent('pyos', 3)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('rex');
    expect(r.rewrites).toEqual({ pyos: 'rex' });
  });

  it('collapses a component linked only transitively (A↔B, B↔C, no direct A↔C)', () => {
    const chars = [
      c({ id: 'a', name: 'Алекс', gender: 'male', aliases: ['Боб'] }),
      c({ id: 'b', name: 'Боб', gender: 'male', aliases: ['Алекс', 'Карл'] }),
      c({ id: 'k', name: 'Карл', gender: 'male', aliases: ['Боб'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a', 5), ...sent('b', 40), ...sent('k', 5)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('b');
    expect(r.rewrites).toEqual({ a: 'b', k: 'b' });
  });

  it('collapses a Tier-1 canonical that then becomes a Tier-3 victim (cross-tier rewrite chain)', () => {
    // Two «Анна» rows → Tier-1 merges them into a synthesized canonical id
    // `анна` (safeId), unioning aliases. That `анна` canonical then forms a
    // mutual Tier-3 edge with the 2-token «Мария Ивановна», which wins the
    // survivor (more tokens) → `анна` becomes a Tier-3 victim. The transitive
    // collapse must resolve the FULL chain anna1/anna2 → анна → maria — and it
    // must not regress as later tiers evolve. Note `анна` carries 0 lines under
    // its synthesized id (sentences stay under anna1/anna2 until dedupAndPrepare),
    // yet the 2-token real name still wins because token-count is the primary key.
    const chars = [
      c({ id: 'anna1', name: 'Анна', gender: 'female', aliases: ['Мария Ивановна'] }),
      c({ id: 'anna2', name: 'Анна', gender: 'female' }),
      c({ id: 'maria', name: 'Мария Ивановна', gender: 'female', aliases: ['Анна'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('anna1', 5), ...sent('anna2', 3), ...sent('maria', 8)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('maria');
    expect(r.characters[0].name).toBe('Мария Ивановна');
    // Both Tier-1 victims AND the synthesized Tier-1 canonical resolve to the
    // final Tier-3 survivor — the cross-tier collapse leaves no dangling id.
    expect(r.rewrites).toEqual({ anna1: 'maria', anna2: 'maria', 'анна': 'maria' });
    expect(r.suggestions).toEqual([]);
  });

  it('picks the same survivor regardless of roster order (stable survivor)', () => {
    const mk = () => [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['Гесер', 'шеф'] }),
      c({ id: 'geser', name: 'Гесер', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    const lines = [...sent('boss', 100), ...sent('boris', 10), ...sent('geser', 5)];
    const fwd = dedupeRosterByName(mk() as any, lines);
    const rev = dedupeRosterByName([...mk()].reverse() as any, lines);
    expect(fwd.characters[0].id).toBe('boris');
    expect(rev.characters[0].id).toBe('boris');
  });

  it('does NOT merge a cross-gender pair even with a mutual link', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'female', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris')]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
  });

  it('pair-level gate: merges the same-gender pair, leaves the cross-gender member separate', () => {
    const chars = [
      c({ id: 'a', name: 'Алекс', gender: 'male', aliases: ['Боб'] }),
      c({ id: 'b', name: 'Боб', gender: 'male', aliases: ['Алекс', 'Мэри'] }),
      c({ id: 'm', name: 'Мэри', gender: 'female', aliases: ['Боб'] }),
    ];
    // a↔b (both male) is a mutual strong edge → merge. b↔m is gender-blocked, so
    // one bad cross-gender edge must NOT suppress the valid a↔b merge.
    const r = dedupeRosterByName(chars as any, [...sent('a', 5), ...sent('b', 40), ...sent('m', 5)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({ a: 'b' });
    expect(r.characters.map((ch) => ch.id).sort()).toEqual(['b', 'm']);
  });
});

describe('dedupeRosterByName Tier-3 (alias coreference — weak suggestions)', () => {
  it('suggests (does not merge) a one-sided bare-word link on exactly two rows', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 3), ...sent('boris', 30)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
    expect(r.suggestions).toEqual([
      { sourceId: 'boss', targetId: 'boris', reason: expect.any(String) },
    ]);
  });

  it('emits NO suggestion when the bare word is on three or more rows', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
      c({ id: 'ivan', name: 'Иван', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris'), ...sent('ivan')]);
    expect(r.suggestions).toEqual([]);
  });

  it('suggests a shared third-party alias on exactly two rows (neither name-linked)', () => {
    const chars = [
      c({ id: 'a', name: 'Анна', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'b', name: 'Мария', gender: 'female', aliases: ['Жница'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a', 10), ...sent('b', 4)]);
    expect(r.characters).toHaveLength(2);
    expect(r.suggestions).toEqual([
      { sourceId: 'b', targetId: 'a', reason: expect.stringContaining('Жница') },
    ]);
  });

  it('emits NO suggestion when a shared alias is on three or more rows', () => {
    const chars = [
      c({ id: 'a', name: 'Анна', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'b', name: 'Мария', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'd', name: 'Дарья', gender: 'female', aliases: ['Жница'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a'), ...sent('b'), ...sent('d')]);
    expect(r.suggestions).toEqual([]);
  });

  it('emits NO suggestion across a gender conflict', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'female' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris')]);
    expect(r.suggestions).toEqual([]);
  });
});
