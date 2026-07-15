/* Re-analysis must not strip designed voices (bug #518). When a manuscript is
   re-analysed, the pipeline builds a FRESH roster from the analyzer (no voice
   fields) and overwrites cast.json — dropping each character's designed-voice
   link (`overrideTtsVoices`, `voiceId`, `voiceState`, `matchedFrom`, …). The
   2026-06-05 incident: navigating to the analysing URL re-ran analysis and
   stripped the Qwen voices from 10 The Drowning Bell characters.

   `mergeAnalysisResultWithExistingCast` overlays the existing cast's
   voice-design fields onto the fresh roster (by id), so re-attribution updates
   lines/scenes/evidence/attributes while the designed voices survive. */

import { describe, it, expect } from 'vitest';
import {
  mergeAnalysisResultWithExistingCast,
  seedReuseGuardsFromPriorCast,
  voicedSurvivorsDropped,
  applyRewriteToPriorCast,
  dropReuseContinuityKeepDesignedVoice,
  dedupePriorCastByName,
} from './merge-analysis-cast.js';

type C = Record<string, unknown> & { id: string };

describe('mergeAnalysisResultWithExistingCast', () => {
  it('preserves a designed Qwen voice when the character survives re-analysis', () => {
    const existing: C[] = [
      {
        id: 'berrin',
        name: 'Berrin',
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
        lines: 58,
      },
    ];
    const fresh: C[] = [{ id: 'berrin', name: 'Berrin', lines: 61 }]; // re-attributed, no voice
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
    expect(merged[0].voiceState).toBe('generated');
    expect(merged[0].lines).toBe(61); // fresh attribution wins
  });

  it('preserves a reused-voice link (voiceId/voiceState/matchedFrom)', () => {
    const existing: C[] = [
      {
        id: 'wisp',
        name: 'Wisp',
        voiceId: 'wisp',
        voiceState: 'reused',
        matchedFrom: { bookId: 'unlocked', characterId: 'wisp', confidence: 0.94 },
        overrideTtsVoices: { qwen: { name: 'qwen-wisp' } },
      },
    ];
    const fresh: C[] = [{ id: 'wisp', name: 'Wisp' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('wisp');
    expect(merged[0].voiceState).toBe('reused');
    expect(merged[0].matchedFrom).toEqual({ bookId: 'unlocked', characterId: 'wisp', confidence: 0.94 });
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-wisp' } });
  });

  it('preserves voiceUuid across a reparse/merge (srv-43)', () => {
    const existing: C[] = [
      {
        id: 'wren',
        name: 'Wren',
        voiceState: 'generated',
        voiceUuid: 'U1',
        overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        lines: 20,
      },
    ];
    const fresh: C[] = [{ id: 'wren', name: 'Wren', lines: 25 }]; // re-attributed, no voice fields
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].voiceUuid).toBe('U1');
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-wren' } });
    expect(merged[0].lines).toBe(25); // fresh attribution wins
  });

  it('keeps a brand-new character (not in the old cast) as-is', () => {
    const existing: C[] = [{ id: 'wren', voiceId: 'wren' }];
    const fresh: C[] = [
      { id: 'wren' },
      { id: 'newbie', name: 'Newbie' }, // first detected this run
    ];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['wren', 'newbie']);
    expect(merged[1].voiceId).toBeUndefined();
  });

  it('carries forward a voiced/reused character the re-analysis dropped (srv-13)', () => {
    const existing: C[] = [
      { id: 'wren', voiceId: 'wren' },
      {
        id: 'gone',
        name: 'Gone',
        voiceState: 'reused',
        voiceId: 'gone',
        overrideTtsVoices: { qwen: { name: 'qwen-gone' } },
      },
    ];
    const fresh: C[] = [{ id: 'wren' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['wren', 'gone']);
    const gone = merged.find((c) => c.id === 'gone')!;
    expect(gone.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-gone' } });
  });

  it('does NOT re-add a dropped character that carries no voice/reuse fields', () => {
    const existing: C[] = [
      { id: 'wren', voiceId: 'wren' },
      { id: 'extra', name: 'Extra', voiceState: 'generated' }, // nothing to rescue
    ];
    const fresh: C[] = [{ id: 'wren' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['wren']);
  });

  it('preserves notLinkedTo (analyzer never emits it)', () => {
    const existing: C[] = [
      { id: 'wren', notLinkedTo: [{ bookId: 'b1', characterId: 'wren-teen' }] },
    ];
    const fresh: C[] = [{ id: 'wren', name: 'Wren' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'wren-teen' }]);
  });

  it('UNIONS aliases (old ∪ fresh) instead of replacing', () => {
    const existing: C[] = [{ id: 'marlow', aliases: ['Marlow', 'Sir Singe'] }];
    const fresh: C[] = [{ id: 'marlow', name: 'Marlow Halden', aliases: ['Marlow', 'Mr. Halden'] }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].aliases).toEqual(['Marlow', 'Sir Singe', 'Mr. Halden']);
  });

  it('id drift: a relabelled character carries its voice onto the same-name fresh row (no duplicate)', () => {
    // The analyzer relabelled the dragon `coalfall` -> `coalfall-dragon` between
    // runs. The old voiced row was dropped by id; without the name fallback the
    // fresh `coalfall-dragon` would be voiceless AND old `coalfall` re-added as a
    // 0-line orphan.
    const existing: C[] = [
      {
        id: 'coalfall',
        name: 'Coalfall',
        voiceState: 'tuned',
        voiceId: 'coalfall',
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
      },
    ];
    const fresh: C[] = [{ id: 'coalfall-dragon', name: 'Coalfall', lines: 33 } as C];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    // The descriptive, library-unique fresh id wins; no orphan.
    expect(merged.map((c) => c.id)).toEqual(['coalfall-dragon']);
    const dragon = merged[0];
    expect(dragon.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-coalfall' } });
    expect(dragon.ttsEngine).toBe('qwen');
    expect(dragon.voiceState).toBe('tuned');
    expect((dragon as C).lines).toBe(33); // analyzer-owned fields stay from the fresh row
  });

  it('id drift: an ambiguous name (two fresh rows) falls back to id-only + re-adds the orphan', () => {
    const existing: C[] = [
      {
        id: 'coalfall',
        name: 'Coalfall',
        voiceState: 'tuned',
        overrideTtsVoices: { qwen: { name: 'qwen-coalfall' } },
      },
    ];
    // Two fresh rows share the name → too risky to guess; don't merge by name.
    const fresh: C[] = [
      { id: 'coalfall-dragon', name: 'Coalfall' } as C,
      { id: 'coalfall-other', name: 'Coalfall' } as C,
    ];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['coalfall-dragon', 'coalfall-other', 'coalfall']);
    // The orphan keeps its voice; neither fresh row got it.
    expect(merged.find((c) => c.id === 'coalfall')!.overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-coalfall' },
    });
    expect(merged.find((c) => c.id === 'coalfall-dragon')!.overrideTtsVoices).toBeUndefined();
  });
});

