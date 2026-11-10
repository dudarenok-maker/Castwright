/* The run-start prior-cast heal (`dedupePriorCastByName`) and
   `voicedSurvivorsDropped`. The old fresh<->prior overlay this file used to
   cover (`mergeAnalysisResultWithExistingCast` & co, bug #518 / srv-13) was
   deleted by plan 291 (#4031): its cases live in `match-fresh-to-prior.test.ts`
   (the matcher) and `plan-overlay.test.ts` (the voice-field overlay). */

import { describe, it, expect } from 'vitest';
import {
  voicedSurvivorsDropped,
  dedupePriorCastByName,
} from './merge-analysis-cast.js';

type C = Record<string, unknown> & { id: string };

describe('voicedSurvivorsDropped', () => {
  it('lists only voiced/reused characters the fresh roster omitted', () => {
    const existing: C[] = [
      { id: 'wren', name: 'Wren', voiceId: 'wren' }, // survives
      { id: 'wisp', name: 'Wisp', voiceState: 'reused', voiceId: 'wisp' }, // dropped + voiced
      { id: 'extra', name: 'Extra' }, // dropped but no voice
    ];
    const fresh: C[] = [{ id: 'wren' }];
    expect(voicedSurvivorsDropped(existing, fresh)).toEqual([{ id: 'wisp', name: 'Wisp' }]);
  });
});

