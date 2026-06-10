# Replace-Manuscript Feature (Wave 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable "Replace manuscript" capability — upload a new manuscript file onto an existing book, re-detect chapters, and preserve designed voices via the existing srv-13 carryover — so an author can revise a manuscript without losing cast work.

**Architecture:** Extract the post-parse half of the existing `POST /api/books/:bookId/reparse` route into a shared `applyReparse()` helper. `reparse` keeps reading the on-disk file; a new `POST /api/books/:bookId/replace-manuscript` writes an uploaded file to the book dir (swapping the extension if needed) and then runs the **same** `applyReparse()`. The frontend adds a "Replace manuscript…" item to both the grid-card and table-row book menus, each with a hidden file input + a destructive confirm dialog, threading an `onReplaceManuscript(book, file)` handler that mirrors the existing reparse handler in `src/routes/index.tsx`.

**Tech Stack:** Express + multer (server), Vitest + supertest (server tests), React + Redux Toolkit (frontend), Vitest + React Testing Library (frontend tests), Playwright (e2e).

**Scope note:** This is Wave 1 of the fs-22 spec (`docs/superpowers/specs/2026-06-11-fs22-bundled-demo-book-design.md`). Wave 2 (produce demo content live) and Wave 3 (fs-22 bundling) are out of scope here and get their own plan after Wave 2. **After this plan is green: merge to `main` and `npm run build` locally — that is the gate before Wave 2.**

This plan touches two scopes (`server`, `frontend`). They are sequential here (frontend calls the new endpoint), so they ship as one cohesive branch/PR `feat/fs-replace-manuscript`.

---

## File Structure

**Server:**
- Modify `server/src/routes/book-state.ts` — extract `applyReparse()`; refactor the `reparse` route to call it; add the `replace-manuscript` route (multer).
- Create `server/src/routes/book-state.replace-manuscript.test.ts` — integration tests for the new route (mirrors `book-state.reparse.test.ts`).

**Frontend:**
- Modify `src/lib/api.ts` — add `replaceManuscript` (real + mock) and a response type.
- Modify `src/components/library/library-grid.tsx` — "Replace manuscript…" menu item + file input + confirm.
- Modify `src/components/library/library-table.tsx` — same menu item for the table view.
- Modify `src/views/book-library.tsx` — thread `onReplaceManuscript` prop to both regions.
- Modify `src/routes/index.tsx` — provide the `onReplaceManuscript` handler.
- Modify `src/components/library/library-table.test.tsx` (or grid test) — unit coverage for the menu → confirm → handler wiring.

**E2E:**
- Modify `e2e/responsive/coverage.spec.ts` OR create `e2e/replace-manuscript.spec.ts` — browser golden path.

**Docs:**
- Create `docs/features/<n>-replace-manuscript.md` from `docs/features/TEMPLATE.md`.
- Modify `docs/features/INDEX.md`, `docs/BACKLOG.md` (thin row), and the spec's status.

---

## Task 1: Extract `applyReparse()` shared core (refactor, behavior-neutral)

**Files:**
- Modify: `server/src/routes/book-state.ts` (the `reparse` route, ~741–977)
- Test: existing `server/src/routes/book-state.reparse.test.ts` must stay green (no new test — this is a pure extraction guarded by the existing suite).

- [ ] **Step 1: Run the existing reparse suite to confirm a green baseline**

Run: `cd server && npx vitest run src/routes/book-state.reparse.test.ts`
Expected: PASS (all cases).

- [ ] **Step 2: Add the `applyReparse()` helper above the `reparse` route**

Insert this top-level function in `server/src/routes/book-state.ts`, just above the `bookStateRouter.post('/:bookId/reparse', …)` line (~741). It is a verbatim lift of the route body **after** `parsed` is obtained, with the change-log `type`/`title` parameterised. All identifiers (`writeStateJsonAtomic`, `castReuseCarryoverJsonPath`, `readJson`, `writeJsonAtomic`, `PRESERVED_VOICE_FIELDS`, `clearAnalysisCache`, `audioDir`, `castJsonPath`, `revisionsJsonPath`, `changeLogJsonPath`, `manuscriptEditsJsonPath`, `putManuscript`, `slug`, `CHAPTER_TITLE_PARSER_VERSION`, types `BookStateJson`/`ManuscriptRecord`) are already imported in this file.

