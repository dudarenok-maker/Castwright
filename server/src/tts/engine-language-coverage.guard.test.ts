/* #3059 — build-time guard for the registry ↔ ENGINE_LANGUAGE_SUPPORT.coqui
   coupling. `server/src/routes/generation.ts` used to carry a
   `nonEnglishBook && !coquiEligible` arm that hard-failed a chapter when a
   non-English book fell outside Coqui's language table. It was removed as
   provably unreachable: `ENGINE_LANGUAGE_SUPPORT.coqui` is exactly the
   registry's `supported:true` code set, and a language outside the registry
   throws earlier in the same route (before this gate is ever evaluated).
   That equality is what made the arm dead code — and nothing anywhere else
   asserts it holds. This guard is the thing watching it now.

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

   This guard's correctness rests on the confirm-screen `supported` gate
   actually holding — if that gate is ever bypassed, this guard's scope is
   too narrow to catch it. */

import { describe, it, expect } from 'vitest';
import { allLanguageEntries } from './language-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';

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
});
