import { describe, expect, it } from 'vitest';
import { dedupeRosterByName } from '../analyzer/roster-dedup.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import {
  ANALYSIS_OWNED,
  applyMatchPlan,
  overlayPlanOntoCast,
  planConstraintsFor,
  remapSentenceIds,
  rerouteDeletedTargets,
  retargetPlanForMerge,
  userOwnedFingerprint,
} from './plan-overlay.js';
import type { JoinTier, MatchDecision, MatchHistory, MatchPlan, PriorRow, RunAddedLedger } from './reanalysis-types.js';

const BOOK = 'book-1';
const planOf = (...ds: MatchDecision[]): MatchPlan => ({
  version: 1,
  runToken: 't',
  decisions: Object.fromEntries(ds.map((d) => [d.rawId, d])),
});
const join = (rawId: string, priorId: string, tier: JoinTier = 'id'): MatchDecision => ({
  kind: 'join', rawId, priorId, tier,
});
const nw = (rawId: string, id = rawId, extra: Partial<Extract<MatchDecision, { kind: 'new' }>> = {}): MatchDecision => ({
  kind: 'new', rawId, id, minted: id !== rawId, suggest: [], inheritedDeclines: [], ...extra,
});
const history = (over: Partial<MatchHistory> = {}): MatchHistory => ({
  status: 'ok', supersededBy: {}, supersededByKind: {}, displaced: {}, notSamePerson: [], ...over,
});
const same = (id: string): string | null => id;
const fp = userOwnedFingerprint;

type Row = { id: string; name: string } & Record<string, unknown>;
/** R29: the overlay's input is the PLAN-APPLIED roster, so every case runs applyMatchPlan first. */
const overlay = (o: {
  current: PriorRow[]; roster: Row[]; plan: MatchPlan; ledger?: RunAddedLedger;
  resolve?: (id: string) => string | null; historyStatus?: 'ok' | 'absent' | 'degraded'; mode?: 'snapshot' | 'persist';
  knownRunIds?: string[];
}) =>
  overlayPlanOntoCast({
    current: o.current, roster: applyMatchPlan(o.roster, o.plan, o.current).characters, plan: o.plan,
    resolve: o.resolve ?? same,
    historyStatus: o.historyStatus ?? 'ok', ledger: o.ledger ?? {}, currentBookId: BOOK, mode: o.mode ?? 'snapshot',
    knownRunIds: new Set(o.knownRunIds ?? []),
  });

describe('userOwnedFingerprint', () => {
  it('ignores analysis-owned fields and key order', () => {
    const a = { id: 'x', name: 'X', tone: 'warm', lines: 3, scenes: [1] };
    const b = { scenes: [9], tone: 'warm', name: 'X', id: 'x', lines: 99, evidence: ['e'] };
    expect(fp(a)).toBe(fp(b));
    expect(fp({ ...a, tone: 'cold' })).not.toBe(fp(a));
    expect(fp({ id: 'x', o: { b: 1, a: 2 } })).toBe(fp({ id: 'x', o: { a: 2, b: 1 } }));
    expect(ANALYSIS_OWNED).toContain('detectionSource');
  });
});

