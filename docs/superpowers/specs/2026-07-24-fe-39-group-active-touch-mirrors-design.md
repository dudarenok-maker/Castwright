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

Tailwind is **v4** (`tailwindcss ^4.3.0`, CSS-first, no `tailwind.config.js`). `group-active` is a built-in state variant in v4; no configuration is required to enable it. The `active:` variant family is already in use across ~10 `src/` files (e.g. `library-grid.tsx`, `voice-library-panel.tsx`, `top-bar.tsx`, `searchable-picker.tsx`), so the variant machinery is proven to compile in this codebase; only the `group-active:` *combinator* is introduced fresh.

### Touch `:active` firing — confirmed for all four groups

`group-active:X` compiles to `.group:active .target`, so the element carrying `group` must itself enter `:active` on press. This is the load-bearing "will a touch user ever see it" question. Verified per control against source — every group container is either a native interactive element or one already proven to receive `:active`, so none depends on `:active` firing on an inert element (the iOS Safari failure mode):

| # | `group` element | Why `:active` fires on touch |
|---|-----------------|------------------------------|
| 1 | `<div class="group">` at `continue-listening-rail.tsx:83`, wrapping a native `<button type="button" onClick>` (line 84) | Pressing the native `<button>` sets `:active` on it **and its ancestors** (standard `:active` ancestor-matching — the same mechanism the existing `group-hover:` already relies on). iOS Safari applies `:active` when the activated element is natively tappable; a `<button>` qualifies. |
| 2 | `<button class="group">` at `library-grid.tsx:556` | Native button — `:active` fires directly and reliably on touch. |
| 3 | `<button class="group">` at `setup-wizard.tsx:442` | Native button — same. |
| 4 | `<div class="group … active:cursor-grabbing">` at `voice-library-panel.tsx:303` | The div **already** uses `active:cursor-grabbing`, which is proof `:active` fires on it in practice. |

Conclusion: the earlier concern that #1's plain-`<div>` group might be iOS-dead does **not** hold — its activation source is a native `<button>`, so `:active` chains to the group div exactly as `:hover` does today. No control is a shipped no-op on iOS.

### Sibling hover effects on the same group — deliberate non-goal

Each of these groups carries *additional* container-level hover effects beyond the enumerated inner span: the Add-book **outer tile** has `hover:border-peach hover:bg-peach/4` (`library-grid.tsx:556`), the rail **card button** has `hover:shadow-float hover:border-ink/20` (`continue-listening-rail.tsx:88`), and the Review **row button** has `hover:bg-ink/[0.03]` (`setup-wizard.tsx:442`). This spec **intentionally mirrors only the enumerated inner-span controls** from #799, not these sibling effects, because: (i) the issue enumerated the inner spans specifically; (ii) the sibling effects are lower-visibility (a shadow shift, a 3–4% background tint); and (iii) "mirror every `hover:` in the tree" is unbounded scope for a Could-priority cosmetic item. If fuller per-control parity is later wanted, the Add-book **outer tile** (`library-grid.tsx:556`) is the highest-value first addition and would be captured as a separate micro-follow-up — not folded into fe-39.

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

**Known limit of this test (explicit):** these components render under jsdom, where Tailwind is not compiled, so the assertion is a `className`-string presence check — it proves the `group-active:X` token is emitted onto the correct element, **not** that the variant compiles to CSS or fires on press. That behavioral correctness is instead established **once, manually, at implementation** (see Verification gates) rather than by an ongoing automated test, because the fire-on-touch mechanism is already confirmed by construction (all four groups are native-interactive or already use `:active` — see "Touch `:active` firing" above). The string check is the regression guard; the manual smoke-check is the one-time behavioral proof.

The existing `continue-listening-rail.test.tsx` already uses `@testing-library/react` `render` + `screen.getByRole('button', { name: … })` + `container`, which is sufficient to reach each touched element. Where the touched element is a role-less/text-less `<span>` (the #1 play badge, the #4 drag icon), query it via its parent's accessible role/name (or the existing `container`) and assert on the child's `className` — against the rendered DOM, never a raw-file source scan.

## Verification gates

Run in the fe-39 worktree (node_modules junctioned from the main checkout):

1. `typecheck`
2. `lint`
3. The 4 updated test files
4. Full frontend test suite **only if** a shared component is implicated (none is here — all 4 edits are leaf className changes)
5. **One-time manual touch smoke-check** (behavioral proof the string test can't give): in the running app with Chrome DevTools device/touch emulation on (which activates the `coarse-pointer` variant and `:active` on tap), confirm the press-flash on at least controls #1 (rail play badge) and #2 (Add-book tile). Real iOS Safari is best-effort/not automatable, but the mechanism is confirmed native (all four groups above), so DevTools touch emulation is accepted as sufficient evidence.

Then open a PR with a body that reads as mini release notes and a literal `Closes #799`.

## Out of scope / non-goals

- No changes to the 3 dropped controls.
- No mirroring of sibling container-level hover effects on the touched groups (outer Add-book tile tint, rail card shadow, Review row bg) — deliberate non-goal, see Design.
- No new Tailwind config, no custom variant definitions.
- No change to any resting appearance, layout, or component logic.
- No refactoring of the touched components beyond the className additions and their test assertions.

## Risks

- **Near-zero user benefit** — accepted; this is cosmetic parity, explicitly Could-priority. The value is consistency/completeness of the touch-parity story started by fe-5, plus a regression guard.
- **`:active` not firing on touch** — investigated and resolved: all four group containers are native-interactive (`<button>`) or already use `:active`, so the mirror fires by the same mechanism as the existing `group-hover:`. iOS Safari's inert-element `:active` restriction does not apply to any of them. Confirmed at the source level; final behavioral confirmation is the one-time manual smoke-check.
- **Test is spelling-level, not behavioral** — accepted and explicit: jsdom doesn't compile Tailwind, so the automated test guards against a dropped token; the manual smoke-check covers fire-on-press once.
- **Test brittleness** — mitigated by asserting against rendered DOM className via existing test helpers, not source text.
