import { describe, it, expect } from 'vitest';
import { matchFreshToPrior, extendPlan, buildReservedIds, mintId } from './match-fresh-to-prior.js';
import type {
  FreshRow,
  MatchDecision,
  MatchHistory,
  MatchInput,
  MatchPlan,
  PriorRow,
  StoredSuggestion,
} from './reanalysis-types.js';

const OK: MatchHistory = {
  status: 'ok',
  supersededBy: {},
  supersededByKind: {},
  displaced: {},
  notSamePerson: [],
};
const hist = (h: Partial<MatchHistory> = {}): MatchHistory => ({ ...OK, ...h });
const p = (id: string, name: string, extra: Record<string, unknown> = {}): PriorRow => ({ id, name, ...extra });
const f = (id: string, name: string, aliases?: string[]): FreshRow => ({ id, name, ...(aliases ? { aliases } : {}) });

function plan(
  fresh: FreshRow[],
  prior: PriorRow[],
  o: {
    history?: MatchHistory;
    openSuggestions?: StoredSuggestion[];
    runToken?: string;
    currentBookId?: string;
    reserved?: string[];
  } = {},
): MatchPlan {
  const history = o.history ?? OK;
  const reservedIds = buildReservedIds({ prior, history });
  for (const r of fresh) reservedIds.add(r.id); // R6: the caller reserves every raw id of the run
  for (const r of o.reserved ?? []) reservedIds.add(r);
  const input: MatchInput = {
    fresh,
    prior,
    history,
    openSuggestions: o.openSuggestions ?? [],
    reservedIds,
    runToken: o.runToken ?? 'tok1',
    currentBookId: o.currentBookId ?? 'book-1',
  };
  return matchFreshToPrior(input);
}

const join = (d: MatchDecision | undefined) => {
  expect(d?.kind).toBe('join');
  return d as Extract<MatchDecision, { kind: 'join' }>;
};
const fresh_ = (d: MatchDecision | undefined) => {
  expect(d?.kind).toBe('new');
  return d as Extract<MatchDecision, { kind: 'new' }>;
};

