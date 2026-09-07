/* #3059 — build-time guard for the coupling that makes the removed
   `nonEnglishBook && !coquiEligible` arm in `generation.ts` provably
   unreachable. `coquiEligible` there is
   `resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES).includes('coqui')`,
   which is true only when BOTH `'coqui' ∈ ALL_TTS_ENGINES` (the installed-
   engines set generation.ts actually passes) AND the language is in
   `ENGINE_LANGUAGE_SUPPORT.coqui`. The arm is unreachable only if every
   validated non-English registry code clears `resolveEligibleEngines`
   itself — the table alone isn't enough, since a future change to what
   `generation.ts:830` passes as the installed-engines set (e.g. swapping
   `ALL_TTS_ENGINES` for a real installed-on-this-box set — exactly the
   question #3059's own "Explicitly out of scope" section parks) could make
   `coquiEligible` false for every language while the table stays untouched.
   The second `it` below asserts through `resolveEligibleEngines` itself so
   it can catch that; the first keeps the table-only assertion because it
   gives a more direct message when the drift is a table edit.

   Keyed on `supported: true`, NOT on registration. A `supported: false`
   language (registered but not yet validated) is blocked at the confirm-
   screen support gate and can never reach generation, so it cannot make the
   removed arm reachable — asserting on registration would force whoever
   registers an unvalidated language to either restore a refusal path they
   don't yet need, or (far more likely) add the new code to
   ENGINE_LANGUAGE_SUPPORT.coqui just to get this guard green, which would be
   a false claim about what XTTS can actually render. Keying on the
   validation flip puts the guard at the moment the language becomes
   user-reachable, where the choice is an honest one.

   This guard has two known limits, both on the confirm-screen `supported`
   gate actually holding for every book that reaches generation:
   - if that gate is ever bypassed at import/write time, this guard's scope
     is too narrow to catch a language slipping through it;
   - a DEMOTION (a language flipped `supported: true` → `false` after books
     were already imported under it) is not caught either: `generation.ts`
     resolves a book's language via `sidecarLanguageName` → `getLanguageEntry`,
     which does not consult `supported`, and `requireBookStateLanguage`
     returns the book's stored language raw without re-validating it. An
     already-imported book under a demoted language still reaches the gate
     with the arm gone. */

import { describe, it, expect } from 'vitest';
import { allLanguageEntries } from './language-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';
import { resolveEligibleEngines } from './language.js';
import { ALL_TTS_ENGINES } from './model-keys.js';

describe('engine/registry language coverage (#3059)', () => {
  it('every validated non-English language is covered by ENGINE_LANGUAGE_SUPPORT.coqui', () => {
    const coquiLanguages = ENGINE_LANGUAGE_SUPPORT.coqui;
    if (coquiLanguages === '*') {
      // Coqui has never been modeled as universal; if that ever changes,
      // there is nothing left for this guard to check.
      return;
    }
    const uncovered = allLanguageEntries()
      .filter((e) => e.supported && e.code !== 'en')
      .map((e) => e.code)
      .filter((code) => !coquiLanguages.includes(code));

    expect(
      uncovered,
      `language(s) ${uncovered.join(', ')} are validated (supported:true) in the language ` +
        'registry but missing from ENGINE_LANGUAGE_SUPPORT.coqui in server/src/tts/voice-mapping.ts. ' +
        'Either Coqui/XTTS can actually render this language — add it to ' +
        "ENGINE_LANGUAGE_SUPPORT.coqui — or it can't, which means a non-Coqui-eligible " +
        'non-English book is now genuinely reachable through generation.ts\'s voice-readiness ' +
        'gate and the refusal path removed by #3059 needs to be restored for it. ' +
        'See https://github.com/dudarenok-maker/Castwright/issues/3059.',
    ).toEqual([]);
  });

  it('resolveEligibleEngines(code, ALL_TTS_ENGINES) includes coqui for every validated non-English language', () => {
    // Exercises the actual function/call-site pairing generation.ts:830-831
    // depends on, not just the table underneath it — so this also catches a
    // future change to what installed-engines set generation.ts passes
    // there (e.g. a real installed set instead of ALL_TTS_ENGINES), which a
    // table-only assertion cannot see since it never touches
    // resolveEligibleEngines or ALL_TTS_ENGINES.
    const ineligible = allLanguageEntries()
      .filter((e) => e.supported && e.code !== 'en')
      .map((e) => e.code)
      .filter((code) => !resolveEligibleEngines(code, ALL_TTS_ENGINES).includes('coqui'));

    expect(
      ineligible,
      `language(s) ${ineligible.join(', ')} are validated (supported:true) but ` +
        "resolveEligibleEngines(code, ALL_TTS_ENGINES) does not include 'coqui' for them — " +
        "either ALL_TTS_ENGINES (server/src/tts/model-keys.ts) no longer contains 'coqui', or " +
        'ENGINE_LANGUAGE_SUPPORT.coqui (server/src/tts/voice-mapping.ts) no longer covers this ' +
        "code. A non-Coqui-eligible non-English book is now genuinely reachable through " +
        "generation.ts's voice-readiness gate and the refusal path removed by #3059 needs to be " +
        'restored for it. See https://github.com/dudarenok-maker/Castwright/issues/3059.',
    ).toEqual([]);
  });
});
