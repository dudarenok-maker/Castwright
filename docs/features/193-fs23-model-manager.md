---
status: stable
shipped: 2026-06-06
owner: null
---

# fs-23 — In-app Model Manager (+ srv-21, ops-7)

> Status: stable
> Key files: `src/views/model-manager.tsx`, `src/components/model-settings-form.tsx`, `src/components/account-forms.tsx`, `src/lib/api.ts`, `src/lib/sidecar-url.ts`, `src/lib/bytes.ts`, `server/src/routes/models-inventory.ts`, `server/src/tts/model-paths.ts`, `server/src/tts/model-integrity.ts`, `server/src/workspace/sidecar-url.ts`, `server/tts-sidecar/scripts/model-hashes.json`
> URL surface: `#/models` (reached only from `#/admin`)
> OpenAPI ops: none — `/api/models/*` is local-ops, deliberately outside the contract (like `/api/sidecar/*`, `/api/qwen/*`, `/api/ollama/*`)

Consolidates every model install / inventory / residency control that used to be
scattered across the Account view into one home, the **Model Manager**, launched
from the Admin view. Bundles two adjacent backlog items it shares surface with:
**srv-21** (validate the outbound sidecar URL) and **ops-7** (SHA256-pin model /
wheel downloads). **fe-22** (scattered installers) is subsumed.

## Benefit / Rationale

- **User:** one place to see each model (Kokoro, Qwen base + design, Coqui XTTS,
  Whisper ASR, local Ollama analyzer models) with present? · size · disk path ·
  live residency, and Load / Unload / Install / Update / **Remove** each. The
  Account view shrinks to profile / library / appearance / backups / advanced.
- **Technical:** a new `GET /api/models/inventory` (Node sizes the weight dirs
  directly + folds in sidecar `/health` residency + Ollama tags — works with the
  sidecar down) and a synchronous `POST /api/models/:id/remove` with guards. The
  sidecar-URL SSRF hole is closed at the resolver chokepoint. Model/wheel
  downloads are hash-verified at install.
- **Architectural:** model-flavored settings move behind one Save harness
  (partial `UserSettingsPatch`, server merges) so Account and Model Manager
  coexist; extracting `account-forms.tsx` and removing ~600 lines from the
  1,669-line `account.tsx` de-risks fs-14 (i18n) later.

## Architectural impact

- **New seams:** `model-manager` `Stage` variant + `openModelManager` reducer +
  `#/models` route; `/api/models` router; `tts/model-paths.ts` (weight-dir
  resolution + `dirSizeBytes`, symlink-skipping); `tts/model-integrity.ts`
  (size-check vs the pinned manifest); `workspace/sidecar-url.ts` +
  `lib/sidecar-url.ts` (the srv-21 validators); `model-hashes.json` manifest.
- **Invariants preserved:** discriminated-union `ui.stage` (new top-level variant,
  not flattened); OpenAPI-as-source-of-truth (these routes stay out by precedent,
  no generated-type change); design tokens (no hex literals); RTK immer reducers;
  every `child_process` spawn passes `windowsHide: true` (the `ollama rm` exec).
- **Reversibility:** removing the view + route + the moved-form component restores
  the prior Account layout; the account-slice schema is unchanged throughout.

## Invariants to preserve

- `Stage` union in `src/lib/types.ts` includes `{ kind: 'model-manager' }`;
  `stageToHash` maps it to `'#/models'` (`src/lib/router.ts`).
- Account's `onSave` (`src/views/account.tsx`) must send ONLY the fields it still
  renders — it emits a full patch, so a stale moved-field would clobber the
  Model Manager's value. The moved fields were pruned from it.
- `getResolvedSidecarUrl()` (`server/src/workspace/user-settings.ts`) validates
  through `isPrivateHostUrl` and falls back to the local default on a non-private
  host — every server→sidecar fetch inherits the guard from this one site.
- Remove guards (`evaluateRemoval`, `server/src/routes/models-inventory.ts`):
  loaded → 409, fallback (Kokoro) → 409, current-default → 409, absent → 200
  no-op, Windows EBUSY → 409 `files-locked`.

## Test plan

### Automated coverage

- Vitest unit — `src/views/model-manager.test.tsx` (inventory rows, residency
  badge, Load/Unload, Remove confirm + guard, moved settings + Save, srv-21 URL
  flag), `src/lib/bytes.test.ts`, `src/lib/sidecar-url.test.ts`,
  `src/lib/router.test.ts`, `src/views/admin.test.tsx` (link dispatch).
- Vitest server — `server/src/routes/models-inventory.test.ts` (inventory shape +
  sizing, `evaluateRemoval` guards, `performRemoval` over a temp tree, route
  404), `server/src/tts/model-integrity.test.ts`,
  `server/src/tts/install-qwen3-helpers.test.ts`,
  `server/src/workspace/sidecar-url.test.ts`.
- Playwright e2e — `e2e/model-manager-inventory.spec.ts` (list + Remove
  round-trip + fallback-block), `e2e/model-manager-{analyzer-knobs,dual-model,models}.spec.ts`
  (moved controls), `e2e/responsive/coverage.spec.ts` (model-manager entry).

### Manual acceptance walkthrough (mock mode)

1. `#/admin` → "Open Model Manager" → stage `{ kind: 'model-manager' }`, `#/models`.
2. Inventory lists each model with size + disk path + residency badge.
3. Load an installed-but-unloaded engine → badge flips to "Loaded".
4. Remove the default / Kokoro → modal warns + Confirm disabled.
5. Remove an idle non-default model → confirm → row flips to "Not installed".
6. Account shows no model cards, keeps the workspace-dir field + the pointer.
7. Resize to phone width → no horizontal scroll.

### Live-GPU / on-box acceptance owed

- Real `GET /api/models/inventory` sizes against an actual install; Remove of a
  real Coqui/Whisper dir; `install-kokoro.ps1` hash-verify on a fresh download;
  `install-qwen3.mjs --flash-attn` once the FA2 wheel hash is **blessed** on a
  Windows box that has the wheel (it ships unpinned).

## Out of scope

- First-run wizard (fs-21) — consumes this inventory but is separate.
- Cloud Gemini analyzer (not a disk artifact; only local Ollama models listed).
- Pinning the FA2 wheel hash — mechanism is in place; the pin is a documented
  bless step (`server/tts-sidecar/scripts/model-hashes.json`).

## Ship notes

Shipped 2026-06-06 on `feat/fs23-model-manager`. Three phases on one branch:
A (consolidation + inventory + Load/Unload + srv-21), B (Remove + guards),
C (ops-7 SHA pinning + integrity badge). Closes #476, #426, #430; fe-22 closed
as subsumed. Delta vs spec: the inventory integrity badge is a lightweight
on-disk **size** match (the cryptographic SHA256 verify is the install-time
gate) to keep the 30 s poll cheap; the FA2 wheel ships unpinned-until-blessed.
