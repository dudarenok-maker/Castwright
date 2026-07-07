# scoreBook Incremental Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the srv-36 `scoreBook()` voice-match pass write results per character as they resolve (instead of only after every character in the book finishes), survive a killed run via a manual resume action, and surface all of this to the user instead of reading as a silent failure.

**Architecture:** `scoreBook`'s per-character loop persists (`centroids.json` + merged verdict rows) immediately after each character resolves, instead of batching everything to the end. A capped retry counter (a new small artifact) makes a permanently-broken character's synthesis attempts stop instead of looping forever. A `triggerScoring` helper shared between the existing chapter-finalize path and a new manual resume route makes an interrupted run resumable. Three new SSE events + a `charactersPending` report field let the frontend show live progress and a Resume button instead of a bare "0 of N scored."

**Tech Stack:** TypeScript, Express, Vitest (server + frontend), React 18 + Redux Toolkit, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-08-scorebook-incremental-hardening-design.md` (revision 4, post 3 rounds of adversarial review — every "Round-N review fix" callout in that doc is already reflected in this plan; do not re-litigate them here).

## Global Constraints

- No new features beyond the spec's design — this plan implements exactly what's in the spec, nothing extra.
- Every new/changed file gets a paired automated test in the same task (this repo's testing-discipline rule) — no task is "done" without its test passing.
- `centroids.json`'s on-disk shape (`CharacterCentroid`) is unchanged — every row written to it is still a fully-resolved row (spec §2, round-2 fix). Pending-attempt counters live in a separate artifact.
- `OpenAPI is the type source of truth` — `src/lib/api-types.ts` is generated from `openapi.yaml` via `npm run openapi:types`, never hand-edited.
- Match existing code style exactly (comment density, naming, atomic-write helpers) — this is a surgical extension of `server/src/audio/render-integrity/`, not a rewrite.
- Windows dev box — use `npm run test:server` (not `npm test`) for server-side test files under `server/`.

---

## File Structure

**New files:**
- `server/src/audio/render-integrity/pending-attempts-io.ts` — read/write the retry-attempts artifact.
- `server/src/audio/render-integrity/pending-attempts-io.test.ts`

**Modified files (server):**
- `server/src/audio/render-integrity/verdicts-io.ts` — `mergeVerdictRows` + `deriveBookOutline`'s new `verdictCharactersByChapter`.
- `server/src/audio/render-integrity/verdicts-io.test.ts`
- `server/src/audio/render-integrity/aggregate.ts` — the core restructure: `resolveCharacterReference` returns a discriminated outcome; `scoreBook` interleaves resolve+persist per character, cheap-first ordered, returns `usedQwenTiers`.
- `server/src/audio/render-integrity/aggregate.test.ts`
- `server/src/audio/qa-report.ts` — `rosterByChapter` sourced from `embeddings.json`, `charactersPending`, roster-aware `scoredChapterIds`/`chaptersEmbedFailed`.
- `server/src/audio/qa-report.test.ts`
- `openapi.yaml` — `GenerationTick` (3 new tick types), `ChangeLogEvent` (2 new types), `BookQaReport.voiceDrift.charactersPending`.
- `src/lib/api-types.ts` — regenerated, not hand-edited.
- `server/src/routes/generation.ts` — extract `triggerScoring`; wire the 3 new SSE emissions.
- `server/src/routes/generation.test.ts`
- `server/src/routes/qa-report.ts` — new `POST /:bookId/resume-scoring`.
- `server/src/routes/qa-report.test.ts`

**Modified files (frontend):**
- `src/lib/api.ts` — `resumeScoring`.
- `src/lib/change-log.ts` — `buildScoringStartedEvent`, `buildScoringCompleteEvent`.
- `src/lib/change-log.test.ts`
- `src/store/chapters-slice.ts` — `scoringProgress` state + actions.
- `src/store/chapters-slice.test.ts`
- `src/store/generation-stream-runner.ts` — handle `scoring_started`/`scoring_progress`/`scoring_complete`.
- `src/store/generation-stream-runner.test.ts`
- `src/views/generation.tsx` — `ACTIVITY_FEED_TYPES`, pass `bookId` + live progress to `QaReportCard`.
- `src/views/listen.tsx` — pass `bookId` to `QaReportCard`.
- `src/components/qa-report-card.tsx` — three-state `VoiceMatchRow` + Resume button.
- `src/components/qa-report-card.test.tsx`
- `e2e/generation-scoring-progress.spec.ts` — new e2e spec.

---

## Design

### 1. `pending-attempts-io.ts` (new)

**Files:**
- Create: `server/src/audio/render-integrity/pending-attempts-io.ts`
- Test: `server/src/audio/render-integrity/pending-attempts-io.test.ts`

**Interfaces:**
- Produces: `readPendingAttempts(bookDir: string): Promise<Record<string, number> | null>`, `writePendingAttempts(bookDir: string, counts: Record<string, number>): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/audio/render-integrity/pending-attempts-io.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPendingAttempts, writePendingAttempts } from './pending-attempts-io.js';

