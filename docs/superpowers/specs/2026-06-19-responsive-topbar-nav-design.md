# Responsive top-bar nav — `<xl` hamburger drawer

**Date:** 2026-06-19
**Status:** design (approved; revised after adversarial review)
**Area:** frontend / `src/components/top-bar.tsx`

## Problem

On tablet and phone viewports the top-bar navigation is unusable:

1. **The nav strip starves and disappears.** The central nav lives in a
   `flex-1 min-w-0 … overflow-x-auto` strip (`top-bar.tsx:292`). The logo, the
   breadcrumb (`projectTitle`, `shrink-0`, `max-w-none` on `sm:`+ so a long
   title never truncates — line 286), and the whole right cluster (Status pill,
   Admin, version, help, theme, avatar — all `shrink-0`) claim the row first.
   The flex-1 nav collapses toward zero width, so when a book is open the
   per-book tabs (Manuscript, Cast, Voices, Generate, Listen, Log) scroll out of
   sight — **you can't reach Cast or Manuscript.**
2. **Horizontal-scroll-to-reach is hostile on touch.** Even with a sliver of
   width, the tabs sit in an `overflow-x-auto` lane with no scroll affordance —
   "almost impossible" to hit on a tablet.
3. **Touch targets shrink at the wrong breakpoint.** Every nav button is
   `min-h-[44px] sm:min-h-0` (lines 299, 312), so at `sm:`+ (≥640px — *all*
   tablets) the WCAG 2.5.5 44px target is removed. Tablets are touch devices.

The plan-81 "swipeable strip" decision (`top-bar.tsx:240`) is the root cause: a
squeezed horizontal-scroll strip does not survive a starved row.