describe('applyMatchPlan', () => {
  const prior: PriorRow[] = [{ id: 'anna', name: 'Anna Petrova', aliases: ['Annie'] }];

  it('item 12: rows mapping to one output id collapse', () => {
    const roster = [
      { id: 'a1', name: 'Anna', lines: 2, scenes: [1] },
      { id: 'a2', name: 'Anya', lines: 3, scenes: [1, 2] },
      { id: 'n1', name: 'Newt', lines: 1 },
      { id: 'n2', name: 'Newton', lines: 4 },
    ];
    const plan = planOf(join('a1', 'anna', 'name'), join('a2', 'anna', 'name'), nw('n1', 'newt'), nw('n2', 'newt'));
    const { characters, idMap } = applyMatchPlan(roster, plan, prior);
    expect(characters.map((c) => c.id)).toEqual(['anna', 'newt']);
    expect(characters[0]).toMatchObject({ id: 'anna', name: 'Anna Petrova', lines: 5, scenes: [1, 2] });
    expect(characters[1]).toMatchObject({ id: 'newt', lines: 5 });
    expect(idMap).toEqual({ a1: 'anna', a2: 'anna', n1: 'newt', n2: 'newt' });
  });

  it('a joined output takes the prior id and name, aliases = prior ∪ analyzer names; a new row gets no notLinkedTo', () => {
    const plan = planOf(join('a1', 'anna', 'name'), nw('z', 'z', { inheritedDeclines: [{ bookId: 'b9', characterId: 'q' }] }));
    const { characters } = applyMatchPlan(
      [{ id: 'a1', name: 'Anna', aliases: ['A.'] }, { id: 'z', name: 'Zed' }],
      plan,
      prior,
    );
    expect(characters[0]).toMatchObject({ id: 'anna', name: 'Anna Petrova', aliases: ['Annie', 'Anna', 'A.'] });
    expect(characters[1]).not.toHaveProperty('notLinkedTo');
  });

  it("A7b: a joined output takes matchedFrom/notLinkedTo only from its prior row, never the fresh row's", () => {
    const link = { bookId: 'b9', characterId: 'mine' };
    const pri: PriorRow[] = [
      { id: 'p', name: 'P', matchedFrom: link, notLinkedTo: ['x'] },
      { id: 'q', name: 'Q' },
    ];
    const fresh = { matchedFrom: { bookId: 'b9', characterId: 'other' }, notLinkedTo: [{ bookId: 'b9', characterId: 'y' }] };
    const { characters } = applyMatchPlan(
      [{ id: 'f1', name: 'P', ...fresh }, { id: 'f2', name: 'Pee', ...fresh }, { id: 'f3', name: 'Q', ...fresh }],
      planOf(join('f1', 'p', 'name'), join('f2', 'p', 'name'), join('f3', 'q', 'name')),
      pri,
    );
    expect(characters.map((c) => c.id)).toEqual(['p', 'q']);
    expect(characters[0]).toMatchObject({ matchedFrom: link, notLinkedTo: ['x'] });
    expect(characters[1]).not.toHaveProperty('matchedFrom');
    expect(characters[1]).not.toHaveProperty('notLinkedTo');
  });

  it('A18b: the narrator keeps its own id through Phase 1 even when it joins another narrator id', () => {
    const plan = planOf(join('narrator', 'char-narrator', 'narrator'));
    const { characters, idMap } = applyMatchPlan([{ id: 'narrator', name: 'Narrator' }], plan, [
      { id: 'char-narrator', name: 'Narrator' },
    ]);
    expect(characters[0].id).toBe('narrator');
    expect(idMap).toEqual({});
  });

  it('remapSentenceIds rewrites speaker ids through the map', () => {
    const out = remapSentenceIds([{ characterId: 'a1' }, { characterId: 'b' }], { a1: 'anna' });
    expect(out.map((s) => s.characterId)).toEqual(['anna', 'b']);
  });
});

