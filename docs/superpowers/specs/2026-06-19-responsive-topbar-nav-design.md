# Responsive top-bar nav — `<lg` hamburger drawer

**Date:** 2026-06-19
**Status:** design (approved)
**Area:** frontend / `src/components/top-bar.tsx`

## Problem

On tablet and phone viewports the top-bar navigation is unusable:

1. **The nav strip starves and disappears.** The central nav lives in a
   `flex-1 min-w-0 … overflow-x-auto` strip (`top-bar.tsx:292`). The logo, the
   breadcrumb (`projectTitle`, `shrink-0`, `max-w-none` on `sm:`+ so a long
   title like "The Coalfall Commission" never truncates — line 286), and the
   whole right cluster (Status pill, Admin, version, help, theme, avatar — all
   `shrink-0`) claim the row first. The flex-1 nav collapses toward zero width,
   so when a book is open the per-book tabs (Manuscript, Cast, Voices, Generate,
   Listen, Log) scroll out of sight — **you can't reach Cast or Manuscript.**
2. **Horizontal-scroll-to-reach is hostile on touch.** Even with a sliver of
   width, the tabs sit in an `overflow-x-auto` lane with no scroll affordance —
   "almost impossible" to hit on a tablet.
3. **Touch targets shrink at the wrong breakpoint.** Every nav button is
   `min-h-[44px] sm:min-h-0` (lines 299, 312), so at `sm:`+ (≥640px — *all*
   tablets) the WCAG 2.5.5 44px target is removed. Tablets are touch devices.

The plan-81 "swipeable strip" decision (comment at `top-bar.tsx:240`) is the
root cause: a squeezed horizontal-scroll strip does not survive a starved row.

Confirmed by on-device screenshots (book open → no tab strip visible) and the
user report ("when a book is selected the whole menu disappears, nowhere to be
found"; "you can't even get to cast or manuscript").

## Goal

Below `lg` (1024px), the nav collapses into a usable hamburger → drawer menu so
every destination is always reachable with a comfortable touch target. Desktop
(`lg+`) is pixel-identical to today.

## Design

### Breakpoint

`lg` (1024px) — the app's established tablet/phone boundary (CLAUDE.md mobile
protocol: `<1024px` = phones + tablets; `lg:`/`xl:` = desktop). The inline strip
becomes `hidden lg:flex`; the hamburger + drawer are `lg:hidden`.

### Layout on `<lg`

- A hamburger button (`≡`) is the **leftmost** element, then logo + breadcrumb
  (matches the approved mockup).
- The inline nav strip (`TABS` / `GLOBAL_NAV`) is hidden, so it no longer
  competes for row width; the breadcrumb + remaining right cluster fit.
- Right cluster on `<lg` reduces to: **Status pill + Admin pill + queue chip
  (when present) + avatar**. Help menu, Theme toggle, and Version pill are
  hidden from the inline bar (`hidden lg:…`) and relocated into the drawer
  (Version remains reachable via avatar → Account, where the upgrade card
  already lives; it is already phone-hidden today).
- Net `<lg` bar: `≡ · Castwright · / Title · ●Status · Admin · ⠿avatar`.

### The drawer

A left slide-in panel, **portaled to `document.body`** (app convention —
drawers must portal; the clip-path lesson from the voice-compare modal), with a
dimming scrim backdrop. It mirrors the portal + outside-click + Escape pattern
already implemented for `HelpMenu` in the same file, so no new dependency.

Behaviour:
- Opens on `≡` tap; trigger carries `aria-haspopup="menu"` / `aria-expanded`.
- Closes on: selecting a destination, scrim/outside click, Escape.
- On open, focus moves to the first drawer item; on Escape, focus returns to `≡`.
- Body scroll is locked while open (overflow hidden on `<body>`), restored on
  close.

Drawer contents are **stage-aware**, mirroring exactly what the desktop strip
would show — no new destinations are invented:

| Stage | Primary section |
|---|---|
| `ready` (book open) | 6 per-book tabs: Manuscript, Cast, Voices, Generate, Listen, Log — active row checked |
| `books` / `voices` / `changelog` | Global nav: Books, Voices, Change log — active row checked |
| any other stage | no primary section (parity with desktop, which shows no strip there) |