```ts
/* Shared post-parse core for reparse + replace-manuscript. Given a freshly
   parsed manuscript, regenerates the chapter list, snapshots the srv-13
   reuse/voice carryover, wipes the now-stale analysis cache / cast / audio,
   reconciles manuscript-edits (via the GET-side merge — the file is left in
   place here), appends a change-log entry, refreshes the in-memory
   ManuscriptRecord, and returns the response payload both routes send.

   The caller is responsible for everything BEFORE this point: locating the
   book, getting the manuscript bytes onto disk (or confirming they're there),
   updating state.manuscriptFile if the file changed, and parsing. */
async function applyReparse(
  bookDir: string,
  state: BookStateJson,
  parsed: Awaited<ReturnType<typeof parseManuscript>>,
  opts: { changeLogType: string; changeLogTitle: string },
) {
  const existingEdits = await readJson<{ sentences?: unknown[] }>(
    manuscriptEditsJsonPath(bookDir),
  );
  const preservedEditCount = Array.isArray(existingEdits?.sentences)
    ? existingEdits!.sentences!.length
    : 0;

  const prevExcludedIds = new Set<number>(
    state.chapters.filter((c) => c.excluded).map((c) => c.id),
  );
  const prevExcludedSlugs = new Set<string>(
    state.chapters.filter((c) => c.excluded).map((c) => c.slug),
  );
  const newChapters: BookStateJson['chapters'] = parsed.chapters.map((c) => {
    const newSlug = `${String(c.id).padStart(2, '0')}-${slug(c.title)}`;
    const carryover = prevExcludedIds.has(c.id) || prevExcludedSlugs.has(newSlug);
    return {
      id: c.id,
      title: c.title,
      slug: newSlug,
      duration: '00:00',
      excluded: carryover ? true : undefined,
    };
  });

  const nextState: BookStateJson = {
    ...state,
    chapters: newChapters,
    chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
    castConfirmed: false,
    updatedAt: new Date().toISOString(),
  };
  await writeStateJsonAtomic(stateJsonPath(bookDir), nextState);

  const carryoverPath = castReuseCarryoverJsonPath(bookDir);
  const existingCast = await readJson<{
    characters?: Array<{ id?: string; name?: string } & Record<string, unknown>>;
  }>(castJsonPath(bookDir));
  const reuseRows = (existingCast?.characters ?? [])
    .filter((c) => typeof c.id === 'string')
    .map((c) => {
      const row: Record<string, unknown> = { id: c.id, name: c.name };
      if (c.aliases !== undefined) row.aliases = c.aliases;
      for (const key of PRESERVED_VOICE_FIELDS) {
        if (c[key] !== undefined) row[key] = c[key];
      }
      return row;
    });
  if (reuseRows.length) {
    await writeJsonAtomic(carryoverPath, { characters: reuseRows });
  } else if (existsSync(carryoverPath)) {
    await rm(carryoverPath, { force: true });
  }

  const ad = audioDir(bookDir);
  await Promise.all([
    clearAnalysisCache(state.manuscriptId),
    existsSync(castJsonPath(bookDir))
      ? rm(castJsonPath(bookDir), { force: true })
      : Promise.resolve(),
    existsSync(revisionsJsonPath(bookDir))
      ? rm(revisionsJsonPath(bookDir), { force: true })
      : Promise.resolve(),
    existsSync(ad) ? rm(ad, { recursive: true, force: true }) : Promise.resolve(),
  ]);

  if (preservedEditCount > 0) {
    const logPath = changeLogJsonPath(bookDir);
    const existingLog = await readJson<{ events?: Array<{ id?: number }> }>(logPath);
    const prior = Array.isArray(existingLog?.events) ? existingLog!.events! : [];
    const nextId = prior.reduce((m, e) => Math.max(m, e?.id ?? 0), 0) + 1;
    const noun = preservedEditCount === 1 ? 'edit' : 'edits';
    const newEntry = {
      id: nextId,
      at: new Date().toISOString(),
      ts: 'Just now',
      date: 'today',
      type: opts.changeLogType,
      title: opts.changeLogTitle,
      note: `Preserved ${preservedEditCount} manuscript ${noun}; ids will be reconciled against the next analysis run.`,
      actor: 'system',
    };
    await writeJsonAtomic(logPath, { events: [newEntry, ...prior] });
  }

  const newExcludedById = new Map<number, boolean>();
  for (const c of newChapters) {
    if (c.excluded) newExcludedById.set(c.id, true);
  }
  const sourceText = parsed.sourceText;
  const record: ManuscriptRecord = {
    manuscriptId: state.manuscriptId,
    format: parsed.format,
    title: state.title,
    wordCount: sourceText.trim().split(/\s+/).filter(Boolean).length,
    byteSize: Buffer.byteLength(sourceText, 'utf8'),
    uploadedAt: state.createdAt,
    sourceText,
    chapterHints: parsed.chapters.map((c) => ({
      ...c,
      excluded: newExcludedById.get(c.id) || undefined,
    })),
    bookId: state.bookId,
    bookDir,
  };
  putManuscript(record);

  const wordCountByChapterId = new Map<number, number>();
  for (const c of parsed.chapters) {
    const body = (c.body ?? '').trim();
    wordCountByChapterId.set(c.id, body ? body.split(/\s+/).filter(Boolean).length : 0);
  }

  return {
    state: nextState,
    chapterCount: newChapters.length,
    chapterTitles: newChapters.map((c) => c.title),
    chapters: newChapters.map((c) => ({
      id: c.id,
      title: c.title,
      slug: c.slug,
      wordCount: wordCountByChapterId.get(c.id) ?? 0,
      excluded: !!c.excluded,
    })),
  };
}
```

