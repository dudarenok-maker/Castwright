# fs-60 — Coqui XTTS Per-Language Engine Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let en/ru/es/fr/de books use Coqui XTTS as a first-class casting choice and an automatic fallback when a designed Qwen voice is unavailable/undesigned, instead of being hard-locked to Qwen with no recovery path.

**Architecture:** A new per-engine `ENGINE_LANGUAGE_SUPPORT` data table (Qwen modeled as a wildcard to preserve today's unconditional non-English⇒Qwen invariant; Coqui scoped to the five analyze-supported languages) drives a single `resolveEligibleEngines` function that replaces the ad-hoc `isNonEnglish` boolean at every enforcement site. That eligibility is exposed as a new `eligibleTtsEngines` API field consumed identically by three frontend call sites. Server-side, Coqui gains per-synth language threading (was boot-time-only) and a second fallback branch alongside the existing Qwen→Kokoro one; a chapter that routes some characters to Qwen and others to Coqui-fallback is partitioned and rendered in two serial phases (Qwen then Coqui, with an explicit evict between) because the two engines' real VRAM footprints can co-exceed an 8 GB card even though the abstract cost table says they'd fit.

**Tech Stack:** TypeScript (Node/Express server, Vitest), Python (FastAPI TTS sidecar, pytest), React/Redux (frontend, Vitest + Testing Library), OpenAPI/openapi-typescript codegen.

## Global Constraints

- Kokoro stays out of scope entirely — no non-English Kokoro capability is added anywhere in this plan (fs-69 owns that).
- Only en/ru/es/fr/de gain Coqui eligibility — no other language is opened up (fs-70 owns that).
- The Qwen→Coqui fallback fires on exactly today's Qwen→Kokoro trigger condition (`!voiceName || qwenUnavailable`) — no new "erroring" trigger is added.
- No new per-voice `language` field is added to `overrideTtsVoices.coqui` — Coqui's catalog voices are language-agnostic; only a per-synth `language` parameter is threaded.
- `forbidKokoroFallback` is never renamed or repurposed — the new Coqui branch is a parallel, independently-gated path.
- `ENGINE_VRAM_COST` / `gpu.weight.*` numeric values are NOT changed by this plan — the residual cross-book Qwen+Coqui VRAM risk is accepted for v1, not silently "fixed" by retuning those weights.
- `autoPreloadKokoro` does not exist as a setting name anywhere — the real key is `tts.preload.kokoro` / env `PRELOAD_KOKORO`.
- No cross-book/cross-language voice-identity check is built (fs-71 owns that).
- Full spec: `docs/superpowers/specs/2026-07-04-fs60-xtts-language-eligibility-design.md`. Issue: `dudarenok-maker/Castwright#1005`.

---

## Task 1: `ENGINE_LANGUAGE_SUPPORT` table + `resolveEligibleEngines`

**Files:**
- Modify: `server/src/tts/model-keys.ts` (add `ALL_TTS_ENGINES` constant)
- Modify: `server/src/tts/voice-mapping.ts` (add `ENGINE_LANGUAGE_SUPPORT`)
- Modify: `server/src/tts/language.ts` (add `resolveEligibleEngines`)
- Test: `server/src/tts/language.test.ts`

**Interfaces:**
- Consumes: `TtsEngine` (`model-keys.ts:18`, `'coqui' | 'piper' | 'kokoro' | 'gemini' | 'qwen'`), `normaliseBookLanguage` (`language.ts:21`).
- Produces: `ALL_TTS_ENGINES: TtsEngine[]` (model-keys.ts), `ENGINE_LANGUAGE_SUPPORT: Record<TtsEngine, string[] | '*'>` (voice-mapping.ts), `resolveEligibleEngines(bookLanguage: string, installedEngines: TtsEngine[]): TtsEngine[]` (language.ts) — every later task in this plan calls one or both of the latter two.

- [ ] **Step 1: Write the failing test for `resolveEligibleEngines`**

Create `server/src/tts/language.test.ts` if it doesn't already exist as a describe block (check first — if the file exists, add this `describe` block to it rather than creating a new file):

```ts
import { describe, it, expect } from 'vitest';
import { resolveEligibleEngines } from './language.js';
import { ALL_TTS_ENGINES } from './model-keys.js';

describe('resolveEligibleEngines', () => {
  it('returns every installed engine for English', () => {
    expect(resolveEligibleEngines('en', ALL_TTS_ENGINES).sort()).toEqual(
      ['coqui', 'gemini', 'kokoro', 'piper', 'qwen'].sort(),
    );
  });

  it('returns qwen + coqui (not kokoro) for the five Coqui-eligible languages', () => {
    for (const lang of ['ru', 'es', 'fr', 'de']) {
      expect(resolveEligibleEngines(lang, ALL_TTS_ENGINES).sort()).toEqual(['coqui', 'qwen'].sort());
    }
  });

  it('returns only qwen for a still-unsupported non-English language (e.g. detected-but-unsupported zh)', () => {
    expect(resolveEligibleEngines('zh', ALL_TTS_ENGINES)).toEqual(['qwen']);
  });

  it('intersects with installedEngines — a Kokoro-only install on an English book excludes qwen/coqui', () => {
    expect(resolveEligibleEngines('en', ['kokoro'])).toEqual(['kokoro']);
  });

  it('a supported language with neither qwen nor coqui installed resolves to empty', () => {
    expect(resolveEligibleEngines('ru', ['kokoro', 'gemini'])).toEqual(['gemini']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/tts/language.test.ts`
Expected: FAIL — `resolveEligibleEngines` is not exported from `./language.js`, and `ALL_TTS_ENGINES` is not exported from `./model-keys.js`.

- [ ] **Step 3: Add `ALL_TTS_ENGINES` to `model-keys.ts`**

In `server/src/tts/model-keys.ts`, immediately after the `TtsEngine` type definition (line 18):

```ts
export type TtsEngine = 'coqui' | 'piper' | 'kokoro' | 'gemini' | 'qwen';

/* Every engine the TtsEngine union names — used wherever a caller needs "all
   engines that could possibly apply" rather than a specific installed set
   (fs-60): the enforcement-side eligibility checks and the eligibleTtsEngines
   API field both start from this and filter down. */
export const ALL_TTS_ENGINES: TtsEngine[] = ['coqui', 'piper', 'kokoro', 'gemini', 'qwen'];
```

- [ ] **Step 4: Add `ENGINE_LANGUAGE_SUPPORT` to `voice-mapping.ts`**

In `server/src/tts/voice-mapping.ts`, after the `qwenStorageKey` function (after line 25), add:

```ts
/* fs-60 — per-engine language capability. '*' means "every language this app
   can ever detect" (used for Qwen: the synthesis-routing invariant
   "non-English ⇒ Qwen, fail loud" — fs-2/plan 162 — is unconditional across
   EVERY non-English language, independent of whether the analyze pipeline's
   quality is tuned for it; modeling Qwen as only the five analyze-supported
   languages would silently narrow that invariant for a detected-but-unsupported
   language like zh/ja, per server/src/tts/language-registry.ts + detect-language.ts).
   Coqui is deliberately scoped to the five analyze-supported languages (fs-70
   owns opening further XTTS-capable languages). Kokoro/piper/gemini reflect
   today's de facto behavior: since the force-to-Qwen enforcement (Task 2) has
   always overridden every non-English character regardless of prior engine,
   none of them has ever actually rendered non-English audio in this app. */
export const ENGINE_LANGUAGE_SUPPORT: Record<TtsEngine, string[] | '*'> = {
  qwen: '*',
  coqui: ['en', 'ru', 'es', 'fr', 'de'],
  kokoro: ['en'],
  gemini: ['en'],
  piper: ['en'],
};
```

- [ ] **Step 5: Add `resolveEligibleEngines` to `language.ts`**

In `server/src/tts/language.ts`, add the import and function:

```ts
import { getLanguageEntry } from './language-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';
import type { TtsEngine } from './model-keys.js';
```

(Replace the existing single `import { getLanguageEntry } from './language-registry.js';` line with the three lines above.) Then, after `isNonEnglish` (end of file):

```ts
/** fs-60 — which engines from `installedEngines` are eligible to render
    `bookLanguage`, per ENGINE_LANGUAGE_SUPPORT. Pure data-driven filter — no
    per-language branching. Replaces the scattered isNonEnglish/forbidKokoroFallback
    derivations at the three server enforcement sites (generation.ts,
    chapter-splice.ts, chapter-qa-repair.ts) and backs the eligibleTtsEngines
    API field frontend callers read. */
export function resolveEligibleEngines(
  bookLanguage: string,
  installedEngines: TtsEngine[],
): TtsEngine[] {
  const lang = normaliseBookLanguage(bookLanguage);
  return installedEngines.filter((engine) => {
    const support = ENGINE_LANGUAGE_SUPPORT[engine];
    return support === '*' || support.includes(lang);
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run src/tts/language.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Run the full server typecheck to catch any import-cycle issue**

Run: `cd server && npx tsc --noEmit`
Expected: PASS. (`voice-mapping.ts` importing nothing new that could cycle back to `language.ts`; `language.ts` already sits below `voice-mapping.ts` in the dependency order established by `synthesise-chapter.ts`'s existing imports of both.)

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/model-keys.ts server/src/tts/voice-mapping.ts server/src/tts/language.ts server/src/tts/language.test.ts
git commit -m "feat(server): add ENGINE_LANGUAGE_SUPPORT + resolveEligibleEngines (fs-60)"
```

---

## Task 2: Wire eligibility into the three server enforcement sites

**Files:**
- Modify: `server/src/routes/generation.ts:590-675`
- Modify: `server/src/routes/chapter-splice.ts:244-271`
- Modify: `server/src/routes/chapter-qa-repair.ts:303-305`
- Test: `server/src/routes/generation-fallback-gate.test.ts` (already covers the fs-2 force-Qwen behavior in its `'fs-2 never-cross-language generation gate'` describe block, lines 250-390 — add a sibling describe block there, not a new file)

**Interfaces:**
- Consumes: `resolveEligibleEngines`, `ALL_TTS_ENGINES` (Task 1).
- Produces: each route now computes `coquiEligible: boolean` — consumed by Task 6's `synthesiseChapter` call sites.

This task fixes two real bugs discovered while mapping the code, both present in today's `isNonEnglish`-only design:

1. **The force-to-`'qwen'` loop stomps a deliberately-chosen eligible engine.** Today `generation.ts:592-593` and the equivalent lines in the other two routes unconditionally overwrite `c.ttsEngine = 'qwen'` for every character on a non-English book. Once the picker (Task 9) lets an operator manually choose Coqui for a ru/es/fr/de character, this loop would silently clobber that choice back to Qwen. Fix: only force to `'qwen'` when the character's current engine isn't already an eligible one.
2. **`generation.ts`'s whole-book abort ignores the new fallback.** `generation.ts:663-675` aborts the ENTIRE generation run before any chapter renders when Qwen is unavailable for a non-English book — this predates and bypasses the per-character `applyQwenFallback` this plan is adding (Task 6). Fix: only abort when there's genuinely no fallback (Coqui isn't eligible either); otherwise warn and let each Qwen-routed character fall back to Coqui per-chapter.

- [ ] **Step 1: Write the failing test for the force-loop fix**

In `server/src/routes/generation-fallback-gate.test.ts`, add a new sibling `describe` block immediately after the existing `describe('fs-2 never-cross-language generation gate', ...)` block (after its closing `});` around line 390) — this reuses the file's shared top-level `workspaceRoot`/`app`/`baseUrl`/`queuePath`/`readQueueFile`/`writeQueueFile` from the outer `beforeAll`, exactly like the block it follows, but seeds its own distinct book so it can't interfere with the other describe block's shared `ruBookId` fixture:

```ts
/* fs-60 — the force-to-qwen loop must honor an already-eligible manual engine
   choice (e.g. a character explicitly cast on Coqui via the picker) instead
   of blindly overwriting it, while still forcing an unset/ineligible engine
   to Qwen exactly as before. */
describe('fs-60 force-engine loop honors an eligible manual Coqui assignment', () => {
  const RU_COQUI_TITLE = 'Russian Coqui Fallback Gate Test';
  const RU_COQUI_MANUSCRIPT = 'm_ru_coqui_gate_test';
  const RU_COQUI_ENTRY = 'ru-coqui-gate-entry-1';
  let ruCoquiBookId: string;

  beforeAll(async () => {
    const [{ makeBookId }, cacheModule] = await Promise.all([
      import('../workspace/paths.js'),
      import('../store/analysis-cache.js'),
    ]);
    ruCoquiBookId = makeBookId(AUTHOR, SERIES, RU_COQUI_TITLE);
    const ruDir = join(workspaceRoot, 'books', AUTHOR, SERIES, RU_COQUI_TITLE);
    mkdirSync(join(ruDir, '.audiobook'), { recursive: true });
    mkdirSync(join(ruDir, 'audio'), { recursive: true });
    writeFileSync(
      join(ruDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: ruCoquiBookId,
        manuscriptId: RU_COQUI_MANUSCRIPT,
        author: AUTHOR,
        title: RU_COQUI_TITLE,
        series: SERIES,
        updatedAt: '2026-06-01T00:00:00.000Z',
        schema: 1,
        language: 'ru',
        chapters: [{ id: 1, title: 'Глава 1', slug: 'glava-1' }],
      }),
    );
    /* oleg is explicitly cast on Coqui (a manual picker choice); sofiya has no
       ttsEngine set (the force loop must still route her to Qwen). */
    writeFileSync(
      join(ruDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'oleg', name: 'Oleg', ttsEngine: 'coqui', overrideTtsVoices: { coqui: { name: 'Damien Black' } } },
          { id: 'sofiya', name: 'Sofiya', voiceId: 'v_sofiya', overrideTtsVoices: { qwen: { name: 'qwen-v_sofiya' } } },
        ],
      }),
    );
    await cacheModule.saveAnalysisCache(RU_COQUI_MANUSCRIPT, {
      chapters: {
        1: [
          { id: 1, chapterId: 1, characterId: 'oleg', text: 'Привет от Олега.' },
          { id: 2, chapterId: 1, characterId: 'sofiya', text: 'Привет от Софии.' },
        ],
      },
    });
  });

  beforeEach(async () => {
    await writeQueueFile(queuePath, {
      entries: [
        {
          id: RU_COQUI_ENTRY,
          bookId: ruCoquiBookId,
          chapterId: 1,
          scope: 'this',
          addedAt: '2026-06-01T00:00:00.000Z',
          status: 'in_progress',
          order: 0,
        },
      ],
      paused: false,
    });
  });

  it('does not stomp an already-eligible Coqui assignment; still forces the unset character to Qwen', async () => {
    const res = await fetch(`${baseUrl}/api/books/${ruCoquiBookId}/generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelKey: 'gemini-2.5-flash',
        chapterIds: [1],
        force: true,
        queueEntryId: RU_COQUI_ENTRY,
      }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).not.toContain('chapter_awaiting_fallback_confirm');
    expect(synthCalled).toBe(true);
    const oleg = lastSynthArgs?.cast?.find((c) => c.id === 'oleg');
    const sofiya = lastSynthArgs?.cast?.find((c) => c.id === 'sofiya');
    expect(oleg?.ttsEngine).toBe('coqui');
    expect(sofiya?.ttsEngine).toBe('qwen');
  }, 10_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/generation-fallback-gate.test.ts -t "does not stomp"`
Expected: FAIL — `oleg.ttsEngine` comes back `'qwen'` (today's unconditional loop overwrites every character, including an explicit Coqui assignment).

- [ ] **Step 3: Fix the force-loop + whole-book abort in `generation.ts`**

Replace `generation.ts:590-620` (the `bookLanguage`/`nonEnglishBook`/force-loop block):

```ts
  const bookLanguage = bookStateLanguage(state);
  const nonEnglishBook = isNonEnglish(bookLanguage);
  const eligibleEngines = resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES);
  const coquiEligible = eligibleEngines.includes('coqui');
  if (nonEnglishBook) {
    /* fs-60 — honor an already-eligible manual engine choice (e.g. a character
       explicitly cast on Coqui via the now-unlocked picker) instead of blindly
       overwriting it. Anything NOT already eligible (unset, or an engine this
       book's language can't use — e.g. Kokoro) still forces to Qwen exactly as
       before. */
    for (const c of cast.characters) {
      if (c.ttsEngine && eligibleEngines.includes(c.ttsEngine)) continue;
      c.ttsEngine = 'qwen';
    }
    let sidecarLang: string;
    try {
      sidecarLang = sidecarLanguageName(bookLanguage);
    } catch (e) {
      send({ type: 'chapter_failed', errorReason: (e as Error).message });
      return res.end();
    }
    const clearedVoices = await clearMismatchedDesignedVoices(
      cast.characters,
      sidecarLang,
      bookLanguage,
    );
    if (clearedVoices.length > 0) {
      const names = clearedVoices.map((c) => c.name).join(', ');
      send({
        type: 'warning',
        code: 'voice_language_mismatch',
        message:
          `${clearedVoices.length} designed voice(s) were cleared because they were designed for a ` +
          `different language than this book — re-design ${names} before generating.`,
      });
    }
  }
