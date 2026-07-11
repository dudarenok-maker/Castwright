# Third-party front-matter roster guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a real third-party person named/quoted only in a non-story front-matter chapter (e.g. a critical-essay subject) from surviving as an attributable cast member, without touching the essay's audio or stripping legitimate framed/walk-on characters.

**Architecture:** A new pure async guard module runs in the `analysis.ts` post-stage-2 assembly block, *before* `foldMinorCast`. It strips a character only when ALL hold: the character is attributed in exactly one chapter with `< minLines` lines (c), its name+aliases appear in no other chapter body (b), and that chapter is front-matter-suspicious (Gate 0: a new essay-title predicate OR positional front-region) AND confirmed non-story by Signal 1 (title) or an optional new analyzer classification call (Signal 2). Stripped characters' sentences re-route to narrator.

**Tech Stack:** TypeScript (server, NodeNext), Vitest (node env), Zod schemas, existing `Analyzer` structured-decoding machinery.

## Global Constraints

- Server code is NodeNext ESM: import sibling modules with an explicit `.js` extension (e.g. `./non-story-essay-title.js`), even though the source file is `.ts`.
- Tests colocate next to the unit as `*.test.ts`; server tests use Vitest (`import { describe, it, expect, vi } from 'vitest'`).
- The guard core is PURE except for the injected `classifyNonStory` escalation; no filesystem, no direct analyzer import in the guard module.
- No schema/persistence change for the non-story flag: it lives only in memory for the run.
- Do NOT modify `isLikelyFrontMatterTitle` / `frontMatterKeywords` / chapter `excluded` behaviour — Signal 1 is a *separate* predicate.
- Character/sentence types come from `server/src/handoff/schemas.js` (`CharacterOutput`, `SentenceOutput`); narrator id is the string `'narrator'`.
- Match algorithm for condition (b): case-folded (`toLocaleLowerCase`) **substring** containment; NO `\b` word boundaries (unreliable for Cyrillic); same-script, no transliteration; skip needles `< 3` chars.
- Commit after each task with a Conventional Commit subject (`feat(server): …` / `test(server): …`). Commit-msg + pre-commit hooks run; do not use `--no-verify`.

---

### Task 1: Signal 1 — `isNonStoryEssayTitle` essay-title predicate

**Files:**
- Create: `server/src/analyzer/non-story-essay-title.ts`
- Test: `server/src/analyzer/non-story-essay-title.test.ts`

**Interfaces:**
- Produces: `export function isNonStoryEssayTitle(title: string | undefined): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/analyzer/non-story-essay-title.test.ts
import { describe, it, expect } from 'vitest';
import { isNonStoryEssayTitle } from './non-story-essay-title.js';
import { isLikelyFrontMatterTitle } from '../parsers/front-matter.js';

describe('isNonStoryEssayTitle', () => {
  it('matches the Russian critical-essay class', () => {
    expect(isNonStoryEssayTitle('Вступительная статья')).toBe(true);
    expect(isNonStoryEssayTitle('вступительная статья')).toBe(true);
    expect(isNonStoryEssayTitle('Критическая статья')).toBe(true);
  });
  it('matches the English critical-essay class', () => {
    expect(isNonStoryEssayTitle('Critical Introduction')).toBe(true);
    expect(isNonStoryEssayTitle('Introductory essay')).toBe(true);
  });
  it('does not match ordinary narrative titles', () => {
    expect(isNonStoryEssayTitle('Chapter 1')).toBe(false);
    expect(isNonStoryEssayTitle('ПРОЛОГ')).toBe(false);
    expect(isNonStoryEssayTitle('Глава вторая')).toBe(false);
    expect(isNonStoryEssayTitle(undefined)).toBe(false);
    expect(isNonStoryEssayTitle('')).toBe(false);
  });
  it('stays decoupled from the exclusion machinery (spec regression)', () => {
    // The essay-class titles this predicate matches must NOT be front-matter
    // titles that isLikelyFrontMatterTitle would exclude — that predicate has
    // no essay-article class, so the two never overlap on the target case.
    // (Import kept local to avoid coupling the module graph.)
    expect(isLikelyFrontMatterTitle('Вступительная статья')).toBe(false);
    expect(isNonStoryEssayTitle('Вступительная статья')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/non-story-essay-title.test.ts`
