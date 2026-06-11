# fs-22 Bundling (Wave 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the infrastructure to bundle **The Coalfall Commission** as a committed sample and load it into a fresh user's workspace from a "Try the sample" affordance — manuscript + designed cast (Qwen + a scripted Kokoro fallback) + the ~13 voice files, no audio.

**Architecture:** A re-runnable capture script freezes the live workspace book into a committed `samples/` tree (stripping audio + the machine-keyed analysis cache, stamping a Kokoro fallback preset onto every character, pulling the referenced Qwen voice files). A new `samples` router exposes `POST /api/samples/the-coalfall-commission/load` that copies that tree into the workspace (fresh `manuscriptId`, voices merged no-clobber, `ManuscriptRecord` registered) — mirroring the `/api/books` route. A "Try the sample" button on the library empty state + upload view calls it and opens the loaded book.

**Tech Stack:** Node ESM script, Express + Vitest (server), React + RTK + Vitest/RTL (frontend), Playwright (e2e).

**Scope note:** Wave 3 of the fs-22 spec (`docs/superpowers/specs/2026-06-11-fs22-bundled-demo-book-design.md`). This builds + tests the bundling **infrastructure**, which does NOT need finished content. The actual **freeze** (running the capture script and committing `samples/`) is the LAST step and is gated on Wave 2 being complete: all 13 characters Qwen-designed (7 still owed — `Tam Hollis, Widow Casper, Brann Weir, Berrin Weir, Father Lessom, Ivo, Hart`). Until then the capture script runs but produces an incomplete bundle that MUST NOT be committed.

This touches `scripts`, `server`, `frontend` — they ship as one branch `feat/fs-bundled-demo-book` (sequential: frontend calls the new endpoint).

---

## File Structure

**Capture (scripts):**
- Create `scripts/capture-sample-book.mjs` — freeze a workspace book → `samples/<slug>/`. Re-runnable; prints a manifest.
- Create `scripts/lib/kokoro-fallback.mjs` — pure `pickKokoroPreset({ gender, ageRange, id })` → a preset name (testable, mirrors `KOKORO_PROFILE_VOICES`).
- Create `scripts/tests/kokoro-fallback.test.mjs` — node:test for the preset mapping.

**Server:**
- Create `server/src/routes/samples.ts` — `GET /api/samples` (list) + `POST /api/samples/:slug/load`.
- Create `server/src/routes/samples.test.ts` — load copies tree, merges voices no-clobber, idempotent, registers manuscript.
- Modify `server/src/index.ts` — mount `samplesRouter` at `/api/samples`.

**Frontend:**
- Modify `src/lib/api.ts` — `listSamples()` + `loadSample(slug)`.
- Modify `src/components/library/library-empty-states.tsx` — "Try the sample" secondary button on `EmptyLibrary`.
- Modify `src/views/upload.tsx` — "Try the sample" affordance.
- Modify `src/views/book-library.tsx` + `src/routes/index.tsx` — thread an `onTrySample` handler that calls `api.loadSample` then opens the book.
- Modify the relevant test files.

**E2E:**
- Create `e2e/try-sample.spec.ts`.

**Bundle (committed, produced by the capture script):**
- `samples/the-coalfall-commission/manuscript.md`
- `samples/the-coalfall-commission/.audiobook/{state.json, cast.json, manuscript-edits.json}`
- `samples/the-coalfall-commission/voices/qwen/qwen-*.{pt,json}`
- `samples/the-coalfall-commission/README.md` (licensing: original Castwright work)

---

## Task 1: Kokoro fallback preset mapping (pure, tested)