describe('dedupePriorCastByName', () => {
  it('reports the loser\'s id as a retirement, not merely a `dropped` log entry (#2040 Task 8)', () => {
    // Round 3's finding: the fourth collapse site pushed the loser's id into
    // `dropped` (a log array nothing else reads) and `continue`d past the
    // row — no path from the loser's id back to the survivor. Pin that the
    // retirement is now reported so the caller can record it.
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
      { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
    ];
    const { cast, retirements } = dedupePriorCastByName(prior, undefined);
    expect(cast.map((c) => c.id)).toEqual(['anton']); // stronger voiceState survives
    expect(retirements).toEqual([{ from: 'антон', to: 'anton' }]);
  });

  it('collapses two same-name voiced rows to one survivor', () => {
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
      { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior, undefined);
    expect(cast).toHaveLength(1);
    expect(cast[0].id).toBe('anton'); // stronger voiceState survives
    expect(cast[0].voiceUuid).toBe('U1');
    expect(dropped.map((d) => d.id)).toEqual(['антон']);
  });

  it('prefers a bespoke designed voice over a reuse link (Coalfall guard)', () => {
    const prior: C[] = [
      { id: 'a-reused', name: 'Света', voiceState: 'reused', voiceId: 'lib-1' },
      {
        id: 'a-bespoke',
        name: 'Света',
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'q-sveta' } },
      },
    ];
    const { cast } = dedupePriorCastByName(prior, undefined);
    expect(cast).toHaveLength(1);
    expect(cast[0].id).toBe('a-bespoke'); // bespoke beats reuse despite weaker voiceState
    expect(cast[0].overrideTtsVoices).toEqual({ qwen: { name: 'q-sveta' } });
  });

  it('folds the dropped row name into the survivor aliases', () => {
    const prior: C[] = [
      { id: 'boris', name: 'Борис Игнатьевич', voiceState: 'tuned', lines: 30, aliases: ['шеф'] },
      { id: 'boris-2', name: 'Борис Игнатьевич', voiceState: 'generated', lines: 1, aliases: ['Гесер'] },
    ];
    const { cast } = dedupePriorCastByName(prior, undefined);
    expect(cast).toHaveLength(1);
    expect(cast[0].aliases).toEqual(expect.arrayContaining(['шеф', 'Гесер']));
    // survivor's own name is NOT folded in as a redundant alias
    expect(cast[0].aliases).not.toContain('Борис Игнатьевич');
  });

  it('does NOT collapse a notLinkedTo-separated same-name pair', () => {
    const prior: C[] = [
      { id: 'john-a', name: 'John', voiceState: 'tuned', notLinkedTo: [{ bookId: 'b', characterId: 'john-b' }] },
      { id: 'john-b', name: 'John', voiceState: 'tuned' },
    ];
    const { cast } = dedupePriorCastByName(prior, undefined);
    expect(cast).toHaveLength(2);
  });

  it('collapses a pair whose only notLinkedTo edge was recorded in ANOTHER book (#3965)', () => {
    const prior: C[] = [
      { id: 'tom', name: 'Old Tom', voiceState: 'locked', notLinkedTo: [{ bookId: 'book-1', characterId: 'tom' }] },
      { id: 'tom-2', name: 'Old Tom', voiceState: 'generated', notLinkedTo: [{ bookId: 'book-1', characterId: 'tom' }] },
    ];
    const { cast, retirements } = dedupePriorCastByName(prior, 'book-2');
    expect(cast.map((r) => r.id)).toEqual(['tom']);
    expect(retirements).toEqual([{ from: 'tom-2', to: 'tom' }]);
  });

  it('still refuses to collapse a pair separated by a SAME-book notLinkedTo edge (#3965)', () => {
    const prior: C[] = [
      { id: 'john-a', name: 'John', voiceState: 'tuned', notLinkedTo: [{ bookId: 'book-2', characterId: 'john-b' }] },
      { id: 'john-b', name: 'John', voiceState: 'tuned' },
    ];
    expect(dedupePriorCastByName(prior, 'book-2').cast).toHaveLength(2);
  });

  it('still refuses to collapse a pair separated by a legacy notLinkedTo entry with no bookId (#3965)', () => {
    const prior: C[] = [
      { id: 'john-a', name: 'John', voiceState: 'tuned', notLinkedTo: [{ characterId: 'john-b' }] },
      { id: 'john-b', name: 'John', voiceState: 'tuned' },
    ];
    expect(dedupePriorCastByName(prior, 'book-2').cast).toHaveLength(2);
  });

  it('the collapse unions every dropped notLinkedTo onto the survivor, deduped by (bookId, characterId) (#3965)', () => {
    const shared = { bookId: 'book-1', characterId: 'tom' };
    const prior: C[] = [
      { id: 'tom', name: 'Old Tom', voiceState: 'locked', lines: 0, notLinkedTo: [shared] },
      { id: 'tom-2', name: 'Old Tom', lines: 3, notLinkedTo: [{ ...shared }, { bookId: 'book-3', characterId: 'x' }] },
    ];
    const { cast } = dedupePriorCastByName(prior, 'book-2');
    expect(cast.map((r) => r.id)).toEqual(['tom']);
    expect(cast[0].notLinkedTo).toEqual([shared, { bookId: 'book-3', characterId: 'x' }]);
    expect(prior[0].notLinkedTo).toEqual([shared]);
  });

  it('the collapse carries both decline markers of every dropped row onto the survivor (#3992)', () => {
    const prior: C[] = [
      { id: 'tom', name: 'Old Tom', voiceState: 'locked', lines: 0, declinedVoiceFrom: ['book-1'], declinedVoiceUuids: ['u1'] },
      { id: 'tom-2', name: 'Old Tom', lines: 3, declinedVoiceFrom: ['book-1', 'book-3'], declinedVoiceUuids: ['u2'] },
    ];
    const { cast } = dedupePriorCastByName(prior, 'book-2');
    expect(cast.map((r) => r.id)).toEqual(['tom']);
    expect(cast[0].declinedVoiceFrom).toEqual(['book-1', 'book-3']);
    expect(cast[0].declinedVoiceUuids).toEqual(['u1', 'u2']);
    expect(prior[0].declinedVoiceFrom).toEqual(['book-1']);
  });

  it('a collapse where no row declined a voice adds no marker keys (#3992)', () => {
    const prior: C[] = [
      { id: 'tom', name: 'Old Tom', voiceState: 'locked', lines: 0 },
      { id: 'tom-2', name: 'Old Tom', lines: 3 },
    ];
    const { cast } = dedupePriorCastByName(prior, 'book-2');
    expect(cast[0]).not.toHaveProperty('declinedVoiceFrom');
    expect(cast[0]).not.toHaveProperty('declinedVoiceUuids');
  });

  it("a row's own SAME-book self-naming edge still blocks the collapse; a cross-book one does not (#3965)", () => {
    // The seed writes the reject-orphan edge onto the re-minted orphan itself,
    // so a self-edge is the surviving record of a rejected pair.
    const prior: C[] = [
      { id: 'a', name: 'X', notLinkedTo: [{ bookId: 'b1', characterId: 'a' }] },
      { id: 'b', name: 'X' },
    ];
    expect(dedupePriorCastByName(prior, undefined).cast).toHaveLength(2);
    expect(dedupePriorCastByName(prior, 'b1').cast).toHaveLength(2);
    expect(dedupePriorCastByName(prior, 'b2').cast).toHaveLength(1);
  });

  it("refuses a collapse when one row declines the link another row carries in matchedFrom (#3965)", () => {
    // The decline is cross-book ({book-1, old-tom} in book-2), so the id-edge
    // gate ignores it; but fusing the rows would hand the declined link to the
    // survivor, which the next run's linker then lands.
    const linked: C = {
      id: 'thomas',
      name: 'Old Tom',
      voiceState: 'reused',
      voiceId: 'v_b1',
      lines: 0,
      matchedFrom: { bookId: 'book-1', characterId: 'old-tom' },
    };
    const declining: C = {
      id: 'old-tom',
      name: 'Old Tom',
      lines: 3,
      notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
    };
    expect(dedupePriorCastByName([linked, declining], 'book-2').cast).toHaveLength(2);
    expect(dedupePriorCastByName([declining, linked], 'book-2').cast).toHaveLength(2);
    // A bare-string decline of the same target blocks too.
    expect(
      dedupePriorCastByName([linked, { ...declining, notLinkedTo: ['old-tom'] }], 'book-2').cast,
    ).toHaveLength(2);
  });

  it('a bare-string or bookId-less decline of the link target blocks, with a target no member owns (#3965)', () => {
    const linked: C = {
      id: 'thomas',
      name: 'Old Tom',
      voiceState: 'reused',
      voiceId: 'v_b1',
      lines: 0,
      matchedFrom: { bookId: 'book-1', characterId: 'tom-b1' },
    };
    const decliner = (notLinkedTo: unknown[]): C => ({
      id: 'old-tom',
      name: 'Old Tom',
      lines: 3,
      notLinkedTo,
    });
    expect(dedupePriorCastByName([linked, decliner(['tom-b1'])], 'book-2').cast).toHaveLength(2);
    expect(
      dedupePriorCastByName([linked, decliner([{ characterId: 'tom-b1' }])], 'book-2').cast,
    ).toHaveLength(2);
    // Controls: a different bare string / a different book still collapse.
    expect(dedupePriorCastByName([linked, decliner(['other'])], 'book-2').cast).toHaveLength(1);
    expect(
      dedupePriorCastByName([linked, decliner([{ bookId: 'book-3', characterId: 'tom-b1' }])], 'book-2')
        .cast,
    ).toHaveLength(1);
  });

  it('the union keeps a loser decline of the same character in ANOTHER book (#3965)', () => {
    const prior: C[] = [
      { id: 'tom', name: 'Old Tom', voiceState: 'locked', lines: 0, notLinkedTo: [{ bookId: 'book-1', characterId: 'tom' }] },
      { id: 'tom-2', name: 'Old Tom', lines: 3, notLinkedTo: [{ bookId: 'book-3', characterId: 'tom' }] },
    ];
    const { cast } = dedupePriorCastByName(prior, 'book-2');
    expect(cast.map((r) => r.id)).toEqual(['tom']);
    expect(cast[0].notLinkedTo).toEqual([
      { bookId: 'book-1', characterId: 'tom' },
      { bookId: 'book-3', characterId: 'tom' },
    ]);
  });

  it('collapses when the decline names a different book or a different target than the other row’s link (#3965)', () => {
    const linked: C = {
      id: 'thomas',
      name: 'Old Tom',
      voiceState: 'reused',
      voiceId: 'v_b1',
      lines: 0,
      matchedFrom: { bookId: 'book-1', characterId: 'old-tom' },
    };
    const otherBook: C = {
      id: 'old-tom',
      name: 'Old Tom',
      lines: 3,
      notLinkedTo: [{ bookId: 'book-3', characterId: 'old-tom' }],
    };
    const otherTarget: C = {
      id: 'old-tom',
      name: 'Old Tom',
      lines: 3,
      notLinkedTo: [{ bookId: 'book-1', characterId: 'someone-else' }],
    };
    expect(dedupePriorCastByName([linked, otherBook], 'book-2').cast).toHaveLength(1);
    expect(dedupePriorCastByName([linked, otherTarget], 'book-2').cast).toHaveLength(1);
  });

  it('two locked same-name rows with different voices DO collapse, keeping the row with the lines (#3965, owner-confirmed)', () => {
    const prior: C[] = [
      { id: 'mira', name: 'Mira', voiceState: 'locked', voiceId: 'v_a', lines: 0 },
      { id: 'mira-2', name: 'Mira', voiceState: 'locked', voiceId: 'v_b', lines: 3 },
    ];
    const { cast, retirements } = dedupePriorCastByName(prior, 'book-2');
    expect(cast.map((r) => r.id)).toEqual(['mira-2']);
    expect(cast[0].voiceId).toBe('v_b');
    expect(retirements).toEqual([{ from: 'mira', to: 'mira-2' }]);
  });

  it('never collapses narrator rows sharing a name', () => {
    const prior: C[] = [
      { id: 'narrator', name: 'Narrator', voiceState: 'tuned' },
      { id: 'char-narrator', name: 'Narrator', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior, undefined);
    expect(cast).toHaveLength(2);
  });

  it('excludes a char-narrator row from grouping even when a REAL character shares its name (#1895)', () => {
    /* Discriminating fixture: unlike the narrator-vs-narrator pair above (a
       size-1 group either way, so it can't tell isNarrator's id-check apart
       from a no-op), this narrator shares its name with an UNRELATED real
       character. If 'char-narrator' were ever NOT recognised as a narrator
       id, it would fall into the same name-group as 'sasha-2' (group size
       2) and get collapsed away — losing the narrator row entirely. */
    const prior: C[] = [
      { id: 'char-narrator', name: 'Sasha', voiceState: 'tuned' },
      { id: 'sasha-2', name: 'Sasha', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior, undefined);
    expect(cast.map((c) => c.id).sort()).toEqual(['char-narrator', 'sasha-2']);
  });

  it('leaves distinct names untouched and preserves order', () => {
    const prior: C[] = [
      { id: 'a', name: 'Alice', voiceState: 'tuned' },
      { id: 'b', name: 'Bob', voiceState: 'tuned' },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior, undefined);
    expect(cast.map((c) => c.id)).toEqual(['a', 'b']);
    expect(dropped).toEqual([]);
  });

  it('collapses accent-variant spellings (normaliseNameKey deburrs Latin)', () => {
    const prior: C[] = [
      { id: 'cafe', name: 'Cafe', voiceState: 'generated', voiceUuid: 'U2' },
      { id: 'café', name: 'Café', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior, undefined);
    expect(cast).toHaveLength(1);
  });
});

describe('dedupePriorCastByName — suggestions, dismissals and the run ledger (#4031 A11)', () => {
  const pair = (): C[] => [
    { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
    { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
  ];
  const none = { openSuggestions: [], notSamePerson: [], skipIds: new Set<string>() };
  const suggestion = (x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    return { sourceId: x, targetId: y, a, b, reason: 'r', origin: 'plan' as const };
  };

  it('A11: identical names heal and report a retirement', () => {
    const { cast, retirements } = dedupePriorCastByName(pair(), undefined, none);
    expect(cast.map((c) => c.id)).toEqual(['anton']);
    expect(retirements).toEqual([{ from: 'антон', to: 'anton' }]);
  });

  it('A11: no heal across a dismissal record', () => {
    const { cast, retirements } = dedupePriorCastByName(pair(), undefined, {
      ...none,
      notSamePerson: [{ a: 'anton', b: 'антон', at: '2026-01-01T00:00:00.000Z' }],
    });
    expect(cast).toHaveLength(2);
    expect(retirements).toEqual([]);
  });

  it('A11: a dismissal record is honoured in either order (unsorted record)', () => {
    const { cast } = dedupePriorCastByName(pair(), undefined, {
      ...none,
      notSamePerson: [{ a: 'антон', b: 'anton', at: '2026-01-01T00:00:00.000Z' }],
    });
    expect(cast).toHaveLength(2);
  });

  it('A11: healDisabled returns the prior unchanged', () => {
    const { cast, dropped, retirements } = dedupePriorCastByName(pair(), undefined, {
      ...none,
      healDisabled: true,
    });
    expect(cast).toHaveLength(2);
    expect(dropped).toEqual([]);
    expect(retirements).toEqual([]);
  });

  it('A11: no heal when either member has an open suggestion, even to a third row', () => {
    const prior: C[] = [...pair(), { id: 'third', name: 'Другой', voiceState: 'tuned' }];
    for (const member of ['anton', 'антон']) {
      const { cast } = dedupePriorCastByName(prior, undefined, {
        ...none,
        openSuggestions: [suggestion(member, 'third')],
      });
      expect(cast).toHaveLength(3);
    }
  });

  it('A11: no heal across a notLinkedTo edge', () => {
    const prior: C[] = pair();
    prior[0] = { ...prior[0], notLinkedTo: ['антон'] };
    expect(dedupePriorCastByName(prior, undefined, none).cast).toHaveLength(2);
  });

  it('the heal never touches a skipIds row', () => {
    const { cast, retirements } = dedupePriorCastByName(pair(), undefined, {
      ...none,
      skipIds: new Set(['антон']),
    });
    expect(cast).toHaveLength(2);
    expect(retirements).toEqual([]);
  });
});
