---
status: active
shipped: null
owner: null
---

# Analyzer eval-rate telemetry (fs-76)

> Status: active
> Key files: `server/src/analyzer/analyzer-eval-stats.ts`,
> `server/src/analyzer/ollama.ts`, `server/src/analyzer/index.ts` (`StageCall`),
> `server/src/routes/analysis.ts`, `server/src/routes/annotate-emotion.ts`,
> `server/src/routes/instruct-annotation.ts`, `server/src/routes/script-review.ts`,
> `server/src/routes/generation-stats.ts`, `src/lib/types.ts`, `src/lib/api.ts`,
> `src/views/admin.tsx` (`AnalyzerTrends`)
> URL surface: `#/admin` (Analyzer throughput panel, alongside Resource trends)
> OpenAPI ops: none (internal telemetry route, not part of the OpenAPI contract)

## Benefit / Rationale

- **User (operator):** a long local-Ollama analysis run's decode speed is now
  visible in the Admin console — a drift canary for thermal throttle, KV-cache
  growth, or a mid-run eviction/reload — instead of only being discoverable by
  grepping server logs.
- **Technical:** exact per-call Ollama timing (`eval_count`/`eval_duration`/
  `prompt_eval_count`/`prompt_eval_duration`/`load_duration`) that was already
  parsed off the `done:true` streaming line and discarded is now captured,
  folded per analysis pass, and persisted.
