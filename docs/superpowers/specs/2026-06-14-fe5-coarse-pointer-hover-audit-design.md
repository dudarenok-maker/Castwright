# fe-5 — Coarse-pointer hover-affordance audit

**Issue:** [#402](https://github.com/dudarenok-maker/AudioBook-Generator/issues/402) ·
**Backlog ID:** `fe-5` · **MoSCoW:** Should · **Date:** 2026-06-14

## Problem

Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (`@media (pointer: coarse)`,
`src/styles.css:53`) so touch devices — which can't hover — still get hover-revealed
affordances. Its first and only broad consumer is the manuscript boundary-handle label.
fe-5 sweeps `src/` for the remaining hover patterns and applies the variant **where the
hover hides a functional action**, so touch users can reach every action a mouse user can.

Per the issue's own scope line, this is explicitly limited to *action-revealing* hover
patterns — **purely decorative** hover states (color/bg feedback shifts on already-visible
controls) are out of scope and left untouched.

## Audit result

A full sweep of `group-hover:` / `peer-hover:` / `hover:opacity-0` (and the adjacent
`group-hover:visible|flex|block`, `[@media(hover:none)]`, `sm:`-proxy reveal idioms)
across `src/**/*.tsx` found **13** matches, classified as:

### Reveals — an action is hidden (IN SCOPE, 3 controls)

| File:line | Control | Current | Fix |
|---|---|---|---|
| `src/views/generation.tsx:1796` | Per-character "Regenerate in this chapter" button | `sm:opacity-0 sm:group-hover:opacity-100` + `sm:min-w-0 sm:min-h-0 sm:w-7 sm:h-7` | `fine-pointer:`-gated hide (see below) |
| `src/components/library/library-grid.tsx:250` | Book-options ⋯ menu trigger | `opacity-0 group-hover:opacity-100 focus:opacity-100` | `+ coarse-pointer:opacity-100` |
| `src/components/mini-player.tsx:671` | Scrubber thumb (visual position dot, `pointer-events-none`) | `opacity-0 group-hover:opacity-100` | `+ coarse-pointer:opacity-100` |

### Decorative feedback — already visible, hover only shifts color/bg (OUT OF SCOPE, 7 controls)

Left untouched per the issue's "not purely decorative" line. On touch these controls are
already visible and tappable; hover is transient pointing feedback (`:active` is the only
real touch equivalent, and it lasts only for the press — near-zero observable benefit on an
already-visible control). Listed so the audit is auditable, not so they change:

- `src/views/revision-diff.tsx:551` — A-side play badge `group-hover:text-ink`
  (a touch `group-active:` mirror would be **masked** anyway: tapping flips `isPlayingA`,
  which sets `bg-ink text-canvas` and overrides the hover color).
- `src/views/revision-diff.tsx:584` — B-side play badge `group-hover:text-magenta` (same masking).
- `src/components/library/library-grid.tsx:537` — "Add book" tile
  `group-hover:bg-peach group-hover:border-peach group-hover:text-white` (forcing this on
  at rest would make the tile look permanently pressed — the reason literal parity was rejected).
- `src/components/library/continue-listening-rail.tsx:111` — play badge `group-hover:bg-white/35`.
- `src/components/setup/setup-wizard.tsx:338` — "Review ›" label `group-hover:text-magenta`.
- `src/components/voice-library-panel.tsx:348` — drag icon `group-hover:text-ink/60`
  (also `hidden md:inline`, and the documented touch alternative is the tap "Assign" pill).
- `src/views/manuscript.tsx:1359` — boundary hit-area tint `group-hover:bg-peach/40`
  (redundant on touch: a drag already sets `isThisDragging` → `bg-peach/40`).

### Already handled — keep their existing fallback (3 controls)

- `src/views/manuscript.tsx:1368` — boundary label `coarse-pointer:opacity-60`.
- `src/components/library/continue-listening-rail.tsx:145` — dismiss button `coarse-pointer:opacity-70`.
- `src/components/listen/listen-header.tsx:126` — change-cover button `[@media(hover:none)]:opacity-100`.

## Design

### Two mechanisms, by hazard

The reveals split by whether the hide competes with another media-query variant:

1. **`library-grid.tsx:250` and `mini-player.tsx:671`** hide via plain unprefixed
   `opacity-0`. A plain unprefixed utility sorts *before* any variant in Tailwind's
   generated CSS, so an additive `coarse-pointer:opacity-100` deterministically wins on
   touch. **Fix:** append `coarse-pointer:opacity-100`.

2. **`generation.tsx:1796`** hides via `sm:opacity-0` — a width-breakpoint variant. Adding
   `coarse-pointer:opacity-100` would pit two **equal-specificity** variants against each
   other on a tablet (both `@media (min-width: 640px)` and `@media (pointer: coarse)` match),
   where CSS source order decides the winner. In **Tailwind v4** the sort position of a
   `@custom-variant` media variant relative to the built-in `sm` breakpoint is not
   guaranteed to favor the override — if `sm:opacity-0` emits later, the button stays hidden
   on tablets and the fix is **inert**.

   **Fix:** stop using `sm:` as a "not-touch" proxy. Gate the hide on `fine-pointer:`
   (mouse) instead — `fine-pointer` and `coarse-pointer` are **mutually-exclusive** media
   queries, so there is no specificity race:

   - Base (all devices): `opacity-100`, full `min-w-[44px] min-h-[44px]` touch target.
   - Mouse only: `fine-pointer:opacity-0 fine-pointer:group-hover:opacity-100`, plus the
     compact `fine-pointer:w-7 fine-pointer:h-7` (and drop the `min-w`/`min-h` at fine
     pointer) so desktop keeps the 28px hover-revealed swatch.

   This delivers the reveal **and** keeps the WCAG 2.5.5 44px touch target on tablets (the
   old `sm:` shrink dropped it to 28px), with no ordering hazard. The exact compact-sizing
   class set is an implementation detail for the plan to settle against the rendered output.

   **Accepted behavior delta:** a narrow desktop window (<640px, fine pointer) now
   hides-until-hover instead of always-showing. Acceptable — hover still reveals it, and it
   makes mouse behavior consistent regardless of window width.

   Replace the now-inaccurate "stays visible on touch" code comment with one describing the
   `fine-pointer:` gating.

### Out of scope (named so they aren't silently dropped)

- The 7 decorative feedback controls above (issue says skip decorative).
- Standardizing the three different touch conventions already in the tree
  (`coarse-pointer:` vs `[@media(hover:none)]:` vs the `sm:` proxy) — only the `sm:` proxy
  on the one in-scope reveal is migrated; listen-header's `hover:none` is left alone.
- `focus:` vs `focus-visible:` inconsistency on the reveal triggers — pre-existing, unrelated.

## Testing

Per the project's testing discipline (UI behaviour crossing layout/pointer seams should land
an e2e; every change ships paired automated coverage):