describe('pending-attempts-io', () => {
  it('returns null when no file has been written yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-attempts-'));
    expect(await readPendingAttempts(dir)).toBeNull();
  });

  it('round-trips a counts map', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-attempts-'));
    await writePendingAttempts(dir, { ren: 2, mairin: 1 });
    expect(await readPendingAttempts(dir)).toEqual({ ren: 2, mairin: 1 });
  });

  it('overwrites the full map on each write (not a merge)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-attempts-'));
    await writePendingAttempts(dir, { ren: 1 });
    await writePendingAttempts(dir, { mairin: 1 });
    expect(await readPendingAttempts(dir)).toEqual({ mairin: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/audio/render-integrity/pending-attempts-io.test.ts`
Expected: FAIL — `Cannot find module './pending-attempts-io.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/audio/render-integrity/pending-attempts-io.ts
/* srv-36 hardening — persists the retry-attempt counter for characters whose
   audition-centroid fallback synthesis transiently failed (auditionCentroid
   returned null — a real synth/embed throw, "sidecar unavailable, bail
   entirely"). Deliberately a SEPARATE artifact from centroids.json: a row in
   centroids.json is always a fully-resolved CharacterCentroid (see that
   module's doc comment and every existing reader's all-required-fields
   assumption, e.g. the repair route's unconditional `cleanMean` read) — this
   file exists so the retry count never has to live inside that contract.

   File: `<bookDir>/audio/render-integrity.pending-attempts.json`
   Shape: Record<characterId, number> — a character with no entry has never
   had a transient failure (or already resolved/degraded past one). */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../workspace/state-io.js';
import { audioDir } from '../../workspace/paths.js';

const PENDING_ATTEMPTS_FILENAME = 'render-integrity.pending-attempts.json';

function pendingAttemptsPath(bookDir: string): string {
  return join(audioDir(bookDir), PENDING_ATTEMPTS_FILENAME);
}

/** Write the full counts map atomically — overwrites any prior file. */
export async function writePendingAttempts(
  bookDir: string,
  counts: Record<string, number>,
): Promise<void> {
  await writeJsonAtomic(pendingAttemptsPath(bookDir), counts);
}

/** Read the counts map. Returns null on ENOENT (no transient failures yet). */
export async function readPendingAttempts(
  bookDir: string,
): Promise<Record<string, number> | null> {
  let raw: string;
  try {
    raw = await readFile(pendingAttemptsPath(bookDir), 'utf8');
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw) as Record<string, number>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/audio/render-integrity/pending-attempts-io.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/audio/render-integrity/pending-attempts-io.ts server/src/audio/render-integrity/pending-attempts-io.test.ts
git commit -m "feat(server): add pending-attempts-io for srv-36 retry-cap counter"
```

---

### 2. `verdicts-io.ts` — `mergeVerdictRows` + `verdictCharactersByChapter`

**Files:**
- Modify: `server/src/audio/render-integrity/verdicts-io.ts`
- Test: `server/src/audio/render-integrity/verdicts-io.test.ts`

**Interfaces:**
- Consumes: `readVerdicts`, `writeVerdicts` (both already exported in this file, unchanged).
- Produces: `mergeVerdictRows(path: string, characterId: string, rows: VerdictRow[]): Promise<void>`. `deriveBookOutline`'s return type gains `verdictCharactersByChapter: Map<number, Set<string>>`.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/audio/render-integrity/verdicts-io.test.ts` (append; read the existing file first to match its exact import/describe style before inserting):

```typescript
describe('mergeVerdictRows', () => {
  it('writes rows fresh when no file exists yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-merge-'));
    const path = join(dir, 'ch1.render-integrity.json');
    await mergeVerdictRows(path, 'narrator', [
      { characterId: 'narrator', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);
    const rows = await readVerdicts(path);
    expect(rows).toHaveLength(1);
    expect(rows![0].characterId).toBe('narrator');
  });

  it('replaces only the given character\'s rows, leaving other characters\' rows untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-merge-'));
    const path = join(dir, 'ch1.render-integrity.json');
    await mergeVerdictRows(path, 'narrator', [
      { characterId: 'narrator', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);
    await mergeVerdictRows(path, 'ren', [
      { characterId: 'ren', sentenceIds: [2], verdict: 'inconclusive', cosine: 0, severity: 'inconclusive', fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'too-short', windowed: false, chapterId: 1 },
    ]);
    // Re-merge narrator with a NEW row set — old narrator rows must be dropped, ren's rows survive.
    await mergeVerdictRows(path, 'narrator', [
      { characterId: 'narrator', sentenceIds: [1, 3], verdict: 'voice-match', cosine: 0.95, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
    ]);
    const rows = await readVerdicts(path);
    expect(rows!.filter((r) => r.characterId === 'narrator')).toHaveLength(1);
    expect(rows!.find((r) => r.characterId === 'narrator')!.sentenceIds).toEqual([1, 3]);
    expect(rows!.filter((r) => r.characterId === 'ren')).toHaveLength(1);
  });
});

describe('deriveBookOutline — verdictCharactersByChapter', () => {
  it('collects the distinct characterIds with verdict rows per chapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-outline-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeVerdicts(join(root, 'ch1.render-integrity.json'), [
      { characterId: 'narrator', sentenceIds: [1], verdict: 'voice-match', cosine: 0.9, severity: null, fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'in-book', windowed: false, chapterId: 1 },
      { characterId: 'ren', sentenceIds: [2], verdict: 'inconclusive', cosine: 0, severity: 'inconclusive', fixable: false, expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: 'too-short', windowed: false, chapterId: 1 },
    ]);
    const outline = await deriveBookOutline(dir, [{ id: 1, slug: 'ch1' }]);
    expect(outline.verdictCharactersByChapter.get(1)).toEqual(new Set(['narrator', 'ren']));
  });

  it('an unscored chapter has no entry in verdictCharactersByChapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-outline-'));
    const outline = await deriveBookOutline(dir, [{ id: 1, slug: 'ch1' }]);
    expect(outline.verdictCharactersByChapter.get(1)).toBeUndefined();
  });
});
```

Add `mkdirSync` and `mergeVerdictRows`/`deriveBookOutline` to the test file's existing imports (adjust the `node:fs`/local imports at the top of the file to include them alongside whatever's already imported there).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/audio/render-integrity/verdicts-io.test.ts`
Expected: FAIL — `mergeVerdictRows is not a function` / `verdictCharactersByChapter` is `undefined`.

- [ ] **Step 3: Implement `mergeVerdictRows`**

Add directly below the existing `writeVerdicts`/`readVerdicts` functions in `server/src/audio/render-integrity/verdicts-io.ts`:

```typescript
/** Read-modify-write a single character's verdict rows into a chapter's
 *  verdict file: drops any existing rows for `characterId`, appends the new
 *  ones, writes atomically. Idempotent — safe to call again with a fresh
 *  `rows` set for the same character (e.g. a re-scored run). This is the
 *  srv-36 incremental-writes primitive: `scoreBook` calls this once per
 *  character per affected chapter, immediately after that character
 *  resolves, instead of collecting every character's rows and writing the
 *  whole file once at the end. */
export async function mergeVerdictRows(
  path: string,
  characterId: string,
  rows: VerdictRow[],
): Promise<void> {
  const existing = (await readVerdicts(path)) ?? [];
  const kept = existing.filter((r) => r.characterId !== characterId);
  await writeVerdicts(path, [...kept, ...rows]);
}
```

- [ ] **Step 4: Extend `deriveBookOutline` to also build `verdictCharactersByChapter`**

In `server/src/audio/render-integrity/verdicts-io.ts`, modify `deriveBookOutline`'s return type and body:

```typescript
export async function deriveBookOutline(
  bookDir: string,
  chapters: { id: number; slug: string }[],
): Promise<{
  issues: VerdictRow[];
  counts: { suspect: number; fixable: number; uncheckedCharacters: string[] };
  scoredChapterIds: number[];
  inconclusiveChapterIds: number[];
  attemptedChapterIds: number[];
  /** srv-36 hardening — the distinct characterIds that have a verdict row in
   *  a given chapter, keyed by chapter id. A chapter's key is absent iff no
   *  verdict rows exist for it at all (mirrors `scoredChapterIds`'s
   *  presence test, just at character granularity — see qa-report.ts's
   *  roster-coverage "fully scored" computation, which compares this
   *  against a chapter's expected-character roster). */
  verdictCharactersByChapter: Map<number, Set<string>>;
}> {
  const root = audioDir(bookDir);
  const issues: VerdictRow[] = [];
  const uncheckedSet = new Set<string>();
  const scoredChapterIds = new Set<number>();
  const inconclusiveChapterIds = new Set<number>();
  const attemptedChapterIds = new Set<number>();
  const verdictCharactersByChapter = new Map<number, Set<string>>();

  for (const ch of chapters) {
    const path = join(root, `${ch.slug}.render-integrity.json`);
    const [attempted, rows] = await Promise.all([
      readAttempted(attemptedPath(root, ch.slug)),
      readVerdicts(path),
    ]);

    if (attempted) {
      attemptedChapterIds.add(ch.id);
    }

    if (!rows) continue;
    scoredChapterIds.add(ch.id);

    const chapterCharIds = new Set<string>();
    for (const row of rows) {
      chapterCharIds.add(row.characterId);
      if (row.verdict === 'voice-mismatch') {
        issues.push(row);
      }
      if (row.verdict === 'inconclusive') {
        inconclusiveChapterIds.add(ch.id);
      }
      if (row.referenceKind === 'too-short') {
        uncheckedSet.add(row.characterId);
      }
    }
    verdictCharactersByChapter.set(ch.id, chapterCharIds);
  }

  const uncheckedCharacters = Array.from(uncheckedSet).sort();

  return {
    issues,
    counts: {
      suspect: issues.length,
      fixable: issues.filter((r) => r.fixable).length,
      uncheckedCharacters,
    },
    scoredChapterIds: Array.from(scoredChapterIds).sort((a, b) => a - b),
    inconclusiveChapterIds: Array.from(inconclusiveChapterIds).sort((a, b) => a - b),
    attemptedChapterIds: Array.from(attemptedChapterIds).sort((a, b) => a - b),
    verdictCharactersByChapter,
  };
}
```

(Only the body additions are `chapterCharIds` collection + the final `verdictCharactersByChapter.set(ch.id, chapterCharIds)` inside the loop, the new field in the return type, and the new field in the returned object — everything else in this function is unchanged from today.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/audio/render-integrity/verdicts-io.test.ts`
Expected: PASS (all tests, old + new)

- [ ] **Step 6: Commit**

```bash
git add server/src/audio/render-integrity/verdicts-io.ts server/src/audio/render-integrity/verdicts-io.test.ts
git commit -m "feat(server): add mergeVerdictRows and per-chapter character coverage to deriveBookOutline"
```

---

### 3. `aggregate.ts` — the core restructure

This is the largest task. It replaces `resolveCharacterReference` and `scoreBook`'s Phase 3+4 with a single interleaved, cheap-first-ordered, per-character resolve-and-persist loop, per spec §1/§2.

**Files:**
- Modify: `server/src/audio/render-integrity/aggregate.ts`
- Test: `server/src/audio/render-integrity/aggregate.test.ts`

**Interfaces:**
- Consumes: `readCentroids`/`writeCentroids` (`centroids-io.ts`, unchanged), `readPendingAttempts`/`writePendingAttempts` (Task 1), `mergeVerdictRows` (Task 2), `auditionCentroid` (`audition-centroid.ts`, unchanged — already returns exactly the 3-outcome shape this task needs: `null | { kind: 'too-short'; ... } | { kind: 'audition'; ... }`).
- Produces: `scoreBook(bookDir, chapters, justFinalizedSlugs?, opts?): Promise<{ usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }>` — new 4th optional param `opts?: { onRosterKnown?: (total: number) => void; onCharacterScored?: (characterId: string, index: number, total: number) => void }`, new non-void return type (was `Promise<void>`).

- [ ] **Step 1: Write the failing tests**

Read `server/src/audio/render-integrity/aggregate.test.ts` in full first to see its existing fixture helpers (`vec(θ)`, `mkdtempSync` pattern, how segments/embeddings files get written) — reuse that exact pattern, don't invent a new one. Append these `describe` blocks:

```typescript
describe('scoreBook — incremental per-character writes (srv-36 hardening)', () => {
  it('writes centroids.json and a chapter\'s verdict file incrementally, one character at a time, in cheap-first order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-incremental-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });

    // narrator: 12 clean anchors (clears CENTROID_MIN_N=10 — "cheap").
    // ren: 1 anchor only (too-thin — needs the "expensive" audition fallback).
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ characterId: 'narrator', sentenceIds: [i], vec: vec(0) })),
      { characterId: 'ren', sentenceIds: [200], vec: vec(0.02) },
    ];
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({ characterId: r.characterId, sentenceIds: r.sentenceIds })),
        characterSnapshots: {
          narrator: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-narrator', modelKey: 'qwen3-tts-1.7b' },
          ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' },
        },
      }),
    );

    const resolveOrder: string[] = [];
    const fakeSynth = async ({ voiceName }: { voiceName: string }) => {
      resolveOrder.push(voiceName.includes('ren') ? 'ren-synth' : voiceName);
      return { pcm: Buffer.alloc(48_000 * 2), sampleRate: 48_000 }; // 1s of silence, clears MIN_DURATION_SEC
    };
    const fakeEmbed = async () => vec(0.02);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, {
      onCharacterScored: (characterId) => resolveOrder.push(`scored:${characterId}`),
      __testSynthFn: fakeSynth,
      __testEmbedFn: fakeEmbed,
    } as never);

    // narrator (already-clears-the-floor) must be scored before ren (needs synthesis).
    const narratorScoredIdx = resolveOrder.indexOf('scored:narrator');
    const renScoredIdx = resolveOrder.indexOf('scored:ren');
    expect(narratorScoredIdx).toBeGreaterThanOrEqual(0);
    expect(renScoredIdx).toBeGreaterThan(narratorScoredIdx);

    const centroids = await readCentroids(dir);
    expect(centroids!.narrator.referenceKind).toBe('in-book');
    expect(centroids!.ren).toBeDefined();

    const verdicts = await readVerdicts(join(root, 'ch1.render-integrity.json'));
    expect(verdicts!.some((v) => v.characterId === 'narrator')).toBe(true);
    expect(verdicts!.some((v) => v.characterId === 'ren')).toBe(true);
  });

  it('a null (transient) auditionCentroid result increments pendingAttempts and writes nothing to centroids.json for that character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-transient-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), [{ characterId: 'ren', sentenceIds: [1], vec: vec(0) }], EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        segments: [{ characterId: 'ren', sentenceIds: [1] }],
        characterSnapshots: { ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );

    const throwingSynth = async () => { throw new Error('sidecar unreachable'); };

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: throwingSynth } as never);

    expect((await readCentroids(dir))?.ren).toBeUndefined();
    expect((await readPendingAttempts(dir))?.ren).toBe(1);
    expect(await readVerdicts(join(root, 'ch1.render-integrity.json'))).toBeNull();
  });

  it('after 3 consecutive null results the character degrades to a terminal too-short row and stops retrying (absorbing state)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-cap-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), [{ characterId: 'ren', sentenceIds: [1], vec: vec(0) }], EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        segments: [{ characterId: 'ren', sentenceIds: [1] }],
        characterSnapshots: { ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );

    let synthCalls = 0;
    const throwingSynth = async () => { synthCalls++; throw new Error('sidecar unreachable'); };

    for (let i = 0; i < 3; i++) {
      await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: throwingSynth } as never);
    }
    expect(synthCalls).toBe(3);
    expect((await readCentroids(dir))?.ren.referenceKind).toBe('too-short');
    expect((await readPendingAttempts(dir))?.ren).toBeUndefined();

    // 4th call — the state is absorbing, the synth fn must NOT fire again.
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: throwingSynth } as never);
    expect(synthCalls).toBe(3);
  });

  it('a { kind: "too-short" } audition result (pool completed, still too thin) writes a terminal row immediately without ever touching pending-attempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-tooshort-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), [{ characterId: 'ren', sentenceIds: [1], vec: vec(0) }], EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        segments: [{ characterId: 'ren', sentenceIds: [1] }],
        characterSnapshots: { ren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ren', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );
    // Renders that never clear MIN_DURATION_SEC — auditionCentroid exhausts
    // its budget and returns { kind: 'too-short' }, not null.
    const tooShortSynth = async () => ({ pcm: Buffer.alloc(10), sampleRate: 48_000 });

    let synthCalls = 0;
    const countingSynth = async (...args: Parameters<typeof tooShortSynth>) => { synthCalls++; return tooShortSynth(...args); };

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: countingSynth } as never);

    expect((await readCentroids(dir))?.ren.referenceKind).toBe('too-short');
    expect((await readPendingAttempts(dir))?.ren).toBeUndefined();

    const callsAfterFirst = synthCalls;
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }], undefined, { __testSynthFn: countingSynth } as never);
    expect(synthCalls).toBe(callsAfterFirst); // absorbing — no second attempt
  });

  it('scoreBook returns usedQwenTiers reflecting the tiers actually seen this call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-tiers-'));
    const root = join(dir, 'audio');
    mkdirSync(root, { recursive: true });
    const rows = Array.from({ length: 12 }, (_, i) => ({ characterId: 'narrator', sentenceIds: [i], vec: vec(0) }));
    await writeEmbeddings(join(root, 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(root, 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({ characterId: r.characterId, sentenceIds: r.sentenceIds })),
        characterSnapshots: { narrator: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-narrator', modelKey: 'qwen3-tts-1.7b' } },
      }),
    );
    const result = await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    expect(result.usedQwenTiers).toEqual({ keep06: false, keep17: true });
  });
});
```

Add `readPendingAttempts` to this test file's imports from `./pending-attempts-io.js`, and `mkdirSync` to its `node:fs` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/audio/render-integrity/aggregate.test.ts`
Expected: FAIL — `scoreBook` doesn't accept a 4th arg / doesn't return `usedQwenTiers` / synth-fn injection seam doesn't exist yet.

- [ ] **Step 3: Add a test-only synth/embed injection seam**

`scoreBook` needs a way for tests to control `auditionCentroid`'s underlying synth/embed calls without a real sidecar. `auditionCentroid` already accepts `opts?.synthFn`/`opts?.embedFn` (`audition-centroid.ts:55-61` — unchanged). Thread two optional test-only fields through `scoreBook`'s `opts` param down to every `auditionCentroid(...)` call site — read the top of `server/src/audio/render-integrity/aggregate.ts` first (imports, `resolveCharacterReference`'s current signature at line 168, `scoreBook`'s current signature at line 296) before editing, then make these exact changes:

Replace the `resolveCharacterReference` function (today's lines ~144-233) with:

```typescript
// ── Reference resolution (Task 10 seam) ───────────────────────────────────

interface CharacterReference {
  centroid: number[];
  cleanMean: number;
  pSevere: number;
  pBand: number;
  referenceKind: 'in-book' | 'audition' | 'too-short';
}

/** Discriminates the three things that can happen when a character's
 *  in-book anchors alone aren't enough (srv-36 hardening, spec §2):
 *  - 'resolved': a usable reference — either real in-book anchors, or a
 *    successful (or reused-from-a-prior-run) audition centroid.
 *  - 'too-short': a CONCLUSIVE negative result — no voice info to attempt
 *    audition at all, or auditionCentroid completed its full render budget
 *    and the pool is still too thin/bimodal. Terminal: never retried.
 *  - 'transient-failure': auditionCentroid's synth/embed call itself threw
 *    (sidecar unreachable, timeout). NOT terminal — the caller tracks a
 *    bounded retry count (pending-attempts-io.ts) and only degrades to
 *    'too-short' after the cap is spent. Nothing is written for this
 *    outcome — the character stays genuinely unresolved this run. */
type ReferenceOutcome =
  | { status: 'resolved' | 'too-short'; ref: CharacterReference }
  | { status: 'transient-failure' };

const TOO_SHORT_REF: CharacterReference = { centroid: [], cleanMean: 0, pSevere: 0, pBand: 0, referenceKind: 'too-short' };

function persistedAsRef(row: CharacterCentroid): CharacterReference {
  return { centroid: row.centroid, cleanMean: row.cleanMean, pSevere: row.pSevere, pBand: row.pBand, referenceKind: row.referenceKind };
}

/**
 * Resolve the centroid reference for a character.
 *
 * In-book path: compute the character's centroid from anchor-eligible
 * vectors, derive the clean spread statistics. Always attempted fresh, every
 * call — cheap (pure local math, no TTS) — so a character can upgrade from
 * a prior audition/too-short result the moment enough real anchors exist
 * (srv-36 hardening, spec §2).
 *
 * Too-thin/bimodal path: if `persisted` is already a terminal `'too-short'`
 * row, that state is ABSORBING — return it verbatim, never call
 * `auditionCentroid` again. If `persisted` is a successful `'audition'` row,
 * reuse it verbatim — no new renders. Otherwise (no persisted state, or a
 * stale 'in-book' row that no longer qualifies), attempt the Option-B
 * audition centroid; its three possible outcomes map onto this function's
 * three outcomes 1:1 (see `ReferenceOutcome`'s doc comment).
 *
 * @param anchorVecs  Anchor-eligible embedding vectors collected from the book.
 * @param voiceInfo   Optional voice info for Option-B (absent when no snapshot).
 * @param persisted   This character's prior-run row from centroids.json, if any.
 * @param auditionOpts  Test-only synth/embed fn overrides, forwarded to auditionCentroid.
 */
async function resolveCharacterReference(
  anchorVecs: Float32Array[],
  voiceInfo: AuditionCharacter | undefined,
  persisted: CharacterCentroid | undefined,
  auditionOpts?: Pick<AuditionCentroidOpts, 'synthFn' | 'embedFn'>,
): Promise<ReferenceOutcome> {
  const result = buildCentroid(anchorVecs);

  if (result.kind === 'in-book' && !result.bimodal) {
    const centroidArr = Array.from(result.centroid);
    const cosines = anchorVecs
      .map((v) => cosineToCentroid(Array.from(v), centroidArr))
      .sort((a, b) => a - b);
    const cleanMean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
    const pSevere = percentile(cosines, CUTOFFS.severeEdgePctl);
    const pBand = percentile(cosines, CUTOFFS.bandUpperPctl);
    return { status: 'resolved', ref: { centroid: centroidArr, cleanMean, pSevere, pBand, referenceKind: 'in-book' } };
  }

  if (persisted?.referenceKind === 'too-short') {
    return { status: 'too-short', ref: persistedAsRef(persisted) };
  }
  if (persisted?.referenceKind === 'audition') {
    return { status: 'resolved', ref: persistedAsRef(persisted) };
  }
  if (!voiceInfo) {
    return { status: 'too-short', ref: TOO_SHORT_REF };
  }

  const audition = await auditionCentroid(voiceInfo, {
    existingAnchors: result.kind === 'too-thin' ? anchorVecs : [],
    synthFn: auditionOpts?.synthFn,
    embedFn: auditionOpts?.embedFn,
  });

  if (audition === null) return { status: 'transient-failure' };
  if (audition.kind === 'too-short') return { status: 'too-short', ref: TOO_SHORT_REF };

  const centroidArr = Array.from(audition.centroid);
  const cosines = audition.embeddings
    .map((v) => cosineToCentroid(Array.from(v), centroidArr))
    .sort((a, b) => a - b);
  const cleanMean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
  const pSevere = percentile(cosines, CUTOFFS.severeEdgePctl);
  const pBand = percentile(cosines, CUTOFFS.bandUpperPctl);
  return { status: 'resolved', ref: { centroid: centroidArr, cleanMean, pSevere, pBand, referenceKind: 'audition' } };
}
```

**Import changes required** (read the current top-of-file import block first — do not guess at line numbers, they will have shifted from what's quoted below once Tasks 1/2 have landed):

1. Change `import { auditionCentroid, type AuditionCharacter } from './audition-centroid.js';` to `import { auditionCentroid, type AuditionCharacter, type AuditionCentroidOpts } from './audition-centroid.js';`.
2. Change `import { writeCentroids, type CharacterCentroid } from './centroids-io.js';` to `import { readCentroids, writeCentroids, type CharacterCentroid } from './centroids-io.js';`.
3. Add `import { CENTROID_MIN_N, buildCentroid } from './centroid.js';` — **replacing** whatever the current `buildCentroid`-only import line from `./centroid.js` is (Step 4's cheap-first sort uses `CENTROID_MIN_N`, exported from `centroid.ts:19`; it is a SEPARATE export from `buildCentroid` and must be imported explicitly — it is easy to add the sort code in Step 4 and forget this import, which fails the build with `Cannot find name 'CENTROID_MIN_N'`).
4. Add a new import line: `import { readPendingAttempts, writePendingAttempts } from './pending-attempts-io.js';`.
5. Find the existing import of `writeVerdicts` (and possibly `readVerdicts`) from `./verdicts-io.js`. Add `mergeVerdictRows` to it. **Then check whether `writeVerdicts` is still called anywhere else in this file after Step 4's edit below removes its one call site in `scoreBook`** (Task 2's `mergeVerdictRows` calls `writeVerdicts` internally, but that's a call *inside `verdicts-io.ts`*, not a reason to keep importing `writeVerdicts` into `aggregate.ts`). If Step 4 is the only place `aggregate.ts` called `writeVerdicts`, **remove `writeVerdicts` from this file's import list entirely** — `server/tsconfig.json` sets `noUnusedLocals: true`, so an orphaned import is a hard build error, not a lint warning. Grep this file for `writeVerdicts(` after finishing Step 4 to confirm before moving to Step 5 of this task.

- [ ] **Step 4: Replace `scoreBook`'s Phase 3 + Phase 4 with the interleaved per-character loop**

Replace `scoreBook`'s signature and everything from `// ── Phase 3: Build centroids...` through the end of the function (today's lines ~484-572) with:

```typescript
export async function scoreBook(
  bookDir: string,
  chapters: { id: number; slug: string }[],
  justFinalizedSlugs?: Iterable<string>,
  opts?: {
    /** Fires exactly once, before the per-character loop starts, with the
        final roster size — independent of whether any character actually
        resolves this run (round-2 plan-review fix: firing "started" lazily
        inside the first onCharacterScored callback meant a run where every
        character hit a transient failure — the exact "book is stuck, please
        resume" scenario this feature targets — never announced itself as
        started at all). */
    onRosterKnown?: (total: number) => void;
    onCharacterScored?: (characterId: string, index: number, total: number) => void;
    /** Test-only — forwarded to every auditionCentroid call this run. */
    __testSynthFn?: AuditionCentroidOpts['synthFn'];
    __testEmbedFn?: AuditionCentroidOpts['embedFn'];
  },
): Promise<{ usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }> {
  const NO_TIERS = { usedQwenTiers: { keep06: false, keep17: false } };
  const root = audioDir(bookDir);
  const justFinalized = new Set(justFinalizedSlugs ?? chapters.map((c) => c.slug));

  // ── Phase 1: Collect per-chapter embeddings + segments ─────────────────
  // (UNCHANGED from today — same loop, same ChapterData/SnapshotView types,
  // same GH #1436 attempted-sentinel logic. Not reproduced here; do not
  // touch it as part of this task.)

  if (chapterData.length === 0) return NO_TIERS;

  // ── Phase 2: Gather anchor-eligible vectors per character ───────────────
  // (UNCHANGED from today through the `anchorVecsByChar` population — same
  // classificationSources/configuredEngineByChar/voiceInfoByChar/
  // stochasticChars/anchorVecsByChar construction. Not reproduced here; do
  // not touch it as part of this task.)

  if (stochasticChars.size === 0) return NO_TIERS;

  // ── Phase 3+4: resolve, persist, and score each character as it resolves ──
  // srv-36 hardening: interleaved instead of two separate batch phases, so
  // a cheap character's result is visible on disk immediately instead of
  // waiting for every character (including expensive too-thin ones) to
  // finish first. Cheap-first ordered so that's ALSO true in practice, not
  // just in theory (an expensive character sorting first in the old
  // first-chapter-appearance order would otherwise still delay the first
  // write for no reason).

  const centroidsMap: Record<string, CharacterCentroid> = (await readCentroids(bookDir)) ?? {};
  const pendingMap: Record<string, number> = (await readPendingAttempts(bookDir)) ?? {};
  const MAX_PENDING_ATTEMPTS = 3;

  const orderedChars = Array.from(stochasticChars).sort((a, b) => {
    const aReady = (anchorVecsByChar.get(a)?.length ?? 0) >= CENTROID_MIN_N ? 0 : 1;
    const bReady = (anchorVecsByChar.get(b)?.length ?? 0) >= CENTROID_MIN_N ? 0 : 1;
    return aReady - bReady;
  });
  opts?.onRosterKnown?.(orderedChars.length);

  /** Returns the number of `voice-mismatch` rows written for this character
   *  this call — accumulated by the caller into a run-total mismatch count
   *  (round-2 plan-review fix: `scoring_complete`'s `mismatchCount` must be
   *  a real count, not the hardcoded 0 an earlier draft shipped, which
   *  would have permanently logged a false "0 mismatches found" into the
   *  Activity feed via buildScoringCompleteEvent regardless of the actual
   *  result). */
  async function scoreAndMergeCharacter(charId: string, ref: CharacterReference): Promise<number> {
    const configuredEngine = configuredEngineByChar.get(charId) ?? '';
    let mismatchCount = 0;
    for (const cd of chapterData) {
      const rowsForChar: VerdictRow[] = [];
      for (const row of cd.embRows) {
        if (row.characterId !== charId) continue;
        const key = segKey(row.characterId, row.sentenceIds);
        const seg = cd.segsByKey.get(key);
        const renderedFallback = seg?.renderedFallbackEngine ?? null;
        const renderedEngine = (renderedFallback != null && renderedFallback !== '') ? renderedFallback : configuredEngine;

        if (ref.referenceKind === 'too-short') {
          rowsForChar.push({
            characterId: row.characterId, sentenceIds: row.sentenceIds, verdict: 'inconclusive',
            cosine: 0, severity: 'inconclusive', fixable: false,
            expectedEngine: configuredEngine, renderedEngine, referenceKind: 'too-short', windowed: false, chapterId: cd.id,
          });
          continue;
        }
        const cosine = cosineToCentroid(Array.from(row.vec), ref.centroid);
        const { verdict, severity } = scoreSegment(cosine, ref, ASSUMED_DURATION_SEC);
        const fixable = verdict === 'voice-mismatch' && severity === 'severe' && STOCHASTIC_ENGINES.has(configuredEngine);
        if (verdict === 'voice-mismatch') mismatchCount++;
        rowsForChar.push({
          characterId: row.characterId, sentenceIds: row.sentenceIds, verdict, cosine, severity, fixable,
          expectedEngine: configuredEngine, renderedEngine, referenceKind: ref.referenceKind, windowed: false, chapterId: cd.id,
        });
      }
      if (rowsForChar.length === 0) continue;
      await mergeVerdictRows(join(root, `${cd.slug}.render-integrity.json`), charId, rowsForChar);
    }
    return mismatchCount;
  }

  let scoredCount = 0;
  let totalMismatches = 0;
  for (const charId of orderedChars) {
    const anchorVecs = anchorVecsByChar.get(charId)!;
    const persisted = centroidsMap[charId];

    const outcome = await resolveCharacterReference(
      anchorVecs,
      voiceInfoByChar.get(charId),
      persisted,
      { synthFn: opts?.__testSynthFn, embedFn: opts?.__testEmbedFn },
    );

    if (outcome.status === 'transient-failure') {
      const prior = pendingMap[charId] ?? 0;
      if (prior + 1 < MAX_PENDING_ATTEMPTS) {
        pendingMap[charId] = prior + 1;
        continue; // genuinely unresolved this run — nothing written, retried next trigger
      }
      delete pendingMap[charId];
      centroidsMap[charId] = { characterId: charId, ...TOO_SHORT_REF };
      await writeCentroids(bookDir, Object.values(centroidsMap));
      totalMismatches += await scoreAndMergeCharacter(charId, TOO_SHORT_REF);
      scoredCount++;
      opts?.onCharacterScored?.(charId, scoredCount, orderedChars.length);
      continue;
    }

    delete pendingMap[charId];
    centroidsMap[charId] = { characterId: charId, ...outcome.ref };
    await writeCentroids(bookDir, Object.values(centroidsMap));
    totalMismatches += await scoreAndMergeCharacter(charId, outcome.ref);
    scoredCount++;
    opts?.onCharacterScored?.(charId, scoredCount, orderedChars.length);
  }

  await writePendingAttempts(bookDir, pendingMap);

  const usedQwenTiers = { keep06: false, keep17: false };
  for (const info of voiceInfoByChar.values()) {
    if (info.modelKey === 'qwen3-tts-0.6b') usedQwenTiers.keep06 = true;
    if (info.modelKey === 'qwen3-tts-1.7b') usedQwenTiers.keep17 = true;
  }
  return { usedQwenTiers, mismatchCount: totalMismatches };
}
```

Note: `TOO_SHORT_REF` is spread (`...TOO_SHORT_REF`) into the `centroidsMap[charId]` object alongside `characterId` — since `TOO_SHORT_REF` already has exactly the `centroid`/`cleanMean`/`pSevere`/`pBand`/`referenceKind` fields `CharacterCentroid` needs, this produces a valid `CharacterCentroid` row without re-listing every field.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/audio/render-integrity/aggregate.test.ts`
Expected: PASS — all tests, old (unchanged behavior) and new.

- [ ] **Step 6: Run the FULL server test suite and fix the two known-breaking existing test files**

Run: `cd server && npm run test`
Expected: FAIL initially in at least these two known locations (found during plan review — fix both, then re-run to confirm PASS):

- **`server/src/audio/render-integrity/aggregate-audition-pool.test.ts`** — line ~98 asserts `.resolves.toBeUndefined()` on a `scoreBook(...)` call. Update to assert against the new `{ usedQwenTiers: {...} }` shape instead (`.resolves.toEqual({ usedQwenTiers: { keep06: expect.any(Boolean), keep17: expect.any(Boolean) } })` or a more specific expected value if the fixture's tiers are known).
- **`server/src/routes/generation-spk.test.ts`** — this is the actual home of `afterChapterFinalized`'s existing test coverage (not `generation.test.ts`). It `vi.mock`s `scoreBook` and asserts `expect(scoreBook).toHaveBeenCalledWith('/b1', [CH1], ['ch1'])` — now wrong because `triggerScoring` calls `scoreBook(bookDir, chapters, slugs, { onCharacterScored, onRosterKnown })` with a 4th argument; update the assertion to `expect(scoreBook).toHaveBeenCalledWith('/b1', [CH1], ['ch1'], expect.any(Object))`. It also has a `mockImplementationOnce(() => new Promise<void>(() => {}))` (a never-resolving promise used to test in-flight behavior) — its type annotation must change to `new Promise<{ usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }>(() => {})` to satisfy the new return type under `noImplicitAny`/strict mode.

If any FURTHER test file (beyond these two, found via the actual full-suite run) calls `scoreBook(...)` and asserts on its old return shape, fix that assertion too — do not change `scoreBook`'s new contract to accommodate a stale assertion.

- [ ] **Step 7: Commit**

```bash
git add server/src/audio/render-integrity/aggregate.ts server/src/audio/render-integrity/aggregate.test.ts
git commit -m "feat(server): interleave scoreBook's per-character resolve+persist, add retry-cap and cheap-first ordering"
```

---

### 4. `qa-report.ts` — embeddings-sourced roster, `charactersPending`, roster-aware scoring

**Files:**
- Modify: `server/src/audio/qa-report.ts`
- Test: `server/src/audio/qa-report.test.ts`

**Interfaces:**
- Consumes: `deriveBookOutline` (Task 2's `verdictCharactersByChapter`), `readEmbeddings` (`embeddings-io.ts`, unchanged), `readCentroids` (`centroids-io.ts`, unchanged).
- Produces: `AudioQaReport.voiceDrift` gains `charactersPending: string[]`. `chaptersScored`/`chaptersEmbedFailed` now roster-aware instead of file-presence-only.

- [ ] **Step 1: Write the failing tests**

Read `server/src/audio/qa-report.test.ts` in full first to match its existing fixture-writing helpers. Append:

```typescript
describe('qa-report — srv-36 hardening: embeddings-sourced roster + charactersPending', () => {
  it('a character present in a chapter\'s snapshot but with ZERO embedding rows there does not block that chapter from being fully scored', async () => {
    // ch1: narrator has embedding rows AND a verdict row. mairin appears in
    // the snapshot (she speaks in ch1) but every one of her lines there fell
    // under the duration floor — no embedding row for her in THIS chapter,
    // even though she resolved fine elsewhere in the book.
    const dir = /* mkdtempSync + write ch1.segments.json with narrator+mairin snapshots,
                   ch1.embeddings.json with ONLY narrator rows,
                   ch1.render-integrity.json with ONLY narrator's verdict row,
                   render-integrity.centroids.json with BOTH narrator and mairin resolved rows
                   — follow this file's existing fixture-writing pattern exactly */;
    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.voiceDrift.chaptersScored).toBe(1); // NOT stuck at 0
  });

  it('charactersPending lists a stochastic character with no row in centroids.json yet, and excludes a terminally too-short one', async () => {
    // ch1: narrator (resolved, in centroids.json), ren (no row at all — still
    // mid-retry-cycle), pell-hollis (a terminal too-short row in centroids.json).
    const dir = /* fixture as above, three characters */;
    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.voiceDrift.charactersPending).toEqual(['ren']);
    expect(report.voiceDrift.charactersPending).not.toContain('pell-hollis');
  });

  it('chaptersEmbedFailed excludes a chapter whose only unscored roster character is in charactersPending', async () => {
    const dir = /* ch1 attempted, narrator scored, ren present on roster + still charactersPending (no centroids row) */;
    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.voiceDrift.chaptersEmbedFailed).toBe(0);
  });

  it('chaptersEmbedFailed DOES count a chapter whose only unscored roster character is terminally capped (not in charactersPending)', async () => {
    // Deliberately hand-authored disk state (NOT a state a single scoreBook
    // run produces on its own — that's the point: this test exercises the
    // qa-report's OWN roster-vs-verdict comparison in isolation from
    // scoreBook's write ordering). Construct exactly this on disk:
    //   - ch1.embeddings.json: rows for BOTH narrator and pell-hollis.
    //   - ch1.segments.json: characterSnapshots for both, both classified
    //     stochastic (qwen) — this makes rosterByChapter = {narrator, pell-hollis}.
    //   - ch1.render-integrity-attempted.json: present (attempted).
    //   - ch1.render-integrity.json: verdict rows for narrator ONLY (simulates
    //     "narrator's per-character write landed, pell-hollis's per-character
    //     write for this chapter has NOT landed yet or was lost") —
    //     verdictCharactersByChapter.get(1) = {narrator} only.
    //   - render-integrity.centroids.json: narrator resolved (in-book) AND
    //     pell-hollis resolved too-short (a terminal row — present in
    //     centroids.json, so NOT in charactersPending).
    // Net effect: pell-hollis is on the roster, has a terminal centroid row
    // (not pending), but her verdict row for ch1 is missing — the chapter is
    // genuinely stuck, not "still working." That's what should count as
    // embed-failed.
    const dir = /* build exactly the fixture described above, mirroring this file's existing writeFileSync/writeEmbeddings/writeVerdicts/writeCentroids fixture-writing calls */;
    const report = await buildAudioQaReport(dir, [{ id: 1, slug: 'ch1' }]);
    expect(report.voiceDrift.chaptersEmbedFailed).toBe(1);
  });
});
```

(Each `/* ... */` fixture comment above must be filled in with real `writeFileSync`/`writeEmbeddings`/`writeVerdicts`/`writeCentroids` calls matching this test file's established style before this step is considered done — see Step 2's failure output for exactly which fixtures are missing. The last test's fixture is now fully specified field-by-field above; build exactly that state, no more, no less.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/audio/qa-report.test.ts`
Expected: FAIL — `report.voiceDrift.charactersPending` is `undefined`; `chaptersScored` still 0 in the first test.

- [ ] **Step 3: Implement**

In `server/src/audio/qa-report.ts`:

1. Add imports: `import { readEmbeddings } from './render-integrity/embeddings-io.js';` and `import { readCentroids } from './render-integrity/centroids-io.js';`.
2. Add `charactersPending: string[];` to the `AudioQaReport['voiceDrift']` interface, right after `uncheckedCharacterIds: string[];`.
3. Inside `buildAudioQaReport`, replace the block that currently computes `eligibleChapterIds` (the segments loop at lines ~70-99) to ALSO build a per-chapter roster sourced from embeddings, not from the segments loop's snapshot presence:

```typescript
  const rosterByChapter = new Map<number, Set<string>>();
  for (const ch of chapters) {
    const embPath = join(audioDir(bookDir), `${ch.slug}.embeddings.json`);
    const embResult = await readEmbeddings(embPath);
    if (!embResult) continue;
    const chapterChars = new Set<string>();
    for (const row of embResult.rows) {
      const engine = configuredEngineByChar.get(row.characterId);
      if (engine && STOCHASTIC_ENGINES.has(engine)) chapterChars.add(row.characterId);
    }
    if (chapterChars.size > 0) rosterByChapter.set(ch.id, chapterChars);
  }
```

   (Needs `join` and `audioDir` imports — add `import { join } from 'node:path';` and `import { audioDir } from '../workspace/paths.js';` if not already imported in this file; check the top of the file first — `deriveBookOutline`'s own module already imports `audioDir` this way, mirror it.) This block runs AFTER `configuredEngineByChar` is computed (it's already computed earlier in the function, at the `resolveConfiguredEngineByChar(segFiles)` call) — insert it right after that line, before the existing segments loop that builds `eligibleChapterIds`/`stochasticCharacterIds` (that loop is UNCHANGED — `rosterByChapter` is an addition alongside it, not a replacement of it; `eligibleChapterIds` still drives the acoustic/ASR line-count logic elsewhere in this function).

4. Replace the `chaptersScored`/`chaptersEmbedFailed` computation:

```typescript
  const outline = await deriveBookOutline(bookDir, chapters);
  const attribution: 'full' | 'legacy-unattributed' = outline.issues.some((r) => r.chapterId == null)
    ? 'legacy-unattributed'
    : 'full';
  const uncheckedSet = new Set(outline.counts.uncheckedCharacters);

  const centroids = (await readCentroids(bookDir)) ?? {};
  const charactersPending = Array.from(stochasticCharacterIds).filter((id) => !(id in centroids));

  const chaptersScored = Array.from(rosterByChapter.entries())
    .filter(([chapterId, roster]) => {
      const verdictChars = outline.verdictCharactersByChapter.get(chapterId);
      if (!verdictChars) return false;
      return Array.from(roster).every((id) => verdictChars.has(id));
    })
    .map(([chapterId]) => chapterId).length;

  const attemptedEligibleCount = outline.attemptedChapterIds.filter((id) => eligibleChapterIds.has(id)).length;
  const chaptersEmbedFailed = attemptedEligibleCount > 0
    ? Array.from(eligibleChapterIds).filter((chapterId) => {
        const roster = rosterByChapter.get(chapterId);
        const verdictChars = outline.verdictCharactersByChapter.get(chapterId);
        const fullyScored = !!roster && !!verdictChars && Array.from(roster).every((id) => verdictChars.has(id));
        if (fullyScored) return false;
        const hasPendingRosterChar = roster && Array.from(roster).some((id) => charactersPending.includes(id));
        return !hasPendingRosterChar && outline.attemptedChapterIds.includes(chapterId);
      }).length
    : 0;
```

   This REPLACES the existing `const chaptersScored = outline.scoredChapterIds.filter(...)` line and the existing `const chaptersEmbedFailed = attemptedEligibleCount > 0 ? attemptedEligibleCount - chaptersScored : 0;` line. Everything else in the function (the `return { ... }` object) is unchanged except adding `charactersPending` to the `voiceDrift` object being returned.

5. Add `charactersPending` to the returned object's `voiceDrift`:

```typescript
    voiceDrift: {
      attribution,
      chaptersEligible: eligibleChapterIds.size,
      chaptersScored,
      chaptersEmbedFailed,
      charactersOnRoster: stochasticCharacterIds.size,
      charactersChecked: Array.from(stochasticCharacterIds).filter((id) => !uncheckedSet.has(id)).length,
      charactersPending,
      mismatches: outline.issues.map((r) => ({
        characterId: r.characterId,
        chapterId: r.chapterId,
        fixable: r.fixable,
      })),
      inconclusiveCount: outline.inconclusiveChapterIds.length,
      uncheckedCharacterIds: outline.counts.uncheckedCharacters,
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/audio/qa-report.test.ts`
Expected: PASS. Then run the full suite once (`cd server && npm run test`) since `qa-report.ts` is read by the route in Task 6 — confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add server/src/audio/qa-report.ts server/src/audio/qa-report.test.ts
git commit -m "feat(server): source qa-report's per-chapter roster from embeddings, add charactersPending"
```

---

### 5. `openapi.yaml` — schema updates + regenerate `api-types.ts`

**Files:**
- Modify: `openapi.yaml`
- Regenerate: `src/lib/api-types.ts` (via script, not hand-edited)

**Interfaces:**
- Produces: `GenerationTick.type` gains `scoring_started | scoring_progress | scoring_complete`; new optional `GenerationTick` fields `charactersOnRoster`, `charactersChecked`, `mismatchCount`. `ChangeLogEvent.type` gains `scoring_started | scoring_complete`. `BookQaReport.voiceDrift` gains `charactersPending: string[]`.

- [ ] **Step 1: Edit `GenerationTick`'s `type` enum**

In `openapi.yaml`, find `GenerationTick:`'s `type` property (`enum: [progress, chapter_assembling, ...]`) and add the 3 new values, plus a description paragraph matching this schema's existing per-value documentation style:

```yaml
        type:
          type: string
          enum: [progress, chapter_assembling, chapter_verifying, chapter_recovering, chapter_complete, chapter_failed, idle, resume_from, warning, chapter_awaiting_fallback_confirm, scoring_started, scoring_progress, scoring_complete]
          description: |
            [... existing description text, unchanged, with this appended:]
            `scoring_started` / `scoring_progress` / `scoring_complete` (srv-36
            hardening) surface the voice-match background scoring pass:
            `scoring_started` fires once when a scoreBook run begins, carrying
            `charactersOnRoster`; `scoring_progress` fires once per character
            resolved, carrying `characterId` (reusing the existing field above)
            plus updated `charactersChecked`/`charactersOnRoster`;
            `scoring_complete` fires once at the end, carrying final
            `charactersChecked`/`charactersOnRoster`/`mismatchCount`. Scoped to
            the book the stream handle belongs to (no separate `bookId` field
            needed — same as every other tick type here).
```

- [ ] **Step 2: Add the new optional `GenerationTick` fields**

In the same `GenerationTick` schema, add two new properties (reuse the existing `characterId` field for `scoring_progress`'s per-character id — do not add a duplicate field):

```yaml
        charactersOnRoster:
          type: integer
          description: srv-36 hardening — total stochastic characters being scored this run. Carried on scoring_started/scoring_progress/scoring_complete.
        charactersChecked:
          type: integer
          description: srv-36 hardening — characters resolved so far this run. Carried on scoring_progress/scoring_complete.
        mismatchCount:
          type: integer
          description: srv-36 hardening — total voice-mismatch verdicts found. Carried on scoring_complete only.
```

- [ ] **Step 3: Extend `ChangeLogEvent`'s `type` enum**

Add `scoring_started` and `scoring_complete` to the existing enum list (after `reparse`):

```yaml
                reparse,
                scoring_started,
                scoring_complete,
              ],