describe('mergeAnalysisResultWithExistingCast — narrator name', () => {
  it('carries forward a user-renamed narrator across reparse', () => {
    const existing = [{ id: 'narrator', name: 'The Bard', voiceStyle: 'crisp herald' }];
    const fresh = [{ id: 'narrator', name: 'Erzähler', role: 'narrator', color: 'narrator' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    const n = merged.find((c) => c.id === 'narrator')!;
    expect(n.name).toBe('The Bard');
    expect((n as { voiceStyle?: string }).voiceStyle).toBe('crisp herald');
  });

  it('takes the fresh name when the prior narrator name was a language default (re-localizes)', () => {
    const existing = [{ id: 'narrator', name: 'Erzähler', voiceStyle: 'crisp herald' }];
    const fresh = [{ id: 'narrator', name: 'Narrateur', role: 'narrator', color: 'narrator' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.find((c) => c.id === 'narrator')!.name).toBe('Narrateur');
  });

  it('does NOT carry forward a non-narrator character name (still recomputed from fresh)', () => {
    const existing = [{ id: 'wren', name: 'Old Wren', voiceId: 'v1' }];
    const fresh = [{ id: 'wren', name: 'Wren', role: 'protagonist', color: 'eliza' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.find((c) => c.id === 'wren')!.name).toBe('Wren');
  });
});

describe('seedReuseGuardsFromPriorCast', () => {
  it('seeds notLinkedTo and matchedFrom onto the fresh roster in place', () => {
    const existing: C[] = [
      {
        id: 'wren',
        notLinkedTo: [{ bookId: 'b1', characterId: 'wren-teen' }],
        matchedFrom: { bookId: 'b0', characterId: 'wren', confidence: 0.9 },
      },
    ];
    const fresh: C[] = [{ id: 'wren', name: 'Wren' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'wren-teen' }]);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'wren', confidence: 0.9 });
  });

  it('does not overwrite a guard field the fresh roster already carries', () => {
    const existing: C[] = [{ id: 'a', matchedFrom: { bookId: 'old', characterId: 'a' } }];
    const fresh: C[] = [{ id: 'a', matchedFrom: { bookId: 'new', characterId: 'a' } }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect((fresh[0].matchedFrom as { bookId: string }).bookId).toBe('new');
  });

  it('seeds onto a same-name survivor when the id was remapped by dedup (collapsed-source)', () => {
    const existing: C[] = [
      {
        id: 'olga',
        name: 'Ольга',
        notLinkedTo: [{ bookId: 'b1', characterId: 'other' }],
        matchedFrom: { bookId: 'b0', characterId: 'olga', confidence: 0.8 },
      },
    ];
    const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'other' }]);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'olga', confidence: 0.8 });
  });

  it('does NOT use the name-fallback when two fresh rows share a name (ambiguous — pre-dedup main route)', () => {
    const existing: C[] = [{ id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'b0', characterId: 'olga' } }];
    const fresh: C[] = [
      { id: 'olga', name: 'Ольга' },
      { id: 'ольга', name: 'Ольга' },
    ];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'olga' }); // id match still works
    expect(fresh[1].matchedFrom).toBeUndefined(); // ambiguous fresh name → not seeded
  });

  it('does NOT use the name-fallback when two prior rows share a name (ambiguous source)', () => {
    const existing: C[] = [
      { id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'b0', characterId: 'olga' } },
      { id: 'olga2', name: 'Ольга', matchedFrom: { bookId: 'b9', characterId: 'olga2' } },
    ];
    const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].matchedFrom).toBeUndefined();
  });

  it('id match takes precedence over the name-fallback', () => {
    const existing: C[] = [
      { id: 'ольга', name: 'Ольга', matchedFrom: { bookId: 'right', characterId: 'ольга' } },
      { id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'wrong', characterId: 'olga' } },
    ];
    const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect((fresh[0].matchedFrom as { bookId: string }).bookId).toBe('right');
  });
});

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

  it("lets a fresh reuse-link stand when the old character had no voice", () => {
    // linkSeriesReuseAtAnalysis may have stamped a NEW reuse on the fresh roster
    // for a character that previously had no voice — don't clobber it with the
    // (absent) old value.
    const existing: C[] = [{ id: 'hart', name: 'Hart' }]; // no voice
    const fresh: C[] = [{ id: 'hart', name: 'Hart', voiceId: 'hart', voiceState: 'reused' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('hart');
    expect(merged[0].voiceState).toBe('reused');
  });

  it('returns the fresh roster unchanged when there is no existing cast', () => {
    const fresh: C[] = [{ id: 'a' }, { id: 'b' }];
    expect(mergeAnalysisResultWithExistingCast([], fresh)).toEqual(fresh);
  });
});

