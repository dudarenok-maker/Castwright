---
status: stable
shipped: 2026-05-22
owner: null
---

# 95 — Analysing-stage multi-model UI + sticky status bar

> Status: stable. Shipped 2026-05-22 via PR #138 (merge commit `2a0081d`).
> Key files: `src/views/analysing.tsx`, `src/components/analysing/phase-card.tsx`, `src/components/analysing/phase-model-chip.tsx`, `src/components/analysing/phase-model-swap.tsx`, `src/components/analysing/sticky-analysis-bar.tsx`, `src/store/account-slice.ts`, `src/store/analysis-slice.ts`
> URL surface: `#/books/<id>/analysing`
> OpenAPI ops: none (purely a frontend surfacing of state already persisted via `PUT /api/user/settings` per plan 88)

## Benefit / Rationale

- **User:** sees which model is actually running each phase of the analysis loop and can swap it from where they're looking — no round-trip to Account → Save → Back. Pause + active-model stays in view while the phase logs scroll, so a long run never hides the controls.
- **Technical:** the per-phase model defaults shipped in plan 88 + PR #118 are exposed exactly once (on Account) today. This plan adds a second consumer that reads the same `UserSettings` keys via shared selectors. The selectors mirror the server-side precedence chain in `server/src/analyzer/select-analyzer.ts:11–21`, so client + server agree on the active model without a wire-format change.
- **Architectural:** breaks the 1,300-line `src/views/analysing.tsx` orchestrator into a thin view + `src/components/analysing/` sub-components (`PhaseCard`, `PhaseModelChip`, `PhaseModelSwap`, `StickyAnalysisBar`), mirroring the listen-view split shipped in plan 60. Per-phase UI now has a real seam — future per-phase work (live quota meters, per-phase failed-chapter triage) inherits the same shape.

## Architectural impact

**New seams / extension points:**
- `src/components/analysing/` directory (parallel to `src/components/listen/`).
- `selectAnalyzerPhase0Model` / `selectAnalyzerPhase1Model` / `selectAnalyzerPhase1MinLag` exported from `src/store/account-slice.ts`. Frontend-side precedence chain: `userSettings.analyzerPhase{0,1}Model` → documented default (`'gemma-4-31b-it'` / `'gemini-3.1-flash-lite'`). Env-var branch (server-only) is intentionally skipped; the frontend cannot read `process.env`.
- `selectActivePhaseId` derived selector on `analysis-slice` (reads `activeStream?.phaseId`).

**Invariants preserved:**
- `ui.stage` discriminated-union shape (plan 00) — no new variants.
- OpenAPI shapes (plan 24) — no contract change; same `UserSettings` payload.
- Design tokens (plan 25) — sticky bar uses `--canvas` / `--ink` via Tailwind classes, no hex literals.
- Sticky-across-navigation pill (plan 32) — different surface from this plan's sticky-on-scroll bar. The top-bar plan-32 pill keeps working unchanged; this plan adds an in-view sticky bar that lives below the topbar and only on the analysing route.

**Migration story:** none. All values read from existing `UserSettings` fields shipped in plan 88; null falls through to documented default.

**Reversibility:** revert the PR. No data migration to undo. The legacy single-model `<select>` deleted from `analysing.tsx:1392–1419` would need to be restored manually if the per-phase chips were ripped out — `ui.selectedModel` writes are dropped in this PR.

## Invariants to preserve