- [ ] **Step 3: Replace the body of the `reparse` route to call `applyReparse()`**

In `bookStateRouter.post('/:bookId/reparse', …)`, keep the locate + manuscript-exists check + buffer read + legacy-text detection + `parseManuscript` call exactly as-is (lines ~742–804). Then **delete** everything from the `prevExcludedIds` declaration (~819) through the `res.json({ … })` block (~972) and replace it with:

```ts
    const payload = await applyReparse(bookDir, state, parsed, {
      changeLogType: 'reparse',
      changeLogTitle: 'Re-parsed manuscript',
    });
    res.json(payload);
```

Leave the surrounding `try { … } catch (e) { … }` intact. The now-unused local `preservedEditCount` block at ~754–763 should also be removed (it moved into `applyReparse`).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no unused-import / type errors).

- [ ] **Step 5: Run the reparse suite to confirm behavior is unchanged**

Run: `cd server && npx vitest run src/routes/book-state.reparse.test.ts`
Expected: PASS (identical to the Step 1 baseline).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/book-state.ts
git commit -m "refactor(server): extract applyReparse core from reparse route"
```

---

## Task 2: `POST /api/books/:bookId/replace-manuscript` endpoint

**Files:**
- Modify: `server/src/routes/book-state.ts` (add the route; add `multer` + `writeFile`/`unlink` imports if absent)
- Test: `server/src/routes/book-state.replace-manuscript.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/book-state.replace-manuscript.test.ts`. It mirrors the reparse test's tempdir + supertest setup, seeds a book with a designed-voice `cast.json`, then POSTs a new manuscript and asserts (a) chapters change, (b) cast carryover is written, (c) the old manuscript file is removed when the extension changes, (d) `castConfirmed` is reset.

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Replace Test';
const SERIES = 'Standalones';
const TITLE = 'Replace Book';
const MANUSCRIPT_ID = 'm_replace_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const ORIGINAL_BODY = `# Chapter One\n\nOne.\nTwo.\n`;
const REPLACEMENT_BODY = `# Fresh Chapter A\n\nAlpha.\n\n# Fresh Chapter B\n\nBeta.\nGamma.\n`;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-replace-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  // Start each case from a book whose on-disk manuscript is markdown.
  writeFileSync(join(bookDir, 'manuscript.md'), ORIGINAL_BODY);
  if (existsSync(join(bookDir, 'manuscript.epub'))) rmSync(join(bookDir, 'manuscript.epub'), { force: true });
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
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  // A designed-voice cast.json whose carryover we expect to survive.
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        {
          id: 'wren',
          name: 'Wren',
          voiceState: 'tuned',
          overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        },
      ],
    }),
  );
  for (const f of ['change-log.json', 'cast-reuse-carryover.json', 'revisions.json']) {
    const p = join(bookDir, '.audiobook', f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
});

