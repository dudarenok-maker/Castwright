# Analyzer eval-rate telemetry — design

**Date:** 2026-07-17
**Status:** approved 2026-07-17 (survived two adversarial passes); implementing on `feat/analyzer-eval-rate-telemetry`
**Area:** server (analyzer + route) + frontend (admin)
**Related:** fs-45 model-VRAM telemetry (`model-vram-stats.ts`), fs-20 resource
telemetry (`resource-telemetry.ts` + `ResourceTrends` in `admin.tsx`),
generation RTF stats (`generation-stats.ts`).

## Problem

When a long book renders through the local Ollama analyzer, the operator has no
self-service way to see how fast the model is actually decoding, or whether that
speed **drifts** across a run. Ollama returns exact per-call timing
(`eval_count` / `eval_duration`, `prompt_eval_count` / `prompt_eval_duration`,
`load_duration`) on the final `done:true` streaming line — the analyzer already
parses that line but reads only `done_reason` and throws the timing away
(`ollama.ts` `chat()`, ~L731-734). The live UI only surfaces a frontend-computed
**chars/s**, which is not tokens/s and is not persisted.

The symptom this is meant to catch: a slow decode-rate decline across a long run
(thermal throttle, a KV-cache growing past a comfortable size, an eviction/reload
stealing time) that is invisible pass-to-pass and only obvious as a trend.

## Goals

- Capture real Ollama decode timing per analysis pass and derive **eval tok/s**
  (the headline drift canary), **prompt-ingest tok/s**, and **load ms**.
- Persist it as append-only history that **survives a server restart**, so the
  operator can see the trend across a whole run — mirroring fs-20/fs-45.
- Surface it in the admin console as a sibling to the existing RTF /
  Resource-Trends panels: a per-run table + tok/s sparkline, **grouped by book
  run → model**, newest-first.
- Bounded, scrollable display: it **accumulates indefinitely but never takes
  over the screen** (fixed max-height scroll region, book-run boundary sections).

## Non-goals (v1, YAGNI)

- **No live top-bar pill.** The admin history panel is the deliverable.
- **No adaptive behaviour.** Pure observability, like fs-45 v1 — nothing *reads*
  this store to change a decision (keep-alive, model choice, batch caps).
- **No Gemini eval-rate.** The Gemini path does not expose per-token decode
  timing the same way; analyzer-**local** (Ollama) only. A pass (or sub-call)
  that runs on Gemini simply contributes no timing (see FallbackAnalyzer below).
- **No re-analysis / re-render.** Telemetry only; changes no analysis output.

## The unit of history — one record per (manuscript, chapter, pass)

**This is the crux, and the correction from the first design.** A single
analysis pass is **not** a single model call. Stage-2 (and stage-1-chapter) run
through a **chunk runner** that fires the model call *many* times for one
chapter-pass: `runStage2ChapterChunked` calls `callForBody` once per chunk
(`stage2-chunk.ts:345-358`), each chunk is wrapped in a coverage-guard that
**retries** the call (`runStage2WithCoverageGuard`, up to `coverageRetries`), and
`attributeSpan` **recursively re-splits** on truncation (L324-334). On top of
that, `runStage` itself does a 1–2 attempt **validation retry** per call
(`ollama.ts:456-522`). So a dense chapter's stage-2 pass = *many* `chat()` calls.

Therefore the record is emitted at the **pass-orchestration boundary** (one per
`attributeChapterStage2` / `runStage1ChapterChunked` / `runEmotionChapter` / …),
folding **every** `chat()` sub-call underneath it — chunks, coverage retries,
adaptive splits, and validation retries alike.

New file `server/src/analyzer/analyzer-eval-stats.ts`, modelled on
`resource-telemetry.ts`.

