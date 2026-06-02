---
status: active
shipped: null
owner: null
---

# fe-2 — power-user tuning panel (keyboard shortcut, accessibility, autosave debounce)

> Status: active (code + automated coverage complete; pending merge)
> Key files: `src/store/settings-slice.ts`, `src/lib/keybindings.ts`, `src/lib/use-accessibility-settings.ts`, `src/views/account.tsx` (AdvancedCard), `src/components/mini-player.tsx`, `src/store/persistence-middleware.ts`, `src/styles.css`
> URL surface: `#/account` → "Advanced (power-user)" card
> OpenAPI ops: none (device-local, localStorage via redux-persist)

## Benefit / Rationale

- **User:** A rebindable play/pause shortcut (default Space → e.g. K), a high-contrast theme, a larger-text scale, and a tunable autosave debounce — surfaced in one Account card. Closes a keyboard-navigation accessibility gap and exposes a previously-hardcoded value.
- **Technical:** Turns the hardcoded `DEBOUNCE_MS = 500` into a user setting read at flush time; adds a reusable global-shortcut primitive (`useKeyBinding`) and a normalised key token.
- **Architectural:** Adds the `settings` slice as a third redux-persist (device-local) slice, distinct from the server-persisted `account` slice — the right home for per-browser preferences.

## Architectural impact

- **New seams:** `settings` slice (`keybindings`, `highContrast`, `textScale`, `autosaveDebounceMs`); `keybindings.ts` (`normalizeKeyEvent`, `isTextEntryTarget`, `formatKeyLabel`, `useKeyBinding`, `TEXT_SCALE_PERCENT`); `useAccessibilitySettings()`; `[data-contrast='high']` token layer in `styles.css`.
- **Decision — folded into Account, not a new top-level view:** the original fe-2 spec named a new `src/views/settings.tsx`, but TTS concurrency (`generationWorkers`) and theme already live in Account, so the panel landed as an **Advanced card inside Account** to avoid duplication. SSE chunk-size was dropped (no real hardcoded home — would have been speculative).
- **Invariants preserved:** Persistence pattern mirrors the existing `themeOverride` redux-persist write (device-local, no server round-trip). The play/pause binding reuses the mini-player's existing window-keydown pattern (the marker `M` shortcut), toggling the same local `playing` state — no new cross-component event bus or redux action. The persistence middleware's default stays 500ms when the slice is absent (older blob / partial test state), so behaviour is unchanged until a user tunes it.
- **Migration story:** none — a fresh `settings` blob starts at `initialState`; `SETTINGS_PERSIST_VERSION` guards future incompatible shape changes.
- **Reversibility:** remove the slice from the store + the AdvancedCard; the mini-player falls back to its on-screen button, accessibility/contrast revert to theme-only, and the debounce reverts to the constant default.

## Invariants to preserve

1. `settings` is whitelist-free in `store/index.ts` (every field is a persisted preference) and registered as `persistedSettingsReducer`.
2. `DEFAULT_KEYBINDINGS['play-pause'] === 'Space'`; `setAutosaveDebounceMs` clamps to `[AUTOSAVE_DEBOUNCE_MIN_MS, AUTOSAVE_DEBOUNCE_MAX_MS]` = `[100, 10000]`.
3. `normalizeKeyEvent` maps the space bar → `'Space'` and a single char → its uppercase; multi-char keys → `null` (unbindable).
4. `useKeyBinding` ignores text-entry targets + modifier chords and `preventDefault`s on a match.
5. `persistence-middleware.ts` reads `settings.autosaveDebounceMs` at flush-scheduling time (falls back to 500).
6. `useAccessibilitySettings` writes `<html data-contrast="high">` and root `font-size` only (no other DOM mutation), mounted once in `layout.tsx` next to `useTheme()`.

## Test plan

### Automated coverage

- Vitest (`src/store/settings-slice.test.ts`) — reducers + the debounce clamp.
- Vitest (`src/lib/keybindings.test.ts`) — key normalisation; `useKeyBinding` fire/rebind/ignore-text-entry/ignore-modifier/disabled.
- Vitest (`src/lib/use-accessibility-settings.test.tsx`) — writes `data-contrast` + root font-size.
- Vitest (`src/store/persistence-middleware.test.ts`) — a user-tuned 2000ms debounce delays the PUT (vs the 500ms default).
- Vitest (`src/views/account.test.tsx`) — Advanced card: default binding, rebind→K, Reset, high-contrast toggle, text-scale change, debounce commit/clamp.
- Playwright e2e (`e2e/keyboard-shortcuts.spec.ts`) — rebind play/pause→K in Account, then K toggles the mini-player's `<audio>` on the Listen view (router + redux + layout + keyboard seams).

### Manual acceptance walkthrough

1. `#/account` → Advanced card. Click **Rebind**, press `K` → the binding pill shows `K`.
2. `#/books/sb/listen` → Play from the start → press `K` → playback pauses; press `K` again → resumes.
3. Toggle **High-contrast theme** → the palette firms up (composes with light/dark); reload → survives (localStorage).
4. Set **Text size** → Larger → UI scales to 125%; reload → survives.
5. Set **Autosave debounce** → 2000 → edit a cast member → the disk write waits ~2s (vs ~0.5s).

## Out of scope

- No new top-level Settings view (folded into Account).
- TTS concurrency cap (already in Account as `generationWorkers`) — not duplicated.
- SSE chunk-size knob — dropped (no real hardcoded home).
- Only play/pause is rebindable in v1; the marker `M` shortcut stays fixed.

## Ship notes

Pending merge — ships with the Coqui installer in one combined PR (branch `feat/frontend-coqui-installer-fe2`). Closes #400. Scope trimmed vs. the original backlog spec per the decisions above (Account-card home, no SSE knob, no concurrency duplication). Flip to `stable` + `git mv` to `archive/` on merge.