describe('replace-manuscript handler', () => {
  it('replaces chapters from the uploaded file and resets castConfirmed', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
    expect(res.status).toBe(200);
    expect(res.body.chapterCount).toBe(2);
    expect(res.body.chapterTitles).toEqual(['Fresh Chapter A', 'Fresh Chapter B']);

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.castConfirmed).toBe(false);
    expect(state.chapters).toHaveLength(2);
  });

  it('snapshots the designed-voice carryover before clearing cast.json', async () => {
    await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');

    const carryoverPath = join(bookDir, '.audiobook', 'cast-reuse-carryover.json');
    expect(existsSync(carryoverPath)).toBe(true);
    const carryover = JSON.parse(readFileSync(carryoverPath, 'utf8'));
    expect(carryover.characters[0]).toMatchObject({
      id: 'wren',
      overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
    });
    // cast.json itself is cleared for a fresh chapter-keyed run.
    expect(existsSync(join(bookDir, '.audiobook', 'cast.json'))).toBe(false);
  });

  it('swaps the on-disk file and updates manuscriptFile when the extension changes', async () => {
    await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.txt');

    // .md replaced by .txt — old file gone, new file present, state points at it.
    expect(existsSync(join(bookDir, 'manuscript.md'))).toBe(false);
    expect(existsSync(join(bookDir, 'manuscript.txt'))).toBe(true);
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.manuscriptFile).toBe('manuscript.txt');
  });

  it('404s for an unknown book', async () => {
    const res = await request(app)
      .post(`/api/books/does-not-exist/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
    expect(res.status).toBe(404);
  });

  it('400s when no file is attached', async () => {
    const res = await request(app).post(`/api/books/${bookId}/replace-manuscript`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/book-state.replace-manuscript.test.ts`
Expected: FAIL (route returns 404 for every case — endpoint not defined yet).

- [ ] **Step 3: Ensure the needed imports exist at the top of `book-state.ts`**

Add any missing imports near the existing node:fs imports. `multer` is a dependency (used by `import.ts`). `writeFile`/`unlink` come from `node:fs/promises`; `readFile`/`rm`/`existsSync` are already imported in this file — verify and only add what's missing:

```ts
import multer from 'multer';
import { writeFile, unlink } from 'node:fs/promises';
```

Define the multer instance once near the top of the module (after imports), mirroring `import.ts`:

```ts
const manuscriptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
```

- [ ] **Step 4: Add the route**

Insert directly after the `reparse` route's closing `});` (~977):

```ts
/* POST /api/books/:bookId/replace-manuscript — upload a revised manuscript
   onto an EXISTING book. Writes the new file into the book dir (swapping the
   extension and deleting the old file if the format changed), then runs the
   same applyReparse() core as reparse: chapters are re-detected, the srv-13
   reuse/voice carryover is snapshotted so designed voices resurrect for
   characters that still match on the next analysis, and analysis cache / cast
   / audio are cleared. Book identity (bookId, dir, title/author/series, cover)
   is untouched — this is NOT a re-import. */
bookStateRouter.post(
  '/:bookId/replace-manuscript',
  manuscriptUpload.single('file'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No manuscript file uploaded.' });

      const located = await findBookByBookId(req.params.bookId);
      if (!located) return res.status(404).json({ error: 'Book not found.' });
      const { bookDir, state } = located;

      // Parse the uploaded bytes through the shared dispatcher (same as /import).
      const parsed = await parseManuscript({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
      });

      // Decide the on-disk filename from the parsed format, mirroring the
      // import route's EXT_BY_FORMAT. Keep the canonical "manuscript.<ext>"
      // name so the rest of the pipeline is unaffected.
      const EXT_BY_FORMAT: Record<typeof parsed.format, string> = {
        markdown: 'md',
        plaintext: 'txt',
        epub: 'epub',
        pdf: 'pdf',
        mobi: 'mobi',
      };
      const newFile = `manuscript.${EXT_BY_FORMAT[parsed.format]}`;
      const oldFile = state.manuscriptFile;

      // Write the new file, then remove the old one if the name changed.
      await writeFile(join(bookDir, newFile), req.file.buffer);
      if (oldFile && oldFile !== newFile && existsSync(join(bookDir, oldFile))) {
        await unlink(join(bookDir, oldFile)).catch(() => {});
      }
      state.manuscriptFile = newFile;

      const payload = await applyReparse(bookDir, state, parsed, {
        changeLogType: 'replace-manuscript',
        changeLogTitle: 'Replaced manuscript',
      });
      res.json(payload);
    } catch (e) {
      console.error('[book-state] replace-manuscript failed', e);
      res
        .status(500)
        .json({ error: (e as Error).message || 'Failed to replace manuscript.' });
    }
  },
);
```

Note: `parseManuscript`, `findBookByBookId`, `join`, `existsSync` are already imported in this file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/book-state.replace-manuscript.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Re-run the reparse suite (shared core unchanged for it)**

Run: `cd server && npx vitest run src/routes/book-state.reparse.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/book-state.ts server/src/routes/book-state.replace-manuscript.test.ts
git commit -m "feat(server): add POST /books/:id/replace-manuscript endpoint"
```

---

## Task 3: API client `replaceManuscript`

**Files:**
- Modify: `src/lib/api.ts` (add response type, real + mock impls, register in both `real`/`mock` objects)

- [ ] **Step 1: Add the response type + real impl near `realReparseBook` (~2937–2966)**

`replace-manuscript` returns the same payload shape as reparse, so reuse `ReparseBookResponse`. Add after `realReparseBook`:

```ts
async function realReplaceManuscript(
  bookId: string,
  file: File,
): Promise<ReparseBookResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/replace-manuscript`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `Replace manuscript failed (${res.status}).`);
  }
  return res.json();
}
```

- [ ] **Step 2: Add the mock impl near `mockReparseBook` (~2985)**

```ts
async function mockReplaceManuscript(
  _bookId: string,
  _file: File,
): Promise<ReparseBookResponse> {
  await wait(120);
  return { state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] };
}
```

- [ ] **Step 3: Register in both exported objects**

In the `real` object add `replaceManuscript: realReplaceManuscript,` immediately after the `reparseBook: realReparseBook,` line (~5801). In the `mock` object add `replaceManuscript: mockReplaceManuscript,` after `reparseBook: mockReparseBook,` (~6046).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): add api.replaceManuscript client"
```