describe('overlayPlanOntoCast', () => {
  it('A8: an unvoiced and a decline-only prior row the roster omits are carried forward with their declines', () => {
    const current: PriorRow[] = [
      { id: 'anna', name: 'Anna', voice: 'v1' },
      { id: 'quiet', name: 'Quiet' },
      { id: 'decl', name: 'Decl', notLinkedTo: [{ bookId: 'b9', characterId: 'z' }, 'anna'] },
    ];
    const r = overlay({ current, roster: [{ id: 'anna', name: 'Anna', lines: 2 }], plan: planOf(join('anna', 'anna')) });
    expect(r.characters.map((c) => c.id)).toEqual(['anna', 'quiet', 'decl']);
    expect(r.characters[2]).toEqual(current[2]);
    expect(r.carriedForward).toEqual([{ id: 'quiet', name: 'Quiet' }, { id: 'decl', name: 'Decl' }]);
  });

  it('A9: a joined row keeps its display name and aliases = existing ∪ analyzer name', () => {
    const current: PriorRow[] = [{ id: 'anna', name: 'Anna Petrova', aliases: ['Annie'], voice: 'v1' }];
    const r = overlay({
      current, plan: planOf(join('a1', 'anna', 'name')),
      roster: [{ id: 'a1', name: 'Anna', aliases: ['A.'], lines: 4, evidence: ['e'] }],
    });
    expect(r.characters[0]).toMatchObject({
      id: 'anna', name: 'Anna Petrova', voice: 'v1', aliases: ['Annie', 'Anna', 'A.'], lines: 4, evidence: ['e'],
    });
  });

  it('A7b: a joined row takes no series link from the roster row (the prior has none)', () => {
    const current: PriorRow[] = [{ id: 'anna', name: 'Anna', voice: 'v1' }];
    // Straight into the overlay: a plan-applied roster row that carries a stamp of its own.
    const r = overlayPlanOntoCast({
      current, plan: planOf(join('a1', 'anna', 'name')), resolve: same, historyStatus: 'ok', ledger: {},
      currentBookId: BOOK, mode: 'snapshot',
      roster: [{ id: 'anna', name: 'Anna', lines: 2, matchedFrom: { bookId: 'b9', characterId: 'far' } }],
    });
    expect(r.characters[0]).not.toHaveProperty('matchedFrom');
  });

  it("A7b: a joined row keeps the prior row's own series link", () => {
    const link = { bookId: 'b9', characterId: 'mine' };
    const current: PriorRow[] = [{ id: 'anna', name: 'Anna', matchedFrom: link }];
    const r = overlay({
      current, plan: planOf(join('a1', 'anna', 'name')),
      roster: [{ id: 'a1', name: 'Anna', matchedFrom: { bookId: 'b9', characterId: 'other' } }],
    });
    expect(r.characters[0]).toMatchObject({ matchedFrom: link });
  });

  it('A7b: a collapsed new output unions every decision\'s cross-book inherited declines', () => {
    const plan = planOf(
      nw('n1', 'newt', { inheritedDeclines: [{ bookId: 'b8', characterId: 'x' }] }),
      nw('n2', 'newt', { inheritedDeclines: [{ bookId: 'b9', characterId: 'y' }, { bookId: BOOK, characterId: 'same' }] }),
    );
    const r = overlay({ current: [], plan, roster: [{ id: 'n1', name: 'Newt' }, { id: 'n2', name: 'Newton' }] });
    expect(r.characters).toHaveLength(1);
    expect((r.characters[0] as PriorRow).notLinkedTo).toEqual([
      { bookId: 'b8', characterId: 'x' },
      { bookId: 'b9', characterId: 'y' },
    ]);
  });

  it('carry-forward: a decline between two prior rows survives the roster joining each side', () => {
    const current: PriorRow[] = [
      { id: 'p1', name: 'P One', notLinkedTo: ['p2'] },
      { id: 'p2', name: 'P Two', notLinkedTo: ['p1'] },
    ];
    const r = overlay({
      current, plan: planOf(join('f1', 'p1', 'name'), join('f2', 'p2', 'name')),
      roster: [{ id: 'f1', name: 'One', lines: 1 }, { id: 'f2', name: 'Two', lines: 2 }],
    });
    expect(r.characters.map((c) => [c.id, (c as PriorRow).notLinkedTo])).toEqual([['p1', ['p2']], ['p2', ['p1']]]);
  });

  it('A18b: a narrator decision maps onto its priorId', () => {
    const current: PriorRow[] = [{ id: 'char-narrator', name: 'Narrator', voice: 'nv' }];
    const r = overlay({
      current, plan: planOf(join('narrator', 'char-narrator', 'narrator')),
      roster: [{ id: 'narrator', name: 'Narrator', lines: 7 }],
    });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0]).toMatchObject({ id: 'char-narrator', voice: 'nv', lines: 7 });
  });

  it('field ownership: tone, gender, description and color from the user, filled from the analyzer when absent', () => {
    const current: PriorRow[] = [{ id: 'a', name: 'A', tone: 'warm', gender: 'f', description: '', color: undefined }];
    const r = overlay({
      current, plan: planOf(join('a', 'a')),
      roster: [{ id: 'a', name: 'A', tone: 'cold', gender: 'm', description: 'tall', color: '#fff', attributes: { x: 1 }, detectionSource: 'llm' }],
    });
    expect(r.characters[0]).toMatchObject({
      tone: 'warm', gender: 'f', description: 'tall', color: '#fff', attributes: { x: 1 }, detectionSource: 'llm',
    });
  });

  it('item 13: a new row already in current takes its user-owned fields from current', () => {
    const current: PriorRow[] = [{ id: 'newt', name: 'Newt', tone: 'dry', voice: 'edited' }];
    const ledger: RunAddedLedger = { newt: { state: 'run-owned', fp: fp(current[0]) } };
    const r = overlay({
      current, ledger, plan: planOf(nw('n1', 'newt')),
      roster: [{ id: 'n1', name: 'Newt', tone: 'cold', lines: 6 }],
    });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0]).toMatchObject({ id: 'newt', tone: 'dry', voice: 'edited', lines: 6 });
    expect(r.collisions).toEqual([]);
  });

  it('a new row is added with its final id and a run-owned ledger entry', () => {
    const r = overlay({ current: [], plan: planOf(nw('z', 'z-n1')), roster: [{ id: 'z', name: 'Zed', lines: 1 }] });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0]).toMatchObject({ id: 'z-n1', name: 'Zed' });
    expect(r.ledger['z-n1']).toEqual({ state: 'run-owned', fp: fp(r.characters[0] as Record<string, unknown>) });
  });

  it('R29: a name join, a history join and a minted row all land on their plan-applied ids', () => {
    const current: PriorRow[] = [
      { id: 'anna', name: 'Anna Petrova', voice: 'va' },
      { id: 'boris', name: 'Boris', voice: 'vb' },
    ];
    const r = overlay({
      current,
      plan: planOf(join('a1', 'anna', 'name'), join('b-old', 'boris', 'history'), nw('z', 'z-n1')),
      roster: [
        { id: 'a1', name: 'Anna', lines: 2 },
        { id: 'b-old', name: 'Boris B', lines: 3 },
        { id: 'z', name: 'Zed', lines: 1 },
      ],
    });
    expect(r.collisions).toEqual([]);
    expect(r.characters.map((c) => c.id)).toEqual(['anna', 'boris', 'z-n1']);
    expect(r.characters[0]).toMatchObject({ voice: 'va', lines: 2 });
    expect(r.characters[1]).toMatchObject({ voice: 'vb', lines: 3 });
    expect(r.ledger['z-n1']?.state).toBe('run-owned');
  });

  it('persist mode: a roster id with no decision throws an invariant error naming the id', () => {
    expect(() =>
      overlay({ current: [{ id: 'a', name: 'A' }], plan: planOf(), roster: [{ id: 'orphan-id', name: 'O' }], mode: 'persist' }),
    ).toThrow(/orphan-id/);
  });

  it('a roster id with no decision is skipped in snapshot mode', () => {
    const r = overlay({ current: [{ id: 'a', name: 'A' }], plan: planOf(), roster: [{ id: 'mystery', name: 'M' }] });
    expect(r.characters.map((c) => c.id)).toEqual(['a']);
  });

  it('A20: a target gone with no history stays gone and is reported', () => {
    const r = overlay({
      current: [{ id: 'a', name: 'A' }], plan: planOf(join('g', 'gone')), roster: [{ id: 'g', name: 'Gone', lines: 2 }],
      resolve: (id) => (id === 'a' ? id : null), historyStatus: 'absent',
    });
    expect(r.deletedTargets).toEqual(['gone']);
    expect(r.unresolved).toEqual([]);
    expect(r.characters.map((c) => c.id)).toEqual(['a']);
  });

  it('F8: with degraded history a gone target is unresolved', () => {
    const r = overlay({
      current: [{ id: 'a', name: 'A' }], plan: planOf(join('g', 'gone')), roster: [{ id: 'g', name: 'Gone' }],
      resolve: () => null, historyStatus: 'degraded',
    });
    expect(r.unresolved).toEqual(['gone']);
    expect(r.deletedTargets).toEqual([]);
    expect(r.characters.map((c) => c.id)).toEqual(['a']);
  });

  it('a target merged away resolves to its survivor', () => {
    const current: PriorRow[] = [{ id: 'surv', name: 'Survivor', voice: 'sv' }];
    const r = overlay({
      current, plan: planOf(join('g', 'merged')), roster: [{ id: 'g', name: 'Merged', lines: 3 }],
      resolve: (id) => (id === 'merged' ? 'surv' : id),
    });
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0]).toMatchObject({ id: 'surv', voice: 'sv', lines: 3, aliases: ['Merged'] });
    expect(r.deletedTargets).toEqual([]);
  });

  it('item 3: a run-added row gone with no history is reported and rerouted', () => {
    const ledger: RunAddedLedger = { newt: { state: 'run-owned', fp: 'x' } };
    const r = overlay({
      current: [{ id: 'a', name: 'A' }], ledger, plan: planOf(nw('n1', 'newt')),
      roster: [{ id: 'n1', name: 'Newt', lines: 2 }], resolve: (id) => (id === 'a' ? id : null), historyStatus: 'absent',
    });
    expect(r.deletedTargets).toEqual(['newt']);
    const sentences = rerouteDeletedTargets([{ characterId: 'newt' }, { characterId: 'a' }], new Set(r.deletedTargets));
    expect(sentences.map((s) => s.characterId)).toEqual(['narrator', 'a']);
  });

  it('rerouteDeletedTargets sets priorCharacterId', () => {
    const out = rerouteDeletedTargets([{ characterId: 'gone' }], new Set(['gone']));
    expect(out[0]).toEqual({ characterId: 'narrator', priorCharacterId: 'gone' });
  });

  it('rerouteDeletedTargets sends a deleted target to the book\'s own narrator id', () => {
    const out = rerouteDeletedTargets([{ characterId: 'gone' }], new Set(['gone']), 'char-narrator');
    expect(out[0]).toEqual({ characterId: 'char-narrator', priorCharacterId: 'gone' });
  });

  it('item 12: a new id live on disk but not in the ledger is reported as a collision', () => {
    const current: PriorRow[] = [{ id: 'wren', name: 'Wren', voice: 'live' }];
    const r = overlay({ current, plan: planOf(nw('wren', 'wren')), roster: [{ id: 'wren', name: 'Other Wren', lines: 1 }] });
    expect(r.collisions).toEqual(['wren']);
    expect(r.characters).toEqual(current);
  });

  it('R2: a new id live on disk that another job ledger knows is overlaid, not a collision', () => {
    const current: PriorRow[] = [{ id: 'dina', name: 'Dina' }];
    const r = overlay({
      current, plan: planOf(nw('dina')), roster: [{ id: 'dina', name: 'Dina', lines: 3 }], knownRunIds: ['dina'],
    });
    expect(r.collisions).toEqual([]);
    expect(r.characters).toEqual([expect.objectContaining({ id: 'dina', lines: 3 })]);
    expect(r.ledger).toEqual({});
  });

  it('R2: a known run row absent from disk is gone, never re-added', () => {
    const r = overlay({
      current: [{ id: 'a', name: 'A' }], plan: planOf(nw('dina')), roster: [{ id: 'dina', name: 'Dina', lines: 3 }],
      knownRunIds: ['dina'],
    });
    expect(r.characters.map((c) => c.id)).toEqual(['a']);
    expect(r.deletedTargets).toEqual(['dina']);
  });

  it('F3: a new row persists only cross-book inherited declines', () => {
    const d = nw('z', 'z', {
      inheritedDeclines: ['p1', { characterId: 'p2' }, { bookId: BOOK, characterId: 'p3' }, { bookId: 'b9', characterId: 'q' }],
    });
    const r = overlay({ current: [], plan: planOf(d), roster: [{ id: 'z', name: 'Zed' }] });
    expect(r.characters[0]).toMatchObject({ notLinkedTo: [{ bookId: 'b9', characterId: 'q' }] });
  });

  it('item 11: a bucket id joins a prior bucket row and keeps its name', () => {
    const current: PriorRow[] = [{ id: 'minor-male', name: 'Minor Male Voices', voice: 'bv' }];
    const r = overlay({
      current, plan: planOf(join('minor-male', 'minor-male')),
      roster: [{ id: 'minor-male', name: 'Minor Characters (Male)', lines: 9 }],
    });
    expect(r.characters[0]).toMatchObject({ id: 'minor-male', name: 'Minor Male Voices', voice: 'bv', lines: 9 });
  });
});

