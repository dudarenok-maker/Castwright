/* Re-analysis must not strip designed voices (bug #518). When a manuscript is
   re-analysed, the pipeline builds a FRESH roster from the analyzer (no voice
   fields) and overwrites cast.json — dropping each character's designed-voice
   link (`overrideTtsVoices`, `voiceId`, `voiceState`, `matchedFrom`, …). The
   2026-06-05 incident: navigating to the analysing URL re-ran analysis and
   stripped the Qwen voices from 10 Stellarlune characters.

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
        id: 'maruca',
        name: 'Maruca',
        voiceState: 'generated',
        overrideTtsVoices: { qwen: { name: 'qwen-maruca' } },
        lines: 58,
      },
    ];
    const fresh: C[] = [{ id: 'maruca', name: 'Maruca', lines: 61 }]; // re-attributed, no voice
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-maruca' } });
    expect(merged[0].voiceState).toBe('generated');
    expect(merged[0].lines).toBe(61); // fresh attribution wins
  });

  it('preserves a reused-voice link (voiceId/voiceState/matchedFrom)', () => {
    const existing: C[] = [
      {
        id: 'flori',
        name: 'Flori',
        voiceId: 'flori',
        voiceState: 'reused',
        matchedFrom: { bookId: 'unlocked', characterId: 'flori', confidence: 0.94 },
        overrideTtsVoices: { qwen: { name: 'qwen-flori' } },
      },
    ];
    const fresh: C[] = [{ id: 'flori', name: 'Flori' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('flori');
    expect(merged[0].voiceState).toBe('reused');
    expect(merged[0].matchedFrom).toEqual({ bookId: 'unlocked', characterId: 'flori', confidence: 0.94 });
    expect(merged[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-flori' } });
  });

  it('keeps a brand-new character (not in the old cast) as-is', () => {
    const existing: C[] = [{ id: 'sophie', voiceId: 'sophie' }];
    const fresh: C[] = [
      { id: 'sophie' },
      { id: 'newbie', name: 'Newbie' }, // first detected this run
    ];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['sophie', 'newbie']);
    expect(merged[1].voiceId).toBeUndefined();
  });

  it('carries forward a voiced/reused character the re-analysis dropped (srv-13)', () => {
    const existing: C[] = [
      { id: 'sophie', voiceId: 'sophie' },
      {
        id: 'gone',
        name: 'Gone',
        voiceState: 'reused',
        voiceId: 'gone',
        overrideTtsVoices: { qwen: { name: 'qwen-gone' } },
      },
    ];
    const fresh: C[] = [{ id: 'sophie' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['sophie', 'gone']);
    const gone = merged.find((c) => c.id === 'gone')!;
    expect(gone.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-gone' } });
  });

  it('does NOT re-add a dropped character that carries no voice/reuse fields', () => {
    const existing: C[] = [
      { id: 'sophie', voiceId: 'sophie' },
      { id: 'extra', name: 'Extra', voiceState: 'generated' }, // nothing to rescue
    ];
    const fresh: C[] = [{ id: 'sophie' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['sophie']);
  });

  it('preserves notLinkedTo (analyzer never emits it)', () => {
    const existing: C[] = [
      { id: 'sophie', notLinkedTo: [{ bookId: 'b1', characterId: 'sophie-teen' }] },
    ];
    const fresh: C[] = [{ id: 'sophie', name: 'Sophie' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'sophie-teen' }]);
  });

  it('UNIONS aliases (old ∪ fresh) instead of replacing', () => {
    const existing: C[] = [{ id: 'keefe', aliases: ['Keefe', 'Lord Hunkyhair'] }];
    const fresh: C[] = [{ id: 'keefe', name: 'Keefe Sencen', aliases: ['Keefe', 'Mr. Sencen'] }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].aliases).toEqual(['Keefe', 'Lord Hunkyhair', 'Mr. Sencen']);
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
        id: 'sophie',
        notLinkedTo: [{ bookId: 'b1', characterId: 'sophie-teen' }],
        matchedFrom: { bookId: 'b0', characterId: 'sophie', confidence: 0.9 },
      },
    ];
    const fresh: C[] = [{ id: 'sophie', name: 'Sophie' }];
    seedReuseGuardsFromPriorCast(existing, fresh);
    expect(fresh[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'sophie-teen' }]);
    expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'sophie', confidence: 0.9 });
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
      { id: 'sophie', name: 'Sophie', voiceId: 'sophie' }, // survives
      { id: 'flori', name: 'Flori', voiceState: 'reused', voiceId: 'flori' }, // dropped + voiced
      { id: 'extra', name: 'Extra' }, // dropped but no voice
    ];
    const fresh: C[] = [{ id: 'sophie' }];
    expect(voicedSurvivorsDropped(existing, fresh)).toEqual([{ id: 'flori', name: 'Flori' }]);
  });

  it("lets a fresh reuse-link stand when the old character had no voice", () => {
    // linkSeriesReuseAtAnalysis may have stamped a NEW reuse on the fresh roster
    // for a character that previously had no voice — don't clobber it with the
    // (absent) old value.
    const existing: C[] = [{ id: 'dex', name: 'Dex' }]; // no voice
    const fresh: C[] = [{ id: 'dex', name: 'Dex', voiceId: 'dex', voiceState: 'reused' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged[0].voiceId).toBe('dex');
    expect(merged[0].voiceState).toBe('reused');
  });

  it('returns the fresh roster unchanged when there is no existing cast', () => {
    const fresh: C[] = [{ id: 'a' }, { id: 'b' }];
    expect(mergeAnalysisResultWithExistingCast([], fresh)).toEqual(fresh);
  });
});
