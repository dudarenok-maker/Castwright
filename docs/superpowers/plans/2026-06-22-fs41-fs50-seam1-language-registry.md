# fs-41/fs-50 Seam 1 — Language Registry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a server-side language registry as the single source of truth for per-language data, and rewire `language.ts` to read from it — with **zero behavior change** for the shipped `en`/`ru` paths.

**Architecture:** A new `server/src/tts/language-registry.ts` holds `LanguageEntry` records (seeded with `en` + `ru`, both `supported: true`). `language.ts` keeps its exact public API (`normaliseBookLanguage`, `sidecarLanguageName`, `isNonEnglish`, `DEFAULT_LANGUAGE`) so its ~11 consumers are untouched; only the internal `SIDECAR_LANGUAGE_NAMES` lookup table moves into the registry. Later seams extend `LanguageEntry` (detection slice, text-pipeline lexicons, `refText`, etc. — spec §2) and add `es`/`fr`/`de`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node 20+, Vitest (server `node` env).

## Global Constraints

- **No behavior change in this seam.** All existing `server/src/tts/language.test.ts` assertions stay green — including `sidecarLanguageName('de') === 'English'` + one `console.warn` (the unknown-code fallback). The fail-loud **throw** for unsupported codes is **seam 5**, NOT here. Do not invert any existing test.
- **`en` and `ru` are seeded `supported: true`** (grandfathered — `ru` shipped validated under fs-2). The registry must never regress them.
- **ESM imports use `.js` extensions** (e.g. `import { getLanguageEntry } from './language-registry.js'`), matching the codebase (`'../tts/language.js'` everywhere).
- **The full registry is server-side.** Do NOT expose it to the frontend in this seam — the detection slice (`{code, detect, sidecarName, supported}`) is wired in seam 2 when the frontend detector consumes it (see Scope note).
- **Commit convention:** `<type>(<scope>): <subject>` — husky `commit-msg` rejects malformed subjects. Pre-commit runs `verify:fast:scoped`; these tasks touch `server/src/tts`, so the **server test leg runs** — it must be green before commit.

## Scope note (this is seam 1 of 5)

The spec (§7) groups "the frontend/server sharing seam" into seam 1. It is **deliberately deferred to seam 2's plan** here: the detection slice the frontend consumes must carry the `detect` field, which does not exist until the seam-2 detection work defines it, and an exporter with no consumer is not independently testable. Seam 1 delivers the registry module + the `language.ts` rewire — a complete, behavior-preserving, server-only unit.

---

### Task 1: Create the language registry module

**Files:**
- Create: `server/src/tts/language-registry.ts`
- Test: `server/src/tts/language-registry.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface LanguageEntry { code: string; sidecarName: string; supported: boolean }`
  - `getLanguageEntry(code: string): LanguageEntry | undefined` — `code` is an already-normalised BCP-47 primary subtag (lower-case).
  - `isSupportedLanguage(code: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `server/src/tts/language-registry.test.ts`:

```typescript
/* language-registry — single source of truth for per-language data.
   Seam 1: pins the en/ru entries + the accessor contract. */

import { describe, it, expect } from 'vitest';
import {
  getLanguageEntry,
  isSupportedLanguage,
  type LanguageEntry,
} from './language-registry.js';

describe('getLanguageEntry', () => {
  it('returns the en entry, supported', () => {
    const en = getLanguageEntry('en');
    expect(en).toEqual<LanguageEntry>({
      code: 'en',
      sidecarName: 'English',
      supported: true,
    });
  });

  it('returns the ru entry, supported (grandfathered under fs-2)', () => {
    const ru = getLanguageEntry('ru');
    expect(ru).toEqual<LanguageEntry>({
      code: 'ru',
      sidecarName: 'Russian',
      supported: true,
    });
  });

  it('returns undefined for a code not in the registry', () => {
    expect(getLanguageEntry('de')).toBeUndefined();
    expect(getLanguageEntry('')).toBeUndefined();
  });
});

