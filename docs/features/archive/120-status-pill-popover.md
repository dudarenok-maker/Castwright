---
status: stable
shipped: 2026-05-27
owner: null
---

# Status pill + hover popover (top-bar consolidation)

> Status: stable
> Key files: `src/components/top-bar.tsx`, `src/components/status-popover.tsx`, `src/components/layout.tsx`, `src/modals/profile-drawer.tsx`
> URL surface: indirect — no route; the popover is rendered (portaled) by the top-bar `StatusPill` and driven by local hover/focus/click state (no redux flag)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** the top bar's status cluster used to be up to ~6 separate pills (Kokoro/Coqui/Qwen Load/Stop + a GPU-busy badge, an Analysing pill, a Generation pill, a Revisions badge). When several were live they ate the row width and shifted the nav tabs, making the menu hard to use. They collapse into ONE compact, color-coded Status pill so the nav keeps its room; the full detail reveals on **hover** (or tap on touch, or focus via keyboard) in an anchored popover — no extra click, no modal.
- **Technical:** the dominant-state arithmetic is a single pure helper (`summarizeStatus`) that's unit-testable in isolation; the popover reuses the existing `ModelControlPill` / `AnalysisPill` / `GenerationPill` components verbatim, so there is no duplicated state machine or routing logic. Open state is local to the pill (not redux) since it's high-frequency hover state.
- **Architectural:** locks the rule that the top-bar middle strip carries the nav + at most one Status pill; per-stream status surfaces land inside the popover, not as fresh inline pills. The popover is portaled with NO backdrop, so it never dismisses or obscures an open cast drawer.

## History