describe('matchFreshToPrior', () => {
  it('A1: a single surname-tolerant candidate joins and keeps the prior id', () => {
    const pl = plan([f('brann-weir', 'Brann Weir')], [p('brann', 'Brann', { voiceId: 'v1' })]);
    const d = join(pl.decisions['brann-weir']);
    expect(d.priorId).toBe('brann');
    expect(d.tier).toBe('surname');
  });

  describe('A2: each #4033 twin roster keeps both twins', () => {
    const twins = [p('wren-a', 'Wren', { notLinkedTo: ['wren-b'] }), p('wren-b', 'Wren', { notLinkedTo: ['wren-a'] })];
    const rosters: Array<[string, string]> = [
      ['wren-a', 'wren-9'],
      ['wren-9', 'wren-a'],
      ['wren-a', 'wren-b'],
    ];
    for (const [x, y] of rosters) {
      it(`${x} + ${y}`, () => {
        const pl = plan([f(x, 'Wren'), f(y, 'Wren')], twins);
        for (const raw of [x, y]) {
          const d = pl.decisions[raw];
          if (raw === 'wren-a' || raw === 'wren-b') expect(join(d).priorId).toBe(raw);
          else {
            const n = fresh_(d);
            expect(n.suggest).toEqual(['wren-a', 'wren-b']);
            expect(n.id).toBe(raw);
          }
        }
      });
    }
    it('wren-2 + wren-7', () => {
      const pl = plan(
        [f('wren-2', 'Wren'), f('wren-7', 'Wren')],
        [p('wren-2', 'Wren', { notLinkedTo: ['wren-7'] }), p('wren-7', 'Wren', { notLinkedTo: ['wren-2'] })],
      );
      expect(join(pl.decisions['wren-2']).priorId).toBe('wren-2');
      expect(join(pl.decisions['wren-7']).priorId).toBe('wren-7');
    });
    it('wren + wren-2', () => {
      const pl = plan(
        [f('wren', 'Wren'), f('wren-2', 'Wren')],
        [p('wren', 'Wren', { notLinkedTo: ['wren-2'] }), p('wren-2', 'Wren', { notLinkedTo: ['wren'] })],
      );
      expect(join(pl.decisions['wren']).priorId).toBe('wren');
      expect(join(pl.decisions['wren-2']).priorId).toBe('wren-2');
    });
  });

  it('A4/N2: a merged-away id and a same-name row both join the survivor', () => {
    const pl = plan(
      [f('brann-weir', 'Brann Weir'), f('ow2', 'Old Weir')],
      [p('old-weir', 'Old Weir')],
      { history: hist({ supersededBy: { 'brann-weir': 'old-weir' }, supersededByKind: { 'brann-weir': 'user' } }) },
    );
    expect(join(pl.decisions['brann-weir'])).toMatchObject({ priorId: 'old-weir', tier: 'history' });
    expect(join(pl.decisions['ow2'])).toMatchObject({ priorId: 'old-weir', tier: 'name' });
    expect(Object.values(pl.decisions).every((d) => d.kind === 'join')).toBe(true);
  });

  it('A5/P4-2: John Smith joins js; John becomes new with suggestions to js and jd', () => {
    const pl = plan(
      [f('x1', 'John Smith'), f('x2', 'John')],
      [p('js', 'John Smith'), p('jd', 'John Doe')],
    );
    expect(join(pl.decisions['x1']).priorId).toBe('js');
    expect(fresh_(pl.decisions['x2']).suggest).toEqual(['jd', 'js']);
  });

  it('A6: one voiced and one unvoiced T3 candidate give a suggestion', () => {
    const pl = plan(
      [f('x', 'Anna')],
      [p('a1', 'Anna Kay', { voiceId: 'v' }), p('a2', 'Anna Lee')],
    );
    expect(fresh_(pl.decisions['x']).suggest).toEqual(['a1', 'a2']);
  });

  it("A7: a new row inherits its candidates' cross-book declines only", () => {
    const pl = plan(
      [f('x', 'Anna')],
      [
        p('a1', 'Anna Kay', { notLinkedTo: [{ bookId: 'book-0', characterId: 'z1' }, { bookId: 'book-1', characterId: 'a2' }] }),
        p('a2', 'Anna Lee', { notLinkedTo: [{ bookId: 'book-0', characterId: 'z2' }, 'a1', { characterId: 'a1' }] }),
      ],
    );
    expect(fresh_(pl.decisions['x']).inheritedDeclines).toEqual([
      { bookId: 'book-0', characterId: 'z1' },
      { bookId: 'book-0', characterId: 'z2' },
    ]);
  });

  it('A10: rule 3 holds, a merged-away id joins its survivor even when its name matches another row (no displaced)', () => {
    const pl = plan(
      [f('gone', 'Mira')],
      [p('keep', 'Keeper'), p('mira', 'Mira')],
      { history: hist({ supersededBy: { gone: 'keep' } }) }, // untagged entry reads as user
    );
    expect(join(pl.decisions['gone'])).toMatchObject({ priorId: 'keep', tier: 'history' });
  });

  it('A15: a forced-new row mints an id that is no live, superseded, displaced or raw id', () => {
    const pl = plan(
      [f('wren', 'Wren'), f('wren-n1', 'Other'), f('wren-n2', 'Another')],
      [p('wren', 'Wren Ash'), p('wren-2', 'Wren')],
      { history: hist({ supersededBy: { 'wren-n3': 'wren-2' }, displaced: { 'wren-n4': 'wren-2' } }) },
    );
    const n = fresh_(pl.decisions['wren']);
    expect(n.minted).toBe(true);
    expect(n.suggest).toEqual(['wren', 'wren-2']);
    expect(['wren', 'wren-2', 'wren-n1', 'wren-n2', 'wren-n3', 'wren-n4']).not.toContain(n.id);
    expect(n.id).toBe('wren-n5');
  });

  it('A18: a fresh narrator joins the prior narrator-id row by role', () => {
    const pl = plan([f('narrator', 'Narrator')], [p('char-narrator', 'Narrator')]);
    expect(join(pl.decisions['narrator'])).toMatchObject({ priorId: 'char-narrator', tier: 'narrator' });
  });

  it('A18b: with two prior narrator-id rows the fresh narrator joins the one with the same id', () => {
    const pl = plan([f('narrator', 'Narrator')], [p('char-narrator', 'Narrator'), p('narrator', 'Narrator')]);
    expect(join(pl.decisions['narrator']).priorId).toBe('narrator');
  });

  describe('A21: provenance', () => {
    const prior = [p('survivor', 'Old Name'), p('other', 'Zed')];
    it('an untagged and a user entry are T1', () => {
      const pl = plan(
        [f('u1', 'Zed'), f('u2', 'Zed')],
        prior,
        { history: hist({ supersededBy: { u1: 'survivor', u2: 'survivor' }, supersededByKind: { u2: 'user' } }) },
      );
      expect(join(pl.decisions['u1']).priorId).toBe('survivor');
      expect(join(pl.decisions['u2']).priorId).toBe('survivor');
    });
    it('a heal entry is T1', () => {
      const pl = plan(
        [f('h', 'Zed')],
        prior,
        { history: hist({ supersededBy: { h: 'survivor' }, supersededByKind: { h: 'heal' } }) },
      );
      expect(join(pl.decisions['h']).priorId).toBe('survivor');
    });
    it('an analyzer entry is not T1: the name decides', () => {
      const pl = plan(
        [f('a', 'Zed')],
        prior,
        { history: hist({ supersededBy: { a: 'survivor' }, supersededByKind: { a: 'analyzer' } }) },
      );
      expect(join(pl.decisions['a'])).toMatchObject({ priorId: 'other', tier: 'name' });
    });
  });

  it('A3: degraded history mints <raw>-r<runToken>', () => {
    const pl = plan(
      [f('fresh-one', 'Nobody Known'), f('fresh-two', 'Anna')],
      [p('a1', 'Anna Kay'), p('a2', 'Anna Lee')],
      { history: hist({ status: 'degraded' }), runToken: 'abc' },
    );
    expect(fresh_(pl.decisions['fresh-one'])).toMatchObject({ id: 'fresh-one-rabc', minted: true });
    expect(fresh_(pl.decisions['fresh-two'])).toMatchObject({ id: 'fresh-two-rabc', minted: true });
  });

  it('A3: degraded history still joins by live id and name, but never by supersededBy', () => {
    const pl = plan(
      [f('a1', 'Anna Kay'), f('gone', 'Zed'), f('z', 'Zed')],
      [p('a1', 'Anna Kay'), p('zed', 'Zed')],
      { history: hist({ status: 'degraded', supersededBy: { gone: 'a1' } }) },
    );
    expect(join(pl.decisions['a1']).tier).toBe('id');
    expect(join(pl.decisions['gone'])).toMatchObject({ priorId: 'zed', tier: 'name' });
  });

  describe('A25a: total and deterministic', () => {
    const twins = [p('wren-a', 'Wren', { notLinkedTo: ['wren-b'] }), p('wren-b', 'Wren', { notLinkedTo: ['wren-a'] })];
    const merged = hist({ supersededBy: { 'brann-weir': 'old-weir' }, supersededByKind: { 'brann-weir': 'user' } });
    const fixtures: Array<[string, FreshRow[], PriorRow[], MatchHistory]> = [
      ['empty', [], [], OK],
      ['first analysis', [f('a', 'Anna'), f('b', 'Anna'), f('c', 'Cora')], [], hist({ status: 'absent' })],
      ['twins + wren-9', [f('wren-9', 'Wren'), f('wren-a', 'Wren')], twins, OK],
      ['twins + wren-b', [f('wren-a', 'Wren'), f('wren-b', 'Wren')], twins, OK],
      ['wren + wren-2', [f('wren', 'Wren'), f('wren-2', 'Wren')], [p('wren', 'Wren Ash'), p('wren-2', 'Wren')], OK],
      ['merged-away + same name', [f('brann-weir', 'Brann Weir'), f('ow2', 'Old Weir')], [p('old-weir', 'Old Weir')], merged],
      ['John', [f('x1', 'John Smith'), f('x2', 'John')], [p('js', 'John Smith'), p('jd', 'John Doe')], OK],
      ['narrator flip', [f('narrator', 'Narrator')], [p('char-narrator', 'Narrator')], OK],
      ['degraded', [f('a', 'Anna'), f('n', 'Nobody'), f('narrator', 'Narrator')], [p('a1', 'Anna Kay'), p('a2', 'Anna Lee')], hist({ status: 'degraded' })],
      ['displaced + superseded raws', [f('ghost', 'Ghost'), f('old', 'Old')], [p('keep', 'Keep')], hist({ displaced: { ghost: 'keep' }, supersededBy: { old: 'keep' }, supersededByKind: { old: 'analyzer' } })],
      ['junk rows', [f('wren-9', 'Wren'), f('', ''), f('weird', undefined as unknown as string), f('wren-9', 'Wren')], twins, OK],
    ];
    for (const [title, fresh, prior, history] of fixtures) {
      it(title, () => {
        const a = plan(fresh, prior, { history });
        const ids = [...new Set(fresh.map((r) => r.id).filter((id) => id !== ''))];
        expect(Object.keys(a.decisions).sort()).toEqual([...ids].sort());
        for (const d of Object.values(a.decisions)) expect(['join', 'new']).toContain(d.kind);
        expect(plan(fresh, prior, { history })).toEqual(a);
        expect(plan([...fresh].reverse(), prior, { history })).toEqual(a);
        const newIds = Object.values(a.decisions).flatMap((d) => (d.kind === 'new' ? [d.id] : []));
        expect(new Set(newIds).size).toBe(newIds.length);
        const live = new Set(prior.map((r) => r.id));
        for (const id of newIds) expect(live.has(id)).toBe(false);
      });
    }
  });

  it('a mixed user then analyzer chain is not T1: the analyzer hop stops it and the name decides', () => {
    const pl = plan([f('a', 'Zed')], [p('live', 'Old'), p('other', 'Zed')], {
      history: hist({
        supersededBy: { a: 'b', b: 'live' },
        supersededByKind: { a: 'user', b: 'analyzer' },
      }),
    });
    expect(join(pl.decisions['a'])).toMatchObject({ priorId: 'other', tier: 'name' });
  });

  describe('the narrator is never minted', () => {
    it('degraded history with no prior narrator row keeps the id', () => {
      const pl = plan([f('narrator', 'Narrator')], [p('a1', 'Anna')], { history: hist({ status: 'degraded' }) });
      expect(fresh_(pl.decisions['narrator'])).toMatchObject({ id: 'narrator', minted: false });
    });
    it('a superseded-to-dead-target or displaced narrator id keeps the id', () => {
      const pl = plan([f('narrator', 'Narrator')], [p('a1', 'Anna')], {
        history: hist({ supersededBy: { narrator: 'gone' } }),
      });
      expect(fresh_(pl.decisions['narrator'])).toMatchObject({ id: 'narrator', minted: false });
      const pl2 = plan([f('char-narrator', 'Narrator')], [p('a1', 'Anna')], {
        history: hist({ displaced: { 'char-narrator': 'a1' } }),
      });
      expect(fresh_(pl2.decisions['char-narrator'])).toMatchObject({ id: 'char-narrator', minted: false });
    });
  });

  it('item 13: a cross-book entry whose characterId equals a local id is kept', () => {
    const pl = plan(
      [f('x', 'Anna')],
      [p('a1', 'Anna Kay', { notLinkedTo: [{ bookId: 'book-0', characterId: 'a2' }] }), p('a2', 'Anna Lee')],
    );
    expect(fresh_(pl.decisions['x']).inheritedDeclines).toEqual([{ bookId: 'book-0', characterId: 'a2' }]);
  });

  it('rule 3 over a decline', () => {
    const pl = plan(
      [f('gone', 'Mira')],
      [p('keep', 'Keeper', { notLinkedTo: ['gone'] })],
      { history: hist({ supersededBy: { gone: 'keep' }, supersededByKind: { gone: 'user' } }) },
    );
    expect(join(pl.decisions['gone']).priorId).toBe('keep');
  });

  it('a decline drops a name candidate in either direction', () => {
    // prior declines the fresh raw id
    expect(
      fresh_(plan([f('x', 'Anna')], [p('a1', 'Anna', { notLinkedTo: ['x'] })]).decisions['x']).suggest,
    ).toEqual([]);
    // a notSamePerson record pairs them
    expect(
      fresh_(
        plan([f('x', 'Anna')], [p('a1', 'Anna')], {
          history: hist({ notSamePerson: [{ a: 'a1', b: 'x', at: 't' }] }),
        }).decisions['x'],
      ).suggest,
    ).toEqual([]);
    // a cross-book entry is not a decision about this book
    expect(
      join(
        plan([f('x', 'Anna')], [p('a1', 'Anna', { notLinkedTo: [{ bookId: 'book-0', characterId: 'x' }] })]).decisions['x'],
      ).priorId,
    ).toBe('a1');
  });

  it('F11: a first analysis keeps every raw id', () => {
    const pl = plan([f('a', 'Anna'), f('b', 'Anna'), f('c', 'Cora')], [], { history: hist({ status: 'absent' }) });
    for (const id of ['a', 'b', 'c']) {
      expect(fresh_(pl.decisions[id])).toMatchObject({ id, minted: false, suggest: [] });
    }
  });

  describe('open-question', () => {
    const sug = (newRow: string | undefined, candidate: string | undefined): StoredSuggestion => ({
      sourceId: 's', targetId: 't', a: 'a', b: 'b', reason: 'r', origin: 'plan', newRow, candidate,
    });
    it('a repeat ambiguous name joins the open-question row', () => {
      const rows = [p('q', 'Anna Kay'), p('a1', 'Anna Lee'), p('a2', 'Anna Fox')];
      const pl = plan([f('x', 'Anna')], rows, { openSuggestions: [sug('q', 'a1'), sug('q', 'a2')] });
      expect(join(pl.decisions['x'])).toMatchObject({ priorId: 'q', tier: 'open-question' });
    });
    it('without full coverage of the other candidates it stays a new row', () => {
      const rows = [p('q', 'Anna Kay'), p('a1', 'Anna Lee'), p('a2', 'Anna Fox')];
      const pl = plan([f('x', 'Anna')], rows, { openSuggestions: [sug('q', 'a1')] });
      expect(fresh_(pl.decisions['x']).suggest).toEqual(['a1', 'a2', 'q']);
    });
    it('a legacy suggestion never makes an open-question row', () => {
      const rows = [p('q', 'Anna Kay'), p('a1', 'Anna Lee')];
      const legacy = (sourceId: string, targetId: string): StoredSuggestion => ({
        // names the real rows but carries no newRow / candidate
        sourceId, targetId, a: targetId, b: sourceId, reason: 'r', origin: 'plan',
      });
      const pl = plan([f('x', 'Anna')], rows, { openSuggestions: [legacy('q', 'a1')] });
      expect(fresh_(pl.decisions['x']).suggest).toEqual(['a1', 'q']);
    });
  });

  it('id/name conflict: a live id whose name points at a different row is new, suggesting both', () => {
    const pl = plan([f('x', 'Wren')], [p('x', 'Zed'), p('y', 'Wren')]);
    const n = fresh_(pl.decisions['x']);
    expect(n.suggest).toEqual(['x', 'y']);
    expect(n.minted).toBe(true);
  });

  it('id/name conflict does not fire when the name matches the id row (name or alias)', () => {
    expect(join(plan([f('x', 'Wren')], [p('x', 'Wren'), p('y', 'Wren')]).decisions['x']).priorId).toBe('x');
    expect(
      join(plan([f('x', 'Wren')], [p('x', 'Zed', { aliases: ['Wren'] }), p('y', 'Wren')]).decisions['x']).priorId,
    ).toBe('x');
  });

  it('id/name conflict applies to T1-by-live-id only, never to a history join', () => {
    const pl = plan(
      [f('gone', 'Wren')],
      [p('keep', 'Zed'), p('y', 'Wren')],
      { history: hist({ supersededBy: { gone: 'keep' } }) },
    );
    expect(join(pl.decisions['gone']).priorId).toBe('keep');
  });

  it('catch-all and narrator rows are never name candidates', () => {
    const pl = plan(
      [f('x', 'Unknown Man'), f('y', 'Narrator Two')],
      [p('unknown-male', 'Unknown Man'), p('unknown-female', 'Unknown Man'), p('char-narrator', 'Narrator Two')],
    );
    expect(fresh_(pl.decisions['x']).suggest).toEqual([]);
    expect(fresh_(pl.decisions['y']).suggest).toEqual([]);
  });

  it('two trailing tokens apart never matches', () => {
    const pl = plan([f('x', 'Anna Maria Kay')], [p('a', 'Anna')]);
    expect(fresh_(pl.decisions['x']).suggest).toEqual([]);
  });

  it('an exact name beats the surname tier', () => {
    const pl = plan([f('x', 'Anna')], [p('exact', 'Anna'), p('t1', 'Anna Kay'), p('t2', 'Anna Lee')]);
    expect(join(pl.decisions['x'])).toMatchObject({ priorId: 'exact', tier: 'name' });
  });

  it('Review Focus 2: told-apart twins plus a third fresh Wren is new, suggests both, inherits no same-book decline', () => {
    const pl = plan(
      [f('wren-9', 'Wren')],
      [
        p('wren-a', 'Wren', { notLinkedTo: ['wren-b', { bookId: 'book-1', characterId: 'wren-b' }, { bookId: 'book-0', characterId: 'far' }] }),
        p('wren-b', 'Wren', { notLinkedTo: [{ characterId: 'wren-a' }, 'wren-a'] }),
      ],
      { history: hist({ notSamePerson: [{ a: 'wren-a', b: 'wren-b', at: 't' }] }) },
    );
    const n = fresh_(pl.decisions['wren-9']);
    expect(n.suggest).toEqual(['wren-a', 'wren-b']);
    expect(n.inheritedDeclines).toEqual([{ bookId: 'book-0', characterId: 'far' }]);
  });

  it('Review Focus 5: a displaced raw id is minted, never reclaimed', () => {
    const pl = plan(
      [f('ghost', 'Ghost')],
      [p('other', 'Other')],
      { history: hist({ displaced: { ghost: 'other' } }) },
    );
    const n = fresh_(pl.decisions['ghost']);
    expect(n).toMatchObject({ minted: true, id: 'ghost-n1' });
  });

  it('a superseded raw id is minted too, and the lowest free k skips taken ids', () => {
    const pl = plan(
      [f('old', 'Nobody')],
      [p('keep', 'Keep')],
      {
        history: hist({
          supersededBy: { old: 'keep', 'old-n1': 'keep' },
          supersededByKind: { old: 'analyzer' }, // not T1, so the row is new but its raw id is still superseded
        }),
        reserved: ['old-n2'],
      },
    );
    expect(fresh_(pl.decisions['old']).id).toBe('old-n3');
  });

  it("minting excludes the row's own raw id from taken (R6 reserves it, but a free raw id is kept)", () => {
    const pl = plan([f('solo', 'Solo')], []);
    expect(fresh_(pl.decisions['solo'])).toMatchObject({ id: 'solo', minted: false });
  });

  it('R6: a minted id never collides with another fresh row raw id', () => {
    const pl = plan([f('wren', 'Wren'), f('wren-n1', 'Fresh')], [p('wren', 'Wren Ash'), p('y', 'Wren')]);
    expect(fresh_(pl.decisions['wren']).id).toBe('wren-n2');
    expect(fresh_(pl.decisions['wren-n1']).id).toBe('wren-n1');
  });

  it('R24: numeric-aware ordering, wren-9 sorts before wren-10', () => {
    const pl = plan([f('q', 'Wren')], [p('wren-10', 'Wren Ash'), p('wren-9', 'Wren Bay')]);
    expect(fresh_(pl.decisions['q']).suggest).toEqual(['wren-9', 'wren-10']);
  });
});

