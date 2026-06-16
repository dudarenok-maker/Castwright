# Engine re-tiering + honest per-engine health — design

**Status:** approved design, pre-plan
**Date:** 2026-06-16
**Issue:** _to be filed_ (bug + feature; links the regression that triggered it)

> **Revision (2026-06-16, post 2nd adversarial pass):** corrected three spec errors found
> by verifying against `base.txt`/`main.py` — (a) `faster-whisper` is a **base** requirement,
> so Whisper is standard (not opt-in); **only Coqui** is demoted to secondary; (b) the
> proposed shared `constraints.txt` is dropped — `base.txt` already pins
> `transformers>=4.45,<5.0` and torch is per-profile (a shared torch pin would break
> AMD/CPU); (c) Repair restarts the sidecar (a mid-process pip install isn't visible to
> `find_spec` without `invalidate_caches`/restart). Qwen goes standard on **GPU profiles
> only** (not `cpu.txt`).

## Origin

A live failure: `Failed to import qwen_tts/torch (No module named 'qwen_tts')` on
synthesis/design. Root cause traced to the **2026-06-15 venv rebuild** (the torch
reinstall): `pip install -r requirements` reinstalled the Coqui and Kokoro packages
but **deliberately skipped Qwen** — `qwen-tts` is *commented out* of
`requirements/nvidia-cuda.txt` (line 60) and installed separately by
`install-qwen3.mjs`, which nobody re-ran. The weights survived in the HF cache, so the
package was the only thing missing.

Two distinct defects surfaced:

1. **The admin surface lied and offered no repair.** The Model Manager showed Qwen as
   green **"Installed"** with a working **"Load model"** button (which crashes on
   `import qwen_tts`), because the badge keys off `present` (= *weights on disk*), not
   off `installState` (= *package importable*). The truth was already in the payload;
   the UI ignored it. The readiness/setup gate has the same weights-only blind spot.
2. **Only Kokoro shows a "verified" integrity badge**, because only its weights are
   hash/size-pinned in `model-hashes.json`. Qwen/Coqui/Whisper show nothing, making
   them look unaccounted-for.

The fix has two phases: **re-tier the engines** so the bug *class* can't recur, then
make the admin surface report **honest health** across every engine on the new tiers.

## Requirements layout (verified)

- `base.txt` is **vendor-neutral**: `fastapi`, `uvicorn`, `numpy`, `psutil`,
  **`faster-whisper>=1.0,<2.0`** (Whisper IS base), and **`transformers>=4.45,<5.0`**
  (the shared pin — originally Coqui-driven).
- Each overlay (`cpu.txt` / `nvidia-cuda.txt` / `amd-rocm.txt`) does `-r base.txt` then
  declares the **torch stack (per-profile)** + the engine packages: `coqui-tts`,
  `kokoro-onnx`, and `qwen-tts` **commented out**.
- Coqui's `from TTS.api import TTS` is **lazy** (`main.py:526`, inside `CoquiEngine`), so
  removing `coqui-tts` from the overlay does **not** break sidecar boot.

## Decisions (locked during brainstorming)

1. **Re-tier installs.** Standard (installed by default) = **Kokoro + Qwen** voice
   engines + **Whisper** ASR. Secondary (opt-in installer) = **Coqui only**. Rationale:
   Qwen is the better engine for our use (bespoke per-character voices); Coqui becomes a
   legacy/compatibility alternate. **Qwen goes standard on GPU profiles only**
   (`nvidia-cuda.txt` + `amd-rocm.txt`) — *not* `cpu.txt`, where Qwen is too slow to be a
   sensible default.
2. **Qwen weights stay on-demand.** Only the *package* moves into the GPU overlays — the
   minimal change that closes the root cause. The ~1.8 GB Base / ~3.4 GB VoiceDesign
   weights still download on first design/load.
3. **Kokoro remains the default + universal fallback.** The default *generation* engine
   does not change. "Standard Qwen" means its package is always importable and it loads
   on demand.
