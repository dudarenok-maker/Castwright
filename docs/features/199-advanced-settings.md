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
- `KnobControl` (`src/components/settings/override-row.tsx`) commits number/integer/string edits on **blur only**, via a local draft buffer (`useState` + a `!editing` resync effect) — not on every keystroke. Dispatching `saveOverride` per character re-renders every row off the still-stale server value while a real (non-mock) PUT is in flight, which visibly reverts multi-digit edits mid-keystroke. Select/checkbox/device controls are unaffected (single discrete action per interaction already). Don't reintroduce a per-keystroke dispatch on these two input types.
- The blur commit is a no-op unless the draft actually differs from `value.effective`. Tabbing (or clicking elsewhere) blurs whatever field currently has focus, including one the user only tabbed through without editing (e.g. the field immediately after the one actually being edited) — committing unconditionally on blur fires a same-value save that the mock/server still marks `overridden: true`, spuriously showing a Revert button on an untouched row. Caught by `e2e/advanced-settings.spec.ts`'s Revert-flow spec, which tabs from "Signal QA max re-records" into the next row.
- The draft-resync effect reads `editing` via a **ref**, not as an effect dependency. The blur commit handlers call `setEditing(false)` in the same tick as dispatching the save, before it resolves — if `editing` were a dependency, that transition alone would re-run the effect against the still-stale `value.effective` and snap the draft back to the OLD value for the one render before the save resolves, reproducing the exact revert-flash this whole component exists to prevent. Depend on `value.effective` alone so the resync only fires when the server value itself actually changes.
- Any button that can steal focus while a knob is mid-edit (`OverrideRow`'s own Revert, `SettingsSection`'s "Reset section", `AdvancedView`'s "Reset all") makes its blurring input **abandon** rather than commit its edit, checked via `shouldAbandonOnBlur` two ways at once — both are load-bearing, don't drop either:
  - **Mouse/pointer**: the button calls the exported `beginConfigAction()` (`override-row.tsx`) from `onMouseDown`, which sets a module-level flag and imperatively calls `document.activeElement.blur()`, forcing whichever knob input is currently focused to blur *before* the button's own `onClick` runs. This can't rely on the browser's own click-focuses-the-button behavior: WebKit (desktop Safari, and every iOS browser, which is WebKit under the hood) doesn't move focus to a `<button>` on click/tap the way Chromium/Firefox do, so relying on that would silently fail there. **This repo's e2e suite is Chromium-only** (no WebKit project in `playwright.config.ts`), so a WebKit-only regression here is invisible to CI — verify manually on Safari/iOS per the mobile testing protocol if touching this mechanism again.
  - **Keyboard**: the button also carries `data-config-action`, checked via `isConfigActionTarget` against the blurring input's `relatedTarget`. Tab-navigation focus changes ARE genuine browser `focus()` calls in every engine (not subject to WebKit's click quirk), so `relatedTarget` reliably identifies the button when Tab lands on it directly — the common case, since Revert sits right after its own knob in tab order. Without this, tabbing straight from a knob to its Revert button would commit the edit via the ordinary blur-commit path before Revert could abandon it.
  - An earlier version used `onMouseDown={(e) => e.preventDefault()}` to block the blur outright instead of either of the above — don't reintroduce that: blocking blur also blocks the `editing` transition the draft-resync effect needs, so the abandoned edit silently re-committed (recreating the override the click had just reverted) on the row's next real blur.
