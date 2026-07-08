# Marketing Screenshots Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the marketing screenshot set (stale since v1.9.0) to cover four shipped-but-unrepresented stories — Quality Gate + voice drift, five-language support, emotion-aware voices + Higher-quality tier, and series memory + shareable cast card — and stage the results for a follow-up website-repo agent to place.

**Architecture:** Additive `DEMO_CAPTURE`-gated fixture changes in `src/mocks/` (two of the four stories need no fixture change at all — the scenes already exist), five new rows in the existing `e2e/marketing/scenes.ts` capture-rail registry, and a new manifest-driven staging script (`scripts/stage-marketing-screenshots.mjs`) that converts curated PNG output to webp and drops it into `brand/go-to-market/launch-post-images/marketing-site/screenshots/`. Zero production/runtime code paths touched — this mirrors the additive shape the Quality Gate marketing-screenshot work (#1286) already proved out.

**Tech Stack:** TypeScript, Vitest (frontend unit tests), Playwright (`e2e/marketing/capture.spec.ts`), Node.js `node:test` (scripts tests), ffmpeg CLI (PNG→webp).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-08-marketing-screenshots-refresh-design.md` (approved, 3 rounds of adversarial review, all Critical/Significant findings fixed). Every claim below cites the spec's or this plan's own verified source lines — do not re-derive them.
- Branch: `docs/docs-marketing-screenshots-refresh`, worktree at `.worktrees/marketing-screenshots-refresh/` (already set up; `node_modules` junctioned to the main checkout).
- `DEMO_CAPTURE` is `import.meta.env.VITE_DEMO_CAPTURE === '1'`, declared once as `const DEMO_CAPTURE` at `src/lib/api.ts:98`. All new branches gate on this constant, never a new flag.
- No changes to the `Castwright-Website` repo in this pass — that work is handed off via Task 7's handover doc.
- No coverage for stories outside the four approved ones (multi-GPU placement, offline voice design, etc.) — call this out explicitly in the handover doc, don't silently drop it.
- No redesign of `capture.spec.ts` or `playwright.marketing.config.ts` — only additive scene/fixture entries, matching the existing `e2e/marketing/README.md` "Adding a scene" convention.
- **This PR is not docs-only** — it touches `e2e/`, `src/mocks/`, `src/lib/`, and a new `scripts/*.mjs`, so it does **not** qualify for CLAUDE.md's docs-only code-review exemption or CI fast-path, and since it spans multiple scopes (`e2e`, `mocks`, `scripts`, `frontend`), the mandatory independent PR review runs at the `high` effort tier per the model-routing table's multi-scope rule. Commits use `feat`/`chore`/`test` types as appropriate — not `docs` (the spec-only commits already on this branch were correctly `docs`; the implementation commits below are not).
- Release notes: this work has no user- or operator-visible product change (marketing/tooling only) — **skip** `docs/release-notes-next.md`/`RELEASE_NOTES.md` updates explicitly, per CLAUDE.md's "skip only when the change has no shippable delta" carve-out. No `docs/features/` regression plan either, following the precedent set by the #1286 Quality Gate marketing-screenshot work (also plan-only, no regression-plan doc).
- PR body must include `Closes #NN` — file a GitHub issue for this work before opening the PR if one doesn't already exist (Task 7).

---

### Task 1: Coalfall `instruct` fixture patch (emotion + delivery-direction story)

**Files:**
- Modify: `src/mocks/marketing/coalfall-manuscript.json`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: sentence id `107` (chapter 4, `characterId: 'sela'`) now carries both `"emotion": "excited"` (already present) and a new `"instruct"` string — consumed by Task 4's `manuscript-emotion-direction` scene.

This task is **data-only**: it populates an existing, already-tested capability (`SentenceInstructControl`, `src/components/sentence-instruct-control.tsx`) with realistic marketing content — no new code path is created, so it needs no new automated test, mirroring the existing precedent that the JSON fixture's 9 pre-existing `emotion` values have no dedicated test of their own either (they're inert data consumed by already-covered components).

- [ ] **Step 1: Locate and patch sentence 107**

Open `src/mocks/marketing/coalfall-manuscript.json`. Find the sentence object with `"id": 107` (chapter 4, `"characterId": "sela"`, `"emotion": "excited"`, text `"Sela!"`). It currently looks like:

```json
    {
      "id": 107,
      "chapterId": 4,
      "characterId": "sela",
      "text": "“Sela!”",
      "confidence": <existing value>,
      "emotion": "excited"
    }
```

Add an `"instruct"` field so the object becomes:

```json
    {
      "id": 107,
      "chapterId": 4,
      "characterId": "sela",
      "text": "“Sela!”",
      "confidence": <existing value>,
      "emotion": "excited",
      "instruct": "shouted from across the yard, half-laughing"
    }
```

Keep every other field on that object exactly as it already is (in particular, don't touch `"confidence"` — copy its current value forward unchanged). Do not modify any other sentence in the file.

- [ ] **Step 2: Confirm the JSON still parses and the field flows through**

Run: `npm run typecheck`
Expected: no errors. (`coalfallManuscriptJson.sentences as unknown as Sentence[]` in `src/mocks/marketing/hollow-tide.ts:361` is a type assertion, not a runtime validator, so this step is really just confirming the JSON is syntactically valid — a `tsc` pass over the whole frontend is the cheapest way to catch a stray trailing comma or unescaped quote.)

- [ ] **Step 3: Commit**

```bash
git add src/mocks/marketing/coalfall-manuscript.json
git commit -m "feat(mocks): add a delivery-direction fixture line for the marketing capture"
```

---

### Task 2: Series-memory two-part fixture fix

**Files:**
- Modify: `src/mocks/marketing/hollow-tide.ts`
- Modify: `src/mocks/series-memory.ts`
- Test: `src/mocks/marketing/hollow-tide.test.ts`

**Interfaces:**
- Consumes: `SeriesMemorySummary`, `SeriesMemoryDetail`, `CarriedCharacter`, `LibrarySeries` types (`src/lib/types.ts:620-642`).
- Produces: `HOLLOW_TIDE_LIBRARY.authors[0].series[0].seriesMemory` (a populated `SeriesMemorySummary`) and `MOCK_SERIES_MEMORY['Marin Vale::The Hollow Tide']` (a populated `SeriesMemoryDetail`) — both consumed by Task 4's `series-memory-reveal` and `series-share-card` scenes. Both objects are mutually consistent (same carried-character count, same confirmed-book count) by construction and by the test below.

**Why two edits, verified against the current code:**
1. `series-memory-chip` (`src/components/series-memory/series-memory-chip.tsx`) is the *sole* entry point to both new scenes — it only renders when `series.seriesMemory` is truthy (`src/components/library/library-grid.tsx:102`: `{series.seriesMemory && (<SeriesMemoryChip …>`). `HOLLOW_TIDE_LIBRARY`'s "The Hollow Tide" series currently has no `seriesMemory` field at all, so the chip never renders under `DEMO_CAPTURE` today.
2. `getSeriesMemory`'s mock resolver (`src/lib/api.ts:8853`, `async (a, s) => MOCK_SERIES_MEMORY[\`${a}::${s}\`]`) is a plain key lookup used identically in dev-mock and `DEMO_CAPTURE` modes — no branching needed there, but the key `'Marin Vale::The Hollow Tide'` (what `HOLLOW_TIDE_LIBRARY`'s author/series names compose to, confirmed at `hollow-tide.ts:502,505`) has no entry in `MOCK_SERIES_MEMORY` today; only `'Marin Vale::Northern Coast Trilogy'` exists, for the *dev-mock* library.

Both must be added, and they must agree with each other (same carried count, same confirmed-book count) — nothing keeps them in sync automatically once hand-authored.

**Chosen carried cast** (grounded in the real `HOLLOW_TIDE_VOICES` fixture, `hollow-tide.ts:787-907`): Narrator (`v_marin_narrator`), Insp. Cray (`v_marin_cray`), Dr. Wren (`v_marin_wren`) — the three voices marked `usedIn: 3` (recurring across the series), all designed in Book 1 (`hollow-tide-1`, *The Drowning Bell*) and carried into Book 2 (`hollow-tide-2`, *Saltgrave*, `characterCount: 6`, matches). Books 3–4 (`hollow-tide-3` analysing with 0 cast, `hollow-tide-4` cast-pending with a different character) aren't part of the carried span yet, so `confirmedBookCount: 2` (books 1–2, both already cast) against `spanBooks: 4` (the series' full planned length) is the honest number — not 4/4.

- [ ] **Step 1: Add the `seriesMemory` summary to `HOLLOW_TIDE_LIBRARY`**

In `src/mocks/marketing/hollow-tide.ts`, find the "The Hollow Tide" series object (starts at line 504):

```ts
        {
          name: 'The Hollow Tide',
          books: [
```

Change the closing of that series object. Find its closing (this is the exact current content of `hollow-tide-4`'s book entry, the last one in the `books` array, immediately before the next series/author entry):

```ts
            {
              /* fs-1318 Tier D — cast-confirmed, zero chapters rendered:
                 the one marketing book with a genuinely undesigned voice
                 (harbor-clerk), which opens the voice-readiness gate from
                 the Manuscript view's "Approve cast & start generating".
                 voiceCount matches voiceIds.length (3) exactly — voiceIds
                 runs through the shared voiceIdsOf helper, whose
                 `voiceId ?? id` fallback pads in harbor-clerk's own id for
                 the undesigned slot, so voiceCount counts that placeholder
                 too rather than the 2 characters with a real voice. A
                 pre-existing helper quirk, not something this book needs
                 to work around. */
              bookId: 'hollow-tide-4',
              title: 'The Harborlight Ledger',
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 4,
              isStandalone: false,
              status: 'cast_pending',
              chapterCount: 6,
              completedChapters: 0,
              characterCount: 3,
              voiceCount: 3,
              voiceIds: voiceIdsOf(harborlight),
              progress: 0,
              lastWorkedOn: 'Just now',
              coverGradient: ['#2B4C57', '#101D22'],
              coverImageUrl: COVER('hollow-tide-2'),
              coverFraming: TITLE_TOP_FRAME,
              tags: ['series-1'],
            },
          ],
        },
      ],
    },
    {
      name: 'Castwright',
```

Replace with (adds `seriesMemory:` as a sibling of `books:`, after the closing `],` of the `books` array — every existing book entry inside `books: [ ... ]`, including `hollow-tide-4` above, stays completely unchanged):

```ts
            {
              /* fs-1318 Tier D — cast-confirmed, zero chapters rendered:
                 the one marketing book with a genuinely undesigned voice
                 (harbor-clerk), which opens the voice-readiness gate from
                 the Manuscript view's "Approve cast & start generating".
                 voiceCount matches voiceIds.length (3) exactly — voiceIds
                 runs through the shared voiceIdsOf helper, whose
                 `voiceId ?? id` fallback pads in harbor-clerk's own id for
                 the undesigned slot, so voiceCount counts that placeholder
                 too rather than the 2 characters with a real voice. A
                 pre-existing helper quirk, not something this book needs
                 to work around. */
              bookId: 'hollow-tide-4',
              title: 'The Harborlight Ledger',
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 4,
              isStandalone: false,
              status: 'cast_pending',
              chapterCount: 6,
              completedChapters: 0,
              characterCount: 3,
              voiceCount: 3,
              voiceIds: voiceIdsOf(harborlight),
              progress: 0,
              lastWorkedOn: 'Just now',
              coverGradient: ['#2B4C57', '#101D22'],
              coverImageUrl: COVER('hollow-tide-2'),
              coverFraming: TITLE_TOP_FRAME,
              tags: ['series-1'],
            },
          ],
          /* Series-memory marketing/wiki screenshots — gates series-memory-chip's
             render (library-grid.tsx:102: `{series.seriesMemory && (<SeriesMemoryChip …>`).
             Carried cast = the three `usedIn: 3` recurring voices in
             HOLLOW_TIDE_VOICES (Narrator, Insp. Cray, Dr. Wren), confirmed present
             in books 1-2 (both already cast; books 3-4 aren't part of the carried
             span yet). perBook.principalCount mirrors each book's own
             characterCount above (7, 6) so the two never silently drift apart. */
          seriesMemory: {
            carriedCount: 3,
            bespokeCount: 0,
            designedCount: 0,
            confirmedBookCount: 2,
            spanBooks: 4,
            perBook: [
              { bookId: 'hollow-tide-1', index: 1, principalCount: 7, carriedPresent: 3 },
              { bookId: 'hollow-tide-2', index: 2, principalCount: 6, carriedPresent: 3 },
            ],
          },
        },
      ],
    },
    {
      name: 'Castwright',
```

(Only the `seriesMemory:` block and the comment above it are new — every book entry above it, and every line after the `Castwright` author entry, stays byte-identical.)

- [ ] **Step 2: Add the `MOCK_SERIES_MEMORY` detail entry**

In `src/mocks/series-memory.ts`, the current full file content is:

```ts
import type { SeriesMemoryDetail } from '../lib/types';

// Populated by Task 11. Key = "<author>::<series>" — must match the library fixture exactly.
// Chosen series: "Northern Coast Trilogy" by "Marin Vale" (bookIds: sb, ns, cc).
export const MOCK_SERIES_MEMORY: Record<string, SeriesMemoryDetail> = {
  'Marin Vale::Northern Coast Trilogy': {
    series: {
      confirmedBookCount: 3,
      spanBooks: 3,
      books: [
        { bookId: 'sb', title: 'Solway Bay',          index: 1, principalCount: 8 },
        { bookId: 'ns', title: 'The Northern Star',   index: 2, principalCount: 9 },
        { bookId: 'cc', title: "Carrick's Compass",   index: 3, principalCount: 9 },
      ],
    },
    carried: {
      count: 4,
      bespokeCount: 3,
      designedCount: 3,
      // Ordered by totalLines desc — matches deriveSeriesMemory's "most-speaking-first" sort.
      characters: [
        {
          character: 'Narrator',
          aliases: [],
          voiceId: 'narrator',
          voiceLabel: 'Deep · Female · UK',
          engine: 'kokoro',
          voiceKind: 'preset',
          firstBookId: 'sb',
          lastBookId: 'cc',
          bookIndices: [1, 2, 3],
          carriedFullSpan: true,
          totalLines: 940,
        },
        {
          character: 'Carrick',
          aliases: [],
          voiceId: 'v-carrick',
          voiceLabel: 'Designed voice',
          engine: 'qwen',
          voiceKind: 'designed',
          firstBookId: 'sb',
          lastBookId: 'cc',
          bookIndices: [1, 2, 3],
          carriedFullSpan: true,
          totalLines: 610,
        },
        {
          character: 'Mara',
          aliases: [],
          voiceId: 'v-mara',
          voiceLabel: 'Designed voice',
          engine: 'qwen',
          voiceKind: 'designed',
          firstBookId: 'sb',
          lastBookId: 'ns',
          bookIndices: [1, 2],
          carriedFullSpan: false,
          totalLines: 340,
        },
        {
          character: 'Doran',
          aliases: [],
          voiceId: 'v-doran',
          voiceLabel: 'Designed voice',
          engine: 'qwen',
          voiceKind: 'designed',
          firstBookId: 'sb',
          lastBookId: 'cc',
          bookIndices: [1, 3],
          carriedFullSpan: false,
          totalLines: 155,
        },
      ],
    },
  },
};
```

Replace the final `};` (end of the `MOCK_SERIES_MEMORY` object, after the Northern Coast entry's closing `},`) — i.e. add a second top-level key — so the file ends with:

```ts
  },
  /* Marketing/wiki series-memory screenshots — the Hollow Tide series
     (hollow-tide.ts). Carried cast = the three `usedIn: 3` recurring voices
     in HOLLOW_TIDE_VOICES (hollow-tide.ts:790-823): Narrator, Insp. Cray, Dr.
     Wren, all designed in Book 1 and carried into Book 2. Kept consistent
     with HOLLOW_TIDE_LIBRARY's series.seriesMemory summary (hollow-tide.ts) —
     same carriedCount (3), same confirmedBookCount (2) — see
     hollow-tide.test.ts for the assertion that locks the two together. */
  'Marin Vale::The Hollow Tide': {
    series: {
      confirmedBookCount: 2,
      spanBooks: 4,
      books: [
        { bookId: 'hollow-tide-1', title: 'The Drowning Bell', index: 1, principalCount: 7 },
        { bookId: 'hollow-tide-2', title: 'Saltgrave',         index: 2, principalCount: 6 },
      ],
    },
    carried: {
      count: 3,
      bespokeCount: 0,
      designedCount: 0,
      // Ordered by totalLines desc, matching the Northern Coast entry's convention.
      characters: [
        {
          character: 'Narrator',
          aliases: [],
          voiceId: 'v_marin_narrator',
          voiceLabel: 'Warm · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-2',
          bookIndices: [1, 2],
          carriedFullSpan: true,
          totalLines: 610,
        },
        {
          character: 'Insp. Cray',
          aliases: [],
          voiceId: 'v_marin_cray',
          voiceLabel: 'Informative · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-2',
          bookIndices: [1, 2],
          carriedFullSpan: true,
          totalLines: 480,
        },
        {
          character: 'Dr. Wren',
          aliases: [],
          voiceId: 'v_marin_wren',
          voiceLabel: 'Breezy · Gemini',
          engine: 'gemini',
          voiceKind: 'preset',
          firstBookId: 'hollow-tide-1',
          lastBookId: 'hollow-tide-2',
          bookIndices: [1, 2],
          carriedFullSpan: true,
          totalLines: 355,
        },
      ],
    },
  },
};
```

(The Northern Coast Trilogy entry above it is untouched — this only adds a second key to the same object.)

- [ ] **Step 3: Write the consistency test**

Open `src/mocks/marketing/hollow-tide.test.ts`. Add `MOCK_SERIES_MEMORY` to its imports — find:

```ts
import { describe, it, expect } from 'vitest';
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
  HOLLOW_TIDE_POSED,
  HOLLOW_TIDE_VOICES,
  HOLLOW_TIDE_CONTINUE,
  HOLLOW_TIDE_LISTEN_PROGRESS,
} from './hollow-tide';
```

Replace with:

```ts
import { describe, it, expect } from 'vitest';
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
  HOLLOW_TIDE_POSED,
  HOLLOW_TIDE_VOICES,
  HOLLOW_TIDE_CONTINUE,
  HOLLOW_TIDE_LISTEN_PROGRESS,
} from './hollow-tide';
import { MOCK_SERIES_MEMORY } from '../series-memory';
```

Append a new `describe` block at the end of the file (after the final closing `});`):

```ts

