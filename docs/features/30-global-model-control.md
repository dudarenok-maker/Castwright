# Global model-control affordance (deferred)

> Status: KNOWN: scaffolded (deferred — Option C from the 2026-05-15 design discussion)
> Key files (today): `src/views/generation.tsx` (TTS pill), `src/views/analysing.tsx` (analyzer pill), `src/lib/play-sample-with-auto-load.ts` (JIT auto-load helper)
> Key files (future): `src/components/layout.tsx` (top bar), `src/store/ui-slice.ts` (model lifecycle state)

## Motivation

Today the `ModelControlPill` (Load / Stop) lives in two view-local spots: the
Analysing view (analyzer pill) and the Generation view (TTS pill). Surfaces
that *use* the models but don't render a pill — the Profile Drawer's Play
button, the Cast view per-row Play, the future per-character regenerate
button — currently rely on JIT auto-load (`playSampleWithAutoLoad`) to warm
the TTS sidecar on demand.

That works for one-off sample previews. But as more surfaces grow a "I need
TTS now" affordance, two failure modes get louder:

1. **Discoverability** — a user who clicks Play and waits 30 s for the
   model to load doesn't realise the next click will be fast unless they
   navigate to Generation and notice the green "ready" pill there.
2. **No global state** — every surface ends up re-implementing the
   "should I show a load banner?" question locally. The Cast view already
   has `evictionBanner`, the Drawer has its own copy, and the Generation
   view has yet another. Diverges over time.

The fix is to hoist a single TTS pill into the top bar (`layout.tsx`) so
it's visible from Confirm Cast / Cast / Drawer / Generation. The JIT
auto-load helper stays — surfaces that need TTS *right now* still trigger
the load themselves — but the pill provides the always-on visual state
and a single Load/Stop the user can use proactively.

## When to pick this up

Build this when the **third** non-Generation surface needs JIT TTS warm.
Today: Profile Drawer Play, Cast row Play. Likely next: per-character
"regenerate this voice across the book" button (`profile-drawer.tsx`
`onRegenerateCharacter`). Once that lands, the friction case is concrete
enough to justify the top-bar surface.

## Invariants to preserve when implementing

- **Lifecycle stays user-driven.** The server never auto-loads or
  auto-evicts on its own — every transition traces back to a user click
  on either the global pill or an in-context surface (Play, Regenerate).
  CLAUDE.md's "model lifecycle is button-driven" rule is non-negotiable.
- **Single source of truth for state.** Move the `ttsPillState` derivation
  from `generation.tsx:226-233` into a shared selector (likely
  `src/store/ui-slice.ts` or a thin module that consumes `getSidecarHealth`
  via a polling hook). Generation view's existing pill consumes the same
  selector; the new top-bar pill is just another reader.
- **JIT path still works.** `playSampleWithAutoLoad` keeps its
  prep-then-synth shape so surfaces that fire without a pill click
  (drawer Play before user notices the bar) still self-heal. The top-bar
  pill is additive UX, not a precondition.
- **Auto-evict banner consolidates.** Today the banner copy is
  duplicated across `generation.tsx` `evictionNotice`, drawer
  `evictionBanner`, and cast `evictionBanner`. When the top-bar pill
  lands, the banner moves up with it and the per-surface banners come
  out. One global toast instead of three local ones.
- **Mobile / narrow viewports.** The top bar already houses the Books /
  Library / Account nav; the pill has to slot in without breaking the
  layout. Stash it under a "model status" menu icon if the bar is
  cramped.

## Acceptance walkthrough (when implemented)

1. **Fresh load, no model resident** → top-bar pill reads "TTS idle". Open
   any character drawer → Play 12s sample → pill flips to "Loading TTS…"
   → "TTS ready" → sample plays. No banner in the drawer (the pill state
   change *is* the feedback).
2. **Model ready, analyzer loaded** → click pill Load on a fresh session
   from the Books view: the unified eviction copy fires from the top bar,
   not the local view.
3. **Across-view persistence**: load TTS from the top bar on Cast →
   navigate to Generation → its existing pill reads "ready" (same
   selector, same state). No flicker.
4. **JIT still works** when the user doesn't see the pill: open drawer
   directly from a deep link, click Play → auto-load fires; once it
   completes the top-bar pill flips to "ready" too.

## Out of scope (don't smuggle into this plan)

- Mobile bottom-sheet for model status (separate UX exercise).
- A combined TTS+Analyzer pill — they're orthogonal lifecycles; keep
  two pills.
- Auto-load on app start (would violate the button-driven rule).
