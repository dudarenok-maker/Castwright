---
status: active
shipped: null
owner: null
---

# 199 — Advanced Settings configuration surface

> Status: active
> Key files: `src/views/advanced.tsx`, `src/store/config-slice.ts`, `src/components/settings/override-row.tsx`, `src/components/settings/settings-accordion.tsx`, `src/components/settings/restart-sidecar-banner.tsx`, `server/src/routes/config.ts`, `openapi.yaml`
> URL surface: `#/advanced` (reached from `#/admin` and `#/account`)
> OpenAPI ops: `GET /api/config`, `PUT /api/config`, `DELETE /api/config` (key/group/all reset), `GET /api/config/prompts/{id}`, `PUT /api/config/prompts/{id}`, `DELETE /api/config/prompts/{id}`, `POST /api/sidecar/restart`

## Benefit / Rationale

- **User:** power users can tune ~70 model, generation, and QA knobs (sample rates, re-record limits, ASR gate, analyzer prompts) without editing `.env` files or restarting the server manually — changes persist across restarts and are immediately visible.
- **Technical:** a single server-side config registry (`config.ts` + `config.json`) owns all runtime-tuneable knobs; the frontend mirrors them via `config-slice.ts` with optimistic-update semantics. Env-file values are surfaced read-only ("locked by .env") so the UI never silently loses an env override.
- **Architectural:** establishes the `KnobDescriptor` / `KnobValue` / `ConfigGroup` schema in `openapi.yaml` as the canonical extensibility seam — adding a new knob is a descriptor addition, no UI code change required. The `apply` field (`live` | `restart-sidecar` | `restart-server`) drives the `RestartSidecarBanner` and a future restart-server banner automatically.

## Architectural impact

**New seams / extension points:**

- `src/store/config-slice.ts` — `fetchConfig`, `saveOverride`, `resetKnob`, `resetGroup`, `resetAllConfig`, `restartSidecar`, `forkPrompt`, `revertPrompt` thunks + selectors `selectRestartPending` / `selectRestartServerPending`. Slotted into the root store as `config:`.
- `src/components/settings/` — three reusable components (`OverrideRow`, `SettingsSection`/`SettingsAccordion`, `RestartSidecarBanner`) that the Account and Model Manager views also share.
- `server/src/routes/config.ts` — the six OpenAPI ops above. The server's in-process `loadConfig()` / `saveConfig()` singleton owns the file-level lock (`config.json` in `workspaceRoot`).
- `server/src/env-config.ts` — `.env.example` generator + drift guard (run `npm run env:check` to see out-of-date entries). Separate from the config route but co-maintains the descriptor list.

**Invariants preserved:**

- Components only import from `api.*` — never directly call fetch. The mock (`VITE_USE_MOCKS=true`) and real API paths remain transparent to the view.
- Env-sourced knobs (`source: 'env'`, `locked: true`) are rendered read-only and are never sent in PUT bodies.
- The `ui.stage` discriminated-union is untouched — `#/advanced` is a route inside `src/routes/` rendered independently of `stage`.

**Migration story:** `config.json` is created fresh on first `GET /api/config` if absent; no migration script needed. Old installs without the file start with all defaults.

**Reversibility:** `DELETE /api/config?all=true` (or "Reset all" in the UI) wipes `config.json`, restoring shipped defaults in one operation.

## Invariants to preserve

- `KnobDescriptor.apply` in `openapi.yaml` is exactly `'live' | 'restart-sidecar' | 'restart-server'` — adding a fourth variant requires updating `RestartSidecarBanner`, the apply-pill renderer in `OverrideRow`, and the `selectRestartPending` / `selectRestartServerPending` selectors.
- `selectRestartPending` (`src/store/config-slice.ts`) returns `true` iff any descriptor with `apply === 'restart-sidecar'` has a matching value with `overridden === true`. The banner must not fire for `live` or `restart-server` knobs.
- Env-locked knobs (`locked: true`) must never appear in PUT request bodies — `mockPutConfig` and the real `PUT /api/config` route both silently drop unknown keys, but the UI guard (`disabled={locked}` on `KnobControl`) is the primary defence.
- The `SettingsSection` button carries `aria-label={group.label}` and `aria-expanded` — used by the e2e spec and by a11y tooling; do not change without updating both.
- `MOCK_CONFIG_DESCRIPTORS` in `src/lib/api.ts` must keep at least one `restart-sidecar` knob and one `live` knob so the e2e spec (`e2e/advanced-settings.spec.ts`) can cover both banner states.