4. **Coqui-to-secondary affects future installs only.** Existing boxes that already have
   `coqui-tts` keep it, and Coqui **stays a selectable/valid default engine** for anyone
   who set it — the tier governs install-by-default + wizard expectations, not whether
   Coqui can be used.
5. **No new constraints file.** The shared `transformers>=4.45,<5.0` pin in `base.txt`
   already prevents a transformers re-resolve from breaking the standard engines; its
   rationale is re-commented as the shared lockstep + the Coqui-opt-in compat guard. The
   **Coqui opt-in installer installs against `base.txt`'s pins** (`-c base.txt` / `-r`-aware)
   so a late `coqui-tts` can't pull transformers 5.x. (Torch is per-profile and is never
   pinned in a shared file.)
6. **Honest, consistent integrity semantics for every engine** — `verified` / `unpinned`
   / `mismatch`. Engines with no manifest pin render a neutral `unpinned` chip, not a
   blank. No new per-engine hash pinning (brittle across model revisions).
7. **Full health gate, but fail-open.** A package-missing engine **warns** on the
   readiness/setup surface; it **hard-blocks generation only when the sidecar's
   `find_spec` confirms** the package is genuinely unimportable. Never hard-block on a
   Node disk-probe guess alone.
8. **All four engines in scope** (Kokoro, Qwen, Coqui TTS + Whisper ASR) get the unified
   health model, so no engine's badge can lie. Whisper stays a base package, ASR-gated by
   `SEG_ASR_ENABLED`, with on-demand weights.

## Adversarial-pass findings folded into the design

- **Repair is per-engine routed by tier.** Standard engines (Kokoro, Qwen, Whisper) ride
  the requirements bundle, so their package-missing repair is a **venv re-bootstrap**
  (self-healing). Coqui is opt-in, so its repair is its **own installer**, which must now
  pip-install the package (today `install-coqui.mjs` / `coqui-install-bootstrap.ts`
  explicitly have *no pip step* — they assume coqui-tts is base).
- **Disk probe ≠ importability.** `existsSync(site-packages/<pkg>)` is weaker than the
  sidecar's `importlib.util.find_spec` (fresh per `/health` call), which is weaker than a
  real import. The sidecar's `find_spec` state is authoritative when reachable; Node disk
  probes are the sidecar-down fallback. The hard-block (Decision 7) requires sidecar
  confirmation.
- **Repair restarts the sidecar.** A package pip-installed into the *running* sidecar's
  venv is not visible to `find_spec` until `importlib.invalidate_caches()` or a process
  restart (`main.py:2580` does not invalidate). The repair flow restarts the sidecar (the
  venv-bootstrap repair implies one); the badge updates after the restart, not live.
- **Torch-disturbance risk on Qwen reinstall.** `install-qwen3.mjs` runs
  `pip install -U qwen-tts`; the `-U` can bump transformers/accelerate (observed live:
  `transformers 4.57.6 → 4.57.3`). With Qwen now in requirements, the primary install
  path is the constrained `pip install -r overlay` (honoring `base.txt`); the standalone
  weights-prefetch path drops `-U` / installs `-c base.txt` so it can't re-resolve
  transformers.
- **Relocated, not removed, transformers tension.** With Coqui secondary, base is clean
  (Qwen + Kokoro + Whisper under one `transformers<5.0` line); the conflict only
  resurfaces on a Coqui opt-in, where installing against `base.txt` keeps transformers in
  range. Watch-item: if a future `qwen-tts` needs transformers ≥5.0, the Coqui-compat pin
  would have to give.

## Architecture

