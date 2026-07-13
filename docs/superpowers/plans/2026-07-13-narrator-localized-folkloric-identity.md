# Localized Folkloric Narrator Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every newly analysed book, deterministically seed the narrator character with a localized display name (per book language, `"Narrator"` alias kept) and one fixed folkloric voice persona, so it gets a designed voice instead of the plan-108 Kokoro-preset fallback — while a user's rename or re-design survives reparse.

**Architecture:** A new pure `narrator-identity.ts` module localizes the narrator name and seeds the folkloric `voiceStyle`/`gender`/`ageRange`/`tone`/`attributes` on the fresh analyzer roster. Localized names live on `LanguageEntry` (`narratorName`) in the registry, which also gains an `isDefaultNarratorName` helper. `routes/analysis.ts` calls the module at both job seams (main + subset). `store/merge-analysis-cast.ts` gains a narrator-only `name` carry-forward (gated on `isDefaultNarratorName`) so a user rename survives reparse; `voiceStyle` and `aliases` are already durable there.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), Vitest, Zod (handoff schemas).

## Global Constraints

- **Node ESM import specifiers end in `.js`** even for `.ts` files (e.g. `import { x } from '../tts/language-registry.js'`).
- **OpenAPI/Zod is the type source of truth** — `CharacterOutput` comes from `server/src/handoff/schemas.ts`; do not hand-redefine cast shapes.
- **Narrator ids are `'narrator'` and `'char-narrator'`** — every narrator check keys on id first; never key narrator logic on the display name.
- **The folkloric persona string is fixed and verbatim** (copied from the accepted Coalfall Russian narrator) — identical across all languages:
  > "A middle-aged voice, neutral in gender, with a medium pitch and steady, mid-paced delivery; the timbre is rich, grounded, and resonant, carrying a measured, folkloric warmth suitable for audiobook narration."
- **No migration** — behavior applies at analysis time to new/re-analysed books only; do not touch existing on-disk casts or shipped samples.
- **Pure helpers stay pure** — `applyNarratorIdentity` and `isDefaultNarratorName` do no I/O, no model calls, never mutate inputs.
- **Commit after each task** with a `<type>(<scope>): <subject>` message (scope `server`).
- Spec of record: `docs/superpowers/specs/2026-07-13-narrator-localized-folkloric-identity-design.md`.

---

### Task 1: Registry — `narratorName` field + `isDefaultNarratorName`

**Files:**
- Modify: `server/src/tts/language-registry.ts`
- Test: `server/src/tts/language-registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `LanguageEntry.narratorName?: string`
  - `isDefaultNarratorName(name: string | undefined | null): boolean`
  - Localized names: `ru: 'Рассказчик'`, `es: 'Narrador'`, `fr: 'Narrateur'`, `de: 'Erzähler'` (en omits → defaults to `"Narrator"`).

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/language-registry.test.ts` (import `isDefaultNarratorName` in the existing top import block from `./language-registry.js`):

```ts
describe('narratorName', () => {
  it('exposes localized narrator names for the four non-English supported languages', () => {
    expect(getLanguageEntry('de')?.narratorName).toBe('Erzähler');
    expect(getLanguageEntry('ru')?.narratorName).toBe('Рассказчик');
    expect(getLanguageEntry('es')?.narratorName).toBe('Narrador');
    expect(getLanguageEntry('fr')?.narratorName).toBe('Narrateur');
  });

  it('omits narratorName on en (defaults to "Narrator" at the call site)', () => {
    expect(getLanguageEntry('en')?.narratorName).toBeUndefined();
  });
});

describe('isDefaultNarratorName', () => {
  it('is true for the English default and every localized default, case-insensitively', () => {
    for (const n of ['Narrator', 'narrator', ' NARRATOR ', 'Erzähler', 'Рассказчик', 'Narrador', 'Narrateur']) {
      expect(isDefaultNarratorName(n)).toBe(true);
    }
  });
  it('is false for a user rename and for empty/nullish', () => {
    expect(isDefaultNarratorName('The Bard')).toBe(false);
    expect(isDefaultNarratorName('')).toBe(false);
    expect(isDefaultNarratorName(undefined)).toBe(false);
    expect(isDefaultNarratorName(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/language-registry.test.ts`