### E2E — real coarse-pointer emulation (`e2e/responsive/`, mobile + tablet projects)

The existing `mobile-chrome` (Pixel 7) and `tablet-chrome` (iPad Pro 11) projects report
`pointer: coarse`. Add a spec asserting the **book-options ⋯** button
(`library-grid.tsx:250`) is **visible/tappable without any hover** on the books view — the
cleanly-reachable proof that the `coarse-pointer:` mechanism works end-to-end. Runs in the
opt-in `test:e2e:mobile` tier (the pre-push chromium battery is fine-pointer, where a
coarse assertion would correctly *not* apply).

### Unit — Vitest + RTL className guard (pre-commit tier)

Render-level assertions, fast, runs in `verify:fast`:

- `generation.tsx` Regenerate button carries base `opacity-100`, the `fine-pointer:` hide,
  and retains a 44px touch target (no unconditional `sm:` shrink).
- `library-grid.tsx` options ⋯ and `mini-player.tsx` thumb each carry `coarse-pointer:opacity-100`.

These are deletion-guards (they assert the class strings, not real media-query rendering —
jsdom cannot evaluate `@media (pointer: coarse)` against Tailwind). Valued as regression
protection against accidental removal in future refactors, not as behavior proof; the e2e
covers behavior.

### Regenerate e2e — conditional

A coarse-pointer e2e directly on the Regenerate button requires a generation-in-progress
state with per-character chapter rows at a tablet viewport. The plan must first confirm this
state is cheaply reachable in mock mode; if it is, add the assertion, otherwise the unit
className guard above is the coverage for that control. Flagged rather than promised.

## Delivery

- **Branch:** `feat/frontend-fe5-coarse-pointer-reveals` (off `main`).
- **Closes** #402. Remove the `fe-5` row from `docs/BACKLOG.md` in the same PR.
- No regression-plan doc under `docs/features/` — this is a small, localized audit; the
  issue body + this spec + paired tests are the record. (`docs/features/archive/81-mobile-tablet-support.md`
  remains the home of the `coarse-pointer:` variant rationale.)
- Run `npm run verify` before marking done.
