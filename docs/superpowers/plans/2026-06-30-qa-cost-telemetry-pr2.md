# QA-cost RTF telemetry — PR-2 (observability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QA cost observable — split the re-record wall out of the per-chapter synth wall and surface it as a `rerecordRtf` column next to RTF in the admin tables, so the operator can SEE the cost that PR-1 removes.

**Architecture:** `synthesiseChapter` already runs QA in three timeable blocks (signal-QA re-record loop, ASR transcribe+re-record loop, SPK embed pass). Accumulate each block's wall, return it, and capture the pure-synth wall in the route immediately after `synthesiseChapter` returns (excluding the loudnorm encode that the current `synthMs` wrongly includes). Fold the QA sub-costs into `generation-stats` as per-chapter `rerecordRtf` (the figure PR-1 moves) + `verifyRtf` (the always-on floor), gated to `generationWorkers === 1` (multi-worker interleaving makes summed per-block wall physically meaningless). Surface in OpenAPI → the local `GenerationStatsResponse` type + mock → the two admin tables.

**Tech Stack:** TypeScript, Node, Vitest (server); React + Redux + Vitest/jsdom + Playwright (frontend); OpenAPI.

**Depends on:** **PR-1 ships first** (`docs/superpowers/plans/2026-06-30-qa-gate-false-positives-pr1.md`). This plan is pure observability; ship it after the gate fixes so the before/after `rerecordRtf` drop is visible on the same admin surface.

## Global Constraints

- **Branch:** cut `feat/server-qa-cost-telemetry` off `main` AFTER PR-1 merges (do not stack on the PR-1 branch).
- **Commit convention:** `<type>(<scope>): <subject>`. Scopes used here: `server` (B1), `openapi` (schema), `frontend` (B3 UI + local type/mock), `e2e` (spec). Never `tts`.
- **Spec source of truth:** `docs/superpowers/specs/2026-06-30-qa-gate-false-positives-and-rtf-telemetry-design.md` (§ PR-2).
- **OpenAPI is the type source of truth** for generated shapes — but the admin surface reads a **hand-written local** `GenerationStatsResponse`/`RecentChapter` in `src/lib/api.ts` (plus a hand-built mock), NOT `api-types.ts`. Both must be updated or the column renders blank.
- **Behaviour change (call out in the PR body):** B1 narrows the per-chapter `synthMs` to exclude the loudnorm encode + disk write it currently includes (H1). Existing RTF numbers shift slightly DOWN. This is intentional — `synthMs` is documented as "all TTS … excludes encode/disk" but the route captures it post-`finalizeChapterAudioWrite`.
- **Concurrency gate:** the QA split fields are emitted only when `generationWorkers === 1`; `null` (rendered "n/a") otherwise. State this in the `generation-stats` module doc.
- **TDD, every task.** No `--no-verify`.

## Deferred (NOT in this plan)

- **B2 — sidecar `reload_ms`.** The spec's downgrade stands: `gen_ms` does **not** fold a routine reload (the primary `_ensure_*_loaded()` runs before `gen_start`), so B2 is observability-only and not load-bearing for the RTF story. **Deferred** — file a follow-up backlog item if `side-11` recycle correlation is wanted later. Do not implement here.

---

## File Structure

- `server/src/tts/synthesise-chapter.ts` — accumulate `rerecordMs`/`transcribeMs`/`embedMs`, add to `ChapterSynthesisResult`.
- `server/src/tts/synthesise-chapter.test.ts` — the no-double-count / zero-when-no-rerecord invariant.
- `server/src/tts/generation-stats.ts` — `rerecordRtf`/`verifyRtf` on `ChapterThroughputRecord`; new optional inputs on `recordChapterThroughput`.
- `server/src/tts/generation-stats.test.ts` — field math + null-when-absent.
- `server/src/routes/generation.ts` — capture pure-synth wall post-`synthesiseChapter`; pass QA sub-fields gated on `generationWorkers === 1`.
- `server/src/routes/generation-stats.test.ts` — endpoint carries the new fields.
- `openapi.yaml` + `src/lib/api-types.ts` (regenerated) — schema.
- `src/lib/api.ts` — local `RecentChapter` type + the `getGenerationStats` mock at `:7575`.
- `src/views/admin.tsx` — the two tables (`GenerationThroughput` `:387`, `ResourceTrends` `:476`).
- `src/views/admin.test.tsx` — column renders.
- `e2e/` — one admin spec asserting the QA column.