```ts
export interface AnalyzerEvalRecord {
  at: string;             // ISO timestamp (pass completion)
  manuscriptId: string;   // STABLE grouping key — always present at analysis time
  bookTitle: string | null; // denormalized display label (recordRef.title); may
                            // be null on an early pass before metadata is known
  model: string;          // canonicalised Ollama tag (":latest" normalised, per
                          //   canonicalVramKey's rule) — the model that ran
  stage: string;          // analysis PASS: stage1-ch | stage2-ch | emotion |
                          //   nonstory | review | stage3
  chapterId: number | 'book';
  evalTokS: number | null;   // ΣevalCount ÷ (ΣevalDuration/1e9) — token-weighted,
                            //   NOT a mean of per-chunk rates; null if ΣevalDuration=0
  promptTokS: number | null; // Σprompt_eval_count ÷ (Σprompt_eval_duration/1e9)
  evalCount: number;         // ΣevalCount — total output tokens for the pass
  loadMs: number;            // MAX load_duration/1e6 over sub-calls (surfaces any
                            //   mid-pass eviction/reload; ~0 when fully resident)
  subCalls: number;          // total chat() calls folded (chunks × retries × splits)
  chunkCount: number | null; // Stage2ChunkRunResult.chunkCount (1 = single-call
                            //   path); distinguishes "model slowed" from "chapter
                            //   was split" — a split inflates subCalls legitimately.
                            //   null when the pass exposes no count (stage-1-chapter
                            //   unions rosters; a failed pass has no result).
  outcome: 'ok' | 'failed';  // 'failed' = the pass threw after these sub-calls
                            //   (recorded best-effort so a pass that died SLOW is
                            //   still visible — the canary wants exactly that)
}
```

`evalTokS`/`promptTokS` are `null` (not 0) when the summed duration is 0 — a dash
in the UI, excluded from the sparkline and the trend comparison so a
divide-by-zero can't corrupt the trend.

## Capture seam — accumulate on the StageCall, emit at the boundary

Confirmed: `attributeChapterStage2` reuses **one** `opts.stageCall` object across
every chunk and retry (`callForBody` → `runStage2Chapter(…, opts.stageCall)`,
`analysis.ts:1746-1751`). So a timing sink on the `StageCall` transparently
collects every sub-call of a chapter-pass, with no change to the chunk runner
(which stays pure) and no new field threaded through it.

1. **`ollama.ts` `chat()`** — capture the timing fields off the `done:true` line
   (today only `done_reason` is read) and fire a new optional
   `onEvalTiming?(raw)` callback once per call with the RAW counts plus
   `this.model`. `chat()` already receives `onChunk`/`signal` as explicit params;
   `onEvalTiming` joins them the same way. Gated by a dedicated best-effort
   registry knob `analyzer.evalStats.enabled` (env `CASTWRIGHT_EVAL_SAMPLE`,
   default on) so fetch-count tests opt out independently of the fs-45 sampler.

2. **`StageCall`** (`index.ts:45`) — add `onEvalTiming?: (t: RawEvalTiming) =>
   void` alongside the existing `onWaiting`/`onChunk`. `runStage` forwards
   `call.onEvalTiming` into each `chat()` it makes (both the first attempt and
   the validation retry), so validation retries fold in too.

3. **The pass boundary (route)** — for each pass invocation the route builds a
   fresh **accumulator** (`const acc: RawEvalTiming[] = []`), sets
   `stageCall.onEvalTiming = (t) => acc.push(t)`, `await`s the pass

   > **Concurrency invariant (Critical — analysis is pipelined).** The
   > accumulator MUST be a local of the per-pass scope, co-located with where the
   > `StageCall` is built (e.g. `stage2Call` inside `runChapter`,
   > `analysis.ts:3974`). Phase 0 and Phase 1 run concurrently, and Phase 1 keeps
   > up to `concurrency` chapters in flight (L4237-4240) — a module-level or
   > book-level sink would mix sub-calls from different chapters/passes into the
   > wrong record. A frontend/admin test and a route test both assert isolation
   > (see Testing). Never introduce a shared "current pass" sink.

   (`attributeChapterStage2` / `runStage1ChapterChunked` / `runEmotionChapter` /
   review / stage3), then in a **`finally`** folds `acc` into one
   `AnalyzerEvalRecord` and appends it (`outcome:'failed'` if the pass threw).
   A thin helper `recordPassEval(acc, { manuscriptId, bookTitle, stage,
   chapterId, chunkCount, outcome })` centralises the fold so each of the ~5 call
   sites is a one-line wrap. **`model` comes from `acc`, not the route** — the
   route needn't know which model ran, which also means:

**FallbackAnalyzer / Gemini:** only Ollama `chat()` calls fire `onEvalTiming`, so
`acc` holds Ollama sub-calls exclusively. A pass that ran entirely on Gemini
leaves `acc` empty → **no record emitted** (correct). The recorded `model` is
therefore always the unambiguous Ollama tag that actually decoded; `recordPassEval`
skips an empty `acc` and, defensively, keys `model` off the last entry (a single
pass never mixes local models — the local-model split is *across* passes).

