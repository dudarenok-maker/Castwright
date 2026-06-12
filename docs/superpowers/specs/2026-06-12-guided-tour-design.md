# Guided tour — in-app, spotlight product tour for new users

> **Status:** design (awaiting review) · **Date:** 2026-06-12 · **Supersedes/folds in:** `fe-28` ([#472](https://github.com/dudarenok-maker/Castwright/issues/472))
> **Owes at implementation:** a new "Guided product tour" backlog issue + a `docs/features/NN-*.md` regression plan (plans reach 210 → next free is **211**).

## Summary

An in-app, **WalkMe-style guided product tour** that teaches a brand-new user how to use Castwright by walking them, screen by screen, through the real app — riding the bundled canonical sample book (**The Coalfall Commission**, `fs-22`). Each step is a **spotlight coachmark**: the screen dims, a lit cutout highlights one real control, and a coach bubble explains it with Back/Next/Skip.

The tour **teaches on real screens; the user does the doing.** It never auto-runs the slow/expensive flows (analysis ≈ minutes, voice design ≈ GPU-bound, generation ≈ long) — it spotlights their entry controls and explains them. The sample book ships finished (analyzed + Qwen-designed cast + **pre-rendered chapter 1 on the full cast**), so every screen the tour lands on is genuinely populated, and the finale is **real playback** of chapter 1.

This reframes `fe-28` (a "small dismissible first-run checklist", sized S) into a substantially larger feature. The old checklist is superseded; the empty-library CTA is repurposed as the tour's entry point.

## Decisions locked in brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Relationship to the app | **Coachmarks on the real UI; tour teaches, user acts** | "Teach me each screen", not a demo reel or a sandbox. |
| Heavy flows (analysis / design / generate) | **Explained & pointed at, not auto-run** | A first-run tour can't make a user wait minutes / hold a GPU. |
| Coachmark style | **Spotlight** — dim screen + lit cutout + floating coach bubble | Maximum focus; impossible to miss on a first run. |
| Structure | **Per-screen mini-tours as building blocks; linear first-run tour chains them** | One registry feeds both the guided journey *and* on-demand "show me this screen". |
| Sample-book state | **Finished sample + bundle one pre-rendered chapter 1 (full Qwen cast)** | Every screen is real & populated; the Listen finale is actual audio. Transient *Analysing* is explained from outside, never faked. |
| Launch & re-entry | **Invited from the empty library, fused with "try a sample"**; replay from Help + top-bar `?`; per-screen `?` runs that screen's mini-tour; persisted "completed" flag | Discoverable for non-technical deployers without forcing a takeover; never re-nags. |
| Scope | **New feature**, supersedes `fe-28` | Owes its own issue + regression plan. |

## Architecture & components

Five pieces. Only piece (2) touches existing view components, and that change is purely additive (`data-tour-id` attributes).

### 1. Tour-step registry — the single source of truth
`src/data/tour-steps.ts`. A declarative, ordered list grouped by screen. Each step:

```ts
type TourStep = {
  id: string;                 // 's7-drawer'
  screen: TourScreen;         // 'library' | 'manuscript' | 'cast' | 'generate' | 'listen'
  anchor: string | null;      // data-tour-id of the target; null = centered (welcome/finish)
  title: string;
  body: string;
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  kind: 'real' | 'explain';   // 'explain' = heavy flow we point at but never trigger
  opensDrawer?: boolean;      // step that requires a transient surface (cast drawer) to be open
};
```

- A screen's **mini-tour** = `steps.filter(s => s.screen === X)`.
- The **linear first-run tour** = the whole registry in declared order.
- Copy lives here (brand voice), so it's reviewable/translatable in one place and the overlay stays dumb.

### 2. `data-tour-id` anchors (the only edit to existing views)
Stable attributes on the real elements the tour points at — decoupled from brittle CSS selectors, survive responsive reflow. Inventory:

| `data-tour-id` | Lives in | Step |
|---|---|---|
| `book-card` | `src/components/library/library-grid.tsx` (sample book's card) | s2 |
| `new-book-btn` | library chrome / top bar | s3 |
| `manuscript-line` | `src/views/manuscript.tsx` (a tagged quote line) | s4 |
| `chapter-boundary` | `src/views/manuscript.tsx` (boundary handle) | s5 |
| `cast-roster` | `src/views/cast.tsx` | s6 |
| `profile-drawer` | `src/modals/profile-drawer.tsx` | s7 |
| `design-full-cast-btn` | `src/views/cast.tsx` | s8 |
| `generate-btn` | `src/views/generation.tsx` | s9 |
| `chapter-1-play` | `src/components/listen/listen-player-region.tsx` (ch.1 row) | s10 |
| `companion-app-banner` | `src/components/listen/companion-app-banner.tsx` | s11 |
| `export-btn` | `src/components/listen/listen-download-section.tsx` | s12 |

### 3. Tour slice + navigation driving
`src/store/tour-slice.ts`, RTK + Immer. Runtime state: `{ active: boolean; mode: 'linear' | 'screen'; tourId: string | null; stepIndex: number; completedAt: string | null }`.

- **The engine drives real navigation.** When `next()` lands on a step whose `screen` differs from the current `ui.stage`, the slice (via a small middleware or thunk) dispatches the corresponding **real stage change** — navigating the sample book to its `cast` / `manuscript` / `generate` / `listen` view, or for `opensDrawer` steps, opening the profile drawer (`openProfileId`) — *before* the overlay measures the anchor. Every spotlight thus lands on a genuine screen.
- **Persistence:** `completedAt` written to `localStorage` (pure-frontend, matching `fe-28`'s intent). Presence suppresses the empty-library invitation and any auto-offer; the tour stays replayable on demand.
- **Sample provisioning:** starting the linear tour from the empty library first ensures the canonical book is present (reuses `fs-22`'s "try a sample" provisioning), then begins at step 1.

### 4. `<TourOverlay/>` — the spotlight renderer
`src/components/tour/tour-overlay.tsx`. Mounted once at the app root (sibling to the stage views), renders only when `tour.active`.

- Resolves `document.querySelector('[data-tour-id="…"]')`, measures its rect, draws a full-screen scrim with a lit cutout (CSS `box-shadow: 0 0 0 9999px` ring on a positioned highlight box, matching the approved mock), and positions the coach bubble (title · body · step dots · Back / Next / Skip).
- **Re-measures** on `scroll`, `resize`, and stage settle (anchored element can move as views mount). Respects `prefers-reduced-motion` (no smooth-scroll), mirroring `help.tsx`/`mini-player.tsx`.
- **Anchor-missing fallback:** if the target isn't in the DOM within a short retry window (wrong breakpoint, not yet mounted), the step degrades to a **centered bubble** with the same copy rather than crashing or pointing at nothing.

### 5. Entry points & re-entry
- **Empty library:** the existing `EmptyLibrary` CTA (`library-empty-states.tsx`) gains a primary **"Take the guided tour"** action that provisions the sample and starts the linear tour. The current "Import your first book" / "or try a sample book" remain as secondary paths.
- **Top-bar `?`** (`top-bar.tsx`, currently a direct Help link): becomes a tiny menu — **Help · Take the tour · Show me this screen** (the last runs the current screen's mini-tour in `mode: 'screen'`).
- **Help view** (`help.tsx`) gains a **"Take the tour"** button at the top of its Getting-started section, complementing (not duplicating) the static six-step text.

## fs-22 coupling — the bundled sample

The canonical book must ship **finished** so the tour rides real screens:
- manuscript + `cast.json` with **Qwen-designed voices** for the full cast (already the `fs-22` plan), **plus**
- **pre-rendered chapter 1** audio rendered with the full Qwen cast (new requirement on the `fs-22` bundle), so the Listen step is real playback.

This adds one short chapter of audio to the release artifact. The tour's "Take the guided tour" action provisions this finished book into the workspace; `localStorage.completedAt` is independent of the book's presence (a user can delete the sample without re-triggering the tour, and replay still re-provisions if needed).

## The step map (13 steps · 5 stations)

Ordered to follow the app's own tabs (Manuscript → Cast → Generate → Listen) so the spotlight moves left-to-right. `real` = lands on a populated screen; `explain` = pointed at, never run.

**1 · Library** (`books`)
- s1 `welcome` (centered, real) — "Turn any book into a full-cast performance. We've loaded a sample — *The Coalfall Commission*."
- s2 `book-card` (real) — "Every book lives here. Open the sample to look inside."
- s3 `new-book-btn` (explain) — "To add YOUR book, click New book and drop a manuscript — Castwright reads it and finds the cast (a few minutes). The sample's already read."

**2 · Manuscript** (`manuscript`)
- s4 `manuscript-line` (real) — "The whole book, line by line, colour-coded by speaker. Tap a line to reassign the speaker if the analyzer guessed wrong, or set a quote's emotion."
- s5 `chapter-boundary` (real) — "Adjust where chapters begin and end, and merge or split paragraphs — drag the boundary handle (touch works too)."

**3 · Cast & voices** (`cast`)
- s6 `cast-roster` (real) — "Narrator, Master Oduvan, Wren, Maerin… Merge duplicates and link characters from earlier books in a series."
- s7 `profile-drawer` (real, opensDrawer) — "Click a character to open their drawer: read their profile and lines, **design a voice from a description**, preview it, swap from the catalogue, and add emotion variants. This is where a character gets their sound."
- s8 `design-full-cast-btn` (explain) — "Or design the whole roster in one pass."

**4 · Generate** (`generate`)
- s9 `generate-btn` (explain) — "With the cast set, Generate renders every chapter in the right voices. Takes a while — it keeps going without you. The sample's chapter 1 is already done."

**5 · Listen, pair & export** (`listen`)
- s10 `chapter-1-play` (real) — "Here's the finished chapter 1 — the full cast, on Qwen voices. Press play."
- s11 `companion-app-banner` (real) — "Take it off the desk: pair the **Castwright Companion** app with a quick QR scan and your library follows you to your phone."
- s12 `export-btn` (real) — "Prefer your own app? Export the audiobook and drop it into any player. Nothing locks you in."
- s13 `finish` (centered, real) — "That's the whole journey. Add your own book whenever you're ready." → sets `completedAt`.

Per-screen mini-tours: the Manuscript `?` replays s4–s5; the Cast `?` replays s6–s8; etc.

## Edge cases & responsive

- **Anchor missing / not yet mounted** → short retry, then centered-bubble fallback with the same copy. Never crash, never point at empty space.
- **User navigates away / clicks outside the bubble mid-tour** → tour pauses with a small "Resume tour / End" affordance rather than fighting the user; `Esc` ends it.
- **Drawer steps** (`opensDrawer`) → engine opens the profile drawer before measuring; `back()` from a drawer step closes it and returns to the prior anchor.
- **Responsive** (per the mobile testing protocol): spotlight + bubble reflow; on `<640px` the coach bubble docks to the bottom (the scrim already separates it from content), and anchors that are hidden at a breakpoint use the centered fallback. All controls keep `min-h-[44px]` touch targets.
- **Reduced motion** → no smooth-scroll / transitions.
- **Sample already present** (replay) → don't re-provision destructively; just start the tour against the existing book.
- **Cross-tab** (`BroadcastChannel`, plan 63) → the tour is device/tab-local; it does not broadcast, so a second tab isn't dragged through the spotlight.

## Out of scope (v1)

- Auto-running any heavy flow (analysis / design / generation) from inside the tour.
- Stage **re-entry** for the *Analysing* screen — it's explained from outside, not replayed live.
- Tours for secondary surfaces (Account, Admin, Model Manager, Advanced, Voices library). The registry makes adding them later trivial, but v1 covers the core pipeline only.
- Server-side persistence / analytics of tour progress (localStorage only).

## Testing

- **Unit (Vitest):** `tour-slice` reducers — start (linear/screen), next/back/skip, drawer open/close on `opensDrawer` steps, `completedAt` persistence + suppression. Registry integrity test — every step's `screen` is a valid `TourScreen`, every non-null `anchor` is unique, ordering matches the five-station sequence.
- **Component (RTL):** `<TourOverlay/>` renders the bubble for a given step, resolves a present anchor, Back/Next/Skip behavior, and the **missing-anchor → centered fallback** path.
- **E2E (Playwright) — the bar per CLAUDE.md** (crosses router/redux/layout seams): empty library → "Take the guided tour" provisions the sample → steps advance across the **real** Manuscript / Cast (drawer opens) / Generate / Listen screens → `chapter-1-play` is present and playable → finish sets `completedAt` → reload shows **no re-nag**. Plus one mini-tour spec (Cast `?` replays s6–s8) and a responsive case appended to `e2e/responsive/coverage.spec.ts`.

## Open disposition (confirm at review)

1. **`fe-28`** — close as **folded into** this feature, or keep a thin "empty-state CTA" slice of it as the entry-point sub-task? (Recommended: fold in; the CTA repurpose lives here.)
2. **Manuscript-before-Cast** ordering (matches app tabs) vs **Cast-first** (voices-first). (Recommended: Manuscript-before-Cast, as mapped.)
3. **fs-22 bundle** gains pre-rendered chapter-1 audio — confirm this rides the `fs-22` plan rather than a separate artifact change.