- **Architectural:** establishes a third fs-20/fs-45-shaped telemetry store
  (alongside resource-telemetry and model-vram-stats) with one new invariant
  those two didn't need — a **serialized append mutex**, because the analyzer
  pipeline appends N-way concurrently (fs-20's generation telemetry does not).
  Purely observational: nothing reads this store to change a decision (no
  adaptive behaviour, per the design's non-goals).

## Architectural impact

- **New seams / extension points:**
  - `onEvalTiming?: (t: RawEvalTiming) => void` callback param on `ollama.ts`
    `chat()`, joining the existing `onChunk`/`signal` params.
  - `StageCall.onEvalTiming` (`server/src/analyzer/index.ts`) — `runStage`
    forwards it into every `chat()` call it makes (first attempt + validation
    retry), so a single reused `StageCall` transparently accumulates every
    sub-call of a chapter-pass with no change to the chunk runner.
  - `withPassEval()` (`analyzer-eval-stats.ts`) — the pass-boundary wrapper:
    installs a fresh accumulator on `call.onEvalTiming`, awaits the pass, folds
    + appends exactly one record in a `finally`.
  - New registry knob `analyzer.evalStats.enabled` (env `CASTWRIGHT_EVAL_SAMPLE`,
    default `true`, `server/src/config/registry.ts:879-880`,
    `server/.env.example:473`) gates the capture independently of the fs-45
    VRAM sampler.
  - `GET /api/generation/analyzer-stats?limit=` (`generation-stats.ts`) —
    returns `{ records: AnalyzerEvalRecord[] }`, newest-first.
- **Invariants preserved:**
  - Best-effort observability discipline (fs-20/fs-45): a telemetry write
    failure never breaks a run; a read failure returns `{ records: [] }`, not
    a 500.
  - Concurrent multi-book workflow (memory: "concurrent multi-book = first-class
    invariant") — grouping is by `(manuscriptId, model)` key over the whole
    window, not contiguous runs, so an interleaved multi-book JSONL can't be
    shattered into slivers by the admin panel's fold.
- **Migration story:** none — new append-only JSONL file
  (`<telemetryDir()>/analyzer-eval-stats.jsonl`), no existing data shape
  touched, no `state.json`/`cast.json`/`openapi.yaml` change.
- **Reversibility:** flip `analyzer.evalStats.enabled` off
  (`CASTWRIGHT_EVAL_SAMPLE=0`, restart) to stop new capture; delete the JSONL
  file to clear history. No code path depends on the data existing.

## Invariants to preserve

- **Token-weighted tok/s, not a mean of per-chunk rates.** `evalTokS = ΣevalCount
  ÷ (ΣevalDuration/1e9)`; `promptTokS` the same shape over prompt-eval counts.
  Enforced in `foldPassTiming` (`server/src/analyzer/analyzer-eval-stats.ts:58-59,
  64-83`). `null` (not 0) when the summed duration is 0, so a divide-by-zero
  can never corrupt the trend or sparkline.
- **`loadMs` is a MAX over sub-calls**, not a sum or mean — it surfaces any
  mid-pass eviction/reload; ~0 when the model stays fully resident
  (`analyzer-eval-stats.ts:73,80`).
- **Exactly ONE record per (manuscriptId, chapterId, stage).** A dense
  chapter's stage-2 pass fires many `chat()` calls (chunks × coverage retries
  × validation retries) — all folded into a single `AnalyzerEvalRecord` at the
  pass-orchestration boundary, never per-chunk or per-attempt
  (`withPassEval`, `analyzer-eval-stats.ts:154-174`).
- **Concurrency isolation via a fresh-per-call accumulator.** `withPassEval`
  allocates a NEW `acc: RawEvalTiming[]` local to each invocation and installs
  it on that call's own `StageCall.onEvalTiming` — never a module-level or
  book-level sink. This is what keeps Phase 0/Phase 1 pipelining (up to
  `concurrency` chapters in flight) from cross-contaminating records between
  chapters or passes.
- **Serialized JSONL append.** A module-level promise-chain mutex
  (`writeQueue = writeQueue.then(() => appendAndTrim(rec))`,
  `analyzer-eval-stats.ts:87-96`) guarantees a concurrent trim (read-modify-
  write against the total-line cap) never races a concurrent append and drops
  a line — required because N pipelined analysis workers can finish passes
  concurrently (unlike fs-20's generation telemetry, which doesn't need this).
- **Admin grouping is by KEY, not contiguity.** `AnalyzerTrends`
  (`src/views/admin.tsx`) buckets all records by `(manuscriptId, model)` across
  the whole window and orders buckets by most-recent record — deliberately NOT
  a contiguous-run fold (which would shatter an interleaved concurrent
  multi-book JSONL into A,B,A,B slivers).
- **Escalation is excluded (v1).** `runAttributionEscalation`'s `chat()` call
  (`ollama.ts:391-397`) forwards only `onChunk`/`signal`, not `onEvalTiming` —
  escalation-window sub-calls contribute nothing to the stage-2 record. This
  is intended v1 scope, not a bug.
- **Best-effort, never throws.** Both the store (`analyzer-eval-stats.ts`
  `appendAndTrim`'s try/catch) and the route (`generation-stats.ts`
  `.catch(() => [])`) swallow failures — telemetry can never break an analysis
  run or turn a read into a 500.
- **Falling tok/s = deteriorating** (inverted from RTF, where rising = bad).
  The admin panel's trend cue keys off a tok/s *drop* vs. the same-
  `(manuscriptId, model)` neighbour.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/analyzer-eval-stats.test.ts`) — token-
  weighted tok/s incl. `null` on zero-duration, `loadMs = max`, append +
  newest-first read, total-line cap trim, corrupt-line skip, concurrent-append
  no-drop under the serialized writer.
- Vitest server (`server/src/analyzer/ollama.test.ts`) — a stubbed stream whose
  `done` line carries timing fires `onEvalTiming` with the raw counts + model;
  the `analyzer.evalStats.enabled` env-gate suppresses it; a
  `runAttributionEscalation` call does NOT fire it (escalation exclusion).
- Vitest server (`server/src/routes/analyzer-eval-wiring.test.ts`) — a chunked
  pass (chunks + coverage retries + a validation retry) folds to ONE record
  with correct `subCalls`/`chunkCount`/weighted tok/s; a Gemini-only pass
  (empty accumulator) emits nothing; a thrown pass emits `outcome:'failed'`;
  two concurrent passes on distinct `StageCall`s fold into two records with no
  cross-contamination (the pipelining regression).
- Vitest server (`server/src/routes/generation-stats.test.ts`) — `GET
  /analyzer-stats` returns newest-first, honours `limit`, returns
  `{ records: [] }` on a read error.
- Vitest frontend (`src/views/admin.test.tsx`) — renders the `AnalyzerTrends`
  panel; interleaved A,B,A,B records still bucket into two
  `(manuscriptId, model)` sections; falling-tok/s deterioration cue renders;
  a `chunkCount > 1` row shows the chunk hint; the scroll container carries
  `data-testid="analyzer-trends-scroll"`.

No e2e — the panel is an admin-only read surface over telemetry, not a
user-facing golden path; add one later if the trend cue's correctness needs
locking at the browser level.

### Manual acceptance walkthrough

Run against the real local server (not mock mode — this exercises the real
Ollama analyzer path):

1. Run a local analysis on a real manuscript (e.g.
   `server/src/__fixtures__/the-coalfall-commission.md`) with the local
   Ollama analyzer engine selected and `analyzer.evalStats.enabled` at its
   default (on).
2. Open `#/admin` → the **Analyzer throughput** panel (sibling of Resource
   trends). Confirm a section per `(book, model)` combination, each showing a
   tok/s sparkline and a per-(chapter, pass) table whose rows name the model
   that ran that pass.
3. Set `CASTWRIGHT_EVAL_SAMPLE=0` in `server/.env`, restart the server, run
   another analysis pass. Confirm no new rows appear in the panel (existing
   history is untouched — the knob only gates new capture).

## Out of scope

- **Live top-bar pill.** The Admin history panel is the only surface — no
  always-visible top-bar readout (design non-goal).
- **Adaptive behaviour.** Nothing reads this store to change a decision
  (keep-alive, model choice, batch caps) — pure observability, mirroring fs-45
  v1.
- **Gemini eval-rate.** Only the local Ollama path exposes per-token decode
  timing the way this store needs; a pass that runs entirely on Gemini
  contributes no record (empty accumulator, by design).
- **Whole-book legacy `stage1`** (`runStage1`, non-pipelined mode) — one call
  of low drift-signal value; only the six per-chapter passes (stage1-ch,
  stage2-ch, emotion, nonstory, review, stage3) are wired.
- **Known follow-up gap — the "retry failed chapters" subset route.** The
  subset-retry route in `server/src/routes/analysis.ts` (around L5071 and
  after, `runSubsetAnalyzerJob` / the retry-a-chapter-that-failed-Phase-1
  path) re-runs stage-1/stage-2/nonstory for the retried chapter(s) but is
  **not** wired through `withPassEval` — a chapter retried via that route
  produces no eval-rate telemetry for the retry attempt. This is a deliberate
  scope boundary for v1 (the six main-analyzer-job boundaries were the
  highest-value wiring); closing it later is mechanical — the same
  lift-the-inline-`StageCall`-to-a-named-const-then-wrap pattern used at the
  six existing call sites, applied to the retry route's call sites.

## Ship notes

(Filled in when status flips to `stable`.)