1. **Per-phase model precedence is `userSettings → default`, mirroring server precedence.** `selectAnalyzerPhase0Model` returns `state.account.analyzerPhase0Model ?? 'gemma-4-31b-it'`; analogously for phase 1. Mirror of `server/src/analyzer/select-analyzer.ts:11–21` minus the env-var branch.
2. **The sticky bar is CSS-only (`position: sticky`, `top-16`, `z-30`).** No `IntersectionObserver`, no scroll listener, no React state. `src/views/analysing.tsx:1277` already wraps with `relative min-h-...` (no `overflow: hidden` clamp), so sticky resolves against the page viewport.
3. **Phase 0 model swap mid-run takes effect from the next chapter onward, never mid-chapter.** Per the user-memory `feedback_warmup_window_for_model_splits.md`, mid-phase-0 swap is dangerous because the cast roster anchors against a single model's interpretation. `<PhaseModelSwap/>` dispatches `saveAccountSettings({...})` and shows a 4-second toast "Applies from next chapter" — does NOT abort the in-flight stream.
4. **Phase 1 chip stays dim with "Warms up after chapter N" tooltip until the watermark releases.** `analyzerPhase1MinLagChapters` default = 10 (plan 88).
5. **Sticky bar mounts ONCE, above the phase cards, outside the centered `max-w-2xl` column** so the backdrop-blur bleeds edge-to-edge over the gradient-hero-wash.

## Test plan

### Automated coverage

- **Vitest unit** `src/components/analysing/phase-model-chip.test.tsx` — given store with `analyzerPhase0Model = 'gemma-4-31b-it'`, asserts chip text reads "gemma-4-31b-it" with the streaming state pill; with `null`, falls back to the default label.
- **Vitest unit** `src/components/analysing/phase-model-swap.test.tsx` — changing the dropdown dispatches `saveAccountSettings({ analyzerPhase0Model: 'gemini-3.1-flash-lite' })`; toast appears.
- **Vitest unit** `src/components/analysing/sticky-analysis-bar.test.tsx` — given `activeStream.phaseId = 1`, asserts the bar shows "Phase 1 · Parsing and attribution" and the phase-1 model name.
- **Vitest unit** `src/store/account-slice.test.ts` (extended) — `selectAnalyzerPhase0Model` returns user-settings value when set, default when null. Same for phase 1.
- **Playwright e2e** `e2e/analysing-multi-model.spec.ts`:
  1. Boot in mock mode, navigate to `#/books/<id>/analysing`, wait for Phase 0 active.
  2. Assert both phase-model chips visible with default labels.
  3. Scroll 800px down; assert the H1 `Reading <book>` is `not.toBeInViewport()` AND `[data-testid="sticky-analysis-bar"]` IS `toBeInViewport()`.
  4. Click the Pause button inside the sticky bar; assert `activeStream.state === 'paused'` via window-probe; assert button label flips to "Resume analysis".
  5. Open the Phase 0 swap dropdown, choose `gemini-3.1-flash-lite`, assert toast text "Applies from next chapter" + `account.analyzerPhase0Model === 'gemini-3.1-flash-lite'` in store.

### Manual acceptance walkthrough

Mock mode (`VITE_USE_MOCKS=true`). All steps assume a fresh import + Start clicked.

1. **Cold boot at `#/books/<bookId>/analysing`** → expected stage `{ kind: 'analysing', ... }`. Visible: book title, word-count caption, Phase 0 card with the gemma chip + swap dropdown LIT (streaming state), Phase 1 card dimmed with "Warms up after chapter 10" hint, Phase 2 card dimmed.
2. **Scroll the page down ~800px** → header (title + caption + analyst-engine pill) scrolls off. The sticky bar (Phase 0 · Detecting characters · gemma-4-31b-it · streaming + Pause button) pins under the 64px topbar with a soft backdrop blur.
3. **Click Pause from the sticky bar** → button label flips to "Resume analysis", `activeStream.state` flips to `paused`. The plan-32 top-bar pill agrees ("Paused").
4. **Open the Phase 0 swap dropdown, pick `gemini-3.1-flash-lite`** → toast "Applies from next chapter". No abort. `account.analyzerPhase0Model` updates in the slice.
5. **Wait for Phase 0 to complete, Phase 1 starts** → sticky bar updates from "Phase 0 · gemma" to "Phase 1 · gemini" automatically. Phase 0 card collapses to "Completed · N characters". Phase 1 chip lights up.

## Out of scope