---

## Task 4: Frontend menu + confirm + handler wiring

**Files:**
- Modify: `src/routes/index.tsx` (add `onReplaceManuscript` handler + pass to `BookLibraryView`)
- Modify: `src/views/book-library.tsx` (thread prop to grid + table)
- Modify: `src/components/library/library-grid.tsx` (menu item + file input + confirm)
- Modify: `src/components/library/library-table.tsx` (menu item + file input + confirm)
- Test: `src/components/library/library-table.test.tsx` (menu → file pick → confirm calls handler)

- [ ] **Step 1: Write the failing test**

Add to `src/components/library/library-table.test.tsx` a case asserting the new menu item triggers the file input and, after a file is chosen + confirmed, calls `onReplaceManuscript` with the book and the file. (Use whichever render harness the existing table tests use — replicate their `renderTable`/props builder.)

```tsx
it('Replace manuscript… → pick file → confirm calls onReplaceManuscript', async () => {
  const onReplaceManuscript = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderTable({ onReplaceManuscript }); // extend the harness to forward this prop

  await user.click(screen.getByLabelText(/book options/i)); // row menu trigger
  await user.click(screen.getByText('Replace manuscript…'));

  const file = new File(['# New\n\nHi.'], 'revised.md', { type: 'text/markdown' });
  const input = screen.getByTestId('replace-manuscript-input') as HTMLInputElement;
  await user.upload(input, file);

  // Destructive confirm dialog appears; confirm it.
  await user.click(screen.getByRole('button', { name: /replace manuscript/i }));

  expect(onReplaceManuscript).toHaveBeenCalledTimes(1);
  expect(onReplaceManuscript.mock.calls[0][0]).toMatchObject({ title: expect.any(String) });
  expect(onReplaceManuscript.mock.calls[0][1]).toBe(file);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/library/library-table.test.tsx -t "Replace manuscript"`