describe('overlayPlanOntoCast ledger (invariant 6)', () => {
  const rosterOf = (extra: Record<string, unknown> = {}): Row[] => [{ id: 'n1', name: 'Newt', lines: 1, ...extra }];

  it('A19: a fold-dropped run-owned row whose disk fingerprint still matches is removed; one given a voice on disk is kept', () => {
    const plain: PriorRow = { id: 'fold', name: 'Fold' };
    const voiced: PriorRow = { id: 'keep', name: 'Keep' };
    const ledger: RunAddedLedger = {
      fold: { state: 'run-owned', fp: fp(plain) },
      keep: { state: 'run-owned', fp: fp(voiced) },
    };
    const r = overlay({ current: [plain, { ...voiced, voice: 'user-given' }], ledger, plan: planOf(), roster: [], mode: 'persist' });
    expect(r.characters.map((c) => c.id)).toEqual(['keep']);
    expect(r.droppedRunAdded).toEqual(['fold']);
    expect(r.ledger.fold).toBeUndefined();
    expect(r.ledger.keep).toEqual({ state: 'added-once' });
  });

  it('a run-owned row the final roster lacks is kept in snapshot mode', () => {
    const row: PriorRow = { id: 'fold', name: 'Fold' };
    const r = overlay({ current: [row], ledger: { fold: { state: 'run-owned', fp: fp(row) } }, plan: planOf(), roster: [] });
    expect(r.characters).toEqual([row]);
    expect(r.droppedRunAdded).toEqual([]);
  });

  it("F2: the job's own rewrite of colour, aliases or a linker stamp between two writes does not convert a row", () => {
    const first = overlay({ current: [], plan: planOf(nw('n1', 'newt')), roster: rosterOf() });
    // Second write: the overlay itself changes the row's aliases (analyzer name union).
    const second = overlay({
      current: first.characters as PriorRow[], ledger: first.ledger, plan: planOf(nw('n1', 'newt')),
      roster: rosterOf({ name: 'Newton', color: '#abc' }),
    });
    expect(second.characters[0]).toMatchObject({ aliases: ['Newton'], color: '#abc' });
    expect(second.ledger.newt).toEqual({ state: 'run-owned', fp: fp(second.characters[0] as Record<string, unknown>) });
    // Third write: disk is exactly the second write, so it must still read as the job's own.
    const third = overlay({
      current: second.characters as PriorRow[], ledger: second.ledger, plan: planOf(nw('n1', 'newt')), roster: rosterOf(),
    });
    expect(third.ledger.newt.state).toBe('run-owned');
  });

  it('F2: a user-owned field changed on disk between two job writes converts the row to added-once, and it stays added-once', () => {
    const first = overlay({ current: [], plan: planOf(nw('n1', 'newt')), roster: rosterOf() });
    const edited = { ...(first.characters[0] as PriorRow), voice: 'user-given' };
    const second = overlay({ current: [edited], ledger: first.ledger, plan: planOf(nw('n1', 'newt')), roster: rosterOf() });
    expect(second.ledger.newt).toEqual({ state: 'added-once' });
    const third = overlay({ current: second.characters as PriorRow[], ledger: second.ledger, plan: planOf(nw('n1', 'newt')), roster: rosterOf() });
    expect(third.ledger.newt).toEqual({ state: 'added-once' });
    const persisted = overlay({ current: third.characters as PriorRow[], ledger: third.ledger, plan: planOf(), roster: [], mode: 'persist' });
    expect(persisted.characters.map((c) => c.id)).toEqual(['newt']);
  });

  it('F2: a ledger row absent from cast.json is not re-added', () => {
    const ledger: RunAddedLedger = { newt: { state: 'run-owned', fp: 'x' } };
    const r = overlay({
      current: [], ledger, plan: planOf(nw('n1', 'newt')), roster: rosterOf(),
      resolve: () => null, historyStatus: 'absent',
    });
    expect(r.characters).toEqual([]);
    expect(r.deletedTargets).toEqual(['newt']);
    // Item 4: a gone run-owned row becomes added-once, so clearing the ledger can never let it be re-added.
    expect(r.ledger.newt).toEqual({ state: 'added-once' });
  });

  it('item 4: a degraded-history gone run-owned row also becomes added-once', () => {
    const ledger: RunAddedLedger = { newt: { state: 'run-owned', fp: 'x' } };
    const r = overlay({
      current: [], ledger, plan: planOf(nw('n1', 'newt')), roster: rosterOf(), resolve: () => null, historyStatus: 'degraded',
    });
    expect(r.unresolved).toEqual(['newt']);
    expect(r.ledger.newt).toEqual({ state: 'added-once' });
  });

  it('a ledger row marked added-once and absent from current is not re-added', () => {
    const ledger: RunAddedLedger = { newt: { state: 'added-once' } };
    const r = overlay({ current: [], ledger, plan: planOf(nw('n1', 'newt')), roster: rosterOf(), resolve: () => null });
    expect(r.characters).toEqual([]);
    expect(r.deletedTargets).toEqual(['newt']);
  });
});

