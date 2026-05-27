---
status: stable
shipped: 2026-05-27
owner: null
---

# Status pill + Status modal (top-bar consolidation)

> Status: stable
> Key files: `src/components/top-bar.tsx`, `src/modals/status-modal.tsx`, `src/components/layout.tsx`, `src/store/ui-slice.ts`
> URL surface: indirect — no route; the modal is mounted in `Layout` and toggled by `ui.statusModalOpen` (see [00-stage-machine.md](00-stage-machine.md))
> OpenAPI ops: none

## Benefit / Rationale

- **User:** the top bar's status cluster used to be up to ~6 separate pills (Kokoro/Coqui/Qwen Load/Stop + a GPU-busy badge, an Analysing pill, a Generation pill, a Revisions badge). When several were live they ate the row width and shifted the nav tabs, making the menu hard to use. They now collapse into ONE compact, color-coded Status pill so the nav menu keeps its room; the full detail lives one click away in a Status modal.
- **Technical:** the dominant-state arithmetic is a single pure helper (`summarizeStatus`) that's unit-testable in isolation; the modal reuses the existing `ModelControlPill` / `AnalysisPill` / `GenerationPill` components verbatim, so there is no duplicated state machine or routing logic.
- **Architectural:** locks the rule that the top-bar middle strip carries the nav + at most one Status pill. New per-stream status surfaces land inside the Status modal, not as fresh inline pills — the bar can't regress to crowding the menu.

## Architectural impact

