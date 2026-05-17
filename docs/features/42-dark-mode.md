---
status: active
shipped: null
owner: null
---

# Dark mode + theme management

> Status: active
> Key files: `src/styles.css`, `src/lib/use-theme.ts`,
>            `src/components/theme-toggle.tsx`, `src/views/account.tsx`,
>            `src/store/ui-slice.ts`, `src/store/index.ts`,
>            `server/src/workspace/user-settings.ts`, `src/main.tsx`
> URL surface: indirect — `<html data-theme>` attribute owned by `useTheme()`
> OpenAPI ops: `GET /api/user/settings`, `PUT /api/user/settings`
>              (extended with `defaultThemePreference: light|dark|system`)

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

(Filled in when status flips to `stable`. Append: shipped date,
commit SHA, any behaviour delta vs. the original spec. Once filled,
move to `docs/features/archive/` per `archive/README.md`.)