**Files:**
- Create: `scripts/lib/kokoro-fallback.mjs`
- Test: `scripts/tests/kokoro-fallback.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/tests/kokoro-fallback.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickKokoroPreset, KOKORO_BUCKETS } from '../lib/kokoro-fallback.mjs';

test('maps a child female to a light female preset', () => {
  const p = pickKokoroPreset({ gender: 'female', ageRange: 'child', id: 'sela' });
  assert.ok(KOKORO_BUCKETS['female-light'].includes(p), `${p} not in female-light`);
});

test('maps an elderly neutral (dragon) to a deep male preset, deterministically', () => {
  const a = pickKokoroPreset({ gender: 'neutral', ageRange: 'elderly', id: 'coalfall-dragon' });
  const b = pickKokoroPreset({ gender: 'neutral', ageRange: 'elderly', id: 'coalfall-dragon' });
  assert.equal(a, b);
  assert.ok(KOKORO_BUCKETS['male-deep'].includes(a), `${a} not in male-deep`);
});

test('distinct ids in the same bucket can land on different presets (twin separation)', () => {
  const brann = pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'brann-weir' });
  const berrin = pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'berrin-weir' });
  // Not guaranteed distinct, but must be stable per id.
  assert.equal(brann, pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'brann-weir' }));
  assert.equal(berrin, pickKokoroPreset({ gender: 'male', ageRange: 'adult', id: 'berrin-weir' }));
});
```

- [ ] **Step 2: Run it (expect FAIL — module missing)**

Run: `node --test scripts/tests/kokoro-fallback.test.mjs`
Expected: FAIL (Cannot find module '../lib/kokoro-fallback.mjs').

- [ ] **Step 3: Implement**

```js
// scripts/lib/kokoro-fallback.mjs
/* Deterministic Kokoro preset per character — the bundle's fallback cast so the
   demo generates on a box without Qwen. Mirrors the female/male × deep/mid/light
   buckets of server/src/tts/voice-mapping.ts KOKORO_PROFILE_VOICES; keep in sync
   if that catalog changes. */
export const KOKORO_BUCKETS = {
  'male-deep': ['am_onyx', 'bm_george'],
  'male-mid': ['am_michael', 'am_adam'],
  'male-light': ['am_eric', 'am_liam'],
  'female-deep': ['af_sarah', 'bf_emma'],
  'female-mid': ['af_bella', 'af_jessica'],
  'female-light': ['af_nicole', 'af_aoede'],
};

function stableHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* gender: 'male'|'female'|'neutral'; ageRange: 'child'|'teen'|'adult'|'elderly'.
   Non-human / neutral falls back to a deep male register (best-effort; Kokoro
   has no non-human voice). child/teen → light, elderly → deep, else mid. */
export function pickKokoroPreset({ gender, ageRange, id }) {
  const g = gender === 'female' ? 'female' : 'male';
  const register =
    ageRange === 'child' || ageRange === 'teen'
      ? 'light'
      : ageRange === 'elderly'
        ? 'deep'
        : 'mid';
  const bucket = KOKORO_BUCKETS[`${g}-${register}`];
  return bucket[stableHash(id) % bucket.length];
}
```

- [ ] **Step 4: Run it (expect PASS)**

Run: `node --test scripts/tests/kokoro-fallback.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/kokoro-fallback.mjs scripts/tests/kokoro-fallback.test.mjs
git commit -m "feat(scripts): deterministic Kokoro fallback preset mapping"
```

---

## Task 2: Capture script

**Files:**
- Create: `scripts/capture-sample-book.mjs`

