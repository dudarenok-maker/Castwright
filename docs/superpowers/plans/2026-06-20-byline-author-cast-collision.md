# Byline Author Cast Collision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the book's byline author from being cast as a speaking character and stealing the first-person protagonist's dialogue, while preserving legitimate framed author's-note speakers.

**Architecture:** Three layers on the analysis pipeline. **A** strips title-page/byline/e-library boilerplate from each chapter body before the model sees it. **B** drops any detected character whose name equals the book's byline author from the per-chapter roster (unless the chapter is a framed author's-note) — empirically, stage-2 then attributes the protagonist's dialogue to the real protagonist on its own. **C** clarifies the detection prompt (the byline author is not a character; the first-person-document rule is for framed embedded documents, not whole first-person novels).

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Vitest (node env), existing analyzer/route modules under `server/src/`.

**Spec:** `docs/superpowers/specs/2026-06-20-byline-author-cast-collision-design.md` · **Issue:** #938 · **Branch:** `fix/server-byline-author-cast-collision` (already checked out).

## Global Constraints

- **OpenAPI is the type source of truth** — `CharacterOutput` comes from `server/src/handoff/schemas.js`; do not hand-write character shapes.
- **Pure modules stay pure** — the two new analyzer modules do no I/O, mirroring `fold-minor-cast.ts`.
- **Name matching uses `normaliseNameKey`** (`server/src/util/safe-id.js`) — Unicode-exact, NO transliteration. Never introduce a lossy transliterated match (false cross-book merges).
- **Russian strings are user-facing and must stay exact.**
- **TDD**: every task writes the failing test first, watches it fail, implements minimally, watches it pass, commits.
- **Test command (frontend+server scope):** server tests run with `cd server && npx vitest run <path>`. Typecheck: `npm run typecheck` from repo root.
- **Conventional commits**: `<type>(<scope>): <subject>` (e.g. `feat(server): …`, `test(server): …`). End commit bodies with the project's Co-Authored-By / session trailer is handled by the harness — a plain subject is fine for task commits.

---

### Task 1: Layer A — front-matter / boilerplate stripper (pure)

**Files:**
- Create: `server/src/analyzer/strip-front-matter.ts`
- Test: `server/src/analyzer/strip-front-matter.test.ts`

**Interfaces:**
- Consumes: `normaliseNameKey` from `../util/safe-id.js`.
- Produces: `export function stripFrontMatterBoilerplate(body: string, opts?: { author?: string; title?: string }): string`

- [ ] **Step 1: Write the failing test**

Create `server/src/analyzer/strip-front-matter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stripFrontMatterBoilerplate } from './strip-front-matter.js';

/* The actual Ночной дозор Ch1 head the analyzer saw (abridged but verbatim shapes). */
const NW_HEAD = [
  '_###ICE#BOOK#READER#PROFESSIONAL#HEADER#START###_ AUTHOR: Сергей Лукьяненко TITLE: Ночной дозор CODEPAGE: -3 _###ICE#BOOK#READER#PROFESSIONAL#HEADER#FINISH###_',
  '',
  'НОЧНОЙ ДОЗОР',
  '',
  'Сергей ЛУКЬЯНЕНКО',
  '',
  'http://www.bestlibrary.ru',
  '',
  'Любое коммерческое использование настоящего текста без ведома и прямого согласия владельца авторских прав НЕ ДОПУСКАЕТСЯ. (С) Сергей Лукьяненко',
  '',
  'Данный текст одобрен к распространению как способствующий делу Света. Ночной Дозор.',
  '',
  'ИСТОРИЯ ПЕРВАЯ',
  '',
  'ПРОЛОГ',
  '',
  'Эскалатор полз медленно, натужно. Старая станция, ничего не поделаешь. Зато ветер гулял в бетонной трубе вовсю, трепал волосы.',
].join('\n');

describe('stripFrontMatterBoilerplate', () => {
  it('strips the Night Watch title-page block but keeps headings and prose', () => {
    const out = stripFrontMatterBoilerplate(NW_HEAD, { author: 'Сергей Лукьяненко', title: 'Ночной дозор' });
    // byline + title echo gone
    expect(out).not.toMatch(/Сергей ЛУКЬЯНЕНКО/);
    expect(out).not.toMatch(/НОЧНОЙ ДОЗОР/);
    // reader header / copyright / url / distribution boilerplate gone
    expect(out).not.toMatch(/ICE#BOOK#READER/);
    expect(out).not.toMatch(/AUTHOR:/);
    expect(out).not.toMatch(/bestlibrary\.ru/);
    expect(out).not.toMatch(/коммерческое использование/);
    expect(out).not.toMatch(/одобрен к распространению/);
    // real structural headings + prose preserved
    expect(out).toMatch(/ИСТОРИЯ ПЕРВАЯ/);
    expect(out).toMatch(/ПРОЛОГ/);
    expect(out).toMatch(/Эскалатор полз медленно/);
  });

  it('leaves an author-name mention inside ordinary prose intact (conservative boundary)', () => {
    const body = 'Эскалатор полз медленно, и я вспомнил, что Сергей Лукьяненко однажды написал об этом в длинном абзаце про метро и людей.';
    const out = stripFrontMatterBoilerplate(body, { author: 'Сергей Лукьяненко', title: 'Ночной дозор' });
    expect(out).toBe(body);
  });

  it('is a no-op for an English book with no byline/boilerplate', () => {
    const body = 'The bell tolled twice over Coalfall. Marlow pulled his collar up and stepped into the rain.';
    expect(stripFrontMatterBoilerplate(body, { author: 'Castwright', title: 'The Coalfall Commission' })).toBe(body);
  });

  it('is a no-op when author/title are absent', () => {
    const body = 'НОЧНОЙ ДОЗОР\n\nСергей ЛУКЬЯНЕНКО\n\nЭскалатор полз медленно, и ветер гулял в трубе вовсю, трепал волосы и капюшон.';
    // Without author/title we cannot identify the byline; only global boilerplate would be removed (none here).
    expect(stripFrontMatterBoilerplate(body)).toBe(body);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/strip-front-matter.test.ts`