Plan 120 first shipped (PR #283) as a click-opened **centered modal**. Real use surfaced two problems: (1) reaching the model controls took a deliberate click, and (2) with the per-character **cast drawer** (`ProfileDrawer`) open, clicking the Status pill *closed the drawer* — the drawer's full-screen backdrop was painted over the top bar, so the pill click hit the backdrop's `onClose`. The follow-up (this doc's current state) replaced the modal with a hover/tap popover and made the drawer tuck under the top bar.

## Architectural impact

- **New seams:** exported pure `summarizeStatus(StatusInput): StatusSummary` + the `StatusSummary`/`StatusTone`/`StatusInput`/`StatusDetail` types from `top-bar.tsx`. New presentational `StatusPopover` in `src/components/status-popover.tsx` (portaled, anchored, no backdrop). The `StatusPill` owns a local open-state machine (hover-bridge + focus + click-pin); there is **no** redux `statusModalOpen` flag.
- **Reused verbatim:** `ModelControlPill` (Load/Stop wiring intact) flows into the popover as the `ttsControls` ReactNode that `Layout` builds (`ttsPillElement`). `AnalysisPill`/`GenerationPill` are exported and rendered inside the popover with their `onClick` overridden to navigate-and-close.
- **Cast-drawer coexistence:** `ProfileDrawer`'s backdrop + `<aside>` start at `top-16` (below the 64px header) so the drawer no longer covers the top bar — the Status pill stays hoverable/clickable while the drawer is open. (Cross-links plan 10 profile-drawer.)
- **Invariants preserved:** the concurrent-multibook invariant — the Status pill + popover detail are computed in `Layout` off the same cross-book snapshots and the same per-second `forceClockTick`. Mock toggle ([23](23-mock-toggle.md)) and discriminated-union stage ([00](00-stage-machine.md)) untouched.
- **Reversibility:** revert the PR. No data migration (open state was never persisted).

## Invariants to preserve

1. **The top-bar middle strip renders the nav + at most one `status-pill`.** The `ml-auto` slot holds only `<StatusPill>`; hidden when `statusSummary === null` (idle global views — Books/Voices/Change log with no book and no cross-book activity).
2. **The popover has NO dimming backdrop and is portaled to `document.body`** (escapes the top bar's `overflow-x-auto`). It must never obscure or dismiss an open cast drawer.
3. **Clicks inside the popover do NOT close the cast drawer.** Guards: (a) the popover is a separate portaled subtree painted `z-50` above the drawer's `z-40` backdrop, so a Load/Stop click is captured by the popover and never reaches the backdrop's `onClick`; (b) the popover root stops `mousedown`/`click` propagation so no document-level dismiss listener fires; (c) `ProfileDrawer` dismisses only via its backdrop element + close button (no document-level outside-click listener). Locked by `e2e/status-popover-cast-drawer.spec.ts`.
4. **The drawer tucks under the top bar** (`profile-drawer.tsx` backdrop + aside at `top-16`), keeping the whole top bar interactive while the drawer is open.
5. **Open-state machine** (local to `StatusPill`): `open = hoverOpen || focusOpen || stickyOpen` — hover (pointer over pill OR panel, with a ~140 ms close grace = the hover-bridge), focus-within (keyboard), and click/tap-to-pin (cleared by outside-click / Escape). `ModelControlPill` Load/Stop keep their `aria-label`s (`stop (tts model)` / `load model (tts model)`).
6. **`summarizeStatus` priority ladder** (highest wins): halted › stalled › generation-running › analysis-running › model-loading › analysis-paused › revisions-pending › idle. Generation outranks analysis when both run.
7. **Queue chip, `wt` dev link, theme toggle, avatar stay inline and unchanged** (right-anchored `shrink-0` cluster).

## Test plan

### Automated coverage

- Vitest unit (`src/components/top-bar.test.tsx`): `summarizeStatus` priority-ladder cases; `StatusPill` reveals the popover on hover (pointer enter) and on click/tap (sticky, `aria-expanded` flips); pill hidden when `statusSummary === null`; `AnalysisPill`/`GenerationPill` direct rendering.
- Vitest unit (`src/components/status-popover.test.tsx`): four sections + empty fallbacks; `ttsControls` pass-through; analysis/generation pill clicks route through `onGoToAnalysing`/`onGoToGeneration`; revisions action fires `onOpenRevisions`; hover-bridge `onPointerEnter`; **mousedown propagation is stopped** (the cast-drawer guard); returns null when `open={false}`.
- Vitest unit (`src/components/layout.test.tsx`): the Qwen-pinned-cast test opens the popover (clicking the pill pins it) and asserts the Qwen `ModelControlPill` inside it.
- Playwright e2e (`e2e/status-popover-cast-drawer.spec.ts`) — **the must-pass**: open the cast drawer → open the Status popover → click Stop inside → assert the drawer AND the popover stay open (and the control flips to Load).
- Playwright e2e (`e2e/kokoro-stop-pill.spec.ts`) — opens the popover, drives the Kokoro ready→idle→ready Load/Stop round-trip inside it; Coqui control absent on a Kokoro-default book.
- Playwright e2e (`e2e/revision-diff.spec.ts`) — the pending-revisions action appears inside the popover after opening a complete book under mocks.
- Playwright e2e (`e2e/responsive/coverage.spec.ts`) — "status popover" opens the popover and asserts no horizontal overflow at all three viewports.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`).

1. **Cold boot at `#/`** (Books) → no Status pill (idle global view).
2. **Open Solway Bay → `#/books/sb/cast`** → a neutral `◷ Status` pill appears top-right; the nav tabs sit left with room.
3. **Hover the pill** → the popover reveals (TTS engines / Analysis / Generation / Revisions); move into it and click — it stays open (hover-bridge). On touch, tap the pill to pin it; tap outside to close. Keyboard: focus the pill to peek, Escape to close.
4. **Open a character's cast drawer, then hover/open the Status pill** → the drawer stays open; click Stop/Load inside the popover → it acts AND both the drawer and popover stay open.
5. **Pending revision** → the pill summarises `Revisions · N`; the popover shows "N revisions pending · Open" → opens the revision player.
6. **Generation running** → the pill shows `⟳ Generating · NN%`; halts → `⚠ Halted` (rose). The popover's generation row routes to the Generate view.

## Out of scope

- The generation queue chip + queue modal stay as shipped in [102] / [110](110-queue-active-generation-honesty.md) — only the chip's neighbours moved.
- No change to the per-stream pill copy or the underlying sticky-analysis ([32](32-sticky-analysis.md)) / sticky-generation ([31](31-sticky-generation.md)) snapshots.
- Deep keyboard interaction with the portaled popover's controls (tab-into-portal focus management) is minimal — focus opens a peek + Escape closes; the controls remain reachable from the Generate view too.

## Ship notes

Initial modal shipped 2026-05-27 via PR #283 (merge commit `08ae6fb`); renumbered 119 → 120 (parallel-PR collision). The hover-popover follow-up (this doc's current state) replaced the click-modal with a portaled hover/tap popover, removed the redux `statusModalOpen` flag, and tucked the cast drawer under the top bar (`profile-drawer.tsx` `top-16`) so model controls are usable from within the drawer without dismissing it. Shipped 2026-05-27 on branch `feat/frontend-status-pill-hover-popover`.
