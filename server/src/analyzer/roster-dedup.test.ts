import { describe, expect, it } from 'vitest';
import {
  dedupeRosterByName,
  composeRewrites,
  pruneSuggestionsToRoster,
} from './roster-dedup.js';
import type { DedupConstraints, PlannedRowInfo } from '../store/reanalysis-types.js';

const c = (over: { id: string; name: string; role?: string; color?: string; gender?: string; [key: string]: unknown }) =>
  ({ role: 'r', color: 'c', ...over });
const sent = (characterId: string, n = 1) => Array.from({ length: n }, () => ({ characterId }));

const newRow = (over: Partial<Extract<PlannedRowInfo, { kind: 'new' }>> = {}): PlannedRowInfo => ({
  kind: 'new',
  minted: false,
  candidates: [],
  inheritedDeclines: [],
  declinedIds: [],
  ...over,
});
const joined = (priorId: string): PlannedRowInfo => ({ kind: 'join', priorId });
const planned = (entries: Record<string, PlannedRowInfo>, currentBookId?: string): DedupConstraints => ({
  planned: new Map(Object.entries(entries)),
  currentBookId,
});
const none: DedupConstraints = { planned: new Map() };


describe('dedupeRosterByName Tier-1 (exact name)', () => {
  it('collapses olga + ольга to one entry; the survivor is the lowest member id, olga (was safeId(name) = ольга)', () => {
    const chars = [c({ id: 'olga', name: 'Ольга', gender: 'female' }), c({ id: 'ольга', name: 'Ольга', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [...sent('olga', 8), ...sent('ольга', 203)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('olga');
    expect(r.rewrites).toEqual({ 'ольга': 'olga' });
  });

  it('does NOT merge two same-name people of different gender', () => {
    const chars = [c({ id: 'ivan', name: 'Иван', gender: 'male' }), c({ id: 'ivan2', name: 'Иван', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [...sent('ivan'), ...sent('ivan2')], { constraints: none });
    expect(r.characters).toHaveLength(2);
  });

  it('never merges the narrator, even with a non-narrator group named "Narrator"', () => {
    const chars = [c({ id: 'narrator', name: 'Narrator', color: 'unset' }), c({ id: 'narrator-2', name: 'Narrator' })];
    const r = dedupeRosterByName(chars as any, [...sent('narrator'), ...sent('narrator-2')], { constraints: none });
    // narrator row untouched; the non-narrator "Narrator" group must NOT remap onto id 'narrator'
    expect(r.characters.find((x) => x.id === 'narrator')).toBeDefined();
    expect(Object.values(r.rewrites)).not.toContain('narrator');
  });
});

describe('dedupeRosterByName Tier-2a (full vs short)', () => {
  it('auto-merges Антон into Антон Городецкий: the full name is kept, short name aliased, survivor id = lowest member id (was: more lines wins)', () => {
    const chars = [c({ id: 'anton', name: 'Антон', gender: 'male' }), c({ id: 'anton-gorodetsky', name: 'Антон Городецкий', gender: 'male' })];
    const r = dedupeRosterByName(chars as any, [...sent('anton', 3), ...sent('anton-gorodetsky', 50)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('anton');
    expect(r.characters[0].name).toBe('Антон Городецкий');
    expect(r.characters[0].aliases).toContain('Антон');
    expect(r.rewrites).toEqual({ 'anton-gorodetsky': 'anton' });
  });

  it('Tier-2a: line counts never pick the survivor (the same either way round; was: tie → earlier roster entry)', () => {
    const chars = [c({ id: 'anton', name: 'Антон', gender: 'male' }), c({ id: 'anton-gorodetsky', name: 'Антон Городецкий', gender: 'male' })];
    const r = dedupeRosterByName(chars as any, [...sent('anton', 5), ...sent('anton-gorodetsky', 5)], { constraints: none });
    const skewed = dedupeRosterByName(chars as any, [...sent('anton', 1), ...sent('anton-gorodetsky', 90)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('anton');
    expect(r.rewrites).toEqual({ 'anton-gorodetsky': 'anton' });
    expect(skewed.rewrites).toEqual(r.rewrites);
  });

  it('does NOT merge when two longer names both contain the short name (ambiguous)', () => {
    const chars = [
      c({ id: 'anton', name: 'Антон', gender: 'male' }),
      c({ id: 'ag', name: 'Антон Городецкий', gender: 'male' }),
      c({ id: 'ai', name: 'Антон Иванов', gender: 'male' }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('anton'), ...sent('ag'), ...sent('ai')], { constraints: none });
    expect(r.characters).toHaveLength(3);
  });
});

describe('dedupeRosterByName Tier-2b (diminutive suggestions)', () => {
  it('emits a suggestion for Оля + Ольга without merging', () => {
    const chars = [c({ id: 'olya', name: 'Оля', gender: 'female' }), c({ id: 'ольга', name: 'Ольга', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [...sent('olya', 4), ...sent('ольга', 30)], { constraints: none });
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
    expect(r.suggestions).toEqual([
      { sourceId: 'olya', targetId: 'ольга', a: 'olya', b: 'ольга', reason: expect.any(String), origin: 'dedup' },
    ]);
  });

  it('does NOT suggest a multi-gender diminutive when genders are unset', () => {
    const chars = [c({ id: 's1', name: 'Саша' }), c({ id: 's2', name: 'Александр' })];
    const r = dedupeRosterByName(chars as any, [...sent('s1'), ...sent('s2')], { constraints: none });
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

describe('#2584/#2570 real-shape regression - a same-run fresh-side duplicate collides with an established ASCII id', () => {
  /* The analyzer detected THREE fresh candidate rows for "Одуван" in one run
     (oduvan, owdovan, одуван), and `oduvan` is also the established prior row's
     raw id. Since #4031 the survivor is the lowest member id, so the dedup
     itself lands on `oduvan` and never produces the old `{oduvan: 'одуван'}`
     shape that retired the established id. The cross-script and mixed-gender
     variants of the old strip cases (stripEstablishedAsciiRewrites, deleted by
     plan 291 Task 28) are covered at the matcher: the prior row joins by id or
     name and nothing is retired (match-fresh-to-prior.test.ts A1/A4, plan-overlay
     tests). */
  it('dedupeRosterByName collapses the triplet onto the lowest member id, oduvan (was: safeId(name) = одуван)', () => {
    const roster = [
      c({ id: 'oduvan', name: 'Одуван' }),
      c({ id: 'owdovan', name: 'Одуван' }),
      c({ id: 'одуван', name: 'Одуван' }),
    ];
    const dd = dedupeRosterByName(
      roster as any,
      [...sent('oduvan'), ...sent('owdovan'), ...sent('одуван')],
      { constraints: none },
    );
    expect(dd.rewrites).toEqual({ owdovan: 'oduvan', 'одуван': 'oduvan' });
  });
});

describe('N6 (PR #2640 pass-3 review) - a genuine Tier-3 alias merge still merges', () => {
  /* `шеф` (id `shef`, ASCII) and `Борис Игнатьевич` (id `борис-игнатьевич`) are
     MUTUAL aliases - a genuine cross-script identity merge. */
  const freshRoster = [
    c({ id: 'shef', name: 'Шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    c({ id: 'борис-игнатьевич', name: 'Борис Игнатьевич', gender: 'male', aliases: ['Шеф'] }),
  ];
  const freshSentences = [...sent('shef', 3), ...sent('борис-игнатьевич', 7)];

  it('dedupeRosterByName Tier-3 merges the pair onto the lowest member id (was: the id of the real-name row)', () => {
    const dd = dedupeRosterByName(freshRoster as any, freshSentences, { constraints: none });
    expect(dd.characters).toHaveLength(1);
    expect(dd.characters[0].id).toBe('shef');
    expect(dd.characters[0].name).toBe('Борис Игнатьевич'); // the real name still supplies the row
    expect(dd.rewrites).toEqual({ 'борис-игнатьевич': 'shef' });
  });
});

describe('#2584/#2570 round-5 regression - a Tier-3 merge inside a Tier-1-skipped mixed-gender group', () => {
  /* Three fresh rows literally named "Одуван Петров", genders male/male/female:
     Tier-1's `genders.size > 1` gate bails on the WHOLE group, but Tier-3's
     gender gate is PER EDGE - the two MALE rows still carry a mutual alias
     link and merge. */
  const freshRoster = [
    c({ id: 'oduvan', name: 'Одуван Петров', gender: 'male', aliases: ['Одуван Петров'] }),
    c({ id: 'одуван-петров', name: 'Одуван Петров', gender: 'male', aliases: ['Одуван Петров'] }),
    c({ id: 'odyuvan-petrova-f', name: 'Одуван Петров', gender: 'female' }),
  ];
  const freshSentences = [
    ...sent('oduvan', 2),
    ...sent('одуван-петров', 9),
    ...sent('odyuvan-petrova-f', 1),
  ];

  it('Tier-1 bails on the whole mixed-gender group, but Tier-3 still merges the two male rows', () => {
    const dd = dedupeRosterByName(freshRoster as any, freshSentences, { constraints: none });
    expect(dd.rewrites).toEqual({ 'одуван-петров': 'oduvan' }); // lowest member id (was: the Cyrillic id)
    expect(dd.characters.map((ch) => ch.id).sort()).toEqual(['oduvan', 'odyuvan-petrova-f']);
  });
});

describe('dedupeRosterByName Tier-3 (alias coreference — strong merge)', () => {
  it('collapses шеф ↔ Борис Игнатьевич ↔ Гесер (mutual links) to one row, real name survives', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['Гесер', 'шеф'] }),
      c({ id: 'geser', name: 'Гесер', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    // шеф has the MOST lines, yet lines play no part: the multi-token real name supplies the row, and boris (< boss) is the surviving id.
    const r = dedupeRosterByName(chars as any, [...sent('boss', 100), ...sent('boris', 10), ...sent('geser', 5)], { constraints: none });
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
    const r = dedupeRosterByName(chars as any, [...sent('boss', 80), ...sent('boris', 2)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
  });

  it('auto-merges a one-sided MULTI-token name link (directional)', () => {
    const chars = [
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male' }), // no aliases
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boris', 5), ...sent('boss', 5)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
    expect(r.rewrites).toEqual({ boss: 'boris' });
  });

  it('does NOT auto-merge a one-sided SINGLE-token (bare-word) link', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }), // no alias back
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 3), ...sent('boris', 30)], { constraints: none });
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
  });

  it('auto-merges a MUTUAL single-token link (tokens tie → earlier row supplies the fields, lowest id survives; lines play no part)', () => {
    const chars = [
      c({ id: 'rex', name: 'Рекс', gender: 'male', aliases: ['Пёс'] }),
      c({ id: 'pyos', name: 'Пёс', gender: 'male', aliases: ['Рекс'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('rex', 20), ...sent('pyos', 3)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('pyos');
    expect(r.characters[0].name).toBe('Рекс');
    expect(r.rewrites).toEqual({ rex: 'pyos' });
  });

  it('collapses a component linked only transitively (A↔B, B↔C, no direct A↔C)', () => {
    const chars = [
      c({ id: 'a', name: 'Алекс', gender: 'male', aliases: ['Боб'] }),
      c({ id: 'b', name: 'Боб', gender: 'male', aliases: ['Алекс', 'Карл'] }),
      c({ id: 'k', name: 'Карл', gender: 'male', aliases: ['Боб'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a', 5), ...sent('b', 40), ...sent('k', 5)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('a');
    expect(r.rewrites).toEqual({ b: 'a', k: 'a' });
  });

  it('does NOT merge a component where an unknown-gender node bridges a male and a female', () => {
    // Fail-open guard: the per-edge gender gate lets an UNKNOWN-gender node link
    // to both a male and a female (unknown conflicts with neither). Union-find is
    // transitive, so male—unknown—female all co-land in one component even though
    // no male↔female edge was ever allowed. Without the component-consistency
    // check this collapsed «Галина» (female) into «Максим» (male) — the exact
    // Night Watch over-merge. The whole contradictory component must be refused.
    const chars = [
      c({ id: 'max', name: 'Максим', gender: 'male', aliases: ['Мост'] }),
      c({ id: 'bridge', name: 'Мост', aliases: ['Максим', 'Галина'] }), // gender unset
      c({ id: 'galina', name: 'Галина', gender: 'female', aliases: ['Мост'] }),
    ];
    const r = dedupeRosterByName(chars as any, [
      ...sent('max', 10),
      ...sent('bridge', 5),
      ...sent('galina', 8),
    ], { constraints: none });
    // No auto-merge: all three rows survive, male and female stay distinct.
    expect(r.characters).toHaveLength(3);
    const names = r.characters.map((ch) => ch.name).sort();
    expect(names).toEqual(['Галина', 'Максим', 'Мост']);
    expect(r.rewrites).toEqual({});
  });

  it('does NOT merge a male and a neutral bridged by an unknown-gender node', () => {
    // The guard mirrors the per-edge conflict semantics: male/female/neutral are
    // all mutually distinct. An UNKNOWN node bridging a male and a neutral forms
    // a component (unknown conflicts with neither), and male+neutral is just as
    // contradictory as male+female — so it must be refused too, not only the
    // narrow male+female case. (A directly-gendered bridge wouldn't form edges at
    // all; the unknown bridge is what lets the mismatched pair co-land.)
    const chars = [
      c({ id: 'max', name: 'Максим', gender: 'male', aliases: ['Мост'] }),
      c({ id: 'bridge', name: 'Мост', aliases: ['Максим', 'Дух'] }), // gender unset
      c({ id: 'dukh', name: 'Дух', gender: 'neutral', aliases: ['Мост'] }),
    ];
    const r = dedupeRosterByName(chars as any, [
      ...sent('max', 10),
      ...sent('bridge', 5),
      ...sent('dukh', 8),
    ], { constraints: none });
    expect(r.characters).toHaveLength(3);
    expect(r.rewrites).toEqual({});
  });

  it('collapses a Tier-1 survivor that then becomes a Tier-3 victim (cross-tier rewrite chain)', () => {
    // Two «Анна» rows → Tier-1 merges anna2 into anna1 (the lowest member id).
    // That anna1 node then forms a mutual Tier-3 edge with the 2-token «Мария
    // Ивановна» (id alma, which sorts lower still) → anna1 becomes a Tier-3
    // victim. The transitive collapse must resolve the FULL chain
    // anna2 → anna1 → alma. The 2-token real name supplies the surviving
    // fields (token-count is the field-base key); the id is the lowest member id.
    const chars = [
      c({ id: 'anna1', name: 'Анна', gender: 'female', aliases: ['Мария Ивановна'] }),
      c({ id: 'anna2', name: 'Анна', gender: 'female' }),
      c({ id: 'alma', name: 'Мария Ивановна', gender: 'female', aliases: ['Анна'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('anna1', 5), ...sent('anna2', 3), ...sent('alma', 8)], { constraints: none });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('alma');
    expect(r.characters[0].name).toBe('Мария Ивановна');
    // Both the Tier-1 victim AND the Tier-1 survivor resolve to the final
    // Tier-3 survivor — the cross-tier collapse leaves no dangling id.
    expect(r.rewrites).toEqual({ anna1: 'alma', anna2: 'alma' });
    expect(r.suggestions).toEqual([]);
  });

  it('picks the same survivor regardless of roster order (stable survivor)', () => {
    const mk = () => [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['Гесер', 'шеф'] }),
      c({ id: 'geser', name: 'Гесер', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    const lines = [...sent('boss', 100), ...sent('boris', 10), ...sent('geser', 5)];
    const fwd = dedupeRosterByName(mk() as any, lines, { constraints: none });
    const rev = dedupeRosterByName([...mk()].reverse() as any, lines, { constraints: none });
    expect(fwd.characters[0].id).toBe('boris');
    expect(rev.characters[0].id).toBe('boris');
  });

  it('does NOT merge a cross-gender pair even with a mutual link', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'female', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris')], { constraints: none });
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
    const r = dedupeRosterByName(chars as any, [...sent('a', 5), ...sent('b', 40), ...sent('m', 5)], { constraints: none });
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({ b: 'a' });
    expect(r.characters.map((ch) => ch.id).sort()).toEqual(['a', 'm']);
  });
});

describe('dedupeRosterByName — first-person pronoun phantom (RC1)', () => {
  it('force-merges a bare «Я» character into the char that lists «Я» as an alias', () => {
    const chars = [
      c({ id: 'антон', name: 'Антон', gender: 'male', aliases: ['Антон Городецкий', 'Я'] }),
      c({ id: 'я', name: 'Я', gender: 'male', aliases: [] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('антон', 196), ...sent('я', 7)], { language: 'ru', constraints: none });
    expect(r.characters.map((x) => x.id)).toEqual(['антон']); // phantom gone, Антон survives (lowest non-phantom id)
    expect(r.rewrites['я']).toBe('антон');
  });

  it('routes a bare «Я» to the narrator when NO character claims it as an alias (fallback)', () => {
    const chars = [
      c({ id: 'антон', name: 'Антон', gender: 'male', aliases: [] }),
      c({ id: 'я', name: 'Я', gender: 'male', aliases: [] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('антон', 196), ...sent('я', 7)], { language: 'ru', constraints: none });
    // A bare pronoun is NEVER a real character: with no alias-holder to absorb
    // it, it routes to the narrator (first-person-with-no-owner = narrator voice).
    expect(r.characters.map((x) => x.id)).toEqual(['антон']);
    expect(r.rewrites['я']).toBe('narrator');
  });

  it('a phantom «Я» with MORE lines than the real protagonist does NOT dissolve the protagonist into narrator', () => {
    const chars = [
      c({ id: 'антон', name: 'Антон', gender: 'male', aliases: ['Я'] }),
      c({ id: 'я', name: 'Я', gender: 'male', aliases: [] }),
    ];
    // phantom has FAR more lines than антон — lines must still never make the phantom win.
    const r = dedupeRosterByName(chars as any, [...sent('антон', 20), ...sent('я', 300)], { language: 'ru', constraints: none });
    expect(r.characters.map((x) => x.id)).toEqual(['антон']); // real protagonist survives, keeps id антон
    expect(r.rewrites['я']).toBe('антон');                    // phantom merged INTO антон
    expect(Object.values(r.rewrites)).not.toContain('narrator'); // антон NOT dissolved to narrator
  });
});

describe('dedupeRosterByName Tier-3 (alias coreference — weak suggestions)', () => {
  it('suggests (does not merge) a one-sided bare-word link on exactly two rows', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 3), ...sent('boris', 30)], { constraints: none });
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
    expect(r.suggestions).toEqual([
      { sourceId: 'boss', targetId: 'boris', a: 'boris', b: 'boss', reason: expect.any(String), origin: 'dedup' },
    ]);
  });

  it('emits NO suggestion when the bare word is on three or more rows', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
      c({ id: 'ivan', name: 'Иван', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris'), ...sent('ivan')], { constraints: none });
    expect(r.suggestions).toEqual([]);
  });

  it('suggests a shared third-party alias on exactly two rows (neither name-linked)', () => {
    const chars = [
      c({ id: 'a', name: 'Анна', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'b', name: 'Мария', gender: 'female', aliases: ['Жница'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a', 10), ...sent('b', 4)], { constraints: none });
    expect(r.characters).toHaveLength(2);
    expect(r.suggestions).toEqual([
      { sourceId: 'b', targetId: 'a', a: 'a', b: 'b', reason: expect.stringContaining('Жница'), origin: 'dedup' },
    ]);
  });

  it('emits NO suggestion when a shared alias is on three or more rows', () => {
    const chars = [
      c({ id: 'a', name: 'Анна', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'b', name: 'Мария', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'd', name: 'Дарья', gender: 'female', aliases: ['Жница'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a'), ...sent('b'), ...sent('d')], { constraints: none });
    expect(r.suggestions).toEqual([]);
  });

  it('emits NO suggestion across a gender conflict', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'female' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris')], { constraints: none });
    expect(r.suggestions).toEqual([]);
  });
});

// ── #4031 Task 5 — plan-constrained dedup ───────────────────────────────────

describe('dedupeRosterByName — survivor and groups (#4031)', () => {
  it('the survivor is a member id, never safeId(name)', () => {
    const chars = [c({ id: 'x1', name: 'Анна', gender: 'female' }), c({ id: 'x2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], { constraints: none });
    expect(r.characters.map((x) => x.id)).toEqual(['x1']);
    expect(r.rewrites).toEqual({ x2: 'x1' });
  });

  it('R24: the lowest raw id is numeric-aware (wren-9 beats wren-10)', () => {
    const chars = [c({ id: 'wren-10', name: 'Wren' }), c({ id: 'wren-9', name: 'Wren' })];
    const r = dedupeRosterByName(chars as any, [], { constraints: none });
    expect(r.characters.map((x) => x.id)).toEqual(['wren-9']);
    expect(r.rewrites).toEqual({ 'wren-10': 'wren-9' });
  });

  it('a joined row whose raw id is the prior id is the survivor, even when another member sorts lower', () => {
    const chars = [c({ id: 'a-fresh', name: 'Анна' }), c({ id: 'prior-1', name: 'Анна' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ 'a-fresh': joined('prior-1'), 'prior-1': joined('prior-1') }),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['prior-1']);
    expect(r.rewrites).toEqual({ 'a-fresh': 'prior-1' });
  });

  it('a minted new row is the survivor over a lower unminted one', () => {
    const chars = [c({ id: 'wren', name: 'Wren' }), c({ id: 'wren-n1', name: 'Wren' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ wren: newRow(), 'wren-n1': newRow({ minted: true }) }),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['wren-n1']);
    expect(r.rewrites).toEqual({ wren: 'wren-n1' });
  });

  it('A25c: the prompt call and the post-stage-2 call give the same groups', () => {
    const mk = () => [
      c({ id: 'anna2', name: 'Анна', gender: 'female', aliases: ['Мария Ивановна'] }),
      c({ id: 'anna1', name: 'Анна', gender: 'female' }),
      c({ id: 'maria', name: 'Мария Ивановна', gender: 'female', aliases: ['Анна'] }),
      c({ id: 'anton', name: 'Антон', gender: 'male' }),
      c({ id: 'anton-gorodetsky', name: 'Антон Городецкий', gender: 'male' }),
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Рекс'] }),
      c({ id: 'rex', name: 'Рекс', gender: 'male', aliases: ['шеф'] }),
    ];
    // The prompt call has no sentences; the post-stage-2 call has them, skewed
    // so any line-count tiebreak would pick a different survivor.
    const lines = [
      ...sent('anna1', 1), ...sent('anna2', 9), ...sent('maria', 2), ...sent('anton', 3),
      ...sent('anton-gorodetsky', 50), ...sent('boss', 100), ...sent('rex', 1),
    ];
    for (const constraints of [none, planned({ anna1: newRow(), anna2: newRow() })]) {
      const prompt = dedupeRosterByName(mk() as any, [], { constraints });
      const post = dedupeRosterByName(mk() as any, lines, { constraints });
      expect(post.rewrites).toEqual(prompt.rewrites);
      expect(post.characters.map((x) => x.id)).toEqual(prompt.characters.map((x) => x.id));
    }
  });

  it("under empty constraints, groups and suggestions match today's except the survivor id", () => {
    const chars = [
      c({ id: 'olya', name: 'Оля', gender: 'female' }),
      c({ id: 'ольга', name: 'Ольга', gender: 'female' }),
      c({ id: 'boss', name: 'шеф', gender: 'male' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
      c({ id: 'p1', name: 'Пётр', gender: 'male' }),
      c({ id: 'p2', name: 'Пётр', gender: 'male' }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('olya', 4), ...sent('ольга', 30)], { constraints: none });
    // Groups: only the Пётр pair merges (survivor now the lowest member id).
    expect(r.rewrites).toEqual({ p2: 'p1' });
    expect(r.characters.map((x) => x.id)).toEqual(['olya', 'ольга', 'boss', 'boris', 'p1']);
    // Suggestions keep today's pairs and direction, in the durable shape.
    expect(r.suggestions).toEqual([
      { sourceId: 'boris', targetId: 'boss', a: 'boris', b: 'boss', reason: expect.any(String), origin: 'dedup' },
      { sourceId: 'olya', targetId: 'ольга', a: 'olya', b: 'ольга', reason: expect.any(String), origin: 'dedup' },
    ]);
    expect(r.refused).toEqual([]);
    expect(r.mergedNew.map((g) => g.survivor)).toEqual(['p1']);
  });
});

describe('dedupeRosterByName — merge refusals (#4031)', () => {
  it('rows joined to different prior rows never merge', () => {
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ a1: joined('p1'), a2: joined('p2') }),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(r.rewrites).toEqual({});
    expect(r.refused).toEqual([{ a: 'a1', b: 'a2', why: 'different-prior' }]);
    expect(r.suggestions).toEqual([expect.objectContaining({ a: 'a1', b: 'a2', origin: 'dedup' })]);
  });

  it('rows joined to the same prior row merge', () => {
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ a1: joined('p1'), a2: joined('p1') }),
    });
    expect(r.characters).toHaveLength(1);
    expect(r.refused).toEqual([]);
  });

  it('a joined row and a new row never merge; the pair becomes a suggestion', () => {
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ a1: joined('p1'), a2: newRow() }),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(r.refused).toEqual([{ a: 'a1', b: 'a2', why: 'join-vs-new' }]);
    expect(r.suggestions).toEqual([
      { sourceId: expect.any(String), targetId: expect.any(String), a: 'a1', b: 'a2', reason: expect.any(String), origin: 'dedup' },
    ]);
  });

  it('two new rows with conflicting matchedFrom stay separate', () => {
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({
        a1: newRow({ matchedFrom: { bookId: 'b1', characterId: 'x' } }),
        a2: newRow({ matchedFrom: { bookId: 'b2', characterId: 'y' } }),
      }),
    });
    expect(r.characters).toHaveLength(2);
    expect(r.refused).toEqual([{ a: 'a1', b: 'a2', why: 'matched-from-conflict' }]);
  });

  it('T5: a neither-joined refused pair is oriented by line count, whatever the caller order (ruling :63)', () => {
    const a1 = c({ id: 'a1', name: 'Анна', gender: 'female' });
    const a2 = c({ id: 'a2', name: 'Анна', gender: 'female' });
    // a2 speaks more: it is the target, a1 the source, in either roster order.
    const sentences = [{ characterId: 'a1' }, { characterId: 'a2' }, { characterId: 'a2' }, { characterId: 'a2' }];
    const constraints = planned({
      a1: newRow({ matchedFrom: { bookId: 'b1', characterId: 'x' } }),
      a2: newRow({ matchedFrom: { bookId: 'b2', characterId: 'y' } }),
    });
    for (const order of [[a1, a2], [a2, a1]]) {
      const r = dedupeRosterByName(order as any, sentences as any, { constraints });
      expect(r.suggestions.map((s) => [s.sourceId, s.targetId])).toEqual([['a1', 'a2']]);
    }
  });

  it('two new rows with the SAME matchedFrom still merge', () => {
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const mf = { bookId: 'b1', characterId: 'x' };
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ a1: newRow({ matchedFrom: mf }), a2: newRow({ matchedFrom: { ...mf } }) }),
    });
    expect(r.characters).toHaveLength(1);
  });

  it('item 1: two new rows whose candidates hold a notSamePerson record stay separate', () => {
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({
        a1: newRow({ candidates: ['p1'], declinedIds: ['p2'] }),
        a2: newRow({ candidates: ['p2'] }),
      }),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(r.refused).toEqual([{ a: 'a1', b: 'a2', why: 'declined' }]);
    expect(r.mergedNew).toEqual([]);
  });
});

describe('dedupeRosterByName — new+new merges (#4031)', () => {
  it('item 18: a new+new merge unions inherited declines onto the survivor and reports mergedNew', () => {
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned(
        {
          a1: newRow({ candidates: ['p1'], inheritedDeclines: [{ bookId: 'other', characterId: 'c1' }, 'same-book-legacy'] }),
          a2: newRow({
            candidates: ['p2'],
            declinedIds: ['p9'],
            inheritedDeclines: [{ bookId: 'other', characterId: 'c2' }, { bookId: 'cur', characterId: 'c3' }],
          }),
        },
        'cur',
      ),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['a1']);
    expect(r.mergedNew).toEqual([
      {
        survivor: 'a1',
        merged: ['a2'],
        candidates: ['p1', 'p2'],
        declinedIds: ['p9'],
        // cross-book entries only: the legacy string and the current-book entry are stripped
        inheritedDeclines: [{ bookId: 'other', characterId: 'c1' }, { bookId: 'other', characterId: 'c2' }],
      },
    ]);
  });
});

describe('dedupeRosterByName — fix round 1 (#4031)', () => {
  it('a refused bridge row does not chain its two neighbours into one character', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male' }),
      c({ id: 'geser', name: 'Гесер', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ boris: joined('p-boris'), boss: newRow(), geser: newRow() }),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['boss', 'boris', 'geser']);
    expect(r.rewrites).toEqual({});
  });

  it.each([
    ['joined row first', ['a1', 'a2']],
    ['joined row last', ['a2', 'a1']],
  ])('a join-vs-new suggestion points the new row at the established one (%s)', (_label, order) => {
    const rows = order.map((id) => c({ id, name: 'Анна', gender: 'female' }));
    const r = dedupeRosterByName(rows as any, [], {
      constraints: planned({ a1: joined('p1'), a2: newRow() }),
    });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ sourceId: 'a2', targetId: 'a1', a: 'a1', b: 'a2' });
  });

  it('narrator-named non-narrator rows stay separate, as before', () => {
    const chars = [
      c({ id: 'narrator', name: 'Narrator' }),
      c({ id: 'narrator-2', name: 'Narrator' }),
      c({ id: 'narrator-3', name: 'Narrator' }),
    ];
    const r = dedupeRosterByName(chars as any, [], { constraints: none });
    expect(r.characters.map((x) => x.id)).toEqual(['narrator', 'narrator-2', 'narrator-3']);
    expect(r.rewrites).toEqual({});
  });

  it.each([
    ['decline on the first row', 'a1', 'a2'],
    ['decline on the second row', 'a2', 'a1'],
  ])('a cross-book decline against the other row\'s matchedFrom link refuses the merge (%s)', (_label, decliner, linker) => {
    const mf = { bookId: 'b1', characterId: 'x' };
    const chars = [c({ id: 'a1', name: 'Анна', gender: 'female' }), c({ id: 'a2', name: 'Анна', gender: 'female' })];
    const r = dedupeRosterByName(chars as any, [], {
      constraints: planned({ [decliner]: newRow({ inheritedDeclines: [mf] }), [linker]: newRow({ matchedFrom: mf }) }, 'cur'),
    });
    expect(r.characters.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(r.refused).toEqual([{ a: 'a1', b: 'a2', why: 'declined' }]);
  });

  it('a first-person phantom never takes the survivor id, even when its id sorts lowest', () => {
    const chars = [
      c({ id: 'антон', name: 'Антон', gender: 'male', aliases: ['Я'] }),
      c({ id: 'ya', name: 'Я', gender: 'male' }),
    ];
    const r = dedupeRosterByName(chars as any, [], { language: 'ru', constraints: none });
    expect(r.characters.map((x) => x.id)).toEqual(['антон']);
    expect(r.rewrites).toEqual({ ya: 'антон' });
  });
});

describe('dedupeRosterByName — every suggestion targets the established row (#4031 fix round 2)', () => {
  it.each([
    ['joined row first', ['j', 'n']],
    ['joined row last', ['n', 'j']],
  ])('a weak alias suggestion points the new row at the joined one, whatever the lines (%s)', (_l, order) => {
    const rows: Record<string, any> = {
      j: c({ id: 'j', name: 'Анна', gender: 'female' }),
      n: c({ id: 'n', name: 'Мария', gender: 'female', aliases: ['Анна'] }),
    };
    const r = dedupeRosterByName(order.map((id) => rows[id]) as any, [...sent('n', 5)], {
      constraints: planned({ j: joined('p1'), n: newRow() }),
    });
    expect(r.characters).toHaveLength(2);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ sourceId: 'n', targetId: 'j' });
  });

  it.each([
    ['joined row first', ['olya', 'ольга']],
    ['joined row last', ['ольга', 'olya']],
  ])('a diminutive suggestion points the new row at the joined one, whatever the lines (%s)', (_l, order) => {
    const rows: Record<string, any> = {
      olya: c({ id: 'olya', name: 'Оля', gender: 'female' }),
      'ольга': c({ id: 'ольга', name: 'Ольга', gender: 'female' }),
    };
    const r = dedupeRosterByName(order.map((id) => rows[id]) as any, [...sent('ольга', 30)], {
      constraints: planned({ olya: joined('p1'), 'ольга': newRow() }),
    });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ sourceId: 'ольга', targetId: 'olya' });
  });
});