- **New seams:** `ui.statusModalOpen` boolean + `openStatusModal`/`closeStatusModal` reducers (mirrors the `queueModalOpen` precedent). Exported pure `summarizeStatus(StatusInput): StatusSummary` and the `StatusSummary`/`StatusTone`/`StatusInput` types from `top-bar.tsx`. New presentational `StatusModal` in `src/modals/`.
- **Reused verbatim:** `ModelControlPill` (Load/Stop wiring intact) flows into the modal as the `ttsControls` ReactNode that `Layout` already built (`ttsPillElement`). `AnalysisPill`/`GenerationPill` are now exported and rendered inside the modal with their `onClick` overridden to navigate-AND-close.
- **Invariants preserved:** the concurrent-multibook invariant (cross-book analysis/generation stays visible regardless of which book's view is active) — the Status pill is summarized in `Layout` off the same cross-book snapshots (`analysisPill`/`generationPill`) and the same per-second `forceClockTick`, so the "stalled" rung stays live. The mock toggle ([23](23-mock-toggle.md)) and discriminated-union stage ([00](00-stage-machine.md)) are untouched.
- **Migration story:** none — no persisted shape changes (the new `ui` field is transient, not persisted).
- **Reversibility:** revert the PR; the inline pills return. No data migration to undo.

## Invariants to preserve

1. **The top-bar middle strip renders the nav + at most one `status-pill`.** The former cluster of `{ttsPill}` + `<AnalysisPill>` + `<GenerationPill>` + revisions badge is gone (`src/components/top-bar.tsx` — the `ml-auto` slot now holds only `<StatusPill>`).
2. **The Status pill is hidden on idle global views.** `Layout` passes `statusSummary={null}` when there is no book in scope AND no analysis/generation stream AND no pending revisions, so Books/Voices/Change log with nothing running show no dead pill (matches the pre-120 empty cluster). `top-bar.tsx` renders nothing when `statusSummary === null`.
3. **Queue chip, `wt` dev link, theme toggle, and avatar stay inline and unchanged** (the right-anchored `shrink-0` cluster in `top-bar.tsx`). Only the queue chip's `data-testid="topbar-queue-chip"` flow is asserted by `e2e/queue-modal.spec.ts`, which is untouched.
4. **`ModelControlPill` Load/Stop is reused verbatim inside the modal.** The buttons keep their `aria-label`s (`stop (tts model)` / `load model (tts model)`); clicking them does NOT close the modal.
5. **`summarizeStatus` priority ladder** (highest wins): halted › stalled › generation-running › analysis-running › model-loading › analysis-paused › revisions-pending › idle. Generation outranks analysis when both run.
6. **The modal's "go to" actions navigate AND close.** `onGoToAnalysing`/`onGoToGeneration` reuse the pills' existing `onClick` routing (single-book → Generate view, multi-book → queue modal) then dispatch `closeStatusModal`; `onOpenRevisions` opens the revision player and closes the status modal so the two overlays don't stack.

## Test plan

### Automated coverage

- Vitest unit (`src/components/top-bar.test.tsx`):
  - `summarizeStatus` — one case per rung of the priority ladder + the generation-over-analysis tie-break + detail-string formatting (`55%`, count, none for idle/halted).
  - `StatusPill` (via `TopBar`) — renders the summary label/detail + `data-status-tone`, click fires `onOpenStatus`, no inline `analysis-pill`/`generation-pill`, and the pill is hidden when `statusSummary === null`.
  - `AnalysisPill`/`GenerationPill` rendered directly (they now live in the modal) — running/halted/paused/subset variants, `data-testid`, click → `onClick`.
- Vitest unit (`src/modals/status-modal.test.tsx`) — four sections render; empty fallbacks when data null/0; `ttsControls` sentinel passes through; analysis/generation pill clicks route through `onGoToAnalysing`/`onGoToGeneration`; revisions action fires `onOpenRevisions`; backdrop + close button fire `onClose`; returns null when `open={false}`.
- Vitest unit (`src/components/layout.test.tsx`) — the Qwen-pinned-cast test opens the Status modal (via the pill) and asserts the Qwen `ModelControlPill` renders inside it.
- Playwright e2e (`e2e/kokoro-stop-pill.spec.ts`) — opens the Status modal, then drives the Kokoro ready→idle→ready Load/Stop round-trip against the buttons inside it; Coqui control absent on a Kokoro-default book.
- Playwright e2e (`e2e/revision-diff.spec.ts`) — the pending-revisions action appears inside the Status modal after opening a complete book under mocks.
- Playwright e2e (`e2e/responsive/coverage.spec.ts`) — "status modal (plan 120)" opens the modal and asserts no horizontal overflow at all three viewports.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`).

1. **Cold boot at `#/`** (Books) → no Status pill in the bar (idle global view); the bar shows only nav + theme + avatar.
2. **Open Solway Bay → `#/books/sb/manuscript`** → a neutral `◷ Status` pill appears top-right (book context). The nav tabs sit left with room.
3. **Click the Status pill** → the Status modal opens (`role="dialog"`, label "Status") with four sections: TTS engines (Kokoro control with Load/Stop), Analysis, Generation, Revisions.
4. **Click Stop on the Kokoro control** → it flips to idle/Load; the modal stays open.
5. **Open a book with a pending revision** → the pill summarises `Revisions · N`; opening the modal shows "N revisions pending · Open"; clicking it opens the revision player and closes the status modal.
6. **Start a generation, navigate away** → the pill shows `⟳ Generating · NN%` (peach) from any view; if it halts it turns `⚠ Halted` (rose); clicking the pill then the generation row routes to the Generate view and closes the modal.

## Out of scope

- The generation queue chip + queue modal stay exactly as shipped in [102] / [110](110-queue-active-generation-honesty.md) — only the chip's neighbours moved.
- No change to the per-stream pill copy or the underlying sticky-analysis ([32](32-sticky-analysis.md)) / sticky-generation ([31](31-sticky-generation.md)) snapshots — the Status pill is a presentation layer over them.

## Ship notes

Shipped 2026-05-27 via PR #283 (merge commit `08ae6fb`), branch `feat/frontend-plan-119-status-pill-modal`. Collapses the top-bar TTS/analysis/generation/revisions cluster into one compact, color-coded Status pill + a Status modal; queue chip / theme / avatar unchanged; pill hidden on idle global views. Renumbered 119 → 120 in a follow-up (a parallel PR shipped a different plan 119 — `archive/119-generate-view-enqueue-gate-clear-queue.md` — concurrently); the in-code comments + this doc now read "plan 120".
