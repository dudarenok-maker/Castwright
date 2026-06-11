---
title: fe-29 — In-app Help / troubleshooting view + fs-19 completion (analysis-path classification)
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

1. **Finish fs-19** — route analysis-path chapter failures through the same
   structured failure taxonomy generation already uses, so the analysing view
   shows a jargon-free message + a "What to do" line (live AND after reload),
   instead of a raw error string that degrades to a generic *"failed on a
   previous attempt"* on refresh. As part of this, the per-code copy
   (`userMessage` / `remediation`) moves into one shared JSON file both the
   server and the frontend import.
2. **fe-29 Help view** — a new offline `#/help` view (Getting started →
   Keyboard shortcuts → Troubleshooting) reachable from a persistent top-bar
   "?" and an Account row. Its troubleshooting section renders every taxonomy
   entry from the shared JSON plus a small curated set of hand-written topics,
   and both failure surfaces (analysing + generate views) deep-link into it
   via `#/help?code=<failure-code>`.

The two halves touch the same module (`server/src/routes/failure-taxonomy.ts`),
so the shared-JSON refactor happens exactly once.

## Goals

- A failed analysis chapter shows `userMessage` + remediation, live and after
  reload — parity with the Generate view (fs-19's original promise).
- One canonical source for remediation copy; editing a string in one place
  updates the failure row, the toast, and the Help view together.
- Help is reachable in ≤2 clicks from anywhere, ships fully static (no network
  dependency — it must work precisely when the server is down), and is
  deep-linkable per failure code.
- Plan 173 can finally go `stable` → archive once live acceptance is done.

## Non-goals

- **No contextual help drawer/overlay.** `#/help` is a dedicated view
  (follows the `/about` + `/release-notes` pattern). A drawer can be a later
  item if contextual help-in-place proves needed.
- **No search-within-help.** One scrollable page; Ctrl-F works.
- **No run-level analysis error classification.** `cast_incomplete` /
  `stage1_shrink_refused` are run-level pause/refuse mechanisms with their own
  UX, not per-chapter failures — untouched.
- **No migration of `failedChapterIds`.** It stays `number[]` (too many
  touchpoints); the new error records are an additive sibling.
- **No second keybindings registry.** The shortcuts section reads the live
  `settings.keybindings` from the store.

---

## Part A — fs-19 completion (PR 1)

### A1. Shared remediation copy file

New canonical file `server/src/routes/failure-remediations.json`:

```jsonc
{
  "vram-spill":  { "userMessage": "…", "remediation": "…" },
  "analyzer-truncated": {
    "userMessage": "…",
    "remediation": "…",
    "helpDetail": "…optional longer prose only the Help view renders…"
  }
  // … one entry per FailureCode, INCLUDING "unknown": its remediation is the
  // existing UNKNOWN_REMEDIATION string (moved here); its userMessage is a
  // generic line used only by the Help view (at classification time the
  // unknown path still substitutes the trimmed raw error string, unchanged)
}
```

- Lives **inside `server/src/`** because the server build's `rootDir` is
  `server/src` — the frontend imports it by relative path
  (`../../server/src/routes/failure-remediations.json`); Vite bundles it
  statically, so the Help view stays offline-capable. Both tsconfigs need
  `resolveJsonModule` (add where missing).
- `failure-taxonomy.ts` keeps every regex, the table **order**, and `fatal`
  in TS; each signature now pulls its `userMessage`/`remediation` from the
  JSON by `code`. The existing `failure-taxonomy.test.ts` strings stay green
  verbatim — the copy is relocated, not reworded.
- Both sides pin the contract:
  - server test: JSON keys exactly equal the set of signature codes + the
    fallback.
  - frontend: `satisfies Record<FailureCode, …>` against the OpenAPI-generated
    enum — a new code without copy fails typecheck on both ends.

### A2. Source-gating + two new codes

- `FailureSignature` gains `source: 'generation' | 'analysis' | 'both'`
  (existing signatures default `'generation'`), and an optional
  `matchName?: string` matcher tested against `err.name` (for typed analyzer
  errors — no string regex on prose that may change).
- New entry point `classifyAnalysisFailure(err)` filters the same ordered
  table to `source ∈ {analysis, both}`. `classifyFailure` (generation) filters
  to `{generation, both}` — so `sidecar-unreachable` can never be blamed for
  an analysis failure and vice versa. **Plan-154 ordering invariants are
  untouched** (the generation-side match sequence is unchanged).
- New codes (added to the OpenAPI `FailureCode` enum → `npm run openapi:types`):
  - `analyzer-unreachable` — Ollama down / connection refused / Gemini stream
    idle (`GeminiStreamIdleError` via `matchName`). Copy: the analyzer could
    not be reached or stopped responding; check the Ollama daemon / network,
    or switch analyzer.
  - `analyzer-truncated` — `AnalyzerTruncatedError` via `matchName`. Copy: the
    model's reply was cut short; usually a weak/overloaded model — retry the
    chapter, or switch to a stronger analyzer model.
- Re-gated to `'both'`: `analyzer-rate-limit`, `auth`, `disk-full`. Everything
  else stays generation-only. Unknown fallback behaviour unchanged
  (`fatal: false`, trimmed raw string).

### A3. Persistence + SSE

- Analysis cache (`server/src/store/analysis-cache.ts`) gains additive
  `failedChapterErrors?: Record<number, { code: FailureCode; message: string;
  remediation: string }>`, written at the two `chapter-failed` catch sites in
  `analysis.ts` (≈ lines 2563 and 4072) alongside the existing
  `failedChapterIds` write; the existing clear-on-success helper
  (`analysis.ts:783`) clears both.
- The `chapter-failed` SSE event + its reconnect replay map
  (`failedByChapterId`, `analysis.ts:1357`) gain optional `code` +
  `remediation` fields.
- Book-state response (`openapi.yaml` `analysis` object, ≈ line 4906) gains
  `failedChapterErrors` (additive). The analysis SSE payload types live in the
  frontend stream client — extend the shared TS type there.

### A4. Analysing view

- `failedChapters` row state gains `code?` + `remediation?`; populated live
  from the upgraded SSE and, on reload, hydrated from
  `book-state.analysis.failedChapterErrors` — the generic *"Analysis failed on
  a previous attempt"* fallback only remains for legacy caches with no record.
- Row renders `userMessage` + a **"What to do:"** line, matching the Generate
  view's fs-19 treatment. (The "More help" deep-link lands in PR 2 with the
  Help view.)

