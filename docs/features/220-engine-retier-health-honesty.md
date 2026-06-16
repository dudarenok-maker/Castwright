---
status: active
shipped: null
owner: null
---

# 220 — Engine re-tier + honest Model Manager health

> Status: active
> Key files:
>   `server/tts-sidecar/requirements/base.txt`,
>   `server/tts-sidecar/requirements/nvidia-cuda.txt`,
>   `server/tts-sidecar/requirements/amd-rocm.txt`,
>   `server/tts-sidecar/scripts/install-coqui.mjs`,
>   `server/src/tts/engine-health.ts`,
>   `server/src/routes/models-inventory.ts`,
>   `src/views/model-manager.tsx`
> URL surface: `#/account` (Model Manager section)
> OpenAPI ops: `GET /api/models/inventory`, `GET /api/diagnostics`, `POST /api/{qwen,coqui,kokoro,whisper}/install`

Spec: [`docs/superpowers/specs/2026-06-16-engine-retier-and-health-honesty-design.md`](../superpowers/specs/2026-06-16-engine-retier-and-health-honesty-design.md)
Plan: [`docs/superpowers/plans/2026-06-16-engine-retier-and-health-honesty.md`](../superpowers/plans/2026-06-16-engine-retier-and-health-honesty.md)

## Benefit / Rationale

- **User:** On a GPU box, Qwen3-TTS installs automatically alongside Kokoro on the first bootstrap — no separate "Install Qwen" step from the Model Manager. Coqui XTTS v2 is honestly described as optional and must be installed explicitly. The Model Manager now shows a truthful "Needs repair" badge (amber) when a package is missing but weights are present, disables Load until the problem is fixed, and offers a one-click Repair action — previously the badge was always green once weights existed, masking a broken package.
- **Technical:** The 4-state health model (`ready | package-missing | weights-missing | not-installed`) is the single source of truth fed by two complementary probes: per-engine `find_spec` booleans from the sidecar `/health` endpoint (authoritative when the sidecar is reachable) with Node disk probes as the offline fallback. An integrity chip (`verified | unpinned | mismatch`) surfaces package-vs-weights version alignment for every engine.
- **Architectural:** Splitting engines into Standard (Kokoro + Qwen on GPU, Whisper) vs Optional add-ons (Coqui) locks in the expectation that GPU installs always have a bespoke-voice engine available. The `reqHash` mechanism turns the requirements overlay into an idempotent self-heal trigger — no migration script, no user action.

## Architectural impact

### Standard engines (GPU profiles)

The NVIDIA (`nvidia-cuda.txt`) and AMD (`amd-rocm.txt`) overlays now include `qwen-tts` directly. `base.txt` holds `kokoro-onnx`, `faster-whisper`, `transformers>=4.45,<5.0`, and all shared deps. CPU (`cpu.txt`) does NOT include `qwen-tts` — Qwen is GPU-only.

**Standard engine set by profile:**

| Profile | Kokoro | Qwen | Whisper (faster-whisper) | Coqui |
|---|---|---|---|---|
| nvidia / amd | standard | standard | standard (base) | opt-in |
| cpu / macOS | standard | — | standard (base) | opt-in |

### Coqui is opt-in

`coqui-tts` was removed from all overlays. The in-app `install-coqui.mjs` installer now runs `pip install coqui-tts -c base.txt` so the install respects the `transformers<5.0` lockstep already established in `base.txt`. Fresh GPU venvs do not have Coqui; existing venvs retain it (pip-install-r never uninstalls).

### base.txt lockstep

`transformers>=4.45,<5.0` in `base.txt` is the shared pin that keeps Qwen + Kokoro + opt-in Coqui on a compatible transformers. Any future engine that imports transformers must resolve under this cap. Verified resolution this session: **transformers 4.57.3**.

### 4-state health model

`server/src/tts/engine-health.ts` exports:

```
type EngineHealthState = 'ready' | 'package-missing' | 'weights-missing' | 'not-installed';
type EngineTier        = 'standard' | 'secondary';
```

