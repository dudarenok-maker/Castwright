# Analyzer: local-by-default engine + opt-out (announced) cloud fallback + patient warm + honest review progress

- **Date:** 2026-07-15
- **Status:** implemented (v4 — folds three 2026-07-15 Opus adversarial passes) — see Ship notes
- **Issue:** [#1660](https://github.com/dudarenok-maker/Castwright/issues/1660)
- **Ship notes:** Implemented on `fix/server-analyzer-local-warm-and-fallback-gate`, six commits —
  Part 0 `361ca3d4` (local default + ANALYZER retired), Part 1 `8d912055` (allowCloudFallback gate + UI),
  Part 2 `24f4e8c8` (patient warm), Part 3 `c51e4c9e` (honest review failure), Part 4 `1515d839`
  (finite Gemini chunk budget + force-split), Part 5 + ship-prep (this commit). Full frontend + server
  suites green at each step. **Accept-owed on a GPU box:** 3.2 (loading/waiting timer + amber tone on a
  real slow local warm — not changed blind), 4.5 (Gemini multi-chunk vs single-call parity on Coalfall +
  a Night-Watch-scale chapter). Deferred: force-split is script-review-only; annotate-emotion +
  instruct-annotation rely on the finite budget + honest `chapter-failed`. E2E for the failure panel
  skipped (mock `reviewScript` has no failure-injection hook; covered by server + jsdom tests). The
  immediate `.env` `ANALYZER=gemini` removal on the dev box still needs a **server restart**.
- **Area:** server (analyzer routing / chunking / script review) + frontend (settings UI, review progress)
- **Amends:** `docs/superpowers/specs/2026-07-14-script-review-progress-heartbeat-model-load-design.md`
  (deliberately **reverses its C1 resolution** — see §Background)
- **Key files:** `server/src/analyzer/index.ts`, `server/src/workspace/user-settings.ts`,
  `server/src/routes/ollama-health.ts`, `server/src/routes/script-review.ts`,
  `server/src/analyzer/chapter-chunker.ts` (+ `resolveStage1ChunkCharBudget`),
  `server/src/routes/annotate-emotion.ts`, `server/src/routes/instruct-annotation.ts`, prosody pass.

## Background — the incident

A user with `analysisEngine: "local"` saved, a warm reachable Ollama, and the local model
pulled, nonetheless had **every** script-review pass run on **Gemini `gemma-4-31b-it`**, which
failed the pass (`reason=MAX_TOKENS`, empty response — `logs/server.err.log` 2026-07-14 16:55,
chapter 35), showing a flat `0%` that ticked to 157s then emptied.

Confirmed root causes:
1. **Engine silently resolved to `gemini`.** `getResolvedAnalysisEngine()` (`user-settings.ts:573`)
   is `cached?.analysisEngine ?? process.env.ANALYZER ?? 'local'`, **but** the product default is
   already cloud — `DEFAULT_USER_SETTINGS.analysisEngine === 'gemini'` (`:263`), the zod field has
   **no `.default()`** (`:135`) so a settings file *missing* that key **parse-fails → all-defaults
   → gemini** (`:336`), and `server/.env` carried `ANALYZER=gemini`. Multiple roads to silent cloud.
2. **`GEMINI_API_KEY` present ⇒ silent cloud fallback even under `local`.** `selectAnalyzer` wraps
   Ollama in `FallbackAnalyzer(→Gemini)` whenever a key exists (`index.ts:189-203`). A key kept for
   Gemini **TTS voices** silently reroutes **manuscript analysis**.
3. **Whole chapter → one Gemini call.** `chapterChunkBudget('gemini')` returns
   `Number.MAX_SAFE_INTEGER` (`chapter-chunker.ts:93`), so a large chapter's ops output overruns the
   model's output-token cap → MAX_TOKENS. **Shared** by script-review AND annotate-emotion AND
   instruct-annotation AND prosody.
4. **Failure is invisible.** A non-unreachable chapter error → `chapter-failed` and the loop
   continues; a pass that produces nothing just clears (0% → empty).

**Decisions (user, 2026-07-15):** (a) default engine → **local**, harden all silent-cloud paths;
(b) cloud fallback stays **ON by default** (non-breaking — existing behaviour unchanged) but is a
**user-controllable toggle in the admin/settings section** (opt-**out** for strict local-only),
applied to both passes; (c) chunk Gemini for **all 3** output-heavy routes; (d) surface partial +
total review failure. *(Note: (b) reverses an earlier default-OFF/opt-in choice — default-ON avoids
regressing "Ollama-down + Gemini-up" installs on upgrade while still giving the privacy control.)*

## Goals / Non-goals

**Goals.** A saved (or defaulted) `local` choice is honoured **end-to-end** — the engine resolves
local **and** the default model is a local id, so a local user is never deterministically routed to
cloud (root cause #1). Cloud fallback (on by default) is **always announced, never silent** — the existing
`switchToFallback` announcement (`script-review.ts:685-701`, kept; see Part 1.4) shows "Switched to
Gemini" whenever a local miss falls back — and is **opt-out** for users who want strictly local. (Precise privacy guarantee under default-ON: *not*
"never sent to cloud," but "never sent **silently** — every fallback is visible — and one toggle
away from never at all.") A merely-slow local warm is waited out, only a genuine connection failure
is "unreachable"; large chapters (Night Watch-sized) review on Gemini without MAX_TOKENS; chapter
failures are surfaced, not swallowed.

**Non-goals.** No analysis-stream-middleware re-plumb; no ETA/pacing changes; **no fake
intra-call progress bar** (unknowable mid-generation — Part 3 makes a slow call *read* as working);
stage-1 cast detection keeps `MAX_SAFE_INTEGER` on Gemini (tiny roster output — correct).

---

## Part 0 — robust engine resolution (fixes root cause #1)

0.1 `DEFAULT_USER_SETTINGS.analysisEngine`: **`'gemini'` → `'local'`** (`user-settings.ts:263`),
    aligning with CLAUDE.md's documented default. **This alone** makes both a *missing* field
    (backfilled by DEFAULT) and a *corrupt* field (parse-fail → `{...DEFAULT}` at `:336`) resolve to
    local.
0.1b **Default MODEL must move in lockstep (Blocker 1).** `DEFAULT_USER_SETTINGS.defaultAnalysisModel`
    (`user-settings.ts:246`) **and** `FRONTEND_ACCOUNT_DEFAULTS.defaultAnalysisModel`
    (`account-defaults.ts:45`) are both `'gemini-3.1-flash-lite'` (a Gemini id). Left unchanged, a
    fresh user gets `engine:'local'` + a Gemini model pre-selected, and the first Defaults save
    re-derives `analysisEngine:'gemini'` via `engineForModelId` (`step-defaults.tsx:97-98`) —
    silently undoing 0.1. **Flip both to a local id (`'qwen3.5:4b'`, the curated
    `DEFAULT_OLLAMA_MODEL`)** so engine + model agree. Accepted consequence (user-confirmed): a fresh
    box with no Ollama shows "Analyzer needed" until Ollama is set up or the user picks Gemini + adds
    a key — the wizard already guides this (Part 5).
0.2 zod field **may** add `.default('local')` (`:135`) for defence-in-depth, but note it is largely
    **inert**: `readUserSettings` parses `{...DEFAULT_USER_SETTINGS, ...migrated}` (`:335`) so the
    field is never `undefined`, and a corrupt enum value fails the parse (`.default` doesn't rescue
    it) → the `:336` fallback → DEFAULT (local, via 0.1). The real fix is 0.1; 0.2 is belt-only.
0.3 `getResolvedAnalysisEngine()` reads **`getCachedUserSettings().analysisEngine`** (which returns
    the DEFAULT — now `local` — when the module cache is cold), instead of
    `cached?.x ?? process.env.ANALYZER ?? 'local'`. **This retires `ANALYZER` as an engine
    selector** — it is the only way to close the leak (because `analysisEngine` is an
    always-present-with-default field, any resolver that still consulted env would have to read the
    leaky raw-null `cached`). `GEMINI_API_KEY` is unaffected (still used for TTS + opt-in fallback).
    Update the CLAUDE.md `ANALYZER=local|gemini` doc line to note env no longer selects the engine.
0.4 **Migration:** existing files with a saved `analysisEngine` (incl. `gemini`) are unchanged —
    only *absent/corrupt* values now default local; a stray `ANALYZER=gemini` in a `.env` becomes
    **inert** for engine selection (previously a silent-cloud road). Release-note both.
0.5 **Tests:** missing field → local; corrupt field → local; null cache → local; saved `gemini`
    → gemini (unchanged); saved `local` with `ANALYZER=gemini` in env → **local** (env retired).
    **Migrate every existing analyzer/route test that drives the engine via `process.env.ANALYZER`**
    (e.g. `select-analyzer.test.ts`) to set the engine through cached user-settings instead — env no
    longer selects, so those would silently test nothing. Grep the server suite for
    `process.env.ANALYZER =`.

0.6 **Stale-copy cleanup (cosmetic, same commit).** Flipping the default *values* leaves rationale
    comments + labels that still call Gemini the default — update `user-settings.ts:239-245,260-263`,
    `account-defaults.ts:39-45,54`, and the picker optgroup `models.ts:164,173-174` ("Gemini API
    (default)"). No behaviour change; keeps the codebase honest about the new default.

*Why this is the real #1 fix:* Part 1's gate only touches the `local` branch of `selectAnalyzer`;
#1 routes through the `gemini` branch, so only Part 0 closes it.

## Part 1 — `allowCloudFallback` gate (default ON, admin opt-out)

1.1 **Setting + resolver + type plumbing** (Major — larger than server-only). Add
    `allowCloudFallback: boolean` to: (a) server `DEFAULT_USER_SETTINGS` (**true**) + zod
    (`.default(true)`); (b) **`openapi.yaml`** `UserSettings` **and** `UserSettingsPatch` schemas —
    the frontend `UserSettings` type is OpenAPI-generated (`src/lib/types.ts:108,113`), so run
    **`npm run openapi:types`** to regenerate `src/lib/api-types.ts`; (c) **`FRONTEND_ACCOUNT_DEFAULTS`**
    (`account-defaults.ts`) — add the field (**true**) **and** flip its `analysisEngine` to `'local'`
    + its `defaultAnalysisModel` to the local id, in lockstep with 0.1/0.1b (the file is documented
    "flip in lockstep"). The account slice needs no new thunk (`AccountState extends UserSettings`;
    `saveAccountSettings` takes a patch). `getResolvedAllowCloudFallback()` reads the saved value
    (defaulting **true**); `ANALYZER_ALLOW_CLOUD_FALLBACK` is a **pre-cache legacy under-ride only**,
    documented, not a live override.
1.2 **Gate the wrapper** (`selectAnalyzer`, `index.ts:189-210`): build `FallbackAnalyzer` only when
    `apiKey && getResolvedAllowCloudFallback()`; else bare `OllamaAnalyzer`, `fallbackModel: null`.
    Applies to both passes (both resolve through `selectAnalyzer`/`selectAnalyzerForPhase`). With the
    default ON, `local + key` still wraps exactly as today — behaviour changes **only** when a user
    turns the toggle **off**.
1.3 **Downstream is already correct** for `fallbackModel === null`: script-review warm-fail
    (`script-review.ts:713-721`) emits `model_load_failed` + Retry, never cloud.
1.3a **Admin toggle placement.** Surface `allowCloudFallback` as a toggle in the admin **analyzer
    settings** section — `src/components/.../model-settings-form.tsx` (the engine/Gemini-key block at
    `~:479-511`), default **on**. Copy: "Cloud fallback — if the local analyzer is unavailable, fall
    back to Gemini (requires an API key). Turn off to keep analysis strictly local." **Also fix the
    stale copy in the same block** (`model-settings-form.tsx:482,490`) that still labels **Gemini** as
    the "default" — Part 0 makes **local** the default; update both strings.
1.4 **Behaviour is non-breaking by default; the reversals apply ONLY when a user opts out.** Because
    the default is ON, existing installs (incl. "Ollama-down + Gemini-up") are **unchanged** — no
    upgrade regression, no migration hazard. When a user **turns the toggle off**:
    - Warm-fail with a key no longer switches to Gemini (spec C1 reversal — now user-elected).
    - **Mid-pass** `LocalUnreachableError` no longer fails over — `switchToFallback`/`onFallback`
      (`script-review.ts:685-701,788`) go dead; remaining chapters hard-fail (`chapter-failed`).
    - **In-UI hint** on a local warm/connect failure while the toggle is off **and** a Gemini key is
      present: "Local analyzer unavailable — turn on Cloud fallback in Settings to use Gemini." So an
      opt-out user who then hits a local outage has a one-click path back.
    All three must be **explicitly tested** in the off state.
1.5 **Tests.** Because the default is **ON**, the existing contract tests
    (`select-analyzer.test.ts:49-58,200-205`: local+key → `FallbackAnalyzer`) **still pass unchanged**
    — no rewrite needed (they'll be migrated off `process.env.ANALYZER` by Part 0.5 regardless). Add:
    - gate **off** → bare `OllamaAnalyzer`, `fallbackModel===null`; gate **on** (default) →
      `FallbackAnalyzer` (pins the default).
    - resolver default is **true**; `ANALYZER_ALLOW_CLOUD_FALLBACK` pre-cache semantics.
    - script-review regression: engine=local + key + **gate off**, warm fails → `model_load_failed`,
      **no** Gemini call, **no** chapter runs.
    - mid-pass local drop + **gate off** → `chapter-failed`, **no** silent Gemini; **gate on** →
      still fails over (default resilience preserved).

## Part 2 — patient warm (`ollama-health.ts` + script-review warm step)

2.1 **Fast reachability pre-check.** Before the warm POST, a cheap `/api/tags` probe (2s
    `PROBE_TIMEOUT_MS`). **ECONNREFUSED / connection error → `unreachable`, return immediately**
    (no long wait). A probe **timeout** (reachable-but-hung daemon) is **not** treated as
    unreachable here — fall through to the warm attempt, which the budget bounds (2.3).
2.2 **Liveness during load.** The warm `keep_alive` POST blocks until the model is resident, so it
    can't emit incremental progress by itself. Emit the `loading` heartbeat from a **parallel
    time ticker** so the panel shows `Loading model · Ns` while the POST is in flight. **Not** an
    `/api/ps` poll — Ollama's `/api/ps` lists only *resident* models (`ollama-health.ts:76-90`), so a
    still-loading model shows as absent until it finishes; the poll would read empty for the whole
    load. The ticker is the only viable liveness source.
2.3 **Budget = registry knob** `analyzer.ollama.warmTimeoutMs` (default **120000**; a 15GB cold
    model on slow disk exceeds the old hard 30s). Add via `registry.ts` + `npm run config:sync` in
    the same commit. Model still not resident past budget → **`load_timeout`** (distinct from
    `unreachable`). **Check `job.controller.signal` each poll iteration** so a cancel during the
    now-longer warm short-circuits to `error{code:'cancelled'}` immediately. **Side effect (intended,
    note it):** `warmOllamaModel` is shared by the manual **Load** button (`/load`,
    `ollama-health.ts:338`), so the budget lift raises that button's ceiling too (30s → 120s).
2.4 **Return shape** `{ ok:true } | { ok:false, kind:'unreachable'|'load_timeout'|'error', status,
    error }`. `/load` route (`ollama-health.ts:338-342`) keeps reading `status`/`error` (retained);
    map each `kind` to its HTTP status. Warm-fail copy distinguishes "Ollama isn't running"
    (`unreachable`) from "model took too long" (`load_timeout`).
2.5 **Tests:** reachable + slow warm → `ok:true`, `loading` heartbeat seen; connection-refused →
    `unreachable` **fast** (≤ probe budget); reachable-but-never-resident past budget →
    `load_timeout`; cancel mid-warm → `cancelled`, not `model_load_failed`; registry knob overrides
    budget (config:check green); `/load` route still returns correct status per kind.

## Part 3 — honest review progress

3.1 **Surface failure — partial AND total** (`script-review.ts` terminal path):
    - **Any** `chapterFailedEvents.length > 0` → include a non-fatal `failedChapters` summary on the
      `result` so the panel shows "N chapters couldn't be reviewed" + Retry — even when other
      chapters produced ops (the incident's chapter-35-hidden-among-successes case).
    - **All** chapters failed / zero ops **and** ≥1 failure → terminal
      `error{ code:'review_failed', failedChapters, lastMessage }` instead of a silent empty result.
    - A genuinely clean book (no failures, no ops) stays a normal empty result — not an error.
3.2 **Slow-call liveness reads as "working," not "stuck."** No fake bar. **Empirically verify**
    (drive a real local review — do not assume yesterday's feature is wired) that
    `activityState:'loading'/'waiting'` + the `useElapsed` timer + amber tone actually render on
    this path; fix wiring if not.
3.3 **Tests:** server — all-fail → `review_failed`; mixed (some ops + some failed) → `result`
    carries `failedChapters`, not silent. Frontend — `review_failed` + partial-failure render +
    Retry; loading/waiting timer + amber tone present on a slow-warm phase. E2E (mock) — force a
    chapter failure, assert the panel shows an error/partial state + Retry, not emptying.

## Part 4 — chunk Gemini for all 3 output-heavy routes (stop MAX_TOKENS, incl. Night Watch)

4.1 **The bug (shared).** `chapterChunkBudget(engine)` (`chapter-chunker.ts:93` →
    `resolveStage1ChunkCharBudget`) returns `MAX_SAFE_INTEGER` for gemini, used by **exactly three**
    routes — `script-review.ts:767`, `annotate-emotion.ts:166`, `instruct-annotation.ts:165` — all
    emitting **per-sentence output**, all able to overrun on a large chapter. (There is **no
    separate "prosody" route**: prosody = the instruct-annotation / Stage-3 pass. Stage-1 cast
    detection calls `resolveStage1ChunkCharBudget` **directly**, so it is untouched by a change to
    `chapterChunkBudget` — a genuinely clean seam; no `pass` param needed.)
4.2 **Fix — new seam, don't corrupt stage-1.** `resolveStage1ChunkCharBudget` also feeds stage-1
    cast detection (`analysis.ts:3079,5024`) where gemini→`MAX_SAFE_INTEGER` is **correct** (tiny
    output). Since the three output-heavy routes call `chapterChunkBudget` while stage-1 calls
    `resolveStage1ChunkCharBudget` **directly**, making `chapterChunkBudget` return a **finite**
    gemini budget cleanly separates them — **no `pass` param needed**. The budget is **larger** than
    local's `num_ctx`-derived value (Gemini has bigger context/output headroom, and fewer calls is
    friendlier on RPM/RPD) but never unbounded. Registry knob
    `analyzer.gemini.outputHeavyChunkChars` (single knob shared by the three routes; revisit
    per-route only if calibration diverges).
4.3 **Night Watch-sized chapters.** The existing `chunkSentencesByBudget` (greedy char packing) already
    scales to any size — a finite budget makes a 60k-char chapter split into as many chunks as
    needed; a single oversized sentence forms its own chunk. No new chunking logic, just a finite
    budget.
4.4 **Force-split-on-truncation recovery (bounded, not absolute).** Bounding **input** chars only
    *approximates* bounding **output** tokens (verbose `rationale` strings mean a small input with
    many flagged sentences can still overrun). Safety net: on a `MAX_TOKENS`/`AnalyzerTruncatedError`
    for a chunk, **re-run `chunkSentencesByBudget` on that chunk's cores at a smaller budget and
    retry the sub-chunks** — this is the *concept* of stage-1's forced split, but the mechanism
    differs: script-review chunks are **sentence-array cores** carrying the `ownsOp` dedup invariant
    (`chapter-chunker.ts:32-81`, `script-review.ts:766-795`), **not** stage-1's prose spans
    (`stage1-chunk.ts:105-127`). The re-split MUST preserve "each sentence owned by exactly one core"
    so ops don't double-emit or drop. **Base case (honest):** a single verbose sentence is its own
    core and can't split further (`chapter-chunker.ts:47-48`) — mirroring `stage1-chunk.ts:143`
    (`if (forced.length <= 1) throw`), it **still surfaces `chapter-failed`**, now handled visibly by
    Part 3. So this makes truncation *rare and mostly-recoverable*, not impossible; the residual is
    routed to the honest-failure path, not swallowed.
4.5 **Quality parity (not just perf).** Chunking removes whole-chapter context Gemini used to see;
    overlap-3 + `ownsOp` dedup handle boundaries, but a structural op spanning a boundary is a risk.
    **Validate** Gemini multi-chunk output against the single-call baseline on a fixture
    (Coalfall + a Night Watch-scale chapter) before shipping — don't assume parity from "local runs
    this path."
4.6 **Blast radius.** Updating the shared budget touches the annotate-emotion + instruct-annotation
    callers and their tests — include them in scope.
4.7 **Tests:** large chapter under gemini yields **≥2** chunks for each of the three routes (today
    exactly 1); budget finite + registry-overridable; a chunk that still truncates triggers a
    force-split and completes (regression tied to the chapter-35 overrun, via a stub analyzer that
    truncates once); ops from overlapping chunks de-duped by `ownsOp`; stage-1 cast budget
    **unchanged** (`MAX_SAFE_INTEGER`); parity check on the fixture.

---

## Part 5 — wizard clarity + Gemini-select path (mostly verify, minimal surgery)

The setup wizard **already** satisfies the "clear + Gemini works" requirement — this part is
verification + guardrail tests, not new wizard surgery (keeping clear of the concurrent
wizard-persistence branch, which touches `step-voice`/`setup-wizard`, **not** `step-analysis`/
`step-defaults`).

5.1 **Already present:** `step-analysis.tsx` is local-first (card ① Local via Ollama with
    install + model-pull, card ② Online via Gemini key) with a tri-state Analyzer badge; the active
    engine is chosen in the Defaults step, and `step-defaults.tsx:95-98` derives
    `analysisEngine = engineForModelId(model)` (`:`→local, else gemini) and saves it alongside
    `defaultAnalysisModel`. So "provide a key + select a Gemini model → routes to Gemini" holds today.
5.2 **Coherence with Part 0's new default (depends on 0.1b).** Once `defaultAnalysisModel` is a local
    id (0.1b), the Defaults step pre-selects a **local** model, `engineForModelId` derives `'local'`,
    and the first save keeps `analysisEngine:'local'` — engine + model agree, no flip-back. Verify
    the fresh-user round-trip: seed → local model shown → save → engine stays local. (Without 0.1b
    this test *fails* — that's the Blocker-1 coupling.)
5.3 **Fresh-user guidance (Part 0 side-effect).** A brand-new user now defaults to local; the
    Analysis-step badge already renders "Analyzer needed" until Ollama is set up **or** a Gemini key
    is added — confirm the copy makes the local-needs-Ollama / add-a-key choice obvious (adjust copy
    only if unclear; no structural change).
5.4 **Tests:** unit — selecting a Gemini model in Defaults saves `analysisEngine:'gemini'`
    (`engineForModelId`); selecting a local `:`-tagged model saves `'local'`. Component — fresh
    account defaults the Analysis-model select to a local id. Server — engine=gemini + key set →
    `selectAnalyzer` routes to Gemini **regardless** of `allowCloudFallback` (explicit selection is
    never gated). E2E (mock) — the wizard local-first copy + both cards render.

## Verification (this worktree — hooks are no-ops here)

`EnterWorktree` ran no `npm install`; husky hooks silently no-op — **do not trust git-hook output**.
Run manually before push: `npm run typecheck`, `npm run test` (frontend),
`cd server && npm run test` + targeted analyzer/script-review/route specs, `npm run build`, and one
**real driven local script-review** (run-app / `/run`) confirming Part 3 on the UI. node_modules
(root + server) and the sidecar `.venv` are junctioned from the main checkout.

## Rollout / tracking

- File a GitHub issue (bug-shaped: silent cloud routing + unhelpful review progress + Gemini
  MAX_TOKENS on large chapters); `Closes #NN` at PR time.
- Amend the 2026-07-14 heartbeat spec's C1 note to point here (its resolution is superseded).
- Release-notes (`docs/release-notes-next.md` + `RELEASE_NOTES.md`) covering: local is now the
  default engine + default model; cloud fallback stays **on by default but is now visible and
  can be turned off** (opt-**out**, in analyzer settings); large-chapter Gemini analysis fixed.
  No upgrade regression (default-ON preserves existing behaviour) — frame it as new *control* +
  fixes, not a behaviour change.
- Paired tests per part above.