---

## Part B — fe-29 Help view (PR 2)

### B1. Routing & stage

- New stage kind `{ kind: 'help'; focusCode?: FailureCode }` in `ui-slice.ts`;
  hash grammar `#/help` and `#/help?code=<failure-code>` (`router.ts` — same
  flat pattern as `about`, query param mirrors `?profile=`). `stageEqual`
  compares `focusCode`.
- Lazy-loaded route in `src/routes/index.tsx` (same shape as `AboutRoute`),
  view at `src/views/help.tsx`.

### B2. Entry points

- **Top bar** (`src/components/top-bar.tsx`): a "?" icon button next to the
  theme toggle. `aria-label="Help"`, active state on `#/help`, ≥44 px touch
  target on phone (`min-h-[44px] sm:min-h-0` idiom).
- **Account** (`src/views/account.tsx`): a "Help & troubleshooting" row next
  to the existing release-notes link.

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
   - **Generation & analysis failures**: every entry from the shared JSON
     (incl. the two new analyzer codes), rendered as: code title → "What you
     saw" (`userMessage`) → "What to do" (`remediation`, plus `helpDetail`
     when present). Each entry carries `id={code}` as its anchor.
   - **Curated topics** (`src/data/help-topics.ts`, frontend-only, ~5
     entries): app won't start; sidecar/models missing; generation is slow;
     phone can't reach the app (LAN cert); where files live on disk.

All content ships in the bundle — zero network dependency.

### B4. Deep-links from failure surfaces

- `#/help?code=X` scrolls to and briefly highlights the matching entry on
  mount (graceful no-op for an unknown code).
- The Generate view's failed-chapter row + failure toast gain a small
  **"More help"** link when `generationErrorCode` is present (already on the
  row — no new plumbing).
- The analysing view's failed-chapter rows gain the same link when `code` is
  present (from Part A).

### B5. Design language

Reuses the existing view chrome (`/about` as the reference): design-token CSS
vars only (no hex literals), General Sans / Lora per brand, dark-mode via the
existing tokens. New view must pass the axe-core a11y harness conventions.

---

## Error handling

- Unknown `?code=` → page renders normally, no scroll/highlight.
- Legacy analysis cache without `failedChapterErrors` → analysing view keeps
  the current generic fallback line (no crash, no blank).
- A `FailureCode` missing from the JSON is impossible at runtime — both sides
  fail typecheck/test first (A1 contract pins).

## Testing

**PR 1 (server + analysing view):**
- Taxonomy unit: source-gating (a sidecar string never matches via
  `classifyAnalysisFailure`; an Ollama-refused string never matches via
  `classifyFailure`); the two new codes fed real captured strings/error names;
  existing `failure-taxonomy.test.ts` green verbatim; JSON↔signature
  key-parity test.
- Analysis route: a failed chapter persists a `failedChapterErrors` record;
  the `chapter-failed` SSE carries `code` + `remediation`; clear-on-success
  removes both.
- Frontend: analysing view renders remediation from a live event and from a
  hydrated book-state; legacy fallback still renders without a record.

**PR 2 (help view):**
- Frontend unit: all three sections render; `?code=` focuses the right entry;
  unknown code no-ops; shortcuts reflect a rebound key from the store; router
  round-trip for `#/help?code=`; `satisfies Record<FailureCode, …>` compile
  pin.
- E2E (`e2e/help.spec.ts`): click top-bar "?" → assert the three sections +
  one known remediation entry render; deep-link `#/help?code=vram-spill`
  lands focused. Plus the mandatory new-view case in
  `e2e/responsive/coverage.spec.ts` (phone/tablet/desktop).

**Owed manual (closes plan 173):** live acceptance across ≥2 real failure
modes on the GPU box (e.g. stop the sidecar mid-generation →
`sidecar-unreachable`; stop Ollama mid-analysis → `analyzer-unreachable`),
confirming row copy + Help deep-link both ways.

## Delivery shape

| PR | Branch | Contents |
|---|---|---|
| 1 | `feat/server-fs19-analysis-classification` | A1–A4: shared JSON refactor, source-gating + new codes, persistence/SSE, analysing-view remediation display |
| 2 | `feat/frontend-fe29-help-view` | B1–B5: help view, entry points, deep-links from both failure surfaces |

- New regression plan `docs/features/209-help-troubleshooting-view.md`
  (fe-29); plan 173 updated in PR 1 (deferral resolved) and moved
  `stable` → archive after the owed live acceptance.
- Issue #473 closes via PR 2 (`Closes #473`); PR 1 references plan 173
  (`Refs #469` for the paper trail).
- `docs/BACKLOG.md` fe-29 row removed when PR 2 merges;
  `docs/features/INDEX.md` updated both rounds.

## Out of scope (explicit)

Contextual help drawer; search-within-help; run-level analysis error
classification (`cast_incomplete`, `stage1_shrink_refused`); classifying
historical/legacy failure records retroactively; any change to the
generation-side match order.