**Escalation is excluded (v1).** `runAttributionEscalation`'s `chat()` call
(`ollama.ts:391-397`) forwards only `onChunk`/`signal`, not `onEvalTiming`, so
escalation-window sub-calls contribute nothing to the stage-2 record. This is the
intended v1 behaviour (best-effort, no retry, would muddy per-chapter decode
rate); wiring it in later is a one-line change if per-window rate proves useful.

**Aggregation rules** (in `recordPassEval`): `evalTokS = ΣevalCount ÷
(ΣevalDuration/1e9)` (token-weighted); `loadMs = max`; `subCalls = acc.length`;
`chunkCount` from the pass result when it exposes one (`Stage2ChunkRunResult`),
else `null` (stage-1-chapter unions rosters — no directly comparable count; a
**failed** pass has no result at all). The failure path still emits: the fold
runs in the `finally`, so a pass that threw after N sub-calls records
`outcome:'failed'`, `chunkCount:null`, and whatever tok/s its sub-calls managed —
which is precisely the "died slow" signal the canary exists for.

## Storage — `analyzer-eval-stats.ts`

Near-clone of `resource-telemetry.ts`:

- Append-only JSONL at `join(telemetryDir(), 'analyzer-eval-stats.jsonl')`.
- **Best-effort, never throws** — a write failure must never break a run; a
  corrupt trailing line (crash mid-append) is skipped by the reader.
- **Serialized appends.** Because N Phase-1 workers (plus Phase 0) can finish
  passes concurrently, the append+trim is guarded by a module-level promise-chain
  mutex (`queue = queue.then(() => appendAndTrim(rec))`) so a `trimIfNeeded`
  read-modify-write never races a concurrent append and drops lines. (fs-20's
  `resource-telemetry.ts` omits this because generation rarely appends N-way
  concurrently; the analyzer does, so we add it here.)
- **Total-line cap** (`ANALYZER_EVAL_MAX_LINES`, ~2000 like fs-20) via
  read-trim-rewrite, newest kept. `manuscriptId` + `model` live in each row, so
  grouping is a read-time concern — no per-key cap.
- `readAnalyzerEvalRecords(limit?)` → newest-first (mirrors `readTelemetry`).

## API

Extend the `generation-stats.ts` route (shares `/api/generation`, next to
`/telemetry`):

```
GET /api/generation/analyzer-stats?limit=  →  { records: AnalyzerEvalRecord[] }
```

Best-effort: a read failure returns `{ records: [] }`, not a 500 — the panel
keeps its last-good snapshot (same contract as `/telemetry`).

## Admin surface — `AnalyzerTrends` panel

New component in `admin.tsx`, modelled on `ResourceTrends`, mounted alongside it:

- **Grouping by KEY, not contiguity.** Bucket all records by `(manuscriptId,
  model)` across the whole window, then order buckets by most-recent record. This
  is the deliberate departure from `ResourceTrends`' contiguous-run fold: a
  concurrent multi-book run interleaves the shared JSONL, and a contiguous fold
  would shatter it into A,B,A,B slivers. Model is part of the key so a
  local-model split (`ollama.ts:141`) or a `:latest` variance separates cleanly
  (model canonicalised at write time).
- **Per section:** header (`bookTitle ?? manuscriptId` · `model` · pass-count ·
  avg tok/s), a hand-rolled inline-SVG **tok/s sparkline** (reuse the
  `ResourceTrends` approach; no charting dep), then a per-(chapter, pass) table:
  Ch · Pass · tok/s · prompt t/s · load · sub-calls (with a `⑂ chunks` hint when
  `chunkCount > 1`, so a split pass reads as split, not slow).
- **Trend cue inverts RTF:** rising RTF = bad; here **falling tok/s = bad**. The
  arrow/tint keys off a tok/s *drop* vs the same-(manuscript,model) neighbour.
- **Load-spike tint:** `loadMs` over a threshold (start ~200 ms, tune on real
  data) is tinted — a reload mid-run (co-residency pressure).
- **Failed-pass row:** `outcome:'failed'` rows are tinted distinctly (the pass
  that died — often the slow one).
- **Bounded scroll:** sections live inside a fixed max-height `overflow-y:auto`
  container (mirror `data-testid="resource-trends-scroll"`, new
  `data-testid="analyzer-trends-scroll"`). Grows internally, scrolls, never
  expands the page. Empty state: "No analyzer telemetry recorded yet."

Selected layout: **trend-first, book-scoped** (approved via the brainstorming
visual companion — `layout-v2.html`).

## Resolved questions (closed before planning)