Detection precedence:
1. Sidecar `/health` per-engine `find_spec` booleans (authoritative when reachable).
2. Node disk probes (offline fallback).

Weights are always probed via Node disk (the sidecar doesn't expose weight presence).

### Model Manager badge → health state table

| `EngineHealthState` | Badge label | Load button | Repair button |
|---|---|---|---|
| `ready` | Installed (green) | enabled | hidden |
| `package-missing` | Needs repair (amber) | disabled | shown |
| `weights-missing` | Weights missing (amber) | disabled | hidden (Install shown) |
| `not-installed` | Not installed (neutral) | disabled | hidden (Install shown) |

Model Manager groups TTS engines under **Standard** / **Optional add-ons** headings matching the tier field (`'standard'` / `'secondary'`).

### Integrity chip

Every engine row carries an integrity chip (`verified | unpinned | mismatch`) sourced from `server/src/routes/models-inventory.ts`. `mismatch` indicates the package was updated outside the pip-install path; `unpinned` means no lockfile hash to compare against.

### Warn-vs-block readiness gate

`anyTtsEnginePresent` now requires `ready` (package+weights both present), fail-open. `readinessSeverity`:

- **warn** — package-missing on a standard engine (sidecar hasn't confirmed importability yet, or the sidecar is unreachable).
- **fail (hard)** — sidecar is reachable AND confirms a standard engine's package is unimportable (`find_spec` false). This is the only hard-block path.
- **informational** — secondary-engine (Coqui) absence, never a blocker.

`/api/diagnostics` "Voice engine" check goes `fail` when a reachable sidecar reports a STANDARD engine's package missing; the card text directs to Model Manager → Repair.

### Fleet self-heal (reqHash)

Changing the requirements overlay bumps the venv `reqHash`. On the next `npm run start:prod`, the bootstrap detects the hash change and re-runs `pip install -r requirements/<profile>.txt`. Because pip-install-r is additive, `qwen-tts` appears in existing NVIDIA/AMD venvs automatically. Coqui users who already have it retain it.

### New seams

- `GET /api/models/inventory` — per-engine `{ state, tier, integrity }` response (extends existing inventory shape).
- `POST /api/coqui/install` — triggers Coqui opt-in install; existing engine installers (`/api/qwen/install`, `/api/kokoro/install`, `/api/whisper/install`) are unchanged.
- `api.restartSidecar()` — called by the frontend Repair action after reinstall completes.

### Reversibility

Rolling back: restore the previous `nvidia-cuda.txt` / `amd-rocm.txt` (remove `qwen-tts` line), revert `engine-health.ts` and inventory changes. Existing venvs keep `qwen-tts` (pip-install-r never uninstalls) but the app no longer treats it as standard. No data migration needed — designed voices in `cast.json` are unaffected.

## Invariants to preserve

1. **Standard set is profile-scoped**: `qwen-tts` appears in `nvidia-cuda.txt` and `amd-rocm.txt` ONLY, never in `cpu.txt`. Kokoro and `faster-whisper` appear in `base.txt` (pulled into all profiles via `-r base.txt`).
2. **base.txt lockstep**: `transformers>=4.45,<5.0` stays in `base.txt`. No overlay adds a conflicting transformers pin. Coqui's in-app installer passes `-c base.txt` so the opt-in install also respects the cap.
3. **4-state health, 2 sources**: `ready` requires both package-importable AND weights-present. The sidecar `find_spec` boolean is the authoritative package probe when reachable; Node disk probes are the fallback. Both must agree before `ready`.
4. **warn-before-block**: hard-fail readiness only when the sidecar is reachable AND actively reports a standard package unimportable. Offline / sidecar-unreachable → warn (fail-open), never a hard block.
5. **Coqui opt-in preserved across upgrades**: pip-install-r never uninstalls, so existing Coqui installs survive a requirements overlay update. New installs on GPU profiles do not have Coqui.
6. **Model Manager tier grouping**: Standard engines always render before Optional add-ons. Load button is disabled for any non-`ready` engine, regardless of tier.

## Test plan

### Automated coverage

Tests landed with the implementation commits on this branch:

- Vitest server (`server/src/tts/engine-health.test.ts`) — asserts 4-state transitions for each probe combination (sidecar-reachable/not × package-present/missing × weights-present/missing).
- Vitest server (`server/src/routes/models-inventory.test.ts`) — asserts per-engine `{ state, tier, integrity }` response shape; asserts Qwen and Kokoro are `standard`, Coqui is `secondary`.
- Vitest server (`server/src/diagnostics/diagnostics.test.ts`) — asserts "Voice engine" check goes `fail` when sidecar is reachable and reports `qwen find_spec=false`.
- Vitest frontend (`src/views/model-manager.test.tsx`) — asserts "Needs repair" badge visible + Load disabled + Repair button present when engine state is `package-missing`; asserts Standard / Optional grouping headings render.
- Playwright e2e (`e2e/model-manager-health.spec.ts`) — needs-repair badge visible, Repair action re-enables Load after mock reinstall completes.

### Manual acceptance walkthrough

Run against a real NVIDIA GPU box with the sidecar venv bootstrapped from `nvidia-cuda.txt`.

#### A. On-box pip-resolve check

1. Activate the sidecar venv: `.venv\Scripts\activate` (Windows) or `source .venv/bin/activate`.
2. Run `pip install -r server/tts-sidecar/requirements/nvidia-cuda.txt --dry-run` (or a real install).
3. Expected: resolves cleanly with `qwen-tts` included, `transformers` pinned to a 4.x release (session-verified: 4.57.3), no conflict with `kokoro-onnx`, `faster-whisper`, or `torch==2.8.0`. No `coqui-tts` in the output.
4. Confirm `pip show qwen-tts transformers` after install. Both present; transformers version < 5.0.

#### B. Repair walkthrough (package-missing → ready)

1. Start the app (`npm run start:prod`). Open **Admin → Model Manager**. Confirm Qwen row shows **Installed** (green).
2. Stop the app (`npm run stop:prod`).
3. In the sidecar venv: `pip uninstall qwen-tts -y`.
4. Restart the app. Open **Admin → Model Manager**.
5. Expected: Qwen row shows **Needs repair** (amber badge). Load button is disabled.
6. Click **Repair** on the Qwen row.
7. Expected: installer runs `pip install qwen-tts -c base.txt`; sidecar restarts; Qwen row returns to **Installed** (green); Load button re-enables.
8. Open **Admin → Diagnostics**. Expected: "Voice engine" check shows green (was `fail` between steps 4 and 7).

#### C. Coqui opt-in (new GPU install)

1. On a fresh GPU venv (or after `pip uninstall coqui-tts -y`), start the app.
2. Open **Admin → Model Manager**. Confirm Coqui row is under **Optional add-ons** heading, state **Not installed**.
3. Click **Install** on Coqui. Expected: `install-coqui.mjs` runs; installs `coqui-tts` under `-c base.txt`; sidecar restarts; row flips to **Installed**.
4. Confirm: `pip show transformers` still reports a 4.x version (< 5.0).

#### D. Integrity chip

1. In the running app with Qwen installed, open Model Manager.
2. Each installed engine (Kokoro, Qwen, Coqui if present) shows an integrity chip: **verified** if the package version matches the lockfile hash, **unpinned** if no hash, **mismatch** if it differs.

## Out of scope

- Making Coqui a standard engine on any profile — it is opt-in by design (voice-cloning use case, plan 194).
- CPU-profile Qwen support — Qwen is GPU-only; CPU synthesizes via Kokoro.
- Per-engine weight-version checking beyond the Node disk probe — a future integrity enhancement.
- AMD DirectML path for Kokoro — documented as unsupported (ConvTranspose 0x80070005 failure); Kokoro stays CPU on AMD boxes (plan 204 / AMD GPU Phase 2 notes).

## Ship notes

(Fill in when status flips to `stable`.)
