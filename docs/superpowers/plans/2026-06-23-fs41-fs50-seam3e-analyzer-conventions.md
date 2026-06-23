# fs-41/fs-50 Seam 3e — Analyzer language conventions (§4.6 preamble + §4.7 boilerplate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the analyzer the correct **language name** and **per-language dialogue conventions** for Spanish/French/German (it currently passes the raw code `"es"` with no conventions, only Russian is wired), and strip es/fr/de copyright/boilerplate lines before analysis — without changing English/Russian behaviour.

**Architecture:** `languagePreamble` (`analyzer/gemini.ts`) looks up the registry `sidecarName` for the language word and adds a short per-language conventions hint (quote marks + the German "capitalisation ≠ name" caution). `stripFrontMatterBoilerplate` (`analyzer/strip-front-matter.ts`) gains es/fr/de copyright-notice patterns in `GLOBAL_BOILERPLATE`.

> **Scope note — §4.5 (token divisor) is intentionally NOT in this plan.** `estimateInputTokens` measures the *text's* Cyrillic fraction (not the declared language), so it already yields the right divisor for es/fr/de (Latin → ~4) and ru (Cyrillic → ~2.5); German's minor compound density is absorbed by the +1000 margin + the post-call `usageMetadata` reconciliation. The real divisor gap is CJK (~1.2), which belongs to the §11.1 CJK sub-spec. Building a registry `charsPerToken` now would be a no-op for the Latin tranche (YAGNI).

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+, Vitest.

## Global Constraints

- **English + Russian behaviour unchanged.** `languagePreamble('en')` / absent → `''` (byte-identical); the Russian branch's tuned conventions string is **untouched**. `GLOBAL_BOILERPLATE`'s existing en/ru patterns are untouched (only es/fr/de added). No existing assertion modified.
- Reuse `getLanguageEntry`/`normaliseBookLanguage` from the registry/`language.ts` for the language word. ESM `.js`. Commit `<type>(<scope>): <subject>`. Husky pre-commit runs the server test leg (green, no `--no-verify`). Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41`, branch `docs/docs-fs41-fs50-seam3e-analyzer-i18n`.

---

### Task 1: `languagePreamble` — use the language name + es/fr/de conventions

**Files:**
- Modify: `server/src/analyzer/gemini.ts` (`languagePreamble`, ~lines 175-190)
- Test: `server/src/analyzer/gemini.test.ts` (or wherever `languagePreamble` is unit-tested; create a focused test if absent)

**Interfaces:** `languagePreamble(language?: string): string` signature unchanged; for es/fr/de it now names the language ("Spanish"/"French"/"German") and adds a conventions hint.

- [ ] **Step 1: Write the failing tests** — add (mirror any existing `languagePreamble` test; if none, create `server/src/analyzer/language-preamble.test.ts`):

```typescript
import { languagePreamble } from './gemini.js';

