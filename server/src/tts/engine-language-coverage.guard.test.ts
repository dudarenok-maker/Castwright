/* #3059 — build-time guard for the coupling that makes the removed
   `nonEnglishBook && !coquiEligible` arm in `generation.ts` provably
   unreachable. `coquiEligible` there is
   `resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES).includes('coqui')`,
   which is empty for every validated non-English `bookLanguage` only if
   ALL THREE of these hold:

     1. every reachable `bookLanguage` is a registry code — enforced by
        `sidecarLanguageName`'s throw in `generation.ts`, called before the
        gate is ever evaluated;
     2. every such registry code is in `ENGINE_LANGUAGE_SUPPORT.coqui`;
     3. `'coqui' ∈ ALL_TTS_ENGINES`, **as `generation.ts:830` actually calls
        it** — i.e. `resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES)`
        still passes `ALL_TTS_ENGINES` itself, not some other installed-
        engines set.

   This file has three `it`s and covers (2) and (3); (1) is a STATED LIMIT,
   not covered — see below.

     - it #1 asserts (2) directly against the table.
     - it #2 asserts (2) AND the *contents* of (3) — `'coqui' ∈
       ALL_TTS_ENGINES` — together, by calling `resolveEligibleEngines`
       itself instead of reading the table. This is real, additional
       coverage over it #1 alone: `'coqui' ∈ ALL_TTS_ENGINES` used to be only
       incidental coverage in `language.test.ts`, and it #2 makes it
       intentional and carries the #3059 message. **It does NOT see the call
       site** — it imports `ALL_TTS_ENGINES` itself and passes that import as
       the argument, so it cannot detect `generation.ts:830` being changed to
       pass a DIFFERENT installed-engines set (e.g. a real
       installed-on-this-box set instead of `ALL_TTS_ENGINES` — the exact
       change #3059's own "Explicitly out of scope" section parks). Under
       that change, `coquiEligible` would be false for every non-English
       language on a box without Coqui weights, the removed arm would be
       live for every non-English book, and it #1 and it #2 would BOTH stay
       green, because neither reads anything `generation.ts` itself contains.
       (An earlier version of this file claimed it #2 caught this. It does
       not — see #3059's PR #3083 review pass 2. That claim is corrected
       here.)
     - it #3 is what actually watches the call site: a deliberately
       syntactic source-text scan of `generation.ts` (same idiom as
       `server/src/workspace/cast-lock.guard.test.ts` — read that file's
       header for the fuller discipline this one borrows) asserting the
       `resolveEligibleEngines(` call there still passes `ALL_TTS_ENGINES`
       literally as its second argument. This closes the gap it #2 cannot:
       it fails if that argument changes to anything else, independent of
       what `ALL_TTS_ENGINES` contains.

   Together, it #2 (or #1) covers the table, and it #3 covers the call site
   — that is (2) and (3) in full. (1) has NO coverage in this file, by
   design: it isn't guarded, it is only named as a limit below.

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

   KNOWN LIMITS — this guard is not total coverage of the three-conjunct
   claim above:
   - Conjunct (1) — that `sidecarLanguageName` throws for an unregistered
     language before the per-chapter gate is evaluated — has NO coverage
     here. It is a fact about control flow ordering inside `generation.ts`
     that this file does not check; it is only named so the guard's scope
     record doesn't imply more than it has.
   - A `supported: false` registry entry is out of scope by design (above) —
     the confirm-screen gate is assumed to hold. If that gate is ever
     bypassed, this guard's scope is too narrow to catch it.
   - A DEMOTION (a language flipped `supported: true` → `false` after books
     were already imported under it) is not caught either: `generation.ts`
     resolves a book's language via `sidecarLanguageName` → `getLanguageEntry`,
     which does not consult `supported`, and `requireBookStateLanguage`
     returns the book's stored language raw without re-validating it. An
     already-imported book under a demoted language still reaches the gate
     with the arm gone.
   - it #3's syntactic scan has its own blind spots, same class as
     `cast-lock.guard.test.ts`'s: an ALIASED import of either name
     (`import { resolveEligibleEngines as foo }` or
     `import { ALL_TTS_ENGINES as bar }`) is invisible to it, since it
     matches on the literal identifier text; and it cannot see through
     INDIRECTION — `const installed = someOtherSet; resolveEligibleEngines(
     bookLanguage, installed)` passes as long as the text `ALL_TTS_ENGINES`
     doesn't appear as the literal second argument, even if `installed`
     happens to equal it, and conversely a computed argument that isn't a
     bare identifier is reported as a violation whether or not it is
     equivalent to `ALL_TTS_ENGINES`. It also only scans `generation.ts` —
     a second call site added elsewhere is invisible to it. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { allLanguageEntries } from './language-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';
import { resolveEligibleEngines } from './language.js';
import { ALL_TTS_ENGINES } from './model-keys.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATION_ROUTE_PATH = join(__dirname, '..', 'routes', 'generation.ts');

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
    // Additional coverage over it #1: exercises resolveEligibleEngines and
    // ALL_TTS_ENGINES's own contents directly, not just the table. Does NOT
    // see whether generation.ts's own call site still passes ALL_TTS_ENGINES
    // — that is it #3's job (see file header).
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

  it("generation.ts's resolveEligibleEngines call site still passes ALL_TTS_ENGINES", () => {
    // Deliberately syntactic — see file header. Finds every
    // resolveEligibleEngines(...) call in generation.ts's own source text
    // and asserts its second argument is the bare identifier
    // ALL_TTS_ENGINES. This is what it #2 cannot check: it #2 imports
    // ALL_TTS_ENGINES itself and so is blind to the call site being changed
    // to pass something else.
    const source = readFileSync(GENERATION_ROUTE_PATH, 'utf8');
    const sourceFile = ts.createSourceFile(
      GENERATION_ROUTE_PATH,
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'resolveEligibleEngines'
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(
      calls.length,
      'no resolveEligibleEngines(...) call found in server/src/routes/generation.ts — the ' +
        'coquiEligible derivation this guard exists to watch appears to have moved or been ' +
        'removed. If it moved, point this guard at its new location; if the derivation itself ' +
        'changed shape, the refusal path removed by #3059 may need re-evaluating. ' +
        'See https://github.com/dudarenok-maker/Castwright/issues/3059.',
    ).toBeGreaterThan(0);

    const violations = calls
      .filter((call) => {
        const secondArg = call.arguments[1];
        return !(secondArg && ts.isIdentifier(secondArg) && secondArg.text === 'ALL_TTS_ENGINES');
      })
      .map((call) => {
        const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
        return `line ${line + 1}: ${call.getText(sourceFile)}`;
      });

    expect(
      violations,
      'server/src/routes/generation.ts calls resolveEligibleEngines(...) with a second argument ' +
        "that is no longer the bare identifier ALL_TTS_ENGINES:\n  " +
        violations.join('\n  ') +
        "\nThis is the call-site conjunct the arm removed by #3059 depends on — coquiEligible is " +
        'derived from whatever this call actually passes, not from ALL_TTS_ENGINES\'s own ' +
        'contents (which it #1/#2 above already cover). If this was a deliberate change (e.g. ' +
        'passing a real installed-engines set instead of ALL_TTS_ENGINES), decide whether the ' +
        "refusal path removed by #3059 needs restoring for a box that lacks Coqui — a " +
        'non-Coqui-eligible non-English book may now be reachable again. ' +
        'See https://github.com/dudarenok-maker/Castwright/issues/3059.',
    ).toEqual([]);
  });
});
