---
status: active
shipped: null
owner: null
---

# Brand-in-app rollout (v1.7.0 wave)

> Status: active
> Key files: `src/lib/brand.ts`, `src/views/about.tsx`, `src/views/release-notes.tsx`, `src/lib/release-notes.ts`, `RELEASE_NOTES.md`, `src/components/whats-new-banner.tsx`, `src/components/upgrade-card.tsx`, `src/components/device-panel.tsx`, `server/src/routes/info.ts`, `scripts/release-notes-gate.mjs`, `scripts/bump-version.mjs`, `scripts/build-release-zip.mjs`, `scripts/render-brand-pngs.mjs`, `src/styles.css`, `index.html`, `public/manifest.webmanifest`, `.github/workflows/release.yml`
> URL surface: `#/about`, `#/release-notes`, `#/models` (device panel)
> OpenAPI ops: none (GET `/api/info` is hand-typed `AppInfo`, fs-1)
> Issues: fe-37 (#704) · fs-43 (#705, device panel) · side-14 (#707, deep device follow-up) · app-16 (#706, companion audit)
> Spec: `docs/superpowers/specs/2026-06-10-brand-in-app-rollout-design.md`

## Benefit / Rationale

- **User:** the app stops broadcasting the retired tagline (`…effortlessly. Even
  in your own voice.`) in link previews, browser tabs, SEO and the installed PWA;
  `/about` becomes a real page; a multi-version in-app release-notes history lets
  testers see what changed across version jumps; a device panel answers "will it
  run on my machine?" honestly (esp. Apple Silicon).
- **Technical:** brand copy is single-sourced (`brand.ts`); a placeholder release
  notes file can no longer reach a published release (two-point gate); brand rules
  become regressions, not conventions.
- **Architectural:** the user-facing brand history (committed `RELEASE_NOTES.md`,
  brand voice) is decoupled from the technical GitHub release body (tag
  annotation from `docs/release-notes-next.md`) — two registers, two doors.

## Architectural impact

- **New seams:** `src/lib/brand.ts` (brand copy), `src/lib/release-notes.ts`
  (parser), `scripts/release-notes-gate.mjs` (shared gate), `AppInfo.hardware`
  (server-sourced host detection), `Stage` kind `'release-notes'`.
- **Invariants preserved:** discriminated-union `ui.stage` (added a variant, did
  not flatten); design tokens are CSS custom properties (added neutrals, no hex
  literals in components); OpenAPI type-source rule untouched (`AppInfo` is
  hand-typed). No visual redesign — the in-use `--ink-soft` (#1a1a1a) was left
  unchanged despite the brand ramp also defining `--ink-soft #4A4440` (flagged).
- **Migration story:** `RELEASE_NOTES.md` moved from a git-ignored build artifact
  to a committed, maintained file; `build-release-zip.mjs` no longer regenerates
  it from the tag body. No runtime data migration.
- **Reversibility:** each item is an isolated commit; reverting any one leaves the
  rest green. The favicons are hand-designed assets (committed), so re-running
  `render-brand-pngs.mjs` will not clobber them (test-pinned).

## Invariants to preserve

- `TAGLINE` in `src/lib/brand.ts` is the v2 line; the retired line + the banned
  word "effortlessly" must appear nowhere — pinned by `src/lib/brand.test.ts`
  (incl. `index.html` + `public/manifest.webmanifest`).
- The fs-38 teaser ("Even in your own voice") renders ONLY with its
  in-development flag — pinned by `src/lib/teaser-governance.test.ts`. Inverts
  when fs-38 ships.
- `scripts/render-brand-pngs.mjs` `JOBS` must NOT include the hand-designed
  favicons — pinned by `scripts/tests/render-brand-pngs.test.mjs`.
- `RELEASE_NOTES.md` is a newest-first multi-version history; its top section
  leads with the release version (release gate) — pinned by
  `scripts/tests/release-notes-gate.test.mjs` + the `bump-version.mjs` pre-flight
  + the `release.yml` guard step.
- `build-release-zip.mjs` ships the committed `RELEASE_NOTES.md` verbatim (never
  regenerates) — pinned by `scripts/tests/release-notes-bundle.test.mjs`.

## Test plan

### Automated coverage

- Vitest (`src/lib/brand.test.ts`) — v2 tagline everywhere via constants; no
  retired line in static sites.
- Vitest (`src/lib/teaser-governance.test.ts`) — teaser always flagged.
- Vitest (`src/styles-neutrals.test.ts`) — the six-token neutral ramp present.
- Vitest (`src/views/about.test.tsx`) — 7-block page incl. teaser flag, engine
  credits, licence, What's-new link, alpha ask.
- Vitest (`src/lib/release-notes.test.ts`, `src/views/release-notes.test.tsx`,
  `src/components/whats-new-banner.test.tsx`) — parser + history view + banner
  latest-only.
- Vitest (`src/components/device-panel.test.tsx`) + Vitest server
  (`server/src/routes/info.test.ts`) — device panel + `AppInfo.hardware`.
- node:test (`scripts/tests/release-notes-gate.test.mjs`,
  `release-notes-bundle.test.mjs`, `render-brand-pngs.test.mjs`,
  `bump-version.test.mjs`) — gate logic, bundler no-clobber, render-script
  no-clobber, bump-version pre-flight wiring.
- **Follow-up:** a Playwright e2e case for `#/release-notes` in
  `e2e/responsive/coverage.spec.ts` (added in this wave).

### Manual acceptance walkthrough (mock mode)

1. **`#/about`** → 7 blocks render; the "Coming next" teaser shows an
   "In development" pill; engine credits link out; "What's new" links to
   `#/release-notes`.
2. **`#/release-notes`** → newest-first history (1.6.0 in mock; 1.7.0/1.6.0/1.5.0
   in a real build); the section matching the running version is badged.
3. **Account → Application updates** → "See what's new" links to `#/release-notes`.
4. **`#/models`** → the device panel shows the honest hardware line + the
   detected host label.
5. **Link preview / tab** → og image + meta description + favicon reflect the v2
   brand (no `.ai` lockup, no retired tagline).

## Out of scope

- Deep device ground-truth (active engine's torch device incl. mps) — **side-14**.
- Companion-app brand audit — **app-16**.
- Adopting the brand `--ink-soft #4A4440` app-wide (a visual change).
- castwright.ai website (com-6), Cast Pass surfaces (com-1), sonic assets (§8),
  the actual 1.7.0 version tag.

## Ship notes

(Filled when status flips to `stable`.)
