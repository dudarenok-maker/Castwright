# Global model-control affordance

> Status: stable for the global TTS pill (top-bar surface); local pills on Generation + Analysing remain alongside it. Single-poll consolidation deferred until the third surface that needs it lands.
> Key files: `src/components/layout.tsx` (top-bar pill mount), `src/lib/use-tts-lifecycle.ts` (shared hook), `src/components/top-bar.tsx` (`ttsPill` slot), `src/views/generation.tsx` (local TTS pill — still owns its own poll), `src/views/analysing.tsx` (analyzer pill — unchanged), `src/lib/play-sample-with-auto-load.ts` (JIT auto-load helper, unchanged)

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

## Shipped in v1 (2026-05-16)

A `<ModelControlPill kind="tts">` is mounted in the top bar via
`src/components/layout.tsx`, driven by a new `useTtsLifecycle()` hook in
`src/lib/use-tts-lifecycle.ts`. The hook encapsulates the same
state-machine that lives inside Generation view today: 30 s `/health`
poll, optimistic `pendingPillState` override on Load/Stop clicks,
analyzer auto-evict on Load, eviction + load-error banner state.

The pill renders only on book-context stages (`analysing` / `confirm` /
`ready`) — Books and Upload stages skip it since TTS isn't meaningful
without a manuscript.

**Two polls in flight.** v1 deliberately does NOT consolidate the
Generation view's local pill into the top-bar one. Layout's hook call
and Generation's local `sidecarHealth` state run their own 30 s polls
independently. After a Load click on either pill, the *other* pill
catches up on its next probe (worst case ~30 s lag); after a Stop click
the same. The eviction/load-error banners are NOT shared either — the
banner appears next to whichever pill was clicked. Acceptable for v1
because the user typically only clicks one pill at a time and the lag
is bounded.

## When to pick up the follow-up (consolidation)

When a third non-Generation surface needs JIT TTS warm (today: Profile
Drawer Play, Cast row Play; likely next: per-character
"regenerate this voice across the book" button — `profile-drawer.tsx`
`onRegenerateCharacter`). At that point lift `useTtsLifecycle` state into
LayoutContext / Redux so all surfaces share a single poll + banner.

## Invariants to preserve

- **Lifecycle stays user-driven.** The server never auto-loads or
  auto-evicts on its own — every transition traces back to a user click
  on either the global pill or an in-context surface (Play, Regenerate).
  CLAUDE.md's "model lifecycle is button-driven" rule is non-negotiable.
- **JIT path still works.** `playSampleWithAutoLoad` keeps its
  prep-then-synth shape so surfaces that fire without a pill click
  (drawer Play before user notices the bar) still self-heal. The top-bar
  pill is additive UX, not a precondition.
- **Mobile / narrow viewports.** The top bar already houses Books /
  Voices / Change-log / Account nav; the pill slots in alongside the
  existing generation pill + revisions chip. If width becomes a
  problem, stash it under a "model status" menu icon — but that's a
  follow-up, not a v1 concern.

## Acceptance walkthrough

1. **Fresh load, no model resident** → top-bar pill reads "TTS model
   idle" with a Load button. Click Load → pill flips to "Loading TTS
   model…" (analyzer auto-evicts in the background; banner appears if
   analyzer was actually resident) → "TTS model ready" with a Stop
   button. `api.loadSidecar` was called.
2. **Stop** → pill flips back to "idle"; `api.unloadSidecar` was called;
   any eviction notice from the prior Load is cleared.
3. **Navigation persistence (v1 caveat)**: load TTS from the top-bar
   pill while on Cast → navigate to Generation. Both pills are visible.
   Generation's local pill flips to "ready" within ~30 s (next poll
   tick) — NOT instantly. This is the documented v1 dual-poll behavior.
4. **JIT still works**: open Profile Drawer via deep link, click Play →
   `playSampleWithAutoLoad` fires its own warm; once complete, both
   pills flip to "ready" on their next poll. The top-bar pill is
   additive UX, not a precondition for sample playback.
5. **Stages without book context**: navigate to `/books` → top-bar pill
   disappears (no manuscript = no TTS need). Open a book → reappears.

## Out of scope (don't smuggle into a B4 follow-up)

- Mobile bottom-sheet for model status (separate UX exercise).
- A combined TTS+Analyzer pill — they're orthogonal lifecycles; keep
  two pills.
- Auto-load on app start (would violate the button-driven rule).
- Consolidating eviction banners across cast.tsx / profile-drawer.tsx —
  those surface `playSampleWithAutoLoad`'s evict flow on Sample-Play
  clicks, parallel to the pill's Load click. Separate codepath, separate
  follow-up.