```

- [ ] **Step 4: Add `charactersPending` to `BookQaReport.voiceDrift`**

In the `BookQaReport.voiceDrift` schema, add to `required` and `properties`:

```yaml
        voiceDrift:
          type: object
          required: [attribution, chaptersEligible, chaptersScored, chaptersEmbedFailed, charactersOnRoster, charactersChecked, charactersPending, mismatches, inconclusiveCount, uncheckedCharacterIds]
          properties:
            # ...existing properties unchanged, insert this after charactersChecked...
            charactersPending:
              type: array
              items: { type: string }
              description: >-
                srv-36 hardening — stochastic characters with no row in
                centroids.json yet: genuinely incomplete (never attempted, or
                mid-retry-cycle under the transient-failure cap). Drives the
                frontend's Resume-scoring affordance — narrower than
                "charactersChecked < charactersOnRoster", which also stays
                true forever for a terminally too-short character (nothing
                left to resume for those).
```

- [ ] **Step 5: Regenerate `api-types.ts`**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` is rewritten; `git diff src/lib/api-types.ts` shows the new `GenerationTick`/`ChangeLogEvent`/`BookQaReport` shapes reflected.

- [ ] **Step 6: Typecheck to confirm nothing else references the old shapes incorrectly**

Run: `npm run typecheck`
Expected: PASS (no other code references these types yet in a way that would break — this task only changes the schema + generated types, no consumers yet).