Expected: FAIL (no "Replace manuscript…" item / no handler).

- [ ] **Step 3: Add the handler in `src/routes/index.tsx`**

Right after the `onReparseBook={async (b) => { … }}` prop on `<BookLibraryView>` (closes ~end of that handler), add:

```tsx
      onReplaceManuscript={async (b, file) => {
        let result;
        try {
          result = await api.replaceManuscript(b.bookId, file);
        } catch (err) {
          showError(`Couldn't replace "${b.title}"`, (err as Error).message, 'Replace');
          return;
        }
        /* Same post-reparse redux reset the reparse handler runs — the server
           wiped cast.json + revisions + audio + cache, so clear the slices a
           stale open-book view might still hold. */
        dispatch(castActions.setCharacters([]));
        dispatch(manuscriptActions.reset());
        if (bookId === b.bookId) dispatch(uiActions.goHome());
        const res = await api.getLibrary().catch(() => null);
        if (res) dispatch(libraryActions.hydrate(res));
        showInfo({
          eyebrow: 'Replace',
          title: 'Manuscript replaced',
          body: (
            <p>
              Re-detected {result.chapterCount} chapter
              {result.chapterCount === 1 ? '' : 's'}. Designed voices were preserved where
              characters still match — confirm the cast again before generating.
            </p>
          ),
          primaryLabel: 'Open book',
          onPrimary: () => {
            const updated = (res?.authors ?? [])
              .flatMap((a) => a.series.flatMap((s) => s.books))
              .find((x) => x.bookId === b.bookId);
            if (updated) onOpenBook(updated);
          },
        });
      }}