describe('isSupportedLanguage', () => {
  it('is true for seeded en/ru, false otherwise', () => {
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('ru')).toBe(true);
    expect(isSupportedLanguage('de')).toBe(false);
    expect(isSupportedLanguage('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/language-registry.test.ts`
Expected: FAIL — `Failed to resolve import "./language-registry.js"` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `server/src/tts/language-registry.ts`:

```typescript
/* language-registry — the single source of truth for per-language data
   (fs-41/fs-50). Seam 1 (foundation) holds only the fields `language.ts`
   reads today: `code`, `sidecarName`, `supported`. Later seams EXTEND
   LanguageEntry with the detection slice, text-pipeline lexicons, and
   `refText` (see the fs-41/fs-50 spec §2) and add es/fr/de entries — each
   gated `supported:false` until its validation gate passes.

   `en` and `ru` are seeded `supported:true`: ru shipped validated under
   fs-2, so it is grandfathered past the per-language gate. */

export interface LanguageEntry {
  /** BCP-47 primary subtag, lower-cased (e.g. 'en', 'ru'). */
  code: string;
  /** Sidecar/analyzer language word — Qwen design + the analyzer preamble. */
  sidecarName: string;
  /** True only once the language has passed its validation gate. */
  supported: boolean;
}

const ENTRIES: readonly LanguageEntry[] = [
  { code: 'en', sidecarName: 'English', supported: true },
  { code: 'ru', sidecarName: 'Russian', supported: true },
];

const BY_CODE: ReadonlyMap<string, LanguageEntry> = new Map(
  ENTRIES.map((e) => [e.code, e]),
);

/** Look up a registry entry by an already-normalised BCP-47 primary subtag. */
export function getLanguageEntry(code: string): LanguageEntry | undefined {
  return BY_CODE.get(code);
}

/** True when the language has passed its validation gate (registry `supported`). */
export function isSupportedLanguage(code: string): boolean {
  return BY_CODE.get(code)?.supported ?? false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/language-registry.test.ts`
Expected: PASS (5 assertions across 2 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/language-registry.ts server/src/tts/language-registry.test.ts
git commit -m "feat(server): add language registry as per-language source of truth (en/ru)"
```

---

### Task 2: Rewire `sidecarLanguageName` to read from the registry

**Files:**
- Modify: `server/src/tts/language.ts:14-44` (remove `SIDECAR_LANGUAGE_NAMES`; `sidecarLanguageName` reads the registry)
- Test: `server/src/tts/language.test.ts` (existing — stays green; add one delegation assertion)

**Interfaces:**
- Consumes: `getLanguageEntry` from Task 1.
- Produces: no public-API change. `sidecarLanguageName(bcp47: string): string`, `isNonEnglish(bcp47: string): boolean`, `normaliseBookLanguage`, `DEFAULT_LANGUAGE` all keep their exact current signatures and behavior. (The ~11 consumers — `generation.ts`, `gemini.ts`, `chapter-splice.ts`, `chapter-qa-repair.ts`, `qwen-voice.ts`, `cast-design.ts`, `single-design.ts`, `scan.ts`, `import.ts`, `fold-minor-cast.ts`, `verify-designed-voice-language.ts` — are untouched.)

- [ ] **Step 1: Add a delegation assertion to the existing test**

Append to `server/src/tts/language.test.ts` inside the existing `describe('sidecarLanguageName', …)` block (after the existing `it` cases, before its closing `});`):

```typescript
  it('sources the language word from the registry entry', async () => {
    const { getLanguageEntry } = await import('./language-registry.js');
    expect(sidecarLanguageName('ru')).toBe(getLanguageEntry('ru')?.sidecarName);
    expect(sidecarLanguageName('en')).toBe(getLanguageEntry('en')?.sidecarName);
  });
```

(Leave every existing assertion — including `sidecarLanguageName('de') === 'English'` with one `console.warn`, and the `isNonEnglish('de') === true` case — unchanged. Seam 1 preserves them.)

- [ ] **Step 2: Run the test to verify the new assertion fails**

Run: `cd server && npx vitest run src/tts/language.test.ts`
Expected: FAIL only on the new "sources the language word from the registry entry" case — `getLanguageEntry` resolves, but `sidecarLanguageName` still reads the local `SIDECAR_LANGUAGE_NAMES` table, so the assertion is comparing two equal strings and actually PASSES even before the rewire.

> Note: this assertion passes pre-rewire because the values coincide (`'Russian'`/`'English'`). That is acceptable — its purpose is a **regression lock** that the registry stays the canonical word source after the rewire, not a red-before-green gate. The genuine red-before-green for this task is the *removal* verified in Step 4 (the old `SIDECAR_LANGUAGE_NAMES` symbol must be gone and all cases still green). Proceed to Step 3.

- [ ] **Step 3: Rewire `language.ts`**

In `server/src/tts/language.ts`, add the import at the top (after the file's opening comment, alongside no other imports today):

```typescript
import { getLanguageEntry } from './language-registry.js';
```

Delete the `SIDECAR_LANGUAGE_NAMES` constant (currently lines ~12-17):

```typescript
/* Primary-subtag → sidecar language word. Keep keys lower-cased primary
   subtags; the lookup normalises before indexing. */
const SIDECAR_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
};
```

Replace the body of `sidecarLanguageName` so it reads the registry:

```typescript
/** The sidecar's language word for a BCP-47 book language. Unknown codes fall
    back to `'English'` with a warning — a stray code must never throw and break
    generation, but it also must never silently mis-route, so we log it.
    (Seam 5 replaces this fallback with a throw gated on the registry's
    `supported` set; seam 1 preserves the shipped behaviour.) */
export function sidecarLanguageName(bcp47: string): string {
  const primary = normaliseBookLanguage(bcp47);
  const entry = getLanguageEntry(primary);
  if (!entry) {
    console.warn(
      `[language] no sidecar language name for "${bcp47}" (primary "${primary}") — falling back to English`,
    );
    return 'English';
  }
  return entry.sidecarName;
}
```

Leave `DEFAULT_LANGUAGE`, `primarySubtag`, `normaliseBookLanguage`, and `isNonEnglish` exactly as they are.

- [ ] **Step 4: Run the full language test file to verify all cases pass**

Run: `cd server && npx vitest run src/tts/language.test.ts`
Expected: PASS — every existing case (en/ru words, `''`→English, `de`→English+warn, `isNonEnglish` matrix, `normaliseBookLanguage`) plus the new registry-delegation case. The `de`→`English`+`console.warn` behavior is unchanged (an unknown code yields `getLanguageEntry(...) === undefined` → the same warn+fallback).

- [ ] **Step 5: Verify no consumer regressed — run the broader tts/analyzer suite**

Run: `cd server && npx vitest run src/tts src/analyzer/gemini.test.ts src/analyzer/fold-minor-cast.test.ts`
Expected: PASS — the `language.ts` consumers (`isNonEnglish`/`sidecarLanguageName`/`normaliseBookLanguage`) see an identical API and identical en/ru behavior.

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/language.ts server/src/tts/language.test.ts
git commit -m "refactor(server): read sidecar language word from the registry (no behaviour change)"
```

---

## Self-Review

- **Spec coverage (seam 1 slice of §2/§7/§10):** registry module is the source of truth ✓ (Task 1); `language.ts` reads from it / `SIDECAR_LANGUAGE_NAMES` removed ✓ (Task 2); `en`+`ru` seeded `supported:true` ✓ (Task 1); `ru` no-regression preserved by the unchanged existing `isNonEnglish('ru')`/`sidecarLanguageName('ru')` assertions ✓ (Task 2 Steps 4-5). Deferred-by-design to later seams (noted): the `sidecarLanguageName` **throw** (seam 5), the detection slice + frontend sharing (seam 2), es/fr/de entries + the `LanguageEntry` text-pipeline fields (seams 2-5).
- **Placeholder scan:** none — every step carries the literal code/command/expected output.
- **Type consistency:** `LanguageEntry`, `getLanguageEntry`, `isSupportedLanguage` are spelled identically in Task 1 (definition), Task 1 test, and Task 2 (import + usage). `sidecarLanguageName` keeps its `(bcp47: string): string` signature.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-fs41-fs50-seam1-language-registry.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task with a review gate between tasks.
2. **Inline Execution** — execute both tasks in this session with a checkpoint after each.

This seam is small (2 tasks, no behavior change), so inline execution is reasonable; subagent-driven still gives a clean per-task review gate.
