---
title: fe-29 — In-app Help / troubleshooting view + fs-19 completion (unified analysis-failure taxonomy)
date: 2026-06-12
status: draft
issues:
  - fe-29 (#473) — In-app help / troubleshooting panel
  - fs-19 (#469, closed) — completes the deferred analysis-path classification
    recorded in plan 173's Ship notes / PR #495 notes
plans:
  - docs/features/173-failure-taxonomy.md (update; → stable/archive after live acceptance)
  - docs/features/209-help-troubleshooting-view.md (new, fe-29)
---

# fe-29 Help view + fs-19 completion

## Summary

Two halves under one design, shipped as two sequenced PRs:

1. **Finish fs-19** — unify ALL analysis-path failure classification into the
   structured failure taxonomy generation already uses. Analysis failures
   surface through three distinct mechanisms today, and only generation got
   the fs-19 treatment:
   - **Per-chapter cast-phase failures** (two `chapter-failed` SSE sites,
     `analysis.ts` ≈ 2563 / 4072) — raw `err.message`, degrades to a generic
     *"failed on a previous attempt"* after reload because only bare
     `failedChapterIds` persist.
   - **Per-chapter stage-2 coverage-suspect** (`analysis.ts:3209`) — adds to
     `failedChapterIds` with **no SSE and no Error object** at all.
   - **Run-level errors** (`describeError()` + `classifyStatus()`,
     `analysis.ts:4496/4613`, called at ≈ 3604 / 4477) — a second, ad-hoc
     classifier with its own code vocabulary (`truncated`, `daily_quota`,
     `rate_limit`, `unavailable`, `internal`, `invalid_key`, `bad_request`,
     `unknown`) feeding the analysing view's run-error panel.

   After this work there is ONE code vocabulary (the OpenAPI `FailureCode`
   enum), one ordered signature table, and one canonical copy source shared
   by the server, the failure surfaces, and the Help view.
2. **fe-29 Help view** — a new offline `#/help` view (Getting started →
   Keyboard shortcuts → Troubleshooting) reachable from a persistent top-bar
   "?" and an Account row. Its troubleshooting section renders every taxonomy
   entry from the shared copy module plus a small curated set of hand-written
   topics; the analysing view (rows + run-error panel) and the Generate view
   deep-link into it via `#/help?code=<failure-code>`.

Both halves touch `server/src/routes/failure-taxonomy.ts`, so the shared-copy
refactor happens exactly once.

## Goals

- A failed analysis chapter shows `userMessage` + remediation, live and after
  reload — parity with the Generate view (fs-19's original promise).
- The analysing run-error panel keeps its existing UX (detail collapsible,
  daily-quota reset line) but speaks `FailureCode` and shows a remediation +
  Help link.
- One canonical source for remediation copy; editing a string in one place
  updates failure rows, the run-error panel, and the Help view together.
- Help is reachable in ≤2 clicks from anywhere, ships fully static (no network
  dependency — it must work precisely when the server is down), and is
  deep-linkable per failure code.
- Plan 173 can finally go `stable` → archive once live acceptance is done.

## Non-goals

- **No contextual help drawer/overlay.** `#/help` is a dedicated view
  (follows the `/about` + `/release-notes` pattern). A drawer can be a later
  item if contextual help-in-place proves needed.
- **No search-within-help.** One scrollable page; Ctrl-F works.
- **Control-flow event codes stay untouched.** `aborted`, `cast_incomplete`,
  `stage1_shrink_refused` are run-control signals with dedicated frontend
  branches (`analysing.tsx` ≈ 484/496/507), not failures — they do NOT join
  the taxonomy.
- **No migration of `failedChapterIds`.** It stays `number[]` (too many
  touchpoints); the new error records are an additive sibling.
- **No second keybindings registry.** The shortcuts section reads the live
  `settings.keybindings` from the store.
- **No "More help" link on toasts.** `PushToastPayload` has no action/link
  support; rows and the run-error panel are persistent and carry the link —
  extending the toast system is not worth it for a transient surface.

---

## Part A — fs-19 completion (PR 1)

### A1. Shared remediation copy module

New canonical file `server/src/routes/failure-remediations.ts` — a
dependency-free const module (deliberately **not** JSON: both packages are
`"type": "module"` with the server on `module: NodeNext`, where a JSON import
needs `with { type: 'json' }` attributes and tsc's emit of imported `.json`
into `dist/` is a dev-works/prod-breaks footgun):

```ts
export const FAILURE_REMEDIATIONS = {
  'vram-spill': { userMessage: '…', remediation: '…' },
  'analyzer-truncated': {
    userMessage: '…',
    remediation: '…',
    helpDetail: '…optional longer prose only the Help view renders…',
  },
  // … one entry per FailureCode, INCLUDING 'unknown': its remediation is the
  // existing UNKNOWN_REMEDIATION string (moved here); its userMessage is a
  // generic line used by the Help view (at classification time the unknown
  // path still substitutes the trimmed raw error string, unchanged)
} as const;
```

- Lives **inside `server/src/`** because the server build's `rootDir` is
  `server/src`; emitted to `dist/` like any other module. The frontend
  imports it by relative path (`../../server/src/routes/failure-remediations`)
  — Vite compiles/bundles it statically (the repo root is the Vite root, so
  the path is in-tree), keeping the Help view offline-capable. The module
  imports nothing, so it type-checks identically under both tsconfigs and
  cannot create a frontend↔server cycle.
- `failure-taxonomy.ts` keeps every regex, the table **order**, and `fatal`
  in TS; each signature pulls `userMessage`/`remediation` from the module by
  `code`. The existing `failure-taxonomy.test.ts` strings stay green verbatim
  — copy is relocated, not reworded. (New analysis-side copy is new.)
- Contract pins:
  - server test: module keys exactly equal the signature codes + fallback —
    i.e. the full `FailureCode` enum.
  - frontend (Help data mapper): `satisfies Record<FailureCode, …>` against
    the OpenAPI-generated enum — a new code without copy fails typecheck on
    both ends. (The module itself stays untyped-strict to remain
    dependency-free; each consumer pins it.)
- Live classification messages may be more specific than the canonical
  `userMessage` (the run-level path interpolates model label / status / reset
  time — see A3); `remediation` is always the shared string, and the Help
  view always renders the canonical copy.

### A2. One vocabulary — source-gating + new codes

- `FailureSignature` gains `source: 'generation' | 'analysis' | 'both'`
  (existing signatures default `'generation'`), and an optional
  `matchName?: string` matcher tested against `err.name` (for typed analyzer
  errors — no string regex on prose that may change). **The generation-side
  match sequence is unchanged** (plan-154 ordering invariants).
- New `FailureCode` values (OpenAPI enum → `npm run openapi:types`), all
  `source: 'analysis'`:
  - `analyzer-unreachable` — connection refused / fetch failed / HTTP
    503/500 from the analyzer. Covers Ollama down AND analyzer service
    errors. Copy must note the silent-fallback behaviour: when
    `GEMINI_API_KEY` is set, an unreachable Ollama silently retries against
    Gemini (`analyzer/index.ts` `FallbackAnalyzer`), so this surfaces mainly
    when no fallback is configured or both engines fail.
    (`GeminiStreamIdleError` also maps here via `matchName`; it is internally
    retried (`gemini.ts:384`) and only escapes after retry exhaustion.)
  - `analyzer-truncated` — `AnalyzerTruncatedError` via `matchName`
    (run-level today; cast-phase truncation also possible). Copy: the model's
    reply was cut short even after adaptive re-split; retry, lower
    `STAGE2_CHUNK_CHAR_BUDGET`, or switch to a stronger analyzer model.
  - `analyzer-daily-quota` — `DailyQuotaExhaustedError` via `matchName` +
    the existing free-tier 429 heuristic (`classifyStatus:4619`). Kept
    distinct from `analyzer-rate-limit` because the remedies differ (switch
    model / wait until reset vs. just retry) and the frontend renders a
    reset-time line for it.
  - `attribution-incomplete` — synthetic code for the stage-2
    coverage-suspect path (no Error object exists there). Copy: some lines in
    this chapter may be unattributed; the best take was kept — retry the
    chapter to re-attribute.
- Re-gated to `'both'`: `analyzer-rate-limit`, `auth`, `disk-full`.
- Run-level code mapping (old → new): `truncated` → `analyzer-truncated`;
  `daily_quota` → `analyzer-daily-quota`; `rate_limit` →
  `analyzer-rate-limit`; `unavailable`/`internal` → `analyzer-unreachable`;
  `invalid_key` → `auth`; `bad_request` → `unknown` (rare; the raw message +
  detail blob still carry the diagnostic, which is the actionable part).

### A3. Unify the run-level classifier

- `describeError()` + `classifyStatus()` + `tryParseApiError()` +
  `trimQuotaMessage()` move from `analysis.ts` into `failure-taxonomy.ts` as
  `classifyAnalysisFailure(err, modelLabel) → { code: FailureCode;
  userMessage; remediation; detail? }`:
  - typed-error checks (`AnalyzerTruncatedError`, `DailyQuotaExhaustedError`,
    `GeminiStreamIdleError`) and the API-envelope/status parsing port
    **verbatim** — same precedence, same message construction (model label,
    status suffix, quota trimming, detail blob);
  - codes come out as `FailureCode` per the A2 mapping;
  - `remediation` is attached from the shared module.
- Call sites: the two run-level sites (≈ 3604 / 4477) AND the two cast-phase
  per-chapter catch sites (≈ 2563 / 4072) all call it — the cast phase talks
  to the same analyzer and throws the same error family.
- The run-level `kind: 'error'` SSE event gains `remediation` (additive);
  `code` values change per the A2 mapping — the frontend consumers update in
  the same PR. Frontend checks that key on run-level codes
  (`analysing.tsx:1129/1144` `daily_quota`) accept BOTH old and new strings
  for one release in case any persisted/paused snapshot surface carries an
  old code (verify during implementation; drop the shim if none does).
- Control-flow events (`aborted`, `cast_incomplete`, `stage1_shrink_refused`)
  are emitted elsewhere and bypass this entirely.

### A4. Per-chapter persistence + SSE

- Analysis cache (`server/src/store/analysis-cache.ts`) gains additive
  `failedChapterErrors?: Record<string, { code: FailureCode; message: string;
  remediation: string }>` (string keys — chapter ids serialise as JSON object
  keys), written at **three** sites: the two cast-phase catches (real
  classification) and the coverage-suspect site (`analysis.ts:3209`,
  synthetic `attribution-incomplete` record). The existing clear-on-success
  helper (`analysis.ts:783`) clears the record alongside the id.
- The `chapter-failed` SSE event + its reconnect replay map
  (`failedByChapterId`, `analysis.ts:1357`) gain optional `code` +
  `remediation`. The coverage-suspect site additionally emits a
  `chapter-failed` tick (it currently emits nothing — the live view learns
  about the flag only via the cast tick side-channel, which is itself a gap).
- Book-state response (`openapi.yaml` `analysis` object, ≈ line 4906) gains
  `failedChapterErrors` as `additionalProperties` keyed by string chapter id
  (additive). The analysis SSE payload types live in the frontend stream
  client — extend the shared TS type there.

### A5. Analysing view

- `failedChapters` row state gains `code?` + `remediation?`; populated live
  from the upgraded SSE and, on reload, hydrated from
  `book-state.analysis.failedChapterErrors` — the generic *"Analysis failed
  on a previous attempt"* fallback only remains for legacy caches with no
  record.
- Rows render `userMessage` + a **"What to do:"** line, matching the Generate
  view's fs-19 treatment.
- The run-error panel shows the (already-displayed) message plus the new
  `remediation` line; its `daily_quota` special-casing keys on
  `analyzer-daily-quota`.
- ("More help" deep-links land in PR 2 with the Help view.)

---

## Part B — fe-29 Help view (PR 2)

### B1. Routing & stage

- New stage kind `{ kind: 'help'; focusCode?: FailureCode }` in `ui-slice.ts`;
  hash grammar `#/help` and `#/help?code=<failure-code>` (`router.ts` — same
  flat pattern as `about`, query param mirrors `?profile=`). `stageEqual`
  compares `focusCode`.
- Lazy-loaded route in `src/routes/index.tsx` (same shape as `AboutRoute`,
  child of the root `<Layout/>` route — so the top bar renders on it, as it
  does on every route), view at `src/views/help.tsx`.

### B2. Entry points

- **Top bar** (`src/components/top-bar.tsx`): a "?" icon button next to the
  theme toggle. `aria-label="Help"`, active state on `#/help`, ≥44 px touch
  target on phone (`min-h-[44px] sm:min-h-0` idiom).
- **Account** (`src/views/account.tsx`): a "Help & troubleshooting" row next
  to the existing release-notes link.
- **Visual baselines:** the top-bar icon changes every full-page screenshot —
  PR 2 regenerates the `test:e2e:visual` baselines (`--update-snapshots`) in
  the same change; call it out in the PR body.

### B3. Page structure

One scrollable page, jump-nav at top (sticky sidebar ≥1024 px, inline links
below that — per the plan-81 three-viewport protocol). Sections in order:

1. **Getting started** — static prose walkthrough of the core flow (Add a
   book → analysis → confirm cast → design voices → generate → listen/export),
   one short paragraph per step, plus a pointer to the bundled demo book
   (fs-22) as the zero-risk first run. Prose lives in the view.
2. **Keyboard shortcuts** — reads `settings.keybindings` live from the store
   (play-pause / skip-back / skip-forward), rendered via `formatKeyLabel`,
   with a "change these in Account" link. Shows the *user's* bindings, not
   defaults.
3. **Troubleshooting** — two blocks:
   - **Failures the app can name**: every entry from the shared copy module
     (incl. the new analyzer codes), rendered as: code title → "What you saw"
     (`userMessage`) → "What to do" (`remediation`, plus `helpDetail` when
     present). Each entry carries `id={code}` as its anchor.
   - **Curated topics** (`src/data/help-topics.ts`, frontend-only, ~5
     entries): app won't start; sidecar/models missing; generation is slow;
     phone can't reach the app (LAN cert); where files live on disk.

All content ships in the bundle — zero network dependency.

### B4. Deep-links from failure surfaces

- `#/help?code=X` scrolls to and briefly highlights the matching entry on
  mount (graceful no-op for an unknown code).
- **Generate view**: the failed-chapter row gains a small **"More help"**
  link when `generationErrorCode` is present (already on the row — no new
  plumbing). Suppressed for `unknown` (the anchor adds nothing over the
  remediation already shown).
- **Analysing view**: failed-chapter rows AND the run-error panel gain the
  same link when a code is present (from Part A).
- Toasts deliberately carry no link (see Non-goals).

### B5. Design language

Reuses the existing view chrome (`/about` as the reference): design-token CSS
vars only (no hex literals), General Sans / Lora per brand, dark-mode via the
existing tokens. New view must pass the axe-core a11y harness conventions.

---

## Error handling

- Unknown `?code=` → page renders normally, no scroll/highlight.
- Legacy analysis cache without `failedChapterErrors` → analysing view keeps
  the current generic fallback line (no crash, no blank).
- Persisted surfaces carrying pre-rename run-level codes (if any) → frontend
  special-case checks accept old + new strings for one release (A3).
- A `FailureCode` missing from the copy module is impossible at runtime —
  both sides fail typecheck/test first (A1 contract pins).

## Testing

**PR 1 (server + analysing view):**
- Taxonomy unit: source-gating (a sidecar string never matches via the
  analysis path; an analyzer string never matches via `classifyFailure`);
  every existing `failure-taxonomy.test.ts` case green verbatim; copy-module
  key-parity test.
- `classifyAnalysisFailure`: ports the existing `describeError` behaviours as
  tests — truncation (`AnalyzerTruncatedError` fields in `detail`),
  daily-quota (reset time preserved), envelope-parsed 429/503/500/401/400
  mapping per A2, quota-message trimming, unknown fallback. Real captured
  strings where they exist.
- Analysis route: a failed cast chapter persists a `failedChapterErrors`
  record and the SSE carries `code` + `remediation`; the coverage-suspect
  path persists the synthetic `attribution-incomplete` record AND emits a
  `chapter-failed` tick; clear-on-success removes record + id.
- Frontend: analysing view renders remediation from a live event and from a
  hydrated book-state; legacy fallback still renders without a record; the
  run-error panel shows remediation and its daily-quota branch fires on the
  new code.

**PR 2 (help view):**
- Frontend unit: all three sections render; `?code=` focuses the right entry;
  unknown code no-ops; shortcuts reflect a rebound key from the store; router
  round-trip for `#/help?code=`; `satisfies Record<FailureCode, …>` compile
  pin.
- E2E (`e2e/help.spec.ts`): click top-bar "?" → assert the three sections +
  one known remediation entry render; deep-link `#/help?code=vram-spill`
  lands focused. Plus the mandatory new-view case in
  `e2e/responsive/coverage.spec.ts` (phone/tablet/desktop) and the
  regenerated visual baselines (B2).

**Owed manual (closes plan 173):** live acceptance across ≥2 real failure
modes on the GPU box. Recipe notes:
- `sidecar-unreachable`: stop the sidecar mid-generation.
- `analyzer-unreachable`: stop Ollama mid-analysis **with `GEMINI_API_KEY`
  unset/blanked** — otherwise `FallbackAnalyzer` silently retries against
  Gemini and nothing fails (that silence is correct behaviour, not a bug).
- Confirm row/panel copy + the Help deep-link both ways.

## Delivery shape

| PR | Branch | Contents |
|---|---|---|
| 1 | `feat/server-fs19-analysis-classification` | A1–A5: shared copy module, source-gating + new codes, run-level unification, persistence/SSE, analysing-view remediation display |
| 2 | `feat/frontend-fe29-help-view` | B1–B5: help view, entry points, deep-links, visual-baseline regen |

- New regression plan `docs/features/209-help-troubleshooting-view.md`
  (fe-29); plan 173 updated in PR 1 (deferral resolved, invariants extended
  with the analysis-side mapping) and moved `stable` → archive after the owed
  live acceptance.
- Issue #473 closes via PR 2 (`Closes #473`); PR 1 references plan 173
  (`Refs #469` for the paper trail).
- `docs/BACKLOG.md` fe-29 row removed when PR 2 merges;
  `docs/features/INDEX.md` updated both rounds.

## Out of scope (explicit)

Contextual help drawer; search-within-help; toast links; control-flow event
codes (`aborted`, `cast_incomplete`, `stage1_shrink_refused`); classifying
historical/legacy failure records retroactively; any change to the
generation-side match order.
