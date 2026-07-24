# fe-39 — Decorative hover-feedback parity for touch (`group-active:` mirrors)

- **Issue:** #799 (`fe-39`, MoSCoW: Could, `area:fe`, `type:feature`)
- **Depends on:** `fe-5` (#402 / PR #798, shipped)
- **Date:** 2026-07-24
- **Branch / worktree:** `feat/frontend-fe-39-group-active-mirrors`

## Problem

`fe-5` added `coarse-pointer:` / `fine-pointer:` variants only to hover patterns that **hide a functional action** (regenerate button, book-options ⋯, scrubber thumb). It deliberately left **decorative hover-feedback** controls — color/background shifts on controls that are already visible — untouched. Touch users get no press-feedback equivalent on those decorative controls, so there is a small visual-parity gap versus mouse users who see a `:hover` shift.

This item closes that gap for the controls where it is actually observable, by adding a `group-active:X` variant mirroring the existing `group-hover:X`. `group-active:` fires on pointer-press, which is the touch analogue of hover.

Benefit is **cosmetic and marginal** by design — the controls are already visible and reachable; this only adds a brief press-feedback flash. Priority is Could.

## Scope decision

The issue lists 7 decorative controls. Verified against live code (line numbers re-anchored 2026-07-24), only **4** yield an observable touch benefit. The other 3 are verified no-ops and are explicitly dropped.

### In scope (4 controls — add a `group-active:` mirror)

| # | File / element | Existing | Add |
|---|----------------|----------|-----|
| 1 | `src/components/library/continue-listening-rail.tsx:111` — play badge | `bg-white/20 group-hover:bg-white/35` | `group-active:bg-white/35` |
| 2 | `src/components/library/library-grid.tsx:559` — "Add book" tile | `group-hover:bg-peach group-hover:border-peach group-hover:text-white` | `group-active:bg-peach group-active:border-peach group-active:text-white` |
| 3 | `src/components/setup/setup-wizard.tsx:459` — "Review ›" | `text-ink/40 group-hover:text-magenta` | `group-active:text-magenta` |
| 4 | `src/components/voice-library-panel.tsx:388` — drag icon | `text-ink/30 group-hover:text-ink/60` | `group-active:text-ink/60` |

### Out of scope (3 controls — verified no-ops, dropped)

- `src/views/revision-diff.tsx:551` & `:584` — play badges A/B. Tapping the badge flips `isPlayingA` / `isPlayingB`, whose truthy branch (`bg-ink text-canvas` / `bg-magenta text-white`) overrides the color entirely. A `group-active:` mirror would only flash during the sub-second pointer-hold before release toggles the state — effectively invisible. **Dropped.**
- `src/views/manuscript.tsx:2088` — boundary hit-area tint. This is a `cursor-ns-resize` drag control, not a tap target; starting a drag sets `isThisDragging`, which already applies `bg-peach/40`. A `group-active:` mirror is redundant with the existing drag-state tint. **Dropped.**

A note will be posted to #799 recording this 4-of-7 decision and the rationale before the PR merges.

## Design

### Approach

Pure Tailwind-variant addition. For each in-scope control, append a `group-active:X` variant alongside the existing `group-hover:X` for the same property. **Add-only** — no resting class is changed, removed, or reordered, and no component logic changes. No new files, no config changes.

Tailwind is **v4** (`tailwindcss ^4.3.0`, CSS-first, no `tailwind.config.js`). `group-active` is a built-in state variant in v4; no configuration is required to enable it. It is currently unused in `src/`, so this introduces the variant fresh.

### Caveat (a) — Add-book tile must not force peach at rest

Called out in the fe-5 review: the Add-book tile's full-peach appearance must **not** become the resting state. Satisfied by construction — we only add `group-active:bg-peach` / `group-active:border-peach` / `group-active:text-white`; the resting `bg-white border-ink/10 text-ink` classes are untouched. The tile stays white until pressed.

### Caveat — #4 is hidden below `md`

`voice-library-panel.tsx:388` carries `hidden md:inline`, so the drag-icon span is invisible on phones. Its `group-active:` feedback is therefore only ever observable on `md`+ touch devices (large tablets). This is expected, not a bug; documented here so a future reader does not mistake the absence of phone feedback for a regression.

## Testing

**Class-presence assertions**, added to the four existing `.test.tsx` files (one per touched component):

- `continue-listening-rail.test.tsx`
- `library-grid.test.tsx`
- `setup-wizard.test.tsx`
- `voice-library-panel.test.tsx`

Each assertion renders the component (using existing test-render helpers / providers already present in that file), queries the specific touched element, and asserts its `className` contains **both** the existing `group-hover:X` variant **and** the paired `group-active:X` variant for the same property.

For control #2 (Add-book tile) the test additionally asserts caveat (a): the resting `bg-white` class is still present and no bare (non-variant) `bg-peach` was introduced.

Rationale for this test shape: `group-active:` is a transient pointer-press state that a static visual-baseline screenshot cannot capture, and a real touch-hold Playwright test is flaky on Windows visual specs and disproportionate for a cosmetic change. A class-presence assertion is deterministic, zero-flake, and precisely guards the one failure mode that matters — a future edit silently dropping a mirror.

If a touched element cannot be uniquely queried from its existing test without new test scaffolding, add a minimal, stable query hook (e.g. an existing accessible role/name already rendered) rather than a source-text scan; the assertion must run against the rendered DOM, not the raw file.

## Verification gates

Run in the fe-39 worktree (node_modules junctioned from the main checkout):

1. `typecheck`
2. `lint`
3. The 4 updated test files
4. Full frontend test suite **only if** a shared component is implicated (none is here — all 4 edits are leaf className changes)

Then open a PR with a body that reads as mini release notes and a literal `Closes #799`.

## Out of scope / non-goals

- No changes to the 3 dropped controls.
- No new Tailwind config, no custom variant definitions.
- No change to any resting appearance, layout, or component logic.
- No refactoring of the touched components beyond the className additions and their test assertions.

## Risks

- **Near-zero user benefit** — accepted; this is cosmetic parity, explicitly Could-priority. The value is consistency/completeness of the touch-parity story started by fe-5, plus a regression guard.
- **Test brittleness** — mitigated by asserting against rendered DOM className via existing test helpers, not source text.