describe('retargetPlanForMerge', () => {
  it("item 12: retargetPlanForMerge copies the target's new decision", () => {
    const plan = planOf(nw('s', 's-n1', { suggest: ['q'] }), nw('t', 't-n1', { suggest: ['p'], inheritedDeclines: [{ bookId: 'b9', characterId: 'x' }] }), join('j', 'prior'));
    const out = retargetPlanForMerge(plan, 's-n1', 't-n1');
    expect(out.decisions.s).toEqual({ ...plan.decisions.t, rawId: 's' });
    expect(out.decisions.t).toEqual(plan.decisions.t);
    expect(out.decisions.j).toEqual(plan.decisions.j);
    expect(plan.decisions.s).toMatchObject({ id: 's-n1' });
  });

  it("otherwise writes join(target, 'merge') for every decision on the source", () => {
    const plan = planOf(join('a', 'src'), nw('b', 'src'));
    const out = retargetPlanForMerge(plan, 'src', 'prior-t');
    expect(out.decisions.a).toEqual({ kind: 'join', rawId: 'a', priorId: 'prior-t', tier: 'merge' });
    expect(out.decisions.b).toEqual({ kind: 'join', rawId: 'b', priorId: 'prior-t', tier: 'merge' });
  });
});

describe('planConstraintsFor', () => {
  const prior: PriorRow[] = [
    { id: 'p1', name: 'P1', notLinkedTo: ['p2', { bookId: 'b9', characterId: 'far' }, { bookId: BOOK, characterId: 'p4' }] },
    { id: 'p2', name: 'P2' },
  ];
  /** R29: constraints are computed over the plan-applied roster. */
  const constraintsOf = (roster: Row[], plan: MatchPlan, pri: PriorRow[], hist = history()) =>
    planConstraintsFor({
      roster: applyMatchPlan(roster, plan, pri).characters, plan, prior: pri, history: hist, currentBookId: BOOK,
    });
  const declinedOf = (c: ReturnType<typeof constraintsOf>, id: string): readonly string[] =>
    (c.planned.get(id) as { declinedIds: readonly string[] }).declinedIds;

  it("item 1: planConstraintsFor lists a candidate's same-book declines", () => {
    const plan = planOf(nw('a', 'a', { suggest: ['p1'] }), join('j', 'p2', 'name'));
    const c = constraintsOf([{ id: 'a', name: 'A' }, { id: 'j', name: 'Jay' }], plan, prior);
    const info = c.planned.get('a');
    expect(info).toMatchObject({ kind: 'new', candidates: ['p1'] });
    expect(declinedOf(c, 'a')).toEqual(['p2', 'p4']);
    expect(c.planned.get('p2')).toEqual({ kind: 'join', priorId: 'p2' });
    expect(c.currentBookId).toBe(BOOK);
  });

  it('R29: constraints are keyed by the output id - a name join, a history join and a minted row', () => {
    const plan = planOf(join('f1', 'p2', 'name'), join('f2', 'p1', 'history'), nw('z', 'z-n1', { suggest: ['p1'] }));
    const c = constraintsOf(
      [{ id: 'f1', name: 'One' }, { id: 'f2', name: 'Two' }, { id: 'z', name: 'Zed' }], plan, prior,
    );
    expect([...c.planned.keys()].sort()).toEqual(['p1', 'p2', 'z-n1']);
    expect(c.planned.get('p2')).toEqual({ kind: 'join', priorId: 'p2' });
    expect(c.planned.get('p1')).toEqual({ kind: 'join', priorId: 'p1' });
    expect(c.planned.get('z-n1')).toMatchObject({ kind: 'new', minted: true, candidates: ['p1'] });
  });

  it('R29: decisions sharing an output id union their candidates, declines and raw-id declines', () => {
    const plan = planOf(
      nw('n1', 'newt', { suggest: ['p1'], inheritedDeclines: [{ bookId: 'b8', characterId: 'x' }] }),
      nw('n2', 'newt', { suggest: ['p2'], inheritedDeclines: [{ bookId: 'b9', characterId: 'y' }] }),
    );
    const c = constraintsOf([{ id: 'n1', name: 'Newt' }, { id: 'n2', name: 'Newton' }], plan, prior, history({
      notSamePerson: [{ a: 'n2', b: 'zz', at: 't' }],
    }));
    expect([...c.planned.keys()]).toEqual(['newt']);
    const info = c.planned.get('newt') as unknown as { candidates: string[]; inheritedDeclines: unknown[] };
    expect([...info.candidates].sort()).toEqual(['p1', 'p2']);
    expect(info.inheritedDeclines).toEqual([{ bookId: 'b8', characterId: 'x' }, { bookId: 'b9', characterId: 'y' }]);
    expect([...declinedOf(c, 'newt')]).toEqual(expect.arrayContaining(['p2', 'p4', 'p1', 'zz']));
  });

  it('a decline written on the other side, and a notSamePerson record, count too', () => {
    const plan = planOf(nw('a', 'a-n1', { suggest: ['p2'] }), nw('b', 'b', { suggest: [] }));
    const c = constraintsOf([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], plan, prior, history({
      notSamePerson: [{ a: 'b', b: 'zz', at: 't' }],
    }));
    expect(declinedOf(c, 'a-n1')).toEqual(['p1']);
    expect(declinedOf(c, 'b')).toEqual(['zz']);
  });

  it('item 1 round trip: minted and name-joined rows are refused or kept by the dedup through the producer keys', () => {
    // Two minted `new` rows whose candidates hold a notSamePerson record stay separate; a name-joined row
    // keeps its prior id. All three share one display name, so only the constraints keep them apart.
    const pri: PriorRow[] = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'ann', name: 'Ann Lee' }];
    const roster: Row[] = [
      { id: 'f0', name: 'Ann Lee' },
      { id: 'ann', name: 'Ann Lee' },
      { id: 'ann2', name: 'Ann Lee' },
    ];
    const plan = planOf(join('f0', 'ann', 'name'), nw('ann', 'ann-n1', { suggest: ['p1'] }), nw('ann2', 'ann2-n1', { suggest: ['p2'] }));
    const applied = applyMatchPlan(roster, plan, pri).characters;
    const constraints = planConstraintsFor({
      roster: applied, plan, prior: pri,
      history: history({ notSamePerson: [{ a: 'p1', b: 'p2', at: 't' }] }), currentBookId: BOOK,
    });
    const run = (c: typeof constraints) =>
      dedupeRosterByName(applied as unknown as CharacterOutput[], [], { constraints: c }).characters.map((x) => x.id);
    expect(applied.map((x) => x.id)).toEqual(['ann', 'ann-n1', 'ann2-n1']);
    expect(run(constraints)).toEqual(['ann', 'ann-n1', 'ann2-n1']);
    // Control: with declinedIds emptied the two new rows still refuse the joined one but merge together.
    const emptied = {
      ...constraints,
      planned: new Map([...constraints.planned].map(([k, v]) => [k, v.kind === 'new' ? { ...v, declinedIds: [] } : v])),
    };
    expect(run(emptied)).toEqual(['ann', 'ann-n1']);
  });
});