Expected: FAIL — `isNonStoryEssayTitle` not found (module doesn't exist).

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/analyzer/non-story-essay-title.ts
/* Signal 1 of the third-party front-matter guard (#1447). A DEDICATED
   essay/critical-article title predicate, kept SEPARATE from
   isLikelyFrontMatterTitle / frontMatterKeywords — those drive chapter
   `excluded` (store/manuscripts.ts, routes/import.ts), which would drop the
   essay from synthesis and moot the guard. This predicate is wired ONLY into
   third-party-front-matter-guard.ts and never into the exclusion machinery.

   Single multilingual regex for v1 (ru/en critical-essay forms). Extend with
   a per-language term list only when real corpus data needs it. */

/* NOTE: `\p{L}` + the `u` flag is REQUIRED — JavaScript `\w` is ASCII-only and
   matches NO Cyrillic, so `\w*` would fail on "вступительн-ая статья". `\p{L}*`
   absorbs the Russian inflectional endings. Verified against every Task 1 case. */
const ESSAY_TITLE_RX =
  /вступительн\p{L}*\s+стать\p{L}*|критическ\p{L}*\s+стать\p{L}*|critical\s+(introduction|essay)|introductory\s+(article|essay)/iu;

export function isNonStoryEssayTitle(title: string | undefined): boolean {
  if (!title) return false;
  return ESSAY_TITLE_RX.test(title.trim());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/non-story-essay-title.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/non-story-essay-title.ts server/src/analyzer/non-story-essay-title.test.ts
git commit -m "feat(server): add isNonStoryEssayTitle predicate (Signal 1, #1447)"
```

---

### Task 2: The guard core — `stripThirdPartyFrontMatter`

**Files:**
- Create: `server/src/analyzer/third-party-front-matter-guard.ts`
- Test: `server/src/analyzer/third-party-front-matter-guard.test.ts`

**Interfaces:**
- Consumes: `isNonStoryEssayTitle` (Task 1); `CharacterOutput`, `SentenceOutput` from `../handoff/schemas.js`.
- Produces:
  - `export interface ThirdPartyGuardChapter { id: number; title?: string; body: string }`
  - `export async function stripThirdPartyFrontMatter(characters: CharacterOutput[], sentences: SentenceOutput[], chapters: ThirdPartyGuardChapter[], opts?: { minLines?: number; frontRegion?: number; classifyNonStory?: (chapter: ThirdPartyGuardChapter) => Promise<boolean> }): Promise<{ characters: CharacterOutput[]; sentences: SentenceOutput[]; stripped: string[] }>`

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/analyzer/third-party-front-matter-guard.test.ts
import { describe, it, expect, vi } from 'vitest';
import { stripThirdPartyFrontMatter, type ThirdPartyGuardChapter } from './third-party-front-matter-guard.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';

const narrator: CharacterOutput = { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', gender: 'neutral', aliases: [] };
const char = (id: string, name: string, aliases: string[] = []): CharacterOutput =>
  ({ id, name, role: 'speaker', color: 'peach', gender: 'male', aliases });
const line = (id: number, chapterId: number, characterId: string): SentenceOutput =>
  ({ id, chapterId, characterId, text: 'x' });

// ch0 = essay (title classifies); ch1..ch5 = story chapters
const essayCh: ThirdPartyGuardChapter = { id: 0, title: 'Вступительная статья', body: 'Радий Погодин был писателем.' };
const storyCh = (id: number, body: string): ThirdPartyGuardChapter => ({ id, title: `Глава ${id}`, body });

describe('stripThirdPartyFrontMatter', () => {
  it('strips via Signal 1 (essay title), re-routes sentences to narrator', async () => {
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin'), line(2, 0, 'narrator')];
    const chapters = [essayCh, storyCh(1, 'Обычная проза без имени.')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.stripped).toEqual(['Радий Погодин']);
    expect(r.characters.find((c) => c.id === 'pogodin')).toBeUndefined();
    expect(r.sentences.find((s) => s.id === 1)!.characterId).toBe('narrator');
  });

  it('strips via Signal 2 when title does not classify but chapter is front-region', async () => {
    const classifyNonStory = vi.fn(async () => true);
    const chars = [narrator, char('x', 'Иван Эссеист')];
    const sents = [line(1, 2, 'x')];
    const chapters = [storyCh(0, 'a'), storyCh(1, 'b'), { id: 2, title: 'Предисловие редактора', body: 'Иван Эссеист.' }];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, { classifyNonStory });
    expect(classifyNonStory).toHaveBeenCalledTimes(1);
    expect(r.stripped).toEqual(['Иван Эссеист']);
  });

  it('does NOT consult Signal 2 when Signal 1 already classifies', async () => {
    const classifyNonStory = vi.fn(async () => true);
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin')];
    const r = await stripThirdPartyFrontMatter(chars, sents, [essayCh, storyCh(1, 'проза')], { classifyNonStory });
    expect(classifyNonStory).not.toHaveBeenCalled();
    expect(r.stripped).toEqual(['Радий Погодин']);
  });

  it('does NOT consider a walk-on in a deep story chapter (Gate 0 blocks it)', async () => {
    const classifyNonStory = vi.fn(async () => true);
    const chars = [narrator, char('barkeep', 'Bob')];
    // Bob speaks once in chapter index 9 (>= frontRegion 5), title not essay.
    const chapters = Array.from({ length: 10 }, (_, i) => storyCh(i, i === 9 ? 'Bob said hi.' : 'prose'));
    const sents = [line(1, 9, 'barkeep')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, { classifyNonStory });
    expect(classifyNonStory).not.toHaveBeenCalled();
    expect(r.characters.find((c) => c.id === 'barkeep')).toBeDefined();
    expect(r.stripped).toEqual([]);
  });

  it('keeps a front-region story character when Signal 2 says no (framed/walk-on safe)', async () => {
    const classifyNonStory = vi.fn(async () => false);
    const chars = [narrator, char('letter', 'Framed Voice')];
    const sents = [line(1, 1, 'letter')];
    const chapters = [storyCh(0, 'a'), { id: 1, title: 'Глава 1', body: 'Framed Voice speaks.' }];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, { classifyNonStory });
    expect(classifyNonStory).toHaveBeenCalledTimes(1);
    expect(r.stripped).toEqual([]);
    expect(r.sentences).toBe(sents); // no-op identity
  });

  it('keeps a character whose full name appears in another chapter body (condition b), Cyrillic', async () => {
    // Body must contain the FULL needle ('Радий Погодин') — the algorithm uses
    // whole-name substring, so a first-name-only mention would MISS (spec Risk #1).
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin')];
    const chapters = [essayCh, storyCh(1, 'Позже Радий Погодин вернулся домой.')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.stripped).toEqual([]);
    expect(r.characters).toBe(chars); // no-op identity
  });

  it('keeps a character matched elsewhere via an alias needle (condition b)', async () => {
    // Alias 'Радий' lets a first-name-only mention elsewhere match and KEEP —
    // documents that alias completeness widens the (b) safety net.
    const chars = [narrator, char('pogodin', 'Радий Погодин', ['Радий'])];
    const sents = [line(1, 0, 'pogodin')];
    const chapters = [essayCh, storyCh(1, 'Позже Радий вернулся домой.')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.stripped).toEqual([]);
  });

  it('keeps a third party quoted >= minLines in the essay (c ceiling)', async () => {
    const chars = [narrator, char('pogodin', 'Радий Погодин')];
    const sents = [line(1, 0, 'pogodin'), line(2, 0, 'pogodin'), line(3, 0, 'pogodin')];
    const r = await stripThirdPartyFrontMatter(chars, sents, [essayCh, storyCh(1, 'проза')], { minLines: 3 });
    expect(r.stripped).toEqual([]);
  });

  it('is a no-op (same references) when nothing qualifies and runs Signal-1-only with no classifier', async () => {
    const chars = [narrator, char('hero', 'Hero')];
    const sents = [line(1, 1, 'hero')];
    const chapters = [storyCh(0, 'a'), storyCh(1, 'Hero prose')];
    const r = await stripThirdPartyFrontMatter(chars, sents, chapters, {});
    expect(r.characters).toBe(chars);
    expect(r.sentences).toBe(sents);
    expect(r.stripped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/analyzer/third-party-front-matter-guard.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/analyzer/third-party-front-matter-guard.ts
/* #1447 — strip a real third-party person named/quoted only in a non-story
   front-matter chapter (e.g. a critical-essay subject) from the roster, before
   foldMinorCast so the proseTagged carve-out (#537) never protects the bogus
   entry. Pure except for the injected `classifyNonStory` (Signal 2) escalation.

   A character is stripped only if ALL hold:
     (c) attributed in exactly one chapter, < minLines lines;
     Gate 0: that chapter is front-matter-suspicious — Signal-1 essay title OR
             positional front-region (index < frontRegion);
     (b) name + aliases appear in NO other chapter body (case-folded substring);
     (a) non-story confirmed — Signal 1 title, else Signal 2 classifier.
   Stripped characters' sentences re-route to narrator. */
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';
import { isNonStoryEssayTitle } from './non-story-essay-title.js';

const NARRATOR_ID = 'narrator';
const DEFAULT_MIN_LINES = 3;
const DEFAULT_FRONT_REGION = 5;
const MIN_NEEDLE_LEN = 3;

export interface ThirdPartyGuardChapter {
  id: number;
  title?: string;
  body: string;
}

export interface ThirdPartyGuardOptions {
  minLines?: number;
  frontRegion?: number;
  /** Signal 2. Injected so the core stays testable. Consulted at most once per
      chapter, only when Signal 1 did not classify it and Gate 0 + (b) + (c)
      held. Omitted → Signal-1-only (fully deterministic). */
  classifyNonStory?: (chapter: ThirdPartyGuardChapter) => Promise<boolean>;
}

export interface ThirdPartyGuardResult {
  characters: CharacterOutput[];
  sentences: SentenceOutput[];
  stripped: string[];
}

export async function stripThirdPartyFrontMatter(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
  chapters: ThirdPartyGuardChapter[],
  opts: ThirdPartyGuardOptions = {},
): Promise<ThirdPartyGuardResult> {
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;
  const frontRegion = opts.frontRegion ?? DEFAULT_FRONT_REGION;
  const classify = opts.classifyNonStory;

  const indexById = new Map<number, number>();
  const chapterById = new Map<number, ThirdPartyGuardChapter>();
  const foldedBodyById = new Map<number, string>();
  chapters.forEach((ch, i) => {
    indexById.set(ch.id, i);
    chapterById.set(ch.id, ch);
    foldedBodyById.set(ch.id, ch.body.toLocaleLowerCase());
  });

  const chaptersByChar = new Map<string, Set<number>>();
  const linesByChar = new Map<string, number>();
  for (const s of sentences) {
    linesByChar.set(s.characterId, (linesByChar.get(s.characterId) ?? 0) + 1);
    let set = chaptersByChar.get(s.characterId);
    if (!set) {
      set = new Set();
      chaptersByChar.set(s.characterId, set);
    }
    set.add(s.chapterId);
  }

  const nonStoryCache = new Map<number, boolean>();
  const strippedIds = new Set<string>();
  const strippedNames: string[] = [];

  for (const c of characters) {
    if (c.id === NARRATOR_ID) continue;

    // (c) single-chapter, low presence.
    const charChapters = chaptersByChar.get(c.id);
    if (!charChapters || charChapters.size !== 1) continue;
    if ((linesByChar.get(c.id) ?? 0) >= minLines) continue;
    const chapterId = [...charChapters][0];
    const index = indexById.get(chapterId);
    const chapter = chapterById.get(chapterId);
    if (index === undefined || !chapter) continue;

    // Gate 0: front-matter-suspicious chapter.
    const titleClassifies = isNonStoryEssayTitle(chapter.title);
    if (!titleClassifies && index >= frontRegion) continue;

    // (b) name + aliases absent from every OTHER chapter body.
    const needles = [c.name, ...(c.aliases ?? [])]
      .map((n) => n.trim().toLocaleLowerCase())
      .filter((n) => n.length >= MIN_NEEDLE_LEN);
    let foundElsewhere = false;
    for (const [chId, foldedBody] of foldedBodyById) {
      if (chId === chapterId) continue;
      if (needles.some((needle) => foldedBody.includes(needle))) {
        foundElsewhere = true;
        break;
      }
    }
    if (foundElsewhere) continue;

    // (a) confirm non-story: Signal 1, else Signal 2 (cached per chapter).
    let nonStory = titleClassifies;
    if (!nonStory && classify) {
      if (nonStoryCache.has(chapterId)) {
        nonStory = nonStoryCache.get(chapterId)!;
      } else {
        nonStory = await classify(chapter);
        nonStoryCache.set(chapterId, nonStory);
      }
    }
    if (!nonStory) continue;

    strippedIds.add(c.id);
    strippedNames.push(c.name);
  }

  if (strippedIds.size === 0) {
    return { characters, sentences, stripped: [] };
  }
  const keptCharacters = characters.filter((c) => !strippedIds.has(c.id));
  const reroutedSentences = sentences.map((s) =>
    strippedIds.has(s.characterId) ? { ...s, characterId: NARRATOR_ID } : s,
  );
  return { characters: keptCharacters, sentences: reroutedSentences, stripped: strippedNames };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/third-party-front-matter-guard.test.ts`
Expected: PASS (all cases). If a `CharacterOutput`/`SentenceOutput` field the test literals set is rejected by the type, check `handoff/schemas.ts` for the exact required fields and adjust the test literals (types only — do not change the implementation).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/third-party-front-matter-guard.ts server/src/analyzer/third-party-front-matter-guard.test.ts
git commit -m "feat(server): add stripThirdPartyFrontMatter guard core (#1447)"
```

---

### Task 3: Signal 2 — `runNonStoryClassification` analyzer method

**Files:**
- Create: `skills/audiobook-non-story-classification.md` (prompt / skill file, repo root `skills/`)
- Modify: `server/src/handoff/schemas.ts` (add `nonStoryClassificationSchema` + type)
- Modify: `server/src/handoff/protocol.ts:24` (add `nonstory-ch${number}` to `HandoffKey`)
- Modify: `server/src/analyzer/index.ts` (optional interface method + `FallbackAnalyzer` delegation + import type)
- Modify: `server/src/analyzer/gemini.ts` (`SKILL_FILES` entry + method impl)
- Modify: `server/src/analyzer/ollama.ts` (method impl)
- Test: `server/src/analyzer/ollama.test.ts` (add a case mirroring an existing `runStage`-backed method test)

**Interfaces:**
- Consumes: the existing `runStage(manuscriptId, key, skillName, promptMd, grammarSchema, validationSchema, call)` helper in both analyzers; `StageCall` from `./index.js`.
- Produces:
  - `export const nonStoryClassificationSchema = z.object({ nonStory: z.boolean() }).strict()` and `export type NonStoryClassificationOutput = z.infer<typeof nonStoryClassificationSchema>` (in `handoff/schemas.ts`).
  - Optional `Analyzer.runNonStoryClassification?(manuscriptId, chapterId, promptMd, call): Promise<NonStoryClassificationOutput>`.

- [ ] **Step 1: Write the failing test**

```ts
// add to server/src/analyzer/ollama.test.ts (mirror an existing runStage-backed
// method test, e.g. the runEmotionChapter test; reuse that file's fetch/HTTP
// mocking helper). The point is to prove the method routes through runStage with
// the non_story_classification skill and validates { nonStory: boolean }.
import { nonStoryClassificationSchema } from '../handoff/schemas.js';

describe('runNonStoryClassification', () => {
  it('parses a { nonStory: true } model response', async () => {
    // Arrange: use this test file's existing helper to stub the Ollama HTTP call
    // to return JSON '{"nonStory": true}' (copy the pattern from the emotion test).
    // Act:
    const out = await analyzer.runNonStoryClassification!('m1', 3, 'PROMPT', { language: 'ru' });
    // Assert:
    expect(out).toEqual({ nonStory: true });
    expect(nonStoryClassificationSchema.safeParse(out).success).toBe(true);
  });
});
```

Note: reuse the exact analyzer construction + HTTP-mock helper already present in `ollama.test.ts` for the other `runStage` methods — do not invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts -t runNonStoryClassification`
Expected: FAIL — `runNonStoryClassification` is not a function.

- [ ] **Step 3a: Add the schema + type**

In `server/src/handoff/schemas.ts`, after `emotionAnnotationSchema` (near the other output schemas), add:

```ts
/* #1447 — Signal 2 of the third-party front-matter guard. A one-field yes/no
   chapter-level non-story classification. Strict: the model returns only
   { nonStory: boolean }. */
export const nonStoryClassificationSchema = z
  .object({ nonStory: z.boolean() })
  .strict();
export type NonStoryClassificationOutput = z.infer<typeof nonStoryClassificationSchema>;
```

- [ ] **Step 3b: Extend `HandoffKey`**

In `server/src/handoff/protocol.ts`, add a variant to the `HandoffKey` union (alongside `` `emotion-ch${number}` ``):

```ts
  | `nonstory-ch${number}`
```

- [ ] **Step 3c: Add the optional interface method + Fallback delegation**

In `server/src/analyzer/index.ts`: import the type near the other schema-type imports:

```ts
import type { /* …existing… */ NonStoryClassificationOutput } from '../handoff/schemas.js';
```

Add to the `Analyzer` interface (after `runAttributionEscalation`):

```ts
  /* #1447 — chapter-level non-story classification (Signal 2). OPTIONAL so
     analyzers that don't implement it degrade to Signal-1-only. Returns
     { nonStory: true } when the chapter is a non-story foreword / critical
     essay about the book or its author rather than narrative fiction. */
  runNonStoryClassification?(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput>;
```

Add the delegating method to `FallbackAnalyzer` (mirror the other methods' try/primary/catch-LocalUnreachable/fallback shape):

```ts
  async runNonStoryClassification(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput> {
    try {
      return await this.primary.runNonStoryClassification!(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runNonStoryClassification!(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }
```

- [ ] **Step 3d: Implement in Ollama + Gemini**

In `server/src/analyzer/gemini.ts`, add to `SKILL_FILES` (after `instruct_annotation`):

```ts
  /* #1447 — chapter-level non-story classification (Signal 2). Not user-forkable
     (omitted from SKILL_TO_PROMPT_ID) — reads straight from skills/. */
  non_story_classification: 'audiobook-non-story-classification.md',
```

Import `nonStoryClassificationSchema` + `NonStoryClassificationOutput` in BOTH `gemini.ts` and `ollama.ts`, then add the identical method body to each analyzer class (mirrors `runEmotionChapter`):

```ts
  async runNonStoryClassification(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput> {
    const key = `nonstory-ch${chapterId}` as const;
    return this.runStage(
      manuscriptId,
      key,
      'non_story_classification',
      promptMd,
      nonStoryClassificationSchema,
      nonStoryClassificationSchema,
      call,
    );
  }
```

- [ ] **Step 3e: Create the prompt/skill file**

```markdown
<!-- skills/audiobook-non-story-classification.md -->
# Non-story chapter classification

You are given ONE chapter of a book (its title and body). Decide whether the
whole chapter is **non-story front matter** — a foreword, preface, publisher's
or translator's note, or a critical/biographical essay *about the book or its
author* — as opposed to **narrative fiction** (a story chapter, including a
framed letter, diary, or in-fiction author's note where characters speak).

Answer conservatively. When in doubt, answer `false` (treat it as story).

## Output schema

Return ONLY this JSON object, no markdown fences:

```json
{ "nonStory": true }
```

- `nonStory` (boolean, required): `true` only if the chapter is non-story front
  matter as defined above; otherwise `false`.

## Examples

- A critical essay discussing another author's life and work → `{ "nonStory": true }`
- A translator's preface about the edition → `{ "nonStory": true }`
- A story chapter, a prologue that is fiction, an in-fiction letter → `{ "nonStory": false }`
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts -t runNonStoryClassification`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS. Because the interface method is OPTIONAL, existing full-`Analyzer` test literals keep compiling. If typecheck flags any site, fix it minimally (it will be a mechanical addition).

- [ ] **Step 5: Commit**

```bash
git add skills/audiobook-non-story-classification.md server/src/handoff/schemas.ts server/src/handoff/protocol.ts server/src/analyzer/index.ts server/src/analyzer/gemini.ts server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts
git commit -m "feat(server): add runNonStoryClassification analyzer method (Signal 2, #1447)"
```

---

### Task 4: Wire the guard into the analysis route + integration test

**Files:**
- Modify: `server/src/routes/analysis.ts` (full-analysis assembly block ~L4189-4195 and subset re-analysis block ~L5226-5231)
- Test: `server/src/routes/analysis.test.ts` (add an analyzer-stubbed integration case)

**Interfaces:**
- Consumes: `stripThirdPartyFrontMatter` + `ThirdPartyGuardChapter` (Task 2); `Analyzer.runNonStoryClassification` (Task 3); in-scope route vars `stage1.characters`, `recovered.sentences`, `record.chapterHints`, `bookLanguage`, `userSettings.minorCastMinLines`, `manuscriptId`, and the analyzer handle (`analyzer` / `phase1Analyzer`).

- [ ] **Step 1: Write the failing integration test**

Add to `server/src/routes/analysis.test.ts`, mirroring an existing full-analysis case in that file (reuse its analyzer-stub + manuscript fixture helpers — do NOT invent a new harness). The test feeds a manuscript whose front-region chapter (index < 5) has a title that does NOT match Signal 1, stubs the analyzer so it (a) attributes one line to a third-party "Radiy" who appears in no other chapter body and (b) returns `{ nonStory: true }` from `runNonStoryClassification`, then asserts:

```ts
// Shape of the assertions (adapt variable names to the existing harness):
const res = await runAnalysisAndGetResponse(/* manuscript with a front-region
  essay chapter quoting a third party, per the existing harness */);
// Third party is gone from the final roster:
expect(res.characters.find((c) => c.name.includes('Radiy'))).toBeUndefined();
// The essay's sentence survives, re-routed to narrator:
const essaySentence = res.sentences.find((s) => s.chapterId === /* essay ch id */);
expect(essaySentence!.characterId).toBe('narrator');
```

If the existing harness's analyzer stub is a partial object, add a `runNonStoryClassification: async () => ({ nonStory: true })` property to it for this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "third-party"`
Expected: FAIL — the third party is still on the roster (guard not wired yet).

- [ ] **Step 3: Wire the guard in the full-analysis block**

In `server/src/routes/analysis.ts`, add the import near the other analyzer imports:

```ts
import { stripThirdPartyFrontMatter, type ThirdPartyGuardChapter } from '../analyzer/third-party-front-matter-guard.js';
```

Immediately BEFORE the `const folded = foldMinorCast(stage1.characters, recovered.sentences, { … })` call in the full-analysis block (~L4192), insert:

```ts
    /* #1447 — strip a real third-party person named/quoted only in a non-story
       front-matter chapter, BEFORE the fold so the proseTagged carve-out never
       protects the bogus entry. Bodies from record.chapterHints (all chapters,
       narrative order incl. excluded, so the front-region index is honest).
       Signal 2 via the analyzer only when the method is implemented. */
    const guardChapters: ThirdPartyGuardChapter[] = record.chapterHints.map((h) => ({
      id: h.id,
      title: h.title,
      body: h.body,
    }));
    const classifyNonStory = analyzer.runNonStoryClassification
      ? async (ch: ThirdPartyGuardChapter): Promise<boolean> => {
          const promptMd = `Title: ${ch.title ?? '(untitled)'}\n\n${ch.body}`;
          const out = await analyzer.runNonStoryClassification!(manuscriptId, ch.id, promptMd, {
            language: bookLanguage,
          });
          return out.nonStory;
        }
      : undefined;
    const guarded = await stripThirdPartyFrontMatter(
      stage1.characters,
      recovered.sentences,
      guardChapters,
      { minLines: userSettings.minorCastMinLines, classifyNonStory },
    );
    if (guarded.stripped.length > 0) {
      log(
        1,
        `Stripped ${guarded.stripped.length} third-party front-matter cast reference(s) (${guarded.stripped.join(', ')}) — re-routed to narrator.`,
      );
    }
    stage1.characters = guarded.characters;
    recovered.sentences = guarded.sentences;
```

(The existing `foldMinorCast(stage1.characters, recovered.sentences, …)` line immediately after now consumes the guarded values.)

Confirm the analyzer handle name in scope at this block — use `analyzer` (`selection.analyzer`, L2378). If that identifier is not in scope at the exact line, use the phase-1 handle (`phase1Analyzer`); both are `Analyzer` instances. Confirm the book-language variable name (`bookLanguage`, used in the adjacent `foldMinorCast` call).

- [ ] **Step 4: Mirror the wiring in the subset re-analysis block**

Apply the SAME insertion immediately before the `foldMinorCast(…)` call in the subset re-analysis block (~L5231), using that block's local characters/sentences variables that feed its `foldMinorCast` call (read the ~30 lines around L5231 to bind the exact variable names — they mirror the full block: a `stage1`/roster var and a `recovered.sentences`/reconciled-sentences var). Reuse the `guardChapters` construction from `record.chapterHints` and the same `classifyNonStory` wrapper.

**IMPORTANT scope difference:** `userSettings` is **NOT in scope** in the subset job runner (it is read only in the full runner ~L4173). The subset `foldMinorCast` call passes only `{ language: bookLanguage }` — no `minLines`. So the subset guard call must **omit `minLines`**:

```ts
    const guarded = await stripThirdPartyFrontMatter(
      /* subset roster var */,
      /* subset sentences var */,
      guardChapters,
      { classifyNonStory }, // omit minLines — guard DEFAULT_MIN_LINES (3) == fold MIN_LINES_DEFAULT (3)
    );
```

`analyzer`, `manuscriptId`, `bookLanguage`, `record.chapterHints`, and `log` are all confirmed in scope at the subset block.

- [ ] **Step 5: Run the integration test + full server suite**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "third-party"`
Expected: PASS.
Run: `cd server && npm run test` (or `npm run test:server` from root)
Expected: PASS — no regression in the analysis route suite.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): wire third-party front-matter guard into analysis route (#1447)

Closes #1447"
```

---

## Docs / release-notes (fold into the final task or a follow-up commit)

- [ ] Append a technical entry to `docs/release-notes-next.md` (PR-refed) and a brand-voice line to the in-progress version section at the top of `RELEASE_NOTES.md`.
- [ ] Move the design spec `docs/superpowers/specs/2026-07-11-third-party-front-matter-guard-design.md` status → `stable` with Ship notes (date + squash SHA) after merge, per the Before-shipping checklist. Update `docs/features/INDEX.md` only if a feature-plan doc is created (this change is spec+plan under `docs/superpowers/`, so INDEX.md likely N/A — state so in the PR).

## Self-review notes (author)

- **Spec coverage:** Signal 1 → Task 1; guard core with Gate 0 / (b) / (c) / reroute / no-op → Task 2; Signal 2 analyzer method (optional, stubbable) → Task 3; both assembly-block call sites + index-derivation-from-`record.chapterHints` + integration test → Task 4. Risk items (b)-fragility, (c)-ceiling, walk-on protection all have explicit tests in Task 2.
- **Types:** `ThirdPartyGuardChapter` / `stripThirdPartyFrontMatter` signatures identical across Tasks 2 and 4; `nonStoryClassificationSchema` / `NonStoryClassificationOutput` identical across Tasks 3 method + interface.
- **Deviation from spec (intentional, simpler):** `isNonStoryEssayTitle` takes no `language` param (single multilingual regex, YAGNI); the guard `opts` carry no `language` (the Signal-2 prompt gets book language via the route's `StageCall.language`). Everything else matches the spec.