```
server/
├── src/tts/
│   ├── engine-health.ts            # NEW — unified per-engine health (4 states) + tier,
│   │                               #       reused by inventory, readiness, badge
│   ├── kokoro-install-detect.ts    # + kokoroPackageInstalled() (probe `kokoro_onnx`)
│   ├── qwen-install-detect.ts      # reused (package + weights already)
│   ├── coqui-install-detect.ts     # reused (package + weights already)
│   ├── whisper-install-detect.ts   # NEW — faster-whisper package + weights probe
│   ├── coqui-install-bootstrap.ts  # + pip-install coqui-tts (-c base.txt) step; fix line-138 msg
│   ├── model-integrity.ts          # kokoroIntegrity → engineIntegrity(engine, repoRoot)
│   └── engine-presence.ts          # readiness uses health==='ready'; tier-aware
├── src/routes/
│   ├── models-inventory.ts         # set installState + integrity + tier for ALL rows
│   └── sidecar-health.ts           # + coqui/kokoro/whisper_install_state passthrough
└── tts-sidecar/
    ├── main.py                     # + _coqui/_kokoro/_whisper_install_state via find_spec
    ├── requirements/base.txt       # keep transformers + faster-whisper; re-comment pin rationale
    ├── requirements/nvidia-cuda.txt# qwen-tts IN, coqui-tts OUT
    ├── requirements/amd-rocm.txt   # qwen-tts IN, coqui-tts OUT
    ├── requirements/cpu.txt        # coqui-tts OUT; qwen-tts stays out (GPU-only standard)
    └── scripts/install-coqui.mjs   # gains the pip-install step (opt-in package install)

src/ (frontend)
├── views/model-manager.tsx         # ResidencyBadge reads health; per-engine Repair;
│                                   #   Load disabled unless ready; tier grouping
├── components/coqui-install.tsx    # opt-in installer copy (now installs package too)
└── components/{qwen,kokoro,whisper}-install.tsx  # repair/weights entry points (reused)
```

### Unified health state (engine-health.ts)

Per engine, derived from the sidecar `/health` `*_install_state` (when reachable) else
Node disk probes:

| State             | Meaning                              | Repair action (per tier)                |
|-------------------|--------------------------------------|-----------------------------------------|
| `ready`           | package + weights present            | none                                    |
| `package-missing` | weights present, package gone        | standard (Kokoro/Qwen/Whisper) → venv re-bootstrap; Coqui → opt-in installer (pip) |
| `weights-missing` | package present, weights gone        | engine's weight installer               |
| `not-installed`   | neither                              | Coqui → "Install"; standard → venv re-bootstrap |

`tier`: `standard` (Kokoro, Qwen, Whisper) · `secondary` (Coqui). Drives wizard
expectations, readiness severity, and Model Manager grouping. (`kind` stays orthogonal:
Whisper remains `asr`.)

### Badge (ResidencyBadge)

```
package-missing → "Needs repair"   (amber)   + Load disabled, action = Repair
weights-missing → "Weights missing"(amber)   + Load disabled, action = engine installer
not-installed   → "Not installed"  (grey)    + action = Install (Coqui) / Repair (standard)
loaded          → "Loaded"         (green)
ready (idle)    → "Installed"
```
Integrity chip (separate): `verified` (emerald) · `mismatch` (red) · `unpinned` (neutral
grey, tooltip: "integrity pinning applies to fixed-file models").

## Phase 1 — Re-tier the engines

1. `requirements/nvidia-cuda.txt` + `amd-rocm.txt`: uncomment/add `qwen-tts` (preserve the
   torch-ordering comments + the transformers note); remove `coqui-tts`. `cpu.txt`: remove
   `coqui-tts` only (Qwen stays out — GPU-only standard).
2. `base.txt`: keep `transformers>=4.45,<5.0` + `faster-whisper`; re-comment the pin
   rationale as the shared lockstep + Coqui-opt-in guard.
3. Coqui opt-in installer: `install-coqui.mjs` / `coqui-install-bootstrap.ts` gain a
   `pip install coqui-tts -c base.txt` step **before** the weights auto-download; update
   the line-138 "package not importable → check venv bootstrap" message to a normal
   install step. `CoquiInstall` copy reframed as opt-in ("install the legacy Coqui engine").
4. `install-qwen3.mjs`: pip step becomes redundant-but-idempotent on GPU profiles
   (package now from the overlay); primary role is weights prefetch. Install path drops
   `-U` / uses `-c base.txt` so repair can't re-resolve transformers.
5. `tier` surfaced in inventory + Model Manager grouping + the fs-21 setup wizard
   (standard engines expected; Coqui shown as an optional add-on).

## Phase 2 — Honest health states