- [ ] **Step 7: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(openapi): add srv-36 scoring SSE tick types, change-log event types, and charactersPending"
```

---

### 6. `generation.ts` — extract `triggerScoring`, wire SSE emission

**Files:**
- Modify: `server/src/routes/generation.ts`
- Test: `server/src/routes/generation.test.ts`

**Interfaces:**
- Consumes: `scoreBook` (Task 3's new signature/return, including the new `onRosterKnown` opt), `isGenerationActive` (already exported in this file, unchanged — reused for Task 7's route guard, not modified here).
- Produces: `export async function triggerScoring(ctx: { bookId: string; bookDir: string; chapters: { id: number; slug: string }[]; justFinalizedSlugs: Iterable<string>; keep?: { keep06: boolean; keep17: boolean } }): Promise<void>` (fire-and-forget — resolves once the run is *registered*, not once it *completes*), plus a test-only `export async function __awaitScoringSettled(bookId: string): Promise<void>` for observing the background run's effects deterministically.

**Round-2 plan-review fix — how SSE ticks actually reach a client (this was the plan's most dangerous gap: the round-1 draft defined `onScoringEvent` as a param on `triggerScoring` but no caller ever supplied one, so nothing was ever emitted).** `generation.ts` already has exactly the primitive this needs, module-private and unexported because nothing outside this file has needed it before:

- `const inFlightByBook: Map<string, Set<RunningJob>>` (`generation.ts:368`) — every currently-running job for a book, looked up LIVE (not closure-captured), so it reaches a client that (re)connected after the original POST too.
- `function broadcast(job: RunningJob, ev: unknown): void` (`generation.ts:505-535`) — writes `ev` to every subscriber of one job, swallowing dead-socket errors.

`triggerScoring` lives in the same module, so it can call these directly — no new export, no callback threaded in from outside. Add one small helper next to `broadcast` (read `broadcast`'s exact body first and mirror its per-subscriber error handling precisely rather than guessing — the sketch below shows the required DEDUPE behavior, not the exact error-swallowing mechanics, which must match `broadcast`'s real implementation):

```typescript
/** srv-36 hardening — push an arbitrary tick to every client currently
 *  subscribed to ANY of this book's in-flight jobs. Unlike `broadcast`
 *  (one job → its subscribers), this fans out to every live job for the
 *  book, because `scoreBook` re-scores the whole book, not one chapter.
 *  De-duplicated by underlying `res`: the bare-resume reconnect path
 *  (~generation.ts:1010-1039) can register the SAME client's {send,res}
 *  as a distinct Subscriber into MULTIPLE sibling jobs for one book, and
 *  without de-duping that client would receive one copy of this tick per
 *  sibling job. */
