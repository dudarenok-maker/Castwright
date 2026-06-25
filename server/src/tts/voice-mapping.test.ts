/* Static self-consistency tests for each engine's voice tables. Catches
   "wrong voices used for wrong models" drift at its source: the picker's
   PROFILE_VOICES table and the cast view's VOICE_DESCRIPTIONS table for
   each engine must stay in lockstep. When they drift, the picker chooses
   a voice that has no UI label, or the cast view shows a voice the
   picker will never select.

   These run at every build/test cycle — any unsynchronised edit to one
   side of the pair fails the test instead of shipping silently. */

import { describe, it, expect } from 'vitest';
import {
  auditEngineCatalog,
  pickVoiceForEngine,
  pickEmotionVariantVoice,
  resolveVoiceAssignment,
  qwenStorageKey,
  KOKORO_PROFILE_VOICES,
} from './voice-mapping.js';

describe('voice-mapping catalogs are self-consistent', () => {
  it('coqui: every picker voice has a description and every described voice is routable', () => {
    const audit = auditEngineCatalog('coqui');
    expect(
      audit.missingDescriptions,
      `voices in COQUI_PROFILE_VOICES with no entry in COQUI_VOICE_DESCRIPTIONS — picker will choose them, cast view will say "Local voice"`,
    ).toEqual([]);
    expect(
      audit.unrouted,
      `voices in COQUI_VOICE_DESCRIPTIONS that PROFILE_VOICES never picks — orphan rows`,
    ).toEqual([]);
    expect(audit.routedCount).toBeGreaterThan(0);
  });

  it('kokoro: every picker voice has a description and every described voice is routable', () => {
    /* Kokoro is English-only by project scope (sidecar filter at
       KokoroEngine.ENGLISH_VOICE_PREFIXES). The picker tables must match
       the same af_/am_/bf_/bm_ shape — anything else would route a voice
       the sidecar will substitute, masking a real catalog drift. */
    const audit = auditEngineCatalog('kokoro');
    expect(
      audit.missingDescriptions,
      `voices in KOKORO_PROFILE_VOICES with no entry in KOKORO_VOICE_DESCRIPTIONS — picker will choose them, cast view will say "Local voice"`,
    ).toEqual([]);
    expect(
      audit.unrouted,
      `voices in KOKORO_VOICE_DESCRIPTIONS that PROFILE_VOICES never picks — orphan rows`,
    ).toEqual([]);
    expect(audit.routedCount).toBeGreaterThan(0);
  });

  it('kokoro: every routed voice has an af_/am_/bf_/bm_ prefix (English-only scope)', () => {
    /* Load-bearing for this project: non-English Kokoro voices are
       filtered out at the sidecar boundary (KokoroEngine.ENGLISH_VOICE_
       PREFIXES). The picker tables must mirror that filter — a non-
       English voice in KOKORO_PROFILE_VOICES would have the sidecar
       silently substitute af_heart, masking a real catalog drift. */
    const englishPrefixes = ['af_', 'am_', 'bf_', 'bm_'];
    const names = new Set<string>();
    for (const opts of Object.values(KOKORO_PROFILE_VOICES)) {
      for (const n of opts) names.add(n);
    }
    for (const name of names) {
      expect(
        englishPrefixes.some((p) => name.startsWith(p)),
        `KOKORO_PROFILE_VOICES contains non-English voice '${name}' — must be af_/am_/bf_/bm_`,
      ).toBe(true);
    }
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
    expect(
      audit.missingDescriptions,
      `voices in GEMINI_PROFILE_VOICES with no entry in GEMINI_VOICE_DESCRIPTIONS — picker will choose them, cast view will say "Prebuilt voice"`,
    ).toEqual([]);
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
        id: 'char-brann',
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
        id: 'char-brann',
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
        id: 'char-brann',
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

  it('routes the override verbatim for kokoro when the engine matches', () => {
    /* Same shape as the coqui case: an explicit per-cast Kokoro override
       takes precedence over profile inference. Different engine matrix
       though — Kokoro names have af_/am_/bf_/bm_ prefixes, so a stray
       Coqui-shaped name would be a clear bug. */
    const picked = pickVoiceForEngine(
      'kokoro',
      {
        id: 'char-brann',
        character: 'Brann',
        attributes: [],
        overrideTtsVoice: { engine: 'kokoro', name: 'am_onyx' },
      },
      { gender: 'male', ageRange: 'adult' },
    );
    expect(picked).toBe('am_onyx');
  });

  it('falls through to Kokoro profile inference when override engine is coqui', () => {
    /* Cross-engine override is ignored at synth time — the synth engine
       is kokoro, the override says coqui, so the picker must derive from
       KOKORO_PROFILE_VOICES instead. Output should be one of the Kokoro
       male-mid options, not the Coqui name from the override. */
    const picked = pickVoiceForEngine(
      'kokoro',
      {
        id: 'char-brann',
        character: 'Brann',
        attributes: [],
        overrideTtsVoice: { engine: 'coqui', name: 'Aaron Dreschner' },
      },
      { gender: 'male', ageRange: 'adult' },
    );
    expect(picked).not.toBe('Aaron Dreschner');
    expect(['am_michael', 'am_adam']).toContain(picked);
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

describe('qwen is a bespoke-voice engine — no catalog inference (plan 108)', () => {
  /* Qwen voices are designed per character (design -> clone -> cache ->
     reuse), not picked from a profile table. A Qwen character MUST carry an
     explicit designed voiceId in overrideTtsVoices.qwen; with none, there's
     nothing to infer — the picker returns '' (not a fallback voice). */

  it('returns the storage key for the designed qwen voice (uuid-less falls back to qwen-<id>)', () => {
    /* srv-43: without a voiceUuid, qwenStorageKey falls back to qwen-<voice.id>.
       voice.id = voiceId ?? characterId; here voiceId is not set so id='char-maerin'. */
    const picked = pickVoiceForEngine(
      'qwen',
      {
        id: 'char-maerin',
        character: 'Maerin',
        attributes: ['Female', 'Teen'],
        overrideTtsVoices: { qwen: { name: 'qwen-char-maerin' } },
      },
      { gender: 'female', ageRange: 'teen' },
    );
    expect(picked).toBe('qwen-char-maerin');
  });

  it('returns "" (no fallback) when no qwen voice has been designed', () => {
    /* The load-bearing invariant: unlike the preset engines, Qwen does NOT
       fall through to attribute inference — there is no catalog. An empty
       string signals "design one first" to the UI / generation path. */
    const picked = pickVoiceForEngine(
      'qwen',
      { id: 'char-maerin', character: 'Maerin', attributes: ['Female', 'Teen'] },
      { gender: 'female', ageRange: 'teen' },
    );
    expect(picked).toBe('');
  });

  it('ignores a non-qwen override slot (each engine reads its own slot)', () => {
    const picked = pickVoiceForEngine(
      'qwen',
      {
        id: 'char-maerin',
        character: 'Maerin',
        attributes: [],
        overrideTtsVoices: { kokoro: { name: 'af_bella' } },
      },
      { gender: 'female' },
    );
    expect(picked).toBe('');
  });

  it('resolveVoiceAssignment labels designed vs undesigned qwen voices', () => {
    const undesigned = resolveVoiceAssignment(
      'qwen',
      { id: 'char-x', character: 'X', attributes: [] },
      { gender: 'female' },
    );
    expect(undesigned).toEqual({
      provider: 'qwen',
      name: '',
      description: 'No voice designed yet',
    });
    /* srv-43: the name returned is now the storage key (qwen-<id> without uuid),
       not the raw overrideTtsVoices.qwen.name. */
    const designed = resolveVoiceAssignment('qwen', {
      id: 'char-x',
      character: 'X',
      attributes: [],
      overrideTtsVoices: { qwen: { name: 'qwen-char-x' } },
    });
    expect(designed).toEqual({ provider: 'qwen', name: 'qwen-char-x', description: 'Designed voice' });
  });

  it('auditEngineCatalog reports an empty audit for qwen (no static catalog)', () => {
    const audit = auditEngineCatalog('qwen');
    expect(audit).toEqual({
      engine: 'qwen',
      missingDescriptions: [],
      unrouted: [],
      routedCount: 0,
    });
  });
});

describe('fs-25 — pickEmotionVariantVoice (Qwen-gated emotion variant selection)', () => {
  /* srv-43: variant key is derived from the (already uuid-resolved) baseVoice,
     not from the stored variant name. Variant slot presence = designed. */
  const variants = { angry: { name: 'wren__angry' }, whisper: { name: 'wren__whisper' } };

  it('returns the derived variant key (baseVoice__emotion) for a tagged emotion on Qwen', () => {
    expect(pickEmotionVariantVoice('qwen', variants, 'angry', 'wren-base')).toBe('wren-base__angry');
  });

  it('falls back to the base voice when the tagged emotion has no variant', () => {
    expect(pickEmotionVariantVoice('qwen', variants, 'sad', 'wren-base')).toBe('wren-base');
  });

  it('returns the base for neutral / undefined emotion', () => {
    expect(pickEmotionVariantVoice('qwen', variants, 'neutral', 'wren-base')).toBe('wren-base');
    expect(pickEmotionVariantVoice('qwen', variants, undefined, 'wren-base')).toBe('wren-base');
  });

  it('is a STRICT no-op for non-Qwen engines — emotion is never read', () => {
    // The Kokoro/XTTS safety net: even with variants present + a tagged emotion,
    // the base voice is returned unchanged so non-Qwen synth is byte-identical.
    expect(pickEmotionVariantVoice('kokoro', variants, 'angry', 'am_onyx')).toBe('am_onyx');
    expect(pickEmotionVariantVoice('coqui', variants, 'angry', 'Asya Anara')).toBe('Asya Anara');
  });

  it('handles a missing variants map by returning the base', () => {
    expect(pickEmotionVariantVoice('qwen', undefined, 'angry', 'wren-base')).toBe('wren-base');
    /* srv-43: slot PRESENCE signals designed; an object (even with blank name) → variant key. */
    expect(pickEmotionVariantVoice('qwen', { angry: { name: '  ' } }, 'angry', 'wren-base')).toBe(
      'wren-base__angry',
    );
  });

  /* fs-57 — on the liveInstruct path the delivery direction travels as an
     instruct phrase; the voice stays the base voice (no __emotion suffix).
     The old __emotion-variant path and the liveInstruct path are mutually
     exclusive. */
  it('fs-57: liveInstruct=true returns the base voice even when a variant is present', () => {
    const variants = { angry: { name: 'wren__angry' } };
    expect(pickEmotionVariantVoice('qwen', variants, 'angry', 'wren-base', true)).toBe('wren-base');
  });

  it('fs-57: liveInstruct=false is byte-identical to the original (no liveInstruct arg)', () => {
    const variants = { angry: { name: 'wren__angry' } };
    expect(pickEmotionVariantVoice('qwen', variants, 'angry', 'wren-base', false)).toBe(
      'wren-base__angry',
    );
  });

  it('fs-57: liveInstruct=true on a non-Qwen engine is still a no-op (base voice)', () => {
    /* The liveInstruct gate only has effect on Qwen; the outer engine guard
       fires first for non-Qwen engines. */
    expect(pickEmotionVariantVoice('kokoro', { angry: { name: 'x' } }, 'angry', 'am_onyx', true)).toBe('am_onyx');
  });
});

describe('srv-43 qwen storage key', () => {
  it('qwenStorageKey returns qwen-<voiceUuid> when uuid is present', () => {
    expect(qwenStorageKey({ voiceUuid: 'U1' }, 'wren')).toBe('qwen-U1');
  });

  it('qwenStorageKey falls back to qwen-<voiceId> when no uuid', () => {
    expect(qwenStorageKey({ voiceId: 'wren' }, 'x')).toBe('qwen-wren');
  });

  it('qwenStorageKey falls back to qwen-<fallbackId> when neither uuid nor voiceId', () => {
    expect(qwenStorageKey({}, 'fallback')).toBe('qwen-fallback');
  });

  it('returns qwen-<voiceUuid> for a designed voice that has a uuid', () => {
    const voice = {
      id: 'wren',
      voiceUuid: 'V1StGXR8Z5',
      overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
    };
    expect(pickVoiceForEngine('qwen', voice)).toBe('qwen-V1StGXR8Z5');
  });

  it('falls back to the stored name for a legacy designed voice (no uuid)', () => {
    const voice = { id: 'wren', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } };
    expect(pickVoiceForEngine('qwen', voice)).toBe('qwen-wren');
  });

  it('returns empty string for an undesigned qwen character', () => {
    expect(pickVoiceForEngine('qwen', { id: 'wren' })).toBe('');
  });

  it('derives the emotion-variant key from the resolved base storage key', () => {
    expect(
      pickEmotionVariantVoice('qwen', { angry: { name: 'ignored-legacy-name' } }, 'angry', 'qwen-V1StGXR8Z5'),
    ).toBe('qwen-V1StGXR8Z5__angry');
  });

  it('resolves a uuid-backed qwen designed voice via the legacy singular field too', () => {
    const voice = {
      id: 'wren',
      voiceUuid: 'V1StGXR8Z5',
      overrideTtsVoice: { engine: 'qwen' as const, name: 'qwen-wren' },
    };
    expect(pickVoiceForEngine('qwen', voice)).toBe('qwen-V1StGXR8Z5');
  });
});