Expected: FAIL — "Cannot find module './strip-front-matter.js'".

- [ ] **Step 3: Write minimal implementation**

Create `server/src/analyzer/strip-front-matter.ts`:

```ts
/* Layer A (#938) — strip title-page byline + e-library boilerplate from a chapter
   body before the analyzer sees it, so the byline author never reaches stage-1/2.
   Pure; applied in-memory to the analysis copy of the body (never persisted).

   Two removal classes:
     - Always-safe global patterns (reader-tool headers, copyright/distribution
       notices, bare URLs) — ordinary prose never contains these, so drop anywhere.
     - Leading-region byline/title echo — a standalone line equal (normalized) to
       the book author or title, removed only before substantial narrative prose
       begins, so a story that *mentions* the author mid-prose is untouched. */
import { normaliseNameKey } from '../util/safe-id.js';

const GLOBAL_BOILERPLATE: RegExp[] = [
  /_###ICE#BOOK#READER/i, // reader-tool header marker (whole line is the header)
  /^\s*(AUTHOR|TITLE|CODEPAGE)\s*:/i, // reader header fields on their own line
  /коммерческое использование/i, // e-library usage notice
  /одобрен к распространению/i, // e-library distribution notice
  /^\s*\((С|C)\)\s/i, // "(С) <author>" copyright line
  /^\s*https?:\/\/\S+\s*$/i, // bare URL line
];

function isGlobalBoilerplate(line: string): boolean {
  return GLOBAL_BOILERPLATE.some((re) => re.test(line));
}

/* A line that reads as narrative prose: reasonably long, contains sentence
   punctuation AND a lowercase letter. All-caps headings ("ПРОЛОГ", "ИСТОРИЯ
   ПЕРВАЯ") and bare bylines are short / have no lowercase → not narrative. */
function isNarrativeLine(line: string): boolean {
  if (line.length < 60) return false;
  return /[.!?…]/.test(line) && /\p{Ll}/u.test(line);
}

export function stripFrontMatterBoilerplate(
  body: string,
  opts: { author?: string; title?: string } = {},
): string {
  const authorKey = normaliseNameKey(opts.author);
  const titleKey = normaliseNameKey(opts.title);
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let inFrontMatter = true;
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Global boilerplate: drop anywhere, without ending the front-matter region.
    if (trimmed && isGlobalBoilerplate(trimmed)) {
      changed = true;
      continue;
    }

    if (inFrontMatter && trimmed) {
      const key = normaliseNameKey(trimmed);
      if (key && (key === authorKey || key === titleKey)) {
        changed = true;
        continue; // standalone byline / title echo
      }
      if (isNarrativeLine(trimmed)) inFrontMatter = false;
    }

    out.push(line);
  }

  return changed ? out.join('\n') : body;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/strip-front-matter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/strip-front-matter.ts server/src/analyzer/strip-front-matter.test.ts
git commit -m "feat(server): add front-matter/boilerplate stripper for analysis (#938 Layer A)"
```