```

(`castActions`, `manuscriptActions`, `uiActions`, `libraryActions`, `showError`, `showInfo`, `onOpenBook`/the open helper, `dispatch`, `bookId` are all already in scope in this component — they're used by the adjacent reparse handler.)

- [ ] **Step 4: Thread the prop through `src/views/book-library.tsx`**

Add `onReplaceManuscript: (book: LibraryBook, file: File) => void | Promise<void>;` to the view's `Props` interface (beside `onReparseBook`), destructure it, and pass `onReplaceManuscript={onReplaceManuscript}` to **both** the `<LibraryGrid …>` (~298) and `<LibraryTable …>` (~322) usages.

- [ ] **Step 5: Add the menu item + file input + confirm to `library-grid.tsx`**

In `Props` add `onReplaceManuscript: (book: LibraryBook, file: File) => void | Promise<void>;`; destructure it; pass `onReplace={(file) => onReplaceManuscript(b, file)}` to each `<BookCard>` (beside `onReparse`). In `BookCard`'s props add `onReplace: (file: File) => void;`. Add state + a ref near the other `useState`s (~146):

```tsx
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [pendingReplaceFile, setPendingReplaceFile] = useState<File | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
```

Add the menu item directly after the "Re-parse manuscript" button (~268):

```tsx
              <button
                onClick={() => {
                  setMenuOpen(false);
                  replaceInputRef.current?.click();
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/4 inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconRefresh className="w-4 h-4" /> Replace manuscript…
              </button>
```

Add the hidden input + confirm dialog inside the scoped `<div onClick={(e) => e.stopPropagation()}>` block (next to the reparse `ConfirmDialog`, ~412):

```tsx
        <input
          ref={replaceInputRef}
          data-testid="replace-manuscript-input"
          type="file"
          accept=".txt,.md,.epub,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            e.target.value = ''; // allow re-picking the same file later
            if (f) {
              setPendingReplaceFile(f);
              setConfirmReplace(true);
            }
          }}
        />
        <ConfirmDialog
          open={confirmReplace}
          eyebrow="Replace"
          title={book.title}
          icon={<IconRefresh className="w-4 h-4" />}
          body={
            <div className="space-y-2">
              <p>This replaces the manuscript file and re-detects chapters from the new file.</p>
              <p className="text-ink/60">
                Cached analysis and any generated audio are discarded. Designed voices are
                preserved where characters still match — you'll confirm the cast again before
                generating.
              </p>
            </div>
          }
          confirmLabel="Replace manuscript"
          onConfirm={() => {
            setConfirmReplace(false);
            const f = pendingReplaceFile;
            setPendingReplaceFile(null);
            if (f) onReplace(f);
          }}
          onClose={() => {
            setConfirmReplace(false);
            setPendingReplaceFile(null);
          }}
        />
```

- [ ] **Step 6: Add the same menu item + input + confirm to `library-table.tsx`**

Mirror Step 5 in the table-row component (it already has the reparse menu item ~380 and reparse `ConfirmDialog` ~423, plus an `onReparse` prop ~228/237). Add the `onReplace` prop, the three state/ref hooks, the "Replace manuscript…" button after the reparse button, and the hidden `<input data-testid="replace-manuscript-input" …>` + the `confirmReplace` `ConfirmDialog` next to the existing one. Thread `onReplaceManuscript`/`onReplace` through the table's `Props` and the row mapping (~206), exactly parallel to `onReparseBook`/`onReparse`.

- [ ] **Step 7: Run the new test to verify it passes**

Run: `npx vitest run src/components/library/library-table.test.tsx -t "Replace manuscript"`
Expected: PASS.

- [ ] **Step 8: Run the full frontend library test files + typecheck**

Run: `npx vitest run src/components/library src/views/book-library.test.tsx src/routes/index.test.tsx && npm run typecheck`
Expected: PASS (existing reparse/menu tests still green — the new item is additive).

- [ ] **Step 9: Commit**

```bash
git add src/routes/index.tsx src/views/book-library.tsx src/components/library/
git commit -m "feat(frontend): Replace manuscript… menu item + confirm wiring"
```

---

## Task 5: E2E golden path

**Files:**
- Create: `e2e/replace-manuscript.spec.ts` (chromium; mock mode)

- [ ] **Step 1: Write the spec**

Drive the book menu → "Replace manuscript…" → set the hidden input → confirm → assert the "Manuscript replaced" info dialog. In mock mode `api.replaceManuscript` resolves to an empty payload (chapterCount 0), so assert on the dialog text/title rather than chapter content. Use Playwright's `setInputFiles` against `[data-testid="replace-manuscript-input"]`. Follow the existing `e2e/responsive/coverage.spec.ts` patterns for app bootstrap + opening the library + the per-card menu.

```ts
import { test, expect } from '@playwright/test';