describe('extendPlan', () => {
  it('extendPlan uses its own runToken and never re-decides a covered row', () => {
    const prior = [p('a1', 'Anna Kay'), p('a2', 'Anna Lee')];
    const history = hist({ status: 'degraded' });
    const first = plan([f('r1', 'Nobody')], prior, { history, runToken: 'one' });
    const reservedIds = buildReservedIds({ prior, history, plan: first });
    reservedIds.add('r2');
    const ext = extendPlan(first, {
      fresh: [f('r1', 'Anna'), f('r2', 'Nobody Else')], // r1 is already covered: its name changed on purpose
      prior,
      history,
      openSuggestions: [],
      reservedIds,
      runToken: 'two',
      currentBookId: 'book-1',
    });
    expect(ext.decisions['r1']).toEqual(first.decisions['r1']);
    expect(fresh_(ext.decisions['r1']).id).toBe('r1-rone');
    expect(fresh_(ext.decisions['r2']).id).toBe('r2-rtwo');
    expect(ext.runToken).toBe('one');
    expect(first.decisions['r2']).toBeUndefined(); // input plan not mutated
  });

  it('extendPlan never hands out an id the input plan already minted, even when the minted row left the prior', () => {
    const prior = [p('wren', 'Wren Ash'), p('y', 'Wren')];
    const first = plan([f('wren', 'Wren')], prior);
    expect(fresh_(first.decisions['wren']).id).toBe('wren-n1');
    const reservedIds = buildReservedIds({ prior, history: OK, plan: first });
    const ext = extendPlan(first, {
      fresh: [f('wren-n1', 'Fresh Face')], // the minted row is not in the re-read prior (deleted mid-run)
      prior,
      history: OK,
      openSuggestions: [],
      reservedIds,
      runToken: 'two',
    });
    const d = fresh_(ext.decisions['wren-n1']);
    expect(d.id).not.toBe('wren-n1');
    expect(d.minted).toBe(true);
    const newIds = Object.values(ext.decisions).flatMap((x) => (x.kind === 'new' ? [x.id] : []));
    expect(new Set(newIds).size).toBe(newIds.length);
  });
});

describe('buildReservedIds and mintId', () => {
  it('buildReservedIds holds live, superseded, displaced and planned ids', () => {
    const first = plan([f('wren', 'Wren')], [p('wren', 'Wren Ash'), p('y', 'Wren')]);
    const ids = buildReservedIds({
      prior: [p('live', 'L')],
      history: hist({ supersededBy: { gone: 'live' }, displaced: { moved: 'live' } }),
      plan: first,
    });
    expect([...ids].sort()).toEqual(['gone', 'live', 'moved', 'wren', 'wren-n1'].sort());
  });

  it('mintId lowest takes the lowest free k; run mode takes the token', () => {
    expect(mintId('a', new Set(['a-n1', 'a-n3']), { kind: 'lowest' })).toBe('a-n2');
    expect(mintId('a', new Set(), { kind: 'run', runToken: 'z' })).toBe('a-rz');
    expect(mintId('a', new Set(['a-rz']), { kind: 'run', runToken: 'z' })).toBe('a-rz-1');
  });
});