function broadcastToBook(bookId: string, ev: unknown): void {
  const jobs = inFlightByBook.get(bookId);
  if (!jobs) return;
  const uniqueSubs = new Map<Response, Subscriber>();
  for (const job of jobs) {
    for (const sub of job.subscribers) uniqueSubs.set(sub.res, sub);
  }
  for (const sub of uniqueSubs.values()) sub.send(ev); // mirror broadcast()'s real error handling here
}
```

**Architectural limit, by design, not a bug — and broader than just the resume path (round-2 plan-review finding).** `inFlightByBook.get(bookId)` only has entries while a generation job is actively rendering, and its entry for a book is deleted (`deregisterJob`) the moment that book's LAST running job drains — which can happen only moments after the final chapter's `afterChapterFinalized` fires, while `scoreBook`'s slow audition-centroid tail (the whole reason this feature exists — "tens of minutes," per the spec's Problem section) is often still running in the background. Two distinct cases end up with no live subscribers to broadcast to:

1. **The resume route (Task 7)** — by construction only ever runs when `isGenerationActive(bookId)` is false. No job, ever, for the whole call.
2. **The tail of a chapter-finalize-triggered run, once the book's last job has drained** — even though this call started with a live job open, that job can close (all its chapters done) before the slow per-character loop finishes. Live ticks broadcast fine for whatever portion of the run overlaps active rendering (e.g. a sibling chapter still synthesizing while `ren`'s audition-centroid fallback runs), then silently stop being observable once the book finishes rendering, even though `scoreBook` keeps working.

Both are expected, not regressions to fix in this plan: there is no open stream to push a background tick through once nothing is rendering, full stop — holding a job/subscriber alive artificially for the sole purpose of scoring progress would be new, out-of-scope infrastructure (a "fake" job with no actual render work), not a wiring fix. The consequence is that live progress is a **best-effort overlay for the portion of scoring that overlaps active generation**, not a guarantee that the whole scoring pass is observable live — the static "X of Y checked so far" + Resume-button state (Task 13, already designed for exactly the "no live progress right now" case) is what a user sees once the live portion ends, whether because nothing is generating at all (resume) or because generation just finished while scoring was still catching up (the tail case). **Task 14's e2e spec must test the MECHANISM (a tick fires, the UI reflects it, while a job is registered as active) — it must NOT assert that a full scoring run's ticks are ALL guaranteed to arrive live, since the tail case means they may not be.** See Task 14's own note for how its test is scoped accordingly.

- [ ] **Step 1: Write the failing tests**

Read `server/src/routes/generation.test.ts` in full first (it's large — find how it currently tests `afterChapterFinalized` if at all, and its fixture-book-setup helpers) before appending. Add:

```typescript
describe('triggerScoring (srv-36 hardening)', () => {
  // Round-2 plan-review fix: `triggerScoring` itself is fire-and-forget —
  // it returns as soon as `scoringInFlight.set(ctx.bookId, run)` completes,
  // NOT once `run` (the actual scoreBook call + broadcast + reconcile) has
  // settled. `await triggerScoring(...)` alone races that background work;
  // every test below that asserts on an EFFECT of the background run must
  // also `await __awaitScoringSettled(bookId)` (added in Step 3 below,
  // alongside `triggerScoring`) before asserting.

  it('no-ops without calling scoreBook when qa.speaker.enabled is off', async () => {
    // Arrange: configValue('qa.speaker.enabled') returns false (mock/stub per this
    // file's existing configValue-mocking pattern — check how other tests in this
    // file already stub configValue and reuse that exact mechanism).
    const scoreBookSpy = /* spy on the imported scoreBook */;
    await triggerScoring({ bookId: 'b1', bookDir: '/tmp/b1', chapters: [], justFinalizedSlugs: [] });
    // No __awaitScoringSettled needed here — the qa.speaker.enabled guard
    // returns synchronously before scoringInFlight is ever set.
    expect(scoreBookSpy).not.toHaveBeenCalled();
  });

  it('when keep is supplied, reconciles against it verbatim (chapter-finalize path behavior, unchanged)', async () => {
    const reconcileSpy = /* spy on reconcileResidentQwenTiers */;
    await triggerScoring({ bookId: 'b1', bookDir: /* fixture */, chapters: [{ id: 1, slug: 'ch1' }], justFinalizedSlugs: ['ch1'], keep: { keep06: true, keep17: false } });
    await __awaitScoringSettled('b1');
    expect(reconcileSpy).toHaveBeenCalledWith({ keep06: true, keep17: false });
  });

  it('when keep is omitted, reconciles against scoreBook\'s own usedQwenTiers (resume-route path)', async () => {
    const reconcileSpy = /* spy on reconcileResidentQwenTiers */;
    // fixture: a qwen3-tts-1.7b character.
    await triggerScoring({ bookId: 'b1', bookDir: /* fixture */, chapters: [{ id: 1, slug: 'ch1' }], justFinalizedSlugs: [] });
    await __awaitScoringSettled('b1');
    expect(reconcileSpy).toHaveBeenCalledWith({ keep06: false, keep17: true });
  });

  it('broadcasts scoring_started/progress/complete to every subscriber of every in-flight job for the book, de-duplicated by res', async () => {
    // Arrange: register two fake RunningJobs for bookId 'b1' into inFlightByBook
    // (or, if that map isn't test-accessible, drive this through the real
    // POST /:bookId/generation SSE subscribe flow this file's existing SSE
    // tests already use — check for an existing "subscribes to an in-flight
    // job" test and copy its harness). One job has subscriber A; the other
    // has subscribers A (same res as the first — the bare-resume reconnect
    // case) and B.
    const received: unknown[] = [];
    // subA.send / subB.send both push into `received`, tagged by which sub.
    await triggerScoring({ bookId: 'b1', bookDir: /* 2-character in-book fixture, no sidecar needed */, chapters: [{ id: 1, slug: 'ch1' }], justFinalizedSlugs: ['ch1'] });
    await __awaitScoringSettled('b1');
    // subA must receive each tick type exactly ONCE (not twice, despite being
    // registered on two jobs); subB must also receive each tick type once.
  });

  it('resume-shaped call (no in-flight job for the book) completes without throwing even though broadcastToBook has nothing to send to', async () => {
    await triggerScoring({ bookId: 'b-not-generating', bookDir: /* fixture */, chapters: [{ id: 1, slug: 'ch1' }], justFinalizedSlugs: [] });
    await expect(__awaitScoringSettled('b-not-generating')).resolves.toBeUndefined();
  });
});
```

(Fill in the `/* ... */` placeholders using this test file's existing conventions for mocking `configValue`, spying on `scoreBook`/`reconcileResidentQwenTiers`, registering fake in-flight jobs/subscribers, and building a fixture book directory — do not invent new conventions; every other describe block in this file already has these patterns. If `inFlightByBook`/`RunningJob`/`Subscriber` aren't already exported for tests, this task may need to add a test-only export of `inFlightByBook` guarded the same way any other test-only export in this file already is — check for an existing precedent before adding a new one.)

**Round-2 plan-review caution:** the first test needs `scoreBook` mocked/spied-and-never-called; the "broadcasts to every subscriber" and reconcile tests need the REAL `scoreBook` to run against an on-disk fixture so its callbacks actually fire. Toggling a module-level mock of `scoreBook` on and off between tests in the same file is a known flake source in this codebase (module-mock state leaking across tests via `vi.mock`/`importOriginal` timing). Do not `vi.mock('../audio/render-integrity/aggregate.js')` at the top of this file for just the one no-op test — either use `vi.spyOn` scoped and restored per-test (`vi.restoreAllMocks()` in an `afterEach`), or split the "qa.speaker.enabled off" case into its own separate top-level `describe`/file section that never touches the real fixture-running tests' module state. Check this file's existing tests for whichever pattern it already uses elsewhere for a similar mock/real split, and match it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/generation.test.ts`
Expected: FAIL — `triggerScoring` is not exported yet.