1. **Emission boundary** — the pass-orchestration site (accumulate on the reused
   `StageCall`, emit once in a `finally`), NOT `runStage`. tok/s is
   token-weighted (`ΣevalCount/ΣevalDuration`), `loadMs = max`, plus `subCalls` +
   `chunkCount` so split overhead is distinguishable from real slowdown.
   *Evidence: `stage2-chunk.ts:285-391`, `analysis.ts:1733-1761`.*
2. **Book key** — `manuscriptId` (stable, always present at analysis time;
   `analysis.ts` threads it everywhere). `title` is a denormalized best-effort
   label, nullable on early passes. *Evidence: `analysis.ts:4062-4063`, 3180-3184.*
3. **Concurrent multi-book grouping** — bucket by `(manuscriptId, model)` key
   over the window, not contiguous runs, so interleaving can't shatter a trend.
   *Evidence: memory invariant "concurrent multi-book = first-class".*
4. **Model under FallbackAnalyzer** — taken from the accumulated Ollama sub-calls
   (canonicalised), so it's unambiguous; a pure-Gemini pass emits nothing.
5. **Failed passes** — recorded best-effort in the `finally` with
   `outcome:'failed'`, `chunkCount:null`, so a pass that died slow is still visible.
6. **Escalation windows** — excluded (their `chat()` path doesn't fire
   `onEvalTiming`); intended v1 behaviour. *Evidence: `ollama.ts:391-397`.*
7. **Append concurrency** — serialized via a module-level promise-chain mutex, so
   N pipelined workers can't race the trim. *Evidence: pipelining at `analysis.ts:4237-4251`.*

**Scope note:** covered passes are the per-chapter ones (stage-1-chapter,
stage-2-chapter, emotion, nonstory, review, stage3). Whole-book `stage1`
(`runStage1`, non-pipelined legacy mode) is out of v1 — it's one call of low
drift-signal value; wiring it in is trivial if wanted.

## Testing

- **Unit — `analyzer-eval-stats.test.ts`:** token-weighted tok/s (incl. `null` on
  zero-duration), `loadMs=max`, append + newest-first read, total-line cap trim,
  corrupt-line skip. Mirrors `model-vram-stats.test.ts`.
- **Unit — `recordPassEval` fold:** a chunked pass (many `RawEvalTiming` entries
  across "chunks + coverage retries + a validation retry") folds to ONE record
  with correct `subCalls`/`chunkCount`/weighted tok/s; a Gemini-only pass (empty
  `acc`) emits nothing; a thrown pass emits `outcome:'failed'`.
- **Unit — `ollama.test.ts`:** a stubbed stream whose `done` line carries timing
  fires `onEvalTiming` with the raw counts + model; the env-gate suppresses it;
  a `runAttributionEscalation` call does NOT fire it (escalation excluded).
- **Concurrency — isolation invariant:** two passes run with overlapping
  `onEvalTiming` sinks on distinct `StageCall` objects fold into two records with
  no cross-contamination (the pipelining regression); concurrent `recordPassEval`
  calls under the serialized writer retain all lines (no trim-race drop).
- **Route — `generation-stats.test.ts`:** `GET /analyzer-stats` returns newest-
  first, honours `limit`, returns `{ records: [] }` on read error.
- **Frontend — `admin.test.tsx`:** renders the panel; **interleaved
  A,B,A,B records still bucket into two (manuscriptId,model) sections** (the Q3
  regression); falling-tok/s deterioration cue; a `chunkCount>1` row shows the
  chunk hint; the scroll container carries the bounded-height testid.
- No e2e (admin-panel read only); add later if we want it locked.

## Rollout / ops

- `analyzer.evalStats.enabled` goes through the registry + `.env.example` per
  repo convention (every new env var is a registry knob). Default **on**.
- Regression plan: a `docs/features/` entry at implementation time (tag the issue
  `needs-plan`); release-notes-next + RELEASE_NOTES lines in the shipping PR
  (operator-visible telemetry = a shippable delta).
- Backlog: file a `srv-` issue (area:server + area:frontend) + thin
  `docs/BACKLOG.md` row; PR links it `Closes #NN`.
- **All implementation lands on a feature branch in an isolated git worktree**
  (per the run directive) — one integration PR, verified once.

## Open questions (non-blocking — tune during implementation)

1. **loadMs highlight threshold** — 200 ms is a guess; tune once real data lands.
2. **avg tok/s in the header** — simple mean vs an EMA like fs-45's VRAM fold.
   Mean for v1; EMA is a trivial follow-up.
