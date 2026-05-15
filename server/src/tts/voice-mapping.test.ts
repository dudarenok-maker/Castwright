/* Static self-consistency tests for each engine's voice tables. Catches
   "wrong voices used for wrong models" drift at its source: the picker's
   PROFILE_VOICES table and the cast view's VOICE_DESCRIPTIONS table for
   each engine must stay in lockstep. When they drift, the picker chooses
   a voice that has no UI label, or the cast view shows a voice the
   picker will never select.

   These run at every build/test cycle — any unsynchronised edit to one
   side of the pair fails the test instead of shipping silently. */

import { describe, it, expect } from 'vitest';
import { auditEngineCatalog, pickVoiceForEngine } from './voice-mapping.js';

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

describe('pickVoiceForEngine honours the per-cast overrideTtsVoice', () => {
  /* The override is the user's manual reassignment of a cast member's TTS
     voice (e.g. "make Brann use Coqui · Asya Anara"). When set AND its
     engine matches the synth engine, attribute inference is skipped and
     the named speaker is used verbatim. Cross-engine overrides are kept
     on the cast record but ignored at synth time. */

  it('returns the override name verbatim when the engine matches', () => {
    const picked = pickVoiceForEngine(
      'coqui',
      {
        id: 'char-Brann',
        character: 'Brann',
        attributes: ['Male', 'Teen'],
        overrideTtsVoice: { engine: 'coqui', name: 'Asya Anara' },
      },
      { gender: 'male', ageRange: 'teen' },
    );
    expect(picked).toBe('Asya Anara');
  });

  it('falls through to attribute inference when the override engine differs from the synth engine', () => {
    /* Override says "Gemini · Charon" but the synth engine is Coqui. The
       picker must pretend the override doesn't exist and pick from the
       Coqui catalog — anything else would route a Gemini speaker name to
       the Coqui sidecar and 500 the chapter. */
    const picked = pickVoiceForEngine(
      'coqui',
      {
        id: 'char-Brann',
        character: 'Brann',
        attributes: [],
        overrideTtsVoice: { engine: 'gemini', name: 'Charon' },
      },
      { gender: 'male', ageRange: 'adult' },
    );
    expect(picked).not.toBe('Charon');
    /* Picker should land on one of the male-mid Coqui options. */
    expect(['Aaron Dreschner', 'Viktor Menelaos']).toContain(picked);
  });

  it('ignores an override whose name is empty', () => {
    /* A previously-set override that the user cleared lands as an empty
       string in the wire format (clients may send {engine, name: ''}
       instead of override: null). Treat it as no override. */
    const picked = pickVoiceForEngine(
      'coqui',
      {
        id: 'char-Brann',
        character: 'Brann',
        attributes: [],
        overrideTtsVoice: { engine: 'coqui', name: '' },
      },
      { gender: 'female', ageRange: 'adult' },
    );
    expect(picked).not.toBe('');
    /* Should land on a female-mid Coqui option. */
    expect(['Daisy Studious', 'Sofia Hellen']).toContain(picked);
  });

  it('null override is the same as no override', () => {
    const withNull = pickVoiceForEngine(
      'coqui',
      { id: 'x', character: 'X', attributes: [], overrideTtsVoice: null },
      { gender: 'male' },
    );
    const withoutKey = pickVoiceForEngine(
      'coqui',
      { id: 'x', character: 'X', attributes: [] },
      { gender: 'male' },
    );
    expect(withNull).toBe(withoutKey);
  });
});