---

### Task 2: Layer B — byline-author roster guard (pure)

**Files:**
- Create: `server/src/analyzer/byline-author-guard.ts`
- Test: `server/src/analyzer/byline-author-guard.test.ts`

**Interfaces:**
- Consumes: `CharacterOutput` from `../handoff/schemas.js`; `normaliseNameKey` from `../util/safe-id.js`.
- Produces:
  - `export function isFramedAuthorNote(chapterTitle: string | undefined): boolean`
  - `export function dropBylineAuthorFromChapter(characters: CharacterOutput[], opts: { author?: string; chapterTitle?: string }): { characters: CharacterOutput[]; dropped: string[] }`

- [ ] **Step 1: Write the failing test**

Create `server/src/analyzer/byline-author-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dropBylineAuthorFromChapter, isFramedAuthorNote } from './byline-author-guard.js';
import type { CharacterOutput } from '../handoff/schemas.js';

function ch(id: string, name: string, role = 'role'): CharacterOutput {
  return { id, name, role, color: 'slot-4' };
}

const ROSTER: CharacterOutput[] = [
  ch('narrator', 'Narrator', 'Third-person observer'),
  ch('sergey-lukyanenko', 'Сергей Лукьяненко', 'Protagonist / Investigator'),
  ch('anton', 'Антон', 'Оперативник'),
  ch('anton-gorodetsky', 'Антон Городецкий', 'Иной'),
];

describe('isFramedAuthorNote', () => {
  it('matches author-note chapter titles (bilingual), not story chapters', () => {
    expect(isFramedAuthorNote("Author's Note")).toBe(true);
    expect(isFramedAuthorNote('Notes from the Author')).toBe(true);
    expect(isFramedAuthorNote('От автора')).toBe(true);
    expect(isFramedAuthorNote('Послесловие автора')).toBe(true);
    expect(isFramedAuthorNote('Chapter 1')).toBe(false);
    expect(isFramedAuthorNote('ПРОЛОГ')).toBe(false);
    expect(isFramedAuthorNote(undefined)).toBe(false);
  });
});

describe('dropBylineAuthorFromChapter', () => {
  it('drops the byline author by name-match (case/inflection-tolerant) from a story chapter', () => {
    const r = dropBylineAuthorFromChapter(ROSTER, { author: 'Сергей Лукьяненко', chapterTitle: 'Chapter 1' });
    expect(r.dropped).toEqual(['Сергей Лукьяненко']);
    expect(r.characters.map((c) => c.id)).toEqual(['narrator', 'anton', 'anton-gorodetsky']);
  });

  it('matches an uppercased byline form too', () => {
    const roster = [ch('a', 'Сергей ЛУКЬЯНЕНКО', 'Protagonist'), ch('anton', 'Антон')];
    const r = dropBylineAuthorFromChapter(roster, { author: 'Сергей Лукьяненко', chapterTitle: 'Глава 2' });
    expect(r.characters.map((c) => c.id)).toEqual(['anton']);
  });

  it('KEEPS the author in a framed author-note chapter (legit case)', () => {
    const r = dropBylineAuthorFromChapter(ROSTER, { author: 'Сергей Лукьяненко', chapterTitle: 'От автора' });
    expect(r.dropped).toEqual([]);
    expect(r.characters).toBe(ROSTER); // referential identity preserved on no-op
  });

  it('never drops narrator and is a no-op when the author is absent or unset', () => {
    expect(dropBylineAuthorFromChapter(ROSTER, { author: '', chapterTitle: 'Chapter 1' }).characters).toBe(ROSTER);
    const noAuthorOnRoster = [ch('narrator', 'Narrator'), ch('anton', 'Антон')];
    const r = dropBylineAuthorFromChapter(noAuthorOnRoster, { author: 'Сергей Лукьяненко', chapterTitle: 'Chapter 1' });
    expect(r.characters).toBe(noAuthorOnRoster);
    expect(r.dropped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/byline-author-guard.test.ts`
Expected: FAIL — "Cannot find module './byline-author-guard.js'".

- [ ] **Step 3: Write minimal implementation**

Create `server/src/analyzer/byline-author-guard.ts`:

```ts
/* Layer B (#938) — drop the book's byline author from a chapter's detected roster
   before stage-2 attribution. Empirically (gemma4-e4b, Ночной дозор Ch1): once the
   "Protagonist"-roled author entity is gone, stage-2 attributes the protagonist's
   dialogue to the real protagonist on its own — no reclamation/anchor needed.

   The legit author-as-character case (a framed author's-note where the author
   genuinely speaks) is preserved by exempting chapters whose title marks an
   author's-note. Pure; mirrors fold-minor-cast.ts. */
import type { CharacterOutput } from '../handoff/schemas.js';
import { normaliseNameKey } from '../util/safe-id.js';

const NARRATOR_ID = 'narrator';

/* Bilingual author's-note chapter-title patterns. Start small; extend on real
   corpus data (same discipline as GENERIC_ROLE_RU). */
const AUTHOR_NOTE_TITLE_RX =
  /author'?s?\s+note|notes?\s+from\s+the\s+author|от\s+автора|предислови|послеслови|об\s+авторе/i;

export function isFramedAuthorNote(chapterTitle: string | undefined): boolean {
  if (!chapterTitle) return false;
  return AUTHOR_NOTE_TITLE_RX.test(chapterTitle);
}

export function dropBylineAuthorFromChapter(
  characters: CharacterOutput[],
  opts: { author?: string; chapterTitle?: string },
): { characters: CharacterOutput[]; dropped: string[] } {
  const authorKey = normaliseNameKey(opts.author);
  if (!authorKey) return { characters, dropped: [] };
  if (isFramedAuthorNote(opts.chapterTitle)) return { characters, dropped: [] };

  const dropped: string[] = [];
  const kept = characters.filter((c) => {
    if (c.id === NARRATOR_ID) return true;
    if (normaliseNameKey(c.name) === authorKey) {
      dropped.push(c.name);
      return false;
    }
    return true;
  });
  if (dropped.length === 0) return { characters, dropped: [] }; // preserve identity on no-op
  return { characters: kept, dropped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/byline-author-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/byline-author-guard.ts server/src/analyzer/byline-author-guard.test.ts
git commit -m "feat(server): add byline-author roster guard (#938 Layer B)"
```

---

### Task 3: Plumbing — resolve the book's byline author in the analysis route

**Files:**
- Modify: `server/src/routes/analysis.ts` (add `resolveBookAuthorForManuscript` next to `resolveBookLanguageForManuscript` at ~2118)
- Test: `server/src/routes/analysis.test.ts` (add a focused unit test)

**Interfaces:**
- Consumes: `findBookByManuscriptId` (already imported in analysis.ts).
- Produces: `export async function resolveBookAuthorForManuscript(manuscriptId: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

In `server/src/routes/analysis.test.ts`, add (place near other `resolveBookLanguageForManuscript`-style tests; import the new symbol from the route module):

```ts
import { resolveBookAuthorForManuscript } from './analysis.js';

describe('resolveBookAuthorForManuscript', () => {
  it('returns "" for an unknown manuscript (no throw)', async () => {
    await expect(resolveBookAuthorForManuscript('mns_does_not_exist')).resolves.toBe('');
  });
});
```

> Note: this asserts the safe fallback path (mirrors how `resolveBookLanguageForManuscript` returns `'en'` on miss). The happy path is covered by the integration test in Task 7.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t resolveBookAuthorForManuscript`
Expected: FAIL — `resolveBookAuthorForManuscript is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/analysis.ts`, immediately after `resolveBookLanguageForManuscript` (ends ~line 2125), add:

```ts
/* #938 — the book's byline author (cover/byline name), for the Layer A front-matter
   strip + the Layer B roster guard. Mirrors resolveBookLanguageForManuscript's
   fail-open shape: "" on any miss so the guard/strip degrade to no-ops. */
export async function resolveBookAuthorForManuscript(manuscriptId: string): Promise<string> {
  try {
    const located = await findBookByManuscriptId(manuscriptId);
    return located?.state?.author ?? '';
  } catch {
    return '';
  }
}
```

> If `located.state` is not the shape (verify against the `findBookByManuscriptId` return type — `resolveBookLanguageForManuscript` reads `located.state`), adjust to the field that carries `author: string` from `BookStateJson`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t resolveBookAuthorForManuscript`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): resolve book byline author for analysis (#938 plumbing)"
```

---

### Task 4: Wire Layer A — strip chapter bodies at job start (both entrypoints)

**Files:**
- Modify: `server/src/routes/analysis.ts` — `runMainAnalyzerJob` (~2136, after `bookLanguage`) and the subset entrypoint (~4355, after its `bookLanguage`).