describe('applyRewriteToPriorCast', () => {
  it('remaps prior ids and keeps the strongest voiceState on collision', () => {
    const prior = [
      { id: 'olga', name: 'Ольга', voiceState: 'generated', overrideTtsVoices: { qwen: { name: 'qwen-gen' } } },
      { id: 'ольга', name: 'Ольга', voiceState: 'tuned', overrideTtsVoices: { qwen: { name: 'qwen-tuned' } } },
    ];
    const { priorCast, droppedVoices } = applyRewriteToPriorCast(prior, { olga: 'ольга' });
    const survivor = priorCast.find((c) => c.id === 'ольга');
    expect(survivor?.overrideTtsVoices?.qwen?.name).toBe('qwen-tuned'); // tuned beats generated
    expect(priorCast.filter((c) => c.id === 'ольга')).toHaveLength(1); // no duplicate id
    expect(droppedVoices).toEqual([{ id: 'olga', voiceState: 'generated' }]);
  });
});

describe('dropReuseContinuityKeepDesignedVoice (fresh re-analysis prior)', () => {
  it('keeps the designed voice but drops reuse continuity + reused state', () => {
    const prior: C[] = [
      {
        id: 'anton',
        name: 'Anton',
        voiceUuid: 'U1',
        ttsEngine: 'qwen',
        voiceStyle: 'a persona',
        overrideTtsVoices: { qwen: { name: 'qwen-U1', variants: { excited: { name: 'qwen-U1__excited' } } } },
        voiceId: 'library-voice',
        voiceState: 'reused',
        matchedFrom: { bookId: 'prior', characterId: 'anton', confidence: 0.9 },
        notLinkedTo: ['someone'],
      },
    ];
    const [out] = dropReuseContinuityKeepDesignedVoice(prior);
    // designed voice kept
    expect(out.voiceUuid).toBe('U1');
    expect(out.ttsEngine).toBe('qwen');
    expect(out.voiceStyle).toBe('a persona');
    expect(out.overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-U1', variants: { excited: { name: 'qwen-U1__excited' } } },
    });
    // reuse continuity dropped
    expect(out.voiceId).toBeUndefined();
    expect(out.matchedFrom).toBeUndefined();
    expect(out.notLinkedTo).toBeUndefined();
    expect(out.voiceState).toBeUndefined(); // 'reused' cleared
  });

  it("keeps a bespoke 'locked'/'tuned' voiceState (not reuse-derived)", () => {
    const prior: C[] = [
      { id: 'a', name: 'A', voiceState: 'locked', overrideTtsVoices: { qwen: { name: 'q-a' } } },
      { id: 'b', name: 'B', voiceState: 'tuned', voiceUuid: 'Ub' },
    ];
    const out = dropReuseContinuityKeepDesignedVoice(prior);
    expect(out[0].voiceState).toBe('locked');
    expect(out[1].voiceState).toBe('tuned');
  });

  it('does not mutate the input', () => {
    const prior: C[] = [
      { id: 'a', name: 'A', voiceId: 'v', matchedFrom: { bookId: 'x' }, voiceUuid: 'U' },
    ];
    dropReuseContinuityKeepDesignedVoice(prior);
    expect(prior[0].voiceId).toBe('v');
    expect(prior[0].matchedFrom).toEqual({ bookId: 'x' });
  });
});

