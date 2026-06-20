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
