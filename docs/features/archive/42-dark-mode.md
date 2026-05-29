---
status: stable
shipped: 2026-05-19
owner: null
---

# Dark mode + theme management

> Status: stable
> Key files: `src/styles.css`, `src/lib/use-theme.ts`,
> `src/components/theme-toggle.tsx`, `src/views/account.tsx`,
> `src/store/ui-slice.ts`, `src/store/index.ts`,
> `server/src/workspace/user-settings.ts`, `src/main.tsx`
> URL surface: indirect — `<html data-theme>` attribute owned by `useTheme()`
> OpenAPI ops: `GET /api/user/settings`, `PUT /api/user/settings`
> (extended with `defaultThemePreference: light|dark|system`)

## Benefit / Rationale

- **User:** the single most-requested visual polish missing from v1.
  9 PM listening sessions stop blasting white. Three-state picker
  (Light / Dark / System) means a Mac user on macOS sundown gets
  auto-flips without configuring anything; a user who wants to pin
  one mode regardless of OS can.
- **Technical:** zero per-component churn. The token system shipped
  in plan 25 already routes every paint through `var(--…)`, so
  enabling dark mode is a single CSS block keyed on
  `[data-theme="dark"]` plus a hook that writes the attribute.
  The two `bg-white` / status-pill utility overrides in
  `src/styles.css` are the only Tailwind-class band-aids needed —
  every other surface inverts cleanly from the token cascade.
- **Architectural:** the `useTheme()` hook in `src/lib/use-theme.ts`
  is the single source of truth for "what theme is paint-active
  right now?". Future per-book or per-route themes plug into the
  same resolution rule (override → account default → system) by
  extending the inputs, not by adding a parallel paint path.

## Architectural impact

- **New seams**:
  - `src/lib/use-theme.ts` — `useTheme()` + the pure `resolveTheme()`
    function. The hook owns `<html data-theme>` writes; nothing else
    sets the attribute. Pre-mount paint guard in `src/main.tsx`
    duplicates the resolution rule synchronously against
    `localStorage` so dark-mode users don't see a one-frame flash.
  - `ui.themeOverride: 'light' | 'dark' | 'system' | null` — device-
    local quick toggle, persisted via the existing redux-persist
    `UI_PERSIST_WHITELIST`. `null` (default) means "follow account
    default"; the three explicit values pin or re-enable OS-driven
    auto-flip.
  - `UserSettings.defaultThemePreference?: 'light' | 'dark' | 'system'`
    — server-persisted account default, edited in the Account view's
    new "Appearance" FormCard. Optional in the Zod schema so legacy
    `user-settings.json` files load unchanged.
- **Invariants preserved**:
  - Plan 25 — zero hex literals in component code. New `bg-white`
    overrides live in `src/styles.css` under the `[data-theme="dark"]`
    block; no `style={{ color: '#…' }}` was introduced.
  - Plan 23 — mock layer mirrors the server. `MOCK_USER_SETTINGS`
    in `src/lib/api.ts` spreads `FRONTEND_ACCOUNT_DEFAULTS` so the
    new field is present under `VITE_USE_MOCKS=true` automatically.