test('replace manuscript: menu → pick file → confirm shows replaced dialog', async ({ page }) => {
  await page.goto('/');
  // Open the first book card's options menu (selector per existing menu tests).
  await page.getByRole('button', { name: /book options/i }).first().click();
  await page.getByText('Replace manuscript…').click();
  await page
    .getByTestId('replace-manuscript-input')
    .setInputFiles({ name: 'revised.md', mimeType: 'text/markdown', buffer: Buffer.from('# New\n\nHi.') });
  await page.getByRole('button', { name: /replace manuscript/i }).click();
  await expect(page.getByText(/Manuscript replaced/i)).toBeVisible();
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- replace-manuscript`
Expected: PASS. (If chromium isn't installed: `npx playwright install chromium` once.)

- [ ] **Step 3: Commit**

```bash
git add e2e/replace-manuscript.spec.ts
git commit -m "test(e2e): replace-manuscript golden path"
```

---

## Task 6: Docs + backlog hygiene

**Files:**
- Create: `docs/features/<n>-replace-manuscript.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md` (new entry under its area)
- Modify: `docs/BACKLOG.md` (thin row) — and file a Backlog-item GitHub issue (area:fs) for the feature
- Modify: `docs/superpowers/specs/2026-06-11-fs22-bundled-demo-book-design.md` (note Wave 1 shipped)

- [ ] **Step 1: Write the regression plan**

Copy `docs/features/TEMPLATE.md` to `docs/features/<n>-replace-manuscript.md` (pick the next free number). Fill: invariants (book identity unchanged; designed voices resurrected via carryover for matching characters; old file removed on extension change; `castConfirmed` reset; cache/cast/audio cleared) and the manual acceptance walkthrough (replace the Coalfall manuscript → 5 voices preserved). Cite the spec.

- [ ] **Step 2: Update INDEX + BACKLOG**

Add the INDEX entry under the full-stack/server area. Add a thin `docs/BACKLOG.md` row linking the new issue. File the GitHub issue with `gh issue create` (labels `area:fs`, `type:feature`, an appropriate `moscow:`), title `<prefix>-<n> — Replace manuscript on an existing book`.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs(docs): replace-manuscript regression plan + backlog row"
```

---

## Task 7: Full verify + ship gate

- [ ] **Step 1: Run the full battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build). Triage any failure as related vs pre-existing per CLAUDE.md before touching anything.

- [ ] **Step 2: Open the PR (draft) and surface the branch**

```bash
git push -u origin feat/fs-replace-manuscript
gh pr create --draft --title "feat(server,frontend): Replace manuscript on an existing book" \
  --body-file <(printf '## Summary\nReusable Replace-manuscript feature: upload a new manuscript onto an existing book, re-detect chapters, preserve designed voices via the srv-13 carryover. Wave 1 of fs-22 (#475).\n\n## Test plan\nServer + frontend unit + e2e; npm run verify green.\n\nRefs #475\n')
```

- [ ] **Step 3: Gate before Wave 2**

Once reviewed: `gh pr ready` → merge to `main` → `git switch main && git pull && npm run build`. The local prod build is the explicit gate before producing demo content (Wave 2). Surface the branch name + commit SHAs in the end-of-turn summary.

---

## Self-Review (completed during authoring)

- **Spec coverage:** Part A of the spec (endpoint, shared-core extraction, book-card menu, server + e2e tests) maps to Tasks 1–6. Part B (bundling) is explicitly deferred to a post-Wave-2 plan, as the spec's delivery sequence requires.
- **Type consistency:** `applyReparse(bookDir, state, parsed, opts)` is defined in Task 1 and called identically in Tasks 1 (reparse) and 2 (replace). `replaceManuscript(bookId, file)` returns `ReparseBookResponse` in Task 3 and is consumed with `.chapterCount` in Task 4. `onReplaceManuscript(book, file)` / `onReplace(file)` props are consistent across Tasks 4's files. `data-testid="replace-manuscript-input"` matches between Task 4 (grid/table), Task 4's unit test, and Task 5's e2e.
- **Placeholders:** none — every code step shows complete code; the only `<n>` placeholders are doc filenames/issue numbers chosen at authoring time in Task 6.