---

## Task 1: B1 — accumulate QA block wall in `synthesiseChapter` and return it

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts` (`ChapterSynthesisResult` interface; three accumulators; wrap four `await`s; extend the return)
- Test: `server/src/tts/synthesise-chapter.test.ts`

**Interfaces:**
- Consumes: existing `synthesiseChapter(...)`, `synthGroupsBatched`, `verify`, `collectGroupEmbeddings`.
- Produces: `ChapterSynthesisResult` gains `rerecordMs: number`, `transcribeMs: number`, `embedMs: number`. `rerecordMs` = total wall in QA-driven re-record synth (signal-QA loop + ASR re-record loop). `transcribeMs` = total wall in ASR transcribe calls (initial verify pass + re-verify). `embedMs` = total wall in the SPK embed pass. Each `await` is wrapped exactly once → no double-count by construction.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/synthesise-chapter.test.ts` (use the file's existing harness for building a `synthesiseChapter` call; mirror an existing test's setup for `groups`, `synthFn`, sample rate). The deterministic invariant: with **no** re-records configured, `rerecordMs` is exactly `0`, and the three fields are present and numeric.

```typescript
it('B1: returns QA-cost fields; rerecordMs is 0 when no re-records run', async () => {
  // Build a chapter that synthesises clean on the first take with the QA
  // re-record budget at 0 (maxSegmentRerecords = 0, asr absent) — no re-record
  // synth happens, so rerecordMs must be exactly 0. (Reuse this file's existing
  // builder for the groups + injected synthFn; see the "happy path" test above.)
  const result = await synthesiseChapter({
    /* …existing happy-path args from the sibling test… */
  });
  expect(typeof result.rerecordMs).toBe('number');
  expect(typeof result.transcribeMs).toBe('number');
  expect(typeof result.embedMs).toBe('number');
  expect(result.rerecordMs).toBe(0); // no re-record synth occurred
  expect(result.transcribeMs).toBe(0); // asr not configured → no transcribe
  expect(result.embedMs).toBe(0); // qa.speaker.enabled off → no embed
});
```

> Note: precise millisecond values are wall-clock dependent and NOT asserted. The
> guarantee this task makes is structural (each `await` wrapped once) + the
> deterministic zero-when-absent case above.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts -t B1`
Expected: FAIL — `result.rerecordMs` is `undefined`, `typeof` is `'undefined'`.

- [ ] **Step 3: Add the three accumulators**

In `synthesiseChapter`, declare alongside the other mutable accumulators, BEFORE the signal-QA block (just above `const segmentQaByIndex = new Map…` at ~line 1491):

```typescript
  /* B1 — QA-cost wall split out for the rerecordRtf telemetry. Each accumulator
     wraps exactly one class of await so the chapter wall can be attributed:
     rerecordMs = QA-driven re-record synth (the part PR-1 moves); transcribeMs +
     embedMs = the always-on verify floor. */
  let rerecordMs = 0;
  let transcribeMs = 0;
  let embedMs = 0;
```

- [ ] **Step 4: Wrap the signal-QA re-record synth**

At the signal-QA loop (line ~1524), wrap the re-synth await:

```typescript
      const reT0 = Date.now();
      const fresh = await synthGroupsBatched(pending);
      rerecordMs += Date.now() - reT0;
```

- [ ] **Step 5: Wrap the ASR transcribe + re-record awaits**

Initial verify pass (line ~1598):

```typescript
      const tT0 = Date.now();
      segmentAsrByIndex.set(group.index, await verify(r.pcm, r.sampleRate, group));
      transcribeMs += Date.now() - tT0;
```

ASR re-record synth (line ~1618):

```typescript
      const asrReT0 = Date.now();
      const fresh = await synthGroupsBatched(pending);
      rerecordMs += Date.now() - asrReT0;
