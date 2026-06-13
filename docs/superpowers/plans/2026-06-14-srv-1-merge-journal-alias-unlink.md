# srv-1 — Merge Journal for Deterministic Alias Un-link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record exact per-sentence lineage at every cast-merge call site in a per-book journal so the unlink-alias route surfaces precisely the sentences a merge moved, instead of guessing from the `chapterCast` roster heuristic.

**Architecture:** A new append/replace JSON journal at `<bookDir>/.audiobook/cast-merges.json`, written by the manual-merge route (append) and the post-stage-2 auto-fold (replace), cleared on a fresh re-analysis. The unlink-alias route reads it for a deterministic lookup, falling back to today's `chapterCast` derivation for pre-journal books, chained merges, and aliases created by a non-sentence-rewriting path. The HTTP contract is unchanged, so no OpenAPI/frontend changes.

**Tech Stack:** TypeScript (Node 20 ESM), Express, Vitest + supertest. Server code under `server/src/`. Spec: `docs/superpowers/specs/2026-06-14-srv-1-merge-journal-alias-unlink-design.md`.

**Branch:** `feat/server-merge-journal-alias-unlink` (already cut).

**Commands you will use:**
- Run a single server test file: `cd server && npx vitest run <relative-path>`
- Full server suite: `npm run test:server`
- Final gate: `npm run verify`

---

## File structure

- **Create** `server/src/store/cast-merges.ts` — the journal: types, IO (`load`/`save`/`clear`), and pure helpers (`appendManualEntry`, `replaceFoldEntries`, `buildFoldJournalEntries`). One responsibility: own the journal file shape + transformations. Mirrors `server/src/store/dropped-quotes.ts`.
- **Create** `server/src/store/cast-merges.test.ts` — unit tests for the store (pure helpers + IO round-trip).
- **Create** `server/src/routes/cast-aliases.journal.test.ts` — integration tests for the journal lookup + composite-key exclusion (keeps the existing fallback tests in `cast-aliases.test.ts` untouched and green).
- **Modify** `server/src/workspace/paths.ts` — add `castMergesJsonPath`.
- **Modify** `server/src/routes/cast-merge.ts` — append a `manual` entry after a merge.
- **Modify** `server/src/routes/cast-merge.test.ts` — assert the manual entry.
- **Modify** `server/src/routes/cast-aliases.ts` — journal-first lookup with `chapterCast` fallback.
- **Modify** `server/src/routes/analysis.ts` — fold journaling at both fold sites + journal clear on fresh.
- **Create** `docs/features/213-cast-merge-journal.md` — regression plan.
- **Modify** `docs/features/INDEX.md` — index the new plan.

---

## Task 1: Journal store module + path helper

**Files:**
- Modify: `server/src/workspace/paths.ts` (add helper next to the other `.audiobook/*` path helpers, ~line 144)
- Create: `server/src/store/cast-merges.ts`
- Test: `server/src/store/cast-merges.test.ts`

- [ ] **Step 1: Add the path helper**

In `server/src/workspace/paths.ts`, immediately after the `manuscriptEditsJsonPath` function (~line 144), add:

```ts
/* srv-1 — per-book deterministic merge journal. Each manual merge / auto-fold
   appends or replaces an entry recording which sentences it rewrote, so the
   unlink-alias route can surface exactly those sentences instead of guessing
   from the chapterCast roster. Sibling to manuscript-edits.json. */
export function castMergesJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'cast-merges.json');
}
```

- [ ] **Step 2: Write the failing unit test**

Create `server/src/store/cast-merges.test.ts`:

```ts
/* Unit tests for the cast-merges journal store: the pure transform helpers
   (no IO) plus a load/save/clear round-trip against a tempdir workspace. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cast-merges store — pure helpers', () => {
  it('buildFoldJournalEntries maps a multi-source rewrite to chapter-qualified affected sets', async () => {
    const { buildFoldJournalEntries } = await import('./cast-merges.js');
    const rewrites = { garrow: 'unknown-male', mott: 'unknown-male' };
    const preFold = [
      { id: 5, chapterId: 7, characterId: 'garrow', text: 'a' },
      { id: 3, chapterId: 8, characterId: 'garrow', text: 'b' },
      { id: 1, chapterId: 2, characterId: 'mott', text: 'c' },
      { id: 9, chapterId: 2, characterId: 'narrator', text: 'd' },
    ];
    const characters = [
      { id: 'garrow', name: 'Garrow' },
      { id: 'mott', name: 'Mott' },
      { id: 'narrator', name: 'Narrator' },
    ];
    const entries = buildFoldJournalEntries(rewrites, preFold, characters, '2026-06-14T00:00:00.000Z');

    expect(entries).toHaveLength(2);
    const garrow = entries.find((e) => e.sourceId === 'garrow')!;
    expect(garrow).toMatchObject({
      kind: 'fold',
      sourceId: 'garrow',
      sourceName: 'Garrow',
      targetId: 'unknown-male',
      ts: '2026-06-14T00:00:00.000Z',
    });
    expect(garrow.affected).toEqual([
      { chapterId: 7, sentenceId: 5 },
      { chapterId: 8, sentenceId: 3 },
    ]);
    const mott = entries.find((e) => e.sourceId === 'mott')!;
    expect(mott.affected).toEqual([{ chapterId: 2, sentenceId: 1 }]);
  });

  it('buildFoldJournalEntries returns [] for an empty rewrite map', async () => {
    const { buildFoldJournalEntries } = await import('./cast-merges.js');
    expect(buildFoldJournalEntries({}, [], [], '2026-06-14T00:00:00.000Z')).toEqual([]);
  });

  it('replaceFoldEntries drops existing fold entries and keeps manual ones', async () => {
    const { replaceFoldEntries } = await import('./cast-merges.js');
    const file = {
      entries: [
        { ts: 't1', kind: 'manual' as const, sourceId: 'a', sourceName: 'A', targetId: 'b', affected: [] },
        { ts: 't2', kind: 'fold' as const, sourceId: 'x', sourceName: 'X', targetId: 'unknown-male', affected: [] },
      ],
    };
    const next = replaceFoldEntries(file, [
      { ts: 't3', kind: 'fold' as const, sourceId: 'y', sourceName: 'Y', targetId: 'unknown-male', affected: [] },
    ]);
    expect(next.entries.map((e) => `${e.kind}:${e.sourceId}`)).toEqual(['manual:a', 'fold:y']);
  });

  it('appendManualEntry appends without touching existing entries', async () => {
    const { appendManualEntry } = await import('./cast-merges.js');
    const file = { entries: [] };
    const next = appendManualEntry(file, {
      ts: 't1', kind: 'manual' as const, sourceId: 'a', sourceName: 'A', targetId: 'b',
      affected: [{ chapterId: 1, sentenceId: 2 }],
    });
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({ kind: 'manual', sourceId: 'a' });
  });
});

describe('cast-merges store — IO round-trip', () => {
  let workspaceRoot: string;
  let bookDir: string;

  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-merges-test-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
    bookDir = join(workspaceRoot, 'books', 'A', 'Standalones', 'Book');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  it('loads an empty envelope when the file is absent, then saves and reloads', async () => {
    const { loadCastMerges, saveCastMerges, appendManualEntry } = await import('./cast-merges.js');
    const empty = await loadCastMerges(bookDir);
    expect(empty).toEqual({ entries: [] });

    const saved = appendManualEntry(empty, {
      ts: 't1', kind: 'manual', sourceId: 'a', sourceName: 'A', targetId: 'b',
      affected: [{ chapterId: 3, sentenceId: 4 }],
    });
    await saveCastMerges(bookDir, saved);

    const reloaded = await loadCastMerges(bookDir);
    expect(reloaded.entries).toHaveLength(1);
    expect(reloaded.entries[0].affected).toEqual([{ chapterId: 3, sentenceId: 4 }]);
  });

  it('clearCastMerges removes the file and is a no-op when absent', async () => {
    const { loadCastMerges, saveCastMerges, clearCastMerges, castMergesExists } = await import('./cast-merges.js');
    await saveCastMerges(bookDir, { entries: [
      { ts: 't', kind: 'manual', sourceId: 'a', sourceName: 'A', targetId: 'b', affected: [] },
    ] });
    expect(await castMergesExists(bookDir)).toBe(true);
    await clearCastMerges(bookDir);
    expect(await castMergesExists(bookDir)).toBe(false);
    /* Second clear must not throw. */
    await clearCastMerges(bookDir);
    expect((await loadCastMerges(bookDir)).entries).toEqual([]);
  });
});
```

> Note: `castMergesExists` is a tiny test-support export defined in Step 4. The test imports it; if you prefer, replace it with a direct `existsSync(castMergesJsonPath(bookDir))` — but the export keeps the test from re-deriving the path. `existsSync` is already imported above for that fallback.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npx vitest run src/store/cast-merges.test.ts`
Expected: FAIL — `Cannot find module './cast-merges.js'`.

- [ ] **Step 4: Write the store module**

Create `server/src/store/cast-merges.ts`:

```ts
/* srv-1 — per-book deterministic merge journal.

   Every operation that folds one cast member into another AND rolls the
   source's name into the survivor's `aliases` records an entry here, so the
   unlink-alias route (server/src/routes/cast-aliases.ts) can later surface
   EXACTLY the sentences that merge rewrote — instead of reconstructing
   "impacted chapters" from the chapterCast roster, which over-reports.

   Two write sites, mirroring how the alias gets created in the first place:
     - manual merge (cast-merge.ts)         → appendManualEntry  (append-only)
     - post-stage-2 auto-fold (analysis.ts) → replaceFoldEntries (idempotent)

   Lifecycle: a `fresh: true` re-analysis clears the whole file (ids regenerate
   from scratch); each fold pass replaces all `kind:'fold'` entries with that
   pass's set while preserving `kind:'manual'`; manual merges append.

   Only these two paths rewrite THIS book's per-sentence `characterId`. The
   stage-1 roster merge happens before sentence attribution exists, and
   cast-link-prior / voice-match / add-alias only attach a recognition label —
   none of them move sentences, so the unlink route correctly falls back to the
   chapterCast heuristic for aliases they produced. See the design doc.

   Same atomic-write + empty-on-missing contract as store/dropped-quotes.ts. */

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { castMergesJsonPath } from '../workspace/paths.js';

/** A chapter-qualified sentence reference. Sentence ids are unique only within
    a chapter (stage2-chunk.ts assigns `id: i + 1` per chapter), so lineage
    MUST carry the chapterId — a bare id list is ambiguous across chapters. */