- [ ] **Step 3: Extract `triggerScoring`, add `onRosterKnown`/`onCharacterScored` → `broadcastToBook` wiring**

In `server/src/routes/generation.ts`, first add the `broadcastToBook` helper (shown above) directly below the existing `broadcast` function. Then replace `afterChapterFinalized`'s body (today's lines 111-182) with:

```typescript
export async function triggerScoring(ctx: {
  bookId: string;
  bookDir: string;
  chapters: { id: number; slug: string }[];
  justFinalizedSlugs: Iterable<string>;
  /** Full-cast-superset tier set, supplied by the chapter-finalize path
      (unchanged from today — protects an in-flight sibling chapter's tier,
      see the reconcile comment below). Omitted by the resume route, which
      has no live run to derive a superset from and instead reconciles
      against scoreBook's own precise usedQwenTiers — safe there because
      resume never runs concurrently with an in-flight sibling render. */
  keep?: { keep06: boolean; keep17: boolean };
}): Promise<void> {
  if (!configValue('qa.speaker.enabled')) return;
  if (scoringInFlight.has(ctx.bookId)) return;

  const run = (async () => {
    const result = await scoreBook(ctx.bookDir, ctx.chapters, ctx.justFinalizedSlugs, {
      onRosterKnown: (total) => {
        broadcastToBook(ctx.bookId, { type: 'scoring_started', charactersOnRoster: total });
      },
      onCharacterScored: (characterId, index, total) => {
        broadcastToBook(ctx.bookId, { type: 'scoring_progress', characterId, charactersChecked: index, charactersOnRoster: total });
      },
    });
    broadcastToBook(ctx.bookId, { type: 'scoring_complete', mismatchCount: result.mismatchCount });
    const keep = ctx.keep ?? result.usedQwenTiers;
    if (keep.keep06 || keep.keep17) await reconcileResidentQwenTiers(keep);
  })()
    .catch((e) => console.warn(`[generation] render-integrity score pass failed: ${String(e)}`))
    .finally(() => scoringInFlight.delete(ctx.bookId));
  scoringInFlight.set(ctx.bookId, run);
}

/** Test-only — `triggerScoring` is deliberately fire-and-forget (same
 *  rationale as today's inline block: scoreBook can make unbounded blocking
 *  sidecar calls, so the chapter-finalize/resume callers must never await
 *  it directly). Tests that need to observe an effect of the background
 *  run (a reconcile call, a broadcast, a written file) await this instead
 *  of `triggerScoring` itself. Resolves immediately (undefined) if no run
 *  is or ever was in flight for `bookId`. */
export async function __awaitScoringSettled(bookId: string): Promise<void> {
  await scoringInFlight.get(bookId);
}

export async function afterChapterFinalized(
  ctx: {
    bookId: string;
    bookDir: string;
    chapters: { id: number; slug: string }[];
    justFinalized: { id: number; slug: string };
    keep: { keep06: boolean; keep17: boolean };
  },
) {
  if (!configValue('qa.speaker.enabled')) return;
  await writeAttempted(attemptedPath(audioDir(ctx.bookDir), ctx.justFinalized.slug));
  await triggerScoring({ ...ctx, justFinalizedSlugs: [ctx.justFinalized.slug], keep: ctx.keep });
}
```

`afterChapterFinalized`'s own `if (!configValue(...)) return;` guard stays exactly where it is today (before `writeAttempted`) — this is intentionally duplicated with `triggerScoring`'s own guard (spec §4, round-3 fix: NOT a relocation, both callers get independent protection).

- [ ] **Step 4: Wire the new tick types into whatever validates/types outgoing SSE payloads in this file**

If `send`/`broadcast`'s call sites are typed against the `GenerationTick` union (check whether `Subscriber.send` or `broadcast`'s `ev` param has a type annotation narrower than `unknown` anywhere in this file), confirm the objects passed to `broadcastToBook` above satisfy it — Task 5 already added `scoring_started`/`scoring_progress`/`scoring_complete` plus `charactersOnRoster`/`charactersChecked`/`mismatchCount` to the `GenerationTick` openapi schema and regenerated `api-types.ts`, so this should typecheck without further changes; this step is a verification, not new code.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/generation.test.ts`
Expected: PASS. Then `cd server && npm run test` for the full suite (this file is central; several other test files exercise `afterChapterFinalized` indirectly through generation-flow tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/generation.ts server/src/routes/generation.test.ts
git commit -m "feat(server): extract triggerScoring, broadcast scoring SSE ticks to a book's live subscribers"
```

---

### 7. `qa-report.ts` route — `POST /:bookId/resume-scoring`

**Files:**
- Modify: `server/src/routes/qa-report.ts`
- Test: `server/src/routes/qa-report.test.ts`

**Interfaces:**
- Consumes: `triggerScoring`, `isGenerationActive` (both exported from `server/src/routes/generation.ts` — Task 6 and pre-existing respectively).