describe('languagePreamble — es/fr/de naming + conventions (seam 3e)', () => {
  it('names Spanish/French/German (not the raw code) and adds quote conventions', () => {
    expect(languagePreamble('es')).toMatch(/Spanish/);
    expect(languagePreamble('es')).not.toMatch(/\bes \(a non-English language\)/);
    expect(languagePreamble('fr')).toMatch(/French/);
    expect(languagePreamble('de')).toMatch(/German/);
    // German caution: capitalisation does not indicate a name
    expect(languagePreamble('de')).toMatch(/capitali[sz]ed/i);
  });
  it('is empty for English and unchanged for Russian (still names Russian + Cyrillic)', () => {
    expect(languagePreamble('en')).toBe('');
    expect(languagePreamble(undefined)).toBe('');
    expect(languagePreamble('ru')).toMatch(/Russian \(Cyrillic script\)/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/language-preamble.test.ts` (or the gemini test file)
Expected: FAIL — `languagePreamble('es')` currently emits `"es (a non-English language)"` and no Spanish conventions.

- [ ] **Step 3: Implement** — in `server/src/analyzer/gemini.ts` `languagePreamble`:

(a) Ensure `getLanguageEntry` is imported from `../tts/language-registry.js` (alongside the existing `isNonEnglish`/`normaliseBookLanguage` from `../tts/language.js`).

(b) Replace the `where` line so the language NAME comes from the registry, and add a per-language conventions map for es/fr/de (keep the Russian branch's existing `conventions` string exactly):

```typescript
const primary = normaliseBookLanguage(language);
const entry = getLanguageEntry(primary);
const ru = primary === 'ru';
const where = entry
  ? `${entry.sidecarName}${entry.detect.script === 'cyrillic' ? ' (Cyrillic script)' : ''}`
  : `${language} (a non-English language)`;
// Per-language dialogue conventions for the Latin tranche (Russian keeps its own
// tuned string below). The German caution is load-bearing: every German noun is
// capitalised, so the model must not infer a speaker from capitalisation.
const LATIN_CONVENTIONS: Record<string, string> = {
  es: ' Dialogue is marked with «…» or an em-dash —, and questions/exclamations open with ¿ ¡. Characters may be named by first name or surname.',
  fr: ' Dialogue is marked with « … » (with spaces) or an em-dash —, not English "quotes".',
  de: ' Dialogue is marked with „…“ (low/high quotes) or «…». NOTE: every German noun is capitalised, so a capitalised word is NOT necessarily a character name.',
};
const conventions = ru
  ? /* …the EXISTING Russian conventions string, unchanged… */ ''
  : (LATIN_CONVENTIONS[primary] ?? '');
```

(Splice these in around the existing `where`/`conventions` definitions; keep `castFields` and the final returned template literal exactly as they are — they already interpolate `${where}` and `${conventions}`. Restore the real Russian string into the `ru ? … : …` ternary — do NOT blank it.)

- [ ] **Step 4: Run to verify pass — new + existing**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/language-preamble.test.ts && npx vitest run src/analyzer/gemini.test.ts`
Expected: PASS — es/fr/de named + conventions; English `''`; Russian unchanged (its string + "Russian (Cyrillic script)" intact). Any existing `languagePreamble`/gemini preamble assertion stays green.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/gemini.ts server/src/analyzer/language-preamble.test.ts
git commit -m "feat(server): analyzer preamble names es/fr/de + adds per-language dialogue conventions"
```

---

### Task 2: `stripFrontMatterBoilerplate` — es/fr/de copyright patterns

**Files:**
- Modify: `server/src/analyzer/strip-front-matter.ts` (`GLOBAL_BOILERPLATE`)
- Test: `server/src/analyzer/strip-front-matter.test.ts` (create if absent)

**Interfaces:** `stripFrontMatterBoilerplate(body, {author?, title?})` unchanged; now also drops es/fr/de copyright-notice lines.

- [ ] **Step 1: Write the failing test** — add to `server/src/analyzer/strip-front-matter.test.ts`:

```typescript
import { stripFrontMatterBoilerplate } from './strip-front-matter.js';

it('strips es/fr/de copyright-notice boilerplate lines', () => {
  const body =
    'Todos los derechos reservados.\nTous droits réservés.\nAlle Rechte vorbehalten.\n\n' +
    'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria.';
  const out = stripFrontMatterBoilerplate(body);
  expect(out).not.toMatch(/derechos reservados/i);
  expect(out).not.toMatch(/droits réservés/i);
  expect(out).not.toMatch(/Rechte vorbehalten/i);
  expect(out).toMatch(/El horno se había enfriado/); // narrative kept
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/strip-front-matter.test.ts`
Expected: FAIL — the es/fr/de copyright lines are not matched by `GLOBAL_BOILERPLATE`.

- [ ] **Step 3: Implement** — in `server/src/analyzer/strip-front-matter.ts`, add es/fr/de copyright/rights patterns to the `GLOBAL_BOILERPLATE` array (alongside the existing en/ru entries — do NOT remove any existing pattern):

```typescript
  /[Tt]odos los derechos reservados/, // es "all rights reserved"
  /[Tt]ous droits réservés/,          // fr
  /[Aa]lle Rechte vorbehalten/,       // de
```

(The existing `^\s*\((С|C)\)\s/` already catches `(C)`/`(С)` copyright marks across languages; these add the spelled-out "all rights reserved" forms.)

- [ ] **Step 4: Run to verify pass — new + existing**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/strip-front-matter.test.ts`
Expected: PASS — es/fr/de copyright lines stripped, narrative kept, and every pre-existing en/ru strip assertion green.

- [ ] **Step 5: Confirm the seam-2 detection still passes (detection reuses this strip)**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/detect-language.test.ts`
Expected: PASS (the front-matter-strip-before-detect path is unaffected by additive boilerplate patterns).

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/strip-front-matter.ts server/src/analyzer/strip-front-matter.test.ts
git commit -m "feat(server): strip es/fr/de copyright boilerplate before analysis"
```

---

## Self-Review

- **Spec coverage (§4.6 preamble word + §4.7 boilerplate):** the preamble names es/fr/de via `sidecarName` + adds per-language conventions (incl. the German capitalisation caution) ✓ (T1); es/fr/de copyright boilerplate is stripped ✓ (T2). §4.5 token divisor is documented as a Latin-tranche no-op (scope note). The big §4.6 prompt-skills few-shot remains the final analyze-half PR.
- **Placeholder scan:** the "keep the existing Russian conventions string unchanged" instruction is explicit (do NOT blank it). Every code step shows the change.
- **Type consistency:** `getLanguageEntry`/`sidecarName`/`detect.script` used as in prior seams; `normaliseBookLanguage` for the primary subtag.
- **English/Russian-unchanged check:** T1 Step 4 asserts `languagePreamble('en') === ''` and the Russian string intact; T2 keeps every existing `GLOBAL_BOILERPLATE` pattern.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam3e-analyzer-conventions.md`. Subagent-Driven recommended. After this, the FINAL analyze-half PR is §4.6 prompt-skills: inject per-language few-shot examples into the stage-1/2 skill bodies (the largest English surface) — a bigger lift that may need fluent in-language examples.