export interface AffectedSentence {
  chapterId: number;
  sentenceId: number;
}

export interface CastMergeEntry {
  /** ISO timestamp the entry was recorded. */
  ts: string;
  kind: 'manual' | 'fold';
  /** Character id that disappeared in the merge. */
  sourceId: string;
  /** The name that became the alias on the target — the match key the unlink
      route uses, since the alias chip carries a name, not an id. */
  sourceName: string;
  /** Survivor that absorbed the source. */
  targetId: string;
  /** The exact sentences this merge rewrote source → target. */
  affected: AffectedSentence[];
}

export interface CastMergesFile {
  entries: CastMergeEntry[];
}

/* ── Pure transforms (no IO) ───────────────────────────────────────────── */

/** Append a manual-merge entry. Returns a new envelope. */
export function appendManualEntry(file: CastMergesFile, entry: CastMergeEntry): CastMergesFile {
  return { entries: [...file.entries, entry] };
}

/** Replace ALL fold entries with `foldEntries`, preserving every manual entry.
    Idempotent across resume / partial re-analysis — a re-fold can't accumulate
    duplicates. */
export function replaceFoldEntries(
  file: CastMergesFile,
  foldEntries: CastMergeEntry[],
): CastMergesFile {
  return { entries: [...file.entries.filter((e) => e.kind !== 'fold'), ...foldEntries] };
}

/** Turn a fold's `rewrites` map (old id → new id) into one journal entry per
    source. `affected` for each source = the (chapterId, sentenceId) of every
    PRE-FOLD sentence still attributed to that source; `sourceName` is looked up
    from the pre-fold roster (which still contains the folded sources). */
export function buildFoldJournalEntries(
  rewrites: Record<string, string>,
  preFoldSentences: ReadonlyArray<{ id: number; chapterId: number; characterId: string }>,
  characters: ReadonlyArray<{ id: string; name: string }>,
  ts: string,
): CastMergeEntry[] {
  const sourceIds = Object.keys(rewrites);
  if (sourceIds.length === 0) return [];
  const nameById = new Map(characters.map((c) => [c.id, c.name]));
  const affectedBySource = new Map<string, AffectedSentence[]>();
  for (const id of sourceIds) affectedBySource.set(id, []);
  for (const s of preFoldSentences) {
    const bucket = affectedBySource.get(s.characterId);
    if (bucket) bucket.push({ chapterId: s.chapterId, sentenceId: s.id });
  }
  return sourceIds.map((sourceId) => ({
    ts,
    kind: 'fold' as const,
    sourceId,
    sourceName: nameById.get(sourceId) ?? sourceId,
    targetId: rewrites[sourceId],
    affected: affectedBySource.get(sourceId) ?? [],
  }));
}

/* ── IO ────────────────────────────────────────────────────────────────── */

/** Load the journal; returns `{ entries: [] }` when the file is absent. */
export async function loadCastMerges(bookDir: string): Promise<CastMergesFile> {
  const existing = await readJson<CastMergesFile>(castMergesJsonPath(bookDir));
  if (existing && Array.isArray(existing.entries)) return existing;
  return { entries: [] };
}

/** Persist atomically (same OneDrive-EPERM retry contract as state-io.ts). */
export async function saveCastMerges(bookDir: string, file: CastMergesFile): Promise<void> {
  await writeJsonAtomic(castMergesJsonPath(bookDir), file);
}

/** Delete the journal. No-op when absent (legacy non-workspace manuscripts
    have no bookDir; callers guard). */
export async function clearCastMerges(bookDir: string): Promise<void> {
  await rm(castMergesJsonPath(bookDir), { force: true });
}

