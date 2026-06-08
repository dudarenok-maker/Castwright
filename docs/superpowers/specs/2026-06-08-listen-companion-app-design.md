# Listen tab — Castwright Companion app entry (design)

- **Date:** 2026-06-08
- **Scope:** `frontend` (mocked surface only — no real store links, no app wiring)
- **Related:** companion app plan `docs/features/188-android-companion-app.md`; brand
  `docs/superpowers/specs/2026-06-07-castwright-brand-design.md`

## Context

We built a companion mobile app (plan 188, `apps/android`) but the web Listen tab
never linked to it. The Listen-tab download region
(`src/components/listen/listen-download-section.tsx`) surfaces a "Listen on your
favourite app" grid of **7** third-party players — 5 live (PocketBook, Voice, Smart
AudioBook Player, BookPlayer, Audiobookshelf) and 2 coming-soon (Apple Books, Plex).
There is no entry for our own first-party companion app.

This change adds a first-party companion entry and trims the third-party grid.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Companion presentation | **Full-width branded banner** above the third-party grid (signals first-party, not a peer tile) |
| Store buttons | **Branded pill buttons** in brand tokens (▶ Google Play / App Store) — no official badge artwork |
| Button behaviour | **No-op** (mocked); the banner's **"Coming soon"** badge carries the not-live message |
| Plex vs Apple Books | **Remove Plex** (overlaps the companion app's stream-your-library role); **keep Apple Books** as the lone coming-soon tile |
| Glyph reuse | **Extract** the inline Castwave SVG from `top-bar.tsx` into a shared component; banner + top bar both consume it (DOM-identical) |
| Mock Plex failed-export fixture | **Re-point to Audiobookshelf** (keeps the failed-state demo without referencing a removed app) |

## A. Companion banner (new)

A full-width banner rendered at the **top of `ListenDownloadSection`**, above
`<ListenerApps>`:

- **Castwave glyph** + heading **"Castwright Companion"** + **`ComingSoonBadge`**.
- Tagline (brand voice): *"Take your full-cast audiobooks anywhere — download to your
  phone for offline listening."*
- Two **branded pill buttons**: **▶ Google Play** and ** App Store**. Both no-op,
  each with an explicit `aria-label`, ≥44px touch targets, `data-testid`s
  (`companion-store-google-play`, `companion-store-app-store`).
- Card language matches the section (`rounded-3xl border shadow-card`) but tinted
  to read as first-party.
- **Responsive:** phone = stacked column (glyph+copy, then full-width stacked
  buttons); `sm:`+ = row with buttons trailing. Verified at the three mobile
  viewports per CLAUDE.md.
- Lives as a `CompanionAppBanner` sub-component in
  `listen-download-section.tsx` (consistent with `ListenerApps`/`ExportQueue`
  co-located there).

## B. Glyph extraction (small refactor)

Lift the inline brand SVG from `src/components/top-bar.tsx:273-287` into a shared
`CastwaveMark` component in `src/lib/icons.tsx` (where the brand hex fills already
live). Top bar and banner both consume it. **DOM output is byte-identical** so
top-bar visual/e2e snapshots stay green.

## C. Drop Plex → 6 tiles

- Remove the `plex` entry from `src/data/listener-apps.ts` (grid 7→6, clean 2×3).
- Remove the orphaned `plex` walkthrough from `src/data/walkthroughs.ts`.
- Re-point the mock **failed** export fixture in `src/data/export-queue.ts`
  (`destination: 'Plex'`) to **Audiobookshelf** ("Server unreachable…").
- **Apple Books stays** as the lone coming-soon tile.

## Testing

- **New** component test for `CompanionAppBanner`: heading present, `ComingSoonBadge`
  present, both store buttons render with correct labels/`aria-label`s, buttons are
  non-functional (no handler / disabled affordance).
- **Update** `src/views/listen.test.tsx`: deferred-apps list
  `['apple_books', 'plex']` → `['apple_books']`; assert the grid renders **6** tiles
  and **no** `listener-app-plex`.
- **e2e:** one assertion in the listen/download spec — companion banner visible above
  the grid; Plex tile gone.

## Out of scope

- Real store links / real app store listings / any companion-app wiring.
- Any change to the live handoff exports or Apple Books.
- The per-book `.audiobook/` naming.

## Verification

1. `npm run verify` green (typecheck + tests + e2e + build).
2. Listen tab shows the Castwright Companion banner above the "favourite app" grid,
   with a Coming-soon badge and two non-functional store buttons.
3. The grid shows 6 tiles; Plex is gone; Apple Books remains coming-soon.
4. Banner is responsive/touch-friendly at phone / tablet / desktop widths.