**Implementation note (deviates from the spec's literal text, same intent):** the spec (§4) describes the in-progress guard as checking "the same in-progress signal `queue-boot.ts`'s orphan-reset sweep uses." `generation.ts` already exports a more precise, purpose-built helper for exactly this — `isGenerationActive(bookId): boolean`, an in-memory check doc-commented "so sibling routes can refuse operations that would race the write path." Use that instead of a queue-file read: same intent (refuse resume while the book is actively generating), simpler, and already the established pattern other routes in this codebase use for this exact check.

- [ ] **Step 1: Write the failing tests**

Read `server/src/routes/qa-report.test.ts` in full first (its existing `GET /:bookId/qa-report` test setup — supertest-style request helper, fixture book) before appending:

```typescript
describe('POST /:bookId/resume-scoring', () => {
  it('triggers scoring and returns 202', async () => {
    // fixture: a book with a rendered chapter that has an unresolved stochastic character.
    const res = await request(app).post(`/api/books/${bookId}/resume-scoring`);
    expect(res.status).toBe(202);
    // assert centroids.json eventually gets the character's row (poll or await triggerScoring directly if this route awaits it — check the implementation step below for which).
  });

  it('returns 409 when the book has an active generation job', async () => {
    // Arrange: isGenerationActive(bookId) returns true (stub per this file's
    // existing mocking conventions for functions imported from generation.ts,
    // if any exist — otherwise mock the module directly).
    const res = await request(app).post(`/api/books/${bookId}/resume-scoring`);
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown bookId', async () => {
    const res = await request(app).post('/api/books/does-not-exist/resume-scoring');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/qa-report.test.ts`
Expected: FAIL — 404 for a route that doesn't exist yet (Express's default for an unmatched route, not this handler's own 404).

- [ ] **Step 3: Implement the route**

In `server/src/routes/qa-report.ts`, add the import and the new route:

```typescript
import { triggerScoring, isGenerationActive } from './generation.js';

// ...(existing GET /:bookId/qa-report route, unchanged)...

/* srv-36 hardening — manual resume for a scoreBook run that got interrupted
   (server restart mid-run) on a book with no more chapters left to render,
   so nothing would otherwise re-trigger it. Fire-and-forget through the
   SAME triggerScoring/scoringInFlight single-flight path the chapter-finalize
   flow uses — a click while a run is already active safely no-ops there. */
qaReportRouter.post('/:bookId/resume-scoring', async (req: Request, res: Response) => {
  try {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    if (isGenerationActive(bookId)) {
      res.status(409).json({ error: 'Book is currently generating — resume scoring once the run finishes.' });
      return;
    }
    const { bookDir, state } = located;
    void triggerScoring({ bookId, bookDir, chapters: state.chapters, justFinalizedSlugs: [] });
    res.status(202).json({ started: true });
  } catch (e) {
    console.error('[qa-report] POST resume-scoring failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to resume scoring.' });
  }
});
```

(`triggerScoring` is fire-and-forget here — same non-blocking rationale as the existing chapter-finalize call site, `generation.ts`'s doc comment on the original inline block: `scoreBook` can make unbounded blocking sidecar calls, so the route returns `202 Accepted` immediately rather than awaiting completion.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/qa-report.test.ts`
Expected: PASS. If the "triggers scoring" test needs to observe the eventual `centroids.json` write, either await `triggerScoring` directly in a unit-level test of the handler logic (bypassing the fire-and-forget for test purposes) or poll with a short timeout — match whatever async-completion pattern this test file already uses elsewhere for fire-and-forget routes (check `POST /:bookId/generation`'s own test in `generation.test.ts` for precedent since it has the same shape).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/qa-report.ts server/src/routes/qa-report.test.ts
git commit -m "feat(server): add POST /:bookId/resume-scoring route"
```

---

### 8. Frontend `api.ts` — `resumeScoring`

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces: `api.resumeScoring(bookId: string): Promise<void>`.

- [ ] **Step 1: Add the real + mock implementations**

Find `realGetQaReport`/`mockGetQaReport` in `src/lib/api.ts` (around line 2099-2110) and add directly after:

```typescript
async function realResumeScoring(bookId: string): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/resume-scoring`, { method: 'POST' });
  if (!res.ok && res.status !== 409)
    throw new Error(
      `Resume scoring failed (${res.status}): ${(await res.text()) || res.statusText}`,
    );
  if (res.status === 409) throw Object.assign(new Error('Book is currently generating.'), { code: 'generation-active' });
}

async function mockResumeScoring(_bookId: string): Promise<void> {
  // No-op in mock mode — there's no real scoreBook to trigger.
}
```

- [ ] **Step 2: Wire into the `mock`/`real` objects and the exported `api`**

Find the `mock = { ..., getQaReport: mockGetQaReport, ... }` and `real = { ..., getQaReport: realGetQaReport, ... }` object literals (near lines 8833/9077) and add `resumeScoring: mockResumeScoring,` / `resumeScoring: realResumeScoring,` respectively, right after each object's `getQaReport` entry.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): add api.resumeScoring"
```

---

### 9. Frontend `change-log.ts` — scoring event builders

**Files:**
- Modify: `src/lib/change-log.ts`
- Test: `src/lib/change-log.test.ts`

**Interfaces:**
- Produces: `buildScoringStartedEvent(args: { charactersOnRoster: number; now?: Date }): ChangeLogEvent`, `buildScoringCompleteEvent(args: { mismatchCount: number; now?: Date }): ChangeLogEvent`.

- [ ] **Step 1: Write the failing tests**

Read `src/lib/change-log.test.ts`'s existing tests for `buildGenerationStartedEvent`/`buildGenerationRunCompleteEvent` first to match style, then append:

```typescript
describe('buildScoringStartedEvent', () => {
  it('builds a scoring_started event naming the character count', () => {
    const ev = buildScoringStartedEvent({ charactersOnRoster: 13, now: new Date('2026-07-08T00:00:00Z') });
    expect(ev.type).toBe('scoring_started');
    expect(ev.title).toContain('13');
    expect(ev.actor).toBe('system');
  });
});

describe('buildScoringCompleteEvent', () => {
  it('builds a scoring_complete event naming zero mismatches', () => {
    const ev = buildScoringCompleteEvent({ mismatchCount: 0, now: new Date('2026-07-08T00:00:00Z') });
    expect(ev.type).toBe('scoring_complete');
    expect(ev.note).toContain('0 mismatches');
  });

  it('pluralizes a nonzero mismatch count', () => {
    const ev = buildScoringCompleteEvent({ mismatchCount: 3, now: new Date('2026-07-08T00:00:00Z') });
    expect(ev.note).toContain('3 mismatches');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/change-log.test.ts`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement**

Add to `src/lib/change-log.ts`, after `buildGenerationRunCompleteEvent`:

```typescript
/** System-emitted event: the srv-36 voice-match scoring pass started running
    in the background. See buildScoringCompleteEvent for its terminal pair. */
export function buildScoringStartedEvent(args: { charactersOnRoster: number; now?: Date }): ChangeLogEvent {
  const { charactersOnRoster } = args;
  const now = args.now ?? new Date();
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'scoring_started',
    title: 'Voice-match scoring started',
    note: `Checking ${charactersOnRoster} character${charactersOnRoster === 1 ? '' : 's'} against their own voice.`,
    actor: 'system',
  };
}

/** System-emitted event: the srv-36 voice-match scoring pass finished. */
export function buildScoringCompleteEvent(args: { mismatchCount: number; now?: Date }): ChangeLogEvent {
  const { mismatchCount } = args;
  const now = args.now ?? new Date();
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'scoring_complete',
    title: 'Voice-match scoring complete',
    note: `${mismatchCount} mismatch${mismatchCount === 1 ? '' : 'es'} found.`,
    actor: 'system',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/change-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-log.ts src/lib/change-log.test.ts
git commit -m "feat(frontend): add buildScoringStartedEvent/buildScoringCompleteEvent"
```

---

### 10. Frontend `chapters-slice.ts` — `scoringProgress` state

**Files:**
- Modify: `src/store/chapters-slice.ts`
- Test: `src/store/chapters-slice.test.ts`

**Interfaces:**
- Produces: `ChaptersState.scoringProgress: Record<string, { charactersChecked: number; charactersOnRoster: number }>`. Actions: `chaptersActions.setScoringProgress({ bookId, charactersChecked, charactersOnRoster })`, `chaptersActions.clearScoringProgress(bookId)`.

- [ ] **Step 1: Write the failing tests**

Read `src/store/chapters-slice.test.ts`'s existing `setActiveStream`/`clearActiveStream`-style tests first, then append:

```typescript
describe('scoringProgress (srv-36 hardening)', () => {
  it('setScoringProgress records progress keyed by bookId', () => {
    let state = chaptersReducer(initialChaptersState, chaptersActions.setScoringProgress({ bookId: 'b1', charactersChecked: 2, charactersOnRoster: 5 }));
    expect(state.scoringProgress.b1).toEqual({ charactersChecked: 2, charactersOnRoster: 5 });
  });

  it('clearScoringProgress removes the entry for that book', () => {
    let state = chaptersReducer(initialChaptersState, chaptersActions.setScoringProgress({ bookId: 'b1', charactersChecked: 2, charactersOnRoster: 5 }));
    state = chaptersReducer(state, chaptersActions.clearScoringProgress('b1'));
    expect(state.scoringProgress.b1).toBeUndefined();
  });
});
```

(Match this test file's actual imported names for the reducer/initial-state/actions — check its existing imports before using `chaptersReducer`/`initialChaptersState` verbatim; use whatever it already imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/chapters-slice.test.ts`
Expected: FAIL — `setScoringProgress` is not a function.

- [ ] **Step 3: Implement**

In `src/store/chapters-slice.ts`:

1. Add `scoringProgress: Record<string, { charactersChecked: number; charactersOnRoster: number }>;` to the `ChaptersState` interface, near `activeStreams`.
2. Add `scoringProgress: {},` to the initial state object, near `activeStreams: {},`.
3. Add two reducers inside the `reducers: { ... }` block, near `setActiveStream`/`clearActiveStream`:

```typescript
    setScoringProgress: (
      s,
      a: PayloadAction<{ bookId: string; charactersChecked: number; charactersOnRoster: number }>,
    ) => {
      s.scoringProgress[a.payload.bookId] = {
        charactersChecked: a.payload.charactersChecked,
        charactersOnRoster: a.payload.charactersOnRoster,
      };
    },
    clearScoringProgress: (s, a: PayloadAction<string>) => {
      delete s.scoringProgress[a.payload];
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/chapters-slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/chapters-slice.ts src/store/chapters-slice.test.ts
git commit -m "feat(frontend): add scoringProgress state to chapters-slice"
```

---

### 11. Frontend `generation-stream-runner.ts` — handle the 3 new tick types

**Files:**
- Modify: `src/store/generation-stream-runner.ts`
- Test: `src/store/generation-stream-runner.test.ts`

**Interfaces:**
- Consumes: `chaptersActions.setScoringProgress`/`clearScoringProgress` (Task 10), `buildScoringStartedEvent`/`buildScoringCompleteEvent` (Task 9), `notificationsActions.pushToast` (existing).

- [ ] **Step 1: Write the failing tests**

Read `src/store/generation-stream-runner.test.ts`'s existing tests for the `'warning'` tick handling first (closest precedent), then append a test asserting: a `scoring_started` tick dispatches `chaptersActions.setScoringProgress` with `charactersChecked: 0` and pushes a toast and a change-log event; a `scoring_progress` tick updates the progress state without an additional toast; a `scoring_complete` tick dispatches `chaptersActions.clearScoringProgress` and a change-log completion event. Match this test file's exact harness (how it constructs a fake `dispatch`/`store` and feeds ticks into `handleTickFor` or equivalent — read the file to find the right entry point before writing assertions).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/generation-stream-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/store/generation-stream-runner.ts`, add imports: `buildScoringStartedEvent, buildScoringCompleteEvent` to the existing `from '../lib/change-log'` import, and `chaptersActions` is already imported. Add a new `else if` branch to `handleTickFor`'s chain (after the existing `chapter_awaiting_fallback_confirm` branch, following the exact same `dispatch(...)` style as the neighboring branches):

```typescript
    } else if (ev.type === 'scoring_started') {
      dispatch(chaptersActions.setScoringProgress({ bookId, charactersChecked: 0, charactersOnRoster: ev.charactersOnRoster ?? 0 }));
      dispatch(
        notificationsActions.pushToast({
          kind: 'info',
          message: `Checking character voices in the background — ${ev.charactersOnRoster ?? 0} to verify.`,
          dedupeKey: `voice-match-scoring:${bookId}`,
        }),
      );
      if (sliceMatchesHandle) {
        dispatch(changeLogActions.appendLogEvent(buildScoringStartedEvent({ charactersOnRoster: ev.charactersOnRoster ?? 0 })));
      }
    } else if (ev.type === 'scoring_progress') {
      dispatch(chaptersActions.setScoringProgress({ bookId, charactersChecked: ev.charactersChecked ?? 0, charactersOnRoster: ev.charactersOnRoster ?? 0 }));
    } else if (ev.type === 'scoring_complete') {
      dispatch(chaptersActions.clearScoringProgress(bookId));
      if (sliceMatchesHandle) {
        dispatch(changeLogActions.appendLogEvent(buildScoringCompleteEvent({ mismatchCount: ev.mismatchCount ?? 0 })));
      }
    }
```

(Round-2 plan-review correction: `Toast['kind']` in `src/store/notifications-slice.ts` already includes `'info'` — `'error' | 'warn' | 'info'` — so no type change is needed here; an earlier draft of this plan incorrectly assumed `'info'` didn't exist yet. Do not stage `notifications-slice.ts` in this task's commit unless you actually touched it for some other reason.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/generation-stream-runner.test.ts`
Expected: PASS. Also run `npx vitest run src/store/notifications-slice.test.ts` if the `Toast['kind']` type changed, to confirm nothing there broke.

- [ ] **Step 5: Commit**

```bash
git add src/store/generation-stream-runner.ts src/store/generation-stream-runner.test.ts
git commit -m "feat(frontend): handle scoring_started/progress/complete SSE ticks"
```

---

### 12. Frontend `generation.tsx` + `listen.tsx` — wire `bookId` and live progress into `QaReportCard`; extend `ACTIVITY_FEED_TYPES`

**Files:**
- Modify: `src/views/generation.tsx`
- Modify: `src/views/listen.tsx`

**Interfaces:**
- Produces: `QaReportCard` (Task 13) receives new props `bookId: string` and `scoringProgress?: { charactersChecked: number; charactersOnRoster: number }`.

- [ ] **Step 1: `generation.tsx`**

Find `ACTIVITY_FEED_TYPES` (around line 105) and add `'scoring_started', 'scoring_complete'` to its array.

Find the `<QaReportCard report={qaReport} loading={qaLoading} error={qaError} bookTitle={title ?? ''} />` line (line 1249) and change it to:

```tsx
<QaReportCard
  report={qaReport}
  loading={qaLoading}
  error={qaError}
  bookTitle={title ?? ''}
  bookId={bookId}
  scoringProgress={useAppSelector((s) => s.chapters.scoringProgress[bookId])}
/>
```

(Do not call `useAppSelector` inline inside JSX in the real edit if this file's existing conventions call selectors at the top of the component body instead — check the surrounding code for the established pattern and place the selector call there instead, then just reference the resulting variable in the JSX. `bookId` must already be in scope in this component — confirm by checking how `title`/`qaReport` are sourced just above this line.)

- [ ] **Step 2: `listen.tsx`**

Find the `<QaReportCard report={qaReport} loading={qaLoading} error={qaError} bookTitle={title} />` line (line 252) and add `bookId={bookId}` (no `scoringProgress` prop here — `listen.tsx` has no active generation SSE stream, so `QaReportCard`'s `scoringProgress` prop stays `undefined`, which is a valid/expected value per Task 13's design, not an error case).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: FAIL until Task 13 adds the new props to `QaReportCardProps` — that's expected; this step and Task 13 are interdependent. Do Task 13 immediately after this one, then re-run typecheck to confirm both together.

- [ ] **Step 4: Commit** (after Task 13 is also done and typecheck passes — see Task 13's own commit step; these two tasks land in ONE commit since neither typechecks alone)

---

### 13. Frontend `qa-report-card.tsx` — three-state `VoiceMatchRow` + Resume button

**Files:**
- Modify: `src/components/qa-report-card.tsx`
- Test: `src/components/qa-report-card.test.tsx`

**Interfaces:**
- Consumes: `api.resumeScoring` (Task 8), the `bookId`/`scoringProgress` props Task 12 now passes in.
- Produces: `QaReportCardProps` gains `bookId: string` (required) and `scoringProgress?: { charactersChecked: number; charactersOnRoster: number }` (optional).

**Round-2 plan-review note — do not expect Resume to ever populate `scoringProgress`.** Per Task 6/7's architecture note, `broadcastToBook` only has subscribers to send to while a generation job is actively rendering — the resume route only ever runs when NO job is active (`isGenerationActive` guards it), so a resume-triggered `scoreBook` run is structurally invisible to SSE. After a successful Resume click, the button must NOT simply revert to its clickable "Resume scoring" label once the `202` response resolves (the underlying work is still running in the background for potentially several minutes) — that would invite the user to click it again, which safely no-ops server-side but reads as broken. Instead: on success, swap the button for static disabled text ("Resuming — check back in a few minutes") that stays until the next time this component mounts fresh with an updated report (i.e. the user reopens/reloads the book and `useQaReport`'s fetch-on-mount picks up whatever `scoreBook` finished in the meantime). No polling loop, no new SSE subscription from this component — that's out of scope; the existing fetch-on-mount + the pre-existing manual reload is the resolution path here, same as it was before this feature existed.

- [ ] **Step 1: Write the failing tests**

Read `src/components/qa-report-card.test.tsx` in full first to match its existing render-and-assert style, then append:

```tsx
describe('VoiceMatchRow — srv-36 hardening states', () => {
  it('shows live progress copy when scoringProgress is present', () => {
    const report = { /* ...minimal BookQaReport fixture with voiceDrift.chaptersEligible > 0... */ };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" scoringProgress={{ charactersChecked: 3, charactersOnRoster: 13 }} />);
    expect(screen.getByText(/3 of 13 done/i)).toBeInTheDocument();
  });

  it('shows a Resume scoring button when charactersPending is non-empty and no live progress', () => {
    const report = { /* voiceDrift.charactersPending: ['ren'], chaptersScored < chaptersEligible */ };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    expect(screen.getByRole('button', { name: /resume scoring/i })).toBeInTheDocument();
  });

  it('does NOT show a Resume button when charactersPending is empty, even if some characters are permanently unchecked', () => {
    const report = { /* voiceDrift.charactersPending: [], uncheckedCharacterIds: ['pell-hollis'] */ };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    expect(screen.queryByRole('button', { name: /resume scoring/i })).not.toBeInTheDocument();
  });

  it('clicking Resume calls api.resumeScoring with the bookId', async () => {
    const resumeSpy = vi.spyOn(api, 'resumeScoring').mockResolvedValue();
    const report = { /* charactersPending: ['ren'] */ };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    await userEvent.click(screen.getByRole('button', { name: /resume scoring/i }));
    expect(resumeSpy).toHaveBeenCalledWith('b1');
  });
});
```

(Fill in each `/* ... */` `BookQaReport` fixture with a complete, valid object matching the real `BookQaReport` type — copy the shape from this test file's existing fixtures for the other `VoiceMatchRow` states and adjust only the fields named in each test's comment.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/qa-report-card.test.tsx`
Expected: FAIL — no `bookId` prop accepted yet, no Resume button rendered.

- [ ] **Step 3: Implement**

In `src/components/qa-report-card.tsx`:

1. Add imports: `import { useState } from 'react';` and `import { api } from '../lib/api';`.
2. Extend `QaReportCardProps`:

```typescript
interface QaReportCardProps {
  report: BookQaReport | null;
  loading: boolean;
  error: boolean;
  bookTitle: string;
  bookId: string;
  scoringProgress?: { charactersChecked: number; charactersOnRoster: number };
}
```

3. Replace the `VoiceMatchRow` function with a version that takes `bookId`/`scoringProgress` and adds the two new states BEFORE the existing not-eligible/scored logic:

```tsx
function VoiceMatchRow({
  report,
  bookId,
  scoringProgress,
}: {
  report: BookQaReport;
  bookId: string;
  scoringProgress?: { charactersChecked: number; charactersOnRoster: number };
}) {
  const vd = report.voiceDrift;
  const [resuming, setResuming] = useState(false);
  const [resumed, setResumed] = useState(false);

  if (vd.chaptersEligible === 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink/50">No stochastic-voiced characters in this book — nothing for this check to do.</span>
      </div>
    );
  }

  if (scoringProgress) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink">
          ⏳ Checking character voices — {scoringProgress.charactersChecked} of {scoringProgress.charactersOnRoster} done
        </span>
      </div>
    );
  }

  if (vd.charactersPending.length > 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">
            {vd.charactersChecked} of {vd.charactersOnRoster} characters checked so far
          </span>
          {resumed ? (
            <span className="text-xs text-ink/50">Resuming — check back in a few minutes</span>
          ) : (
            <button
              onClick={async () => {
                setResuming(true);
                try {
                  await api.resumeScoring(bookId);
                  // Deliberately stays disabled after success (does NOT revert to
                  // clickable) — a resume-triggered scoreBook run produces no live
                  // SSE progress (see Task 6/7's architecture note), so nothing
                  // will update this row again until the user next reloads the
                  // book and useQaReport re-fetches. Reverting to "Resume scoring"
                  // here would invite a confusing repeat click.
                  setResumed(true);
                } catch {
                  setResuming(false); // a real failure (not the 409 already-running case) — let them retry
                }
              }}
              disabled={resuming}
              className="text-xs font-semibold text-ink/70 hover:text-ink px-3 py-1 rounded-full border border-ink/10 disabled:opacity-50"
            >
              {resuming ? 'Resuming…' : 'Resume scoring'}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (vd.chaptersScored === 0 && vd.chaptersEmbedFailed === 0) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink/50">Not run for this book — flip on render-integrity checking to catch mismatches automatically.</span>
      </div>
    );
  }
  const inconclusiveNote = vd.inconclusiveCount > 0 ? ` · ${vd.inconclusiveCount} chapters inconclusive` : '';
  if (vd.chaptersScored < vd.chaptersEligible) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-ink/70">Voice match</span>
        <span className="text-sm text-ink">
          {vd.chaptersScored} of {vd.chaptersEligible} eligible chapters scored ({vd.chaptersEmbedFailed} couldn't be embedded), {vd.mismatches.length} mismatches{inconclusiveNote}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-ink/70">Voice match</span>
      <span className="text-sm text-ink">
        {vd.charactersChecked} of {vd.charactersOnRoster} characters checked, {vd.mismatches.length} mismatches{inconclusiveNote}
      </span>
    </div>
  );
}
```

4. Update the call site inside `QaReportCard`'s render body: change `<VoiceMatchRow report={report} />` to `<VoiceMatchRow report={report} bookId={bookId} scoringProgress={scoringProgress} />`, and destructure `bookId, scoringProgress` from `QaReportCard`'s own props alongside `report, loading, error, bookTitle`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/qa-report-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck the whole frontend** (closes out Task 12's deferred typecheck too)

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit** (Task 12 + Task 13 together, since they only typecheck as a pair)

```bash
git add src/views/generation.tsx src/views/listen.tsx src/components/qa-report-card.tsx src/components/qa-report-card.test.tsx
git commit -m "feat(frontend): three-state Voice Match row with live progress and Resume scoring button"
```

---

### 14. E2E — scoring progress + resume UX

**Files:**
- Create: `e2e/generation-scoring-progress.spec.ts`

**Interfaces:**
- Consumes: this repo's existing e2e mock-mode SSE-driving helpers — read `e2e/` for the nearest existing spec that drives a mocked generation stream (search for a spec asserting on `chapter_complete`/`warning` ticks) and copy its harness setup exactly; do not invent a new mocking mechanism.

**Scoping note (round-2 plan-review fix):** this spec drives the MOCKED frontend SSE stream directly with hand-fed tick events — it tests "does the UI react correctly when these ticks arrive," which is the mechanism this feature adds. It deliberately does NOT (and cannot, at this layer) assert that a real `scoreBook` run's ticks are guaranteed to arrive live end-to-end on a real server — per Task 6's architectural note, the live portion of a real run is best-effort (broadcasts only while a generation job is registered as active; the tail after the book finishes rendering, or the whole resume path, has no subscriber to reach). That server-side reality is out of scope for an e2e spec driven against the frontend's mock SSE layer; this spec's job is narrower and that's intentional, not an oversight.

- [ ] **Step 1: Write the spec**

```typescript
// e2e/generation-scoring-progress.spec.ts
import { test, expect } from '@playwright/test';
// Import whatever this repo's existing SSE-mocking helper module is called —
// check e.g. e2e/generation.spec.ts or similar for the exact import path and
// helper function names before writing this file; do not guess names.

test.describe('Voice-match scoring progress (srv-36 hardening)', () => {
  test('Quality Gate card and Activity feed update live as scoring_progress ticks arrive, then settle to the complete state', async ({ page }) => {
    // 1. Navigate to a book's Generate view (reuse this repo's existing
    //    navigation helper for that, matching e2e/generation.spec.ts's setup).
    // 2. Drive the mocked SSE stream with: scoring_started (charactersOnRoster: 3),
    //    scoring_progress x2, scoring_complete (mismatchCount: 0).
    // 3. Assert the Quality Gate card's Voice match row shows the live
    //    "X of Y done" copy while progress ticks are arriving.
    // 4. Assert an Activity feed entry appears for "Voice-match scoring started".
    // 5. After scoring_complete, assert the row settles to the final
    //    "N of M eligible chapters scored" copy (report refetched).
  });

  test('Resume scoring button appears when charactersPending is non-empty with no active stream, and clicking it calls the resume endpoint', async ({ page }) => {
    // 1. Mock GET /api/books/:bookId/qa-report to return a report with
    //    voiceDrift.charactersPending: ['ren'] and no active SSE stream.
    // 2. Assert the "Resume scoring" button is visible.
    // 3. Intercept POST /api/books/:bookId/resume-scoring, click the button,
    //    assert the request fired.
  });
});
```

Fill in each numbered step with real Playwright calls once the exact existing SSE-mocking helper (Step 1's import) is identified — this is deliberately left as a structural skeleton because the correct helper name can only be confirmed by reading the current `e2e/` directory at implementation time, not guessed here.

- [ ] **Step 2: Run the new spec**

Run: `npx playwright test e2e/generation-scoring-progress.spec.ts`
Expected: PASS once Step 1's placeholders are filled in with real assertions (this step is the actual TDD "red" checkpoint — the spec should fail meaningfully against the pre-Task-9-through-13 app if run early, and pass once all frontend tasks are in place; since e2e specs in this repo run against a real dev build, run this LAST, after every other task is committed).

- [ ] **Step 3: Commit**

```bash
git add e2e/generation-scoring-progress.spec.ts
git commit -m "test(e2e): cover live voice-match scoring progress and the Resume scoring button"
```

---

## Self-Review

**Revision history:** this plan went through two rounds of mandatory adversarial (Opus assumption-checker) review before implementation, plus a third self-reviewed pass (the loop cap for this gate is an initial pass + 2 re-reviews).

- **Round 1** found two Critical gaps — (a) the SSE events were fully specified end-to-end but no caller of `triggerScoring` ever supplied the `onScoringEvent` callback that would have emitted them, so the primary live-progress feature would have shipped silently dead; (b) `aggregate.ts`'s restructure referenced `CENTROID_MIN_N` without importing it and left `writeVerdicts` imported-but-unused, both hard build errors under this repo's `noUnusedLocals: true` — plus two Significant gaps (`generation-spk.test.ts` breaks on `scoreBook`'s new arity/return but wasn't named as a file needing updates; `scoring_started` never fired when every character hit a transient failure, exactly the stuck-book scenario Resume exists for). Fixed: Task 6 now wires SSE via the real `inFlightByBook`/`broadcast` primitives already in `generation.ts`; Task 3's imports are corrected; Task 3 Step 6 names both breaking test files explicitly; Task 3 gained an `onRosterKnown` callback independent of character resolution.
- **Round 2** verified all four Round-1 fixes hold (no new build-breakers) but found the live-SSE wiring, while now real, was still incompletely described — it goes silent not just on the resume path but also on the *tail* of a chapter-finalize-triggered run once the book's last generation job drains (a real generation job's registration, not just the resume route's absence of one, is what backs `broadcastToBook`'s subscriber list) — plus a hardcoded `mismatchCount: 0` that would have permanently logged a false "0 mismatches found" into the Activity feed regardless of the real result, a test-timing race in Task 6's own unit tests against the fire-and-forget background promise, and a Minor false premise about `ToastKind` needing a new union member (it already has `'info'`). Fixed (self-reviewed, no Round 3 dispatch — all three were precise, unambiguous engineering fixes, not judgment calls, consistent with the reviewer's own "not hard blockers" framing): `scoreAndMergeCharacter` now returns a real per-character mismatch count, accumulated and returned from `scoreBook` as `mismatchCount`, threaded through to `scoring_complete`'s broadcast; the architectural-limit note in Task 6 now covers both the resume path AND the post-render tail, and Task 14's e2e scoping note clarifies it tests the frontend reaction mechanism, not a server-side live-delivery guarantee; Task 6 gained a test-only `__awaitScoringSettled` export and every test asserting on the background run's effects now awaits it; the `ToastKind` premise is corrected.

**Spec coverage** — every numbered section of the spec maps to a task:
- §1 (interleave + cheap-first order) → Task 3.
- §2 (resume policy, retry cap, pending-attempts artifact) → Tasks 1 + 3.
- §3 (SSE events) → Tasks 5, 6, 11 (openapi schema, server emission via `broadcastToBook`, frontend handling).
- §4 (triggerScoring, keep derivation, justFinalizedSlugs, in-progress guard) → Tasks 6, 7.
- §5 (roster-aware scoredChapterIds, charactersPending, chaptersEmbedFailed reconciliation) → Tasks 2, 4.
- §6 (three-state frontend) → Tasks 8-13.
- Testing section → every task carries its own paired test per the spec's own testing plan; the E2E item → Task 14.

**Placeholder scan** — the `/* ... */` spots (Task 4's qa-report fixtures — the last one now fully specified field-by-field after round-1 review flagged it as ambiguous, Task 6/7's mocking-convention placeholders, Task 13's `BookQaReport` fixtures, Task 14's Playwright body) are intentional: they require reading each test file's/e2e directory's *current* conventions at implementation time rather than this plan guessing and getting them subtly wrong (e.g. inventing a `configValue` mock shape that doesn't match what `generation.test.ts` actually uses). Every one of them names EXACTLY what real content must replace it and why it can't be pre-filled — this is different from a bare "add appropriate tests" placeholder, which this plan does not use anywhere else.

**Type consistency** — `scoreBook`'s new return type (`{ usedQwenTiers: { keep06, keep17 } }`, Task 3) is consumed identically in Task 6's `triggerScoring`. `ReferenceOutcome`'s `status` values (`'resolved' | 'too-short' | 'transient-failure'`, Task 3) are used consistently within that same task — no other task touches this type. `mergeVerdictRows`'s signature (Task 2) matches its call site in Task 3's `scoreAndMergeCharacter`. `charactersPending` (Task 4, server; Task 5, openapi) flows into `vd.charactersPending` used in Task 13's frontend — same field name throughout. `scoringProgress`'s shape (`{ charactersChecked, charactersOnRoster }`) is identical across Task 10 (store), Task 11 (dispatch), Task 12 (prop threading), and Task 13 (consumption). `broadcastToBook`'s tick shapes (Task 6) match the `GenerationTick` fields Task 5 added to the openapi schema.
