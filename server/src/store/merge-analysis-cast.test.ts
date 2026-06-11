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
} from './merge-analysis-cast.js';

type C = Record<string, unknown> & { id: string };

describe('mergeAnalysisResultWithExistingCast', () => {
  it('preserves a designed Qwen voice when the character survives re-analysis', () => {
    const existing: C[] = [
      {
        id: 'Berrin',
        name: 'Berrin',
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-Berrin' } },
        lines: 58,
      },
    ];
    const fresh: C[] = [{ id: 'Berrin', name: 'Berrin', lines: 61 }]; // re-attributed, no voice
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-Berrin' } });
    expect(merged[0].voiceState).toBe('generated');
    expect(merged[0].lines).toBe(61); // fresh attribution wins
  });

  it('preserves a reused-voice link (voiceId/voiceState/matchedFrom)', () => {
    const existing: C[] = [
      {
        id: 'Wisp',
        name: 'Wisp',
        voiceId: 'Wisp',
        voiceState: 'reused',
        matchedFrom: { bookId: 'unlocked', characterId: 'Wisp', confidence: 0.94 },
        overrideTtsVoices: { qwen: { name: 'qwen-Wisp' } },
      },
    ];
    const fresh: C[] = [{ id: 'Wisp', name: 'Wisp' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('Wisp');
    expect(merged[0].voiceState).toBe('reused');
    expect(merged[0].matchedFrom).toEqual({ bookId: 'unlocked', characterId: 'Wisp', confidence: 0.94 });
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-Wisp' } });
  });

  it('keeps a brand-new character (not in the old cast) as-is', () => {
    const existing: C[] = [{ id: 'Wren', voiceId: 'Wren' }];
    const fresh: C[] = [
      { id: 'Wren' },
      { id: 'newbie', name: 'Newbie' }, // first detected this run
    ];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['Wren', 'newbie']);
    expect(merged[1].voiceId).toBeUndefined();
  });

  it('carries forward a voiced/reused character the re-analysis dropped (srv-13)', () => {
    const existing: C[] = [
      { id: 'Wren', voiceId: 'Wren' },
      {
        id: 'gone',
        name: 'Gone',
        voiceState: 'reused',
        voiceId: 'gone',
        overrideTtsVoices: { qwen: { name: 'qwen-gone' } },
      },
    ];
    const fresh: C[] = [{ id: 'Wren' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['Wren', 'gone']);
    const gone = merged.find((c) => c.id === 'gone')!;
    expect(gone.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-gone' } });
  });

  it('does NOT re-add a dropped character that carries no voice/reuse fields', () => {
    const existing: C[] = [
      { id: 'Wren', voiceId: 'Wren' },
      { id: 'extra', name: 'Extra', voiceState: 'generated' }, // nothing to rescue
    ];
    const fresh: C[] = [{ id: 'Wren' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['Wren']);
  });

  it('preserves notLinkedTo (analyzer never emits it)', () => {
    const existing: C[] = [
      { id: 'Wren', notLinkedTo: [{ bookId: 'b1', characterId: 'Wren-teen' }] },
    ];
    const fresh: C[] = [{ id: 'Wren', name: 'Wren' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'Wren-teen' }]);
  });

  it('UNIONS aliases (old ∪ fresh) instead of replacing', () => {
    const existing: C[] = [{ id: 'Marlow', aliases: ['Marlow', 'Sir Singe'] }];
    const fresh: C[] = [{ id: 'Marlow', name: 'Marlow Halden', aliases: ['Marlow', 'Mr. Halden'] }];
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
        id: 'Wren',
        notLinkedTo: [{ bookId: 'b1', characterId: 'Wren-teen' }],
        matchedFrom: { bookId: 'b0', characterId: 'Wren', confidence: 0.9 },
      },
    ];
    const fresh: C[] = [{ id: 'Wren', name: 'Wren' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'Wren-teen' }]);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'Wren', confidence: 0.9 });
  });

  it('does not overwrite a guard field the fresh roster already carries', () => {
    const existing: C[] = [{ id: 'a', matchedFrom: { bookId: 'old', characterId: 'a' } }];
    const fresh: C[] = [{ id: 'a', matchedFrom: { bookId: 'new', characterId: 'a' } }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect((fresh[0].matchedFrom as { bookId: string }).bookId).toBe('new');
  });
});

describe('voicedSurvivorsDropped', () => {
  it('lists only voiced/reused characters the fresh roster omitted', () => {
    const existing: C[] = [
      { id: 'Wren', name: 'Wren', voiceId: 'Wren' }, // survives
      { id: 'Wisp', name: 'Wisp', voiceState: 'reused', voiceId: 'Wisp' }, // dropped + voiced
      { id: 'extra', name: 'Extra' }, // dropped but no voice
    ];
    const fresh: C[] = [{ id: 'Wren' }];
    expect(voicedSurvivorsDropped(existing, fresh)).toEqual([{ id: 'Wisp', name: 'Wisp' }]);
  });

  it("lets a fresh reuse-link stand when the old character had no voice", () => {
    // linkSeriesReuseAtAnalysis may have stamped a NEW reuse on the fresh roster
    // for a character that previously had no voice — don't clobber it with the
    // (absent) old value.
    const existing: C[] = [{ id: 'Hart', name: 'Hart' }]; // no voice
    const fresh: C[] = [{ id: 'Hart', name: 'Hart', voiceId: 'Hart', voiceState: 'reused' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('Hart');
    expect(merged[0].voiceState).toBe('reused');
  });

  it('returns the fresh roster unchanged when there is no existing cast', () => {
    const fresh: C[] = [{ id: 'a' }, { id: 'b' }];
    expect(mergeAnalysisResultWithExistingCast([], fresh)).toEqual(fresh);
  });
});
