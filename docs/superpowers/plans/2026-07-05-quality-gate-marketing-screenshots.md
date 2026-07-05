# Quality Gate — real screenshots + comprehensive wiki coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real, dual-purposed (wiki + marketing) screenshots for the Quality Gate's acoustic/ASR segment gates and the voice-drift detector, and rewrite `docs/wiki/The-Quality-Gate.md` to comprehensively and honestly document both, closing issue #1286.

**Architecture:** Additive `DEMO_CAPTURE`-gated mock-data changes only (Saltgrave chapter 3 fixture + two `src/lib/api.ts` mock functions) — zero production code paths touched. Three new Playwright marketing-capture scenes drive real screenshots off that data, which get embedded in the wiki alongside a brand-voiced prose rewrite.

**Tech Stack:** TypeScript, Vitest (unit tests), Playwright (`e2e/marketing/capture.spec.ts`), Markdown (wiki).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-quality-gate-marketing-screenshots-design.md` (approved, 3 rounds of adversarial review, all Critical/Contradicted findings fixed). Every claim below cites the spec's already-verified source lines — do not re-derive them.
- `DEMO_CAPTURE` is `import.meta.env.VITE_DEMO_CAPTURE === '1'`, declared once in `src/lib/api.ts:93`. All new branches must gate on this constant, never a new flag.
- No change to non-`DEMO_CAPTURE` (dev mock mode) behavior. Every new branch must have a test proving the old behavior survives untouched.
- Marketing capture is excluded from `npm run verify` (it's a tool, not a regression gate) — but the new `api.ts` logic branches are real behavior and get real Vitest unit tests.
- `npm run wiki:sync` (pushes to the separate public `Castwright.wiki.git` remote) is **never** run without explicit user confirmation first — it's Task 6's last step and must pause for it.
- Branch: `docs/frontend-1286-quality-gate-screenshots`, worktree at `.worktrees/quality-gate-screenshots/` (already set up, baseline verified: typecheck clean, 4056/4075 tests passing — the 1 unhandled error is the known `tinypool` worker-exit flake, not a regression).
- PR body must include `Closes #1286`.

---

### Task 1: Saltgrave fixture data — flagged chapter + drift events

**Files:**
- Modify: `src/mocks/marketing/hollow-tide.ts`

**Interfaces:**
- Consumes: `DriftEvent` type (import from `../../lib/types`, alongside the existing `LibraryResponse, BookStateResponse, Character, Sentence, ContinueListeningItem` import).
- Produces: `HOLLOW_TIDE_DRIFT_EVENTS: DriftEvent[]` (new named export) and `BOOK2_CHAPTERS[2]` (chapter id 3, 0-indexed array position 2) carrying an `audioQa` field — both consumed by Task 2/3's `src/lib/api.ts` changes.

- [ ] **Step 1: Add `DriftEvent` to the existing type import**

Find this import near the top of `src/mocks/marketing/hollow-tide.ts`:

```ts
import type {
  LibraryResponse,
  BookStateResponse,
  Character,
  Sentence,
  ContinueListeningItem,
} from '../../lib/types';
```

Change to:

```ts
import type {
  LibraryResponse,
  BookStateResponse,
  Character,
  Sentence,
  ContinueListeningItem,
  DriftEvent,
} from '../../lib/types';
```

- [ ] **Step 2: Patch `BOOK2_CHAPTERS` to flag chapter 3 as Suspect**

Find:

```ts
const BOOK2_CHAPTERS = makeChapters(11);
```

Replace with:

```ts
/* Quality Gate marketing/wiki screenshots (#1286) — chapter 3 (already `done`,
   within the first 7 of 11 completedSlugs below) carries the advisory QA
   verdict the top-level "Suspect" pill checks (chapters-slice.ts:335). Ordered
   to match the segment override's chronological order added in api.ts (ASR
   content flag at [200,400), acoustic flag at [488,600)).

   `ChapterQaVerdict` (api-types.ts:3637-3651, generated from openapi.yaml)
   requires `measuredLufs`/`truePeakDb`/`durationSec`/`expectedSec`/`checkedAt`
   in addition to `status`/`reasons` — none are optional. `durationSec: 600`
   matches Task 2's forced totalSec for this chapter's audio; `checkedAt`
   reuses the file's existing `now` constant for internal consistency with
   every other stamped-at-generation-time field in this fixture. */
const BOOK2_CHAPTERS = makeChapters(11).map((c) =>
  c.id === 3
    ? {
        ...c,
        audioQa: {
          status: 'suspect' as const,
          reasons: [
            'Word substitution against the script',
            'Near-silent stretch before a line',
          ],
          measuredLufs: -19.2,
          truePeakDb: -1.4,
          durationSec: 600,
          expectedSec: 580,
          checkedAt: now,
        },
      }
    : c,
);
```

- [ ] **Step 3: Add the `HOLLOW_TIDE_DRIFT_EVENTS` export**

Append at the end of the file, after the `HOLLOW_TIDE_POSED` export:

```ts
/* ── Voice-drift fixture for Saltgrave (served under VITE_DEMO_CAPTURE=1) ──
   Quality Gate marketing/wiki screenshots (#1286). Two severities so the
   drift-report modal's severity grouping and Auto-regen control both show.
   Both chapters (2, 5) are within Saltgrave's 7 done chapters (see
   `completedSlugs` above). `autoQueueable` is a SERVER-set field
   (api-types.ts:3454 — "today: severity === 'severe'"), not client-derived,
   so the severe event must set it explicitly or the modal falls back to
   manual Regenerate. `onAutoQueueRegenerate` is already unconditionally
   wired to DriftReportModal in real app code (layout.tsx:1966) — no
   additional wiring needed for the Auto-regen control to render. */
export const HOLLOW_TIDE_DRIFT_EVENTS: DriftEvent[] = [
  {
    id: 'drift:hollow-tide-2:2:insp-cray:register',
    bookId: 'hollow-tide-2',
    characterId: 'insp-cray',
    chapterId: 2,
    chapterTitle: 'Chapter 2',
    severity: 'severe',
    factor: 'register',
    factorLabel: 'Vocabulary register',
    description:
      "Cray's register here reads far more formal than his established " +
      "dogged, plainspoken voice from Book 1 — likely a manuscript edit " +
      'sharpening his dialogue after this chapter rendered.',
    metrics: { current: 70, expected: 35, unit: 'formality' },
    snapshot: {
      voiceId: 'v_marin_cray', gender: 'male', ageRange: 'adult',
      tone: { warmth: 40, pace: 45, authority: 85, emotion: 50 },
      attributes: ['Male', 'Baritone', 'Northern English', '50s', 'Dogged'],
    },
    current: {
      name: 'Insp. Cray', voiceId: 'v_marin_cray', gender: 'male', ageRange: 'adult',
      tone: { warmth: 40, pace: 30, authority: 85, emotion: 30 },
      attributes: ['Male', 'Baritone', 'Northern English', '50s', 'Dogged'],
    },
    detected: '2 hr ago',
    suggestedAction: 'regenerate_chapter',
    autoQueueable: true,
  },
  {
    id: 'drift:hollow-tide-2:5:dr-wren:warmth',
    bookId: 'hollow-tide-2',
    characterId: 'dr-wren',
    chapterId: 5,
    chapterTitle: 'Chapter 5',
    severity: 'moderate',
    factor: 'warmth',
    factorLabel: 'Warmth',
    description:
      "Wren reads cooler here than her established precise-but-humane " +
      'profile — worth a listen before shipping.',
    metrics: { current: 40, expected: 58, unit: 'warmth score' },
    snapshot: {
      voiceId: 'v_marin_wren', gender: 'female', ageRange: 'adult',
      tone: { warmth: 58, pace: 40, authority: 60, emotion: 45 },
      attributes: ['Female', 'Mezzo', 'RP English', '40s', 'Precise'],
    },
    current: {
      name: 'Dr. Wren', voiceId: 'v_marin_wren', gender: 'female', ageRange: 'adult',
      tone: { warmth: 40, pace: 40, authority: 60, emotion: 45 },
      attributes: ['Female', 'Mezzo', 'RP English', '40s', 'Precise'],
    },
    detected: '1 hr ago',
    suggestedAction: 'review',
  },
];
```

- [ ] **Step 4: Typecheck (this is pure data — typecheck is the test)**