```

ASR re-verify (line ~1622):

```typescript
        const revT0 = Date.now();
        const freshClass = await verify(f.pcm, f.sampleRate, group);
        transcribeMs += Date.now() - revT0;
```

- [ ] **Step 6: Wrap the SPK embed pass**

At the embed pass (line ~1646):

```typescript
      const embT0 = Date.now();
      spkEmbeddings = await collectGroupEmbeddings(
        groups,
        results,
        (index) => resolveGroup(groupByIndex.get(index)!).configuredEngine,
        embedSegment,
        onEmbedProgress,
      );
      embedMs += Date.now() - embT0;
```

- [ ] **Step 7: Add the fields to the interface and the return**

In `ChapterSynthesisResult` (line ~379), after `embeddings?`:

```typescript
  embeddings?: EmbeddingRow[];
  /** B1 QA-cost split (ms). `rerecordMs` is QA-driven re-record synth wall (the
      part the gate fixes move); `transcribeMs`/`embedMs` are the always-on verify
      floor. Zero when the corresponding gate did not run. */
  rerecordMs: number;
  transcribeMs: number;
  embedMs: number;
```

In the return object (line ~1725):

```typescript
  return {
    pcm,
    sampleRate,
    durationSec: pcmDurationSec(pcm.length, sampleRate),
    segments,
    embeddings: spkEmbeddings,
    rerecordMs,
    transcribeMs,
    embedMs,
  };
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts`
Expected: PASS — the new B1 case plus every pre-existing `synthesiseChapter` test.

- [ ] **Step 9: Commit**

```bash
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter.test.ts
git commit -m "feat(server): split QA re-record/transcribe/embed wall out of synthesiseChapter"
```

---

## Task 2: B1 — `rerecordRtf`/`verifyRtf` in `generation-stats`

**Files:**
- Modify: `server/src/tts/generation-stats.ts` (`ChapterThroughputRecord`; `recordChapterThroughput` input + history push)
- Test: `server/src/tts/generation-stats.test.ts`

**Interfaces:**
- Consumes: existing `recordChapterThroughput(input, now?)`, `ChapterThroughputRecord`, `getGenerationStats`.
- Produces: `ChapterThroughputRecord` gains `rerecordRtf: number | null` and `verifyRtf: number | null`. `recordChapterThroughput`'s input gains optional `rerecordMs?: number | null`, `transcribeMs?: number | null`, `embedMs?: number | null`. When `rerecordMs` is a number and `audioSec > 0`, `rerecordRtf = rerecordMs / 1000 / audioSec`; when `transcribeMs`/`embedMs` are numbers, `verifyRtf = (transcribeMs + embedMs) / 1000 / audioSec`. When the inputs are `null`/absent (multi-worker, or no audio), both are `null`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/generation-stats.test.ts`:

```typescript
it('B1: records rerecordRtf and verifyRtf from QA sub-costs', () => {
  __resetGenerationStatsForTest();
  const s = recordChapterThroughput({
    chapterId: 1,
    audioSec: 100,
    synthMs: 120_000,
    rerecordMs: 30_000, // 30s re-record over 100s audio → 0.30
    transcribeMs: 8_000,
    embedMs: 2_000, // (8+2)/100 → 0.10
  });
  expect(s.recentChapters[0].rerecordRtf).toBeCloseTo(0.3, 3);
  expect(s.recentChapters[0].verifyRtf).toBeCloseTo(0.1, 3);
});

it('B1: QA fields are null when sub-costs are absent (multi-worker / no split)', () => {
  __resetGenerationStatsForTest();
  const s = recordChapterThroughput({ chapterId: 2, audioSec: 100, synthMs: 120_000 });
  expect(s.recentChapters[0].rerecordRtf).toBeNull();
  expect(s.recentChapters[0].verifyRtf).toBeNull();
});
```