Below the primary section, a divider then the relocated secondary actions
(always present, every stage):
- **Help** (`#/help` link)
- **Take the tour** (`startLinearTour`)
- **Show me this screen** (`startScreenTour(screen)`, disabled when `screen` is
  null — same gate as today's HelpMenu)
- **Theme** toggle (reuse `ThemeToggleButton`, rendered as a full-width row)

Because the secondary actions are always present, **the hamburger renders on
every stage on `<lg`** (not only when a nav strip exists) — it is the single
home for Help/Theme/tour on small screens.

Each drawer row is a full-width control with `min-h-[44px]` (touch target),
left-aligned label, optional trailing check for the active destination.

### Touch-target fix

The `min-h-[44px] sm:min-h-0` concern on the inline buttons dissolves: the
inline strip is now `lg`-only (pointer devices), and the drawer rows carry the
44px target for touch. No sub-44px tap zones remain on tablets/phones.

### What does NOT change

- Desktop `lg+` rendering: inline strip, full right cluster — byte-identical.
- The concurrent-multibook invariant: the Status pill stays visible on all
  viewports (it is NOT moved into the drawer).
- Status pill / Admin pill / queue chip behaviour and the existing
  `summarizeStatus` logic.
- Hash-router grammar, `setView` / `onGlobal` dispatch wiring — the drawer rows
  call the exact same handlers the inline buttons do.

## Components & boundaries

All changes are local to `src/components/top-bar.tsx`:

- **`TopBar`** — gains a `lg:hidden` hamburger trigger + `hidden lg:flex` on the
  existing inline `<nav>`s; right-cluster items gain `hidden lg:…` where folded.
- **`NavDrawer`** (new, in-file) — owns drawer open state (local `useState`,
  like `HelpMenu`), portal, scrim, focus + Escape + outside-click + body-scroll
  lock, and renders the stage-aware primary section + secondary actions. Receives
  the same props `TopBar` already has (`stage`, `view`, `setView`, `onHome`,
  `onOpenVoices`, `onOpenChangelog`) plus nothing new — it reuses `TABS` /
  `GLOBAL_NAV` and the `onGlobal` mapping.

No new files, no new shared primitive — keeps the change surgical and keeps the
existing unit-test selectors (`status-pill`, `topbar-help`, tab buttons) intact
for `lg+`.

## Testing

**Unit (`src/components/top-bar.test.tsx`):**
- Hamburger trigger renders (it carries a `lg:hidden` class + a stable
  `data-testid="topbar-nav-toggle"`).
- Opening the drawer renders the correct primary section per stage:
  - `ready` → all six tab labels, active one marked.
  - `books` → Books / Voices / Change log, active one marked.
- Clicking a drawer destination calls the right handler (`setView('cast')`,
  `onHome` for Books, `onOpenVoices`, `onOpenChangelog`) and closes the drawer.
- Secondary actions present: Help link (`#/help`), Take the tour
  (`startLinearTour` dispatched), Theme toggle.
- Every drawer row matches `/min-h-\[44px\]/` (touch target).
- Escape and outside-click close the drawer.

**E2E (`e2e/responsive/`, runs under `mobile-chrome` + `tablet-chrome`):** a new
spec that locks the exact reported bug — with a book open, the inline tab strip
is not visible, the hamburger IS visible, tapping it and then "Cast" navigates
to the Cast view. This is the regression that proves the fix on real tablet +
phone viewports (jsdom can't see the `lg:hidden` media query).

**Desktop guard:** existing `top-bar.test.tsx` + `layout.test.tsx` stay green
(inline strip still in the DOM; the drawer is additive). Add an assertion that
the inline `<nav>` carries `hidden lg:flex` so a future regression that drops
the desktop strip is caught.

## Out of scope

- Moving the Status/Admin/queue chips into the drawer (they must stay visible).
- Any change to desktop layout, router grammar, or the per-view content.
- Animating the drawer beyond a simple slide/fade (CSS transition is enough).