## Test plan

### Automated coverage

- Vitest unit (`src/views/advanced.test.tsx`) — asserts group headers render after `fetchConfig` hydrates, a knob label renders inside the open TTS section, `saveOverride` is dispatched with the correct key + value when a number input changes, the restart banner appears when a restart-sidecar knob is overridden, and it does NOT appear when no knob is overridden.
- Playwright e2e (`e2e/advanced-settings.spec.ts`) — six specs: heading visible at `#/advanced`, TTS accordion `aria-expanded="true"` + knob label on load, Admin card navigation to `#/advanced`, LIVE knob edit → Revert button + `default: N` label, Revert click → button disappears, restart-sidecar knob edit → amber `RestartSidecarBanner` + "Restart sidecar" CTA.
- Playwright responsive (`e2e/responsive/coverage.spec.ts`) — `advanced configuration view` case asserts no horizontal overflow at chromium / mobile-chrome / tablet-chrome viewports.
- Server unit (`server/src/routes/config.test.ts`) — GET returns descriptors + values, PUT merges override, DELETE resets to defaults, env-locked keys are ignored in PUT body. (Server test file to be verified against existing coverage.)

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, default in dev) via `npm run dev`:

1. **Navigate to `#/advanced`** — heading "Advanced configuration" visible, "Text-to-speech" section open (no accordion collapse needed), "Kokoro sample rate" and "Max re-records per segment" rows rendered.
2. **Edit "Max re-records per segment"** from 2 to 5 and press Tab — the row shows `default: 2` + a "Revert" button; no banner (apply: live).
3. **Click "Revert"** — the value resets to 2, the Revert button disappears.
4. **Edit "Kokoro sample rate"** to 16000 and press Tab — the amber "Voice-engine setting changed — restart the sidecar to apply." banner appears; "Restart sidecar" button visible.
5. **Click "Restart sidecar"** — button shows "Restarting…" then returns to idle (mock returns `{ok:true}`); banner may persist (knob still overridden).
6. **Open the "Analyzer" section** — click the "Analyzer" accordion toggle; it expands and shows the stage-1 prompt row.
7. **Click "Edit" on the prompt row** — textarea opens pre-filled with the default text; click Cancel to discard.
8. **Click "Reset all"** — confirm dialog → all knobs back to defaults; Revert buttons gone; banner gone (all `overridden: false`).
9. **Navigate from Admin** — go to `#/admin`, find "Advanced configuration →" card (`data-testid="admin-open-advanced"`), click it → lands on `#/advanced`.

**Live GPU acceptance** (run with the real server + sidecar, `VITE_USE_MOCKS=false`):

- Change `KOKORO_SAMPLE_RATE` to 16000, restart the sidecar via the banner, synthesize a chapter → audio comes out at the new sample rate.
- Verify `.env`-sourced values appear as locked (read-only) when a real `.env` carries the key.
- Verify `config.json` is written to `<workspaceRoot>/config.json` and survives a server restart.

## Out of scope

- Prompt diffing / syntax highlighting in `PromptRow` — plain `<textarea>` only for v1.
- Per-knob undo history — only the current override is tracked; `Revert` is the undo path.
- Export / import of the full config as a JSON file — follow-up `fs-42` (#TBD).
- Server-restart banner auto-dismiss on actual server restart — banner requires manual page reload to clear.
- CI: e2e specs require `PLAYWRIGHT_PORT=5184` (or any free port not reused by the main project's dev server) when run from a worktree, because `reuseExistingServer: !process.env.CI` would otherwise attach to the main branch's running Vite instance.

## Ship notes

(Filled in when status flips to `stable`.)