describe('dedupePriorCastByName', () => {
  it('collapses two same-name voiced rows to one survivor', () => {
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
      { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior);
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
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
    expect(cast[0].id).toBe('a-bespoke'); // bespoke beats reuse despite weaker voiceState
    expect(cast[0].overrideTtsVoices).toEqual({ qwen: { name: 'q-sveta' } });
  });

  it('folds the dropped row name into the survivor aliases', () => {
    const prior: C[] = [
      { id: 'boris', name: 'Борис Игнатьевич', voiceState: 'tuned', lines: 30, aliases: ['шеф'] },
      { id: 'boris-2', name: 'Борис Игнатьевич', voiceState: 'generated', lines: 1, aliases: ['Гесер'] },
    ];
    const { cast } = dedupePriorCastByName(prior);
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
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(2);
  });

  it('never collapses narrator rows sharing a name', () => {
    const prior: C[] = [
      { id: 'narrator', name: 'Narrator', voiceState: 'tuned' },
      { id: 'char-narrator', name: 'Narrator', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(2);
  });

  it('leaves distinct names untouched and preserves order', () => {
    const prior: C[] = [
      { id: 'a', name: 'Alice', voiceState: 'tuned' },
      { id: 'b', name: 'Bob', voiceState: 'tuned' },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior);
    expect(cast.map((c) => c.id)).toEqual(['a', 'b']);
    expect(dropped).toEqual([]);
  });

  it('collapses accent-variant spellings (normaliseNameKey deburrs Latin)', () => {
    const prior: C[] = [
      { id: 'cafe', name: 'Cafe', voiceState: 'generated', voiceUuid: 'U2' },
      { id: 'café', name: 'Café', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
  });
});
