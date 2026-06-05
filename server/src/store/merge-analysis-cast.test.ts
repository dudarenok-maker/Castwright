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
import { mergeAnalysisResultWithExistingCast } from './merge-analysis-cast.js';

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

  it("does NOT re-add a character the re-analysis dropped (roster shrink is separate)", () => {
    const existing: C[] = [
      { id: 'Wren', voiceId: 'Wren' },
      { id: 'gone', voiceId: 'gone', voiceState: 'generated' },
    ];
    const fresh: C[] = [{ id: 'Wren' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.map((c) => c.id)).toEqual(['Wren']);
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