/** Test/diagnostic helper — does the journal file exist on disk? */
export async function castMergesExists(bookDir: string): Promise<boolean> {
  return existsSync(castMergesJsonPath(bookDir));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run src/store/cast-merges.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/workspace/paths.ts server/src/store/cast-merges.ts server/src/store/cast-merges.test.ts
git commit -m "feat(server): add cast-merges journal store + path helper"
```

---

## Task 2: Manual-merge journaling

**Files:**
- Modify: `server/src/routes/cast-merge.ts`
- Test: `server/src/routes/cast-merge.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/routes/cast-merge.test.ts`, add this test immediately after the first test (`'folds source into target, builds aliases, remaps sentences, updates cache'`), inside the same `describe('cast-merge router', …)` block. It relies on that first test having already merged `wren → wren-sparrow`:

```ts
  it('records a manual journal entry with chapter-qualified affected sentences', async () => {
    /* The first test merged wren → wren-sparrow. wren spoke sentences
       id1/id2 (chapter 1) and id3 (chapter 2). The journal must record those
       three as chapter-qualified pairs under a single manual entry. */
    const journal = readDisk<{
      entries: Array<{
        kind: string;
        sourceId: string;
        sourceName: string;
        targetId: string;
        affected: Array<{ chapterId: number; sentenceId: number }>;
      }>;
    }>('cast-merges.json');

    expect(journal.entries).toHaveLength(1);
    const entry = journal.entries[0];
    expect(entry).toMatchObject({
      kind: 'manual',
      sourceId: 'wren',
      sourceName: 'Wren',
      targetId: 'wren-sparrow',
    });
    expect(entry.affected).toEqual([
      { chapterId: 1, sentenceId: 1 },
      { chapterId: 1, sentenceId: 2 },
      { chapterId: 2, sentenceId: 3 },
    ]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/cast-merge.test.ts`
Expected: FAIL — reading `cast-merges.json` throws `ENOENT` (file not written yet).

- [ ] **Step 3: Add the journal import**

In `server/src/routes/cast-merge.ts`, after the existing import of `loadAnalysisCache` (line 24), add:

```ts
import { loadCastMerges, saveCastMerges, appendManualEntry } from '../store/cast-merges.js';
```

- [ ] **Step 4: Collect affected pairs during the remap**

In `server/src/routes/cast-merge.ts`, the edits-remap block currently reads (lines ~137–153):

```ts
  const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
  let editsTouched = false;
  let editsAfter: SentenceOutput[] | null = null;
  if (edits?.sentences?.length) {
    let changed = 0;
    editsAfter = edits.sentences.map((s) => {
      if (s.characterId === sourceId) {
        changed += 1;
        return { ...s, characterId: targetId };
      }
      return s;
    });
    if (changed > 0) {
      editsTouched = true;
      await writeJsonAtomic(manuscriptEditsJsonPath(bookDir), { sentences: editsAfter });
    }
  }
```

Replace it with (adds an `affected` accumulator declared at the outer scope so the journal write below can read it):

```ts
  const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
  let editsTouched = false;
  let editsAfter: SentenceOutput[] | null = null;
  /* srv-1 — chapter-qualified ids of the sentences this merge rewrites
     source → target. Sentence ids are unique only within a chapter, so we
     keep the chapterId alongside each id. */
  const affected: Array<{ chapterId: number; sentenceId: number }> = [];
  if (edits?.sentences?.length) {
    let changed = 0;
    editsAfter = edits.sentences.map((s) => {
      if (s.characterId === sourceId) {
        changed += 1;
        affected.push({ chapterId: s.chapterId, sentenceId: s.id });
        return { ...s, characterId: targetId };
      }
      return s;
    });
    if (changed > 0) {
      editsTouched = true;
      await writeJsonAtomic(manuscriptEditsJsonPath(bookDir), { sentences: editsAfter });
    }
  }
```

- [ ] **Step 5: Append the journal entry after all persists**

In `server/src/routes/cast-merge.ts`, find the final `console.log('[cast-merge] …')` call (~lines 220–224) and insert this block immediately BEFORE it:

```ts
  /* srv-1 — append this merge to the deterministic lineage journal so the
     unlink-alias route can later surface exactly these sentences. Non-fatal:
     cast.json / edits / cache already persisted above, so a journal failure
     must never fail the merge (mirrors the reuse-link precedent). */
  try {
    const journal = await loadCastMerges(bookDir);
    await saveCastMerges(
      bookDir,
      appendManualEntry(journal, {
        ts: new Date().toISOString(),
        kind: 'manual',
        sourceId,
        sourceName: source.name,
        targetId,
        affected,
      }),
    );
  } catch (journalErr) {
    console.warn('[cast-merge] failed to write cast-merges journal', journalErr);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/cast-merge.test.ts`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/cast-merge.ts server/src/routes/cast-merge.test.ts
git commit -m "feat(server): journal manual cast merges for deterministic alias un-link"
```

---

## Task 3: Unlink journal lookup + fallback

**Files:**
- Modify: `server/src/routes/cast-aliases.ts`
- Test: `server/src/routes/cast-aliases.journal.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/cast-aliases.journal.test.ts`:

```ts
/* Integration tests for the cast-aliases unlink-alias JOURNAL path (srv-1).

   Proves the deterministic lookup beats the chapterCast heuristic AND that
   the chapter-qualified (chapterId, sentenceId) key excludes a colliding id
   from an unrelated chapter — the exact bug a flat number[] design would hit.

   The existing chapterCast-fallback behaviour is covered by cast-aliases.test.ts
   (which writes no journal); this file always seeds a journal. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Journal Book';
const MANUSCRIPT_ID = 'm_journal_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

/* Source character carries the alias "Garrow" (merged onto it mid-book). */
const source = {
  id: 'saltgrave-figure',
  name: 'Saltgrave Figure',
  role: 'antagonist',
  color: 'eliza',
  gender: 'male',
  ageRange: 'adult',
  aliases: ['Garrow'],
};

/* manuscript-edits.json — Garrow's lines were merged onto Saltgrave in
   chapters 7/8/9 (ids 5,6 / 3 / 1). Chapter 1 also has Saltgrave lines whose
   ids COLLIDE with the chapter-7 ids (5 and 6) but are NOT Garrow's — a flat
   number[] design would wrongly surface them. */
const editsSentences = [
  { id: 5, chapterId: 1, characterId: 'saltgrave-figure', text: 'ch1 collide a' },
  { id: 6, chapterId: 1, characterId: 'saltgrave-figure', text: 'ch1 collide b' },
  { id: 5, chapterId: 7, characterId: 'saltgrave-figure', text: 'garrow 7a' },
  { id: 6, chapterId: 7, characterId: 'saltgrave-figure', text: 'garrow 7b' },
  { id: 3, chapterId: 8, characterId: 'saltgrave-figure', text: 'garrow 8' },
  { id: 1, chapterId: 9, characterId: 'saltgrave-figure', text: 'garrow 9' },
];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-aliases-journal-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castAliasesRouter }, { makeBookId }] = await Promise.all([
    import('./cast-aliases.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [1, 7, 8, 9].map((id) => ({ id, title: `Ch ${id}`, slug: `0${id}-ch` })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [source] }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: editsSentences }),
  );
  /* The journal records exactly Garrow's chapter-7/8/9 sentences. */
  writeFileSync(
    join(bookDir, '.audiobook', 'cast-merges.json'),
    JSON.stringify({
      entries: [
        {
          ts: '2026-06-14T00:00:00.000Z',
          kind: 'manual',
          sourceId: 'garrow',
          sourceName: 'Garrow',
          targetId: 'saltgrave-figure',
          affected: [
            { chapterId: 7, sentenceId: 5 },
            { chapterId: 7, sentenceId: 6 },
            { chapterId: 8, sentenceId: 3 },
            { chapterId: 9, sentenceId: 1 },
          ],
        },
      ],
    }),
  );

  /* chapterCast deliberately ALSO lists Garrow in chapter 1 — proving the
     journal path ignores it (the fallback path would surface chapter 1). */
  const testFileDir = dirname(fileURLToPath(import.meta.url));
  cachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({
      chapterCast: {
        1: [{ id: 'garrow', name: 'Garrow', role: 'minor', color: 'halloran' }],
        7: [{ id: 'garrow', name: 'Garrow', role: 'minor', color: 'halloran' }],
      },
      chapters: {},
      updatedAt: new Date().toISOString(),
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', castAliasesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (cachePath) rmSync(cachePath, { force: true });
});

interface UnlinkRes {
  newCharacter: { id: string; name: string };
  impactedChapters: Array<{ chapterId: number; candidateSentenceIds: number[] }>;
}

describe('cast-aliases unlink-alias — journal path', () => {
  it('surfaces exactly the journal-recorded sentences and excludes colliding ids from other chapters', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow' });

    expect(res.status).toBe(200);
    const body = res.body as UnlinkRes;
    expect(body.newCharacter.name).toBe('Garrow');

    /* ONLY chapters 7, 8, 9 — NOT chapter 1 (chapterCast lists Garrow there,
       but the journal path ignores chapterCast entirely). */
    expect(body.impactedChapters.map((c) => c.chapterId)).toEqual([7, 8, 9]);
    /* Chapter 7 has exactly Garrow's ids 5 and 6. The chapter-1 sentences with
       the SAME ids (5, 6) are excluded by the composite key. */
    const ch7 = body.impactedChapters.find((c) => c.chapterId === 7)!;
    expect(ch7.candidateSentenceIds).toEqual([5, 6]);
    expect(body.impactedChapters.find((c) => c.chapterId === 8)!.candidateSentenceIds).toEqual([3]);
    expect(body.impactedChapters.find((c) => c.chapterId === 9)!.candidateSentenceIds).toEqual([1]);
    expect(body.impactedChapters.some((c) => c.chapterId === 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/cast-aliases.journal.test.ts`
Expected: FAIL — the current route uses `chapterCast`, so `impactedChapters` includes chapter 1 and the assertion `toEqual([7, 8, 9])` fails.

- [ ] **Step 3: Add the journal import**

In `server/src/routes/cast-aliases.ts`, after the `loadAnalysisCache` import (line 26), add:

```ts
import { loadCastMerges } from '../store/cast-merges.js';
```

- [ ] **Step 4: Replace the chapterCast derivation with journal-first lookup**

In `server/src/routes/cast-aliases.ts`, replace the entire block from the comment `/* Derive impacted chapters from the preserved chapterCast …` down to the construction of `impactedChapters` (lines ~164–208, i.e. everything between the `writeJsonAtomic(castJsonPath …)` call and the `console.log('[cast-aliases] …')` call) with:

```ts
    /* srv-1 — prefer the deterministic merge journal. A journal entry that
       records THIS alias (sourceName) being merged onto THIS character
       (targetId === sourceCharacterId) pins the exact sentences that merge
       rewrote. Fall back to the chapterCast heuristic for pre-journal books,
       chained merges, manual `add-alias` chips, and any alias produced by a
       path that never rewrote sentences (see store/cast-merges.ts header). */
    const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
    let impactedChapters = await impactedChaptersFromJournal(
      bookDir,
      sourceCharacterId,
      aliasKey,
      edits,
    );
    let lineageSource: 'journal' | 'fallback' = 'journal';
    if (!impactedChapters) {
      lineageSource = 'fallback';
      impactedChapters = await impactedChaptersFromChapterCast(
        state.manuscriptId,
        sourceCharacterId,
        edits,
        aliasKey,
      );
    }

    console.log(
      `[cast-aliases] book=${bookId} unlinked alias "${aliasName}" from ${sourceCharacterId}` +
        ` → ${newCharacterId} (${impactedChapters.length} impacted chapters, ${lineageSource})`,
    );

    return res.json({ newCharacter, impactedChapters });
  },
);
```

> This deletes the old inline `cache` load, the `impactedChapterIds` loop, the inline `edits` read, the `byChapter` build, and the old `console.log` + `return res.json(...)` — they are all replaced by the two helper calls and the new log/return above. Make sure exactly one `console.log` + `return res.json({ newCharacter, impactedChapters })` remains for this route.

- [ ] **Step 5: Add the two helper functions**

In `server/src/routes/cast-aliases.ts`, add these two functions at the bottom of the file (after the `add-alias` route, before any trailing exports). They use the existing `ImpactedChapter` / `EditsFile` interfaces and the already-imported `loadAnalysisCache`:

```ts
/* srv-1 — deterministic lineage from the merge journal. Returns null (→ caller
   falls back to chapterCast) when no entry matches OR when the matched entries
   carry no recorded sentences at all (a merge logged before stage-2
   attribution existed — ambiguous, so let the heuristic decide). When entries
   DO carry recorded sentences, returns the intersection with the lines still
   attributed to the source — even if that intersection is empty (the user
   already reattributed them; there is genuinely nothing left to surface). */
async function impactedChaptersFromJournal(
  bookDir: string,
  sourceCharacterId: string,
  aliasKey: string,
  edits: EditsFile | null,
): Promise<ImpactedChapter[] | null> {
  const journal = await loadCastMerges(bookDir);
  const matched = journal.entries.filter(
    (e) => e.targetId === sourceCharacterId && e.sourceName.trim().toLowerCase() === aliasKey,
  );
  if (matched.length === 0) return null;

  /* Union the recorded (chapterId, sentenceId) pairs, dedup on composite key. */
  const recorded = new Set<string>();
  for (const e of matched) {
    for (const a of e.affected) recorded.add(`${a.chapterId}:${a.sentenceId}`);
  }
  if (recorded.size === 0) return null; // ambiguous pre-stage-2 merge → fall back

  /* Intersect with sentences STILL attributed to the source (drops lines the
     user already reattributed, and any stale pair whose id no longer exists). */
  const byChapter = new Map<number, number[]>();
  for (const s of edits?.sentences ?? []) {
    if (s.characterId !== sourceCharacterId) continue;
    if (!recorded.has(`${s.chapterId}:${s.id}`)) continue;
    const list = byChapter.get(s.chapterId);
    if (list) list.push(s.id);
    else byChapter.set(s.chapterId, [s.id]);
  }
  return [...byChapter.keys()]
    .sort((a, b) => a - b)
    .map((chapterId) => ({
      chapterId,
      candidateSentenceIds: (byChapter.get(chapterId) ?? []).sort((a, b) => a - b),
    }));
}

/* Legacy heuristic (pre-srv-1 behaviour, unchanged): a chapter is "impacted"
   when its preserved Phase-0a chapterCast roster contained a character matching
   the alias name. Candidate sentences are the source-attributed lines in those
   chapters. Over-reports (the reason srv-1 exists), but it is the best lineage
   available when the journal has nothing for this alias. */
async function impactedChaptersFromChapterCast(
  manuscriptId: string,
  sourceCharacterId: string,
  edits: EditsFile | null,
  aliasKey: string,
): Promise<ImpactedChapter[]> {
  const cache = await loadAnalysisCache(manuscriptId);
  const impactedChapterIds = new Set<number>();
  if (cache.chapterCast) {
    for (const [rawId, roster] of Object.entries(cache.chapterCast)) {
      const chapterId = Number(rawId);
      if (!Number.isFinite(chapterId)) continue;
      for (const c of roster) {
        if (c.name.trim().toLowerCase() === aliasKey) {
          impactedChapterIds.add(chapterId);
          break;
        }
        if ((c.aliases ?? []).some((a) => a.trim().toLowerCase() === aliasKey)) {
          impactedChapterIds.add(chapterId);
          break;
        }
      }
    }
  }
  const byChapter = new Map<number, number[]>();
  for (const s of edits?.sentences ?? []) {
    if (s.characterId !== sourceCharacterId) continue;
    if (!impactedChapterIds.has(s.chapterId)) continue;
    const list = byChapter.get(s.chapterId);
    if (list) list.push(s.id);
    else byChapter.set(s.chapterId, [s.id]);
  }
  return [...impactedChapterIds]
    .sort((a, b) => a - b)
    .map((chapterId) => ({
      chapterId,
      candidateSentenceIds: (byChapter.get(chapterId) ?? []).sort((a, b) => a - b),
    }));
}
```

- [ ] **Step 6: Run both unlink test files to verify journal passes AND fallback stays green**

Run: `cd server && npx vitest run src/routes/cast-aliases.journal.test.ts src/routes/cast-aliases.test.ts`
Expected: PASS for both — the new journal test passes, and the original `cast-aliases.test.ts` (no journal file → `impactedChaptersFromJournal` returns null → fallback) still produces `impactedChapters` `[1, 4]` exactly as before.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/cast-aliases.ts server/src/routes/cast-aliases.journal.test.ts
git commit -m "feat(server): journal-first deterministic alias un-link with chapterCast fallback"
```

---

## Task 4: Fold journaling + journal clear on fresh re-analysis

**Files:**
- Modify: `server/src/routes/analysis.ts` (two fold persist sites + the `requestedFresh` cleanup block)

> **Testing note (read first):** the fold-lineage LOGIC is fully unit-tested in Task 1 (`buildFoldJournalEntries` + `replaceFoldEntries`). The change in this task is mechanical glue (compute entries from already-in-scope values, then `replaceFoldEntries` + `saveCastMerges` inside the existing persist block). A full route-level integration test would have to stand up the entire analyzer pipeline, which is disproportionate for ~6 lines of wiring; the pure-helper tests plus the manual verification in Step 5 are the coverage here. This is a deliberate, stated skip per CLAUDE.md's "say so explicitly" rule — not an omission.

- [ ] **Step 1: Add the journal imports**

In `server/src/routes/analysis.ts`, after the `foldMinorCast` import (line 24), add:

```ts
import {
  loadCastMerges,
  saveCastMerges,
  clearCastMerges,
  replaceFoldEntries,
  buildFoldJournalEntries,
} from '../store/cast-merges.js';
```

- [ ] **Step 2: Clear the journal on a fresh re-analysis**

In `server/src/routes/analysis.ts`, in the `if (requestedFresh)` block, the `if (recordRef.bookDir)` cleanup currently `rm`s cast.json / manuscript-edits.json / carryover (lines ~2041–2047). Add one line after the carryover `rm`:

```ts
        await rm(castReuseCarryoverJsonPath(recordRef.bookDir), { force: true });
        /* srv-1 — fresh run regenerates ids from scratch, so old lineage is
           meaningless; drop the merge journal too. */
        await clearCastMerges(recordRef.bookDir);
```

- [ ] **Step 3: Journal the fold on the MAIN route**

In `server/src/routes/analysis.ts`, inside the main route's persist block, find the edits write (~lines 3540–3542):

```ts
        await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), {
          sentences: reconciled.sentences,
        });
```

Immediately AFTER it (still inside the same `try`, BEFORE the `if (phase1DriftExceeded)` branch), add:

```ts
        /* srv-1 — record this fold pass's lineage. Co-located with the edits
           write so the journal is persisted iff the sentences it describes are
           (edits are written even on drift; cast.json is the file skipped).
           Replace-all keeps fold entries in lockstep with the current edits;
           manual entries are preserved. Non-fatal. */
        try {
          const journal = await loadCastMerges(record.bookDir);
          await saveCastMerges(
            record.bookDir,
            replaceFoldEntries(
              journal,
              buildFoldJournalEntries(
                folded.rewrites,
                recovered.sentences,
                stage1.characters,
                new Date().toISOString(),
              ),
            ),
          );
        } catch (journalErr) {
          console.warn('[analysis] failed to write cast-merges journal', journalErr);
        }
```

- [ ] **Step 4: Journal the fold on the SUBSET (re-analysis) route**

In `server/src/routes/analysis.ts`, inside the subset route's `if (record.bookDir && !isAborted())` persist block, find the edits write (~lines 4444–4446):

```ts
        await writeJsonAtomic(manuscriptEditsJsonPath(record.bookDir), {
          sentences: subsetReconciled.sentences,
        });
```

Immediately AFTER it (still inside the same `try`, BEFORE the `if (subsetDriftExceeded)` branch), add the SAME block as Step 3 (the in-scope variable names `folded`, `recovered`, `stage1` are identical here):

```ts
        /* srv-1 — record this fold pass's lineage (see the main route's same
           block). Subset fold runs over the full whole-book sentence set, so
           replace-all is correct. Gated by !isAborted() with the edits write. */
        try {
          const journal = await loadCastMerges(record.bookDir);
          await saveCastMerges(
            record.bookDir,
            replaceFoldEntries(
              journal,
              buildFoldJournalEntries(
                folded.rewrites,
                recovered.sentences,
                stage1.characters,
                new Date().toISOString(),
              ),
            ),
          );
        } catch (journalErr) {
          console.warn('[analysis] failed to write cast-merges journal', journalErr);
        }
```

- [ ] **Step 5: Typecheck + verify wiring compiles and the server suite stays green**

Run: `npm run typecheck`
Expected: PASS (no type errors — confirms `folded.rewrites`, `recovered.sentences`, `stage1.characters` are in scope and correctly typed at both sites).

Run: `cd server && npm run test`
Expected: PASS — existing analysis tests unaffected; no fold-journal regression.

Manual verification (optional, on a GPU/analyzer box): run an analysis on a book that folds a background speaker, confirm `<bookDir>/.audiobook/cast-merges.json` appears with a `kind:'fold'` entry whose `affected` pairs match the folded character's sentences, then open the Profile Drawer for the bucket and remove the folded alias chip — the Reattribute Lines modal should list exactly those sentences.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts
git commit -m "feat(server): journal auto-folds + clear journal on fresh re-analysis"
```

---

## Task 5: Regression plan doc + index + final gate

**Files:**
- Create: `docs/features/213-cast-merge-journal.md`
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the regression plan**

Create `docs/features/213-cast-merge-journal.md`:

```markdown
---
status: active
issue: 397
---

# 213 — Merge journal for deterministic alias un-link (srv-1)

## What

A per-book journal `<bookDir>/.audiobook/cast-merges.json` records, for every
cast-merge that rewrites sentence attributions, the exact sentences it moved.
The unlink-alias route reads it to surface precisely those sentences in the
Reattribute Lines modal, replacing the over-reporting `chapterCast` heuristic.

## Invariants

- **Entry shape:** `{ ts, kind: 'manual' | 'fold', sourceId, sourceName,
  targetId, affected: { chapterId, sentenceId }[] }`. Sentence ids are unique
  only within a chapter, so lineage is always chapter-qualified.
- **Write sites:** manual merge (`cast-merge.ts`, append) and post-stage-2
  auto-fold (`analysis.ts`, replace-all fold entries). No other path rewrites
  this book's sentence attributions.
- **Lifecycle:** `fresh: true` re-analysis clears the journal; each fold pass
  replaces `kind:'fold'` entries; manual merges append and survive non-fresh
  re-runs.
- **Lookup:** match `targetId === sourceCharacterId` AND `sourceName` ==
  aliasName (case-insensitive); intersect recorded pairs with sentences still
  attributed to the source. No match (or zero recorded pairs) → fall back to the
  `chapterCast` derivation.
- **Contract unchanged:** `UnlinkResponse` / `ImpactedChapter` shapes are
  identical; no OpenAPI or frontend change.

## Acceptance walkthrough

1. Analyse a book; merge a mid-book duplicate that touches sentences only in
   chapters 7–9.
2. Open the survivor's Profile Drawer, remove the merged alias chip.
3. The Reattribute Lines modal lists exactly the chapters 7–9 sentences the
   merge moved — no chapter 1–6 lines, even if the alias name appears in those
   chapters' rosters.
4. On a pre-journal book (no `cast-merges.json`), the modal falls back to the
   chapterCast behaviour (chapters where the name was in the roster).

## Automated coverage

- `server/src/store/cast-merges.test.ts` — pure helpers + IO round-trip.
- `server/src/routes/cast-merge.test.ts` — manual entry recorded with
  chapter-qualified affected pairs.
- `server/src/routes/cast-aliases.journal.test.ts` — journal path beats
  chapterCast and excludes a colliding id from another chapter.
- `server/src/routes/cast-aliases.test.ts` — fallback path stays green.

## Residual risks (accepted)

- Alias union vs. journal replace: a character the analyzer stops detecting on a
  later re-analysis keeps its chip (aliases are unioned) but loses its fold
  entry (replaced) → that one alias falls back to chapterCast.
- Sentence-id stability across re-segmentation: stale pairs drop out of the
  intersection harmlessly.

See `docs/superpowers/specs/2026-06-14-srv-1-merge-journal-alias-unlink-design.md`
for the full design + adversarial-review findings.
```

- [ ] **Step 2: Index the plan**

In `docs/features/INDEX.md`, add an entry for plan 213 under the appropriate server/cast area (match the surrounding format of existing entries — find a neighbouring `2xx` cast/analysis entry and mirror its bullet style). Example line:

```markdown
- [213 — Merge journal for deterministic alias un-link (srv-1)](213-cast-merge-journal.md) — exact per-sentence lineage for alias un-link; replaces the chapterCast heuristic.
```

- [ ] **Step 3: Commit the docs**

```bash
git add docs/features/213-cast-merge-journal.md docs/features/INDEX.md
git commit -m "docs(docs): regression plan 213 for srv-1 merge journal"
```

- [ ] **Step 4: Run the full verification gate**

Run: `npm run verify`
Expected: PASS — typecheck + all tests + e2e + build green. If a leg fails, triage per CLAUDE.md (related → fix here; pre-existing → surface, do not bypass).

- [ ] **Step 5: Open the PR (draft)**

```bash
git push -u origin feat/server-merge-journal-alias-unlink
gh pr create --draft \
  --title "feat(server): merge journal for deterministic alias un-link (srv-1)" \
  --body "$(cat <<'EOF'
## Summary

Adds a per-book merge journal (`.audiobook/cast-merges.json`) recording the exact sentences each cast-merge / auto-fold rewrites, so the unlink-alias route surfaces precisely those sentences instead of guessing from the `chapterCast` roster. Falls back to the `chapterCast` heuristic for pre-journal books, chained merges, and aliases created by paths that never moved sentences. HTTP contract unchanged.

Spec: `docs/superpowers/specs/2026-06-14-srv-1-merge-journal-alias-unlink-design.md`
Plan: `docs/superpowers/plans/2026-06-14-srv-1-merge-journal-alias-unlink.md`
Regression plan: `docs/features/213-cast-merge-journal.md`

## Test plan

- `cast-merges.test.ts` — store helpers + IO
- `cast-merge.test.ts` — manual entry recorded
- `cast-aliases.journal.test.ts` — journal path + composite-key exclusion
- `cast-aliases.test.ts` — fallback stays green
- `npm run verify` green

Closes #397
EOF
)"
```

- [ ] **Step 6: Make ready when green**

After `npm run verify` is green locally, run `gh pr ready` to fire the single billed CI run before merge.

---

## Self-review (completed during planning)

- **Spec coverage:** journal file + store (Task 1), manual write (Task 2), unlink read + fallback (Task 3), fold write at both sites + fresh clear (Task 4), regression plan (Task 5). Every spec section maps to a task.
- **Composite-key correctness** (the spec's headline correction) is pinned by the colliding-id assertion in `cast-aliases.journal.test.ts`.
- **Type consistency:** `CastMergeEntry` / `CastMergesFile` / `AffectedSentence` defined in Task 1 are used verbatim in Tasks 2–4; helper names (`loadCastMerges`, `saveCastMerges`, `clearCastMerges`, `appendManualEntry`, `replaceFoldEntries`, `buildFoldJournalEntries`, `castMergesJsonPath`) match across all tasks.
- **Fallback preserved:** Task 3 keeps the original chapterCast logic verbatim inside `impactedChaptersFromChapterCast`, so `cast-aliases.test.ts` stays green without edits.
```