- **Live RPM/TPM/RPD quota meters per model.** `server/src/analyzer/rate-limit.ts` state is module-internal; needs a new SSE event or polling endpoint. Backlog: Could.
- **Mid-chapter model swap (abort + resume on different model).** Watermark seam (plan 88) plus the warm-up gate (user-memory `feedback_warmup_window_for_model_splits.md`) make this risky. Today's swap takes effect on the NEXT chapter, not mid-chapter. Backlog: Could.
- **Cost / token-spend visualisation.** Frontend doesn't know token counts. Out of scope until quota endpoint exists.
- **Account tab redesign.** Per-phase pickers stay where they are (`src/views/account.tsx:323–406`); this plan only consumes the values.

## Ship notes

**Shipped 2026-05-22 via PR #138** (merge commit `2a0081d` on `main`). Six commits on `feat/frontend-analysing-multi-model-ui`:

1. `517a023` — docs(docs): plan 95 (originally landed as 94 — renumbered post-merge to deconflict with PR #137's plan 94, "series-prior roster dedup") + HTML mockup at `mockups/analysing-multi-model.html`
2. `8a9905a` — refactor(frontend): extract `PhaseCard` from `src/views/analysing.tsx` (behaviour-neutral, ~340 LOC moved out of the 1,769-line monolith)
3. `f9fd182` — feat(frontend): per-phase model chip + swap + new account-slice selectors
4. `0922bb7` — feat(frontend): sticky status bar on analysing scroll
5. `2abe7a5` — test(frontend): e2e spec at `e2e/analysing-multi-model.spec.ts` (4 cases) + plan flip to `active`
6. `d2906c7` — test(frontend): refresh analysing + confirm visual baselines (`e2e/win32/visual.spec.ts/{analysing,confirm}{,-dark}.png`) for the outer-flex layout shift

**Delta vs the original spec:**

- The plan recommended option (A) — extract `PhaseCard` now — and that's what shipped. The orchestrator dropped from 1,769 to ~1,400 lines; per-phase model UI lives in one obvious place.
- The plan called for the sticky bar to mount as a sibling of the centred column via a `<div className="relative w-full max-w-2xl">` wrapper. That broke `position: sticky` because the wrapper was only as tall as the bar itself — sticky elements pin within their containing block, and the wrapper had nothing to scroll within. The shipped fix drops the wrapper and adds `self-stretch` to the sticky bar so it spans the outer flex column's full width directly. Documented in commit `2abe7a5`.
- The outer container also flipped from `flex items-center justify-center` to `flex flex-col items-center` so the sticky bar can sit above the centred column on its own row. Visible diff: the pre-start "No manuscript loaded" card no longer vertically-centres; it now anchors to the top inside the `py-16` padding. Visual baselines regenerated to match (`d2906c7`).
- A new **mutual-exclusivity invariant** emerged during commit 4: when `isAnalysisRunning`, the sticky bar mounts AND the inline header Start/Resume button hides; when idle/paused, the sticky bar unmounts AND the inline button shows. No moment with duplicate Pause/Start buttons in the DOM — kept the 42 existing `analysing.test.tsx` tests' `findByRole('button', { name: /pause|start|resume/i })` selectors single-match and unchanged.

**Tests:** 18 unit cases (5 chip + 4 swap + 5 sticky + 4 e2e) added; all 42 existing `src/views/analysing.test.tsx` cases pass unchanged after registering the account slice in every store factory.

**CI / verify note:** Local pre-push verify flagged 4 visual baselines (analysing + confirm, light + dark) as drifting past the 1% `maxDiffPixelRatio` threshold when run in the full e2e battery (parallel workers), even though the same snapshots pass reliably in isolation. CI's `npm run verify` (ubuntu-latest, workers=1) passed in 8m31s with all 4 visuals green. The local-only flake is captured as a Could-bucket item in `docs/BACKLOG.md` so a future round can address it (most likely a `--workers=1` flag on the visual subset, a wider `toHaveScreenshot` tolerance, or hoisting visuals out of the pre-push battery into a separate `npm run verify:visual` step).