This script has no automated test (it's a dev tool that reads the live workspace); it's exercised manually + by the loader test consuming a fixture. Keep it small and obvious.

- [ ] **Step 1: Implement the capture script**

```js
// scripts/capture-sample-book.mjs
/* Freeze a confirmed workspace book into a committed samples/ tree for fs-22.
   Usage: node scripts/capture-sample-book.mjs "<bookDir>" <slug>
   Copies: manuscript.<ext> + .audiobook/{state.json,cast.json,manuscript-edits.json}
           + the qwen voice files referenced by cast.json, stamps a Kokoro
           fallback preset onto every character, and STRIPS audio + the analysis
           cache (rebuilds from manuscript-edits.json on first generate) +
           machine-specific paths. Re-runnable. Prints a manifest. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pickKokoroPreset } from './lib/kokoro-fallback.mjs';

const [, , bookDir, slug] = process.argv;
if (!bookDir || !slug) {
  console.error('Usage: node scripts/capture-sample-book.mjs "<bookDir>" <slug>');
  process.exit(1);
}
const repoRoot = dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const out = join(repoRoot, 'samples', slug);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, '.audiobook'), { recursive: true });
mkdirSync(join(out, 'voices', 'qwen'), { recursive: true });

// 1. Manuscript file (whatever state.json points at).
const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
copyFileSync(join(bookDir, state.manuscriptFile), join(out, state.manuscriptFile));

// 2. state.json — strip cover bytes ref + keep identity/chapters. Drop audio fields.
const cleanState = { ...state, castConfirmed: true };
delete cleanState.coverImage;
writeFileSync(join(out, '.audiobook', 'state.json'), JSON.stringify(cleanState, null, 2));

// 3. manuscript-edits.json (attribution) — verbatim.
const editsSrc = join(bookDir, '.audiobook', 'manuscript-edits.json');
if (existsSync(editsSrc)) copyFileSync(editsSrc, join(out, '.audiobook', 'manuscript-edits.json'));

// 4. cast.json — stamp a Kokoro fallback preset onto every character + pull voices.
const cast = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
const workspaceRoot = dirname(dirname(dirname(dirname(bookDir)))); // books/<A>/<S>/<T> -> workspace root
const qwenDir = join(workspaceRoot, 'voices', 'qwen');
const pulled = [];
for (const c of cast.characters) {
  c.overrideTtsVoices = c.overrideTtsVoices || {};
  c.overrideTtsVoices.kokoro = { name: pickKokoroPreset({ gender: c.gender, ageRange: c.ageRange, id: c.id }) };
  const qwenName = c.overrideTtsVoices.qwen?.name;
  if (qwenName) {
    for (const ext of ['pt', 'json']) {
      const f = `${qwenName}.${ext}`;
      if (existsSync(join(qwenDir, f))) {
        copyFileSync(join(qwenDir, f), join(out, 'voices', 'qwen', f));
        pulled.push(f);
      }
    }
    // Pull any emotion variants too.
    for (const v of Object.values(c.overrideTtsVoices.qwen?.variants || {})) {
      for (const ext of ['pt', 'json']) {
        const f = `${v.name}.${ext}`;
        if (existsSync(join(qwenDir, f))) {
          copyFileSync(join(qwenDir, f), join(out, 'voices', 'qwen', f));
          pulled.push(f);
        }
      }
    }
  }
}
writeFileSync(join(out, '.audiobook', 'cast.json'), JSON.stringify(cast, null, 2));

// 5. README licensing note.
writeFileSync(
  join(out, 'README.md'),
  '# The Coalfall Commission (bundled sample)\n\nAn original Castwright work, all rights reserved. Bundled as the fs-22 generate-able demo book. No audio is shipped — the demo runs the real pipeline locally.\n',
);

const designed = cast.characters.filter((c) => c.overrideTtsVoices?.qwen?.name).length;
console.log(`Captured ${slug}: ${cast.characters.length} characters (${designed} Qwen-designed), ${pulled.length} voice files pulled.`);
if (designed < cast.characters.length) {
  console.warn(`WARNING: ${cast.characters.length - designed} characters have NO Qwen voice — do NOT commit this bundle until every character is designed.`);
}
```

- [ ] **Step 2: Smoke-run against the live book (manual — produces an incomplete bundle today)**

Run: `node scripts/capture-sample-book.mjs "C:\AudiobookWorkspace\books\Castwright\Standalones\The Coalfall Commission" the-coalfall-commission`
Expected: prints the manifest + the WARNING (7 chars undesigned today). Inspect `samples/the-coalfall-commission/` shape. **Do not `git add samples/` yet** — the bundle is incomplete until Wave 2 finishes.

- [ ] **Step 3: Commit the script only (not the bundle)**

```bash
git add scripts/capture-sample-book.mjs
git commit -m "feat(scripts): capture-sample-book freezes a workspace book into samples/"
```

---

## Task 3: Loader endpoint + samples router

**Files:**
- Create: `server/src/routes/samples.ts`
- Modify: `server/src/index.ts` (mount router)
- Test: `server/src/routes/samples.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/routes/samples.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = resolve(__dirname, '..', '..', '..', 'samples');

let workspaceRoot: string;
let app: Express;
const SLUG = 'the-coalfall-commission';

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-samples-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { samplesRouter } = await import('./samples.js');
  app = express();
  app.use(express.json());
  app.use('/api/samples', samplesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

it('loads the bundled sample into the workspace with voices merged', async () => {
  // The committed sample must exist for this test to be meaningful; skip with a
  // clear message until the bundle is captured (Wave 2 gate).
  if (!existsSync(join(SAMPLES_ROOT, SLUG, '.audiobook', 'cast.json'))) {
    console.warn(`[samples.test] sample bundle ${SLUG} not captured yet — skipping load assertion.`);
    return;
  }
  const res = await request(app).post(`/api/samples/${SLUG}/load`);
  expect(res.status).toBe(200);
  expect(res.body.bookId).toBeTruthy();
  // Book dir written.
  const dir = join(workspaceRoot, 'books', 'Castwright', 'Standalones', 'The Coalfall Commission');
  expect(existsSync(join(dir, '.audiobook', 'cast.json'))).toBe(true);
  // Voices merged into workspace.
  const cast = JSON.parse(readFileSync(join(dir, '.audiobook', 'cast.json'), 'utf8'));
  const firstQwen = cast.characters.find((c: { overrideTtsVoices?: { qwen?: { name?: string } } }) => c.overrideTtsVoices?.qwen?.name);
  if (firstQwen) {
    expect(existsSync(join(workspaceRoot, 'voices', 'qwen', `${firstQwen.overrideTtsVoices.qwen.name}.pt`))).toBe(true);
  }
  // Fresh manuscriptId (not the bundle's).
  const state = JSON.parse(readFileSync(join(dir, '.audiobook', 'state.json'), 'utf8'));
  expect(state.manuscriptId).toMatch(/^mns_/);
});

it('is idempotent — a second load does not error and does not duplicate', async () => {
  if (!existsSync(join(SAMPLES_ROOT, SLUG, '.audiobook', 'cast.json'))) return;
  const a = await request(app).post(`/api/samples/${SLUG}/load`);
  const b = await request(app).post(`/api/samples/${SLUG}/load`);
  expect(a.status).toBe(200);
  expect([200, 409]).toContain(b.status); // already exists → no-op or explicit conflict
});

it('404s for an unknown sample slug', async () => {
  const res = await request(app).post(`/api/samples/not-a-real-sample/load`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run it (expect FAIL — router missing)**

Run: `cd server && npx vitest run src/routes/samples.test.ts`
Expected: FAIL (Cannot find module './samples.js'). (The 404 case fails because the route doesn't exist.)

- [ ] **Step 3: Implement the router**

```ts
// server/src/routes/samples.ts
/* fs-22 — load a committed sample book (samples/<slug>/) into the workspace.
   Copies the manuscript + .audiobook/{state,cast,manuscript-edits} into the
   workspace book dir, merges the bundle's qwen voice files into the shared
   voices/qwen/ (no-clobber), mints a fresh manuscriptId, and registers a
   ManuscriptRecord — mirroring POST /api/books. Idempotent: a re-load of an
   existing book is a no-op 200. No audio ships; the analysis cache rebuilds
   from manuscript-edits.json on the first generate. */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import {
  BOOKS_ROOT,
  WORKSPACE_ROOT,
  bookDirByDisplay,
  dotAudiobook,
  ensureWorkspace,
  makeBookId,
  stateJsonPath,
} from '../workspace/paths.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { putManuscript, type ManuscriptRecord } from '../store/manuscripts.js';
import { parseManuscript } from '../parsers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = resolve(__dirname, '..', '..', '..', 'samples');

export const samplesRouter = Router();

samplesRouter.get('/', async (_req: Request, res: Response) => {
  if (!existsSync(SAMPLES_ROOT)) return res.json({ samples: [] });
  const slugs = (await readdir(SAMPLES_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((s) => existsSync(join(SAMPLES_ROOT, s, '.audiobook', 'state.json')));
  const samples = [];
  for (const slug of slugs) {
    const st = JSON.parse(await readFile(join(SAMPLES_ROOT, slug, '.audiobook', 'state.json'), 'utf8'));
    samples.push({ slug, title: st.title, author: st.author });
  }
  res.json({ samples });
});

samplesRouter.post('/:slug/load', async (req: Request, res: Response) => {
  const slug = req.params.slug;
  const src = join(SAMPLES_ROOT, slug);
  if (!existsSync(join(src, '.audiobook', 'state.json'))) {
    return res.status(404).json({ error: `Sample not found: ${slug}` });
  }
  await ensureWorkspace();
  const bundleState = JSON.parse(await readFile(join(src, '.audiobook', 'state.json'), 'utf8'));
  const { author, series, title } = bundleState;
  const bookDir = bookDirByDisplay(author, series, title);
  const bookId = makeBookId(author, series, title);

  // Idempotent: already present → no-op.
  if (existsSync(stateJsonPath(bookDir))) {
    return res.json({ bookId, alreadyLoaded: true });
  }

  await mkdir(dotAudiobook(bookDir), { recursive: true });

  // 1. Manuscript.
  await copyFile(join(src, bundleState.manuscriptFile), join(bookDir, bundleState.manuscriptFile));

  // 2. .audiobook/{cast,manuscript-edits}.
  for (const f of ['cast.json', 'manuscript-edits.json']) {
    if (existsSync(join(src, '.audiobook', f))) {
      await copyFile(join(src, '.audiobook', f), join(dotAudiobook(bookDir), f));
    }
  }

  // 3. Fresh manuscriptId + state.json.
  const manuscriptId = `mns_${nanoid(10)}`;
  const state = { ...bundleState, bookId, manuscriptId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeStateJsonAtomic(stateJsonPath(bookDir), state);

  // 4. Merge bundle voices into workspace voices/qwen (no clobber).
  const srcVoices = join(src, 'voices', 'qwen');
  if (existsSync(srcVoices)) {
    const dstVoices = join(WORKSPACE_ROOT, 'voices', 'qwen');
    await mkdir(dstVoices, { recursive: true });
    for (const f of await readdir(srcVoices)) {
      if (!existsSync(join(dstVoices, f))) await copyFile(join(srcVoices, f), join(dstVoices, f));
    }
  }

  // 5. Register the ManuscriptRecord so the analysis/generation pipeline is wired.
  const buffer = await readFile(join(bookDir, bundleState.manuscriptFile));
  const parsed = await parseManuscript({ buffer, fileName: bundleState.manuscriptFile, sourcePath: join(bookDir, bundleState.manuscriptFile) });
  const record: ManuscriptRecord = {
    manuscriptId,
    format: parsed.format,
    title,
    wordCount: parsed.sourceText.trim().split(/\s+/).filter(Boolean).length,
    byteSize: Buffer.byteLength(parsed.sourceText, 'utf8'),
    uploadedAt: state.createdAt,
    sourceText: parsed.sourceText,
    chapterHints: parsed.chapters.map((c) => ({ ...c })),
    bookId,
    bookDir,
  };
  putManuscript(record);

  res.json({ bookId, manuscriptId, alreadyLoaded: false });
});
```

Note: verify `bookDirByDisplay`, `dotAudiobook`, `WORKSPACE_ROOT`, `ensureWorkspace`, `makeBookId`, `stateJsonPath` are the real exports of `workspace/paths.js` (the import route uses them). Adjust names to the actual exports if any differ.

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`, beside the other `app.use('/api/...')` lines:
```ts
import { samplesRouter } from './routes/samples.js';
// ...
app.use('/api/samples', samplesRouter); // fs-22 — load the bundled demo book
```

- [ ] **Step 5: Run the test (404 + skip cases pass now; load cases skip until the bundle exists)**

Run: `cd server && npx vitest run src/routes/samples.test.ts`
Expected: PASS (the 404 case asserts; the load/idempotent cases self-skip with a banner until `samples/` is captured).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add server/src/routes/samples.ts server/src/routes/samples.test.ts server/src/index.ts
git commit -m "feat(server): /api/samples load endpoint for the bundled demo book"
```

---

## Task 4: API client + "Try the sample" affordance

**Files:**
- Modify: `src/lib/api.ts`, `src/routes/index.tsx`, `src/views/book-library.tsx`, `src/components/library/library-empty-states.tsx`, `src/views/upload.tsx`
- Test: `src/components/library/library-empty-states.test.tsx` (or the nearest existing test)

- [ ] **Step 1: API client (real + mock)**

In `src/lib/api.ts`, near the other book RPCs, add real + mock impls and register in both objects (mirror `reparseBook`):
```ts
async function realLoadSample(slug: string): Promise<{ bookId: string }> {
  const res = await fetch(`/api/samples/${encodeURIComponent(slug)}/load`, { method: 'POST' });
  if (!res.ok) throw new Error(`Couldn't load the sample (${res.status}).`);
  return res.json();
}
async function mockLoadSample(_slug: string): Promise<{ bookId: string }> {
  await wait(150);
  return { bookId: 'castwright__standalones__the-coalfall-commission' };
}
```
Register `loadSample: realLoadSample,` / `loadSample: mockLoadSample,` in the `real` / `mock` objects.

- [ ] **Step 2: Handler in `src/routes/index.tsx`**

On `<BookLibraryView>`, add an `onTrySample` prop beside `onStartNew`:
```tsx
      onTrySample={async () => {
        let result;
        try {
          result = await api.loadSample('the-coalfall-commission');
        } catch (err) {
          showError("Couldn't load the sample", (err as Error).message, 'Sample');
          return;
        }
        const refreshed = await api.getLibrary().catch(() => null);
        if (refreshed) dispatch(libraryActions.hydrate(refreshed));
        const book = refreshed?.authors
          .flatMap((a) => a.series.flatMap((s) => s.books))
          .find((b) => b.bookId === result.bookId);
        if (book) {
          dispatch(uiActions.openBook({ id: book.bookId, status: book.status === 'complete' ? 'ready' : 'confirm', manuscriptId: book.manuscriptId }));
        }
      }}
```
(Verify `uiActions.openBook`'s accepted `status` values; for a freshly-loaded, cast-confirmed book the natural landing is the confirm/ready stage. Match the value the reparse/replace handlers use.)

- [ ] **Step 3: Thread the prop**

In `src/views/book-library.tsx`, add `onTrySample: () => void | Promise<void>;` to `Props`, destructure it, and pass it to the empty-state render path. In `src/components/library/library-empty-states.tsx`, add an `onTrySample` prop to `EmptyLibrary` and render a secondary button under the existing "Start a new book":
```tsx
        <button
          onClick={onTrySample}
          className="mt-3 text-sm font-medium text-ink/70 underline underline-offset-2 hover:text-ink"
        >
          or try a sample book
        </button>
```

- [ ] **Step 4: Upload-view affordance**

In `src/views/upload.tsx`, add a parallel "Try a sample" link/button wired to the same `onTrySample` (thread it the same way the upload view receives its other callbacks). Keep copy consistent ("or try a sample book").

- [ ] **Step 5: Test**

Add a test (in `library-empty-states.test.tsx` or the book-library test) asserting the empty state renders "try a sample book" and clicking it invokes `onTrySample`. Run: `npx vitest run src/components/library src/views/book-library.test.tsx`.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/lib/api.ts src/routes/index.tsx src/views/book-library.tsx src/components/library/library-empty-states.tsx src/views/upload.tsx src/components/library/library-empty-states.test.tsx
git commit -m "feat(frontend): 'Try the sample' affordance loads the bundled demo book"
```

---

## Task 5: E2E + docs

**Files:**
- Create: `e2e/try-sample.spec.ts`
- Create: `docs/features/<n>-fs22-bundled-demo-book.md` (regression plan); update `docs/features/INDEX.md` + close fs-22 (#475) when the bundle ships.

- [ ] **Step 1: E2E (mock mode)**

```ts
import { test, expect } from '@playwright/test';

test('try a sample loads the demo book', async ({ page }) => {
  await page.goto('/');
  // From an empty library (mock seed permitting) OR the upload view, click the sample affordance.
  const trySample = page.getByText(/try a sample book/i).first();
  if (await trySample.isVisible().catch(() => false)) {
    await trySample.click();
    // In mock mode loadSample resolves to the demo bookId; assert navigation/hydration occurred.
    await expect(page).toHaveURL(/confirm|ready|books/);
  }
});
```
Run: `npm run test:e2e -- try-sample`. Adjust the selector to the real affordance once Task 4 lands.

- [ ] **Step 2: Regression plan + INDEX**

Write `docs/features/<n>-fs22-bundled-demo-book.md` from `TEMPLATE.md` (key files, invariants: idempotent load, voices no-clobber, no audio shipped, licensing). Add the INDEX entry. Leave fs-22 (#475) open until the bundle is committed (Wave 2 gate).

- [ ] **Step 3: Commit**

```bash
git add e2e/try-sample.spec.ts docs/features/
git commit -m "test(e2e): try-sample golden path + fs-22 regression plan"
```

---

## Task 6: Verify + the freeze gate

- [ ] **Step 1: Full verify (infrastructure only; bundle not yet committed)**

Run: `npm run verify`
Expected: PASS. The samples load test self-skips until the bundle exists.

- [ ] **Step 2: THE FREEZE (gated on Wave 2 — do NOT do this until all 13 characters are Qwen-designed)**

Once the user has designed every character on the prod box:
1. `node scripts/capture-sample-book.mjs "C:\AudiobookWorkspace\books\Castwright\Standalones\The Coalfall Commission" the-coalfall-commission` — must print 0 undesigned (no WARNING).
2. Inspect `samples/the-coalfall-commission/` (manuscript + 3 .audiobook json + ~13 voice files + README, no audio).
3. `git add samples/ && git commit -m "feat(scripts): freeze The Coalfall Commission bundled sample"`.
4. Re-run `npm run verify` — the samples load test now ASSERTS (no longer skips).

- [ ] **Step 3: Wave 4 — release packaging**

Ensure `samples/` is included in the release zip (check the packaging script's include list) and document the Qwen requirement + Kokoro fallback in INSTALL/README. Close fs-22 (#475).

---

## Self-Review (completed during authoring)

- **Spec coverage:** capture (Task 2) + Kokoro fallback (Task 1) + loader (Task 3) + affordance (Task 4) + e2e/docs (Task 5) + freeze/release (Task 6) cover the spec's Part B. No audio in the bundle; cache rebuilds from manuscript-edits.json — both honored.
- **Type/name consistency:** `pickKokoroPreset` (Task 1) is consumed in Task 2. `loadSample(slug)` (Task 4) hits `POST /api/samples/:slug/load` (Task 3). `the-coalfall-commission` slug is consistent across capture, loader, client, e2e.
- **Gating:** every content-dependent step (loader assertions, freeze) self-skips or is explicitly gated until Wave 2 completes — the infrastructure ships and verifies green now; the bundle commits later.
- **Placeholders:** the only `<n>` is the doc filename in Task 5 (chosen at authoring time).