describe('Hollow Tide series-memory fixture (marketing/wiki screenshots)', () => {
  it('the library chip summary and the detail resolver entry agree with each other', () => {
    const marin = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Marin Vale');
    const series = marin!.series.find((s) => s.name === 'The Hollow Tide');
    const summary = series?.seriesMemory;
    const detail = MOCK_SERIES_MEMORY['Marin Vale::The Hollow Tide'];

    expect(summary).toBeDefined();
    expect(detail).toBeDefined();

    // The chip's headline count must match the reveal panel's actual roster —
    // nothing keeps these two hand-authored fixtures in sync automatically.
    expect(summary!.carriedCount).toBe(detail.carried.count);
    expect(summary!.carriedCount).toBe(detail.carried.characters.length);
    expect(summary!.confirmedBookCount).toBe(detail.series.confirmedBookCount);
    expect(summary!.spanBooks).toBe(detail.series.spanBooks);
  });

  it('every carried character is a real Hollow Tide voice, not a leftover Northern Coast name', () => {
    const detail = MOCK_SERIES_MEMORY['Marin Vale::The Hollow Tide'];
    const hollowTideVoiceIds = new Set(HOLLOW_TIDE_VOICES.voices.map((v) => v.id));
    for (const c of detail.carried.characters) {
      expect(hollowTideVoiceIds.has(c.voiceId)).toBe(true);
    }
    // None of the Northern Coast Trilogy's invented ids leaked in.
    const northernCoastIds = ['narrator', 'v-carrick', 'v-mara', 'v-doran'];
    for (const c of detail.carried.characters) {
      expect(northernCoastIds).not.toContain(c.voiceId);
    }
  });

  it('the detail entry’s book ids/titles match the real HOLLOW_TIDE_LIBRARY entries', () => {
    const marin = HOLLOW_TIDE_LIBRARY.authors.find((a) => a.name === 'Marin Vale');
    const series = marin!.series.find((s) => s.name === 'The Hollow Tide');
    const detail = MOCK_SERIES_MEMORY['Marin Vale::The Hollow Tide'];
    for (const b of detail.series.books) {
      const real = series?.books.find((rb) => rb.bookId === b.bookId);
      expect(real).toBeDefined();
      expect(real!.title).toBe(b.title);
    }
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- hollow-tide --run`
Expected: PASS — all existing tests in the file plus the 3 new ones.

- [ ] **Step 5: Run the full frontend suite to confirm no regressions**

Run: `npm test -- --run`
Expected: same pass count as the branch baseline plus the 3 new tests, no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/mocks/marketing/hollow-tide.ts src/mocks/series-memory.ts src/mocks/marketing/hollow-tide.test.ts
git commit -m "feat(mocks): add Hollow Tide series-memory fixture for marketing screenshots"
```

---

### Task 3: QA report card mixed-data fixture (v1.11 receipt story)

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api-demo-capture.test.ts`

**Interfaces:**
- Consumes: `HOLLOW_TIDE_DRIFT_EVENTS` (already imported in `api.ts:76`, defined in `hollow-tide.ts:965`, two events: `insp-cray`/chapter 2/severe, `dr-wren`/chapter 5/moderate).
- Produces: `api.getQaReport('hollow-tide-2')` returns a realistic mixed-result `BookQaReport` under `DEMO_CAPTURE`; every other bookId, and every mode without `DEMO_CAPTURE`, still returns the existing `MOCK_QA_REPORT` (all-clean) unchanged — consumed by Task 4's `qa-report-card` scene.

**Verified gap**: `mockGetQaReport` (`api.ts:2108-2110`) unconditionally returns `MOCK_QA_REPORT` — the same all-zero, all-clean report (`src/data/qa-report.ts`) — for every bookId, in every mode, with no `DEMO_CAPTURE` awareness at all. Capturing the `qa-report-card` scene against it today would produce exactly the "all-clean placeholder" screenshot the spec's Verification section already said to avoid. This task adds a `DEMO_CAPTURE` branch reusing `HOLLOW_TIDE_DRIFT_EVENTS` for `configDrift.events` — the same two drift events the existing `voice-drift-report` scene already shows for this book — so the QA receipt and the voice-drift modal tell one consistent story for Saltgrave (`hollow-tide-2`), the same book the existing `chapter-suspect`/`preview-flagged` scenes already use for chapter 7's acoustic/content flags.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/api-demo-capture.test.ts` (inside the existing `describe('DEMO_CAPTURE-gated api.ts mocks (#1286 Quality Gate marketing screenshots)', ...)` block, after its last existing test, before the closing `});`):

```ts

  it('mockGetQaReport: hollow-tide-2 gets a realistic mixed report under DEMO_CAPTURE', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const report = await api.getQaReport('hollow-tide-2');
    expect(report.bookId).toBe('hollow-tide-2');
    expect(report.acoustic.linesRerecorded).toBeGreaterThan(0);
    expect(report.asr.linesFlaggedDrift).toBeGreaterThan(0);
    expect(report.configDrift.counts.severe).toBe(1);
    expect(report.configDrift.counts.moderate).toBe(1);
    expect(report.configDrift.events.map((e) => e.characterId)).toEqual(['insp-cray', 'dr-wren']);
    expect(report.voiceDrift.mismatches.length).toBeGreaterThan(0);
  });

  it('mockGetQaReport: every other book keeps the all-clean MOCK_QA_REPORT under DEMO_CAPTURE', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const report = await api.getQaReport('hollow-tide-1');
    expect(report.configDrift.counts).toEqual({ mild: 0, moderate: 0, severe: 0 });
    expect(report.acoustic.linesRerecorded).toBe(0);
  });

  it('mockGetQaReport: the override never fires outside DEMO_CAPTURE', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '0');
    const { api } = await import('./api');

    const report = await api.getQaReport('hollow-tide-2');
    expect(report.configDrift.counts).toEqual({ mild: 0, moderate: 0, severe: 0 });
    expect(report.acoustic.linesRerecorded).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- api-demo-capture --run`
Expected: FAIL — the first new test fails (`mockGetQaReport` always returns the all-clean `MOCK_QA_REPORT`, so `linesRerecorded`/`linesFlaggedDrift` are `0` and `configDrift.events` is `[]`).

- [ ] **Step 3: Implement the `mockGetQaReport` override**

Find (in `src/lib/api.ts`, ~line 2108) — this is the exact current content:

```ts
async function mockGetQaReport(_bookId: string): Promise<BookQaReport> {
  return MOCK_QA_REPORT;
}
```

Replace with:

```ts
/* Quality Gate marketing/wiki screenshots — a realistic mixed report for
   Saltgrave (hollow-tide-2), reusing the SAME two drift events the
   voice-drift-report scene already shows for this book, so the QA receipt
   and the drift modal agree with each other rather than telling two
   different stories about the same book. */
const HOLLOW_TIDE_QA_REPORT: BookQaReport = {
  bookId: 'hollow-tide-2',
  generatedAt: '2026-06-12T09:00:00.000Z',
  chaptersRendered: 7,
  chaptersTotal: 11,
  totalLines: 640,
  acoustic: { linesChecked: 640, linesRerecorded: 5, chaptersFlagged: 1 },
  asr: { linesVerified: 640, linesFlaggedDrift: 2 },
  voiceDrift: {
    attribution: 'full',
    chaptersEligible: 7,
    chaptersScored: 7,
    chaptersEmbedFailed: 0,
    charactersOnRoster: 6,
    charactersChecked: 6,
    mismatches: [{ characterId: 'insp-cray', chapterId: 2, fixable: true }],
    inconclusiveCount: 0,
    uncheckedCharacterIds: [],
  },
  configDrift: {
    // Derived from HOLLOW_TIDE_DRIFT_EVENTS rather than hand-typed, so the
    // counts can never silently drift from the events list they summarize —
    // the same "two hand-authored fixtures with no sync guard" hazard Task 2's
    // seriesMemory/MOCK_SERIES_MEMORY consistency test exists to prevent.
    counts: {
      mild: HOLLOW_TIDE_DRIFT_EVENTS.filter((e) => e.severity === 'mild').length,
      moderate: HOLLOW_TIDE_DRIFT_EVENTS.filter((e) => e.severity === 'moderate').length,
      severe: HOLLOW_TIDE_DRIFT_EVENTS.filter((e) => e.severity === 'severe').length,
    },
    events: HOLLOW_TIDE_DRIFT_EVENTS,
  },
};

async function mockGetQaReport(bookId: string): Promise<BookQaReport> {
  if (DEMO_CAPTURE && bookId === 'hollow-tide-2') return HOLLOW_TIDE_QA_REPORT;
  return MOCK_QA_REPORT;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- api-demo-capture --run`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Run the full frontend suite to confirm no regressions**

Run: `npm test -- --run`
Expected: same pass count as the branch baseline (after Task 2) plus the 3 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/lib/api-demo-capture.test.ts
git commit -m "feat(frontend): DEMO_CAPTURE mixed QA report for the marketing capture"
```

---

### Task 4: Five new marketing-capture scenes

**Files:**
- Modify: `e2e/marketing/scenes.ts`

**Interfaces:**
- Consumes: Task 1's `instruct` fixture (sentence 107), Task 2's `series-memory-chip` render gate + `SeriesMemoryReveal`/`ShareCardModal` flow, Task 3's `HOLLOW_TIDE_QA_REPORT`, and the existing `pin-higher-quality` button/dialog (`src/views/cast.tsx:773-778`, `:1562-1575` — already live, no change needed there).
- Produces: five new `Scene` entries the capture harness picks up automatically (no other file references these — `capture.spec.ts` iterates `SCENES`).

New scene additions to `e2e/marketing/scenes.ts` are **not unit-tested** — this matches the file's existing convention (60+ prior scene rows, none unit-tested; verified only by actually running the capture and reading the resulting PNG, which is Task 6 below).

- [ ] **Step 1: Add the five scenes**

Append to the `SCENES` array in `e2e/marketing/scenes.ts`, before the closing `];`:

```ts
  {
    /* v1.11 book-level QA receipt (src/components/qa-report-card.tsx),
       shown on the Listen view once a book has rendered. Uses hollow-tide-2
       (Saltgrave) so the receipt's mixed figures agree with the same book's
       existing chapter-suspect/voice-drift-report/preview-flagged scenes
       (Task 3's HOLLOW_TIDE_QA_REPORT reuses HOLLOW_TIDE_DRIFT_EVENTS). No
       action needed — the Listen view calls useQaReport(bookId) with the
       route's own bookId (src/views/listen.tsx), the same per-book routing
       every other book-scoped scene in this file already relies on. */
    id: 'qa-report-card',
    hash: '#/books/hollow-tide-2/listen',
    viewports: ['desktop'],
    waitFor: 'text=Quality gate',
  },
  {
    /* Emotion + delivery-direction story — a single line (Coalfall ch.4,
       sentence 107) carrying both chips filled in: the emotion chip
       (already-existing fixture data) and the new instruct chip (Task 1's
       fixture patch). Passive load, no action needed.

       NOT `[data-sentence-id="107"] [data-testid="instruct-chip"]` — the
       chip is rendered as a SIBLING of the `data-sentence-id` span, not a
       descendant (sentence-instruct-control.tsx / manuscript.tsx's own
       comment: chips sit outside the text span deliberately, so they never
       perturb the selection→split offset math). A descendant selector can
       never match. Instead target the chip's own aria-label, which bakes in
       Task 1's exact instruct text — unambiguous regardless of DOM nesting. */
    id: 'manuscript-emotion-direction',
    hash: '#/books/coalfall-commission/manuscript?chapter=4',
    viewports: ['desktop'],
    waitFor: '[aria-label="Delivery direction: shouted from across the yard, half-laughing — edit"]',
    scrollTo: '[data-sentence-id="107"]',
  },
  {
    /* Higher-quality tier story — the bulk "Pin higher quality" flow
       (cast.tsx:773, visible whenever the book has any Qwen cast members;
       Saltgrave does). Captures the confirm dialog, not just the button. */
    id: 'cast-pin-higher-quality',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    waitFor: '[data-testid^="cast-row-"]',
    action: async (page) => {
      await page.getByTestId('pin-higher-quality').click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Pin 1.7B quality to all Qwen cast?',
    strict: true,
  },
  {
    /* Series memory — "N books in, not a voice changed" reveal panel,
       opened from the library shelf's series-memory-chip (Task 2's fixture
       fix is what makes this chip render at all under DEMO_CAPTURE).

       Depends on the library rendering in CARD view, not table view — the
       chip only exists in library-grid.tsx, never library-table.tsx
       (book-library.tsx:228's effectiveViewMode reads a persisted
       localStorage value, defaulting to 'card' on the empty storage a fresh
       Playwright context always has). This holds today; if that default or
       a persisted value ever flips to 'table', this scene and
       series-share-card below silently stop finding the chip. */
    id: 'series-memory-reveal',
    hash: '#/',
    viewports: ['desktop'],
    waitFor: '[data-testid="series-memory-chip"]',
    action: async (page) => {
      await page.getByTestId('series-memory-chip').click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=books in, and not a voice has changed',
    strict: true,
  },
  {
    /* Series memory — the shareable portrait card (ShareCardModal / +
       SeriesShareCard), opened from the reveal panel's "Share this cast"
       button. Same chip + fixture dependency as series-memory-reveal above. */
    id: 'series-share-card',
    hash: '#/',
    viewports: ['desktop'],
    waitFor: '[data-testid="series-memory-chip"]',
    action: async (page) => {
      await page.getByTestId('series-memory-chip').click({ timeout: 5000 });
      await page.waitForSelector('text=books in, and not a voice has changed', { timeout: 5000 });
      await page.getByRole('button', { name: 'Share this cast' }).click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Download image',
    strict: true,
  },
```

- [ ] **Step 2: Smoke-run each new scene once**

Run, one at a time:

```bash
CAPTURE_SCENE=qa-report-card npm run capture:marketing
CAPTURE_SCENE=manuscript-emotion-direction npm run capture:marketing
CAPTURE_SCENE=cast-pin-higher-quality npm run capture:marketing
CAPTURE_SCENE=series-memory-reveal npm run capture:marketing
CAPTURE_SCENE=series-share-card npm run capture:marketing
```

Expected: each run reports a passing Playwright test and writes both `<id>.desktop.light.png` and `<id>.desktop.dark.png` into `mockups/marketing-screens/`. Per `e2e/marketing/README.md` and `capture.spec.ts`'s own best-effort `try/catch`, a green run here proves the `action`/`waitFor` selectors resolved — it does **not** prove the screenshot shows the right content. Do not treat this step as the verification pass; that's Task 6.

- [ ] **Step 3: Commit**

```bash
git add e2e/marketing/scenes.ts
git commit -m "feat(e2e): add five marketing-capture scenes for the four approved stories"
```

---

### Task 5: Staging script + test

**Files:**
- Create: `scripts/stage-marketing-screenshots.mjs`
- Create: `scripts/tests/stage-marketing-screenshots.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: PNG files from `mockups/marketing-screens/<scene>.<viewport>.<theme>.png` (produced by `npm run capture:marketing`).
- Produces: `.webp` files in `brand/go-to-market/launch-post-images/marketing-site/screenshots/<output>.webp` / `<output>-dark.webp`. Exports `MANIFEST` (the curated scene→output mapping) and `stagingPlan(manifest, sourceDir, destDir)` (a pure function mapping each manifest entry to its two `{src, dest}` pairs) for the test to exercise without needing ffmpeg or real files — same shape as `scripts/build-release-zip.mjs`'s `MANIFEST`/`matchesManifest` exports, tested by `scripts/tests/release-manifest.test.mjs`.

This script covers **only** Playwright-scene-sourced screenshots — the site's existing `companion-iphone`/`companion-pixel` entries (produced by the separate `scripts/capture-companion.mjs` pipeline) are explicitly **out of scope** here and are left untouched on disk; this pass doesn't add a new companion story, so there's nothing to re-stage for them.

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/stage-marketing-screenshots.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MANIFEST, stagingPlan } from '../stage-marketing-screenshots.mjs';

test('stagingPlan produces one light + one dark pair per manifest entry', () => {
  const plan = stagingPlan(MANIFEST, '/src', '/dest');
  assert.equal(plan.length, MANIFEST.length * 2);
});

test('stagingPlan maps a scene id + viewport to the correct source path and output filename', () => {
  const plan = stagingPlan(
    [{ output: 'library', scene: 'library-shelf', viewport: 'desktop' }],
    '/src',
    '/dest',
  );
  assert.deepEqual(plan, [
    {
      src: path.join('/src', 'library-shelf.desktop.light.png'),
      dest: path.join('/dest', 'library.webp'),
    },
    {
      src: path.join('/src', 'library-shelf.desktop.dark.png'),
      dest: path.join('/dest', 'library-dark.webp'),
    },
  ]);
});

test('the manifest has an entry for every scene this pass captures for the four approved stories (3 pre-existing, re-captured only + 5 brand-new from Task 4 + 2 language scenes, re-captured only)', () => {
  const storySceneIds = [
    'chapter-suspect',
    'voice-drift-report',
    'preview-flagged',
    'qa-report-card',
    'language-detect-russian',
    'language-cast-confirm-german',
    'manuscript-emotion-direction',
    'cast-pin-higher-quality',
    'series-memory-reveal',
    'series-share-card',
  ];
  for (const id of storySceneIds) {
    assert.ok(
      MANIFEST.some((e) => e.scene === id),
      `manifest is missing an entry for scene "${id}"`,
    );
  }
});

test('the manifest has no duplicate output names', () => {
  const outputs = MANIFEST.map((e) => e.output);
  assert.equal(new Set(outputs).size, outputs.length);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/stage-marketing-screenshots.test.mjs`
Expected: FAIL — `scripts/stage-marketing-screenshots.mjs` doesn't exist yet (module not found).

- [ ] **Step 3: Write the script**

Create `scripts/stage-marketing-screenshots.mjs`:

```js
#!/usr/bin/env node
/* Converts the curated subset of mockups/marketing-screens/ (produced by
   `npm run capture:marketing`) to webp and stages both theme variants into
   brand/go-to-market/launch-post-images/marketing-site/screenshots/ — the
   folder mirrored into the separate Castwright-Website repo's
   public/screenshots/. Replaces the ad hoc process used before this script
   existed; re-run after any capture-rail change instead of hand-converting.

   Out of scope: companion-app screenshots (scripts/capture-companion.mjs is
   a separate pipeline) — not touched here. */

import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'mockups', 'marketing-screens');
const DEST_DIR = path.join(
  ROOT,
  'brand',
  'go-to-market',
  'launch-post-images',
  'marketing-site',
  'screenshots',
);

// scene/viewport → output filename. Every entry is staged in BOTH themes:
// `<output>.webp` (light) and `<output>-dark.webp` (dark).
export const MANIFEST = [
  // --- Existing curated set (re-staged for freshness; stale since mid-June) ---
  { output: 'library', scene: 'library-shelf', viewport: 'desktop' },
  { output: 'library-full', scene: 'library-shelf-full', viewport: 'desktop' },
  { output: 'cast', scene: 'coalfall-cast', viewport: 'desktop' },
  { output: 'cast-reuse', scene: 'cast-reuse', viewport: 'desktop' },
  { output: 'coalfall-manuscript', scene: 'coalfall-manuscript', viewport: 'desktop' },
  { output: 'generate', scene: 'generating', viewport: 'desktop' },
  { output: 'listen', scene: 'listen', viewport: 'desktop' },
  { output: 'listen-phone', scene: 'listen', viewport: 'phone' },
  { output: 'listen-tablet', scene: 'listen', viewport: 'tablet' },
  { output: 'continue-listening', scene: 'continue-listening', viewport: 'desktop' },
  { output: 'continue-listening-phone', scene: 'continue-listening', viewport: 'phone' },
  { output: 'continue-listening-tablet', scene: 'continue-listening', viewport: 'tablet' },
  { output: 'voice-library', scene: 'voice-library', viewport: 'desktop' },
  // --- New story-driven additions (this pass) ---
  { output: 'quality-gate-suspect-chapter', scene: 'chapter-suspect', viewport: 'desktop' },
  { output: 'quality-gate-voice-drift', scene: 'voice-drift-report', viewport: 'desktop' },
  { output: 'quality-gate-preview-flagged', scene: 'preview-flagged', viewport: 'desktop' },
  { output: 'quality-gate-report-card', scene: 'qa-report-card', viewport: 'desktop' },
  { output: 'language-detect-russian', scene: 'language-detect-russian', viewport: 'desktop' },
  {
    output: 'language-cast-confirm-german',
    scene: 'language-cast-confirm-german',
    viewport: 'desktop',
  },
  {
    output: 'emotion-delivery-direction',
    scene: 'manuscript-emotion-direction',
    viewport: 'desktop',
  },
  { output: 'cast-pin-higher-quality', scene: 'cast-pin-higher-quality', viewport: 'desktop' },
  { output: 'series-memory-reveal', scene: 'series-memory-reveal', viewport: 'desktop' },
  { output: 'series-share-card', scene: 'series-share-card', viewport: 'desktop' },
];

// Pure — no filesystem access — so the test can exercise it without real files.
export function stagingPlan(manifest = MANIFEST, sourceDir = SOURCE_DIR, destDir = DEST_DIR) {
  const plan = [];
  for (const entry of manifest) {
    for (const theme of ['light', 'dark']) {
      const src = path.join(sourceDir, `${entry.scene}.${entry.viewport}.${theme}.png`);
      const destName = theme === 'dark' ? `${entry.output}-dark.webp` : `${entry.output}.webp`;
      plan.push({ src, dest: path.join(destDir, destName) });
    }
  }
  return plan;
}

function main() {
  mkdirSync(DEST_DIR, { recursive: true });
  const plan = stagingPlan();
  let missing = 0;
  let failed = 0;
  for (const { src, dest } of plan) {
    if (!existsSync(src)) {
      console.warn(`[stage-marketing-screenshots] missing source, skipped: ${src}`);
      missing++;
      continue;
    }
    const result = spawnSync('ffmpeg', ['-y', '-i', src, '-quality', '85', dest], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(`[stage-marketing-screenshots] ffmpeg failed for ${src}`);
      failed++;
    }
  }
  const staged = plan.length - missing - failed;
  console.log(
    `[stage-marketing-screenshots] staged ${staged}/${plan.length} files into ${DEST_DIR}`,
  );
  if (missing > 0 || failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/tests/stage-marketing-screenshots.test.mjs`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Add the `npm run` convenience script**

In `package.json`, find the `"scripts"` entry for `"capture:marketing"`:

```json
    "capture:marketing": "playwright test --config=playwright.marketing.config.ts --project=desktop",
```

Add a new line immediately after it:

```json
    "capture:marketing": "playwright test --config=playwright.marketing.config.ts --project=desktop",
    "stage:marketing-screenshots": "node scripts/stage-marketing-screenshots.mjs",
```

- [ ] **Step 6: Run the full scripts test suite to confirm no regressions**

Run: `npm run test:hooks`
Expected: PASS — same tests as the branch baseline plus the new `stage-marketing-screenshots.test.mjs` file (auto-discovered via the existing `node --test scripts/tests/*.test.mjs` glob).

- [ ] **Step 7: Commit**

```bash
git add scripts/stage-marketing-screenshots.mjs scripts/tests/stage-marketing-screenshots.test.mjs package.json
git commit -m "chore(scripts): add marketing-screenshot staging script"
```

---

### Task 6: Full capture run, staging, and manual PNG verification

**Files:** none (execution + verification only; `mockups/marketing-screens/` and `brand/go-to-market/...` are both git-ignored, so nothing here is committed).

This task is the real gate. Per the spec's Verification section, `capture.spec.ts`'s best-effort `try/catch` means a green Playwright run proves selectors resolved, not that the screenshot shows the right content — and a scene can capture green with *plausible but wrong* data (the exact failure mode Task 2's fixture fix was written to avoid). Every claim below must be checked by actually reading the PNG (the Read tool supports images), not inferred from the capture run's exit code.

- [ ] **Step 1: Run the full capture set**

Run: `npm run capture:marketing`
Expected: all scenes (including the 5 new ones from Task 4) pass, producing `<id>.desktop.{light,dark}.png` for every desktop-only scene and additional `.phone.*`/`.tablet.*` files for multi-viewport scenes, in `mockups/marketing-screens/`.

- [ ] **Step 2: Run the staging script**

Run: `npm run stage:marketing-screenshots`
Expected: reports `staged 46/46 files into ...` (23 manifest entries × light + dark) with zero `missing source` warnings, and `brand/go-to-market/launch-post-images/marketing-site/screenshots/` now contains 46 `.webp` files.

- [ ] **Step 3: Verify the Quality Gate scenes**

Read `brand/go-to-market/launch-post-images/marketing-site/screenshots/quality-gate-suspect-chapter.webp` and confirm: chapter 7's row shows a visible Suspect badge, the expanded strip shows two distinct amber bands, and the caption reads "2 issues to review" (plural).

Read `quality-gate-voice-drift.webp` and confirm: both Insp. Cray (Severe, with an "Auto-regen" pill) and Dr. Wren (Moderate, "Regenerate" pill) are visible in the modal.

Read `quality-gate-preview-flagged.webp` and confirm: the mini-player's scrubber shows a visible amber issue band.

Read `quality-gate-report-card.webp` and confirm: the card shows non-zero figures for acoustic re-records, ASR drift flags, and cast-continuity (severe + moderate pills) — not an all-clean "Every line held." headline.

If any of these four fail, fix the underlying scene/fixture (do not just re-run and hope) and repeat Steps 1-2 before proceeding.

- [ ] **Step 4: Verify the language scenes**

Read `language-detect-russian.webp` and confirm the "Auto-detected Russian — verify" chip is visible.

Read `language-cast-confirm-german.webp` and confirm the cast-confirmation rows show German character names.

- [ ] **Step 5: Verify the emotion/higher-quality scenes**

Read `emotion-delivery-direction.webp` and confirm the flagged line (chapter 4, "Sela!") shows **both** a filled emotion chip and a filled delivery-direction chip with visible preview text — not the empty emoji placeholder for either.

Read `cast-pin-higher-quality.webp` and confirm the "Pin 1.7B quality to all Qwen cast?" confirm dialog is in frame, not just the triggering button.

- [ ] **Step 6: Verify the series-memory scenes — the check that matters most**

Read `series-memory-reveal.webp` and confirm:
- The headline reads "Two books in, and not a voice has changed."
- All three carried characters — Narrator, Insp. Cray, Dr. Wren — are listed, not a Northern-Coast-Trilogy name (Carrick/Mara/Doran) left over from a copy-paste.
- The book-presence dots reflect exactly 2 books.

Read `series-share-card.webp` and confirm the same three names appear on the exportable card, with a book/voice count consistent with the reveal panel (2 books, 3 voices) — not a mismatched number between the chip, the reveal, and the card.

If either fails, the fixture fix in Task 2 is wrong — re-check the two edits and their consistency test before re-running the capture.

- [ ] **Step 7: Spot-check the dark variants**

Steps 3-6 above only read the light `.webp` for each new/changed scene. Read the `-dark` counterpart for the four highest-risk ones — `quality-gate-report-card-dark.webp`, `emotion-delivery-direction-dark.webp`, `series-memory-reveal-dark.webp`, `series-share-card-dark.webp` — and confirm the same content is legible in dark mode: no chip, badge, or text rendering invisible-on-invisible (e.g. a dark-on-dark chip), and no clipping specific to the dark theme's layout. If any of the four look wrong in dark, the light-mode confirmation above does not carry over automatically — fix and re-run before proceeding.

- [ ] **Step 8: Note anything dropped**

If any scene's screenshot doesn't match its intended claim after a reasonable fix attempt, do not silently ship it — note it explicitly in Task 7's handover doc under "not covered by this pass" rather than letting a wrong or missing shot pass as done.

---

### Task 7: Handover doc + PR wrap-up

**Files:**
- Create: `brand/go-to-market/marketing-screenshots-handover-2026-07-08.md` (git-ignored, matching the rest of `brand/` — not committed)

**Interfaces:** none — this is the terminal, human-facing deliverable for a follow-up agent working in the separate `Castwright-Website` repo.

- [ ] **Step 1: Write the handover doc**

Create `brand/go-to-market/marketing-screenshots-handover-2026-07-08.md`:

```markdown
# Marketing screenshots refresh — handover for Castwright-Website

Source work: `docs/superpowers/plans/2026-07-08-marketing-screenshots-refresh.md`
in the product repo (branch `docs/docs-marketing-screenshots-refresh`).

## What's new in brand/go-to-market/launch-post-images/marketing-site/screenshots/

23 scenes × light/dark = 46 webp files, staged via
`npm run stage:marketing-screenshots`. The 4 new stories:

1. **Quality Gate + voice drift** — `quality-gate-suspect-chapter.webp`,
   `quality-gate-voice-drift.webp`, `quality-gate-preview-flagged.webp`,
   `quality-gate-report-card.webp` (+ `-dark` pairs).
2. **Five-language support** — `language-detect-russian.webp`,
   `language-cast-confirm-german.webp` (+ `-dark` pairs). Re-captured only;
   no new content since the roadmap copy for this story is already accurate.
3. **Emotion-aware voices + Higher-quality tier** —
   `emotion-delivery-direction.webp`, `cast-pin-higher-quality.webp`
   (+ `-dark` pairs).
4. **Series memory + shareable cast card** — `series-memory-reveal.webp`,
   `series-share-card.webp` (+ `-dark` pairs).

The remaining 13 manifest entries are re-captures of the existing curated set
(library, cast, generate, listen, continue-listening, voice-library, etc.) —
same content, refreshed pixels only (the app's UI has changed cosmetically
since the last capture — checkbox styling, Cast table spacing — per
`RELEASE_NOTES.md`'s v1.11.0 entries).

## Roadmap card to flip

`src/components/home/RoadmapSection.astro` — the **"A per-book quality
report"** card (currently `status: 'Planned'`) has shipped. Suggested
replacement copy, drawn from `RELEASE_NOTES.md`'s own v1.11.0 language rather
than reinvented: "Every book now carries a receipt — how many lines were
checked for a clean recording, how many were verified against what was
actually said, how many characters were checked against their own voice,
and what's changed in your cast since you rendered." Pair with
`quality-gate-report-card.webp`.

## Suggested screenshot placements

- `quality-gate-*` four shots → a new "The Quality Gate" section on
  `/features`, or replacing the flipped roadmap card above.
- `emotion-delivery-direction.webp` / `cast-pin-higher-quality.webp` → a new
  section covering emotion-aware voices + the Higher-quality tier — this
  story has **zero** current site presence (not even a roadmap card),
  despite shipping as a headline v1.10.0 feature.
- `series-memory-reveal.webp` / `series-share-card.webp` → check whether the
  existing series-spotlight section (added per an earlier round of website
  work, per `RELEASE_NOTES.md`/product memory) already covers this, or needs
  its own section — the strong, distinctive "twelve books in, not a voice
  changed" proof-point deserves prominent placement either way.
- `language-*` shots → re-place into whatever section currently shows the
  language story; no copy change needed there.

## Explicitly NOT covered by this pass

- Multi-GPU per-model placement — not screenshotted, no copy change.
- Offline/local voice design (no cloud key) — not screenshotted, no copy
  change. Worth considering as a "runs fully offline" differentiator in a
  future pass.
- Non-verbal sounds (gasps/sighs/laughs), custom stage directions beyond the
  single example line, number/date normalization — no dedicated shots;
  `emotion-delivery-direction.webp` gives a taste of the delivery-direction
  half only.
- castwright.local naming / one-click cert renewal / device pairing — not
  in this pass; existing companion/LAN screenshots (`companion-iphone.webp`
  etc., untouched by this script) may already partially cover the story.
```

- [ ] **Step 2: Run the branch-scoped verify battery**

Run: `npm run verify:fast:branch`
Expected: PASS (lint, typecheck, config:check, test:hooks, test, test:server, build — each scope-gated to what this branch's diff touches; `test:sidecar` is scoped out since nothing under `server/tts-sidecar/` changed).

- [ ] **Step 3: File the GitHub issue and open the PR**

Check first whether an issue already covers this work; if not, file one (`type:chore` + `area:frontend`, since this is tooling/marketing infra with a real, if modest, code change — not a bug). Then:

```bash
git push -u origin docs/docs-marketing-screenshots-refresh
gh pr create --title "chore(frontend): refresh marketing screenshots for four post-v1.9.0 stories" --body "$(cat <<'EOF'
## Summary
- Adds five new e2e/marketing capture scenes (QA report card, emotion+delivery-direction, higher-quality tier pin, series-memory reveal + share card) and two additive DEMO_CAPTURE-gated fixture fixes (series-memory two-part fix, QA report mixed data) so the marketing capture set covers four shipped-but-unrepresented stories: Quality Gate + voice drift, five-language support, emotion-aware voices + Higher-quality tier, and series memory.
- Adds a manifest-driven staging script (scripts/stage-marketing-screenshots.mjs) replacing the prior ad hoc PNG-to-webp process, and stages a refreshed 46-file screenshot set into brand/go-to-market/launch-post-images/marketing-site/screenshots/ (git-ignored).
- Leaves a handover doc for a follow-up agent to update the separate Castwright-Website repo's copy/placement — no changes to that repo in this PR.

## Test plan
- [ ] npm run verify:fast:branch green
- [ ] Every new/changed screenshot visually confirmed against its specific claim (Task 6)

Closes #NN
EOF
)"
```

(Replace `#NN` with the real issue number.)

- [ ] **Step 4: Request the mandatory code-review gate**

Per this plan's Global Constraints and `.claude/skills/model-routing/SKILL.md`: this PR is multi-scope (`e2e`, `mocks`, `scripts`, `frontend`), not docs-only — run the `code-review` skill at **`high`** effort before merge. Triage and fix any correctness findings; a fix commit re-triggers one re-review round, per the skill's own re-review rule.

- [ ] **Step 5: Surface the result**

In the end-of-turn summary: branch name, PR link, and a one-line pointer to the handover doc's location (`brand/go-to-market/marketing-screenshots-handover-2026-07-08.md`, git-ignored — the user needs to read it locally or paste its content into the follow-up Castwright-Website session, since it isn't committed anywhere).
