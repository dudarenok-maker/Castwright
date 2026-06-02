---
status: stable
shipped: 2026-06-02
owner: null
---

# Coqui XTTS v2 in-app installer (engine install parity with Qwen)

> Status: stable
> Key files: `src/components/coqui-install.tsx`, `src/views/account.tsx` (Models card), `server/src/routes/coqui-install.ts`, `server/src/tts/coqui-install-bootstrap.ts`, `server/src/tts/coqui-install-detect.ts`, `server/tts-sidecar/scripts/install-coqui.mjs`
> URL surface: `#/account` → Models card (Coqui subsection)
> OpenAPI ops: none (local install routes, like `/api/qwen/*`)

## Benefit / Rationale

- **User:** Coqui XTTS v2 — the alternate engine — installs from Account → Models with a one-click button and streamed progress, on par with Qwen. The card explains Coqui's value/difference (zero-shot voice cloning from a reference clip · ~30 baked multilingual voices · ~1.8 GB · ~3 GB VRAM · optional), so a user can decide whether they want it instead of guessing from a terminal snippet.
- **Technical:** Replaces a display-only copy-paste snippet with a real detect → install → poll → recheck state machine. Detection is node-side on-disk and aligned with the runtime's actual model path, so the installer never reports a wrong state.
- **Architectural:** Mirrors the Qwen installer 1:1, establishing the per-engine in-app installer as a repeatable pattern (detect/bootstrap/routes/script siblings).

## Architectural impact

- **New seams:** `/api/coqui/{detect,install,install/:id,install/:id/recheck}` (mirror of `/api/qwen/*`); `CoquiInstallBootstrap` with injectable `spawnFn`/`detectFn`; `detectCoquiInstallStateOnDisk`; the `CoquiInstall` self-contained polling component.
- **Invariants preserved:** OpenAPI is unaffected (local-only routes, same as Qwen). No change to the TTS engine dispatch, the per-character voice map, or the `ModelControlPill` load/stop path (Coqui's pill already works off the existing `model_loaded`/`loading` health fields).
- **Key correctness decision:** the sidecar runtime never sets `TTS_HOME`, so XTTS v2 weights land in the Coqui lib's default user-data dir (`get_user_data_dir("tts")` from `trainer.io` → `%LOCALAPPDATA%\tts` / `~/Library/Application Support/tts` / `~/.local/share/tts`, honoring `TTS_HOME`/`XDG_DATA_HOME`). `coqui-install-detect.ts` replicates that resolution exactly, and `install-coqui.mjs` deliberately does NOT pin `TTS_HOME` — pre-fetching elsewhere would be invisible to the runtime (the same trap `install-qwen3.mjs` records for `HF_HOME`).
- **No resolver-cache sync:** unlike Qwen (the auto-default engine), Coqui is never auto-selected, so the install-state never feeds `getResolvedTtsModelKey` — the routes skip the `setLastKnown…` cache entirely.
- **Reversibility:** delete the new files + the Models-card swap; the legacy `install-coqui.ps1`/`.sh` scripts and the auto-download-on-first-synth path are untouched.

## Invariants to preserve

1. `coqui-tts` (import package `TTS`) is a BASE sidecar requirement (`server/tts-sidecar/requirements.txt:7`), so `detectCoquiInstallStateOnDisk` returns `not-installed` only when the venv itself isn't bootstrapped; the meaningful variable is the XTTS v2 weights → `weights-missing` vs `ready`.
2. XTTS v2 weights path = `get_user_data_dir("tts")/tts_models--multilingual--multi-dataset--xtts_v2/model.pth` (no extra `/tts` segment in the default case). `coqui-install-detect.ts` `ttsDataDir()` must keep matching `trainer.io.get_user_data_dir`.
3. `install-coqui.mjs` must NOT set `TTS_HOME` (aligns the pre-fetch with the runtime's default dir).

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/coqui-install-detect.test.ts`) — package/weights probes + the three install states.
- Vitest server (`server/src/tts/coqui-install-bootstrap.test.ts`) — detect/installing/installed/error/recheck state machine with injected spawn+detect.
- Vitest server (`server/src/routes/coqui-install.test.ts`) — `/detect` shape, `/install` 202 + poll to installed, 404 on unknown id, recheck promotion.
- Vitest frontend (`src/components/coqui-install.test.tsx`) — installed/not-installed/installing/error renders.
- Vitest frontend (`src/views/account.test.tsx`) — Models card renders `<CoquiInstall />` with the value/difference copy.
- Playwright e2e (`e2e/account-dual-model.spec.ts`) — the Coqui install card renders in the Account view (probe stubbed via `stubAccountModelProbes`).

### Manual acceptance walkthrough

1. `npm start`, open `#/account` → Models → Coqui subsection shows the value/difference blurb + **Install Coqui XTTS v2** (or the green "installed" pill + **Re-check** if XTTS is already present).
2. Click Install on a box without XTTS → step progress streams (`[install-coqui] …`) → flips to "installed" on completion. On a box that already has XTTS, the job short-circuits to "installed".
3. Confirm the Coqui load/stop pill in the top bar still loads/unloads XTTS.

## Out of scope

- No cast-selection "install me" nudge (the `qwen-status-notice` analog) — Coqui is the alternate, not the default, so nudging would be wrong.
- No sidecar `/health` `coqui_install_state` field — detection is node-side on-disk.

## Ship notes

Shipped 2026-06-02 with fe-2 in one combined PR — #450, merge commit `8a8cd25` (server commit `fb5f9c3`). No behaviour delta vs. spec. Detection path validated against the live sidecar venv's `TTS.utils.manage.ModelManager` (`%LOCALAPPDATA%\tts\tts_models--…--xtts_v2\model.pth`).