**Interfaces:**
- Consumes: `stripFrontMatterBoilerplate` (Task 1), `resolveBookAuthorForManuscript` (Task 3).
- Produces: in-memory stripped `recordRef.chapterHints[*].body` consumed by every downstream stage-1/stage-2 builder.

- [ ] **Step 1: Add the import and the strip loop (no new test file — covered by Task 7 integration; verified here by the existing suite staying green)**

At the top of `server/src/routes/analysis.ts`, add to the analyzer imports:

```ts
import { stripFrontMatterBoilerplate } from '../analyzer/strip-front-matter.js';
```

In `runMainAnalyzerJob`, immediately after:

```ts
  const bookLanguage = await resolveBookLanguageForManuscript(manuscriptId);
```

insert:

```ts
  /* #938 Layer A — resolve the byline author + strip title-page/e-library
     boilerplate from each chapter body BEFORE the model sees it. In-memory only
     (the hydrated analysis copy), never persisted; idempotent so a re-run is safe. */
  const bookAuthor = await resolveBookAuthorForManuscript(manuscriptId);
  for (const ch of recordRef.chapterHints) {
    ch.body = stripFrontMatterBoilerplate(ch.body, { author: bookAuthor, title: recordRef.title });
  }
```

In the subset entrypoint (the function starting ~4340 with its own `const bookLanguage = await resolveBookLanguageForManuscript(manuscriptId);` at ~4355), insert the analogous block right after that line, using that function's record variable name (it uses `record`, not `recordRef` — confirm the local name and `record.title` / `record.chapterHints`):

```ts
  const bookAuthor = await resolveBookAuthorForManuscript(manuscriptId);
  for (const ch of record.chapterHints) {
    ch.body = stripFrontMatterBoilerplate(ch.body, { author: bookAuthor, title: record.title });
  }
```

> `bookAuthor` is now in scope for Tasks 5 and 6 in BOTH entrypoints — keep these declarations.

- [ ] **Step 2: Run the route suite to verify nothing regressed**