Expected: FAIL — `isDefaultNarratorName` is not exported; `narratorName` is undefined for de/ru/es/fr.

- [ ] **Step 3: Add the field + names + helper**

In `server/src/tts/language-registry.ts`, add the field to the `LanguageEntry` interface (after `frontMatterKeywords?`):

```ts
  /** Localized narrator display name for this language. Absent on `en`
      (call sites default to "Narrator"). */
  narratorName?: string;
```

Add `narratorName` to each non-English entry in `ENTRIES` (alongside its existing fields):

- `ru` entry: `narratorName: 'Рассказчик',`
- `es` entry: `narratorName: 'Narrador',`
- `fr` entry: `narratorName: 'Narrateur',`
- `de` entry: `narratorName: 'Erzähler',`

Add the helper near `codeForSidecarName` (end of file):

```ts
/** True when `name` is a built-in narrator default — the English "Narrator" or
    any language's localized narrator name. Distinguishes a replaceable default
    from a user rename (which must survive reparse). Case-insensitive; trims. */
export function isDefaultNarratorName(name: string | undefined | null): boolean {
  if (typeof name !== 'string') return false;
  const key = name.trim().toLowerCase();
  if (!key) return false;
  if (key === 'narrator') return true;
  return ENTRIES.some((e) => e.narratorName?.toLowerCase() === key);
}
```

- [ ] **Step 4: Update the existing full-object registry expectations**

The `getLanguageEntry` tests assert the entire entry with `toEqual<LanguageEntry>`. Add `narratorName` to the ru/es/fr/de expected objects (the en test stays as-is). For each of those `expect(...).toEqual<LanguageEntry>({ ... })` blocks add the matching line, e.g. in the ru block:

```ts
      code: 'ru',
      sidecarName: 'Russian',
      supported: true,
      narratorName: 'Рассказчик',
```