- `KnobControl`'s commit handlers funnel through a shared `commitEdit` that attaches a `.catch()` to `onChange`'s return value (when it returns one — `advanced.tsx` wires it to `dispatch(saveOverride(...)).unwrap()`) and resets the draft back to the last-known `value.effective` if the save is rejected — guarded **two ways**, both needed:
  - `editingRef.current` (matching the resync effect's own guard): don't clobber a re-edit that's still mid-typing.
  - `commitSeqRef`, a counter bumped on every commit: don't clobber a re-edit that's ALREADY been committed (blurred, its own save dispatched or even already succeeded) by the time an EARLIER commit's rejection arrives late — only the most recent commit's own rejection may revert the draft. `editingRef` alone doesn't cover this case, since it's back to `false` again once the second edit is also blurred.
  - Without the `.catch()` at all, a rejected save left the draft frozen on the unsaved value forever (config-slice's `saveOverride.rejected` case leaves `s.values` untouched, so the draft-resync effect has nothing to resync to), and `AdvancedView` only surfaces the rose error banner pre-hydration (`!hydrated && status === 'error'`) — so a rejection after the view is already hydrated (the normal case for any in-place edit) produced zero visible feedback otherwise.
- Boolean/enum/device `KnobControl`s call `swallowRejection(onChange(...))` rather than `onChange(...)` directly. Since `advanced.tsx` wires every knob's `onChange` through `.unwrap()` (needed so the number/string commit paths above can detect a rejection), a save failure on ANY control type now produces a rejected promise — boolean/enum/device don't buffer a local draft to recover, but still must not leave that rejection unhandled.

## Test plan

### Automated coverage

- Vitest unit (`src/views/advanced.test.tsx`) — asserts group headers render after `fetchConfig` hydrates, a knob label renders inside the open TTS section, `saveOverride` is dispatched with the correct key + value on **blur** (not on the preceding `change` event) for a number input, the restart banner appears when a restart-sidecar knob is overridden, and it does NOT appear when no knob is overridden.
- Vitest unit (`src/components/settings/override-row.test.tsx`) — asserts number/integer/string `KnobControl`s buffer keystrokes locally and only call `onChange` on blur, that an invalid numeric draft reverts to the last effective value on blur rather than committing, that a focus+blur with no edit (or a blur where the draft still equals `value.effective`) does NOT call `onChange`, that a field kept showing the just-typed value immediately after blur rather than snapping back to the pre-edit value for the render before the save resolves, that clicking Revert directly (a real `input.focus()` + `mouseDown`+`click` on the Revert button, exercising `beginConfigAction`'s imperative blur) abandons an uncommitted edit — `onChange` is never called, `onRevert` still fires, the draft resets to the current value — that Tab landing focus directly on Revert (a `blur` with `relatedTarget` set to the button, no mousedown involved) abandons the same way, that a rejected save resets the draft to the last known value UNLESS the user has since refocused and started a fresh edit OR a second, newer edit has already been committed in the meantime (in which case the stale rejection must not clobber either), that a rejected boolean save doesn't leave an unhandled promise rejection, and that enum/boolean/device controls still commit immediately (single discrete action).
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
- **A narrow keyboard-only race on Revert/Reset** (found in review of the blur-commit-on-save work): Tab away from a knob commits a `saveOverride` (as designed), and if the user then activates a Revert/Reset button via keyboard (Enter/Space, not a mouse click) fast enough that the earlier save's response lands *after* the reset's response, the field can silently un-revert. `isConfigActionTarget`'s `relatedTarget` check covers this when Tab itself lands focus directly on the button (the common case, since Revert sits right after its knob in tab order) — the residual gap is a save and a *separate*, later keyboard action racing at the network layer, which needs response-ordering (e.g. a per-key request generation counter) in `config-slice.ts` to close fully. Not attempted here — same underlying "last response wins" gap as any other page in the app that fires two async writes to the same key in quick succession, not something newly introduced by this fix.
- **Losing an in-progress edit if the input unmounts without a preceding blur** (e.g. collapsing its accordion section, or navigating away from `#/advanced`, mid-keystroke) — the draft buffer lives only in component state, with no unmount/`beforeunload` flush. Before the blur-commit change, every keystroke saved immediately, so no edit could be lost this way. Deferred as a narrow edge case (requires editing and leaving without ever blurring) rather than adding an unmount safety net to this fix.
- **`beginConfigAction()` abandons unconditionally on mousedown, before the click completes** — if the user presses a Revert/Reset button then drags off before releasing (so `onClick` never fires), whatever edit was mid-typing elsewhere is discarded with neither a save nor an actual revert/reset happening. Deferred: fixing it properly needs tracking whether the click actually completes (a mouseup/click vs. a drag-off), which is a materially bigger state machine than this fix's scope for a narrow, easy-to-recover (just retype) edge case.
- **`beginConfigAction()`'s abandon flag isn't scoped to the clicked row** — it acts on `document.activeElement` (whichever knob input happens to be focused when a Revert/Reset button is clicked), not specifically the row/section the clicked button belongs to. Clicking Row B's Revert while Row A's field is mid-edit (unblurred) abandons Row A's edit, even though Row A was never touched. Scoping this properly would mean forwarding a ref from `KnobControl`'s input up through `OverrideRow` so `beginConfigAction` could check "is THIS row's own input focused" rather than "is anything focused" — deferred as a narrower edge case (requires editing one field, then acting on an unrelated field's Revert/Reset without ever blurring the first) relative to the invasiveness of that refactor.
- CI: e2e specs require `PLAYWRIGHT_PORT=5184` (or any free port not reused by the main project's dev server) when run from a worktree, because `reuseExistingServer: !process.env.CI` would otherwise attach to the main branch's running Vite instance.

## Ship notes

(Filled in when status flips to `stable`.)