```

Add the import at the top of `generation.ts` (alongside the existing `isNonEnglish` import):

```ts
import { isNonEnglish, sidecarLanguageName, resolveEligibleEngines } from '../tts/language.js';
import { ALL_TTS_ENGINES } from '../tts/model-keys.js';
```

Then replace the whole-book abort block (`generation.ts:663-675`, the `if (qwenUnavailable && nonEnglishBook)` block):

```ts
  if (qwenUnavailable && nonEnglishBook && !coquiEligible) {
    /* fs-2 — a non-English book with NO fallback engine (still-unsupported
       language) CANNOT proceed if Qwen is unavailable. Abort the whole run
       before any chapter renders rather than emitting cross-language garbage. */
    const message =
      `This ${bookLanguage} book requires Qwen, but Qwen is unavailable ` +
      `(install-state: ${qwenState}). This language has no fallback engine, ` +
      `so no chapter can be generated. Start/refresh the TTS sidecar and load ` +
      `Qwen, then regenerate.`;
    console.warn(`[generation] ${message}`);
    send({ type: 'chapter_failed', errorReason: message });
    return res.end();
  }
  if (qwenUnavailable && nonEnglishBook && coquiEligible) {
    /* fs-60 — a Coqui-eligible non-English book (en/ru/es/fr/de) has a real
       fallback: don't abort the whole run, let every Qwen-routed character
       fall back to Coqui per-chapter (Task 6's applyQwenFallback branch). */
    const message =
      `Qwen is unavailable (install-state: ${qwenState}), so every Qwen character ` +
      `will render in Coqui — a fallback voice, NOT the designed Qwen voice. ` +
      `Check the TTS sidecar, then regenerate affected chapters.`;
    console.warn(`[generation] ${message}`);
    send({
      type: 'warning',
      code: 'qwen_unavailable_coqui_fallback',
      message,
      qwenInstallState: qwenState,
    });
  }
```

- [ ] **Step 4: Thread `coquiEligible` into the `synthesiseChapter` call**

At `generation.ts:1338-1351` (the `synthesiseChapter({...})` call), add `coquiEligible,` immediately after the existing `forbidKokoroFallback: nonEnglishBook,` line:

```ts
        forbidKokoroFallback: nonEnglishBook,
        coquiEligible,
        bookLanguage,
```

- [ ] **Step 5: Apply the same force-loop fix to `chapter-splice.ts`**

Replace `chapter-splice.ts:241-267`:

```ts
        /* fs-2/fs-60 — non-English book: force Qwen (unless a character is
           already on an eligible engine, e.g. a manually-cast Coqui voice) +
           forbid the English Kokoro fallback so an undesigned voice fails
           loudly rather than reading the wrong language. */
        const bookLanguage = bookStateLanguage(state);
        const nonEnglishBook = isNonEnglish(bookLanguage);
        const eligibleEngines = resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES);
        const coquiEligible = eligibleEngines.includes('coqui');
        if (nonEnglishBook) {
          for (const c of cast.characters) {
            if (c.ttsEngine && eligibleEngines.includes(c.ttsEngine)) continue;
            c.ttsEngine = 'qwen';
          }
          /* fs-32c — mirror generation: a reused designed Qwen voice whose
             baked manifest language ≠ this book's is cleared so the
             forbidKokoroFallback gate blocks it (undesigned) rather than
             re-recording the line in the wrong language. */
          const clearedVoices = await clearMismatchedDesignedVoices(
            cast.characters,
            sidecarLanguageName(bookLanguage),
            bookLanguage,
          );
          if (clearedVoices.length > 0) {
            const names = clearedVoices.map((c) => c.name).join(', ');
            send({
              type: 'warning',
              code: 'voice_language_mismatch',
              message:
                `${clearedVoices.length} designed voice(s) were cleared because they were designed for a ` +
                `different language than this book — re-design ${names} before generating.`,
            });
          }
        }
```

Add the same two imports used in Step 3 to the top of `chapter-splice.ts`.

Then at `chapter-splice.ts:294-307` (the `synthesiseChapter({...})` call), add `coquiEligible,` after `forbidKokoroFallback: nonEnglishBook,`.

- [ ] **Step 6: Apply the same force-loop fix to `chapter-qa-repair.ts`**

Replace `chapter-qa-repair.ts:303-305`:

```ts
      const bookLanguage = bookStateLanguage(state);
      const nonEnglishBook = isNonEnglish(bookLanguage);
      const eligibleEngines = resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES);
      const coquiEligible = eligibleEngines.includes('coqui');
      if (nonEnglishBook) {
        for (const c of cast.characters) {
          if (c.ttsEngine && eligibleEngines.includes(c.ttsEngine)) continue;
          c.ttsEngine = 'qwen';
        }
      }
```

Add the same two imports to the top of `chapter-qa-repair.ts`. Then at `chapter-qa-repair.ts:415-428` (the `synthesiseChapter({...})` call), add `coquiEligible,` after `forbidKokoroFallback: nonEnglishBook,`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/generation-fallback-gate.test.ts -t "does not stomp"`
Expected: PASS

- [ ] **Step 8: Run the full route test suites to check for regressions**

