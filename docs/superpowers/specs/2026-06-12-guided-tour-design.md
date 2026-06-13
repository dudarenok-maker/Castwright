# Guided tour — in-app, spotlight product tour for new users

> **Status:** design (review round 1 complete — adversarial pass folded in) · **Date:** 2026-06-12 · **Supersedes/folds in:** `fe-28` ([#472](https://github.com/dudarenok-maker/Castwright/issues/472))
> **Owes at implementation:** a new "Guided product tour" backlog issue + a `docs/features/NN-*.md` regression plan (plans reach 210 → next free is **211**).
> **Companion change required:** amend the committed `fs-22` spec — its "no pre-rendered audio" Non-Goal is lifted to allow ONE pre-rendered chapter 1 (full Qwen cast). See *fs-22 coupling*.
> **Scope:** frontend-led, but **not pure-frontend** — needs a small server addition (`tourCompletedAt` user-setting + write endpoint, mirroring fs-21's `setupCompletedAt`) plus the fs-22 bundle/audio change. The `POST /api/samples/{slug}/load` provisioning route already exists (`api.ts:3059`).

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
| Completed-flag persistence | **Server-side `tourCompletedAt` user-setting** (mirrors fs-21's `setupCompletedAt`) | Cross-device, survives localStorage clears; matches the established precedent. Raw `localStorage` is reserved for transient device prefs here. |
| Chapter-1 audio | **Amend `fs-22` to bundle one pre-rendered chapter 1** | Instant, guaranteed real-playback finale; no GPU needed at tour time. Costs a few MB in the zip + an fs-22 spec edit. |
| Top-bar `?` | **Menu-ify** (Help · Take the tour · Show me this screen) | The contextual "Show me this screen" needs a persistent, context-aware home; the `?` is it. Costs one unit-test rewrite + one extra click to Help. |
| Scope | **New feature**, supersedes `fe-28` | Owes its own issue + regression plan. |

### Adversarial review (round 1) — assumptions verified against code

Five read-only investigations confirmed the navigation spine and corrected four real flaws. Verified working: provisioning (`onTrySample` → `api.loadSample` → opens book, `routes/index.tsx:315`), stage derivation from `status` (`ui-slice.ts:209`), guard-free `changeView` (`ui-slice.ts:226`), and the safe anchors. Corrected below: the finished-book button-visibility flaw (s8/s9), persistence, the fs-22 audio conflict, and the top-bar change's true blast radius.

## Architecture & components

Five pieces. Piece (2) adds `data-tour-id` attributes (additive) to existing views; piece (5) also edits three existing components (`EmptyLibrary`, `top-bar.tsx`, `help.tsx`) and rewrites one top-bar unit test. Everything else is net-new files.

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

### 2. `data-tour-id` anchors
Stable attributes on the real elements the tour points at — decoupled from brittle CSS selectors, survive responsive reflow. Inventory (✅ verified present / ⚠️ corrected by review):

| `data-tour-id` | Lives in | Step | Note (from review) |
|---|---|---|---|
| `book-card` | `library-grid.tsx:200` (`data-testid=book-cover-${id}`) | s2 | ✅ Target the sample by `bookId`. |
| `new-book-btn` | `library-grid.tsx:524` (NewBookCard) | s3 | ✅ Single, always visible. |
| `manuscript-line` | `manuscript.tsx:1270` | s4 | ⚠️ Lines are repeated; pin a **specific known `data-sentence-id`** from the sample (first ch.1 dialogue), NOT `absIdx` (shifts on edit). Safe because the finished sample is locked. |
| `chapter-boundary` | `manuscript.tsx:1318` (BoundaryHandle) | s5 | ⚠️ Handle has **no targetable attribute** today → the anchor work must **add `data-tour-id` to the handle span** (pin the first boundary). |
| `cast-roster` | `cast.tsx:945` | s6 | ✅ Always rendered. |
| `profile-drawer` | `profile-drawer.tsx` | s7 | ✅ Opens via `openProfileId`; inline render (not portal), `layout.tsx:1607`. |
| ~~`design-full-cast-btn`~~ | — | s8 | ❌ **HIDDEN on a finished book** (`cast.tsx:562` — only shows with ≥1 undesigned char/variant). **Anchor `cast-roster` instead**, `kind: explain`, centered-ish copy. |
| `generate-resume-btn` | `generation.tsx:881` | s9 | ⚠️ On the partial sample (ch.1 done, 2+ queued) the rendered control is **"Resume generation"**, not "Generate". Anchor that. (A *fully* generated book would show "Regenerate" — `generation.tsx:891`.) |
| `chapter-1-play` | `listen-player-region.tsx:340` (row `data-testid=chapter-row-1`) | s10 | ✅ Enabled once ch.1 `hasAudio`. |
| `companion-app-banner` | `companion-app-banner.tsx:38` | s11 | ✅ Always in Listen view. |
| `download-tile-m4b` | `listen-download-section.tsx:96` | s12 | ⚠️ Six download tiles exist; pin the **M4B tile** specifically (no generic `export-btn`). |

### 3. Tour slice + navigation driving
`src/store/tour-slice.ts`, RTK + Immer. Runtime state: `{ active: boolean; mode: 'linear' | 'screen'; tourId: string | null; stepIndex: number; completedAt: string | null }`.

- **The engine drives real navigation.** When `next()` lands on a step whose `screen` differs from the current `ui.stage`, the slice (via a small middleware or thunk) dispatches the corresponding **real stage change** — navigating the sample book to its `cast` / `manuscript` / `generate` / `listen` view, or for `opensDrawer` steps, opening the profile drawer (`openProfileId`) — *before* the overlay measures the anchor. Every spotlight thus lands on a genuine screen.
- **Persistence (server-side, per review):** the slice's `completedAt` mirrors a new **`tourCompletedAt` user-setting** — add the field to `server/.../user-settings.ts` (the fs-21 `setupCompletedAt` precedent: schema field, stripped from the general PUT, written by a dedicated `POST /api/tour/complete`), fetched once at boot via the existing account-settings thunk. Presence suppresses the empty-library invitation and any auto-offer; the tour stays replayable on demand. Cross-device by construction.
- **Sample provisioning:** starting the linear tour from the empty library calls the existing `api.loadSample('the-coalfall-commission')` (`api.ts:3059` → `routes/index.tsx:315`) to ensure the canonical book is present, then begins at step 1.

### 4. `<TourOverlay/>` — the spotlight renderer
`src/components/tour/tour-overlay.tsx`. Mounted once at the app root (sibling to the stage views), renders only when `tour.active`.

- Resolves `document.querySelector('[data-tour-id="…"]')`, measures its rect, draws a full-screen scrim (`fixed inset-0`) with a lit cutout (CSS `box-shadow: 0 0 0 9999px` ring on a positioned highlight box, matching the approved mock), and positions the coach bubble (title · body · step dots · Back / Next / Skip).
- **Stacking (per review):** the drawer is z-40/z-50 and nested modals reach z-60/z-70 (`profile-drawer.tsx:802`, `match-detail.test.tsx:76`). The overlay must sit at **`z-[75]+`**, and the **cutout region must pass pointer events through** (`pointer-events: none` on the scrim hole) so the highlighted control — including one inside the open cast drawer — stays clickable.
- **Re-measures** on `scroll`, `resize`, and stage settle (anchored element can move as views mount). Respects `prefers-reduced-motion` (no smooth-scroll), mirroring `help.tsx`/`mini-player.tsx`.
- **Anchor-missing fallback:** if the target isn't in the DOM within a short retry window (wrong breakpoint, not yet mounted), the step degrades to a **centered bubble** with the same copy rather than crashing or pointing at nothing.

### 5. Entry points & re-entry
- **Empty library:** the existing `EmptyLibrary` CTA (`library-empty-states.tsx`) gains a primary **"Take the guided tour"** action that provisions the sample and starts the linear tour. The current "Import your first book" / "or try a sample book" remain as secondary paths.
- **Top-bar `?`** (`top-bar.tsx:346`, currently an `<a href="#/help">`): becomes a tiny **popover menu** — **Help · Take the tour · Show me this screen** (the last runs the current screen's mini-tour in `mode: 'screen'`). Reuse the existing `status-popover.tsx` portal pattern (the top bar has `overflow-x-auto`, so a portal avoids clipping). **Keep `data-testid="topbar-help"`** (e2e survives) but **rewrite the unit test** `top-bar.test.tsx:120` (it asserts `role="link"` + `href` — now a `button` with `aria-expanded`). The `helpHrefForFailureCode` deep-links from analysing/generation are unaffected (separate `<a>` tags).
- **Help view** (`help.tsx`) gains a **"Take the tour"** button at the top of its Getting-started section, complementing (not duplicating) the static six-step text.

## fs-22 coupling — the bundled sample

The canonical book ships **analyzed + Qwen-designed cast** (already the `fs-22` plan) **plus a pre-rendered chapter 1** (full Qwen cast). The committed `fs-22` spec lists "no pre-rendered audio" as a **Non-Goal** — so this feature **requires amending fs-22** to allow exactly one bundled chapter. That edit is a companion deliverable (call it out in the new issue + re-link the fs-22 plan).

Consequence verified in review: the sample is therefore **partial** (ch.1 done, 2+ queued), which is intentional and load-bearing —
- it makes the **Generate** step real (a "Resume generation" control renders, `generation.tsx:881`), and
- the **Listen** view shows ch.1 playable with the remaining chapters as not-yet-rendered rows (`listen.tsx:143`). The tour copy owns this honestly ("chapter 1's ready — generate the rest whenever") rather than pretending the whole book is done.

`tourCompletedAt` is server-side and independent of the book's presence (a user can delete the sample without re-triggering the tour; replay re-provisions via `loadSample`).

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
- s8 `cast-roster` (explain — anchor moved off the hidden button) — "And when you start a fresh book, **Design full cast** voices the whole roster in one pass." *(The button only renders when characters still need voices, so on this finished sample it's absent — taught here as a note, not a spotlight on a missing control.)*

**4 · Generate** (`generate`)
- s9 `generate-resume-btn` (explain) — "With the cast set, generation renders every chapter in the right voices. Takes a while — it keeps going without you. Chapter 1's already done; **Resume generation** finishes the rest."

**5 · Listen, pair & export** (`listen`)
- s10 `chapter-1-play` (real) — "Here's the finished chapter 1 — the full cast, on Qwen voices. Press play. (The other chapters render once you generate them.)"
- s11 `companion-app-banner` (real) — "Take it off the desk: pair the **Castwright Companion** app with a quick QR scan and your library follows you to your phone."
- s12 `download-tile-m4b` (real) — "Prefer your own app? Export the audiobook (M4B here) and drop it into any player. Nothing locks you in."
- s13 `finish` (centered, real) — "That's the whole journey. Add your own book whenever you're ready." → sets `completedAt`.

Per-screen mini-tours: the Manuscript `?` replays s4–s5; the Cast `?` replays s6–s8; etc. (Ordering — Manuscript before Cast — matches the app's own tabs; confirmed at review.)

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
- Step-level progress persistence / analytics. Only the binary `tourCompletedAt` is stored; a half-finished tour isn't resumed across reloads (it just re-offers).

## Testing

- **Unit (Vitest):** `tour-slice` reducers — start (linear/screen), next/back/skip, drawer open/close on `opensDrawer` steps, `completedAt` persistence + suppression. Registry integrity test — every step's `screen` is a valid `TourScreen`, every non-null `anchor` is unique, ordering matches the five-station sequence.
- **Component (RTL):** `<TourOverlay/>` renders the bubble for a given step, resolves a present anchor, Back/Next/Skip behavior, the **missing-anchor → centered fallback** path, and **z-[75]+ over an open drawer with a click-through cutout**.
- **Server (Vitest, node):** `tourCompletedAt` read/write round-trip + stripped from the general PUT (mirrors the `setupCompletedAt` tests).
- **Updated test:** rewrite `top-bar.test.tsx:120` for the `?`-as-menu (button + `aria-expanded`, menu items present), keeping `data-testid="topbar-help"`.
- **E2E (Playwright) — the bar per CLAUDE.md** (crosses router/redux/layout seams): empty library → "Take the guided tour" provisions the sample → steps advance across the **real** Manuscript / Cast (drawer opens) / Generate / Listen screens → `chapter-1-play` is present and playable → finish sets `tourCompletedAt` → reload shows **no re-nag**. Plus one mini-tour spec (Cast `?` replays s6–s8) and a responsive case appended to `e2e/responsive/coverage.spec.ts`.

## Open disposition (resolved at review round 1)

1. **`fe-28`** → **folded in** (close as superseded; the empty-state CTA repurpose lives here). ✅
2. **Manuscript-before-Cast** ordering → **confirmed** (matches app tabs). ✅
3. **Chapter-1 audio** → **amend `fs-22`** to bundle it (companion spec edit, flagged at top). ✅
4. **Completed-flag persistence** → **server-side `tourCompletedAt`** (fs-21 pattern). ✅
5. **Top-bar `?`** → **menu-ify** (reuse `status-popover`; rewrite one unit test). ✅

Remaining for the **implementation plan** (not blockers): exact ch.1-dialogue `data-sentence-id` to pin for s4; whether `loadSample` should kick a background render of chapters 2+ (out of scope for v1 — left queued); copy review pass on all 13 steps.
