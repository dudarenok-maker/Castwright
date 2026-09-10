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

       IT #3 READS `generation.ts` AT RUNTIME, NOT VIA IMPORT — the same
       #1847 trap `server/vitest.config.ts`'s `forceRerunTriggers` header
       documents repeatedly. That file has a `generation.ts` entry
       (mirrored in `force-rerun-triggers.test.ts`'s `MAIN_COVERED` list)
       specifically so `vitest run --changed`'s scoped CI leg still selects
       THIS file when only `generation.ts` changes. If the scan target ever
       moves to a different file, move that trigger with it — otherwise this
       guard goes back to being silent on the CI leg that runs on every PR,
       exactly the failure mode this guard exists to close.

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
   - it #3's syntactic scan has blind spots, and this list is measured, not
     guessed (#3083 review pass 3, finding H -- an earlier version of it got
     one case backwards and omitted the only fail-open one).
     FAIL CLOSED, so safe: aliasing the FUNCTION import moves the derivation
     out of this file and the `calls.length > 0` assertion fires; aliasing
     ALL_TTS_ENGINES at the import makes the second argument a different
     identifier, which lands in `violations`; a computed second argument is
     reported whether or not it is equivalent to ALL_TTS_ENGINES.
     FAIL OPEN, so guarded separately below: REBINDING the identifier TEXT --
     importing under an alias and re-declaring a local `const ALL_TTS_ENGINES
     = ...` -- leaves the call site byte-identical and used to pass 3/3 while
     coquiEligible was false for every language. That is the MINIMAL diff for
     the very change #3059 parks, so it is the one spelling this guard cannot
     afford to miss; it #3 now asserts the import is un-aliased and the name
     is never re-declared.
     STILL UNGUARDED: indirection through an equivalent value under another
     name, and a second call site in another file -- this scan only reads
     generation.ts. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { allLanguageEntries } from './language-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';
import { resolveEligibleEngines } from './language.js';
import { ALL_TTS_ENGINES } from './model-keys.js';
import { ENGINE_LANGUAGE_COVERAGE_GUARD_SCAN_GLOB } from './engine-language-coverage.guard-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATION_ROUTE_PATH = join(__dirname, '..', 'routes', 'generation.ts');
const REPO_ROOT = join(__dirname, '..', '..', '..');

describe('engine/registry language coverage (#3059)', () => {
  it('scan scope matches the declared ENGINE_LANGUAGE_COVERAGE_GUARD_SCAN_GLOB (#3085)', () => {
    // Ties this guard's ACTUAL scan target (GENERATION_ROUTE_PATH, read by
    // the third `it` below) to the scope it DECLARES via the sibling
    // module — the same constant force-rerun-triggers.test.ts checks its
    // forceRerunTriggers entry against — so the two statements of this
    // guard's scope can never independently drift.
    const actualRel = relative(REPO_ROOT, GENERATION_ROUTE_PATH).split(sep).join('/');
    expect(actualRel).toBe(ENGINE_LANGUAGE_COVERAGE_GUARD_SCAN_GLOB);
  });

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

    /* The call site being textually `ALL_TTS_ENGINES` only means anything if
       that name still refers to the real, whole engine set. Importing it
       under an alias and shadowing the name locally keeps the call site
       byte-identical while changing what it passes -- measured fail-open
       (#3083 pass 3, H). Assert the binding, not just the spelling. */
    const importAliases: string[] = [];
    const redeclarations: string[] = [];
    const visitBindings = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node) && node.propertyName?.text === 'ALL_TTS_ENGINES') {
        importAliases.push(`imported as '${node.name.text}'`);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ALL_TTS_ENGINES') {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        redeclarations.push(`line ${line + 1}: ${node.getText(sourceFile)}`);
      }
      ts.forEachChild(node, visitBindings);
    };
    visitBindings(sourceFile);

    const bindingProblems = [...importAliases, ...redeclarations];
    expect(
      bindingProblems,
      'in server/src/routes/generation.ts the name ALL_TTS_ENGINES no longer binds directly ' +
        'to the exported engine set (' + bindingProblems.join('; ') + '). The ' +
        'resolveEligibleEngines(...) call site above can stay byte-identical while passing ' +
        'something else entirely, which is the one spelling of this change that used to slip ' +
        'through. If narrowing the engine set here is deliberate, decide whether the refusal ' +
        'path removed by #3059 needs restoring for a book whose language the narrowed set ' +
        'cannot render. See https://github.com/dudarenok-maker/Castwright/issues/3059.',
    ).toEqual([]);
  });
});