- **Brand-token policy under dark mode** (updated 2026-05-18 after
  the initial ship hit two contrast bugs):
  - `--peach` (#F79A83) — kept identical across themes. Already gives
    ~8:1 on dark canvas.
  - `--magenta` — lifted from #A43C6C to #E58FB8 in dark mode. The
    light value gives 2.27:1 on #14110F (fails WCAG); the lifted
    value gives ~7.5:1.
  - `--purple-deep` — lifted from #3C194F to #B89AD6 in dark mode.
    The light value gives 1.18:1 (essentially invisible); the lifted
    value gives ~8.2:1.
  - The `*-rgb` channel forms shift in lockstep so
    `rgba(var(--magenta-rgb), …)` overlays stay tonally aligned with
    the text-colour utilities.
  - The cascade route is `tailwind.config.ts:11-12` — every
    `text-magenta` / `bg-magenta` / `border-magenta` / `ring-magenta`
    / `text-purple-deep` / etc. utility picks up the new token value
    automatically, no component-code change required.
- **Migration story**: persist version bump `UI_PERSIST_VERSION = 1 → 2`
  in `src/store/index.ts`. The change is additive (new optional
  field with `null` default), so redux-persist's version-mismatch
  fallback gives the right behaviour without a custom `migrate:`
  function. Legacy `server/user-settings.json` files lacking
  `defaultThemePreference` parse cleanly because the Zod field is
  `.optional()`; consumers fall through to `'system'`.
- **Reversibility**: revert the `[data-theme="dark"]` block in
  `src/styles.css` to neutralise the visual change while leaving
  the toggle plumbing in place; or revert the whole feat branch.
  The persisted `themeOverride` blob is ignored once the field
  drops from the whitelist (redux-persist treats unknown keys as
  no-ops).

## Invariants to preserve

1. `useTheme()` in `src/lib/use-theme.ts:79-93` is the only React
   surface that writes `document.documentElement.dataset.theme`.
   The pre-mount IIFE in `src/main.tsx:18-49` is the only other
   writer — it runs once, before React, and never re-runs.
2. `resolveTheme(override, accountDefault, systemTheme)` precedence
   is `override ?? accountDefault`, with `'system'` re-resolving
   through `systemTheme`. Pinned by `src/lib/use-theme.test.tsx`
   under `describe('resolveTheme — precedence rule')`.
3. `ui.themeOverride` is the only field in
   `UI_PERSIST_WHITELIST` (`src/store/index.ts:44-51`) that the
   user toggles directly; `selectedModel`/`ttsModelKey` are
   seeded by the account-default applyAccountDefaults reducer.
   Persistence whitelist pinned by `src/store/persist-config.test.ts`.
4. The 3-state cycle order is `system → light → dark → system`
   (`src/components/theme-toggle.tsx:15`). Pinned by
   `src/components/theme-toggle.test.tsx`.
5. `defaultThemePreference` is `.optional()` in the Zod schema
   (`server/src/workspace/user-settings.ts`). Legacy
   `user-settings.json` files without the field MUST parse cleanly.
   Pinned by `server/src/workspace/user-settings.test.ts`.
6. The Account view's Appearance section reads the live
   `ui.themeOverride` and renders the "Currently overridden" pill
   iff that value is non-null. `Use account default` dispatches
   `uiActions.clearThemeOverride()` only — it does NOT clear the
   account default. Pinned by
   `src/views/account.test.tsx > AccountView — Appearance`.

## Contrast invariants

Added 2026-05-18 after the initial ship's two contrast bugs (hover
flashing white, purple text invisible on dark canvas). Any future
dark-mode token / utility edit must preserve these targets:

1. **Body text on canvas** — `--ink` (#F4EFEC) on `--canvas`
   (#14110F) ≥ 15:1. Floor for AA Normal text is 4.5:1; the
   inverted-ink choice gives plenty of headroom.
2. **Brand text on canvas** — `text-magenta` (#E58FB8 in dark) and
   `text-purple-deep` (#B89AD6) must each hold ≥ 4.5:1 against
   `--canvas` (AA Normal). Light-mode values fail this; that's
   why they're overridden.
3. **Hover-state surfaces** — `hover:bg-white`, `hover:bg-white/60`,
   `hover:bg-white/70` must paint a _darker_ surface than the bare
   `bg-white` redirect (#1F1B19), one that still keeps the on-top
   text legible. They MUST NOT paint pure white.
4. **Translucent base surfaces** — `bg-white/60` and `bg-white/70`
   need their own dark overrides (separate selector from `.bg-white`,
   so the solid redirect doesn't reach them). Without these the
   Analysing-view ConnPill paints `text-emerald-700` light-emerald
   text on a ~70% white wash → light-on-light, unreadable. Alpha
   sits one step below the matching `hover:` variants so the base→
   hover elevation ordering is preserved.
5. **Status pills** — rose / emerald / amber backgrounds drop to
   ~10–32% alpha overlays on dark; matching text shifts to the
   -300/-400 family. Any new status-colour utility must land an
   override at the same time it's first used in component code.
6. **Full red/rose ladder coverage** (added 2026-05-18 after the
   Halted-pill / Analysis-halted-panel bug: the top-bar pill paints
   `text-rose-800` and the analysing-view error panel paints
   `text-red-800` / `text-red-900` on red/rose-50 fills — neither
   utility had a dark override, so both bled dark-on-dark). The dark
   overrides now cover every red/rose utility used as a text or
   surface in component code: text shades -600 through -900 (plus
   their `/70`-`/90` alpha modifiers) collapse to `#fca5a5` (~10:1
   on `--canvas`); hover variants lift to `#fecaca`; `bg-red-100`,
   `bg-red-100/60`, `bg-rose-50/30…/80`, and the `hover:bg-rose-100`
   / `hover:bg-rose-200` / `hover:bg-red-50` surfaces drop to
   alpha-tinted overlays; `border-red-200` / `border-red-300` join
   `border-rose-200` at ~30–35% red alpha. Saturated paints
   (`bg-rose-400/500`, `bg-red-500/600`, `hover:bg-red-700`,
   `ring-red-400/40`) are intentionally left as-is — they read as
   destructive-action / dot-indicator hues and already hold contrast
   on dark.

### 2026-05-19 follow-ups (pre-ship bug bundle)

Eight bugs surfaced in one testing session — five visual (dark-mode contrast / stacking) and one always-visible-metadata redesign. Three were either fully or partially fixed by PR #41 (`1264680`, `06444ee`) before the bundle started. The remaining five landed on Branch A (`fix/frontend-pre-ship-bug-bundle`):

1. **Translucent `bg-white/40` + `bg-white/95`** — drawer engine-tab background (profile-drawer.tsx:1061) and drawer sticky header (profile-drawer.tsx:299, match-detail.tsx:51). Both compiled to their own Tailwind selectors and were uncovered. Added override entries at styles.css alongside the existing `/60` and `/70` block. Alpha follows the established ladder: `/40` → 0.03, `/95` → 0.08.
2. **`bg-amber-50/60` + `hover:bg-amber-50`** — voice-drift banner at cast.tsx:206–228. Translucent /60 base + non-translucent hover variant compile to separate selectors that the bare `.bg-amber-50` redirect doesn't reach. Without them the banner painted a cream-amber wash at rest and pushed to a near-solid cream on hover — `text-ink` content disappeared. Added under the existing amber block at styles.css:236; `/60` → 0.07, hover → 0.14.
3. **`floating-pill-inverse` utility** — the cast-view selection bar at cast.tsx:439 used `bg-ink text-canvas` as a "dark capsule in both modes" shorthand. That was a light-mode coincidence: under token inversion the pill flipped to a cream surface and the inner `bg-canvas/15` elevation overlays (Compare button enabled-state fill, count pill, divider) painted dark-on-cream and washed out. The new utility pins the colours per mode (`var(--ink)` / `var(--canvas)` in light; `#14110f` / `#f4efec` literals in dark) so the inner overlays paint the same way in both. Bespoke utility — not Tailwind — to avoid scattering `dark:` siblings (the project doesn't use Tailwind's `dark:` prefix elsewhere).
4. **Match-detail z-index bump** — drawer-stacking bug where match-detail (mounted earlier in layout.tsx) opened underneath the profile drawer because both shared `z-50` and DOM order put profile-drawer on top. Match-detail backdrop bumped to `z-[60]`, aside to `z-[70]`. The "see why" link inside the profile drawer is a drill-deeper affordance, so the match-detail wins the stacking explicitly.
5. **Book-card always-visible metadata strip** — book-library.tsx:387–392 gated `<h3>{book.title}</h3>` + `<p>{seriesLine}</p>` on `!effectiveCoverUrl || coverLoadFailed`. Once a real cover image rendered, both pieces vanished — series position ("Book 7") is never conveyable through cover art alone, so any book without a title baked into the artwork lost its identity. Added a small always-visible metadata strip below the cover (test id `book-meta-strip-<bookId>`) with title + series line; the big serif placeholder title stays for the no-cover case as visual identity.

Test scaffold extended in lockstep: `src/test/dark-mode-css.test.ts` now pins the four new selectors + the six previously-uncovered amber selectors. New regression file `src/modals/match-detail.test.tsx` pins the z-index contract. `src/views/book-library.test.tsx` adds four cases (cover loads, no cover, in-series, standalone).

Skipped: bug 5 (bulk-sync flips decisions) and bug 6 generation side — both landed in PR #41 ahead of this bundle. Bug 6 analysis-side mirror lands in this branch as a separate commit (`fix(frontend): mirror cross-book heartbeat for analysis stream`).

### 2026-05-29 follow-up (install-banner emerald-900 text)

Missing rung in the emerald text ladder. The Account → Models install-status banners (`src/components/ollama-install.tsx`, `src/components/qwen-install.tsx`) paint an `text-emerald-900` heading ("Ollama is installed") plus an `text-emerald-900/70` version/warning line on the `bg-emerald-50` fill. The dark override ladder covered `text-emerald-{800,700,600}` but stopped short of `-900`, so the banner read near-black-green on the dark-green wash — green-on-green and unreadable. Added `[data-theme='dark'] .text-emerald-900` + the `.text-emerald-900\/70` alpha variant (its own compiled selector, same caveat as the rose `/70` ladder) collapsing to the same `#6ee7b7` tint as `-800/-700` at `src/styles.css`. The "Re-check" button (`bg-white` → dark surface in dark mode, `text-emerald-900` label) rides along on the same fix.

A sweep for every other emerald shade used in component code surfaced one related pre-existing gap on the cast-view VRAM-eviction banner (`src/views/cast.tsx:401–409`, the "TTS / Analyzer unloaded to free VRAM" status row): its `bg-emerald-50/70` fill and `text-emerald-700/60` dismiss button + `hover:text-emerald-700` are all `/N` / hover forms that compile to their own selectors the bare overrides never reached, so in dark mode the banner painted a pale cream wash with lightened-`text-emerald-700` body text on top (light-on-light) and a dark-green dismiss control. Added `.bg-emerald-50\/70` (alpha 0.09 — between `/50`'s 0.08 and the base 0.10), `.text-emerald-700\/60` (→ `#6ee7b7`), and `.hover\:text-emerald-700:hover` (→ `#a7f3d0`, one step brighter for the affordance). The other two emerald text shades in use are already correct: `text-emerald-300` (revision-timeline-modal) uses a Tailwind `dark:` variant directly, and `text-emerald-100` (voices.tsx pill) is near-white on a saturated fill. Five new selectors pinned in `src/test/dark-mode-css.test.ts`.

### 2026-05-22 follow-up (Generate-view "Done" overlay)

Same `/N` selector-mismatch class as the 2026-05-19 amber-50/60 entry, this time for the emerald palette used by the Generate view's chapter cards. `.bg-emerald-50/50` (the outer wash on `stateConfig.done` rows in `src/views/generation.tsx`) had no dark counterpart, so the cards painted 50% opacity of the near-white `#ecfdf5` over the dark canvas — a muddy cream overlay rather than the green "done" cue the user reads in light mode. Added the override at `src/styles.css` (alpha 0.08 — one step above `.bg-rose-50/50` at 0.06, one step below the un-multiplied `.bg-emerald-50` at 0.10). Same edit also covered the companion progress-bar shades that had been sitting on bare Tailwind values: `.bg-emerald-200` (Done track), `.bg-emerald-400` (CharStatusBar fullyDone pip), `.bg-emerald-500` (Done fill) — all dropped to alpha-form emerald so the elevation step matches the rose / amber companions. Test scaffold extended: four new selectors pinned in `src/test/dark-mode-css.test.ts`, and `e2e/visual.spec.ts` now covers `generate` + `generate-dark` (the Generate view was the one core surface previously missing a visual baseline — picked Solway Bay because `hydrateFromBookState` flips all 18 chapters to `done`, giving a deterministic full-card render with no live SSE motion).

## Test plan

### Automated coverage

- Vitest unit (`src/lib/use-theme.test.tsx`) — `resolveTheme()`
  precedence (override > account default > system), `useTheme()`
  DOM write side-effect, mid-session reactivity to
  `setThemeOverride` / `clearThemeOverride`, `prefers-color-scheme`
  resolution via mocked `matchMedia`.
- Vitest unit (`src/components/theme-toggle.test.tsx`) — initial
  icon reflects effective mode (override > account default), 3-state
  cycle (system → light → dark → system), aria-label rotates per
  mode.
- Vitest unit (`src/views/account.test.tsx`) — Appearance section
  renders persisted value, falls back to `'system'` for legacy
  files, round-trips through Save patch, override pill renders iff
  `ui.themeOverride !== null`, "Use account default" clears the
  override.
- Vitest server (`server/src/workspace/user-settings.test.ts`) —
  schema accepts `'light' | 'dark' | 'system'`, rejects unknown,
  optional field tolerates legacy files, round-trips through
  `writeUserSettings + readUserSettings`.
- Playwright e2e (`e2e/theme-toggle.spec.ts`) — cold boot paints
  light, toggle cycles + flips `<html data-theme>`, override
  persists across `page.reload()`, Account "Use account default"
  clears override and reverts theme.
- Playwright visual (`e2e/visual.spec.ts`) — six dark-theme
  baselines (`library-dark`, `upload-dark`, `analysing-dark`,
  `confirm-dark`, `ready-dark`, `listen-dark`) blessed alongside
  the existing six light baselines.
- Vitest unit (`src/test/dark-mode-css.test.ts`) — asserts the
  surface-utility overrides for `bg-white`, `bg-white/60`,
  `bg-white/70` and their `hover:` counterparts exist under
  `[data-theme='dark']`. Locks the regression where a missing
  base-variant override let the ConnPill paint
  `text-emerald-700` on a near-white wash in dark mode. Extended
  2026-05-18 with the red/rose ladder additions (`text-rose-800`,
  `text-red-800`, `text-red-900`, the /N alpha modifiers,
  `bg-red-100`, `hover:bg-rose-100` / `…-200` / `bg-red-50`,
  `border-red-200`, `border-red-300/60`) so the Halted-pill +
  Analysis-halted-panel regression can't reopen.

### Manual acceptance walkthrough

1. **Cold boot at `#/` in a fresh browser profile** — light surface,
   top-bar toggle shows the monitor (system) glyph.
2. **Click the toggle twice** — first click writes
   `ui.themeOverride='light'` (sun glyph); second writes `'dark'`
   (moon glyph) and `<html data-theme="dark">` flips the canvas
   to dark.
3. **Hard refresh (Ctrl+F5)** — page repaints dark immediately, no
   white flash. Toggle still shows moon.
4. **Click toggle a third time** — `ui.themeOverride='system'`,
   theme reverts to OS preference, monitor glyph returns.
5. **Navigate to `#/account` → Appearance** — picker shows current
   default ('System'). Change to 'Dark', click Save, observe
   "Saved." flash. `server/user-settings.json` now contains
   `"defaultThemePreference": "dark"`.
6. **Click top-bar toggle once** — writes `themeOverride='light'`;
   Account view's "Currently overridden" pill appears (showing
   `light`); page paints light.
7. **Click "Use account default" in the pill** — pill disappears,
   theme paints dark (account default).
8. **Open macOS / Windows dark mode** (or browser devtools "force
   prefers-color-scheme: dark") with no override and account
   default = 'System' — UI flips dark live without refresh.

## Out of scope

- Per-book theme override (e.g. always read a series in sepia).
  Wake when a user asks for it.
- Animated theme transition (`transition: background-color`). The
  instant snap is intentional — avoids reflow during the swap.
- High-contrast / accessibility theme variants. Pair with the
  axe-core pass on `docs/BACKLOG.md` Could #2 when that lands.

## Ship notes

Shipped 2026-05-19 across a multi-commit arc:

- **Initial ship** (`19210dc`, 2026-05-17): `feat(frontend,server,docs): plan 42 — dark mode + account-managed default theme`. `useTheme()` hook, three-state top-bar toggle, Account view Appearance section, `defaultThemePreference` field in `UserSettings`, six light + six dark visual baselines under `e2e/visual.spec.ts`.
- **Contrast pass A** (`2d33bd4`, 2026-05-18): `fix(frontend,docs): dark-mode contrast — lift brand tokens, hover overrides, status gaps`. Lifted `--magenta` and `--purple-deep` in dark, added the first round of `*-rgb` shifts so `rgba(var(--…-rgb), …)` overlays stay tonally aligned.
- **Contrast pass B** (`5fac605`, 2026-05-18): `fix(frontend): dark-mode contrast for bg-white/{60,70} surfaces`. Translucent base-surface overrides — covered the Analysing ConnPill regression where `text-emerald-700` painted on a ~70% white wash.
- **Red/rose ladder** (`2a03476`, 2026-05-18): `fix(frontend,docs): plan-42 follow-up — dark-mode contrast for red/rose ladder`. Halted-pill / Analysis-halted-panel regression — full text-{600..900} + `/N` alpha + hover variants + `bg-red-100` + `bg-rose-50/30…/80` + matching borders.
- **Confirm inputs** (`bb55711`, 2026-05-19): `fix(frontend): readable confirm-metadata inputs in dark mode`.
- **Pre-ship bug bundle** (`3a93d52` + `a7f3fc2` + `e344a03` + `07d8aac`, 2026-05-19, all on PR #43): `bg-white/40` + `bg-white/95` overrides (drawer engine-tab + sticky header); `bg-amber-50/60` + `hover:bg-amber-50` (voice-drift banner); `floating-pill-inverse` utility (cast-view selection bar); follow-up notes recorded in plan body.

**Behaviour deltas vs original spec:**

1. The brand-token contrast policy expanded from "two `bg-white` overrides" to a full per-utility override block in `src/styles.css` covering the white / amber / red / rose ladders and their `/N` alpha + hover variants. The cascade route is unchanged (Tailwind utilities pick up the token-keyed values).
2. Added `floating-pill-inverse` as a bespoke utility (not Tailwind) for the cast-view selection bar — the project doesn't use Tailwind's `dark:` prefix anywhere else, so introducing it for one site would be inconsistent. The utility pins colours per mode literally.
3. Added the `match-detail` z-index bump (`z-[60]` / `z-[70]`) and the book-card always-visible metadata strip — both surfaced in the same bug-bundle testing pass and ship under plan 42's umbrella because they were dark-mode-discovered regressions, not net-new features.

**Regression coverage at ship:**

- `src/lib/use-theme.test.tsx` (resolveTheme precedence, useTheme DOM write, mid-session reactivity, matchMedia mock)
- `src/components/theme-toggle.test.tsx` (3-state cycle, aria-label rotation)
- `src/views/account.test.tsx` (Appearance section round-trip)
- `server/src/workspace/user-settings.test.ts` (Zod optional field, legacy file roundtrip)
- `src/test/dark-mode-css.test.ts` (every utility override selector pinned)
- `src/modals/match-detail.test.tsx` (z-index over profile-drawer)
- `src/views/book-library.test.tsx` (book-card metadata strip — cover-loads / no-cover / in-series / standalone)
- `e2e/theme-toggle.spec.ts` (Playwright cold boot + cycle + persistence + Account "Use account default" clear)
- `e2e/visual.spec.ts` (six dark baselines: `library-dark`, `upload-dark`, `analysing-dark`, `confirm-dark`, `ready-dark`, `listen-dark`)