Run: `cd server && npx vitest run src/routes/generation-fallback-gate.test.ts src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts`
Expected: PASS — the existing "forces every character onto Qwen and threads forbidKokoroFallback + bookLanguage" / "fails fast for a cross-language reused voice" tests in `generation-fallback-gate.test.ts` must still pass unchanged (that describe block's fixtures never set an explicit `ttsEngine`, so `coquiEligible` being newly computed doesn't change their outcome). If `chapter-splice.test.ts` / `chapter-qa-repair.test.ts` have their own equivalent force-Qwen coverage, confirm those pass too for a still-unsupported language.

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/generation.ts server/src/routes/chapter-splice.ts server/src/routes/chapter-qa-repair.ts server/src/routes/generation-fallback-gate.test.ts
git commit -m "fix(server): eligibility-aware force-engine loop + whole-book abort (fs-60)"
```

---

## Task 3: `eligibleTtsEngines` API field

**Files:**
- Modify: `openapi.yaml` (`LibraryBook` schema, after the existing `language` field around line 3350)
- Modify: `server/src/workspace/scan.ts:266-310` (interface) and the book-builder function around line 722
- Regenerate: `src/lib/api-types.ts`
- Test: `server/src/workspace/scan.test.ts` (extend the existing `bookSkeleton` helper with an optional `language` option, add a new test to the `describe('scanLibrary derived stats', ...)` block)

**Interfaces:**
- Consumes: `resolveEligibleEngines`, `ALL_TTS_ENGINES` (Task 1).
- Produces: `LibraryBook.eligibleTtsEngines: TtsEngine[]` — consumed by Task 9's frontend selectors.

- [ ] **Step 1: Write the failing test**

`server/src/workspace/scan.test.ts`'s `bookSkeleton` helper (line 32) doesn't currently accept a `language` option — extend it, then add a new test using it. First, update `bookSkeleton`'s `opts` type and body:

```ts
function bookSkeleton(
  title: string,
  opts: {
    castConfirmed?: boolean;
    chapters?: Array<{ id: number; slug: string }>;
    language?: string;
  } = {},
) {
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  const audioRoot = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioRoot, { recursive: true });
  const chapters = opts.chapters ?? [{ id: 1, slug: 'chapter-one' }];
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: !!opts.castConfirmed,
      chapters: chapters.map((c) => ({ id: c.id, title: `Chapter ${c.id}`, slug: c.slug })),
      coverGradient: ['#000', '#fff'],
      language: opts.language,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  return { bookId, bookDir, audioRoot };
}
```

(This changes only the two marked lines — the new `language?: string` in the `opts` type, and the new `language: opts.language,` line in the written JSON. `undefined` serializes to an absent key via `JSON.stringify`, so every existing call site that doesn't pass `language` is byte-identical to before.)

Then add a new test to the `describe('scanLibrary derived stats', ...)` block:

```ts
it('includes eligibleTtsEngines on the built book, scoped by language (fs-60)', async () => {
  bookSkeleton('Russian Eligibility Test', { language: 'ru' });
  const books = await flatten();
  const book = books.find((b) => b.title === 'Russian Eligibility Test');
  expect(book?.eligibleTtsEngines?.slice().sort()).toEqual(['coqui', 'qwen']);
});