Run: `cd server && npx vitest run src/routes/analysis.test.ts`
Expected: PASS (existing tests green; ETA/length assertions tolerate the small body trim, which only affects chapter 1's leading boilerplate).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean (confirms `recordRef.chapterHints[*].body` and `record.title` are mutable/readable as used).

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/analysis.ts
git commit -m "feat(server): strip front-matter from chapter bodies at analysis start (#938 Layer A wiring)"
```

---

### Task 5: Wire Layer B — guard the roster build (covers cached + fresh chapters)

> **Adversarial-review correction (2026-06-20):** the guard must NOT sit at the
> `chapterCast[ch.id] = result.characters` write (it runs only for *freshly-detected*
> chapters — on a resume, or on an already-analyzed book like the user's *Ночной
> дозор*, `chapterCast` is loaded from cache at `const chapterCast = cache.chapterCast ?? {}`
> ~line 2538 and would bypass the guard). The guard goes inside **`rebuildRoster()`** —
> the choke point that turns `chapterCast` into the running roster, the final roster
> (~3044), and the live "Cast so far" SSE view (~2572→2578). Guarding on *read* there
> covers cached AND fresh, in both entrypoints. `buildInterimCast` is guarded too so
> the on-disk interim cast.json the user watches never shows the author.

**Files:**
- Modify: `server/src/routes/analysis.ts` — `rebuildRoster` in `runMainAnalyzerJob` (~2556) and in the subset entrypoint (~4476); `buildInterimCast` (~650) + its two callers (~2921, ~4561).
- Test: `server/src/routes/analysis.test.ts` (Task 7 integration covers this; verified here by suite + typecheck).

**Interfaces:**
- Consumes: `dropBylineAuthorFromChapter` (Task 2), `bookAuthor` (Task 4 — in scope in both entrypoints), `ch.title` (chapter hint).
- Produces: `buildInterimCast(chapterCast, chapterOrder, language, author?)` — new trailing optional `author` param.

- [ ] **Step 1: Add the import**

At the top of `server/src/routes/analysis.ts`, add:

```ts
import { dropBylineAuthorFromChapter } from '../analyzer/byline-author-guard.js';
```

- [ ] **Step 2: Guard the full-entrypoint `rebuildRoster` (~2556)**

Find:

```ts
      const rebuildRoster = (): Map<string, CharacterOutput> => {
        const r = new Map<string, CharacterOutput>();
        for (const ch of recordRef.chapterHints) {
          const cast = chapterCast[ch.id];
          if (cast?.length) mergeRosterChapter(r, cast);
        }
        return r;
      };
```

Replace the loop body so each chapter's cast is filtered before merge:

```ts
      const rebuildRoster = (): Map<string, CharacterOutput> => {
        const r = new Map<string, CharacterOutput>();
        for (const ch of recordRef.chapterHints) {
          const cast = chapterCast[ch.id];
          if (cast?.length) {
            /* #938 Layer B — keep the byline author out of every roster build
               (covers cached chapterCast too, unlike guarding only fresh writes).
               Framed author's-note chapters keep the author. */
            const guarded = dropBylineAuthorFromChapter(cast, {
              author: bookAuthor,
              chapterTitle: ch.title,
            });
            mergeRosterChapter(r, guarded.characters);
          }
        }
        return r;
      };
```

- [ ] **Step 3: Guard the subset-entrypoint `rebuildRoster` (~4476)**

Find the subset entrypoint's identical `rebuildRoster` (iterates `record.chapterHints`) and apply the same filter-before-merge change (use that function's record local — `record` — and its in-scope `bookAuthor` from Task 4).

- [ ] **Step 4: Guard `buildInterimCast` so the on-disk interim cast.json is clean too**

In `buildInterimCast` (signature ~650), add a trailing optional `author` param and filter each chapter's cast inside its merge loop (~657). It has no per-chapter title in scope, so it drops the author unconditionally — acceptable for the transient interim write; the authoritative final cast.json is produced from the title-aware `rebuildRoster` above:

```ts
export function buildInterimCast(
  chapterCast: Record<number, CharacterOutput[]>,
  chapterOrder: number[],
  language?: string,
  author = '',
): CharacterOutput[] {
```

At its merge loop, change:

```ts
    const cast = chapterCast[chapterId];
    if (cast?.length) mergeRosterChapter(roster, cast);
```

to:

```ts
    const cast = chapterCast[chapterId];
    if (cast?.length) {
      const guarded = dropBylineAuthorFromChapter(cast, { author }); // #938 — no title here (transient interim)
      mergeRosterChapter(roster, guarded.characters);
    }
```

Then pass `bookAuthor` at the two `buildInterimCast(...)` call sites (~2921 full, ~4561 subset) as the new 4th argument:

```ts
          const interim = buildInterimCast(
            chapterCast,
            recordRef.chapterHints.map((h) => h.id),
            bookLanguage,
            bookAuthor,
          );
```

(Use the matching record/language locals at each call site.)

- [ ] **Step 5: Run the route suite + typecheck**

Run: `cd server && npx vitest run src/routes/analysis.test.ts && cd .. && npm run typecheck`
Expected: PASS + clean. (Existing `buildInterimCast` tests still pass — the new param is optional and a book with no author is a no-op.)

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts
git commit -m "feat(server): guard byline author out of roster builds incl. cached cast (#938 Layer B wiring)"
```

---

### Task 6: Layer C — prompt clarification (inbox builder + skill file)

**Files:**
- Modify: `server/src/routes/analysis.ts` — `buildStage1ChapterInbox` (~1242): add an `author` param, render a "book author is not a character" block, and narrow the first-person-document rule.
- Modify: `skills/audiobook-character-detection-per-chapter.md` — mirror the narrowed first-person-document rule.
- Test: `server/src/routes/analysis.test.ts` (buildStage1ChapterInbox renders the guidance).

**Interfaces:**
- Consumes: `bookAuthor` (Task 4) at the `buildStage1ChapterInbox` call sites (~2757 and the subset ~4517).
- Produces: `buildStage1ChapterInbox(manuscriptId, title, chapter, runningRoster, seriesPrior, author?)` — new trailing optional `author` param (keeps existing callers/tests compiling).

- [ ] **Step 1: Write the failing test**

In `server/src/routes/analysis.test.ts`, add:

```ts
import { buildStage1ChapterInbox } from './analysis.js';

describe('buildStage1ChapterInbox — #938 byline-author guidance', () => {
  const chapter = { id: 1, title: 'Chapter 1', body: 'Эскалатор полз медленно.' };

  it('renders a "book author is not a character" block when an author is provided', () => {
    const md = buildStage1ChapterInbox('m1', 'Ночной дозор', chapter, [], [], 'Сергей Лукьяненко');
    expect(md).toMatch(/Сергей Лукьяненко/);
    expect(md).toMatch(/not a character/i);
  });

  it('omits the block when no author is provided (back-compat)', () => {
    const md = buildStage1ChapterInbox('m1', 'Ночной дозор', chapter, [], []);
    expect(md).not.toMatch(/not a character/i);
  });

  it('narrows the first-person-document rule to framed embedded documents', () => {
    const md = buildStage1ChapterInbox('m1', 'X', chapter, [], [], 'Author');
    expect(md).toMatch(/first-person novel is NOT/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "byline-author guidance"`
Expected: FAIL — author param ignored / strings absent.

- [ ] **Step 3: Implement — add the param and prompt text**

In `buildStage1ChapterInbox` (signature ~1242), add a trailing optional param:

```ts
export function buildStage1ChapterInbox(
  manuscriptId: string,
  title: string,
  chapter: { id: number; title: string; body: string },
  runningRoster: CharacterOutput[],
  seriesPrior: SeriesPriorCharacter[] = [],
  author = '',
): string {
```

Build an author block before the final `return` (near where `priorBlock` is built, ~1294):

```ts
  /* #938 — the book's byline author is NOT a character. Rendered only when known. */
  const authorBlock = author.trim()
    ? `
## Book author — NOT a character

The byline author of this book is **${author.trim()}**. This is the real-world author printed on the cover — they are NOT a character in the story. Do NOT add them to the roster, and never assign the narrator's prose or the protagonist's first-person lines to them — UNLESS this chapter is an explicitly-framed author's note/letter in which the author speaks in the first person about the book.
`
    : '';
```

Insert `${authorBlock}` into the returned template — put it immediately after the `${priorBlock}` interpolation.

Then narrow the inline first-person-document rule. Find the rule text in the template (the "first-person document" clause, ~1313-1320, starting `2. The chapter is a **first-person document**`) and append this sentence to that clause:

```
   A whole **first-person novel is NOT** such a document — its first-person
   voice is the protagonist/narrator, NOT the book's author; never roster the
   byline author as that voice.
```

- [ ] **Step 4: Update the skill file (parity)**

In `skills/audiobook-character-detection-per-chapter.md`, find the "First-person prose by an identifiable author" rule (~line 71) and append the same clarification:

```
   A whole first-person **novel** is NOT such a document — its first-person voice
   is the protagonist/narrator, not the book's author. Never roster the book's
   byline author as a character unless they explicitly act or speak in the story
   (e.g. a clearly-framed author's note).
```

- [ ] **Step 5: Thread `bookAuthor` into the call sites**

At the `buildStage1ChapterInbox(...)` call in `runMainAnalyzerJob` (~2757) add `bookAuthor` as the final argument:

```ts
                    buildStage1ChapterInbox(
                      manuscriptId,
                      recordRef.title,
                      { ...ch, body: subBody },
                      Array.from(rebuildRoster().values()),
                      seriesPrior,
                      bookAuthor,
                    ),
```

Do the same at the subset entrypoint's `buildStage1ChapterInbox(...)` call (~4517), using that function's record/author locals.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && npx vitest run src/routes/analysis.test.ts && cd .. && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/analysis.ts skills/audiobook-character-detection-per-chapter.md server/src/routes/analysis.test.ts
git commit -m "feat(server): clarify byline-author + first-person rule in detection prompt (#938 Layer C)"
```

---

### Task 7: Integration regression — full cast excludes the byline author

**Files:**
- Test: `server/src/routes/analysis.test.ts` (add a route-level case using the existing stub-analyzer harness).

**Interfaces:**
- Consumes: the existing analysis-route test harness (stub `Analyzer`, in-memory book). Match the established pattern already used in `analysis.test.ts` for driving `runMainAnalyzerJob` / the analyse route with a stub analyzer.

- [ ] **Step 1: Write the failing test**

Add a case that drives the analysis route/job with a stub analyzer whose stage-1 returns a roster containing the byline author (with `role: "Protagonist"`) plus the real protagonist, on a book whose `author` is that same name. **Critically, also cover the cached path** — seed `cache.chapterCast` (or run twice so the second run reads the cache) so the test would catch the adversarial-review bug where only fresh chapters were guarded. Assert the final roster/cast contains the protagonist and the narrator but NOT the byline author. Mirror the existing harness in the file (book fixture creation, stub `Analyzer` wiring, how the test reads the resulting `stage1.characters` / cast.json). Skeleton:

```ts
it('#938 — excludes the byline author from the final cast on a story chapter', async () => {
  // Arrange: in-memory book with author "Сергей Лукьяненко"; stub analyzer returns
  // stage-1 roster [narrator, sergey-lukyanenko(Protagonist), anton] for the chapter.
  // (Use the same fixture/harness helpers the other route tests in this file use.)
  // Act: run the analysis job to completion.
  // Assert:
  //   finalRoster.map(c => c.id) includes 'anton' and 'narrator'
  //   finalRoster.find(c => normaliseNameKey(c.name) === normaliseNameKey('Сергей Лукьяненко')) is undefined
});
```

> Implementer: wire this to the file's existing harness rather than inventing a new one. If the harness only exposes the pure pieces, assert on the result of `dropBylineAuthorFromChapter` applied across `chapterCast` + `mergeRosterChapter` (the exact wiring Tasks 5 added), which still constitutes an integration check across Layer B + the roster merge.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "excludes the byline author"`
Expected: FAIL before wiring is exercised / passes only with Tasks 1-6 in place — if it passes immediately, strengthen it so it would fail with the guard removed (temporarily comment the guard to confirm red, then restore).

- [ ] **Step 3: Confirm it passes with the implementation**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "excludes the byline author"`
Expected: PASS.

- [ ] **Step 4: Full server suite + typecheck**

Run: `cd server && npx vitest run && cd .. && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.test.ts
git commit -m "test(server): integration regression for byline-author exclusion (#938)"
```

---

### Task 8: Spec ship-notes + verify

**Files:**
- Modify: `docs/superpowers/specs/2026-06-20-byline-author-cast-collision-design.md` (add a short "Shipped" note: date + commit range).
- Modify: `docs/features/221-multilingual-attribution-gemma-and-cast-merge.md` (one line referencing #938 fix, if it still mentions the author-takeover as open).

- [ ] **Step 1: Run the full verify battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 2: Add ship notes to the spec**

Append a `## Shipped` section to the spec with the date (2026-06-20) and the commit SHAs from Tasks 1-7.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-20-byline-author-cast-collision-design.md docs/features/221-multilingual-attribution-gemma-and-cast-merge.md
git commit -m "docs(docs): ship notes for #938 byline-author cast collision"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin fix/server-byline-author-cast-collision
gh pr create --base main --title "fix(server): stop the byline author being cast as the protagonist (#938)" --body "Closes #938. Three layers (front-matter strip + byline-author roster guard + prompt clarification). Empirically validated on Ночной дозор: removing the byline author from the roster makes stage-2 attribute the protagonist's dialogue to anton. See docs/superpowers/specs/2026-06-20-byline-author-cast-collision-design.md."
```

---

## Self-Review

**Spec coverage:**
- Layer A (front-matter strip) → Tasks 1, 4. ✓
- Layer B (per-chapter roster guard, framed-note exemption) → Tasks 2, 5. ✓
- Layer C (prompt clarification + skill parity) → Task 6. ✓
- Shared plumbing (resolve book author) → Task 3. ✓
- Testing (pure unit per layer + integration regression) → Tasks 1, 2, 6, 7. ✓
- Non-goals (Anton dedup, world-knowledge denylist) → not implemented, by design. ✓

**Placeholder scan:** Task 7's test is a guided skeleton (the route-test harness shape is file-specific and must be read at implementation time) — flagged explicitly with the fallback assertion path, not a silent TODO. All code-bearing steps show complete code.

**Type consistency:** `dropBylineAuthorFromChapter` / `isFramedAuthorNote` / `stripFrontMatterBoilerplate` / `resolveBookAuthorForManuscript` signatures are identical across their defining task and their call sites. `buildStage1ChapterInbox` gains a trailing optional `author` param (back-compatible with existing callers and tests).

**Known implementation checks called out inline:** `findBookByManuscriptId(...)` returns BOTH `.author` and `.state` (verified — `server/src/workspace/scan.ts:636`), so `located.state.author` is valid (Task 3); confirm the subset entrypoint's local names (`record` vs `recordRef`) (Tasks 4-6); confirm the route-test harness shape (Task 7).

**Adversarial-review correction (applied):** Layer B was moved from the per-chapter
`chapterCast[ch.id] = result.characters` write to `rebuildRoster()` (+ `buildInterimCast`)
so it covers **cached** chapterCast entries, not just freshly-detected ones — otherwise
the fix silently no-ops on a resume or on an already-analyzed book (the exact case the
user will test). Verified: `rebuildRoster` (full ~2556, subset ~4476) is the single
choke point feeding the running roster, final roster (~3044), and live SSE view
(~2572). `chapterHints.body` is read-only (never persisted), so Layer A's in-place
strip is safe.