Confirmed by on-device screenshots (book open, tablet in landscape → no tab
strip visible) and the user report ("when a book is selected the whole menu
disappears"; "you can't even get to cast or manuscript").

## Goal

Below `xl` (1280px), the nav collapses into a hamburger → drawer menu so every
destination is reachable with a comfortable touch target. Desktop (`xl+`) is
pixel-identical to today.

## Decisions (locked)

- **Scope = nav only.** Only the navigation strip moves into the drawer. Help
  (its own working portaled `min-h-[44px]` menu), Theme, Version, Status, Admin,
  queue, and avatar all stay in the bar, unchanged. This deliberately avoids the
  regression surface flagged by review (no theme-row reshape, no version-
  discoverability change, no duplicate Help/Theme selectors).
- **Breakpoint = `xl` (1280px).** A real landscape tablet (the device in the
  user's screenshots) commonly reports ≥1024 CSS px, so an `lg` breakpoint would
  not trigger on it. `xl` collapses for phones + portrait *and* landscape
  tablets. A narrow desktop window (1024–1279px) also gets the hamburger — this
  is acceptable and arguably correct, since the full strip genuinely does not fit
  there with a book open.

## Design

### Layout on `<xl`

- A hamburger button (`≡`) is the **leftmost** element (`shrink-0`,
  `xl:hidden`), then logo + breadcrumb (matches the approved mockup).
- The inline nav `<nav>`s (TABS / GLOBAL_NAV) become `hidden xl:flex`, so they
  no longer compete for row width. Removing the strip (the biggest space
  consumer) frees enough room for the breadcrumb + the unchanged right cluster
  to fit at tablet widths; the existing `overflow-x-clip` + `truncate
  max-w-[140px]` on the title (load-bearing — keep them) handle the 375–412px
  phone edge as they do today.
- The hamburger renders **only when there is nav to show** — i.e. when
  `stage === 'ready'` (per-book tabs) OR `showGlobalNav` (books/voices/changelog).
  On other stages (upload, analysing, confirm, account, admin, help,
  model-manager) no strip exists today and none is added — parity with desktop;
  the logo remains the home affordance.

### The drawer

A left slide-in panel, **portaled to `document.body`** (app convention; the
clip-path lesson from the voice-compare modal), following the **proven
ProfileDrawer pattern** (`profile-drawer.tsx:803–806`): a `fixed inset-x-0
top-16 bottom-0 bg-ink/30` scrim that closes on click, and a `fixed top-16
bottom-0 left-0 w-[min(80vw,320px)]` panel that slides in from the left. **No
body-scroll-lock** (ProfileDrawer doesn't use one; copying it avoids a net-new
mechanism and the sticky-header interaction). `top-16` keeps the top bar — and
the always-visible Status pill — interactive while the drawer is open.

Behaviour (mirrors `HelpMenu` in the same file — portal + outside-click +
Escape, already implemented there):
- Opens on `≡` tap; trigger carries `aria-haspopup="menu"` /
  `aria-expanded={open}` and `data-testid="topbar-nav-toggle"`.
- **Content is unmounted when closed** (`{open && createPortal(...)}`), exactly
  like `HelpMenu`. This is the key duplicate-selector mitigation (see Testing).
- Closes on: selecting a destination, scrim/outside click, Escape.
- On open, focus moves to the first drawer item; on Escape, focus returns to `≡`.

Drawer contents are **stage-aware**, mirroring exactly what the desktop strip
shows — no new destinations:

| Stage | Drawer rows |
|---|---|
| `ready` (book open) | the 6 per-book tabs, active row marked `aria-current` |
| `books` / `voices` / `changelog` | Books, Voices, Change log, active row marked |

Each row is a full-width control, `min-h-[44px]`, left-aligned label, optional
trailing check on the active destination, and calls the **same handler** the
inline button does (`setView(id)` for tabs; `onHome`/`onOpenVoices`/
`onOpenChangelog` via the existing `onGlobal` map). Rows carry **distinct**
testids (`data-testid="nav-drawer-link-{id}"`) — they do NOT reuse the inline
buttons' names-as-only-selector, so tests can disambiguate.

### Touch-target fix

The inline buttons' `min-h-[44px] sm:min-h-0` is now moot for nav: the inline
strip is `xl`-only (pointer devices), and the drawer rows carry the 44px target
for touch. No sub-44px *nav* tap zones remain `<xl`.

### What does NOT change

- Desktop `xl+`: inline strip + full right cluster — byte-identical. The
  hamburger uses `xl:hidden` (display:none at `xl`), so it is absent from the
  desktop accessibility tree and tab order.
- The concurrent-multibook invariant: the Status pill stays visible on all
  viewports (NOT moved into the drawer).
- Status / Admin / queue / Help / Theme / Version / avatar — all unchanged in
  position and behaviour. (Known, deliberate out-of-scope: their
  `min-h-[44px] sm:min-h-0` touch sizing on tablet is the existing app-wide
  convention and is not re-keyed here — see Out of scope.)
- Hash-router grammar; `setView` / `onGlobal` dispatch wiring.

## Components & boundaries

All changes local to `src/components/top-bar.tsx`:

- **`TopBar`** — add the `xl:hidden` hamburger trigger (leftmost); change the two
  inline `<nav>`s from `shrink-0` to `hidden xl:flex shrink-0`. Nothing else in
  the bar moves.
- **`NavDrawer`** (new, in-file) — owns drawer open state (local `useState`,
  like `HelpMenu`), the portal, scrim, focus + Escape + outside-click, and
  renders the stage-aware rows. Receives the props `TopBar` already holds
  (`stage`, `view`, `setView`, `onHome`, `onOpenVoices`, `onOpenChangelog`);
  reuses the existing `TABS` / `GLOBAL_NAV` constants and the `onGlobal` map. No
  new files, no new shared primitive, no edits to `theme-toggle.tsx` or any
  other component.

## Testing

**Duplicate-selector safety (the review's top risk):** because the drawer is
**unmounted when closed**, existing `top-bar.test.tsx` / `layout.test.tsx`
(which never open the drawer) see only the inline strip — no duplicate "Cast" /
"Log" / "Change log" / `theme-toggle` nodes. Any test that opens the drawer MUST
scope queries with `within(getByTestId('topbar-nav-drawer'))` and/or use the
`nav-drawer-link-{id}` testids. State this in the test file.

**Unit (`src/components/top-bar.test.tsx`):**
- Hamburger renders for `ready` and global stages, carries `xl:hidden` +
  `data-testid="topbar-nav-toggle"`, and is ABSENT on a non-nav stage (e.g.
  `upload`).
- Drawer is unmounted when closed (`queryByTestId('topbar-nav-drawer')` is null
  before the trigger is clicked) — guards the duplicate-selector invariant.
- Opening renders the correct rows per stage (scoped with `within`):
  `ready` → six tab labels, active one `aria-current`; `books` → Books / Voices
  / Change log.
- Clicking a drawer row calls the right handler (`setView('cast')`, `onHome` for
  Books, `onOpenVoices`, `onOpenChangelog`) and unmounts the drawer.
- Every drawer row matches `/min-h-\[44px\]/`.
- Escape and outside/scrim click close the drawer; Escape returns focus to `≡`.
- Desktop guard: the inline `<nav>` carries `hidden xl:flex` (catches a future
  regression that drops the desktop strip).

**E2E (`e2e/responsive/`, `mobile-chrome` + `tablet-chrome`):** new spec locking
the exact reported bug — with a book open, the inline tab strip is not visible,
the hamburger IS visible, tapping it then "Cast" navigates to the Cast view.
(`tablet-chrome` = iPad Pro 11 @ 834px < 1280 → hamburger shows; jsdom can't see
the media query, so this is the only layer that proves the breakpoint.)

**a11y:** the hamburger gets `aria-haspopup`/`aria-expanded`; drawer rows are
real `<button>`/`<a>` with discernible names and `aria-current` on the active
one. (The existing `a11y.test.tsx` scans views, not `TopBar`; adding a TopBar
axe render is a nice-to-have, not required for this change.)

## Out of scope

- Folding Help / Theme / Version into the drawer (Option B — deferred; Help
  already has a working touch menu).
- Re-keying the `sm:min-h-0` touch sizing on the Status pill / queue chip / other
  right-cluster items (existing app-wide convention; not the reported bug).
- Moving Status / Admin / queue into the drawer (must stay visible).
- Any change to desktop layout, router grammar, or per-view content.
- Drawer animation beyond the existing `slide-in` / `fade-in` CSS classes.