it('a still-unsupported language resolves to qwen-only eligibility (fs-60)', async () => {
  bookSkeleton('Chinese Eligibility Test', { language: 'zh' });
  const books = await flatten();
  const book = books.find((b) => b.title === 'Chinese Eligibility Test');
  expect(book?.eligibleTtsEngines).toEqual(['qwen']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/workspace/scan.test.ts -t "fs-60"`
Expected: FAIL — `book.eligibleTtsEngines` is `undefined` on both new tests (and `bookSkeleton`'s new `language` option is a type error until `LibraryBook`'s producing code is updated in Step 3-4).

- [ ] **Step 3: Add the field to the `LibraryBook` TypeScript interface**

In `server/src/workspace/scan.ts`, in the `LibraryBook` interface (starts line 266), add after the existing `language: string;` field (line 308):

```ts
  language: string;
  /** fs-60 — which TTS engines are eligible for this book's language,
      independent of install state (frontend intersects with its own
      installed-engines list). Computed via resolveEligibleEngines against
      the full engine set — not a live install probe. */
  eligibleTtsEngines: TtsEngine[];
```

Add the import at the top of `scan.ts`:

```ts
import { resolveEligibleEngines } from '../tts/language.js';
import { ALL_TTS_ENGINES, type TtsEngine } from '../tts/model-keys.js';
```

- [ ] **Step 4: Populate the field at the book-builder call site**

At `server/src/workspace/scan.ts:722` (the line reading `language: state ? bookStateLanguage(state) : normaliseBookLanguage(undefined),`), add immediately after it:

```ts
    language: state ? bookStateLanguage(state) : normaliseBookLanguage(undefined),
    eligibleTtsEngines: resolveEligibleEngines(
      state ? bookStateLanguage(state) : normaliseBookLanguage(undefined),
      ALL_TTS_ENGINES,
    ),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run src/workspace/scan.test.ts -t "fs-60"`
Expected: PASS (2 tests)

- [ ] **Step 6: Add the field to `openapi.yaml`**

In `openapi.yaml`, in the `LibraryBook` schema, immediately after the existing `language:` property (ends around line 3350, right before `prosodyEnabled:`):

```yaml
        eligibleTtsEngines:
          type: array
          items: { type: string, enum: [qwen, coqui, kokoro, gemini, piper] }
          description: |
            fs-60 — which TTS engines are eligible for this book's language
            (independent of which engines are actually installed on this
            deployment — the frontend intersects this with its own
            installed-engines list). Qwen is always eligible (the
            unconditional non-English⇒Qwen invariant, fs-2); Coqui is
            additionally eligible for en/ru/es/fr/de. Optional — like `tags`,
            `scan.ts` always populates it in practice, but the schema keeps it
            optional (NOT added to `required`) so existing test fixtures that
            construct a `LibraryBook` object literal without every field don't
            all need updating; every frontend consumer already defaults it
            with `?? [...]` (Tasks 9/10).
```

Do **not** add `eligibleTtsEngines` to the `required` array — this is a deliberate choice, not an oversight. Making it required would force a type error on every existing `LibraryBook` test fixture across the frontend (`book-library.test.tsx`'s `oneBook`/`base`, `routes/index.test.tsx`, `library-table.test.tsx`, and others) that constructs a partial object literal without it, exactly mirroring why `tags` (which `scan.ts` also always populates) isn't required either.

- [ ] **Step 7: Regenerate the frontend types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` regenerates with `eligibleTtsEngines` on the `LibraryBook`-equivalent generated type, no errors.

- [ ] **Step 8: Run the frontend typecheck to confirm no downstream break**

Run: `npx tsc --noEmit`
Expected: PASS — no existing code destructures `LibraryBook` exhaustively in a way that would break on an added field.

- [ ] **Step 9: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts server/src/workspace/scan.ts server/src/workspace/scan.test.ts
git commit -m "feat(server,openapi): add eligibleTtsEngines to LibraryBook (fs-60)"
```

---

## Task 4: Sidecar — per-request Coqui `language` parameter

**Files:**
- Modify: `server/tts-sidecar/main.py` (`Engine` base class ~line 675, `CoquiEngine.synthesize` ~line 892, `KokoroEngine.synthesize` ~line 1202, `QwenEngine.synthesize` ~line 2901, the `/synthesize` route handler ~line 5287-5366)
- Test: `server/tts-sidecar/tests/test_smoke.py` (extend `_FakeEngine`) or a new sibling test — check whether a `test_coqui_language.py` naming fits this repo's existing per-topic split test convention (`test_coqui_device.py` already exists for a similar narrowly-scoped Coqui concern) and prefer that pattern: create `server/tts-sidecar/tests/test_coqui_language.py`.

**Interfaces:**
- Consumes: nothing new server-side yet (Task 5 threads the Node-side caller).
- Produces: `Engine.synthesize(self, model, voice, text, language=None)` — every engine subclass's signature, consumed by the `/synthesize` route handler and by Task 5's Node-side request body.

- [ ] **Step 1: Write the failing test**

Create `server/tts-sidecar/tests/test_coqui_language.py`:

```python
"""test_coqui_language.py — per-request Coqui `language` param (fs-60).

Coqui previously read a single boot-time COQUI_LANGUAGE env var for every
synth call. This pins that /synthesize now accepts a per-request `language`
field that overrides the boot-time default, and that omitting it still
falls back to the env var (backward-compat for every existing English caller).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402


class _FakeCoquiEngine(main.CoquiEngine):
    """Captures the `language` argument synthesize() actually received,
    without loading the real ~3 GB XTTS model."""

    name = "coqui"

    def __init__(self) -> None:
        super().__init__()
        self.received_language: Optional[str] = None

    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> "main.SynthResult":
        self.received_language = language or self._language
        return main.SynthResult(pcm=b"\x00\x00", sample_rate=24000, substituted_from=None)


def test_synthesize_passes_request_language_to_coqui(monkeypatch) -> None:
    fake = _FakeCoquiEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "Claribel Dervla", "text": "hi", "language": "ru"},
        )
    assert r.status_code == 200
    assert fake.received_language == "ru"


def test_synthesize_omitted_language_falls_back_to_env_default(monkeypatch) -> None:
    monkeypatch.setenv("COQUI_LANGUAGE", "en")
    fake = _FakeCoquiEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "Claribel Dervla", "text": "hi"},
        )
    assert r.status_code == 200
    assert fake.received_language == "en"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_coqui_language.py -v`
Expected: FAIL — `TypeError: synthesize() got an unexpected keyword argument 'language'` (the route doesn't pass it yet) or the base signature rejects it.

- [ ] **Step 3: Add `language` to the `Engine` base class and all three subclasses**

In `server/tts-sidecar/main.py`, change the base class (line 675):

```python
    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> SynthResult:
        raise NotImplementedError
```

`CoquiEngine.synthesize` (line 892) — change the signature and both `self._language` reads (lines 933, 939):

```python
    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> SynthResult:
        self._ensure_loaded(model)
        assert self._tts is not None
        effective_language = language or self._language
```

Then replace `language=self._language` at both call sites (lines 933 and 939) with `language=effective_language`.

`KokoroEngine.synthesize` (line 1202) — change only the signature (the body doesn't use `language`, Kokoro ignores it):

```python
    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> SynthResult:
```

`QwenEngine.synthesize` (line 2901) — change only the signature (Qwen has its own existing `lang` derivation elsewhere in the file unrelated to this param; it ignores the new parameter):

```python
    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> SynthResult:
```

- [ ] **Step 4: Parse `language` from the request body and pass it through**

In `server/tts-sidecar/main.py`'s `/synthesize` route handler, after the existing `text = body.get("text")` line (~5296):

```python
    text = body.get("text")
    language = body.get("language")  # fs-60 — optional per-request language (Coqui only honors it)
```

Change the dispatch call (~line 5366):

```python
        result = await asyncio.to_thread(engine.synthesize, model, voice, text, language)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_coqui_language.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full sidecar suite to check for regressions**

Run: `npm run test:sidecar`
Expected: PASS — every other engine's `synthesize` call site (batch synth, voice-clone paths) still passes 3 positional args and now implicitly gets `language=None`, which is a no-op for Kokoro/Qwen.

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_coqui_language.py
git commit -m "feat(sidecar): thread per-request language param through /synthesize (fs-60)"
```

---

## Task 5: Node-side language threading (`SynthesizeInput` → sidecar request)

**Files:**
- Modify: `server/src/tts/index.ts:24-33` (`SynthesizeInput` interface)
- Modify: `server/src/tts/sidecar.ts:91-102` (`SidecarTtsProvider.synthesize` request body)
- Modify: `server/src/tts/synthesise-chapter.ts:985-990, 1165-1170` (the two `provider.synthesize({...})` call sites)
- Test: `server/src/tts/sidecar.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SynthesizeInput.language?: string` — consumed by every `TtsProvider.synthesize` caller; harmless no-op for `GeminiTtsProvider`.

- [ ] **Step 1: Write the failing test**

In `server/src/tts/sidecar.test.ts`, add a new `describe` block after the existing `describe('fs-57 — synthesizeBatch request body carries liveInstruct + per-item instruct', ...)` block (before `describe('SidecarTtsProvider error classification', ...)`), reusing the file's existing `stubFetch`/`mockFetch` setup:

```ts
describe('fs-60 — synthesize request body carries language', () => {
  it('includes language in the request body when provided', async () => {
    const bodies: unknown[] = [];
    stubFetch(async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
      });
    });
    await makeProvider().synthesize({
      text: 'hi',
      voiceName: 'Claribel Dervla',
      modelKey: 'coqui-xtts-v2',
      language: 'ru',
    });
    const body = bodies[0] as Record<string, unknown>;
    expect(body.language).toBe('ru');
  });

  it('omits language from the body when not provided (backward-compatible for existing English callers)', async () => {
    const bodies: unknown[] = [];
    stubFetch(async (_url: unknown, init: unknown) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
      });
    });
    await makeProvider().synthesize(SYNTH_INPUT);
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('language');
  });
});
```

(`makeProvider`, `stubFetch`, and `SYNTH_INPUT` are this file's existing top-level helpers, lines 35-47 — no new mocking setup needed.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/tts/sidecar.test.ts -t "fs-60"`
Expected: FAIL — TypeScript error (`language` isn't a valid `SynthesizeInput` property).

- [ ] **Step 3: Add `language` to `SynthesizeInput`**

In `server/src/tts/index.ts`, in the `SynthesizeInput` interface (line 24), add after `modelKey: TtsModelKey;`:

```ts
export interface SynthesizeInput {
  text: string;
  voiceName: string;
  modelKey: TtsModelKey;
  /** fs-60 — BCP-47 primary subtag for this synth call. Only Coqui honors it
      (threaded to the sidecar's per-request `language` field); every other
      engine/provider ignores it. Optional — omitted means "use the sidecar's
      boot-time COQUI_LANGUAGE default" (backward-compatible for English). */
  language?: string;
  signal?: AbortSignal;
}
```

- [ ] **Step 4: Thread it through `SidecarTtsProvider.synthesize`**

In `server/src/tts/sidecar.ts`, change the `synthesize` method (line 91):

```ts
  async synthesize({
    text,
    voiceName,
    modelKey,
    language,
    signal,
  }: SynthesizeInput): Promise<SynthesizeOutput> {
    const body = JSON.stringify({
      engine: this.engine,
      model: sidecarModelId(modelKey),
      voice: voiceName,
      text,
      ...(language != null ? { language } : {}),
    });
```

- [ ] **Step 5: Thread `langCode` into the two `provider.synthesize` call sites in `synthesise-chapter.ts`**

At `synthesise-chapter.ts:985-990` (the title-beat call):

```ts
            titleRoute.provider.synthesize({
              text: normaliseForTts(titleText, langCode),
              voiceName: narratorVoice,
              modelKey: titleRoute.modelKey,
              language: langCode,
              signal: sig,
            }),
```

(Match this against the existing exact argument list at that call site — add only the `language: langCode,` line, keep every other existing argument unchanged.)

At `synthesise-chapter.ts:1165-1170` (the body-group call):

```ts
            route.provider.synthesize({
              text: normaliseForTts(group.text, langCode),
              voiceName,
              modelKey: route.modelKey,
              language: langCode,
              signal: sig,
            }),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run src/tts/sidecar.test.ts -t "fs-60"`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the full synthesise-chapter suite to check for regressions**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts src/tts/sidecar.test.ts`
Expected: PASS — every existing English-book test still gets `language: 'en'` (from `langCode = normaliseBookLanguage(undefined) = 'en'`), byte-identical wire shape for Gemini/Kokoro/Qwen callers that ignore the field server-side.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/index.ts server/src/tts/sidecar.ts server/src/tts/synthesise-chapter.ts server/src/tts/sidecar.test.ts
git commit -m "feat(server): thread book language into every TTS synth call (fs-60)"
```

---

## Task 6: Qwen → Coqui fallback branch

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts:440-472` (`SynthesiseChapterOpts` interface), `:788-822` (destructuring), `:873-893` (`applyQwenFallback`)
- Test: `server/src/tts/synthesise-chapter-coqui-fallback.test.ts` (new file, mirroring the existing `synthesise-chapter-asr.test.ts` / `synthesise-chapter.spk.test.ts` per-topic split convention)

**Interfaces:**
- Consumes: `pickVoiceForEngine`, `toVoiceLike`, `buildHintFromCast` (already imported/defined in `synthesise-chapter.ts`), `MissingDesignedVoiceError` (already defined in this file).
- Produces: `SynthesiseChapterOpts.coquiEligible?: boolean` — set by all three call sites from Task 2.

- [ ] **Step 1: Write the failing test**

Create `server/src/tts/synthesise-chapter-coqui-fallback.test.ts`:

```ts
/* fs-60 — Qwen → Coqui graceful fallback for non-English books. Mirrors the
   structure of the existing "Qwen→Kokoro graceful fallback" and
   "forbidKokoroFallback" describe blocks in synthesise-chapter.test.ts — this
   is the Coqui-eligible-language counterpart to the still-unsupported-language
   fail-loud case those blocks already pin. */
import { describe, it, expect } from 'vitest';
import { synthesiseChapter, MissingDesignedVoiceError, type CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

const COQUI_VOICE_RE = /^[A-Z][a-z]+ [A-Z][a-z]+$/; // "Claribel Dervla"-shaped catalog names

function makeProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}

function sentence(id: number, characterId = 'wren'): SentenceOutput {
  return { id, chapterId: 1, characterId, text: 'Привет, это тестовое предложение для проверки.' };
}

function multiEngine() {
  const qwen = makeProvider();
  const coqui = makeProvider();
  const resolveForEngine = (e: string) =>
    e === 'coqui'
      ? { provider: coqui, modelKey: 'coqui-xtts-v2' as const }
      : { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const };
  return { qwen, coqui, resolveForEngine };
}

describe('synthesiseChapter — Qwen→Coqui fallback (fs-60)', () => {
  it('falls an undesigned Qwen character back to Coqui when coquiEligible + forbidKokoroFallback', async () => {
    const cast: CastCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female' }];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    expect(qwen.calls).toHaveLength(0);
    expect(coqui.calls).toHaveLength(1);
    expect(coqui.calls[0].voiceName).toMatch(COQUI_VOICE_RE);
    expect(coqui.calls[0].language).toBe('ru');
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBe('coqui');
  });

  it('still throws MissingDesignedVoiceError when coquiEligible is false (still-unsupported language)', async () => {
    const cast: CastCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female' }];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    await expect(
      synthesiseChapter({
        sentences: [sentence(1)],
        cast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        forbidKokoroFallback: true,
        coquiEligible: false,
        bookLanguage: 'zh',
      }),
    ).rejects.toBeInstanceOf(MissingDesignedVoiceError);

    expect(qwen.calls).toHaveLength(0);
    expect(coqui.calls).toHaveLength(0);
  });

  it('does NOT fall back a designed Qwen voice when the engine is available, even if coquiEligible', async () => {
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
    ];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'marlow')],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    expect(qwen.calls).toHaveLength(1);
    expect(coqui.calls).toHaveLength(0);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/tts/synthesise-chapter-coqui-fallback.test.ts`
Expected: FAIL — TypeScript error (`coquiEligible` isn't a valid `SynthesiseChapterOpts` property), or (once the type error is worked around) the first test throws `MissingDesignedVoiceError` instead of falling back.

- [ ] **Step 3: Add `coquiEligible` to `SynthesiseChapterOpts`**

In `server/src/tts/synthesise-chapter.ts`, in the interface (after `forbidKokoroFallback?: boolean;`, line 469):

```ts
  forbidKokoroFallback?: boolean;
  /** fs-60 — when true, a Qwen-routed character that needs the Kokoro
      fallback (blocked by forbidKokoroFallback) falls back to Coqui instead
      of throwing MissingDesignedVoiceError. Set by the three server routes
      from `resolveEligibleEngines(bookLanguage, ...).includes('coqui')`.
      Requires `resolveForEngine` (to obtain the Coqui provider). Default
      false — a still-unsupported non-English language keeps today's
      fail-loud behavior unchanged. */
  coquiEligible?: boolean;
```

- [ ] **Step 4: Destructure it in the function body**

In `synthesise-chapter.ts:788-822`, add `coquiEligible = false,` immediately after `forbidKokoroFallback = false,` (line 796).

- [ ] **Step 5: Add the Coqui branch to `applyQwenFallback`**

Replace `synthesise-chapter.ts:881-886`:

```ts
    /* fs-2 — on a non-English book the Kokoro fallback is forbidden: it would
       read the book's language through an English-only voice. fs-60 — if
       Coqui is eligible for this book's language, fall back there instead of
       failing; only a still-unsupported language (coquiEligible=false) fails
       loudly so the user designs the missing voice. */
    if (forbidKokoroFallback) {
      if (coquiEligible && resolveForEngine) {
        const coqui = resolveForEngine('coqui');
        return {
          route: { engine: 'coqui', provider: coqui.provider, modelKey: coqui.modelKey },
          voiceName: pickVoiceForEngine('coqui', toVoiceLike(c), buildHintFromCast(c)),
          renderedFallbackEngine: 'coqui',
        };
      }
      throw new MissingDesignedVoiceError(c.name ?? c.id, bookLanguage ?? 'non-English');
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run src/tts/synthesise-chapter-coqui-fallback.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Run the existing fallback + forbidKokoroFallback suites to check for regressions**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts`
Expected: PASS — every existing `forbidKokoroFallback: true` test in this file passes `coquiEligible` implicitly as `false` (unset), so `MissingDesignedVoiceError` still throws exactly as before for every one of them.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter-coqui-fallback.test.ts
git commit -m "feat(server): Qwen to Coqui fallback branch in applyQwenFallback (fs-60)"
```

---

## Task 7: Qwen/Coqui chapter-level partition + evict serialization

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts:1, 1482-1485, 1546, 1653` (imports + all THREE dispatch call sites — not just the initial body dispatch)
- Test: `server/src/tts/synthesise-chapter-coqui-fallback.test.ts` (extend from Task 6)

**Interfaces:**
- Consumes: `gpuSemaphore` (already imported), `resolveGroup` (already defined in this file), `synthGroupsBatched` (already defined in this file, Task 6's neighbor).
- Produces: `evictQwenForCoquiPhase(): Promise<void>` and `synthGroupsSerialized(groupList, onDone?): Promise<Map<number, GroupResult>>` (both local to `synthesise-chapter.ts`) — not consumed elsewhere; this task is self-contained.

**Additional accepted limitation, surfaced during plan review: `evictQwenForCoquiPhase` is a global unload, not scoped to this chapter's book.** It POSTs `/unload {engine:'qwen'}` to the one shared sidecar process. This app's concurrent multi-book workflow is a first-class invariant — if a *different* book is mid-Qwen-render on another worker when this chapter's Coqui phase evicts Qwen, that other book's in-flight Qwen synth gets evicted out from under it too, forcing an unplanned reload (not a correctness bug — Qwen reloads and that book's render continues — but a real, unbudgeted latency hit for an unrelated book). This is the same class of residual limitation the design spec's §4 already accepts for the VRAM-admission side of cross-book Qwen+Coqui concurrency; this plan extends that same acceptance to the eviction side-effect rather than building per-book-scoped eviction (which the sidecar's `/unload` endpoint doesn't support — it's process-wide by design). Flag this in Task 12's regression-plan doc as a named, accepted v1 limitation.

**This task's scope was corrected during plan review.** The first draft only wrapped the *initial* body dispatch (`groups.slice(bodyStartIndex)` at line 1482). But `synthesiseChapter` has **two more** dispatch sites that can re-synth a mixed Qwen+Coqui set — the segment-QA re-record loop (`synthGroupsBatched(pending)` at line 1546) and the ASR re-record loop (`synthGroupsBatched(pending)` at line 1653) — both of which run routinely in production whenever `maxSegmentRerecords > 0` or an `asr` option is supplied. Partitioning only the initial dispatch would let a re-record round reload Qwen while Coqui is still resident from the initial dispatch's second phase — exactly the co-residency this task exists to prevent, and invisible to a test that only exercises the initial-dispatch path. The fix: extract the partition-then-evict logic into one shared `synthGroupsSerialized` wrapper, and use it at **all three** dispatch sites instead of calling `synthGroupsBatched` directly at any of them.

**Also confirmed (resolves a plan-review "Unverifiable" flag):** `resolveForEngine('coqui')` does NOT require any character to be pre-configured on Coqui. `generation.ts`'s `resolveForEngine` (and the equivalent in `chapter-splice.ts`/`chapter-qa-repair.ts`) calls `canonicalModelKeyForEngine('coqui', modelKey)` → the static string `'coqui-xtts-v2'` (`model-keys.ts:90-91`), then `selectTtsProvider('coqui-xtts-v2')` (`tts/index.ts:106-121`) — a **stateless factory** that just constructs `new SidecarTtsProvider({ url, engine: 'coqui' })`. This is exactly how today's Kokoro fallback already works when no character is configured on Kokoro either. No character needs to be "configured" for Coqui — the fallback provider is built on demand, same as Kokoro's.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/synthesise-chapter-coqui-fallback.test.ts`:

```ts
it('serializes a mixed Qwen+Coqui chapter: all Qwen segments render before any Coqui segment starts', async () => {
  const cast: CastCharacter[] = [
    { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
    { id: 'wren', name: 'Wren', gender: 'female' }, // undesigned -> falls back to Coqui
  ];
  const { qwen, coqui, resolveForEngine } = multiEngine();
  const callOrder: string[] = [];
  const trackedQwen = {
    ...qwen,
    async synthesize(input: SynthesizeInput) {
      callOrder.push('qwen');
      return qwen.synthesize(input);
    },
  };
  const trackedCoqui = {
    ...coqui,
    async synthesize(input: SynthesizeInput) {
      callOrder.push('coqui');
      return coqui.synthesize(input);
    },
  };
  const tracked = (e: string) =>
    e === 'coqui'
      ? { provider: trackedCoqui, modelKey: 'coqui-xtts-v2' as const }
      : { provider: trackedQwen, modelKey: 'qwen3-tts-0.6b' as const };

  const result = await synthesiseChapter({
    sentences: [sentence(1, 'marlow'), sentence(2, 'wren'), sentence(3, 'marlow')],
    cast,
    provider: trackedQwen,
    modelKey: 'qwen3-tts-0.6b',
    engine: 'qwen',
    resolveForEngine: tracked,
    forbidKokoroFallback: true,
    coquiEligible: true,
    bookLanguage: 'ru',
  });

  // All 'qwen' entries must precede all 'coqui' entries — never interleaved.
  const firstCoqui = callOrder.indexOf('coqui');
  const lastQwen = callOrder.lastIndexOf('qwen');
  expect(firstCoqui).toBeGreaterThan(-1);
  expect(lastQwen).toBeLessThan(firstCoqui);
  // Output stays in original sentence-index order regardless of dispatch order.
  const bodySegments = result.segments.filter((s) => s.kind !== 'title');
  expect(bodySegments.map((s) => s.sentenceIds?.[0])).toEqual([1, 2, 3]);
});
```

This test needs `evictQwenForCoquiPhase`'s `fetch(.../unload)` call stubbed so it doesn't hit a real network address — `persona-gpu-plan.test.ts` already does exactly this for the sibling `unloadResidentSidecar` helper via `vi.spyOn(global, 'fetch')` (a plain global-fetch spy, since `evictQwenForCoquiPhase` — like `unloadResidentSidecar` — uses Node's built-in `fetch`, not the `undici`-specific one `SidecarTtsProvider` uses). Add this setup at the top of `synthesise-chapter-coqui-fallback.test.ts`, alongside the existing imports:

```ts
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});
```

(`describe`/`it`/`expect` are already imported per Step 1's import line — add `afterEach, vi` to that same import statement rather than a separate one.) Then, inside the `'serializes a mixed Qwen+Coqui chapter'` test, before the `synthesiseChapter({...})` call, add:

```ts
  vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/tts/synthesise-chapter-coqui-fallback.test.ts -t "serializes a mixed"`
Expected: FAIL — today's dispatch runs `synthGroupsBatched` once over the full mixed group list, so Qwen and Coqui calls interleave in original sentence order (`qwen, coqui, qwen`), not grouped.

- [ ] **Step 3: Add the `evictQwenForCoquiPhase` helper and partition logic**

Add the import at the top of `synthesise-chapter.ts` (alongside the existing `gpuSemaphore` import, line 41):

```ts
import { gpuSemaphore } from '../gpu/semaphore.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
```

Add the helper function immediately before the `synthesiseChapter` export (before line 785):

```ts
/* fs-60 — Qwen and Coqui are both VRAM-heavy engines whose real footprints
   can co-exceed an 8 GB card even though the abstract ENGINE_VRAM_COST budget
   check would admit them together (see the design spec §4). Rather than
   retuning that shared budget table (a separate, riskier change affecting
   every existing Qwen-concurrency decision), a mixed Qwen+Coqui chapter is
   partitioned into two serial phases with an explicit evict between them.
   Holds the FULL gpu semaphore budget during the unload (mirrors
   tts/persona-gpu-plan.ts's unloadResidentSidecar pattern) so a concurrent
   synth call from another book can't race the eviction — but, unlike that
   function, this one does NOT check activeGenerationBooks/refuse when a
   render is active: it's deliberately called *during* an active render, as
   part of this chapter's own sequencing. */
async function evictQwenForCoquiPhase(): Promise<void> {
  const release = await gpuSemaphore.acquire(gpuSemaphore.budget);
  try {
    const url = getResolvedSidecarUrl();
    const res = await fetch(`${url}/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'qwen' }),
    });
    if (!res.ok) {
      throw new Error(`Sidecar /unload returned ${res.status} ${res.statusText}`);
    }
  } finally {
    release();
  }
}

/* fs-60 — drop-in wrapper around synthGroupsBatched that adds the Qwen/Coqui
   serialization guarantee, for use at EVERY dispatch site in this function,
   not just the initial body dispatch. A re-record round (segment-QA or ASR)
   can re-synth a mixed pending set exactly as easily as the initial dispatch
   can — partitioning only the initial call would leave Coqui resident from
   its own second phase while a re-record round reloads Qwen, which is the
   exact co-residency this mechanism exists to prevent. Same signature as
   synthGroupsBatched (groupList, optional onDone) => Map<index, result>, so
   it's a drop-in replacement at every call site. When the group list doesn't
   actually mix qwen+coqui, this is a zero-overhead passthrough to
   synthGroupsBatched. Cost note: if MULTIPLE re-record rounds each mix
   engines, this evicts+reloads Qwen once per such round — a real perf cost,
   accepted deliberately in exchange for correctness; not optimized away in
   this task (redundant-evict avoidance is a follow-up, not a v1 requirement). */
async function synthGroupsSerialized(
  groupList: SentenceGroup[],
  onDone?: (group: SentenceGroup, result: GroupResult) => void,
): Promise<Map<number, GroupResult>> {
  const engines = new Set(groupList.map((g) => resolveGroup(g).route.engine));
  if (!(engines.has('qwen') && engines.has('coqui'))) {
    return synthGroupsBatched(groupList, onDone);
  }
  const qwenGroups = groupList.filter((g) => resolveGroup(g).route.engine === 'qwen');
  const coquiGroups = groupList.filter((g) => resolveGroup(g).route.engine === 'coqui');
  const out = new Map<number, GroupResult>();
  for (const [k, v] of await synthGroupsBatched(qwenGroups, onDone)) out.set(k, v);
  await evictQwenForCoquiPhase();
  for (const [k, v] of await synthGroupsBatched(coquiGroups, onDone)) out.set(k, v);
  return out;
}
```

Replace the body-dispatch call site at `synthesise-chapter.ts:1482-1485`:

```ts
  await synthGroupsSerialized(groups.slice(bodyStartIndex), (group, result) => {
    results[group.index] = result;
    fireComplete(group);
  });
```

Replace the segment-QA re-record call site at `synthesise-chapter.ts:1546` — change only the function name, the `timed(() => ...)` wrapper and everything else stays identical:

```ts
      const { value: fresh, ms: reMs } = await timed(() => synthGroupsSerialized(pending));
```

Replace the ASR re-record call site at `synthesise-chapter.ts:1653` — same, function name only:

```ts
      const { value: fresh, ms: asrReMs } = await timed(() => synthGroupsSerialized(pending));
```

- [ ] **Step 4: Write the failing test for the re-record gap**

Add to `server/src/tts/synthesise-chapter-coqui-fallback.test.ts`, alongside the previous test:

```ts
it('serializes a mixed Qwen+Coqui segment-QA re-record round too, not just the initial dispatch', async () => {
  const cast: CastCharacter[] = [
    { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
    { id: 'wren', name: 'Wren', gender: 'female' }, // undesigned -> falls back to Coqui
  ];
  const callOrder: string[] = [];
  let qwenCallCount = 0;
  const trackedQwen: TtsProvider = {
    async synthesize(): Promise<SynthesizeOutput> {
      qwenCallCount += 1;
      callOrder.push('qwen');
      /* First call for each sentence renders silence (fails segment-QA and
         triggers a re-record); the re-record call renders real audio. */
      const silent = qwenCallCount <= 2;
      return { pcm: Buffer.alloc(silent ? 4 : 4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
  const trackedCoqui: TtsProvider = {
    async synthesize(): Promise<SynthesizeOutput> {
      callOrder.push('coqui');
      return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
  const tracked = (e: string) =>
    e === 'coqui'
      ? { provider: trackedCoqui, modelKey: 'coqui-xtts-v2' as const }
      : { provider: trackedQwen, modelKey: 'qwen3-tts-0.6b' as const };

  await synthesiseChapter({
    sentences: [sentence(1, 'marlow'), sentence(2, 'wren')],
    cast,
    provider: trackedQwen,
    modelKey: 'qwen3-tts-0.6b',
    engine: 'qwen',
    resolveForEngine: tracked,
    forbidKokoroFallback: true,
    coquiEligible: true,
    bookLanguage: 'ru',
    maxSegmentRerecords: 1,
  });

  /* The re-record round (attempt 2 of Marlow's line, plus Wren's Coqui line
     already rendered in phase 1) must not interleave qwen after coqui has
     started — every 'qwen' entry precedes every 'coqui' entry, even across
     the initial dispatch AND the re-record round combined. */
  const firstCoqui = callOrder.indexOf('coqui');
  const lastQwen = callOrder.lastIndexOf('qwen');
  expect(firstCoqui).toBeGreaterThan(-1);
  expect(lastQwen).toBeLessThan(firstCoqui);
});
```

(This test's exact silence-then-real-audio sequencing depends on `evaluateSegmentPcm`'s actual suspect-detection thresholds — before implementing, run this test once against the CURRENT unfixed code to confirm the silent take is actually flagged `suspect` and a re-record round fires; if the default thresholds don't trigger on `Buffer.alloc(4, 0)`, adjust the fake's silence condition or pass an explicit `segmentQaThresholds` override until a re-record is reliably provoked — the mechanism under test is the *serialization*, not the QA gate's sensitivity, so tune the fixture rather than the assertion.)

- [ ] **Step 5: Run both new tests to verify they fail**

Run: `cd server && npx vitest run src/tts/synthesise-chapter-coqui-fallback.test.ts -t "serializes a mixed"`
Expected: FAIL — both tests fail. The initial-dispatch test fails because `synthGroupsBatched` is still called directly (no partitioning exists yet). The re-record test fails because even after Step 3 lands the initial-dispatch partition alone, the re-record loop still calls `synthGroupsBatched(pending)` directly on a mixed set.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/tts/synthesise-chapter-coqui-fallback.test.ts -t "serializes a mixed"`
Expected: PASS (both tests)

- [ ] **Step 7: Run the full synthesise-chapter suite to check for regressions**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts src/tts/synthesise-chapter-coqui-fallback.test.ts`
Expected: PASS — every English/single-engine/Kokoro+Qwen-mixed chapter's `groupList` never contains both `qwen` and `coqui` at any of the three dispatch sites, so `synthGroupsSerialized` takes the zero-overhead passthrough branch and behavior is byte-identical to calling `synthGroupsBatched` directly, at all three sites, for every existing test.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter-coqui-fallback.test.ts
git commit -m "feat(server): serialize Qwen/Coqui chapter dispatch, never co-resident (fs-60)"
```

---

## Task 8: `PRELOAD_KOKORO` default flips to off

**Files:**
- Modify: `server/src/config/registry.ts:529` (the `tts.preload.kokoro` entry's `default`)
- Test: `server/src/config/registry.test.ts` (find the existing default-value assertions and add/update one for this key)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this is a single default-value change.

- [ ] **Step 1: Write the failing test**

`registry.test.ts` has no existing test for `tts.preload.kokoro` specifically — it uses a `getKnob(key)` lookup (already imported at the top of the file, line 2: `import { GROUPS, KNOBS, allKnobs, getKnob, knobByEnv, knobsInGroup } from './registry.js';`) for this kind of single-key default assertion (see the existing `'registers ANALYZER_KEEP_ALIVE with a 5m default'` test). Add a new test using the same helper:

```ts
it('tts.preload.kokoro defaults to false (fs-60 — non-English books are no longer forced onto a single engine, so an always-hot English-only engine is a less universally good default)', () => {
  const k = getKnob('tts.preload.kokoro');
  expect(k).toBeDefined();
  expect(k?.env).toBe('PRELOAD_KOKORO');
  expect(k?.default).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/config/registry.test.ts -t "tts.preload.kokoro defaults to false"`
Expected: FAIL — current default is `true`.

- [ ] **Step 3: Flip the default**

In `server/src/config/registry.ts`, the full entry (lines 522-531) currently reads:

```ts
  {
    key: 'tts.preload.kokoro',
    env: 'PRELOAD_KOKORO',
    group: 'tts-engine',
    label: 'Preload Kokoro at startup',
    help: 'When true (default), the sidecar eagerly loads Kokoro v1 at startup (~1 s, ~1 GB VRAM). When false, Kokoro warms on demand on the first synth that needs it. Turn off if Qwen is your main engine and you want the ~1 GB VRAM back. Changing this requires a sidecar restart.',
    type: 'boolean',
    default: true, // ← PRELOAD_KOKORO default in tts-sidecar/main.py (line 2304, _parse_bool default=True)
    apply: 'restart-sidecar', risk: 'high',
  },
```

Replace the `help` and `default` lines (the `default` value AND its trailing comment, since that comment's claim about `main.py`'s default is what Task 4 area doesn't touch — `main.py`'s own `_parse_bool` fallback stays `True` for when `PRELOAD_KOKORO` is unset entirely, which is a different concern than THIS registry entry's `default` field, the value the app writes into `.env`/config on a fresh install):

```ts
  {
    key: 'tts.preload.kokoro',
    env: 'PRELOAD_KOKORO',
    group: 'tts-engine',
    label: 'Preload Kokoro at startup',
    help: 'When true, the sidecar eagerly loads Kokoro v1 at startup (~1 s, ~1 GB VRAM). When false (default), Kokoro warms on demand on the first synth that needs it — fs-60: non-English books can now use Coqui too, so an always-hot English-only engine is a less universally good default. Changing this requires a sidecar restart.',
    type: 'boolean',
    default: false, // fs-60 — was `true`; see help text above
    apply: 'restart-sidecar', risk: 'high',
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/config/registry.test.ts -t "tts.preload.kokoro defaults to false"`
Expected: PASS

- [ ] **Step 5: Run the full config test suite to check for regressions**

Run: `cd server && npx vitest run src/config/registry.test.ts`
Expected: PASS — check for any OTHER test in this file that hardcodes an expectation of `tts.preload.kokoro`'s default being `true` (e.g. a snapshot of the full registry, or a `buildSidecarEnv` test asserting `PRELOAD_KOKORO=1` by default) and update those too, since this default-value change is intentionally user-visible.

- [ ] **Step 6: Update `server/.env.example` if it documents this default**

Check `server/.env.example` for a `PRELOAD_KOKORO` line documenting the default; if present, update its comment to reflect the new `false` default.

- [ ] **Step 7: Commit**

```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts server/.env.example
git commit -m "fix(server): flip PRELOAD_KOKORO default to off (fs-60)"
```

---

## Task 9: Frontend — `cast.tsx` + `profile-drawer.tsx` eligibility derivation

**Files:**
- Modify: `src/routes/index.tsx:806` (thread `eligibleTtsEngines` alongside the existing `bookLanguage` prop)
- Modify: `src/views/cast.tsx:84, 136, 153` (`Props`, default, `isNonEnglish` derivation — becomes eligibility-based)
- Modify: `src/modals/profile-drawer.tsx:234-236, 279, 1037, 1039` (`bookLanguage` selector, `lockedToQwen`, hardcoded `installedEngines`)
- Test: `src/views/cast.test.tsx`, `src/modals/profile-drawer.test.tsx`

**Interfaces:**
- Consumes: `LibraryBook.eligibleTtsEngines` (Task 3, via the generated `api-types.ts`).
- Produces: `cast.tsx`'s `eligibleTtsEngines` prop and `profile-drawer.tsx`'s derived `lockedToQwen`/`installedEngines` — consumed nowhere else in this plan (leaf frontend wiring).

- [ ] **Step 1: Write the failing test for `profile-drawer.tsx`**

`profile-drawer.test.tsx`'s `makeStore`/`renderDrawer` helpers (lines 87-148) don't currently wire the `library` reducer at all — every existing test in this file implicitly renders with no `bookId` prop, so `bookLanguage` always defaults to `'en'` (no existing test exercises the locked path; that's covered at the component level in `voice-engine-picker.test.tsx` instead, which isn't touched by this task). Extend both helpers to optionally seed a library book:

Replace `makeStore` (line 87) and `renderDrawer`'s signature (line 101):

```ts
import { librarySlice } from '../store/library-slice';
import type { LibraryBook } from '../lib/types';

function makeStore({
  baseVoices,
  voices,
  libraryBook,
}: StoreSetup & { libraryBook?: LibraryBook } = {}) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      voices: voicesSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
      library: librarySlice.reducer,
    },
  });
  if (baseVoices) store.dispatch(voicesActions.hydrateBaseVoices(baseVoices));
  if (voices) store.dispatch(voicesActions.hydrate({ voices }));
  if (libraryBook) store.dispatch(librarySlice.actions.addBook(libraryBook));
  return store;
}
```

Update `StoreSetup` (line 82) to add `libraryBook?: LibraryBook;`, and `renderDrawer`'s `extra` param (line 101-121) to add `bookId?: string; libraryBook?: LibraryBook;`, passing both through:

```ts
function renderDrawer(
  character: Character,
  extra: {
    /* ...existing fields unchanged... */
    bookId?: string;
    libraryBook?: LibraryBook;
  } = {},
) {
  const store = makeStore({ baseVoices: extra.baseVoices, voices: extra.voices, libraryBook: extra.libraryBook });
  return {
    store,
    ...render(
      <Provider store={store}>
        <ProfileDrawer
          character={character}
          bookId={extra.bookId}
          voice={extra.voice}
          onClose={() => {}}
          onSave={() => {}}
          onLock={() => {}}
          mergeCandidates={extra.mergeCandidates}
          mergeCandidatesPrior={extra.mergeCandidatesPrior}
          onMerge={extra.onMerge}
          onLinkPrior={extra.onLinkPrior}
          onUnlinkAlias={extra.onUnlinkAlias}
          onAddAlias={extra.onAddAlias}
          onRename={extra.onRename}
          duplicateOther={extra.duplicateOther}
          onReviewDuplicate={extra.onReviewDuplicate}
          renderedFallbackEngine={extra.renderedFallbackEngine}
        />
      </Provider>,
    ),
  };
}
```

Then add a new describe block (mirroring the minimal `LibraryBook` fixture shape from `src/views/book-library.test.tsx`'s `oneBook`):

```ts
describe('ProfileDrawer — fs-60 eligibility-based engine lock', () => {
  const ruBook: LibraryBook = {
    bookId: 'ru-book-1',
    title: 'Russian Test Book',
    author: 'Test Author',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    status: 'cast_pending',
    chapterCount: 1,
    completedChapters: 0,
    characterCount: 1,
    voiceCount: 0,
    lastWorkedOn: 'today',
    coverGradient: ['#000', '#fff'],
    tags: [],
    language: 'ru',
    eligibleTtsEngines: ['qwen', 'coqui'],
  };

  it('unlocks the engine picker to Qwen + Coqui for a Coqui-eligible non-English book (ru)', () => {
    renderDrawer(baseChar, { bookId: 'ru-book-1', libraryBook: ruBook });
    expect(screen.queryByTestId('qwen-locked-note')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Qwen (bespoke)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Coqui XTTS' })).toBeInTheDocument();
  });

  it('still hard-locks to Qwen for a still-unsupported non-English language (zh)', () => {
    renderDrawer(baseChar, {
      bookId: 'zh-book-1',
      libraryBook: { ...ruBook, bookId: 'zh-book-1', language: 'zh', eligibleTtsEngines: ['qwen'] },
    });
    expect(screen.getByTestId('qwen-locked-note')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modals/profile-drawer.test.tsx -t "fs-60"`
Expected: FAIL — `lockedToQwen` is still derived from `bookLanguage !== 'en'`, so the Russian book stays locked (first test fails); TypeScript also errors since `ProfileDrawer` doesn't yet read `eligibleTtsEngines` and `installedEngines` is still the hardcoded `['kokoro', 'qwen']` (no `Coqui XTTS` option exists to find).

- [ ] **Step 3: Update `profile-drawer.tsx`'s selector and derivation**

At `profile-drawer.tsx:234-236`, add a second selector alongside the existing `bookLanguage` one:

```ts
  const bookLanguage = useAppSelector(
    (s) => s.library?.books?.find((b) => b.bookId === bookId)?.language ?? 'en',
  );
  const eligibleTtsEngines = useAppSelector(
    (s): TtsEngine[] =>
      s.library?.books?.find((b) => b.bookId === bookId)?.eligibleTtsEngines ?? [
        'qwen',
        'kokoro',
        'coqui',
        'gemini',
        'piper',
      ],
  );
```

(Import `TtsEngine` from `../lib/types` at the top of `profile-drawer.tsx` if not already imported in this file.)

At `profile-drawer.tsx:279`, replace:

```ts
  const lockedToQwen = bookLanguage !== 'en';
```

with:

```ts
  /* fs-60 — lockedToQwen means "the ONLY eligible engine is Qwen" (a
     still-unsupported non-English language), NOT "there's exactly one
     eligible engine" — a Kokoro-only or Coqui-only install on an ENGLISH
     book must not hard-lock to a disabled, uninstalled Qwen option. */
  const lockedToQwen = eligibleTtsEngines.length === 1 && eligibleTtsEngines[0] === 'qwen';
```

At `profile-drawer.tsx:1037`, replace the hardcoded array:

```ts
              installedEngines={['kokoro', 'qwen']}
```

with:

```ts
              installedEngines={(['kokoro', 'qwen', 'coqui'] as const).filter((e) =>
                eligibleTtsEngines.includes(e),
              )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modals/profile-drawer.test.tsx -t "Coqui-eligible"`
Expected: PASS

- [ ] **Step 5: Confirm `cast.tsx` needs no new behavioral test**

`cast.tsx` itself never renders `voice-engine-picker.tsx` directly — it opens `ProfileDrawer` (Task 9's Step 1-4 target) as a modal, which owns the picker. `cast.tsx`'s only job here is to receive and forward the new `eligibleTtsEngines` prop (Step 6 below) so a future consumer can read it; it has no eligibility-gated rendering of its own to test. Skip writing a new `cast.test.tsx` case for this step — Step 7's typecheck plus the existing `cast.test.tsx` suite passing unmodified (Step 8) is the correct verification here, not a new assertion.

- [ ] **Step 6: Thread `eligibleTtsEngines` prop through `cast.tsx` and `routes/index.tsx`**

In `src/views/cast.tsx`, add to the `Props` interface (near line 84, alongside `bookLanguage?: string;`):

```ts
  bookLanguage?: string;
  eligibleTtsEngines?: TtsEngine[];
```

(Add the `TtsEngine` type import from `../lib/types` if not already imported in this file.) Add the destructured default near line 136:

```ts
  bookLanguage = 'en',
  eligibleTtsEngines = ['qwen', 'kokoro', 'coqui', 'gemini', 'piper'],
```

In `src/routes/index.tsx:806`, add alongside the existing prop:

```ts
          bookLanguage={activeBook?.language ?? 'en'}
          eligibleTtsEngines={activeBook?.eligibleTtsEngines}
```

- [ ] **Step 7: Run the frontend typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Run the full frontend test suite for these two files**

Run: `npx vitest run src/views/cast.test.tsx src/modals/profile-drawer.test.tsx`
Expected: PASS — every existing English-book test gets the default `['qwen','kokoro','coqui','gemini','piper']` eligible set (unlocked, byte-identical to before this task), every existing still-unsupported-non-English test (if any pass an explicit `eligibleTtsEngines: ['qwen']` fixture) stays locked.

- [ ] **Step 9: Commit**

```bash
git add src/routes/index.tsx src/views/cast.tsx src/modals/profile-drawer.tsx src/views/cast.test.tsx src/modals/profile-drawer.test.tsx
git commit -m "feat(frontend): eligibility-based engine picker lock (fs-60)"
```

---

## Task 10: Frontend — `voice-readiness-gate.tsx` soft-gate + Coqui copy

**Files:**
- Modify: `src/store/voice-readiness-selectors.ts:58-76` (`selectIsBookNonEnglish` → `selectHasNoFallbackEngine`, `voiceReadinessGateMessage`)
- Modify: `src/modals/voice-readiness-gate.tsx:16-19, 37, 116-137` (import + usage + the "Proceed anyway" button/copy branch)
- Test: `src/store/voice-readiness-selectors.test.ts`, `src/modals/voice-readiness-gate.test.tsx`

**Interfaces:**
- Consumes: `LibraryBook.eligibleTtsEngines` (Task 3).
- Produces: `selectHasNoFallbackEngine(state, bookId): boolean`, `voiceReadinessGateMessage` gains a third message variant — leaf frontend wiring, nothing downstream in this plan depends on it.

- [ ] **Step 1: Write the failing test for the selector**

This file's `mk()` helper (line 11-22) builds a fabricated `RootState` with `books: { bookId: string; language?: string }[]` — extend that inline type to also accept `eligibleTtsEngines?: string[]`:

```ts
const mk = (opts: {
  characters?: Partial<Character>[];
  voices?: Partial<Voice>[];
  ttsModelKey?: TtsModelKey;
  books?: { bookId: string; language?: string; eligibleTtsEngines?: string[] }[];
}): RootState =>
  ({
    cast: { characters: (opts.characters ?? []) as Character[] },
    voices: { voices: (opts.voices ?? []) as Voice[] },
    ui: { ttsModelKey: opts.ttsModelKey ?? 'qwen3-tts-0.6b' },
    library: { books: opts.books ?? [] },
  }) as unknown as RootState;
```

(This changes only the `books` field's inline type — the function body is untouched.) Then replace the `describe('selectIsBookNonEnglish', ...)` block (lines 129-145) with:

```ts
describe('selectHasNoFallbackEngine', () => {
  it('is false for a Coqui-eligible non-English book (ru)', () => {
    const s = mk({ books: [{ bookId: 'b1', language: 'ru', eligibleTtsEngines: ['qwen', 'coqui'] }] });
    expect(selectHasNoFallbackEngine(s, 'b1')).toBe(false);
  });

  it('is true for a still-unsupported non-English language (zh)', () => {
    const s = mk({ books: [{ bookId: 'b1', language: 'zh', eligibleTtsEngines: ['qwen'] }] });
    expect(selectHasNoFallbackEngine(s, 'b1')).toBe(true);
  });

  it('is false for English', () => {
    const s = mk({
      books: [{ bookId: 'b1', language: 'en', eligibleTtsEngines: ['qwen', 'kokoro', 'coqui', 'gemini'] }],
    });
    expect(selectHasNoFallbackEngine(s, 'b1')).toBe(false);
  });

  it('defaults to false (assume every engine eligible) when the book is missing, matching the old missing-book default', () => {
    expect(selectHasNoFallbackEngine(mk({ books: [] }), 'missing')).toBe(false);
  });
});
```

Update the import at the top of the file (line 5) from `selectIsBookNonEnglish` to `selectHasNoFallbackEngine`. Also update the `voiceReadinessGateMessage` describe block (lines 147-167) — its existing "hard-block copy for a non-English book" test (lines 161-167) uses a bare `{ bookId: 'b1', language: 'ru' }` fixture with no `eligibleTtsEngines` set. **This must change**: `selectHasNoFallbackEngine`'s missing-field default is now "assume every engine eligible" (Step 3's fix above, `?? ['qwen','kokoro','coqui','gemini','piper']`) — so a bare `language: 'ru'` book with no `eligibleTtsEngines` would now resolve to the **soft-gate** copy, not the hard-block copy, breaking this existing test. Replace it with the two tests below (still-unsupported hard-block + Coqui-eligible soft-gate), both with `eligibleTtsEngines` set explicitly so neither test relies on the missing-field default's behavior:

```ts
it('returns the hard-block copy for a still-unsupported non-English book', () => {
  const s = mk({
    characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
    books: [{ bookId: 'b1', language: 'zh', eligibleTtsEngines: ['qwen'] }],
  });
  expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/can't fall back to a generic voice/);
});

it('returns the Coqui-worded soft-gate copy for a Coqui-eligible non-English book (ru)', () => {
  const s = mk({
    characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
    books: [{ bookId: 'b1', language: 'ru', eligibleTtsEngines: ['qwen', 'coqui'] }],
  });
  expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/render with a Coqui fallback voice/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/store/voice-readiness-selectors.test.ts -t "fs-60|selectHasNoFallbackEngine|Coqui-worded"`
Expected: FAIL — `selectHasNoFallbackEngine` doesn't exist yet (import error), and the still-unsupported-language test's `zh` fixture currently isn't even reachable since `selectIsBookNonEnglish` (today's function) only checks `language !== 'en'`, not eligibility.

- [ ] **Step 3: Replace `selectIsBookNonEnglish` with `selectHasNoFallbackEngine`**

In `src/store/voice-readiness-selectors.ts`, replace the function at lines 58-63:

```ts
/** fs-60 — true only when this book's language has NO fallback engine at
    all (a still-unsupported non-English language — Coqui isn't in
    eligibleTtsEngines either). A Coqui-eligible language (en/ru/es/fr/de)
    gets the soft-gate below instead of a hard block, since an undesigned
    Qwen character falls back to Coqui rather than failing. */
export function selectHasNoFallbackEngine(state: RootState, bookId: string): boolean {
  const book = state.library?.books?.find((b) => b.bookId === bookId);
  /* Missing book data (not yet loaded) defaults to "assume every engine is
     eligible" — i.e. NOT blocked — mirroring the old selectIsBookNonEnglish's
     "defaults to English (false)" posture for the same missing-data case,
     rather than flashing a hard-block while the library is still loading. */
  const eligible = book?.eligibleTtsEngines ?? ['qwen', 'kokoro', 'coqui', 'gemini', 'piper'];
  return !eligible.includes('coqui') && !eligible.includes('kokoro');
}
```

Then update `voiceReadinessGateMessage` (lines 65-76):

```ts
/** fs-46/fs-60 — message-builder pair mirroring `analysisBusyMessage`. Three
    branches: English's existing soft-gate (Kokoro fallback), the NEW
    Coqui-eligible soft-gate (ru/es/fr/de), and the still-unsupported-language
    hard block (unchanged copy). Returns null when the gate shouldn't fire. */
export function voiceReadinessGateMessage(state: RootState, bookId: string): string | null {
  if (!selectVoiceReadinessGateShouldFire(state, bookId)) return null;
  if (selectHasNoFallbackEngine(state, bookId)) {
    return "This book can't fall back to a generic voice — every speaking character needs a designed voice.";
  }
  const book = state.library?.books?.find((b) => b.bookId === bookId);
  const isEnglish = (book?.language ?? 'en') === 'en';
  return isEnglish
    ? "These speaking characters haven't been designed yet. Design them now, or proceed and they'll render with a generic Kokoro fallback voice."
    : "These speaking characters haven't been designed yet. Design them now, or proceed and they'll render with a Coqui fallback voice.";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/store/voice-readiness-selectors.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for the modal's "Proceed anyway" affordance**

`voice-readiness-gate.test.tsx`'s `makeStore` helper (line 25-58) accepts a `language` option but not `eligibleTtsEngines` — extend it:

```ts
function makeStore(opts: {
  bookId?: string;
  language?: string;
  eligibleTtsEngines?: string[];
  characters?: Character[];
  designActive?: { bookId: string; state: string } | null;
} = {}) {
  const bookId = opts.bookId ?? 'b1';
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      voices: voicesSlice.reducer,
      library: librarySlice.reducer,
      castDesign: castDesignSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId, view: 'manuscript', currentChapterId: 1, openProfileId: null },
        voiceReadinessGate: { bookId },
      } as never,
      cast: { ...castSlice.getInitialState(), characters: opts.characters ?? [] },
      library: {
        ...librarySlice.getInitialState(),
        books: [{ bookId, language: opts.language ?? 'en', eligibleTtsEngines: opts.eligibleTtsEngines }],
      } as never,
      castDesign: {
        ...castDesignSlice.getInitialState(),
        active: opts.designActive as never,
      },
    },
  });
  return store;
}
```

(This changes only the `opts` type and the `books` array's `eligibleTtsEngines` field — the rest of the function is unchanged.) Then add two tests immediately after the existing `'non-English book omits the proceed affordance entirely'` test (line 93-105):

```ts
it('a Coqui-eligible non-English book (ru) shows Proceed anyway with Coqui-worded copy', () => {
  const store = makeStore({
    characters: [qwenChar({ id: 'a', name: 'Alice', lines: 3 })],
    language: 'ru',
    eligibleTtsEngines: ['qwen', 'coqui'],
  });
  render(
    <Provider store={store}>
      <VoiceReadinessGateModal />
    </Provider>,
  );
  expect(screen.getByText(/Proceed anyway/)).toBeInTheDocument();
  expect(screen.getByText(/render with a Coqui fallback voice/)).toBeInTheDocument();
});

it('a still-unsupported non-English book (zh) still omits the proceed affordance', () => {
  const store = makeStore({
    characters: [qwenChar({ id: 'a', name: 'Alice', lines: 3 })],
    language: 'zh',
    eligibleTtsEngines: ['qwen'],
  });
  render(
    <Provider store={store}>
      <VoiceReadinessGateModal />
    </Provider>,
  );
  expect(screen.queryByText(/Proceed anyway/)).not.toBeInTheDocument();
  expect(screen.getByText(/can't fall back to a generic voice/)).toBeInTheDocument();
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/modals/voice-readiness-gate.test.tsx -t "Coqui-eligible non-English"`
Expected: FAIL — the modal currently reads `selectIsBookNonEnglish`, which only checks `language !== 'en'` and ignores `eligibleTtsEngines` entirely, so the Russian book still hides "Proceed anyway" and shows the hard-block copy.

- [ ] **Step 7: Update `voice-readiness-gate.tsx`'s import and branch condition**

Replace the import at lines 16-19:

```ts
import {
  selectUndesignedQwenCharacters,
  selectHasNoFallbackEngine,
  voiceReadinessGateMessage,
} from '../store/voice-readiness-selectors';
```

Replace the `isNonEnglish` derivation (line 37):

```ts
  const hasNoFallbackEngine = useAppSelector((s) =>
    gate ? selectHasNoFallbackEngine(s, gate.bookId) : false,
  );
```

Find every remaining use of `isNonEnglish` in this file (the "Proceed anyway" button's conditional render, around lines 116-137) and rename it to `hasNoFallbackEngine` — the boolean semantics are byte-identical to before at every OTHER call site (`isNonEnglish` and `hasNoFallbackEngine` agreed for every language before this task; they only diverge for the new en/ru/es/fr/de-with-Coqui-eligible case, which is exactly the case that should now show "Proceed anyway").

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/modals/voice-readiness-gate.test.tsx`
Expected: PASS

- [ ] **Step 9: Run the full test suite for both files to check for regressions**

Run: `npx vitest run src/store/voice-readiness-selectors.test.ts src/modals/voice-readiness-gate.test.tsx`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/store/voice-readiness-selectors.ts src/modals/voice-readiness-gate.tsx src/store/voice-readiness-selectors.test.ts src/modals/voice-readiness-gate.test.tsx
git commit -m "feat(frontend): eligibility-aware readiness-gate soft-gate + Coqui copy (fs-60)"
```

---

## Task 11: E2E — Russian book Qwen-failure resolves via Coqui fallback

**Files:**
- Create: `e2e/generation/coqui-fallback-non-english.spec.ts`
- Reference fixture: `server/src/__fixtures__/the-coalfall-commission.ru.md` (already exists per CLAUDE.md's canonical-fixture guidance — do not invent a new manuscript)

**Interfaces:**
- Consumes: the full stack wired by Tasks 1-10.
- Produces: nothing consumed elsewhere — this is the plan's terminal verification task.

- [ ] **Step 1: Find an existing e2e spec exercising the Russian canonical fixture**

Run: `grep -rl "the-coalfall-commission.ru" e2e/` and open whichever spec(s) it finds to mirror their exact book-import + confirm-language + cast-setup boilerplate (do not hand-roll a new import flow).

- [ ] **Step 2: Write the failing e2e test**

Create `e2e/generation/coqui-fallback-non-english.spec.ts`, structured as: import the Russian fixture (mirroring Step 1's boilerplate) → confirm language `ru` → in the cast view, leave the narrator character undesigned (no Qwen voice minted) → click Generate → assert the chapter completes (not `chapter_failed`) and the rendered segment's status/badge indicates a Coqui fallback (mirror however the existing Kokoro-fallback badge is asserted in an existing English-book e2e spec — search for `Fallback (Kokoro)` in `e2e/` to find that assertion pattern and mirror it for Coqui).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:e2e -- coqui-fallback-non-english`
Expected: FAIL — before this plan's server-side changes ship, an undesigned Qwen character on a Russian book throws `MissingDesignedVoiceError` and the chapter fails instead of completing.

(This step only truly fails against a build WITHOUT Tasks 1-10 applied. If run after all prior tasks are committed, skip straight to Step 4 — the point of Step 2/3 here is to confirm the spec is written correctly against the pre-fs-60 baseline if this task is executed out of order; in the normal task sequence, this test should already pass once written.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:e2e -- coqui-fallback-non-english`
Expected: PASS

- [ ] **Step 5: Run the full e2e suite to check for regressions**

Run: `npm run test:e2e`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add e2e/generation/coqui-fallback-non-english.spec.ts
git commit -m "test(e2e): Russian book Qwen-failure resolves via Coqui fallback (fs-60)"
```

---

## Task 12: Docs — regression plan, release notes, index

**Files:**
- Create: `docs/features/241-fs60-xtts-language-eligibility.md`
- Modify: `docs/features/INDEX.md` (new entry under the appropriate area heading, e.g. "Ingest & languages")
- Modify: `docs/release-notes-next.md` (technical entry)
- Modify: `RELEASE_NOTES.md` (user-facing entry, in-progress version section)
- Modify: `docs/BACKLOG.md` (remove/collapse the `fs-60` row per the "when you ship a backlog item" convention — this plan does NOT close fs-60 outright since Live-GPU acceptance is still owed per Task 11's scope; leave the row but update it to reference this plan)

**Interfaces:** none — pure documentation.

- [ ] **Step 1: Write the regression plan doc**

Create `docs/features/241-fs60-xtts-language-eligibility.md` using `docs/features/TEMPLATE.md`'s structure, frontmatter `status: active` (code + automated tests land; Live-GPU acceptance owed — matches this plan's Task 11 e2e scope, not a full acceptance walkthrough). Summarize: the `ENGINE_LANGUAGE_SUPPORT`/`resolveEligibleEngines` model, the `eligibleTtsEngines` API field, per-synth Coqui language threading, the Qwen→Coqui fallback branch, the Qwen/Coqui chapter-level serialization + its residual cross-book VRAM risk (explicitly named, not silently accepted), `PRELOAD_KOKORO`'s default flip, and the frontend picker/readiness-gate changes. Link the design spec (`docs/superpowers/specs/2026-07-04-fs60-xtts-language-eligibility-design.md`) and cite `dudarenok-maker/Castwright#1005`, `#1302` (fs-69), `#1303` (fs-70), `#1304` (fs-71).

- [ ] **Step 2: Add the INDEX.md entry**

Add one line to `docs/features/INDEX.md` under the "Ingest & languages" area (near the existing fs-41/fs-50/fs-59 entries), summarizing the plan in the house style (see the existing entries in that section for the exact format/tone).

- [ ] **Step 3: Add the release-notes-next.md entry**

Add a PR-referenced technical bullet to `docs/release-notes-next.md`'s current in-progress section, e.g.: "fs-60: Coqui XTTS becomes an eligible casting choice and automatic fallback for Russian/Spanish/French/German books, no longer hard-locked to Qwen with no recovery path (#1005)."

- [ ] **Step 4: Add the RELEASE_NOTES.md entry**

Add a matching brand-voice, user-facing line to the in-progress version section at the top of `RELEASE_NOTES.md`, e.g.: "Russian, Spanish, French, and German books now have a graceful fallback voice if a character's bespoke voice isn't ready yet — no more hard stops."

- [ ] **Step 5: Update the BACKLOG.md fs-60 row**

In `docs/BACKLOG.md`, update the existing `fs-60` row to note the implementation plan location and that Live-GPU acceptance is the remaining owed item before this can be considered fully shipped (do not delete the row yet — this plan builds the code + automated tests, not the live-GPU acceptance walkthrough Task 11 flags as still owed via the design spec's testing plan §6).

- [ ] **Step 6: Commit**

```bash
git add docs/features/241-fs60-xtts-language-eligibility.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md docs/BACKLOG.md
git commit -m "docs(docs): fs-60 regression plan + release notes"
```

---

## After all tasks: verify, review, ship

1. Run `npm run verify` (typecheck + all tests + e2e + build) from the repo root.
2. Run the mandatory adversarial review on THIS plan before implementation starts (per CLAUDE.md's model-routing skill — Opus-tier `assumption-checker` pass), and again the mandatory `code-review` pass (medium effort — single-scope `feat`, per CONTRIBUTING.md's commit-convention-based effort table) once the branch is fully staged, before opening the PR.
3. Open the PR with `Closes #1005` in the body (this plan delivers the XTTS-only slice fs-60 was narrowed to — a full delivery of the narrowed scope, not a partial wave).
4. Cut the branch as `feat/server-fs60-xtts-eligibility` (multi-scope: server + frontend + sidecar — per CONTRIBUTING.md's multi-scope syntax, consider `feat/server,frontend-fs60-xtts-eligibility` if this repo's convention requires listing every touched scope).