6. `engine-health.ts` with the 4-state model for all four engines; add
   `kokoroPackageInstalled` + Whisper package/weights probes.
7. Sidecar `/health`: add `coqui_install_state`, `kokoro_install_state`,
   `whisper_install_state` (cheap `find_spec`, fresh per call, mirroring
   `qwen_install_state`); plumb through `sidecar-health.ts`.
8. `models-inventory.ts`: set `installState` + `integrity` + `tier` for all TTS + Whisper
   rows. `present` stays weights-based (still gates sizing/removal of orphaned weights).
9. `model-manager.tsx`: badge reads health; Load disabled unless `ready`; per-engine
   Repair routing; integrity chip for all; tier grouping.
10. `model-integrity.ts`: generalize to `engineIntegrity(engine, repoRoot)` →
    `verified | unpinned | mismatch`.
11. `engine-presence.ts` + diagnostics: per-engine `health === 'ready'`; standard-engine
    package-missing **warns**, hard-blocks generation only on sidecar-confirmed
    unimportable; Coqui absence is informational.

## Testing (required — paired with each change)

- **Unit (server):** `engine-health` (4 states × 4 engines, tier assignment);
  `engineIntegrity` (verified/unpinned/mismatch); `kokoroPackageInstalled` + Whisper
  probes against temp site-packages trees.
- **Sidecar (pytest):** new `/health` `*_install_state` fields (present + missing package
  via `find_spec` monkeypatch); the Coqui installer pip-install path.
- **Server integration:** inventory health+integrity+tier per row; readiness warn-vs-block
  (sidecar-confirmed vs disk-probe-only); the requirements-layout invariants.
- **Requirements/zip touchpoints (must update):** `requirements-layout.test.ts`
  (qwen-in-GPU-overlays / coqui-out), `zip-validate.test.ts:118` (overlay package list),
  `spawn-windows-hide.test.ts` (`install-coqui.mjs`), `accelerator-profile.test.ts`,
  `coqui-install-bootstrap.test.ts` (new pip step + message).
- **Frontend (Vitest):** `model-manager.test.tsx` — "Needs repair" badge, disabled Load,
  per-engine Repair label, "unpinned" chip, standard/secondary grouping.
- **E2E (Playwright):** Model Manager renders "Needs repair" + the correct Repair
  affordance for a package-missing engine; Coqui shows "Install".

## Migration & docs

- Existing installs keep Coqui (future installs only lose it from the default set); Coqui
  stays a valid selectable default for anyone who set it.
- Release zip / fresh GPU installs ship the new standard set (Kokoro + Qwen + Whisper
  packages); CPU installs get Kokoro + Whisper (Qwen GPU-only).
- `INSTALL.md` + the fs-21 wizard copy updated: standard vs opt-in engines; Coqui as a
  legacy alternate; the `-c base.txt` note for anyone installing into the venv by hand.

## Out of scope

- New per-engine hash pinning for Qwen/Coqui/Whisper integrity (Decision 6 — `unpinned`
  is the honest answer; pinning HF-snapshot models is brittle across revisions).
- Changing the default generation engine (Decision 3 — Kokoro stays).
- Auto-migrating existing Coqui installs off the box (Decision 4).
- Qwen as standard on CPU-only installs (Decision 1 — GPU profiles only).

## Risks

- **base.txt transformers pin couples Qwen to `<5.0` for Coqui's sake.** Cheap today
  (Qwen resolves to 4.57.3); revisit if a future `qwen-tts` needs ≥5.0. Mitigation: the
  Coqui opt-in installer surfaces a clear conflict message rather than silently breaking
  Qwen.
- **find_spec false-positive.** A present-but-broken package passes `find_spec`. Accepted:
  the badge then shows "Installed" but a real Load surfaces the import error — strictly
  better than today.
- **Constrained-install path resolution.** `-c base.txt` / overlay paths must resolve
  correctly from each caller (`bootstrap-venv`, `install-qwen3.mjs`, `install-coqui.mjs`)
  — a known install-mjs path hazard. Mitigation: a layout test asserting the references.