(`__resetGenerationStatsForTest` is already exported.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/tts/generation-stats.test.ts -t B1`
Expected: FAIL — `rerecordRtf` is `undefined`.

- [ ] **Step 3: Extend `ChapterThroughputRecord`**

In `server/src/tts/generation-stats.ts`, add to the interface (after `rtf`):

```typescript
  rtf: number | null;
  /** B1 — QA-driven re-record wall ÷ audio (the cost the gate fixes move).
      null when not split (generationWorkers > 1) or no audio. */
  rerecordRtf: number | null;
  /** B1 — always-on verify floor (transcribe + embed) ÷ audio. null as above. */
  verifyRtf: number | null;
```

- [ ] **Step 4: Extend `recordChapterThroughput` input + history push**

Add to the input type:

```typescript
    modelKey?: string | null;
    rerecordMs?: number | null;
    transcribeMs?: number | null;
    embedMs?: number | null;
```

Add a helper above the `history.unshift(...)` call and use it in the push:

```typescript
  const hasAudio = input.audioSec > 0;
  const rerecordRtf =
    hasAudio && input.rerecordMs != null ? input.rerecordMs / 1000 / input.audioSec : null;
  const verifyMs =
    input.transcribeMs != null || input.embedMs != null
      ? (input.transcribeMs ?? 0) + (input.embedMs ?? 0)
      : null;
  const verifyRtf = hasAudio && verifyMs != null ? verifyMs / 1000 / input.audioSec : null;

  history.unshift({
    chapterId: input.chapterId,
    title: input.title ?? null,
    bookId: input.bookId ?? null,
    modelKey: input.modelKey ?? null,
    rtf: input.audioSec > 0 ? synthSec / input.audioSec : null,
    rerecordRtf,
    verifyRtf,
    audioSec: input.audioSec,
    synthSec,
    at: new Date(now).toISOString(),
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run src/tts/generation-stats.test.ts`
Expected: PASS (new B1 cases + all existing).

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/generation-stats.ts server/src/tts/generation-stats.test.ts
git commit -m "feat(server): add rerecordRtf/verifyRtf to per-chapter throughput records"
```

---

## Task 3: B1 — wire the route (narrow synthMs, gate to one worker)

**Files:**
- Modify: `server/src/routes/generation.ts` (capture pure-synth wall after `synthesiseChapter`; pass QA fields gated on `generationWorkers === 1`)
- Test: `server/src/routes/generation-stats.test.ts`

**Interfaces:**
- Consumes: `synthesiseChapter` (now returns `rerecordMs`/`transcribeMs`/`embedMs`), `recordChapterThroughput` (now accepts them), the `generationWorkers` config value.
- Produces: `recordChapterThroughput` is called with `synthMs` = wall from `synthStartMs` to **immediately after `synthesiseChapter` returns** (pre-encode), and with the QA sub-fields when `generationWorkers === 1`, else `null`.

- [ ] **Step 1: Write the failing test**

In `server/src/routes/generation-stats.test.ts`, add a case asserting that, after a single-worker render, the stats endpoint's newest `recentChapters` entry carries a non-null `rerecordRtf`. (Mirror the existing test that drives a render and reads `GET /api/generation/stats`; if that harness doesn't exist here, assert at the `recordChapterThroughput` seam instead — the route test that already exercises a finished chapter.)

```typescript
it('B1: single-worker render reports rerecordRtf on the stats endpoint', async () => {
  // …drive one chapter through the route harness with generationWorkers=1…
  const res = await request(app).get('/api/generation/stats');
  expect(res.body.recentChapters[0]).toHaveProperty('rerecordRtf');
  expect(res.body.recentChapters[0].rerecordRtf).not.toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/generation-stats.test.ts -t B1`
Expected: FAIL — `rerecordRtf` absent/null (route not passing it yet).

- [ ] **Step 3: Capture the pure-synth wall right after `synthesiseChapter`**

In `server/src/routes/generation.ts`, immediately after the `const result = await synthesiseChapter({…})` call (ends ~line 1465, before `finalizeChapterAudioWrite`), add:

```typescript
      // B1/H1 — synth-only wall, captured BEFORE the loudnorm encode + disk write
      // so the RTF rollup measures TTS, not encode. (The old post-finalize
      // capture wrongly folded encode into synthMs.)
      const synthOnlyMs = Date.now() - synthStartMs;
```

- [ ] **Step 4: Pass the narrowed wall + gated QA fields**

Replace the `recordChapterThroughput({…})` call (line ~1544) with:

```typescript
      const oneWorker = configValue<number>('generationWorkers') === 1;
      const roll = recordChapterThroughput({
        chapterId: chapter.id,
        audioSec,
        synthMs: synthOnlyMs,
        title: chapter.title ?? null,
        bookId: job.bookId,
        modelKey,
        rerecordMs: oneWorker ? result.rerecordMs : null,
        transcribeMs: oneWorker ? result.transcribeMs : null,
        embedMs: oneWorker ? result.embedMs : null,
      });
```

(Confirm the `generationWorkers` registry key name with `grep -n "generationWorkers" server/src/config/registry.ts`; use `configValue` exactly as the resolver expects. If it's already imported in this file, reuse the import.)

Leave the existing `synthSec`/`chapterRtf` log line as-is OR repoint it at `synthOnlyMs` for consistency — note the choice in the commit body. (Recommended: repoint, so the log RTF matches the recorded RTF.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/generation-stats.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the concurrency assumption in the module doc**

In `server/src/tts/generation-stats.ts`, add to the top-of-file doc block a line: "QA-cost fields (`rerecordRtf`/`verifyRtf`) are populated only for single-worker runs (`generationWorkers === 1`); under multi-worker interleaving the summed per-block wall over-counts, so the route passes them as `null` (rendered n/a)."

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/generation.ts server/src/routes/generation-stats.test.ts server/src/tts/generation-stats.ts
git commit -m "feat(server): record QA-cost split for single-worker renders; narrow synthMs to pre-encode"
```

---

## Task 4: B3 — schema + local type + mock

**Files:**
- Modify: `openapi.yaml` (the generation-stats `RecentChapter`/throughput schema), then regenerate `src/lib/api-types.ts`
- Modify: `src/lib/api.ts` (`RecentChapter` interface `:7662`; mock `getGenerationStats` `:7575`)
- Test: covered by Task 5's admin test + the mock shape itself

**Interfaces:**
- Consumes: existing `RecentChapter`/`GenerationStatsResponse` local types + the mock.
- Produces: `RecentChapter` gains `rerecordRtf: number | null` and `verifyRtf: number | null`; the mock emits a deterministic descending `rerecordRtf` (e.g. high on the oldest chapters, ~0 on the newest — the PR-1 "cost drops after the fix" story).

- [ ] **Step 1: Update OpenAPI**

In `openapi.yaml`, find the schema backing the generation-stats recent-chapter shape (search `recentChapters` / the `RecentChapter` schema). Add two nullable number properties:

```yaml
        rerecordRtf:
          type: number
          nullable: true
          description: QA-driven re-record wall ÷ audio for this chapter; null for multi-worker runs.
        verifyRtf:
          type: number
          nullable: true
          description: Always-on verify floor (transcribe + embed) ÷ audio; null for multi-worker runs.
```

- [ ] **Step 2: Regenerate generated types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` updates with the two new optional/nullable fields; no diff elsewhere.

- [ ] **Step 3: Update the local `RecentChapter` type**

In `src/lib/api.ts` (`:7662`), add to the interface:

```typescript
  rtf: number | null;
  /** B1 — QA re-record wall ÷ audio (the cost the gate fixes move). null for
      multi-worker runs. */
  rerecordRtf: number | null;
  /** B1 — always-on verify floor (transcribe + embed) ÷ audio. null as above. */
  verifyRtf: number | null;
```

- [ ] **Step 4: Update the mock**

In the `getGenerationStats` mock (`:7575`), add `rerecordRtf`/`verifyRtf` to each mapped record so the column is exercisable under `VITE_USE_MOCKS`. Make `rerecordRtf` descend toward 0 on the newest chapters (tells the "fixed" story); keep `verifyRtf` roughly flat (the floor):

```typescript
    const recentChapters = [2.41, 2.12, 1.78, 1.5, 1.31, 1.12, 0.94].map((rtf, i) => ({
      chapterId: 7 - i,
      title: `Chapter ${7 - i}`,
      bookId: 'mock-book',
      modelKey: 'qwen3-tts',
      rtf,
      // Newest-first: index 0 is newest → lowest QA cost (post-fix).
      rerecordRtf: [0.02, 0.05, 0.4, 0.7, 0.9, 1.1, 1.3][i] ?? null,
      verifyRtf: 0.1,
      audioSec: 600,
      synthSec: Math.round(600 * rtf),
      at: new Date(Date.parse('2026-06-01T09:00:00Z') + (6 - i) * 9 * 60_000).toISOString(),
    }));
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean — the local type, the mock, and `admin.tsx`'s consumption all agree.

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts src/lib/api.ts
git commit -m "feat(openapi): add rerecordRtf/verifyRtf to generation-stats recent-chapter shape"
```

---

## Task 5: B3 — admin tables QA column

**Files:**
- Modify: `src/views/admin.tsx` (`THROUGHPUT_COLS` `:82`, `GenerationThroughput` header `:431` + `ThroughputRow` `:645`; `TRENDS_COLS` `:84` + `ResourceTrends` `:536`)
- Test: `src/views/admin.test.tsx`

**Interfaces:**
- Consumes: `RecentChapter.rerecordRtf` (now present), `fmtRtf` (`:49`), the responsive `hidden md:block` pattern.
- Produces: a new right-aligned **"QA"** column showing `fmtRtf(chapter.rerecordRtf)` in both tables. Per the 3-viewport mobile protocol, hide it below `md` (phone shows Chapter + RTF only) — same breakpoint as the existing Audio/Synth columns. `null` renders as "–" (via `fmtRtf`).

- [ ] **Step 1: Write the failing test**

In `src/views/admin.test.tsx`, add (mirror the existing throughput-table test that renders with the mock):

```typescript
it('B3: renders the QA (rerecordRtf) column in the throughput table', async () => {
  // …render AdminView with the mock stats (rerecordRtf present)…
  expect(await screen.findByText('QA')).toBeInTheDocument();
  // newest chapter mock rerecordRtf 0.02 → formatted "0.02"
  expect(screen.getByTestId('throughput-row-7')).toHaveTextContent('0.02');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/views/admin.test.tsx -t B3`
Expected: FAIL — no "QA" header.

- [ ] **Step 3: Widen the grid templates**

`THROUGHPUT_COLS` (`:82`) — add one `auto` track at `md` (before the final RTF `auto`):

```typescript
const THROUGHPUT_COLS =
  'grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_7rem_auto] md:grid-cols-[1fr_7rem_3.5rem_3.5rem_3.5rem_auto] gap-x-3 sm:gap-x-6';
```

`TRENDS_COLS` (`:84`) — add one `auto`/`3.5rem` track at `sm`:

```typescript
const TRENDS_COLS =
  'grid grid-cols-[1fr_3rem_3rem_auto] sm:grid-cols-[1fr_7rem_3rem_3.5rem_3.5rem_auto] gap-x-3 sm:gap-x-6';
```

- [ ] **Step 4: Add the header + cell in `GenerationThroughput`**

Header (after the Synth `<span>`, before RTF, line ~434):

```typescript
              <span className="text-right hidden md:block">Synth</span>
              <span className="text-right hidden md:block">QA</span>
              <span className="text-right">RTF</span>
```

In `ThroughputRow` (after the Synth cell, line ~665):

```typescript
      <span className="text-right text-xs text-ink/50 font-mono tabular-nums hidden md:block">
        {fmtRtf(chapter.rerecordRtf)}
      </span>
```

- [ ] **Step 5: Add the header + cell in `ResourceTrends`**

`ResourceTrends` reads `ResourceTelemetryRecord`, which does NOT carry `rerecordRtf`. Two options — pick the lighter:
- **(a) Skip the QA column in `ResourceTrends`** (the spec's "column only, no summary" is satisfied by the throughput table; ResourceTrends is VRAM/wall-focused). Recommended — avoids threading `rerecordRtf` through the telemetry record + its server emit.
- (b) If the operator wants QA next to VRAM too, add `rerecordRtf` to `ResourceTelemetryRecord` and its server-side emit, then render here.

Default to **(a)**: revert the `TRENDS_COLS` change from Step 3 and do not touch `ResourceTrends`. Note the choice in the commit body. (Step 3's `TRENDS_COLS` edit applies only if you choose (b).)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/views/admin.test.tsx`
Expected: PASS (new B3 case + existing admin tests).

- [ ] **Step 7: Commit**

```bash
git add src/views/admin.tsx src/views/admin.test.tsx
git commit -m "feat(frontend): show per-chapter QA re-record RTF column in the throughput table"
```

---

## Task 6: e2e spec + full verify

**Files:**
- Create/Modify: an admin e2e spec under `e2e/` (router/redux/layout seam — the spec mandates one e2e per UI surface crossing those seams)

- [ ] **Step 1: Add the e2e assertion**

In the existing admin e2e spec (or a new `e2e/admin-throughput.spec.ts`), navigate to the admin view in mock mode and assert the QA column header + a row value are visible:

```typescript
test('admin throughput table shows the QA re-record RTF column', async ({ page }) => {
  await page.goto('/#/admin'); // confirm the admin hash route in src/lib/router.ts
  await expect(page.getByText('QA')).toBeVisible();
  await expect(page.getByTestId('throughput-row-7')).toContainText('0.02');
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `npm run test:e2e -- admin`
Expected: PASS.

- [ ] **Step 3: Full verify**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/server-qa-cost-telemetry
```

PR title `feat(server): QA-cost RTF telemetry in the admin throughput table`. Body = mini-release-notes: B1 split + the synthMs narrowing behaviour change (call it out explicitly), the single-worker gate, B3 column, B2 deferred. Link the design spec.

---

## Self-Review (completed by plan author)

**1. Spec coverage (§ PR-2):**
- B1 split `rerecordMs`/`transcribeMs`/`embedMs` out of chapter wall → Tasks 1–3 ✓
- B1 `rerecordRtf` (headline) + always-on `verifyRtf` floor → Task 2 ✓
- C3 concurrency gate (`generationWorkers === 1`, else null) → Task 3 ✓; module doc → Task 3 Step 6 ✓
- H1 synthMs scope (capture pre-encode) → Task 3 Step 3 ✓ (flagged as a behaviour change)
- B2 sidecar `reload_ms` → **deferred** per the spec's own downgrade; documented under "Deferred" ✓
- B3 local `GenerationStatsResponse`/`RecentChapter` + mock (H3) → Task 4 ✓; admin tables (correct lines `:387`/`:476`) → Task 5 ✓
- M5 responsive behaviour (hide below `md`) → Task 5 Step 4 ✓
- Missing-five affected files (H2): `generation.ts`, `generation-stats.ts` + both tests, `main.py` (B2 deferred), `openapi.yaml`/`api-types.ts`, `api.ts` + mock, `admin.tsx`/`admin-pill.tsx`, e2e → covered (admin-pill only needs touching if it reads `rerecordRtf`; it consumes the summary, not per-chapter, so no change — noted) ✓

**2. Placeholder scan:** the test-harness `/* …existing args… */` markers in Tasks 1 & 3 point at concrete sibling tests to copy rather than invented code — acceptable because the exact builder args are file-local and must match the existing harness; every NEW line (accumulators, fields, wiring, UI) is shown in full. No "handle edge cases"/"TBD".

**3. Type consistency:** `rerecordMs`/`transcribeMs`/`embedMs` (number) flow Task 1 → Task 3; `rerecordRtf`/`verifyRtf` (number | null) flow Task 2 → Task 4 → Task 5 with identical names and nullability throughout.

**Open decision left to the executor (flagged, not hidden):** Task 5 Step 5 — whether `ResourceTrends` also gets the QA column (option b, needs a `ResourceTelemetryRecord` field + server emit) or not (option a, recommended). Default (a) keeps PR-2 scoped to the throughput table; (b) is a clean follow-up if the operator wants QA beside VRAM.
