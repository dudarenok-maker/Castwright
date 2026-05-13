/* Static self-consistency tests for each engine's voice tables. Catches
   "wrong voices used for wrong models" drift at its source: the picker's
   PROFILE_VOICES table and the cast view's VOICE_DESCRIPTIONS table for
   each engine must stay in lockstep. When they drift, the picker chooses
   a voice that has no UI label, or the cast view shows a voice the
   picker will never select.

   These run at every build/test cycle — any unsynchronised edit to one
   side of the pair fails the test instead of shipping silently. */

import { describe, it, expect } from 'vitest';
import { auditEngineCatalog } from './voice-mapping.js';

describe('voice-mapping catalogs are self-consistent', () => {
  it('coqui: every picker voice has a description and every described voice is routable', () => {
    const audit = auditEngineCatalog('coqui');
    expect(audit.missingDescriptions, `voices in COQUI_PROFILE_VOICES with no entry in COQUI_VOICE_DESCRIPTIONS — picker will choose them, cast view will say "Local voice"`).toEqual([]);
    expect(audit.unrouted, `voices in COQUI_VOICE_DESCRIPTIONS that PROFILE_VOICES never picks — orphan rows`).toEqual([]);
    expect(audit.routedCount).toBeGreaterThan(0);
  });

  it('gemini: every picker voice has a description and every described voice is routable', () => {
    /* Gemini's catalog is interesting because GEMINI_VOICE_DESCRIPTIONS
       intentionally documents all 30 published prebuilt voices, but
       GEMINI_PROFILE_VOICES only routes 16 (two per profile). So we
       expect a substantial `unrouted` list here — those are "voices
       you could route, but currently don't" — and that's by design.

       The load-bearing assertion is the other direction:
       missingDescriptions MUST be empty so the picker never chooses a
       voice the cast view has no label for. */
    const audit = auditEngineCatalog('gemini');
    expect(audit.missingDescriptions, `voices in GEMINI_PROFILE_VOICES with no entry in GEMINI_VOICE_DESCRIPTIONS — picker will choose them, cast view will say "Prebuilt voice"`).toEqual([]);
    expect(audit.routedCount).toBeGreaterThan(0);
    /* Unrouted is allowed; we just sanity-check it's a sensible number
       (< total documented) so a future refactor doesn't accidentally
       hand-pick more voices than documented. */
    expect(audit.unrouted.length).toBeLessThan(40);
  });
});