Do the same for `es` (`'Narrador'`), `fr` (`'Narrateur'`), `de` (`'Erzähler'`). (If a language's full-object assertion doesn't exist in the file, skip it — only the four that do.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/tts/language-registry.test.ts`
Expected: PASS (all, including the updated full-object assertions).

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/language-registry.ts server/src/tts/language-registry.test.ts
git commit -m "feat(server): add per-language narratorName + isDefaultNarratorName"
```

---

### Task 2: `narrator-identity.ts` — the seed module

**Files:**
- Create: `server/src/analyzer/narrator-identity.ts`
- Test: `server/src/analyzer/narrator-identity.test.ts`

**Interfaces:**
- Consumes: `getLanguageEntry`, `isDefaultNarratorName` (Task 1); `CharacterOutput` from `handoff/schemas.ts`.
- Produces:
  - `FOLKLORIC_NARRATOR` — frozen persona constant.
  - `NARRATOR_DEFAULT_NAME = 'Narrator'`.
  - `applyNarratorIdentity(characters: CharacterOutput[], language: string): CharacterOutput[]`.

- [ ] **Step 1: Write the failing test**

Create `server/src/analyzer/narrator-identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CharacterOutput } from '../handoff/schemas.js';
import { applyNarratorIdentity, FOLKLORIC_NARRATOR } from './narrator-identity.js';

function narrator(over: Partial<CharacterOutput> = {}): CharacterOutput {
  return { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', ...over };
}
function hero(over: Partial<CharacterOutput> = {}): CharacterOutput {
  return { id: 'wren', name: 'Wren', role: 'protagonist', color: 'eliza', ...over };
}

describe('applyNarratorIdentity', () => {
  it('localizes the narrator name per language; en stays Narrator', () => {
    expect(applyNarratorIdentity([narrator()], 'de')[0].name).toBe('Erzähler');
    expect(applyNarratorIdentity([narrator()], 'ru')[0].name).toBe('Рассказчик');
    expect(applyNarratorIdentity([narrator()], 'es')[0].name).toBe('Narrador');
    expect(applyNarratorIdentity([narrator()], 'fr')[0].name).toBe('Narrateur');
    expect(applyNarratorIdentity([narrator()], 'en')[0].name).toBe('Narrator');
  });

  it('adds the "Narrator" alias exactly once', () => {
    const once = applyNarratorIdentity([narrator()], 'de')[0];
    expect(once.aliases).toEqual(['Narrator']);
    const twice = applyNarratorIdentity(applyNarratorIdentity([narrator()], 'de'), 'de')[0];
    expect(twice.aliases).toEqual(['Narrator']);
  });

  it('seeds the folkloric voice identity when there is no voiceStyle', () => {
    const n = applyNarratorIdentity([narrator()], 'de')[0];
    expect(n.voiceStyle).toBe(FOLKLORIC_NARRATOR.voiceStyle);
    expect(n.gender).toBe('neutral');
    expect(n.ageRange).toBe('adult');
    expect(n.tone).toEqual({ warmth: 40, pace: 50, authority: 60, emotion: 40 });
    expect(n.attributes).toEqual(['formal', 'observational', 'measured', 'rhythmic']);
  });

  it('preserves id, color, description, and other characters', () => {
    const out = applyNarratorIdentity([narrator({ description: 'forge-warm' }), hero()], 'de');
    expect(out[0].id).toBe('narrator');
    expect(out[0].color).toBe('narrator');
    expect(out[0].description).toBe('forge-warm');
    expect(out[1]).toEqual(hero());
  });

  it('does NOT clobber a user rename, but still adds the alias', () => {
    const out = applyNarratorIdentity([narrator({ name: 'The Bard' })], 'de')[0];
    expect(out.name).toBe('The Bard');
    expect(out.aliases).toEqual(['Narrator']);
  });

  it('does NOT clobber an existing voiceStyle or its companion fields', () => {
    const out = applyNarratorIdentity(
      [narrator({ voiceStyle: 'a crisp young herald', gender: 'male', attributes: ['bright'] })],
      'de',
    )[0];
    expect(out.voiceStyle).toBe('a crisp young herald');
    expect(out.gender).toBe('male');
    expect(out.attributes).toEqual(['bright']);
    expect(out.name).toBe('Erzähler'); // name localization still applies
  });

  it('is idempotent', () => {
    const once = applyNarratorIdentity([narrator()], 'de');
    const twice = applyNarratorIdentity(once, 'de');
    expect(twice).toEqual(once);
  });

  it('is a no-op with no narrator, and falls back to Narrator for unknown language', () => {
    expect(applyNarratorIdentity([hero()], 'de')).toEqual([hero()]);
    expect(applyNarratorIdentity([narrator()], 'zz')[0].name).toBe('Narrator');
  });

  it('never mutates the input array or its objects', () => {
    const input = [narrator()];
    const snapshot = JSON.parse(JSON.stringify(input));
    applyNarratorIdentity(input, 'de');
    expect(input).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/narrator-identity.test.ts`
Expected: FAIL — module `./narrator-identity.js` not found.

- [ ] **Step 3: Write the module**

Create `server/src/analyzer/narrator-identity.ts`:

```ts
/* Deterministic narrator identity for every newly analysed book.

   The narrator is the same character in every book, so its name and voice are
   seeded from code, not the model: a localized display name (with a "Narrator"
   alias) and one fixed folkloric persona identical across languages. This gives
   the narrator a designed voice instead of the Kokoro-preset fallback, and a
   consistent identity across a multi-language series.

   Pure and idempotent. A user's rename or re-designed voice is left untouched
   here; its survival across a reparse is handled by the cast merge
   (store/merge-analysis-cast.ts). No I/O, no model calls. */

import type { CharacterOutput } from '../handoff/schemas.js';
import { getLanguageEntry, isDefaultNarratorName } from '../tts/language-registry.js';

const NARRATOR_IDS = new Set(['narrator', 'char-narrator']);
export const NARRATOR_DEFAULT_NAME = 'Narrator';

/** The one fixed folkloric narrator persona, verbatim from the accepted Coalfall
    Russian narrator. Seeded onto a new book's narrator so every book — in every
    language — starts from the same designed voice. */
export const FOLKLORIC_NARRATOR = {
  voiceStyle:
    'A middle-aged voice, neutral in gender, with a medium pitch and steady, ' +
    'mid-paced delivery; the timbre is rich, grounded, and resonant, carrying ' +
    'a measured, folkloric warmth suitable for audiobook narration.',
  gender: 'neutral',
  ageRange: 'adult',
  tone: { warmth: 40, pace: 50, authority: 60, emotion: 40 },
  attributes: ['formal', 'observational', 'measured', 'rhythmic'],
} as const;

/** Seed the narrator (`id` 'narrator'/'char-narrator') with a localized display
    name + "Narrator" alias, and the fixed folkloric voice identity when it has
    no `voiceStyle` yet. Pure and idempotent; returns a new array, never mutates
    the input. Non-narrator characters and the no-narrator case pass through. */
export function applyNarratorIdentity(
  characters: CharacterOutput[],
  language: string,
): CharacterOutput[] {
  const localized = getLanguageEntry(language)?.narratorName ?? NARRATOR_DEFAULT_NAME;
  return characters.map((c) => {
    if (!NARRATOR_IDS.has(c.id)) return c;
    const next: CharacterOutput = { ...c };

    // Name: replace only when the current name is still a default (English
    // "Narrator" or any language's localized default). A user rename survives.
    if (isDefaultNarratorName(c.name)) next.name = localized;

    // Alias: ensure "Narrator" is present exactly once (case-insensitive).
    const aliases = Array.isArray(c.aliases) ? [...c.aliases] : [];
    if (!aliases.some((a) => a.trim().toLowerCase() === 'narrator')) {
      aliases.push(NARRATOR_DEFAULT_NAME);
    }
    next.aliases = aliases;

    // Voice identity: seed as a unit only when no voiceStyle has been set yet.
    if (!c.voiceStyle) {
      next.voiceStyle = FOLKLORIC_NARRATOR.voiceStyle;
      next.gender = FOLKLORIC_NARRATOR.gender;
      next.ageRange = FOLKLORIC_NARRATOR.ageRange;
      next.tone = { ...FOLKLORIC_NARRATOR.tone };
      next.attributes = [...FOLKLORIC_NARRATOR.attributes];
    }
    return next;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/narrator-identity.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/narrator-identity.ts server/src/analyzer/narrator-identity.test.ts
git commit -m "feat(server): narrator-identity module — localized name + folkloric persona seed"
```

---

### Task 3: Wire `applyNarratorIdentity` into both analyzer jobs

**Files:**
- Modify: `server/src/routes/analysis.ts` (import; seam at ~4259-4262; seam at ~5323)
- Test: `server/src/routes/analysis.test.ts`

**Interfaces:**
- Consumes: `applyNarratorIdentity` (Task 2); `bookLanguage` (already in scope in both jobs).
- Produces: persisted `cast.json` (and the streamed `response.characters`) carrying the localized+seeded narrator in both the full and subset analysis paths.

- [ ] **Step 1: Add the import**

At the top of `server/src/routes/analysis.ts`, with the other `../analyzer/...` imports, add:

```ts
import { applyNarratorIdentity } from '../analyzer/narrator-identity.js';
```

- [ ] **Step 2: Wire the main job seam**

In `runMainAnalyzerJob`, wrap the `characters` definition (currently at ~line 4259-4262). Replace:

```ts
    const characters = attachLinesAndScenes(
      assignPaletteColors(folded.characters),
      folded.sentences,
    );
```

with:

```ts
    const characters = applyNarratorIdentity(
      attachLinesAndScenes(assignPaletteColors(folded.characters), folded.sentences),
      bookLanguage,
    );
```

(`characters` feeds both `response.characters` and the merge at ~line 4380, so this single wrap covers the confirm-screen stream and the persisted cast.)

- [ ] **Step 3: Wire the subset job seam**

In `runSubsetAnalyzerJob`, wrap the `enriched` definition (currently at ~line 5323). Replace:

```ts
    const enriched = attachLinesAndScenes(assignPaletteColors(folded.characters), folded.sentences);
```

with:

```ts
    const enriched = applyNarratorIdentity(
      attachLinesAndScenes(assignPaletteColors(folded.characters), folded.sentences),
      bookLanguage,
    );
```

(`enriched` feeds the subset merge at ~line 5462.)

- [ ] **Step 4: Write the wiring assertion test**

In `server/src/routes/analysis.test.ts`, reuse the existing job harness in the `describe('runMainAnalyzerJob / runSubsetAnalyzerJob — analysisProvenance persistence ...')` block (starts ~line 2529) as the template — it already sets up a book dir, mocks the analyzer, runs `runMainAnalyzerJob(job, recordRef as never, phase0Selection, {...})`, and reads `cast.json` via `castPath(dir)`. Add a sibling test that:
1. Sets the book's on-disk `state.json` `language` to `'de'` in the harness setup (so `resolveBookLanguageForManuscript` returns `'de'`).
2. Ensures the mocked Phase-1 roster includes a narrator `{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' }`.
3. After the job, reads `cast.json` and asserts:

```ts
    const persisted = await readJson<{ characters: Array<{ id: string; name: string; voiceStyle?: string; aliases?: string[] }> }>(castPath(dir));
    const narr = persisted!.characters.find((c) => c.id === 'narrator')!;
    expect(narr.name).toBe('Erzähler');
    expect(narr.aliases).toContain('Narrator');
    expect(narr.voiceStyle).toContain('folkloric warmth');
```

Mirror the same assertions for a `runSubsetAnalyzerJob` case in the same block (it already exercises the subset job at ~line 2843).

- [ ] **Step 5: Run the analyzer suite**

Run: `cd server && npx vitest run src/routes/analysis.test.ts`
Expected: PASS — the new de-language assertions pass and every pre-existing analysis test stays green (proves the 2-line wraps didn't regress the jobs).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): seed narrator identity in both analyzer jobs"
```

---

### Task 4: Merge — narrator `name` carry-forward (rename survives reparse)

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts` (import; overlay block ~line 143-149)
- Test: `server/src/store/merge-analysis-cast.test.ts`

**Interfaces:**
- Consumes: `isDefaultNarratorName` (Task 1).
- Produces: `mergeAnalysisResultWithExistingCast` now carries the prior narrator `name` forward **only when it's a user rename**; default/localized names take the fresh value; real characters unchanged.

- [ ] **Step 1: Write the failing test**

Add to `server/src/store/merge-analysis-cast.test.ts` (match the file's existing import/describe style):

```ts
import { isDefaultNarratorName } from '../tts/language-registry.js';

describe('mergeAnalysisResultWithExistingCast — narrator name', () => {
  it('carries forward a user-renamed narrator across reparse', () => {
    const existing = [{ id: 'narrator', name: 'The Bard', voiceStyle: 'crisp herald' }];
    const fresh = [{ id: 'narrator', name: 'Erzähler', role: 'narrator', color: 'narrator' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    const n = merged.find((c) => c.id === 'narrator')!;
    expect(n.name).toBe('The Bard');
    expect((n as { voiceStyle?: string }).voiceStyle).toBe('crisp herald');
  });

  it('takes the fresh name when the prior narrator name was a language default (re-localizes)', () => {
    const existing = [{ id: 'narrator', name: 'Erzähler', voiceStyle: 'crisp herald' }];
    const fresh = [{ id: 'narrator', name: 'Narrateur', role: 'narrator', color: 'narrator' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.find((c) => c.id === 'narrator')!.name).toBe('Narrateur');
  });

  it('does NOT carry forward a non-narrator character name (still recomputed from fresh)', () => {
    const existing = [{ id: 'wren', name: 'Old Wren', voiceId: 'v1' }];
    const fresh = [{ id: 'wren', name: 'Wren', role: 'protagonist', color: 'eliza' }];
    const merged = mergeAnalysisResultWithExistingCast(existing, fresh);
    expect(merged.find((c) => c.id === 'wren')!.name).toBe('Wren');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts`
Expected: FAIL — the renamed narrator comes back as `'Erzähler'` (fresh name wins today).

- [ ] **Step 3: Add the carry-forward**

In `server/src/store/merge-analysis-cast.ts`, add the import near the top:

```ts
import { isDefaultNarratorName } from '../tts/language-registry.js';
```

In `mergeAnalysisResultWithExistingCast`, inside the `overlaid = fresh.map(...)` callback, after the aliases-union block (`if (aliases) merged.aliases = aliases;`) and before `return merged as T;`, add:

```ts
    // Narrator name is a code-seeded default/override, not model-derived. The
    // merge recomputes name from the fresh roster for real characters, but for
    // the narrator that would drop a user RENAME. Carry forward a non-default
    // prior name; a default prior name lets the fresh (re-localized) name win.
    if (
      (f.id === 'narrator' || f.id === 'char-narrator') &&
      typeof old.name === 'string' &&
      !isDefaultNarratorName(old.name)
    ) {
      merged.name = old.name;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts`
Expected: PASS (all three, plus the pre-existing merge tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/store/merge-analysis-cast.ts server/src/store/merge-analysis-cast.test.ts
git commit -m "feat(server): carry a renamed narrator forward across reparse"
```

---

### Task 5: Docs & shipping

**Files:**
- Create: `docs/features/252-narrator-localized-folkloric-identity.md`
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the regression plan**

Create `docs/features/252-narrator-localized-folkloric-identity.md` from `docs/features/TEMPLATE.md`. Frontmatter `status: active`, area server/analyzer. Document the invariants: narrator id stable at `'narrator'`; localized name per book language with `"Narrator"` alias; fixed folkloric persona seeded when no `voiceStyle`; applied in both `runMainAnalyzerJob` and `runSubsetAnalyzerJob`; user rename/`voiceStyle` survive reparse (merge carry-forward + `PRESERVED_VOICE_FIELDS`); no migration of existing books. Manual acceptance walkthrough: analyse a German manuscript → confirm screen shows `Erzähler` with a designed (not preset) narrator voice; rename to "Der Erzähler", reparse → name survives. Link the spec.

- [ ] **Step 2: Index the plan**

Add an entry for `252-narrator-localized-folkloric-identity.md` under the appropriate area in `docs/features/INDEX.md`.

- [ ] **Step 3: Release notes (technical register)**

Append to the current `## 🎙️ Voice design & casting` section (or add it) in `docs/release-notes-next.md`, one bold-lead bullet ending with the PR ref `(#NNNN)` (fill the PR number at PR time):

```markdown
- **Every new book's narrator now gets a localized name and one consistent folkloric voice, instead of an English "Narrator" on a Kokoro preset.** Newly analysed books seed the narrator (`id: 'narrator'`) with a per-language display name (`Erzähler` / `Рассказчик` / `Narrador` / `Narrateur`; `Narrator` kept as an alias) and a fixed folkloric voice persona, so the narrator gets a designed Qwen voice rather than the plan-108 preset fallback. Applied in both the full and subset analyzer jobs; a user rename or re-designed narrator voice survives reparse (merge carry-forward). No migration — existing books and shipped samples are untouched. (#NNNN)
```

- [ ] **Step 4: Release notes (user-facing)**

Add a matching brand-voice line to the in-progress version section at the top of `RELEASE_NOTES.md`, e.g.:

```markdown
- Your narrator now speaks the book's language from the first analysis — a German book opens with *Erzähler*, a Russian one with *Рассказчик* — and starts from one warm, folkloric storyteller's voice you can always redesign.
```

- [ ] **Step 5: Commit**

```bash
git add docs/features/252-narrator-localized-folkloric-identity.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(server): regression plan + release notes for narrator identity"
```

---

## Final verification (before PR)

- [ ] `cd server && npm run test` — full server suite green.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run verify:fast:branch` — branch-scoped battery green.
- [ ] Open the PR with `Closes #NNNN` (file/link a GitHub issue — `type:feature` + `area:server` — at PR time per the PR-gate), fill Summary + Test plan, link the spec and regression plan.
- [ ] Mandatory `code-review` pass (medium — single-scope `feat`) before merge.

## Self-Review

- **Spec coverage:** localized name (Task 1 names + Task 2 apply + Task 3 wiring); `"Narrator"` alias (Task 2); fixed folkloric persona + designed voice (Task 2 seed + Task 3 wiring; voice-style/cast-design unchanged per spec); both analyzer jobs (Task 3); merge name carry-forward + `isDefaultNarratorName` (Task 1 + Task 4); voiceStyle/aliases already durable (no task needed — asserted in Task 4/existing); no migration (Task 3 applies at analysis only; docs Task 5); captions/detection non-issues (documented in spec, no code). Covered.
- **Placeholder scan:** the only deferred value is the PR number `#NNNN` (unknowable until the PR exists) and the reuse of the existing analysis.test harness in Task 3 Step 4 (template cited by line, assertions given in full) — acceptable.
- **Type consistency:** `applyNarratorIdentity(CharacterOutput[], string): CharacterOutput[]`, `isDefaultNarratorName(string|undefined|null): boolean`, `FOLKLORIC_NARRATOR` fields, and narrator ids `'narrator'`/`'char-narrator'` are used identically across Tasks 2, 3, and 4.