Run: `npm run typecheck`
Expected: no errors (confirms `DriftEvent`'s required fields are all present and the `audioQa`/`status: 'suspect'` literal narrows correctly).

- [ ] **Step 5: Commit**

```bash
git add src/mocks/marketing/hollow-tide.ts
git commit -m "feat(frontend): flag Saltgrave chapter 3 + add drift fixture for Quality Gate screenshots"
```

---

### Task 2: `mockGetChapterAudio` — real segment override for the flagged chapter

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api-demo-capture.test.ts` (new file — shared with Task 3)

**Interfaces:**
- Consumes: nothing new from Task 1 directly (this task doesn't touch chapter 3's `audioQa`, only its per-line audio segments — a separate data path, per the spec's "Fixture changes" section).
- Produces: `api.getChapterAudio({ bookId: 'hollow-tide-2', chapterId: 3 })` (under `DEMO_CAPTURE`) returns 4 segments where the 2 suspect ones carry `characterId: 'dockhand-remy'`/`'narrator'` and the two gate-flavor reason strings, at **fixed** timings (`start`/`end`) — see the duration bug below — regardless of what `duration` argument the caller passes. Every other `(bookId, chapterId)` pair is unaffected.

**Bug found during plan review, fixed in this task:** `src/components/mini-player.tsx:228` calls `api.getChapterAudio({ bookId, chapterId, duration: chapter.duration })` — unlike `ChapterSegmentStrip` (Task 4's `chapter-suspect` scene), it explicitly forwards `chapter.duration`. Saltgrave's chapters carry no `duration` field (`BOOK2_CHAPTERS = makeChapters(11)` without `{ withDuration: true }`), so `chapters-slice.ts`'s hydrate defaults it to `'00:00'` (`duration: c.duration ?? '00:00'`). `'00:00' || '10:00'` evaluates to `'00:00'` (a non-empty string is truthy), so `parseDuration('00:00')` would make `totalSec = 0` — and `deriveIssues` in `src/lib/chapter-issues.ts` explicitly guards `if (!dur || dur <= 0 || ...) return [];`. Without a fix, Task 4's `preview-flagged` scene (which goes through the mini-player) would silently render **zero** issues and no amber band, while Task 4's `chapter-suspect` scene (which goes through `ChapterSegmentStrip`, passing no `duration`) would work fine — a scene-dependent, silent break. Fix: the override forces `totalSec = 600` unconditionally for the flagged chapter, ignoring whatever `duration` was passed.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/api-demo-capture.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

describe('DEMO_CAPTURE-gated api.ts mocks (#1286 Quality Gate marketing screenshots)', () => {
  it('mockGetChapterAudio: hollow-tide-2 chapter 3 gets the acoustic+ASR segment override, same timings', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const audio = await api.getChapterAudio({ bookId: 'hollow-tide-2', chapterId: 3 });
    const suspects = audio.segments.filter((s) => s.suspect);

    expect(suspects).toHaveLength(2);
    expect(suspects.map((s) => s.characterId)).toEqual(['dockhand-remy', 'narrator']);
    expect(suspects[0].reasons).toEqual([
      'Content drift — heard "the ropes" where the script says "the ledger."',
    ]);
    expect(suspects[1].reasons).toEqual(['Near-silent — dead air detected before this line.']);
    // Timings unchanged from the generic layout (totalSec=600 default duration):
    // third=200, third*2=400, lateStart=488.
    expect(suspects[0].start).toBe(200);
    expect(suspects[0].end).toBe(400);
    expect(suspects[1].start).toBe(488);
    expect(suspects[1].end).toBe(600);
  });

  it('mockGetChapterAudio: every other chapter/book keeps the generic halloran/narrator segments', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const otherChapter = await api.getChapterAudio({ bookId: 'hollow-tide-2', chapterId: 4 });
    expect(
      otherChapter.segments.filter((s) => s.suspect).map((s) => s.characterId),
    ).toEqual(['halloran', 'narrator']);

    const otherBook = await api.getChapterAudio({ bookId: 'coalfall-commission', chapterId: 3 });
    expect(
      otherBook.segments.filter((s) => s.suspect).map((s) => s.characterId),
    ).toEqual(['halloran', 'narrator']);
  });

  it('mockGetChapterAudio: the override never fires outside DEMO_CAPTURE', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '0');
    const { api } = await import('./api');

    const audio = await api.getChapterAudio({ bookId: 'hollow-tide-2', chapterId: 3 });
    expect(
      audio.segments.filter((s) => s.suspect).map((s) => s.characterId),
    ).toEqual(['halloran', 'narrator']);
  });

  it('mockGetChapterAudio: the override ignores a passed duration:"00:00" (the mini-player Preview bug)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    // Mirrors mini-player.tsx:228's call shape for a chapter whose hydrated
    // duration defaulted to '00:00' (Saltgrave's chapters carry no duration
    // field). Without the totalSec-forcing fix this would collapse
    // durationSec to 0 and deriveIssues would find no issues at all.
    const audio = await api.getChapterAudio({
      bookId: 'hollow-tide-2',
      chapterId: 3,
      duration: '00:00',
    });
    expect(audio.durationSec).toBe(600);
    expect(audio.segments.filter((s) => s.suspect)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- api-demo-capture --run`
Expected: FAIL — all 4 tests fail (the override doesn't exist, so `characterId`s are `['halloran', 'narrator']` and `durationSec` is `0` for the `'00:00'` case instead of `600`).

- [ ] **Step 3: Implement the `mockGetChapterAudio` override**

**This step's Find blocks are copied byte-for-byte from the real file** (confirmed during plan review — the first draft of this step omitted two existing comment blocks, which would have made a literal find-and-replace fail to match).

Find (in `src/lib/api.ts`, ~line 1657):

```ts
async function mockGetChapterAudio({ chapterId, duration }: AudioArgs): Promise<ChapterAudio> {
  await wait(120);
  const totalSec = parseDuration(duration || '10:00');
  const peakCount = 240;
```

Replace with (destructure `bookId` too, and force a fixed duration for the flagged chapter — see "Bug found during plan review" above):

```ts
async function mockGetChapterAudio({ bookId, chapterId, duration }: AudioArgs): Promise<ChapterAudio> {
  await wait(120);
  /* Quality Gate marketing/wiki screenshots (#1286) — force totalSec=600 for
     Saltgrave chapter 3 regardless of what `duration` the caller passes.
     Saltgrave's chapters carry no `duration` field, so chapters-slice
     hydrates it to '00:00' — and the mini-player's Preview action (unlike
     ChapterSegmentStrip) explicitly forwards `chapter.duration`, which would
     otherwise collapse totalSec to 0 and make deriveIssues return no issues
     at all (its own guard: `!dur || dur <= 0 → return []`), silently
     breaking the preview-flagged scene's amber band. */
  const isFlaggedDemoChapter = DEMO_CAPTURE && bookId === 'hollow-tide-2' && chapterId === 3;
  const totalSec = isFlaggedDemoChapter ? 600 : parseDuration(duration || '10:00');
  const peakCount = 240;
```

Find the `return` block (segments array) further down — this is the exact current content, including the existing comments (do not drop them):

```ts
  /* Deterministic per-character segment layout so the Listen-view per-line
     re-record resolver (fs-26) has something to bite on in mock mode: split
     the chapter into four contiguous spans (narrator / halloran / narrator /
     narrator-late-suspect).  The two suspect segments are non-adjacent so
     deriveIssues produces TWO distinct IssueRegions rather than merging them
     — the e2e jump-to-issue test needs a "before" region (issue-1, halloran)
     and an "after" region (issue-2, late narrator) to prove the Next-issue
     button actually advances the playhead. */
  const third = totalSec / 3;
  /* issue-1: halloran at [third, third*2]; padded seekSec = third − 2.
     issue-2: late narrator at [third*2 + 88, totalSec]; padded seekSec =
     third*2 + 86.  Gap between padded end of issue-1 (third*2 + 2) and
     padded start of issue-2 (third*2 + 86) = 84 s → will NOT merge.
     For chapter 1 (duration '38:24' = 2304 s): third=768, lateStart=1624,
     seekSec-1=766 (33.2%), seekSec-2=1622 (70.4%). */
  const lateStart = third * 2 + 88;
  return {
    url: stubAudioB,
    durationSec: totalSec,
    peaks,
    sampleRate: 44100,
    segments: [
      { start: 0, end: third, characterId: 'narrator', sentenceId: 1 },
      {
        start: third,
        end: third * 2,
        characterId: 'halloran',
        sentenceId: 2,
        suspect: true,
        reasons: ['Long sentence — possible truncation'],
      },
      { start: third * 2, end: lateStart, characterId: 'narrator', sentenceId: 3 },
      {
        start: lateStart,
        end: totalSec,
        characterId: 'narrator',
        sentenceId: 4,
        suspect: true,
        reasons: ['Pacing anomaly — possible mispronunciation'],
      },
    ],
  };
}
```

Replace with (same comments preserved, only the two suspect segments' `characterId`/`reasons` branch on `isFlaggedDemoChapter`):

```ts
  /* Deterministic per-character segment layout so the Listen-view per-line
     re-record resolver (fs-26) has something to bite on in mock mode: split
     the chapter into four contiguous spans (narrator / halloran / narrator /
     narrator-late-suspect).  The two suspect segments are non-adjacent so
     deriveIssues produces TWO distinct IssueRegions rather than merging them
     — the e2e jump-to-issue test needs a "before" region (issue-1, halloran)
     and an "after" region (issue-2, late narrator) to prove the Next-issue
     button actually advances the playhead. */
  const third = totalSec / 3;
  /* issue-1: halloran at [third, third*2]; padded seekSec = third − 2.
     issue-2: late narrator at [third*2 + 88, totalSec]; padded seekSec =
     third*2 + 86.  Gap between padded end of issue-1 (third*2 + 2) and
     padded start of issue-2 (third*2 + 86) = 84 s → will NOT merge.
     For chapter 1 (duration '38:24' = 2304 s): third=768, lateStart=1624,
     seekSec-1=766 (33.2%), seekSec-2=1622 (70.4%). */
  const lateStart = third * 2 + 88;
  /* Quality Gate marketing/wiki screenshots (#1286) — Saltgrave chapter 3
     gets real cast ids and reason text for the two gate flavors that
     actually share this surface (acoustic + ASR content-QA), reusing this
     function's already-correct non-adjacent spacing rather than reinventing
     timings (spec's adversarial review round 2 flagged that risk explicitly). */
  return {
    url: stubAudioB,
    durationSec: totalSec,
    peaks,
    sampleRate: 44100,
    segments: [
      { start: 0, end: third, characterId: 'narrator', sentenceId: 1 },
      {
        start: third,
        end: third * 2,
        characterId: isFlaggedDemoChapter ? 'dockhand-remy' : 'halloran',
        sentenceId: 2,
        suspect: true,
        reasons: isFlaggedDemoChapter
          ? ['Content drift — heard "the ropes" where the script says "the ledger."']
          : ['Long sentence — possible truncation'],
      },
      { start: third * 2, end: lateStart, characterId: 'narrator', sentenceId: 3 },
      {
        start: lateStart,
        end: totalSec,
        characterId: 'narrator',
        sentenceId: 4,
        suspect: true,
        reasons: isFlaggedDemoChapter
          ? ['Near-silent — dead air detected before this line.']
          : ['Pacing anomaly — possible mispronunciation'],
      },
    ],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- api-demo-capture --run`
Expected: PASS (all 4 tests so far)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api-demo-capture.test.ts
git commit -m "feat(frontend): DEMO_CAPTURE segment override for Saltgrave chapter 3"
```

---

### Task 3: `mockPollRevisions` — drift events + `pending: []` for every book under DEMO_CAPTURE

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api-demo-capture.test.ts` (append to Task 2's file)

**Interfaces:**
- Consumes: `HOLLOW_TIDE_DRIFT_EVENTS` from `src/mocks/marketing/hollow-tide.ts` (Task 1).
- Produces: `api.pollRevisions({ bookId })` and `api.pollRevisionsBulk({ bookIds })` (under `DEMO_CAPTURE`) return `pending: []` for **every** book id, and merge `HOLLOW_TIDE_DRIFT_EVENTS` into `drift` alongside the existing `VOICE_DRIFT_EVENTS` filter.

- [ ] **Step 1: Add the failing tests**

Append to `src/lib/api-demo-capture.test.ts` (inside the same `describe` block, after Task 2's tests):

```ts
  it('mockPollRevisions: hollow-tide-2 gets HOLLOW_TIDE_DRIFT_EVENTS and pending: [] under DEMO_CAPTURE', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const res = await api.pollRevisions({ bookId: 'hollow-tide-2' });
    expect(res.pending).toEqual([]);
    // Exact-equality is safe here: VOICE_DRIFT_EVENTS (src/data/drift.ts) only
    // seeds bookId 'sb' (x6) and 'cc' (x1) — confirmed zero 'hollow-tide-2'
    // events during plan review — so the merged array is exactly these two.
    expect(res.drift.map((d) => d.id)).toEqual([
      'drift:hollow-tide-2:2:insp-cray:register',
      'drift:hollow-tide-2:5:dr-wren:warmth',
    ]);
  });

  it('mockPollRevisions/pollRevisionsBulk: pending stays [] for every book id under DEMO_CAPTURE (round-2 fix — not just Hollow Tide)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const coalfall = await api.pollRevisions({ bookId: 'coalfall-commission' });
    expect(coalfall.pending).toEqual([]);

    const bulk = await api.pollRevisionsBulk({ bookIds: ['hollow-tide-1', 'coalfall-commission'] });
    expect(bulk.byBookId['hollow-tide-1'].pending).toEqual([]);
    expect(bulk.byBookId['coalfall-commission'].pending).toEqual([]);
  });

  it('non-demo-capture mode is unaffected: dev pending/drift fixtures still serve for sb/cc', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '0');
    const { api } = await import('./api');

    const res = await api.pollRevisions({ bookId: 'sb' });
    expect(res.pending.length).toBeGreaterThan(0);
    expect(res.drift.some((d) => d.bookId === 'sb')).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- api-demo-capture --run`
Expected: FAIL — `res.pending` is `PENDING_REVISIONS` (non-empty) and `res.drift` doesn't include the Hollow Tide events yet.

- [ ] **Step 3: Implement the `mockPollRevisions` branch**

Add `HOLLOW_TIDE_DRIFT_EVENTS` to the existing import from `../mocks/marketing/hollow-tide` (near the top of `src/lib/api.ts`):

```ts
import {
  HOLLOW_TIDE_LIBRARY,
  HOLLOW_TIDE_BOOK_STATES,
  HOLLOW_TIDE_POSED,
  HOLLOW_TIDE_VOICES,
  HOLLOW_TIDE_CONTINUE,
  HOLLOW_TIDE_DRIFT_EVENTS,
```

(the import statement's closing `} from '../mocks/marketing/hollow-tide';` line and the rest of the list stay as-is.)

Find `mockPollRevisions` (~line 1759) — this is the exact current content, including the existing NOTE comment (do not drop it):

```ts
async function mockPollRevisions(args: PollArgs): Promise<RevisionsResponse> {
  await wait(200);
  /* Filter drift to the requested book so the mock mirrors the server's
     per-book endpoint shape. The dev fixture seeds events for two
     books — the modal's multi-book grouping only renders if the slice
     accumulates entries from each book separately, which is what
     happens when `applyPoll` is called once per book.

     NOTE: `pending` is returned for every book (the slice's `applyPoll`
     replaces `pending` wholesale regardless of bookId, so scoping it here
     would let a background poll of an empty book wipe the active book's
     pending). The fe-15 profile-regen-preview spec clears `pending` itself
     before opening its preview stub to avoid the phantom-revision collision. */
  return {
    pending: PENDING_REVISIONS,
    drift: VOICE_DRIFT_EVENTS.filter((d) => !args.bookId || d.bookId === args.bookId),
  };
}
```

Replace with (the existing comment is preserved as historical context for the dev-mode path; the new comment explains the added `DEMO_CAPTURE` branch):

```ts
async function mockPollRevisions(args: PollArgs): Promise<RevisionsResponse> {
  await wait(200);
  /* Filter drift to the requested book so the mock mirrors the server's
     per-book endpoint shape. The dev fixture seeds events for two
     books — the modal's multi-book grouping only renders if the slice
     accumulates entries from each book separately, which is what
     happens when `applyPoll` is called once per book.

     NOTE: `pending` is returned for every book (the slice's `applyPoll`
     replaces `pending` wholesale regardless of bookId, so scoping it here
     would let a background poll of an empty book wipe the active book's
     pending). The fe-15 profile-regen-preview spec clears `pending` itself
     before opening its preview stub to avoid the phantom-revision collision. */
  /* Quality Gate marketing/wiki screenshots (#1286) — under DEMO_CAPTURE,
     stop the dev-only PENDING_REVISIONS fixture (an Eliza/book-`sb` revision
     with no bookId field, so it always matched every book before) from
     bleeding into the marketing books' poll response. Scoped to the
     DEMO_CAPTURE flag for EVERY book, not specific book ids — the background
     bulk poll (layout.tsx) reaches every non-active marketing book, and
     applyPoll replaces `pending` wholesale regardless of bookId, so a
     partial scope wouldn't fully close the bleed (adversarial review round
     2 caught this when an earlier fix scoped it to hollow-tide-* only). */
  if (DEMO_CAPTURE) {
    return {
      pending: [],
      drift: [
        ...VOICE_DRIFT_EVENTS.filter((d) => !args.bookId || d.bookId === args.bookId),
        ...HOLLOW_TIDE_DRIFT_EVENTS.filter((d) => !args.bookId || d.bookId === args.bookId),
      ],
    };
  }
  return {
    pending: PENDING_REVISIONS,
    drift: VOICE_DRIFT_EVENTS.filter((d) => !args.bookId || d.bookId === args.bookId),
  };
}
```

(`pollRevisionsBulk`'s mock already delegates per-book to `mockPollRevisions` — no separate change needed there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- api-demo-capture --run`
Expected: PASS (all 6 tests in the file)

- [ ] **Step 5: Run the full frontend suite to confirm no regressions**

Run: `npm test -- --run`
Expected: same pass count as the worktree baseline (4056 passed / 8 skipped, ignoring the known tinypool worker-exit flake) plus the 6 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/lib/api-demo-capture.test.ts
git commit -m "feat(frontend): DEMO_CAPTURE drift events + pending:[] fix for marketing capture"
```

---

### Task 4: Three new marketing-capture scenes

**Files:**
- Modify: `e2e/marketing/scenes.ts`

**Interfaces:**
- Consumes: chapter 3's Suspect badge (Task 1+2), the drift banner (Task 3's drift events reaching `hollow-tide-2` via the cast view), the mini-player's `mini-player-next-issue` testid (existing, `src/components/mini-player.tsx:804`, only rendered when `issues.length > 0`).
- Produces: three new `Scene` entries the capture harness picks up automatically (no other file references these — `capture.spec.ts` iterates `SCENES`).

- [ ] **Step 1: Add the three scenes**

Append to the `SCENES` array in `e2e/marketing/scenes.ts`, before the closing `];`:

```ts
  {
    /* Quality Gate marketing/wiki screenshot #1286 — Saltgrave chapter 3's
       row expanded, showing the Suspect badge + amber waveform bands + "N
       issues to review" caption. `waitFor` targets the chapter's stable
       `#chapter-<id>` container (chapters-slice.ts/generation.tsx) so the
       click has something real to act on; the action's own waitFor (not a
       fixed delay) waits for "issues to review" text, which only renders
       once ChapterSegmentStrip's async getChapterAudio fetch resolves — and
       doubles as an assertion that both flagged segments produced distinct
       issue regions (the plural "issues", not singular "issue"). */
    id: 'chapter-suspect',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    waitFor: '#chapter-3',
    action: async (page) => {
      await page.locator('#chapter-3').getByRole('button').first().click({ timeout: 5000 });
      await page.waitForSelector('text=issues to review', { timeout: 5000 });
    },
  },
  {
    /* Drift-report modal — two severity-tiered flags (Severe with Auto-regen,
       Moderate). The drift events arrive via the active-book poll
       (api.pollRevisions, layout.tsx ~line 949, fires immediately on mount
       when the book is `ready`) rather than the background bulk poll, so no
       extra settle beyond the action's own content-aware waits is needed. */
    id: 'voice-drift-report',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    waitFor: '[data-testid^="cast-row-"]',
    action: async (page) => {
      await page.waitForSelector('text=Voice drift detected in', { timeout: 5000 });
      await page.getByText(/Voice drift detected in/).click({ timeout: 5000 });
      await page.waitForSelector('[data-testid^="drift-event-"]', { timeout: 5000 });
    },
  },
  {
    /* The "a flag follows you" preview surface — the mini-player's amber
       issue band persists once you hit Preview on the flagged chapter. The
       Preview button lives in the chapter row's always-visible action strip
       (not gated on the row being expanded), so no expand-click is needed
       here — only the click-then-wait-for-content pattern. */
    id: 'preview-flagged',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    waitFor: '#chapter-3',
    action: async (page) => {
      await page
        .locator('#chapter-3')
        .getByRole('button', { name: 'Preview' })
        .click({ timeout: 5000 });
      await page.waitForSelector('[data-testid="mini-player-next-issue"]', { timeout: 5000 });
    },
  },
```

- [ ] **Step 2: Run the registry guard test**

Run: `npx playwright test --config=playwright.marketing.config.ts --project=desktop -g "capture chapter-suspect|capture voice-drift-report|capture preview-flagged"`
Expected: 3 scenes captured (both light + dark = 6 screenshots total) into `mockups/marketing-screens/`; no "duplicate scene id" or "hash must start with #/" registry-guard errors from the top of `capture.spec.ts`.

**A green run here proves nothing about correctness — read this before Step 3.** `capture.spec.ts:88-94` wraps every scene's `action` in a `try/catch` that only `console.warn`s on failure ("capturing pre-interaction"), and every `waitFor` is non-fatal too. This means: if chapter 3's row never actually expands, if the drift modal never actually opens, or if the mini-player never actually picks up an issue, **the test still passes and still writes a PNG** — just the wrong one, silently. Playwright's own exit code cannot be trusted as evidence these three screenshots are correct.

**One partial mechanical check, before the manual one:** `chapter-suspect`'s action waits for `text=issues to review` — a *plural* substring. If only one segment's issue actually derived (e.g. the two spans merged into one `IssueRegion`), the real caption would read "1 issue to review" (singular), the substring wouldn't match, the `waitFor` would time out, and the console would print `[capture] chapter-suspect: action failed — capturing pre-interaction`. **Check the terminal output of this run for that exact warning line for any of the three scene ids** — its absence is a real (if partial) signal, not a guess. Its presence means don't even bother with Step 3 — go fix the underlying issue first. But its absence does NOT clear `voice-drift-report` or `preview-flagged` on its own (their waits check for *presence* of an element, not a specific count/state), so Step 3 is still required for all three.

- [ ] **Step 3: Visually confirm each screenshot — a real gate, not a rubber stamp**

Read each PNG with the Read tool (it supports images) and confirm the specific claim, not just "a screenshot exists":
- `mockups/marketing-screens/chapter-suspect.desktop.light.png` — the Suspect badge is visible on chapter 3's row; the expanded strip shows **two distinct amber bands** (not one merged band, not zero) and the caption reads **"2 issues to review"** (plural — confirms `deriveIssues` didn't collapse the two suspect spans into one region).
- `mockups/marketing-screens/voice-drift-report.desktop.light.png` — **both** Cray (Severe, with an "Auto-regen" pill — not the manual "Regenerate" pill) and Wren (Moderate, "Regenerate" pill) are visible in the modal.
- `mockups/marketing-screens/preview-flagged.desktop.light.png` — the mini-player's scrubber shows a visible amber issue band. If this one is blank/band-less, the most likely cause is the duration-forcing fix in Task 2 not having landed correctly (re-check `isFlaggedDemoChapter` fires for this call) — do not assume it's a Playwright timing fluke without checking that first.

If any check fails, fix the scene definition or the underlying fixture (do not just re-run and hope) and repeat Step 2 before proceeding. Do not embed a screenshot into the wiki until all three checks above are individually confirmed.

- [ ] **Step 4: Commit**

```bash
git add e2e/marketing/scenes.ts
git commit -m "feat(frontend): add Quality Gate marketing-capture scenes"
```

---

### Task 5: Wiki rewrite + embed screenshots

**Files:**
- Modify: `docs/wiki/The-Quality-Gate.md`
- Create: `docs/wiki/images/the-quality-gate/01-suspect-chapter.png`
- Create: `docs/wiki/images/the-quality-gate/02-voice-drift-report.png`
- Create: `docs/wiki/images/the-quality-gate/03-preview-surface.png`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: the three light-theme PNGs captured in Task 4 (`mockups/marketing-screens/{chapter-suspect,voice-drift-report,preview-flagged}.desktop.light.png`).
- Produces: nothing consumed elsewhere — this is the terminal, user-facing deliverable.

- [ ] **Step 1: Copy the light-theme screenshots into the wiki images folder**

```bash
mkdir -p docs/wiki/images/the-quality-gate
cp mockups/marketing-screens/chapter-suspect.desktop.light.png docs/wiki/images/the-quality-gate/01-suspect-chapter.png
cp mockups/marketing-screens/voice-drift-report.desktop.light.png docs/wiki/images/the-quality-gate/02-voice-drift-report.png
cp mockups/marketing-screens/preview-flagged.desktop.light.png docs/wiki/images/the-quality-gate/03-preview-surface.png
```

- [ ] **Step 2: Rewrite `docs/wiki/The-Quality-Gate.md`**

Replace the file's full contents with:

```markdown
# The Quality Gate

The honest worry with any AI voice is a line that comes out fluent but *wrong* — a dropped clause, a clipped word, a stretch of dead air — and you only catch it three chapters later. Castwright runs two independent checks so that mistake gets caught before you do, not after.

## Check one: the acoustic gate, before a chapter assembles

Every rendered sentence is checked acoustically — dead air, near-silence, clipping, duration drift against what the line should take to say — before the chapter is assembled. A sentence that fails gets automatically re-recorded, up to a fixed retry budget, with no action from you.

A second, optional pass reads the words themselves. Off by default (turn it on in **Advanced Configuration → QA gates**), it transcribes each rendered line and checks it against the script — the "fluent but wrong" case the acoustic check can't see: a dropped clause, a swapped word, a line that says something other than what was written. Together the two checks cover both ways a take can go bad — the sound of it, and the sense of it.

A line that still doesn't clear after its retries ships anyway with the best take kept, and the chapter is marked **Suspect** so you know to take a listen rather than trust it blindly.

Expanding a Suspect chapter's row on the Generate screen shows exactly where the trouble is: a waveform strip with each flagged stretch rendered as an amber band, an "N issues to review" caption, and a tooltip on each band naming the reason — a line rendered suspiciously short against how long it should have taken to say, or a line whose words drifted from the script.

![Suspect chapter — two flagged lines, one caught acoustically and one caught by the content check](images/the-quality-gate/01-suspect-chapter.png)

A chapter that clears cleanly shows none of this — no Suspect badge, no amber band, every character row reads Done straight through. That's the gate working quietly in the common case: nothing to review because nothing needed a re-record.

## Check two: voice drift, after a chapter renders

The acoustic gate catches a broken *take*. It doesn't catch a voice that rendered cleanly but drifted away from the character it's supposed to be. That's what the drift detector is for: once a chapter renders, it compares that chapter's synthesis against the character's established voice profile and flags any character whose rendered voice has wandered.

Flags are severity-tiered — **Severe**, **Moderate**, **Mild** — and open into a comparison view: the profile's voice attributes (gender, age, warmth, pace, authority, emotion) as they were "when rendered" against "now," a **Listen** control that A/B-plays the actual chapter audio against a fresh sample of the current profile so you can hear the drift rather than just read it, and a one-click **Regenerate** for that chapter. A Severe flag offers **Auto-regen** — no confirmation step, because at that severity the drift is confident enough not to need a second opinion. Anything you're not worried about, **Dismiss** (or **Dismiss all**) clears it.

![Voice drift report — severity-tiered flags with the Auto-regen control on a Severe event](images/the-quality-gate/02-voice-drift-report.png)

## Where a flag follows you: the preview surface

A Suspect flag isn't stranded on the Generate screen. The same amber-marked waveform follows the audio wherever you play it — including the mini-player that pins to the bottom of every view. Hit preview on a chapter from Generate, or play it from the Listen tab's chapter list, and a bad take lights up amber in the scrubber before you've even pressed play — so a flagged line never has to be rediscovered by ear from scratch.

![The same flag in the mini-player — a bad take lights up amber before you've pressed play](images/the-quality-gate/03-preview-surface.png)

Next: [Listening & Revising](Listening-and-Revising).
```

- [ ] **Step 3: Append the technical release-notes entry**

Add a new bullet under the in-progress version section at the top of `docs/release-notes-next.md` (match the file's existing bullet format and PR-reference style):

```markdown
- **docs:** `The-Quality-Gate.md` wiki page now documents the ASR content-QA gate alongside the acoustic gate (previously undocumented), and ships real screenshots for a flagged Suspect chapter, the voice-drift report, and the mini-player preview surface — replacing the placeholder note tracked as #1286. (PR #XXXX)
```

(Replace `#XXXX` with the actual PR number once it's opened — see Task 6.)

- [ ] **Step 4: Append the brand-voice release-notes line**

Add a matching user-facing line to the in-progress version section at the top of `RELEASE_NOTES.md` (match the file's existing brand-voice tone — short, plain-language, no jargon):

```markdown
- The Quality Gate wiki page finally shows its work — real pictures of a flagged line, a voice-drift flag, and the amber warning following you into the mini-player, plus the word-check pass documented for the first time.
```

- [ ] **Step 5: Commit**

```bash
git add docs/wiki/The-Quality-Gate.md docs/wiki/images/the-quality-gate/ docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): ship real Quality Gate screenshots + comprehensive wiki coverage"
```

---

### Task 6: Verify, open the PR, sync the wiki (with confirmation)

**Files:** none (verification + git/GitHub operations only)

- [ ] **Step 1: Run the full verify battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build all green (same pass counts as Task 1's baseline plus the new tests from Tasks 2/3). `e2e/marketing/capture.spec.ts` IS collected by `playwright.config.ts`'s default `chromium` project (there's no marketing-specific exclusion in that config), but every capture test self-skips there: `capture.spec.ts:61-62` does `test.skip(!viewports.includes(vp))` where `vp = testInfo.project.name` (`'chromium'` under `test:e2e`, never a member of any scene's `viewports: ['desktop']`/etc.), so the leg stays green without actually running the marketing suite. This was confirmed by reading `capture.spec.ts` during plan review — an earlier draft of this step assumed the exclusion came from the config file, which isn't where it actually lives.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin docs/frontend-1286-quality-gate-screenshots
gh pr create --title "docs(docs): real Quality Gate screenshots + comprehensive wiki coverage" --body "$(cat <<'EOF'
## Summary
- Wires additive `DEMO_CAPTURE`-gated fixtures (Saltgrave chapter 3 flagged Suspect, two drift events) so the marketing-capture harness can produce real screenshots instead of a placeholder.
- Adds three new capture scenes and rewrites `docs/wiki/The-Quality-Gate.md` to document the ASR content-QA gate for the first time, alongside the existing acoustic gate and voice-drift detector.

## Test plan
- [ ] `npm run verify` green
- [ ] Screenshots visually confirmed (Task 4, Step 3)
- [ ] Wiki page renders correctly with embedded images

Closes #1286
EOF
)"
```

- [ ] **Step 3: Fill in the real PR number in the release notes**

Task 5 Step 3 left a `(PR #XXXX)` placeholder in `docs/release-notes-next.md` because the PR didn't exist yet. Now that it does (from Step 2's `gh pr create` output), replace `#XXXX` with the real number, e.g.:

```bash
git log -1 --format=%H  # confirm you're editing the right commit context
# Edit docs/release-notes-next.md: replace "(PR #XXXX)" with "(PR #<real-number>)"
git add docs/release-notes-next.md
git commit -m "docs(docs): fill in PR number in release notes"
git push
```

- [ ] **Step 4: Request the mandatory code-review gate**

Per `.claude/skills/model-routing/SKILL.md`, this PR is single-scope `docs`+`feat` touching `src/mocks/`, `src/lib/api.ts`, `e2e/marketing/`, `docs/wiki/` — run the `code-review` skill at `medium` effort before merge.

- [ ] **Step 5: STOP and ask before syncing the wiki**

`npm run wiki:sync` force-pushes to the separate public `Castwright.wiki.git` remote. **Do not run it automatically** — present the PR link to the user and ask explicitly whether to run `npm run wiki:sync` now or wait until after merge.
