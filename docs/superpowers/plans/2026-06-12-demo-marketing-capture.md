# Demo Marketing Screenshot Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a repeatable, on-brand marketing screenshot set of the Castwright web app posed across its pipeline stages, driven by a fictional "The Hollow Tide" series in mock mode, with the maintainer's real name scrubbed from mock data and account chrome.

**Architecture:** Three waves. **A** — narrow name scrub (author `Mike Dudarenok → Marin Vale`, default `displayName → "Castwright"`) across mock data + the 12 asserting specs, leaving titles/slugs untouched. **B** — an *additive*, capture-only Hollow Tide fixture set served by the mock layer only under a new `VITE_DEMO_CAPTURE=1` flag, plus a dedicated `playwright.marketing.config.ts`, a scene registry, and a capture runner. Determinism lives in the mock layer: under the flag, the analysing/generating mock streams emit a single fixture-defined frame and then hang, so animated views freeze. **C** — cover art wiring, the remaining scenes (account/profile/voice-library), phone+tablet variants, and visual review.

**Tech Stack:** Vite + React 18 + TS + Redux Toolkit (frontend), Vitest (unit), Playwright/chromium (capture), mock mode via `VITE_USE_MOCKS`.

**Branch:** `feat/frontend-demo-marketing-capture` (already cut). **Spec:** `docs/superpowers/specs/2026-06-12-demo-mode-marketing-capture-design.md`.

---

## Subagent execution contract

Each task is self-contained for a **fresh subagent with zero conversation context**. Per task:

- **Work on the existing branch `feat/frontend-demo-marketing-capture`.** Do not create a new branch; do not merge. First action: `git switch feat/frontend-demo-marketing-capture` (it already exists).
- **Touch only the files named in the task's "Files" block.** Read only the files the task names. Do not refactor adjacent code.
- **Follow the steps in order**, run the exact commands shown, and confirm the stated "Expected" output before moving on. If a command's output differs, stop and report — do not improvise past a red step.
- **Commit** with the task's shown message at the end; one commit per task.
- **Do NOT touch** any `Marlow` / `the Coalfall Commission` / `Marlow Side-Stories` strings (piece #2), or `LICENSE`/`NOTICE` (piece #3).
- **Covers are already staged** in git-ignored `public/marketing-covers/` (planning did this); Wave C only verifies them.
- **Dependencies:** Wave A tasks are independent of B/C and ship on their own. Within B, do tasks in order (B1→B9). Wave C needs B complete.
- **Capture tasks need chromium:** `npx playwright install chromium` (one-time) before any `capture:marketing` run.

A handful of steps say "read file X, confirm field/signature Y, then implement." These are **precise investigations**, not open-ended design — the file and the decision rule are named. Animated-view scenes (analysing/generating) carry a spelled-out fallback (Task B4) if the mock-layer freeze doesn't engage.

---

## File Structure

**Wave A — modify:**
- `server/src/workspace/user-settings.ts` — `DEFAULT_USER_SETTINGS.displayName`
- `server/src/routes/user-settings.test.ts` — assertion
- `src/lib/account-defaults.ts` — `FRONTEND_ACCOUNT_DEFAULTS.displayName`
- `src/mocks/library.ts`, `src/mocks/canned-data.ts`, `src/data/books.ts`, `src/mocks/manuscripts/the-northern-star.md` — `author` strings only
- 12 asserting specs (listed in Task A3/A4)

**Wave B — create:**
- `.env.marketing`
- `src/mocks/marketing/hollow-tide.ts` — the capture-only fixture set (library + book states + casts + posed snapshots)
- `src/mocks/marketing/hollow-tide.test.ts` — fixture shape test
- `playwright.marketing.config.ts`
- `e2e/marketing/scenes.ts` — scene registry
- `e2e/marketing/scenes.test.ts` — registry resolution smoke test (Vitest)
- `e2e/marketing/capture.spec.ts` — Playwright capture runner
- `e2e/marketing/README.md`

**Wave B — modify:**
- `src/lib/api.ts` — `DEMO_CAPTURE` flag; `mockGetLibrary`/`mockGetBookState` branch; analysing + generation mock streams emit-once-and-hang under the flag
- `package.json` — `capture:marketing` script
- `.gitignore` — `public/marketing-covers/`, `mockups/marketing-screens/`

**Wave C — create/modify:**
- `public/marketing-covers/` (git-ignored, local) — generated + copied cover JPEGs
- `e2e/marketing/scenes.ts` — add account/profile/voice-library scenes + viewport variants

---

## Conventions for this plan

- **Run one frontend test file:** `npx vitest run <path>` (single-run, no watch).
- **Run one server test file:** `cd server && npx vitest run <path>`.
- **Commit** at the end of each task with the shown message.
- Replace **only** the `author` / `displayName` value `Mike Dudarenok`. **Do NOT** touch any `Marlow`/`the Coalfall Commission` titles or `Marlow Side-Stories` series strings — those belong to piece #2.

---

# Wave A — Name scrub

### Task A1: Server default display name → "Castwright"

**Files:**
- Modify: `server/src/workspace/user-settings.ts`
- Test: `server/src/routes/user-settings.test.ts:74`

- [ ] **Step 1: Update the failing assertion**

In `server/src/routes/user-settings.test.ts` change line 74:
```ts
    expect(res.body.displayName).toBe('Castwright');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/routes/user-settings.test.ts`
Expected: FAIL — received `'Mike Dudarenok'`, expected `'Castwright'`.

- [ ] **Step 3: Update the default**

In `server/src/workspace/user-settings.ts`, in `DEFAULT_USER_SETTINGS`, change:
```ts
  displayName: 'Castwright',
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && npx vitest run src/routes/user-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/user-settings.ts server/src/routes/user-settings.test.ts
git commit -m "refactor(server): default display name to Castwright"
```

---

### Task A2: Frontend account default + account/top-bar specs

**Files:**
- Modify: `src/lib/account-defaults.ts:40`
- Tests: `src/views/account.test.tsx:28`, `src/views/account.backups.test.tsx:36`, `src/components/top-bar.test.tsx:70`

- [ ] **Step 1: Update the failing assertions/fixtures**

`src/lib/account-defaults.ts` line 40:
```ts
  displayName: 'Castwright',
```
`src/views/account.test.tsx` line 28 (`SERVER_FIXTURE.displayName`):
```ts
  displayName: 'Castwright',
```
`src/views/account.backups.test.tsx` line 36 (`SERVER_FIXTURE.displayName`):
```ts
  displayName: 'Castwright',
```
`src/components/top-bar.test.tsx` line 70:
```ts
    userDisplayName: 'Castwright',
```
> Note: `account.backups.test.tsx` also has `author`/`name: 'Mike Dudarenok'` entries (lines 59/77/206) — those are book-author/library fixtures handled in Task A3; leave them for now.

- [ ] **Step 2: Run to verify (the account/top-bar specs that assert displayName)**

Run: `npx vitest run src/views/account.test.tsx src/components/top-bar.test.tsx`
Expected: PASS (displayName now flows from the updated default/fixtures).

- [ ] **Step 3: Commit**

```bash
git add src/lib/account-defaults.ts src/views/account.test.tsx src/views/account.backups.test.tsx src/components/top-bar.test.tsx
git commit -m "refactor(frontend): default display name to Castwright"
```

---

### Task A3: Mock + data book authors → "Marin Vale"

**Files:**
- Modify: `src/mocks/library.ts` (5 `author:` fields), `src/data/books.ts` (book seeds), `src/mocks/canned-data.ts`, `src/mocks/manuscripts/the-northern-star.md`
- Modify (mock book states): `src/lib/api.ts` — the `author: 'Mike Dudarenok'` strings inside `buildSolwayBayMockState` / `buildNorthernStarMockState` and any sibling mock-state builders.

- [ ] **Step 1: Replace author strings (mock/data sources only)**

In each of `src/mocks/library.ts`, `src/data/books.ts`, `src/mocks/canned-data.ts`, and the mock-state builders in `src/lib/api.ts`, replace every `author: 'Mike Dudarenok'` with:
```ts
  author: 'Marin Vale',
```
In `src/mocks/manuscripts/the-northern-star.md`, replace the byline `Mike Dudarenok` with `Marin Vale`.

Verify none missed (mock/data only):
Run: `git grep -n "Mike Dudarenok" -- src/mocks src/data src/lib/api.ts`
Expected: no output (exit 1 = zero matches).

- [ ] **Step 2: Run the mock-dependent suites**

Run: `npx vitest run src/lib/api.test.ts src/store/library-slice.test.ts`
Expected: PASS (no spec asserts the author from these mocks; if one does, update it to `Marin Vale`).

- [ ] **Step 3: Commit**

```bash
git add src/mocks src/data/books.ts src/lib/api.ts
git commit -m "refactor(frontend): rename mock author to Marin Vale"
```

---

### Task A4: Update remaining book-fixture specs + full fast verify

**Files (each has an inline `author:`/`name:` fixture = `'Mike Dudarenok'`):**
- `src/views/upload.test.tsx:18,95`
- `src/modals/edit-book-meta.test.tsx:18,72`
- `src/store/book-meta-slice.test.ts:19,40,51`
- `src/store/persistence-middleware.test.ts:355,370`
- `src/lib/cross-book-duplicates.test.ts:58,64,70`
- `src/views/listen.test.tsx:57`
- `src/components/listen/listen-responsive.test.tsx:77`
- `src/test/a11y.test.tsx:154`
- `src/views/account.backups.test.tsx:59,77,206`

- [ ] **Step 1: Replace `Mike Dudarenok` → `Marin Vale` in each file above**

Change only the author/name string value. In `edit-book-meta.test.tsx:72`, the assertion becomes:
```ts
    expect((screen.getByLabelText('Author') as HTMLInputElement).value).toBe('Marin Vale');
```
Leave `'the Coalfall Commission'` titles and `'Marlow Side-Stories'` series strings untouched (piece #2).

- [ ] **Step 2: Confirm no stray name in test sources**

Search the repo's `*.test.ts(x)` for `Mike Dudarenok`. Expected: zero hits.

- [ ] **Step 3: Run fast verify**

Run: `npm run verify:fast`
Expected: PASS (frontend + server fast tests green).

- [ ] **Step 4: Commit**

```bash
git add src/ server/
git commit -m "test: rename Mike Dudarenok to Marin Vale in fixtures"
```

---

# Wave B — Hollow Tide fixtures + capture plumbing

### Task B1: `.env.marketing`

**Files:**
- Create: `.env.marketing`

> **Note (revised during execution):** the `DEMO_CAPTURE` flag declaration was
> moved into Task B3. Declaring it here (unused until B3) trips `tsc` TS6133
> ("declared but never read"). B1 commits only the env file; B3 adds the flag
> *and* its first use together, keeping typecheck green.

- [ ] **Step 1: Create `.env.marketing`**

```
VITE_USE_MOCKS=true
VITE_DEMO_CAPTURE=1
```

- [ ] **Step 2: Commit**

```bash
git add .env.marketing
git commit -m "feat(frontend): add .env.marketing capture mode"
```

---

### Task B2: Hollow Tide fixture module

**Files:**
- Create: `src/mocks/marketing/hollow-tide.ts`
- Test: `src/mocks/marketing/hollow-tide.test.ts`

Uses the real types: `LibraryResponse` (`src/lib/types.ts`), `BookStateResponse` / `BookStateJson` / `Character`.

- [ ] **Step 1: Write the failing fixture-shape test**

`src/mocks/marketing/hollow-tide.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
  HOLLOW_TIDE_POSED,
} from './hollow-tide';

describe('Hollow Tide marketing fixtures', () => {
  it('exposes the Marin Vale "The Hollow Tide" three-book series', () => {
    const marin = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Marin Vale');
    expect(marin).toBeDefined();
    const series = marin!.series.find((s) => s.name === 'The Hollow Tide');
    expect(series?.books.map((b) => b.bookId)).toEqual([
      'hollow-tide-1',
      'hollow-tide-2',
      'hollow-tide-3',
    ]);
  });

  it('includes Coalfall as a Castwright standalone on the shelf', () => {
    const cw = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Castwright');
    expect(cw?.series[0].books[0].bookId).toBe('coalfall-commission');
  });

  it('poses the three books at finished / generating / analysing', () => {
    const byId = new Map(
      HOLLOW_TIDE_LIBRARY.authors[0].series[0].books.map((b) => [b.bookId, b]),
    );
    expect(byId.get('hollow-tide-1')?.status).toBe('complete');
    expect(byId.get('hollow-tide-2')?.status).toBe('generating');
    expect(byId.get('hollow-tide-3')?.status).toBe('analysing');
  });

  it('provides a book state for every library book', () => {
    for (const bookId of ['hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3']) {
      expect(HOLLOW_TIDE_BOOK_STATES.get(bookId)?.state.bookId).toBe(bookId);
    }
  });

  it('marks recurring cast as reused with matchedFrom provenance', () => {
    const cast = HOLLOW_TIDE_BOOK_STATES.get('hollow-tide-2')?.cast?.characters ?? [];
    const reused = cast.filter((c) => c.voiceState === 'reused');
    expect(reused.length).toBeGreaterThanOrEqual(3);
    expect(reused[0].matchedFrom?.bookTitle).toBe('The Drowning Bell');
  });

  it('carries posed analysing + generating snapshots', () => {
    expect(HOLLOW_TIDE_POSED.analysing.bookId).toBe('hollow-tide-3');
    expect(HOLLOW_TIDE_POSED.analysing.phaseProgress).toBeGreaterThan(0);
    expect(HOLLOW_TIDE_POSED.generating.bookId).toBe('hollow-tide-2');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mocks/marketing/hollow-tide.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fixture module**

Create `src/mocks/marketing/hollow-tide.ts`. Author the data using the real types. Below is the complete shape with **`hollow-tide-1` fully filled** as the worked example; fill `hollow-tide-2` and `-3` by the same shape with the values from the table that follows.

```ts
/* Capture-only marketing fixtures (VITE_DEMO_CAPTURE=1). Additive — never
   served in normal mock mode, so this touches no existing spec. */
import type { LibraryResponse, BookStateResponse, Character } from '../../lib/types';

const COVER = (slug: string) => `/marketing-covers/${slug}.png`;

/* --- Recurring cast, designed in Book 1, reused in 2 & 3 --- */
const narrator = (): Character => ({
  id: 'narrator',
  name: 'Narrator',
  role: 'Narrator',
  color: '#3C6E71',
  voiceId: 'v_marin_narrator',
  voiceState: 'generated',
  tone: { warmth: 0.6, pace: 0.5, authority: 0.7, emotion: 0.4 },
  description: 'Measured, salt-weathered storyteller.',
});
const reusedFromBook1 = (c: Character): Character => ({
  ...c,
  voiceState: 'reused',
  matchedFrom: {
    bookId: 'hollow-tide-1',
    characterId: c.id,
    bookTitle: 'The Drowning Bell',
    confidence: 0.97,
  },
});
const inspCray = (): Character => ({
  id: 'insp-cray',
  name: 'Insp. Cray',
  role: 'Detective',
  color: '#264653',
  voiceId: 'v_marin_cray',
  voiceState: 'generated',
  tone: { warmth: 0.4, pace: 0.45, authority: 0.85, emotion: 0.5 },
  description: 'Dogged harbour-town inspector.',
});
const drWren = (): Character => ({
  id: 'dr-wren',
  name: 'Dr. Wren',
  role: 'Coroner',
  color: '#7B5A26',
  voiceId: 'v_marin_wren',
  voiceState: 'generated',
  tone: { warmth: 0.55, pace: 0.4, authority: 0.6, emotion: 0.45 },
  description: 'Precise, dryly humane coroner.',
});

const now = '2026-06-12T09:00:00.000Z';

function bookState(args: {
  bookId: string;
  title: string;
  seriesPosition: number;
  coverGradient: [string, string];
  castConfirmed: boolean;
  chapters: BookStateResponse['state']['chapters'];
  cast: Character[] | null;
  completedSlugs: string[];
}): BookStateResponse {
  return {
    state: {
      bookId: args.bookId,
      manuscriptId: `mns_${args.bookId}`,
      title: args.title,
      author: 'Marin Vale',
      series: 'The Hollow Tide',
      seriesPosition: args.seriesPosition,
      isStandalone: false,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: args.castConfirmed,
      chapters: args.chapters,
      coverGradient: args.coverGradient,
      createdAt: now,
      updatedAt: now,
      narratorCredit: null,
    },
    cast: args.cast ? { characters: args.cast } : null,
    manuscript: { wordCount: 84_000, format: 'epub' },
    manuscriptEdits: null,
    revisions: null,
    completedSlugs: args.completedSlugs,
    changeLog: null,
  };
}

/* Book 1 — The Drowning Bell — FINISHED (worked example) */
const BOOK1_CHAPTERS: BookStateResponse['state']['chapters'] = Array.from(
  { length: 12 },
  (_, i) => ({
    id: i + 1,
    title: `Chapter ${i + 1}`,
    slug: `${String(i + 1).padStart(2, '0')}-chapter`,
    duration: '34:12',
  }),
);
const drowningBell = bookState({
  bookId: 'hollow-tide-1',
  title: 'The Drowning Bell',
  seriesPosition: 1,
  coverGradient: ['#1F3A40', '#0B1416'],
  castConfirmed: true,
  chapters: BOOK1_CHAPTERS,
  cast: [narrator(), inspCray(), drWren() /* + 4 book-1-only chars */],
  completedSlugs: BOOK1_CHAPTERS.map((c) => c.slug),
});

/* Book 2 — Saltgrave — GENERATING (fill chapters 1..11; mark 7 done) */
const saltgrave = bookState({
  bookId: 'hollow-tide-2',
  title: 'Saltgrave',
  seriesPosition: 2,
  coverGradient: ['#2B4C57', '#101D22'],
  castConfirmed: true,
  chapters: [/* 11 chapters; ids 1..11 */],
  cast: [
    reusedFromBook1(narrator()),
    reusedFromBook1(inspCray()),
    reusedFromBook1(drWren()),
    /* + 3 book-2-new chars with voiceState 'generated' */
  ],
  completedSlugs: [/* slugs of chapters 1..7 */],
});

/* Book 3 — The Tidewatcher's Oath — ANALYSING (cast still forming) */
const tidewatcher = bookState({
  bookId: 'hollow-tide-3',
  title: "The Tidewatcher's Oath",
  seriesPosition: 3,
  coverGradient: ['#22343F', '#0A1014'],
  castConfirmed: false,
  chapters: [/* 8 chapters; ids 1..8 */],
  cast: [reusedFromBook1(narrator()), reusedFromBook1(inspCray())],
  completedSlugs: [],
});

export const HOLLOW_TIDE_BOOK_STATES = new Map<string, BookStateResponse>([
  ['hollow-tide-1', drowningBell],
  ['hollow-tide-2', saltgrave],
  ['hollow-tide-3', tidewatcher],
]);

export const HOLLOW_TIDE_LIBRARY: LibraryResponse = {
  authors: [
    {
      name: 'Marin Vale',
      series: [
        {
          name: 'The Hollow Tide',
          books: [
            {
              bookId: 'hollow-tide-1',
              title: 'The Drowning Bell',
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 1,
              isStandalone: false,
              status: 'complete',
              chapterCount: 12,
              completedChapters: 12,
              characterCount: 7,
              voiceCount: 7,
              progress: 1,
              runtime: '7h 02m',
              lastWorkedOn: '2 days ago',
              coverGradient: ['#1F3A40', '#0B1416'],
              coverImageUrl: COVER('hollow-tide-1'),
              tags: ['series-1'],
            },
            {
              bookId: 'hollow-tide-2',
              title: 'Saltgrave',
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 2,
              isStandalone: false,
              status: 'generating',
              chapterCount: 11,
              completedChapters: 7,
              characterCount: 6,
              voiceCount: 6,
              progress: 0.62,
              runtime: '6h 18m',
              lastWorkedOn: '4 min ago',
              coverGradient: ['#2B4C57', '#101D22'],
              coverImageUrl: COVER('hollow-tide-2'),
              pinned: true,
              tags: ['series-1'],
            },
            {
              bookId: 'hollow-tide-3',
              title: "The Tidewatcher's Oath",
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 3,
              isStandalone: false,
              status: 'analysing',
              chapterCount: 8,
              completedChapters: 0,
              characterCount: 0,
              voiceCount: 0,
              progress: 0.4,
              lastWorkedOn: 'Just now',
              coverGradient: ['#22343F', '#0A1014'],
              coverImageUrl: COVER('hollow-tide-3'),
              tags: ['series-1'],
            },
          ],
        },
      ],
    },
  ],
};

/* Posed snapshots for the animated views (Task B4 emits these once, then hangs). */
export const HOLLOW_TIDE_POSED = {
  analysing: {
    bookId: 'hollow-tide-3',
    manuscriptId: 'mns_hollow-tide-3',
    bookTitle: "The Tidewatcher's Oath",
    phaseId: 1,
    phaseLabel: 'Detecting characters',
    phaseProgress: 0.45,
    remainingMs: 9000,
  },
  generating: {
    bookId: 'hollow-tide-2',
    chapterId: 8,
    modelKey: 'kokoro-v1' as const,
    done: 7,
    total: 11,
    inProgress: 1,
  },
};
```

> **Cover field (verified):** the field is `coverImageUrl` on `LibraryBook` (`src/lib/types.ts:560`), and the library grid renders an `<img src={coverImageUrl}>` (`library-grid.tsx:198`). In mock mode the browser loads that URL as a static file, so `/marketing-covers/<slug>.png` (served by Vite from `public/`) renders directly — no api-mock interception needed.
> **Listen-view cover (verify once):** the listen view receives `bookCoverImageUrl` as a prop (`src/views/listen.tsx:48,102`). Read `src/App.tsx` where it renders the listen view and confirm that prop is sourced from the active library book's `coverImageUrl` (the expected path). If instead it builds `/api/books/:id/cover`, that 404s offline → gradient fallback; in that case also stamp `coverImageUrl` wherever App derives the listen cover. The cast/confirm/account scenes don't show a book cover, so they're unaffected.

- [ ] **Step 4: Fill the remaining data**

Complete `hollow-tide-2` (11 chapters, 7 completed slugs, 3 new chars) and `hollow-tide-3` (8 chapters, empty cast beyond the 2 reused), plus 4 book-1-only characters, following the worked example's shape.

- [ ] **Step 4b: Add Coalfall to the shelf (standalone anchor)**

The library-shelf scene shows "Hollow Tide + Coalfall," so add a second author to `HOLLOW_TIDE_LIBRARY.authors` and a matching book state. Append to the `authors` array:
```ts
    {
      name: 'Castwright',
      series: [
        {
          name: 'Standalones',
          books: [
            {
              bookId: 'coalfall-commission',
              title: 'The Coalfall Commission',
              author: 'Castwright',
              series: 'Standalones',
              seriesPosition: null,
              isStandalone: true,
              status: 'complete',
              chapterCount: 4,
              completedChapters: 4,
              characterCount: 11,
              voiceCount: 11,
              progress: 1,
              runtime: '2h 41m',
              lastWorkedOn: 'Last week',
              coverGradient: ['#3C194F', '#0F0E0D'],
              coverImageUrl: COVER('coalfall-commission'),
              tags: [],
            },
          ],
        },
      ],
    },
```
And add a book state to `HOLLOW_TIDE_BOOK_STATES` (so a `#/books/coalfall-commission/listen` scene would also resolve), using `bookState({ bookId: 'coalfall-commission', title: 'The Coalfall Commission', seriesPosition: 0, coverGradient: ['#3C194F', '#0F0E0D'], castConfirmed: true, chapters: <4 chapters>, cast: <11 chars or null>, completedSlugs: <all 4> })` — but set its `state.author` to `'Castwright'`, `series` to `'Standalones'`, `isStandalone: true`, `seriesPosition: null` (override the helper defaults inline, or extend the helper to accept these). Update the B2 test's first assertion to expect two authors (`['Marin Vale', 'Castwright']`) if you assert author count.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/mocks/marketing/hollow-tide.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mocks/marketing/hollow-tide.ts src/mocks/marketing/hollow-tide.test.ts
git commit -m "feat(frontend): add Hollow Tide marketing fixtures"
```

---

### Task B3: Serve Hollow Tide under the capture flag

**Files:**
- Modify: `src/lib/api.ts` — `mockGetLibrary` (≈600), `mockGetBookState` (≈1044); import the fixtures.

- [ ] **Step 1: Write the failing test**

Add to `src/mocks/marketing/hollow-tide.test.ts`:
```ts
import { vi } from 'vitest';
// (top of file) — note: this asserts wiring intent; the api branch is covered
// by manual capture. Keep this as a documentation test of the maps.
it('book-state map and library agree on ids', () => {
  const ids = HOLLOW_TIDE_LIBRARY.authors[0].series[0].books.map((b) => b.bookId);
  for (const id of ids) expect(HOLLOW_TIDE_BOOK_STATES.has(id)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it passes (map agreement)**

Run: `npx vitest run src/mocks/marketing/hollow-tide.test.ts`
Expected: PASS.

- [ ] **Step 3: Branch the mock serving functions**

At the top of `src/lib/api.ts`, import:
```ts
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
} from '../mocks/marketing/hollow-tide';
```
In `mockGetLibrary` (return at ≈602), prepend:
```ts
async function mockGetLibrary(): Promise<LibraryResponse> {
  await wait(40);
  if (DEMO_CAPTURE) return HOLLOW_TIDE_LIBRARY;
  return MOCK_LIBRARY;
}
```
In `mockGetBookState` (≈1044):
```ts
export async function mockGetBookState(bookId: string): Promise<BookStateResponse | null> {
  await wait(60);
  if (DEMO_CAPTURE && HOLLOW_TIDE_BOOK_STATES.has(bookId)) {
    return HOLLOW_TIDE_BOOK_STATES.get(bookId) ?? null;
  }
  return MOCK_BOOK_STATES.get(bookId) ?? null;
}
```

- [ ] **Step 4: Typecheck + frontend tests**

Run: `npm run typecheck && npx vitest run src/store/library-slice.test.ts`
Expected: PASS (DEMO_CAPTURE is false in unit tests, so default mock path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): serve Hollow Tide fixtures under capture flag"
```

---

### Task B4: Freeze animated views — emit one posed frame, then hang

**Files:**
- Modify: `src/lib/api.ts` — the mock analysis stream (`mockAnalyseManuscript` ≈1144 and/or the `streamAnalysis` mock) and the mock generation tick loop (the `setInterval(tick, 1200)` at ≈1329).

Goal: under `DEMO_CAPTURE`, for a posed Hollow Tide book, emit the fixture's posed phase/chapter values **once** and never advance or complete — so the analysing/generating views render the frozen frame and stay on-screen.

- [ ] **Step 1: Read the two mock stream entry points**

Read `src/lib/api.ts` around the analysis stream (the function the analysing view calls — `mockAnalyseManuscript` and any `mockStreamAnalysis`) and the generation stream (the function returning the `setInterval(tick,1200)` cleanup at ≈1290–1331). Identify the callback names (`onPhase`, `onTick`/`onEta`) and the book id available to each.

- [ ] **Step 2: Short-circuit the analysis stream under the flag**

In the analysis mock, before the live phase loop, add:
```ts
import { HOLLOW_TIDE_POSED } from '../mocks/marketing/hollow-tide';
// inside the analyse/stream fn, given the manuscriptId/bookId:
if (DEMO_CAPTURE) {
  const p = HOLLOW_TIDE_POSED.analysing;
  onPhase?.({ phaseId: p.phaseId, progress: p.phaseProgress });
  // Do NOT resolve/complete — return a promise that never settles so the
  // analysing view stays posed. The capture screenshots this frame.
  return new Promise<never>(() => {});
}
```
> If the analysing view derives its label/cast from a richer snapshot than `onPhase` supplies, also call the relevant callback(s) (`onEta`, `onSeriesPrior`) once with `HOLLOW_TIDE_POSED.analysing` values. Confirm the callback set by reading the mock fn signature in Step 1.

- [ ] **Step 3: Short-circuit the generation stream under the flag**

In the generation mock (the `tick` loop), before scheduling the interval:
```ts
if (DEMO_CAPTURE) {
  const g = HOLLOW_TIDE_POSED.generating;
  // Emit one posed snapshot: g.done chapters complete, one in progress.
  onTick({
    type: 'progress',
    chapterId: g.chapterId,
    characterId: null,
    progress: 0.6,
    currentLine: 360,
    totalLines: 600,
  });
  return () => {}; // no interval; state stays frozen at the posed values
}
```
> Match `onTick`'s real event shape from Step 1 (the live code emits `{ type: 'progress', chapterId, characterId, progress, currentLine, totalLines }`). Emit one tick per already-done chapter if the view needs them marked done, using the posed `done` count.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify the freeze engages (deferred check)**

This is verified when the `analysing` + `generating` scenes are captured in Task B7. The pass criterion: `analysing.desktop.png` shows the phase bar at ~45% with the forming-cast panel (NOT a spinner, blank, or a redirect to the confirm/cast screen), and `generating.desktop.png` shows 7/11 chapters done with one in progress.

**Fallback if the mock-layer freeze does NOT engage** (e.g. the view redirects on `castConfirmed`, or never subscribes to the mock stream on direct hash navigation): pose the state by **direct redux dispatch** instead. (a) Under `DEMO_CAPTURE`, in `src/store/index.ts`, expose the store: `if (import.meta.env.VITE_DEMO_CAPTURE === '1') (window as any).__CW_STORE__ = store;`. (b) Give the two animated scenes a `setup(page)` that dispatches a posed snapshot, e.g.:
```ts
await page.evaluate((posed) => {
  const store = (window as any).__CW_STORE__;
  store.dispatch({ type: 'analysis/setActiveStream', payload: posed });
}, HOLLOW_TIDE_POSED.analysing);
```
Confirm the real action creator + payload by reading `src/store/analysis-slice.ts` (look for the exported `analysisActions` member that replaces the whole `activeStream`) and `src/store/chapters-slice.ts` (chapter list + active-stream setters). Use the mock-layer freeze first; only add the store hook if B7 shows it's needed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): freeze analysing/generating mocks under capture flag"
```

---

### Task B5: `playwright.marketing.config.ts`

**Files:**
- Create: `playwright.marketing.config.ts`

- [ ] **Step 1: Create the config**

```ts
import { defineConfig, devices } from '@playwright/test';

/* Marketing screenshot capture — NOT a regression gate. Runs Vite in
   `--mode marketing` (.env.marketing → VITE_USE_MOCKS=true + VITE_DEMO_CAPTURE=1)
   and drives the scene registry under e2e/marketing/. */
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5175);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e/marketing',
  testMatch: /capture\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL, navigationTimeout: 60_000 },
  expect: { toHaveScreenshot: { animations: 'disabled' } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'tablet', use: { ...devices['iPad Pro 11'], browserName: 'chromium' } },
  ],
  webServer: {
    command: `npx vite --mode marketing --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Verify the config loads**

Run: `npx playwright test --config=playwright.marketing.config.ts --list`
Expected: lists capture spec(s) across the three projects (zero tests is fine before Task B7).

- [ ] **Step 3: Commit**

```bash
git add playwright.marketing.config.ts
git commit -m "build: add playwright.marketing.config for capture"
```

---

### Task B6: Scene registry

**Files:**
- Create: `e2e/marketing/scenes.ts`
- Test: `e2e/marketing/scenes.test.ts`

Hashes per the verified `router.ts` grammar (`#/`, `#/books/:bookId/<view>`, `#/books/:bookId/analysing`, `#/account`, `#/voices`).

- [ ] **Step 1: Write the failing registry test**

`e2e/marketing/scenes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SCENES, type Scene } from './scenes';

describe('marketing scene registry', () => {
  it('has unique ids and valid hashes', () => {
    const ids = SCENES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENES) expect(s.hash.startsWith('#/')).toBe(true);
  });
  it('defaults to the desktop viewport', () => {
    const lib = SCENES.find((s) => s.id === 'library-shelf') as Scene;
    expect(lib.viewports ?? ['desktop']).toContain('desktop');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run e2e/marketing/scenes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry (core scenes)**

`e2e/marketing/scenes.ts`:
```ts
export type Viewport = 'desktop' | 'phone' | 'tablet';

export interface Scene {
  id: string;
  hash: string;
  viewports?: Viewport[]; // default ['desktop']
  waitFor?: string;       // selector to await before the shot
}

export const SCENES: Scene[] = [
  { id: 'library-shelf', hash: '#/', viewports: ['desktop', 'phone', 'tablet'],
    waitFor: '[data-testid="book-cover-hollow-tide-1"]' },
  { id: 'analysing', hash: '#/books/hollow-tide-3/analysing',
    viewports: ['desktop', 'phone', 'tablet'] },
  { id: 'confirm-cast', hash: '#/books/hollow-tide-1/confirm',
    viewports: ['desktop', 'phone', 'tablet'] },
  { id: 'cast-reuse', hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop', 'phone', 'tablet'] },
  { id: 'generating', hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop', 'phone', 'tablet'] },
  { id: 'listen', hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop', 'phone', 'tablet'],
    waitFor: '[data-testid="listen-cover-art"]' },
];
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run e2e/marketing/scenes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/marketing/scenes.ts e2e/marketing/scenes.test.ts
git commit -m "feat(e2e): add marketing scene registry"
```

---

### Task B7: Capture runner

**Files:**
- Create: `e2e/marketing/capture.spec.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Add git-ignores**

Append to `.gitignore`:
```
public/marketing-covers/
mockups/marketing-screens/
```

- [ ] **Step 2: Write the capture runner**

`e2e/marketing/capture.spec.ts`:
```ts
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENES, type Viewport } from './scenes';

const OUT = resolve(process.cwd(), 'mockups', 'marketing-screens');
mkdirSync(OUT, { recursive: true });

const onlyScene = process.env.CAPTURE_SCENE; // optional filter

for (const scene of SCENES) {
  if (onlyScene && scene.id !== onlyScene) continue;
  const viewports = scene.viewports ?? (['desktop'] as Viewport[]);

  test.describe(scene.id, () => {
    test(`capture ${scene.id} @ ${test.info().project.name}`, async ({ page }, testInfo) => {
      const vp = testInfo.project.name as Viewport;
      test.skip(!viewports.includes(vp), 'viewport not requested for this scene');

      await page.goto(`/${scene.hash}`);
      if (scene.waitFor) await page.waitForSelector(scene.waitFor, { timeout: 30_000 });
      // settle: fonts + posed frame painted
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.screenshot({ path: resolve(OUT, `${scene.id}.${vp}.png`), fullPage: false });
    });
  });
}
```
> Note `page.goto('/' + '#/...')` resolves against `baseURL`; if double-slash is an issue, use `page.goto(scene.hash)` (hash-only navigation is supported by Playwright against `baseURL`). Verify on first run and adjust.

- [ ] **Step 3: Run the desktop capture for one scene**

Run: `CAPTURE_SCENE=listen npx playwright test --config=playwright.marketing.config.ts --project=desktop`
Expected: PASS; `mockups/marketing-screens/listen.desktop.png` written. Open it to confirm the Hollow Tide "The Drowning Bell" cover/title render.

- [ ] **Step 4: Run the full desktop set**

Run: `npx playwright test --config=playwright.marketing.config.ts --project=desktop`
Expected: PASS; six PNGs in `mockups/marketing-screens/`. Eyeball each (esp. `analysing`/`generating` show the posed frozen frame, not a spinner or a completed/redirected view).

- [ ] **Step 5: Commit**

```bash
git add e2e/marketing/capture.spec.ts .gitignore
git commit -m "feat(e2e): add marketing capture runner"
```

---

### Task B8: `capture:marketing` commands + README

**Files:**
- Modify: `package.json`
- Create: `e2e/marketing/README.md`

- [ ] **Step 1: Add the script**

In `package.json` `scripts`:
```json
"capture:marketing": "playwright test --config=playwright.marketing.config.ts --project=desktop"
```

- [ ] **Step 2: Verify the command**

Run: `npm run capture:marketing`
Expected: regenerates the six desktop PNGs.
Run (one scene): `CAPTURE_SCENE=cast-reuse npm run capture:marketing`
Expected: regenerates only `cast-reuse.desktop.png`.

- [ ] **Step 3: Write the README (the canonical recipe)**

`e2e/marketing/README.md` documents: prerequisites (`npx playwright install chromium`), `npm run capture:marketing` (all desktop), `CAPTURE_SCENE=<id> npm run capture:marketing` (one), `--project=phone,tablet` for responsive, output path `mockups/marketing-screens/`, where covers live (`public/marketing-covers/`, git-ignored), and **how to add a scene** (one row in `e2e/marketing/scenes.ts`).

- [ ] **Step 4: Commit**

```bash
git add package.json e2e/marketing/README.md
git commit -m "build: add capture:marketing command + recipe README"
```

---

# Wave C — Covers, remaining scenes, responsive, review

### Task C1: Cover art wiring

**Files:**
- Create (local, git-ignored): `public/marketing-covers/hollow-tide-1.jpg`, `-2.jpg`, `-3.jpg`, `coalfall-commission.jpg`

- [ ] **Step 1: Verify the covers are staged (already done during planning)**

The four covers were already copied into `public/marketing-covers/` during
planning, and `public/marketing-covers/` is git-ignored (`.gitignore`). Confirm:
```bash
ls public/marketing-covers/   # expect: coalfall-commission.png hollow-tide-1.png hollow-tide-2.png hollow-tide-3.png
git check-ignore public/marketing-covers/hollow-tide-1.png   # expect: the path is printed (ignored)
```
If any are missing, re-copy from the git-ignored sources:
```bash
cp "brand/book-covers/The Drowning Bell - Marin Vale.png"      public/marketing-covers/hollow-tide-1.png
cp "brand/book-covers/Saltgrave - Marin Vale.png"              public/marketing-covers/hollow-tide-2.png
cp "brand/book-covers/The Tidewatcher's Oath - Marin Vale.png" public/marketing-covers/hollow-tide-3.png
cp "brand/test-book/the-coalfall-commission-cover-final.png"   public/marketing-covers/coalfall-commission.png
```
The fixture `COVER()` helper points at `/marketing-covers/<slug>.png` (Task B2).

- [ ] **Step 2: Re-capture and verify covers render**

Run: `CAPTURE_SCENE=library-shelf npm run capture:marketing`
Expected: `library-shelf.desktop.png` shows the three Hollow Tide cover images (not the gradient fallback).

- [ ] **Step 3: Commit (harness only — covers are git-ignored)**

```bash
git add -A
git commit -m "docs(e2e): wire marketing cover art (assets git-ignored)" --allow-empty
```

---

### Task C2: Account-tab scene (F7 — confirm sub-card mock coverage)

**Files:**
- Modify: `e2e/marketing/scenes.ts`

- [ ] **Step 1: Confirm the Account view renders cleanly under capture**

Run: `npx playwright test --config=playwright.marketing.config.ts --project=desktop -g account` will not yet match; first add the scene below, then run. Before that, manually check `src/views/account.tsx` for any card that hard-requires a non-mocked endpoint (model inventory, app-updates, backups, apiKeyStatus). If a card errors under mocks, note it and either accept the empty card or extend the relevant mock — keep this minimal.

- [ ] **Step 2: Add the account scene**

In `SCENES` (`e2e/marketing/scenes.ts`):
```ts
{ id: 'account', hash: '#/account', viewports: ['desktop', 'phone'] },
```

- [ ] **Step 3: Capture + verify**

Run: `CAPTURE_SCENE=account npm run capture:marketing`
Expected: `account.desktop.png` shows the account view with display name "Castwright" (or the marketing persona if overridden) and no error cards.

- [ ] **Step 4: Commit**

```bash
git add e2e/marketing/scenes.ts
git commit -m "feat(e2e): add account marketing scene"
```

---

### Task C3: Profile-drawer + voice-library scenes

**Files:**
- Modify: `e2e/marketing/scenes.ts`

- [ ] **Step 1: Add the scenes**

The profile drawer opens via the `?profile=<characterId>` query on a ready/confirm hash (per `router.ts` `openProfileId`). Voice library is `#/voices`.
```ts
{ id: 'profile-drawer', hash: '#/books/hollow-tide-2/cast?profile=insp-cray',
  viewports: ['desktop'], waitFor: '[data-testid="profile-drawer"]' },
{ id: 'voice-library', hash: '#/voices', viewports: ['desktop'] },
```
> Confirm the profile-drawer test id by reading `src/modals/profile-drawer.tsx`; if it differs, set `waitFor` to the real selector (or drop `waitFor`).

- [ ] **Step 2: Capture + verify**

Run: `CAPTURE_SCENE=profile-drawer npm run capture:marketing` then `CAPTURE_SCENE=voice-library npm run capture:marketing`
Expected: drawer open over the cast view; voices library populated.

- [ ] **Step 3: Commit**

```bash
git add e2e/marketing/scenes.ts
git commit -m "feat(e2e): add profile-drawer + voice-library scenes"
```

---

### Task C4: Phone + tablet variants

- [ ] **Step 1: Capture responsive variants for the core scenes**

Run: `npx playwright test --config=playwright.marketing.config.ts --project=phone --project=tablet`
Expected: `<scene>.phone.png` / `<scene>.tablet.png` for every scene whose `viewports` include them.

- [ ] **Step 2: Eyeball the responsive output**

Open the phone/tablet PNGs; confirm single-column/drawer layouts render (no desktop three-pane bleed, no clipped chrome). If a scene looks broken at a viewport, remove that viewport from its `viewports` array (marketing ≠ responsive regression).

- [ ] **Step 3: Commit any registry tweaks**

```bash
git add e2e/marketing/scenes.ts
git commit -m "feat(e2e): tune responsive viewport coverage" --allow-empty
```

---

### Task C5: Full verify + final review

- [ ] **Step 1: Confirm the capture harness is NOT in the gate**

Verify `playwright.marketing.config.ts` / `capture:marketing` are not referenced by `npm run verify` or the husky hooks. They must stay on-demand.

- [ ] **Step 2: Run the full battery**

Run: `npm run verify`
Expected: PASS — the name scrub + additive fixtures must not break typecheck, unit, e2e, or build. (The marketing config is separate, so `test:e2e` is unaffected.)

- [ ] **Step 3: Visual review of the full set**

Regenerate everything: `npm run capture:marketing` + the responsive projects. Review all PNGs in `mockups/marketing-screens/` for marketing quality (legible titles inside the central band, posed states correct, no real name anywhere).

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "docs(e2e): finalize marketing capture set" --allow-empty
```

---

## Self-review notes (author)

- **Spec coverage:** name scrub (A) ✓, additive Hollow Tide set under flag (B2/B3) ✓, `.env.marketing` + dedicated playwright config (B1/B5) ✓, determinism via emit-once-and-hang (B4) ✓, scene registry + runner + commands + README (B6–B8) ✓, covers (C1) ✓, account/profile/voice-library scenes (C2/C3) ✓, phone/tablet (C4) ✓, git-ignored output (B7) ✓, harness out of gate (C5) ✓.
- **Known verify-then-implement points (precise, not placeholders):** the exact `LibraryBook` cover-URL field name (B2 Step 3), the analysing/generation mock callback signatures (B4 Step 1), the profile-drawer test id (C3), and whether any Account sub-card needs a mock (C2). Each names the exact file to read.
- **Deferred to sibling pieces:** companion capture (#1b), Marlow character scrub (#2), legal/docs name scrub (#3).
