# fs-38 Wave 3 — on-box acceptance run sheet (voice cloning: 3a + 3b1 + 3b2 + 3c)

> **This is a working document.** Fill it in AS you run it, on the box, with the
> real GPU + real TTS sidecar. When it is complete it becomes the record of
> acceptance. Do not pre-fill Pass columns.
>
> Source branches: `feat/fs38-wave3b2-resolver` (3a/3b1/3b2, worktree
> `C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\feat+fs38-wave3b2-resolver`),
> `feat/fs38-wave3c-xtts` (3c, worktree
> `C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\feat+fs38-wave3c-xtts`)
> Plans of record: [`docs/features/267-fs38-wave3-voice-clone.md`](../../267),
> [`docs/features/268-fs38-wave3b2-resolver.md`](../../268),
> [`docs/features/271-fs38-wave3c-xtts.md`](../../271)
> Spec: `docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`
> Umbrella: fs-38 · GitHub [#624](https://github.com/dudarenok-maker/Castwright/issues/624)

---

## 1. Purpose & scope

### 1.1 What this sheet accepts

The **complete shipped voice-clone arc** — everything a user can reach today
under "Clone a voice":

| Sub-wave | Covers | Section |
|---|---|---|
| **3a** | Sample ingest (upload + browser recorder), the quality gate, Whisper transcript, consent capture, `master.wav` retention, the consent-at-write guard, the `/revoke` route, the sample-route consent gate | **A** (13 tests) |
| **3b1** | The first real clone on Qwen: sidecar `POST /qwen/clone-voice`, `deriveEngineArtifact`, `POST /api/voice-library/clone`, the advisory ECAPA fidelity check, the two-phase wizard, cast assignment, the `applyQwenFallback` cloned exemption, the assign-readiness gate | **B** (13 tests) |
| **3b2** | The per-chapter cloned-voice resolver pre-pass, transparent re-derive, revocation-at-render, fail-fast + readiness gate, transient-vs-permanent derive buckets, `purgeCloneArtifacts` total erasure (revoke + delete), revoke erasing the original recording behind a confirm, atomic sidecar `.pt` writes, the distinct `wrong-engine` diagnosis + assign-time guard, the `cloned-voice-broken` failure code + toast/help, the Broken/Repairable card chip, and §2.3 designed-voice clip retention + self-heal | **C** (21 tests) |
| **3c** | Cloned **and designed** voices on Coqui XTTS v2: `CoquiEngine.clone_voice` (hand-rolled latents derive), the engine-parametric resolver/pre-pass/purge (the same never-substitute + total-erasure guarantees, now on a second engine), the fail-**soft** designed-voice-on-Coqui arm (the opposite policy from cloned, on purpose), the epoch-guarded `_latents_cache`, the non-zero revoke-to-silence bound, and the provenance-gated dual-slot assign | **E** (9 tests) |
| Cross-cutting | Multi-book concurrency, full-book render, restart/cache-independence, the splice/QA-repair surfacing gap | **D** (4 tests) |

**Total: 60 acceptance tests.**

This run is intended to discharge the *owed on-box acceptance debt* recorded in
all three plans:

- 267 "Owed — on-box live-GPU acceptance (spec §8)" items (a) and (b).
- 268 "Owed — on-box live-GPU acceptance" items (a), (b), (c), and the
  Known-limitations list (a)–(c).
- 271 "Owed on-box acceptance" items E-1 through E-7.

### 1.2 What this sheet deliberately does NOT accept

- **Three originally-planned/flagged gaps have since landed and are now
  fixed, not open — verify the fix, don't test for the old absence.**
  (1) Task 27 shipped the engine-aware library sample route
  ([#1887](https://github.com/dudarenok-maker/Castwright/issues/1887),
  closed) — `POST /:voiceUuid/sample` now resolves the requested
  clone-capable engine from `modelKey` and scopes both the synth call and
  the sample cache to that engine's storage key; see §6 KL-o for the one
  remaining nuance (the My-voices card's own Play button still only ever
  *requests* Qwen — a frontend gap, not a route one). (2) #1813's resolver
  pre-pass progress signal also shipped (a `chapter_preparing_voice` SSE
  tick + a "Preparing voice — `<Character>`…" row caption) — see §6 KL-f,
  which is now fixed, not a known limitation; a re-derive is no longer a
  silent dead pause. (3) the manual override-link consent hole and the
  invisible sidecar-evict-on-revoke failure — see §6 KL-q.
- **Two consent-bypass gaps — both now appear fixed in source, but both
  issues are still open. Verify the SHA under test before trusting either as
  closed.** A manual cast-link route bypass
  ([#1885](https://github.com/dudarenok-maker/Castwright/issues/1885), §6
  KL-p) covered TWO routes; both are now guarded as of this source read —
  `cast-link-prior.ts` refuses to denormalise a cloned voice onto/from
  either side of a manual link, and `workspace/series-reuse-link.ts`'s
  `clearStaleLink` (the destructive half — it unconditionally wiped a stale
  link's voice fields) now preserves a cloned character's voice fields
  instead of erasing them, via the same fail-safe `characterHasClonedSlot`
  guard the sibling denormalise path already used. A wholesale cast-write
  route with no consent check
  ([#1899](https://github.com/dudarenok-maker/Castwright/issues/1899), §6
  KL-r) now appears closed in source (`preserve-cast-voices.ts`'s
  `rejectForeignCloneKeys`, wired into `routes/book-state.ts`) — but the
  GitHub issue itself is still open, so confirm the commit is actually in
  your SHA before treating it as fixed. Neither has a normal-UI repro on
  this sheet — recorded for awareness, not as tests to run here.
- **Catalogue rebuild (Wave 2)** — deferred, unaffected by this arc.
- **Consolidating the two engine→modelKey mappers: SHIPPED, not open.**
  [#1812](https://github.com/dudarenok-maker/Castwright/issues/1812) is
  closed — `server/src/tts/clone-engines.ts` now centralises the
  engine-vocabulary helpers both routes use.
- **Emotion-variant `.pt` minting (`mint_variant`)** — its bare `torch.save`
  is explicitly out of scope for the atomic-write work (268 Invariant 6).
- Mobile/tablet viewport acceptance of the wizard — covered by the standard
  mobile protocol, not this sheet.

---

## 2. Preconditions & environment capture

**Fill this in FIRST, before running any test.** Several tests are only
meaningful against a recorded environment (VRAM/capacity behaviour especially —
this box is dual-GPU).

> ### Run 1 — captured 2026-07-29
>
> | # | Value |
> |---|---|
> | P-01 | 2026-07-29, ~13:40–16:10 local |
> | P-02 | Claude Code (agent), on the repo owner's box |
> | P-03 | `2503bca68d387bd155d337cef6746d8cfb812ac6` |
> | P-04 | `main` |
> | P-05 | CLEAN at run start |
> | P-06 / P-07 / P-08 | 1.14.0 / 1.14.0 / 1.14.0 |
> | P-09 | `engines: ["coqui","kokoro","qwen"]`, `devices_state: ready`, `poisoned: false` |
> | P-10 | `0, NVIDIA GeForce RTX 4070 Laptop GPU, 8585 MB`, uuid `1831b67f-…` |
> | P-11 | `1, NVIDIA GeForce RTX 5070 Ti, 17094 MB`, uuid `73e7270e-…` — **eGPU attached**, 2-card rows runnable |
> | P-12 | 610.62 |
> | P-13 / P-14 | Qwen weights present, `install_state: ready` / 1.7B-Base present |
> | P-15 | `whisper_package_installed: true`; `faster-whisper-base` cached |
> | P-16 | ECAPA `spkrec-ecapa-voxceleb` cached; `spk_device: cpu`; `/embed` returns dim 192 |
> | P-17 | **`C:\AudiobookWorkspace`** |
> | P-18 | `env` |
> | P-19 | `coqui_package_installed: true`, `coqui_weights_present: true`, `coqui_version: 0.27.5` — **but see #1944: this field does not mean Coqui can actually load** |
> | P-20 | `SEG_CAPACITY_ADMISSION=1` |
> | P-21 | unset → local (Ollama present with `qwen36-cw-*` / `gemma4-cw-*`) |
> | P-22 | `qwen3-tts-1.7b` |
> | P-23 | unset at run start |
> | P-24 | no pin; both GPUs idle, `resident: []` |
> | P-25 | `autoStartSidecar: true` |
>
> **Deviation from §3's probes:** `server/.env` sets `LAN_HTTPS=1`, so the server
> listens on **`https://localhost:8443`**, not `http://localhost:8080`. Every
> `curl` in this sheet needs `curl.exe -k https://localhost:8443`. The sidecar is
> unchanged at `http://localhost:9000`.
>
> **Fixtures:** built from public-domain LibriVox recordings (two distinct
> narrators) and left at `C:\fixtures\fs38\` — F-1…F-9 plus `F8b-twospeaker`.
> F-8 was regenerated at `volume=+6dB` rather than the sheet's `-8dB`, which
> landed at −41.7 dBFS, only 3.3 dB above the −45 dBFS fatal-silence floor.
>
> **Baseline before the run:** `C:\AudiobookWorkspace\voice-library\` did not
> exist and `voices\xtts\` did not exist — independent confirmation that no clone
> had ever been created on this box. `voices\qwen\` held 1109 files / 605 `.pt`.

| # | Item | How to obtain | Value (fill in) |
|---|---|---|---|
| P-01 | Run date / time | — | |
| P-02 | Tester | — | |
| P-03 | Git SHA under test | `git -C "<worktree>" rev-parse HEAD` | |
| P-04 | Git branch | `git -C "<worktree>" rev-parse --abbrev-ref HEAD` | |
| P-05 | Working tree clean? | `git -C "<worktree>" status --porcelain` (empty = clean) | |
| P-06 | App version (package.json) | `node -e "console.log(require('./package.json').version)"` | |
| P-07 | App version (running server) | `curl -s http://localhost:8080/api/info` → `version` | |
| P-08 | Sidecar version | `curl -s http://localhost:8080/api/info` → `sidecarVersion` (null = sidecar down or predates the field) | |
| P-09 | Sidecar health / engines | `curl -s http://localhost:9000/health` (or via the server proxy `curl -s http://localhost:8080/api/sidecar/health`) | |
| P-10 | GPU 0 | `nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv` — expect `0, NVIDIA GeForce RTX 4070, 8192 MiB` | |
| P-11 | GPU 1 | same command — expect `1, NVIDIA GeForce RTX 5070 Ti, 16376 MiB` (eGPU) | |
| P-12 | Driver version | from P-10 output | |
| P-13 | Qwen weights present? | `curl -s http://localhost:9000/health` → `engines` contains `qwen`; and `POST /load` succeeds. Also check the Model Manager (`GET /api/models`) or the Voices page's Qwen pill. | |
| P-14 | Qwen 1.7B-Base resident/available? | The per-character "Higher quality (1.7B)" toggle only renders when the 1.7B-Base model is available on the sidecar (`voice-engine-picker.tsx:147`). Needed for **C-19**. | |
| P-15 | Whisper (`faster-whisper`) weights present? | Ingest calls the sidecar's `POST /transcribe` unconditionally (it is NOT gated by `SEG_ASR_ENABLED` — that flag only gates the QA pass). First call downloads weights. Confirm a `/transcribe` succeeds. | |
| P-16 | ECAPA `/embed` reachable? | Drives the advisory clone-fidelity cosine. `POST http://localhost:9000/embed`. | |
| P-17 | `WORKSPACE_ROOT` (resolved) | `curl -s http://localhost:8080/api/workspace` → `{ root, booksRoot, source }`. **Use this value, not a guess** — it can come from `workspaceDirOverride` in `~/.castwright/user-settings.json`, from `WORKSPACE_DIR` in `server/.env`, or from the built-in `<repo>/castwright-workspace` default (`server/src/workspace/paths.ts:20-45`). | |
| P-18 | Workspace source | from P-17 `source` (`env` / `default`; note `override` is also possible per `paths.ts:41`) | |
| P-19 | **(3c) Coqui/XTTS weights + package installed?** | The sidecar reports `coqui_package_installed` and `coqui_weights_present` in its health payload (`server/src/routes/sidecar-health.ts:98,221-262`), and its currently-installed `coqui-tts` package version at `coqui_version` (Task 19, `:107-112`, `:297-298`) — surfaced server-side via `getLastKnownCoquiVersion()`. Confirm via `curl -s http://localhost:9000/health` or the Voices page's Coqui pill. Needed for all of Section E; a not-installed/no-weights Coqui makes E-01 through E-09 blocked, not failed. | |
| P-20 | `SEG_CAPACITY_ADMISSION` | `server/.env` line (ships `SEG_CAPACITY_ADMISSION=1`, `server/.env.example:126`). Sidecar default is **ON** when unset (`main.py:2978-2979` — anything but `"0"` enables). **No registry knob exists for this — it is env-only.** | |
| P-21 | Analyzer engine setting | Account → analyzer settings (or `~/.castwright/user-settings.json`). Record it; the analyzer competes for VRAM. | |
| P-22 | TTS engine setting (persisted account default) | Account settings → default TTS model. Record the **model key** (e.g. `qwen3-tts-0.6b`). | |
| P-23 | **Session model-key the picker is set to** | The Voices-page / top-bar engine picker writes a **session-only** `ui.ttsModelKey` that is *never persisted* and is what generation actually routes off. Record it explicitly — several tests (B-11, C-13) turn on the difference between this and P-22. | |
| P-24 | Which card is Qwen pinned to (if pinned) | `curl -s http://localhost:9000/capacity` and/or `curl -s http://localhost:8080/api/gpu/devices`; env pin via `_engine_env_pin("qwen")` | |
| P-25 | Sidecar autostart pref | `autoStartSidecar` in user settings — governs whether `npm start` owns the sidecar lifecycle (matters for the stop/restart tests C-08, C-12, D-03) | |

### 2.1 Starting the stack

| Goal | Command | Notes |
|---|---|---|
| Everything (frontend + server + sidecar) | `npm start` | `scripts/start-app.mjs`. Server owns the sidecar child process (per-user `autoStartSidecar`, default on). |
| Stop everything | `npm run stop` | `scripts/stop-app.ps1`. **Use this, not PID kills.** |
| Dev (HMR) frontend + server only | `npm run dev` | Vite on `http://localhost:5173`, server on `:8080`. Does **not** start the sidecar. |
| Sidecar alone | `npm run tts:sidecar` | `scripts/launch-sidecar.mjs`. Needed for the "stop just the sidecar" tests. |
| Production bundle | `npm run start:prod` | `scripts/start-app-prod.mjs`. |

> ⚠️ **Do NOT run in mock mode.** `.env.development` sets `VITE_USE_MOCKS` on for
> `npm run dev`'s frontend; mock mode exercises only the store/component seams
> and will fake every result in this sheet. Confirm you are hitting the real
> server (the wizard must produce a real entry directory on disk — see §3).

---

## 3. How to observe

Everything below is keyed off two variables. Set them once per PowerShell
session.

```powershell
# Take $WS from P-17 (GET /api/workspace -> .root), NOT from a guess.
$WS = (Invoke-RestMethod http://localhost:8080/api/workspace).root
$U  = '<voiceUuid>'          # the cloned voice under test
$K  = "qwen-$U"              # the qwen storage key every qwen artifact is named from
$KX = "xtts-$U"              # (3c) the coqui storage key every xtts artifact is named from
$WS
```

### 3.1 On-disk layout

| What | Path | Written by |
|---|---|---|
| Library entry dir | `$WS\voice-library\<voiceUuid>\` | `entryDir()` — `workspace/voice-library.ts:93` |
| Entry manifest | `$WS\voice-library\<voiceUuid>\voice.json` | atomic `voice.json.tmp` → rename, `voice-library.ts:151-159` (`writeEntry`) |
| Retained source recording | `$WS\voice-library\<voiceUuid>\master.wav` | `POST /clone` copies the candidate's `master.wav` in (`voice-library.ts:733`). Its filename is `entry.master.clipFile`, which the clone route always sets to the literal `master.wav`. |
| Ephemeral phase-1 candidate | `$WS\voice-library\_candidates\<candidateId>\{master.wav,candidate.json}` | `workspace/clone-candidate.ts:20-39`. Removed on a successful `POST /clone`. |
| Qwen artifact dir | `$WS\voices\qwen\` | `qwenVoicesDir()` — `workspace/paths.ts:289` |
| Base clone/design prompt | `$WS\voices\qwen\qwen-<uuid>.pt` | sidecar `_atomic_torch_save` (`main.py:202`) |
| Sidecar manifest | `$WS\voices\qwen\qwen-<uuid>.json` | sidecar `clone_voice` (`main.py:3946-3958`) / `design_voice` (`main.py:3834-3850`) |
| 1.7B-native derived prompt | `$WS\voices\qwen\qwen-<uuid>__1.7b.pt` | `_load_voice_prompt_17b` (auto-derive on 1.7B cache miss) |
| Preview design variants | `qwen-<uuid>-preview.pt`, `qwen-<uuid>-preview.json`, `qwen-<uuid>-preview__1.7b.pt` | the `preview:true` design path |
| **Designed** voice's retained clip (§2.3) | `$WS\voices\qwen\qwen-<uuid>__master.wav` | sidecar `design_voice` step 3b, `_atomic_wav_save` (`main.py:3862-3866`) |
| Preview design's retained clip | `$WS\voices\qwen\qwen-<uuid>-preview__master.wav` | same, on the preview key |
| Sample (audition) cache | `<repo>\server\audio\voices\` — files named `qwen-<uuid>-<modelKey>-<hash>.mp3` | `voice-sample-cache.ts:26-28`, `152-166`. **NOT under `$WS`.** Purged by `purgeVoiceSamples("qwen-<uuid>")`. |
| **(3c) Coqui artifact dir** | `$WS\voices\xtts\` | `xttsVoicesDir()` — `workspace/paths.ts` |
| **(3c) Latents artifact** | `$WS\voices\xtts\xtts-<uuid>.pt` | sidecar `_atomic_torch_save`, `CoquiEngine.clone_voice` |
| **(3c) Sidecar manifest** | `$WS\voices\xtts\xtts-<uuid>.json` | sidecar `CoquiEngine.clone_voice` |
| **(3c) Reference-audio temp WAV** | `$WS\voices\xtts\xtts-<uuid>.derive-src.tmp.wav` | sidecar `clone_voice`, deleted in a `finally` — survives **only** a hard process kill mid-derive. This IS the person's source recording, not a derived artifact — treat it with the same severity as `master.wav`. |
| **(3c) Sample (audition) cache** | `<repo>\server\audio\voices\` — files named `xtts-<uuid>-<modelKey>-<hash>.mp3` | Same cache, scoped by the `xtts-<uuid>` storage key — `POST /:voiceUuid/sample` derives `voiceName`/`cacheScope` from the requested `modelKey`'s engine (Task 27, `voice-library.ts:597-598`), so a `coqui-xtts-v2` sample request now writes here. **The My-voices card's own Play button now sends that `modelKey` when Qwen isn't ready** (`voice-library-card.tsx`'s `previewEngine`, GATE 1 F2) — a Qwen-stale/Coqui-ready entry lands under `xtts-<uuid>-*` here instead of always `qwen-<uuid>-*` — see §6 KL-o (fixed). |

> ⚠️ Spec §2.2 lists a `preview.mp3` in the entry dir. **3b1 deliberately does
> not write one** — the route comment at `voice-library.ts:656-662` states the
> on-disk layout for a cloned entry is `master.wav` + `voice.json` only, with
> the audition served on demand by `POST /:uuid/sample` + the sample cache.
> A missing `preview.mp3` is **not** a defect.

### 3.2 Copy-pasteable artifact listings (Windows / PowerShell)

**List every artifact for the voice under test (the exact set `purgeCloneArtifacts` targets):**

```powershell
$paths = @(
  "$WS\voices\qwen\$K.pt",
  "$WS\voices\qwen\$K.json",
  "$WS\voices\qwen\${K}__1.7b.pt",
  "$WS\voices\qwen\$K-preview.pt",
  "$WS\voices\qwen\$K-preview.json",
  "$WS\voices\qwen\${K}-preview__1.7b.pt",
  "$WS\voices\qwen\${K}__master.wav",
  "$WS\voices\qwen\${K}-preview__master.wav",
  "$WS\voice-library\$U\voice.json",
  "$WS\voice-library\$U\master.wav",
  # (3c) purgeCloneArtifacts also always sweeps these three — no-ops for a
  # voice that never touched Coqui, but part of the "exact set" this section
  # claims to list. See §3.1's "(3c)" rows / Section E.
  "$WS\voices\xtts\$KX.pt",
  "$WS\voices\xtts\$KX.json",
  "$WS\voices\xtts\$KX.derive-src.tmp.wav"
)
$paths | ForEach-Object {
  [pscustomobject]@{
    Exists = Test-Path $_
    Bytes  = if (Test-Path $_) { (Get-Item $_).Length } else { $null }
    Path   = $_
  }
} | Format-Table -AutoSize
```

**Wildcard sweep (catches anything the explicit list above misses, e.g. a `.tmp` left behind):**

```powershell
Get-ChildItem "$WS\voices\qwen" -Filter "$K*" | Select-Object Name,Length,LastWriteTime
Get-ChildItem "$WS\voice-library\$U" -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length
```

**Sample cache for this voice:**

```powershell
Get-ChildItem "$PWD\server\audio\voices" -Filter "$K-*" | Select-Object Name,Length,LastWriteTime
```

**Read the entry manifest (consent, master, fidelity, engine status):**

```powershell
Get-Content "$WS\voice-library\$U\voice.json" -Raw | ConvertFrom-Json |
  Select-Object voiceUuid,name,provenance,
    @{n='revokedAt';e={$_.consent.revokedAt}},
    @{n='clipFile';e={$_.master.clipFile}},
    @{n='cosine';e={$_.sampleMeta.qualityChecks.cloneCosine}},
    @{n='fidelityWarning';e={$_.sampleMeta.qualityChecks.cloneFidelityWarning}},
    @{n='fidelityUnavailable';e={$_.sampleMeta.qualityChecks.cloneFidelityUnavailable}},
    @{n='qwenStatus';e={$_.engines.qwen.status}},
    @{n='qwenBaseModel';e={$_.engines.qwen.baseModel}}
```

**Read the sidecar manifest (persona survival check, C-17):**

```powershell
Get-Content "$WS\voices\qwen\$K.json" -Raw | ConvertFrom-Json |
  Select-Object voiceId,voiceUuid,instruct,designModel,mintMethod,fallbackFor,baseModel,clone,refText
```

**Snapshot / diff the artifact set around an operation (revoke, delete, render):**

```powershell
function Snap { Get-ChildItem "$WS\voices\qwen" -Filter "$K*" | Select-Object Name,Length,LastWriteTime }
$before = Snap
# ... perform the operation ...
$after  = Snap
Compare-Object $before $after -Property Name,Length -PassThru | Format-Table -AutoSize
```

### 3.3 Where a generation failure lands

**Live (SSE):** the generation view's `chapter_failed` tick carries
`errorReason`, `errorCode`, `remediation`
(`server/src/routes/generation.ts:2082-2088`).

**Persisted (survives reload):** `<bookDir>\.audiobook\state.json`, per-chapter
(`server/src/workspace/scan.ts:115-136`):

| Field | Meaning |
|---|---|
| `generationState` | only ever `'failed'` |
| `generationError` | the human reason — for this arc, verbatim from `UnresolvableClonedVoiceError.message` |
| `generationErrorCode` | expect `cloned-voice-broken` |
| `generationRemediation` | the `FAILURE_REMEDIATIONS['cloned-voice-broken']` copy |

All four are **cleared on a successful render**.

```powershell
$BOOK = '<absolute path to the book dir>'   # from GET /api/workspace -> booksRoot, then <Author>\<Series>\<Title>
Get-Content "$BOOK\.audiobook\state.json" -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty chapters |
  Where-Object { $_.generationState -eq 'failed' } |
  Select-Object id,slug,generationState,generationErrorCode,generationError,generationRemediation |
  Format-List
```

**Chapter audio on disk** (the "produced no audio at all" check):

```powershell
Get-ChildItem "$BOOK\audio" | Select-Object Name,Length,LastWriteTime
```

**Cast assignment for a character** (the cloned slot):

```powershell
Get-Content "$BOOK\.audiobook\cast.json" -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty characters |
  Where-Object { $_.overrideTtsVoices.qwen.libraryUuid } |
  Select-Object id,name,ttsEngine,ttsModelKey,
    @{n='qwenName';e={$_.overrideTtsVoices.qwen.name}},
    @{n='libraryUuid';e={$_.overrideTtsVoices.qwen.libraryUuid}},
    @{n='provenance';e={$_.overrideTtsVoices.qwen.provenance}}
```

### 3.4 Logs

| Log | Path | Use |
|---|---|---|
| Server stdout | `<repo>\logs\server.log` | resolver decisions, `[voice-library]`, `[purge-clone-artifacts]`, `[clone-voice-resolver]` warnings |
| Server stderr | `<repo>\logs\server.err.log` | stack traces |
| Sidecar stdout | `<repo>\logs\tts.log` | `Cloned + cached Qwen voice '<id>' …`, per-op structured timing lines, `/qwen/clone-voice` errors |
| Sidecar stderr | `<repo>\logs\tts.err.log` | Python tracebacks |

Override the directory with `APP_LOG_DIR` (`scripts/start-app-prod.mjs:34`).

**Live tail (two panes):**

```powershell
Get-Content "$PWD\logs\server.log" -Wait -Tail 40
Get-Content "$PWD\logs\tts.log"    -Wait -Tail 40
```

**Prove no synth fired during a fail-fast (C-02):**

```powershell
# Note the file length before, then after; and grep for synth activity in the window.
Select-String -Path "$PWD\logs\tts.log" -Pattern 'synthesize|clone_voice|create_voice_clone_prompt' |
  Select-Object -Last 20
```

Key log strings to expect:

| String | Emitted by |
|---|---|
| `Cloned + cached Qwen voice '<voiceId>' from caller clip.` | `main.py:3969` — a real clone/re-derive happened |
| `[purge-clone-artifacts] failed to erase "<path>" for voice "<uuid>"` | a file survived a purge (C-21) |
| `[clone-voice-resolver] designed voice self-heal failed for "<name>" (<uuid>)` | §2.3 self-heal swallowed a failure |
| `[clone-voice-resolver] designed self-heal for "<name>" … failed to restore its sidecar manifest` | persona restore write failed |
| `[voice-library] revoke for "<uuid>" left N artifact(s) un-erased` | partial erasure (C-21) |

### 3.5 Useful API probes

```powershell
# List the library
Invoke-RestMethod http://localhost:8080/api/voice-library | ConvertTo-Json -Depth 6

# Ingest a clip (phase 1) — multipart field name MUST be `audio`
curl.exe -s -X POST http://localhost:8080/api/voice-library/clone-sample `
  -F "audio=@C:\fixtures\clean-10s.wav" -F "captureMethod=upload"

# Revoke
Invoke-RestMethod -Method Post "http://localhost:8080/api/voice-library/$U/revoke" | ConvertTo-Json -Depth 6

# Audition / sample
Invoke-RestMethod -Method Post "http://localhost:8080/api/voice-library/$U/sample" `
  -ContentType 'application/json' -Body '{}'

# Delete (usage-scan first; add ?confirm=1 to force)
Invoke-RestMethod -Method Delete "http://localhost:8080/api/voice-library/$U"
Invoke-RestMethod -Method Delete "http://localhost:8080/api/voice-library/$U`?confirm=1"
```

---

## 4. Test fixtures to prepare

Prepare these **before** starting. Put them somewhere stable, e.g.
`C:\fixtures\fs38\`, and record the exact paths in the table.

| ID | Fixture | Spec | How to make it | Used by | Path (fill in) |
|---|---|---|---|---|---|
| F-1 | **Clean ≥8 s recording** | ≥8 s, one speaker, quiet room, RMS well above −45 dBFS, no clipping. 15–25 s is ideal (ingest caps at 60 s). | Record yourself reading two or three sentences. WAV or MP3. | A-01, B-01, B-04, B-08…, most of C | |
| F-2 | **Too-short clip (<4 s)** | ~2 s | `ffmpeg -i F-1 -t 2 short-2s.wav` | A-02 | |
| F-3 | **Near-silent clip** | ≥8 s, RMS ≤ −45 dBFS | `ffmpeg -i F-1 -af "volume=-60dB" -t 10 silent-10s.wav` | A-03 | |
| F-4 | **Borderline 4–8 s clip** | ~6 s, otherwise clean | `ffmpeg -i F-1 -t 6 short-6s.wav` | A-04 | |
| F-5 | **Clipped / too-loud clip** | ≥8 s with >0.5 % of samples at/above −0.1 dBFS | `ffmpeg -i F-1 -af "volume=25dB" -t 10 clipped-10s.wav` | A-05 | |
| F-6 | **Over-cap clip (>60 s)** | ~90 s | `ffmpeg -i F-1 -filter_complex "aloop=loop=8:size=2e9" -t 90 long-90s.wav` | A-06 | |
| F-7 | **Browser-recorder capture (webm/opus)** | Produced live by the in-app recorder — `VoiceRecorder` builds the Blob as `type: 'audio/webm'` (`src/components/voices/voice-recorder.tsx:19`) | Nothing to pre-make; produced during A-07. Keep a copy if you can, for re-use. | A-07, B-02 | |
| F-8 | **Low-fidelity clip** | A clip that will score a *low* ECAPA cosine against its own clone — e.g. F-1 heavily noised or band-limited: `ffmpeg -i F-1 -af "highpass=f=800,lowpass=f=2000,volume=-8dB" lowfi.wav` | Advisory warning fires below `CLONE_FIDELITY_MIN = 0.3` (`server/src/tts/clone-fidelity.ts:16`). ⚠️ Not guaranteed to trip on the first try — iterate the filter until the persisted `cloneCosine` is < 0.30. | B-06 | |
| F-9 | **A second, different speaker's clean clip** | ≥8 s | Any second voice. | D-01 (two books, two voices), C-03 | |

### 4.1 The book to render

Use the repository's canonical end-to-end fixture manuscript:

**`server/src/__fixtures__/the-coalfall-commission.md`** — *The Coalfall
Commission*, a Castwright-owned original, committed and safe to use freely.
Language variants alongside it (not needed here):
`the-coalfall-commission.ru.md`, `.ru-dash.md`, `.ja.md`, `.zh.md`.

Import it once, run analysis, and confirm the cast. You need a book with:

- at least **two speaking characters** in a single chapter (for C-03's
  "unrelated broken voice" case),
- at least **two chapters** with the same character speaking (for B-10's
  cross-chapter consistency check),
- a **chapter title** that narrates (for C-05's title-beat path).

Record the resolved book directory and chapter slugs here:

| Item | Value (fill in) |
|---|---|
| Book id | |
| Book dir (absolute) | |
| Chapter under test (id / slug) | |
| Second chapter (id / slug) | |
| Cloned character (id / name) | |
| Second character (id / name) | |

---

## 5. The acceptance tests

Legend for the result column: **P** pass · **F** fail · **B** blocked · **N/A**
not applicable (say why).

---

### Section A — 3a: ingest, quality gate, consent, recorder

Thresholds under test, from `server/src/tts/clone-quality.ts:10-14` and
`clone-ingest.ts:10-11`:

| Threshold | Value | Effect |
|---|---|---|
| `MIN_FATAL_S` | 4 s | below → **fatal** (400) |
| `SILENCE_DBFS` | −45 dBFS RMS | at/below → **fatal** (400) |
| `MIN_GOOD_S` | 8 s | 4 s ≤ d < 8 s → **warn**, proceed |
| `CLIP_DBFS` / `CLIP_FRACTION` | −0.1 dBFS / 0.5 % of samples | above → **warn**, proceed |
| `MAX_SECONDS` | 60 s | input is **truncated** before the gate runs |
| `SAMPLE_RATE` | 24 000 Hz | everything is decoded/normalised to this |

---

#### A-01 — A clean ≥8 s clip ingests into a candidate with a Whisper transcript

**Proves:** the 3a ingest pipeline end to end (decode → gate → cap → WAV →
candidate store → transcript) and 267 Invariant 3 (`master.wav` is a real
RIFF/WAVE file written without a second ffmpeg spawn).

**Preconditions:** server + sidecar up; P-15 (Whisper) satisfied; fixture F-1.

**Steps**
1. `curl.exe -s -X POST http://localhost:8080/api/voice-library/clone-sample -F "audio=@<F-1>" -F "captureMethod=upload"`
2. Note the returned `candidateId`.
3. `Get-ChildItem "$WS\voice-library\_candidates\<candidateId>"`
4. Inspect the WAV header: `Get-Content "$WS\voice-library\_candidates\<candidateId>\master.wav" -AsByteStream -TotalCount 12` (Windows PowerShell 5.1: `-Encoding Byte -TotalCount 12`).

**Expected**
- HTTP **202**, body `{ candidateId, transcript, durationSeconds, sampleRate, qualityWarnings }`.
- `qualityWarnings` is an **empty array**.
- `sampleRate` is **24000**.
- `durationSeconds` within ~0.1 s of the clip's real length.
- `transcript` is a non-empty string that plausibly matches what you said.
- The candidate dir contains **`master.wav` and `candidate.json`**.
- The first 12 bytes of `master.wav` are `52 49 46 46 .. .. .. .. 57 41 56 45` (`RIFF`…`WAVE`).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-02 — A clip under 4 s is rejected with a duration message

**Proves:** the fatal duration threshold (267 Invariant 2).

**Preconditions:** fixture F-2 (~2 s).

**Steps**
1. `POST /api/voice-library/clone-sample` with F-2.

**Expected**
- HTTP **400**.
- `error` reads exactly: `Sample too short (2.0s) — need at least 4s.` (the number matches the clip; format is one decimal place).
- **No** candidate directory is created for this attempt.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-03 — A near-silent clip is rejected

**Proves:** the silence threshold (RMS ≤ −45 dBFS is fatal).

**Preconditions:** fixture F-3 (≥8 s, ~−60 dB).

**Steps**
1. `POST /api/voice-library/clone-sample` with F-3.

**Expected**
- HTTP **400**, `error` = `Sample is silent or too quiet — record closer to the mic.`
- Note the ordering: duration is checked **first**, so F-3 must be ≥4 s or you will get the A-02 message instead.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-04 — A 4–8 s clip warns but proceeds

**Proves:** the short-but-usable warn tier is non-blocking.

**Preconditions:** fixture F-4 (~6 s).

**Steps**
1. `POST /api/voice-library/clone-sample` with F-4.
2. In the UI: open `#/voices` → My voices → **Clone a voice** → Upload tab → pick F-4.

**Expected**
- HTTP **202** (not 400).
- `qualityWarnings` contains exactly one entry: `Sample is a little short (6.0s) — 8s+ clones better.`
- In the wizard, the warning renders in amber under the transcript, and **Continue is still reachable** once consent is complete.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-05 — A clipping clip warns but proceeds

**Proves:** the clipping warn tier is non-blocking.

**Preconditions:** fixture F-5.

**Steps**
1. `POST /api/voice-library/clone-sample` with F-5.

**Expected**
- HTTP **202**.
- `qualityWarnings` contains `Audio is clipping — lower the input level or move back from the mic.`
- If F-5 is also <8 s you will see **both** warnings; either is acceptable so long as the clipping one is present.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-06 — A clip longer than 60 s is silently capped, not rejected

**Proves:** `MAX_SECONDS = 60` truncation happens **before** the quality gate
(`clone-ingest.ts:41-45`), so a long clip is usable rather than an error.

**Preconditions:** fixture F-6 (~90 s).

**Steps**
1. `POST /api/voice-library/clone-sample` with F-6.
2. Check the candidate's `master.wav` size.

**Expected**
- HTTP **202**, no error.
- `durationSeconds` reads **≈ 60.0** (not 90).
- `master.wav` is ≈ 60 × 24000 × 2 = 2,880,000 bytes plus a 44-byte header.
- No warning about length (60 s ≥ 8 s).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-07 — The browser recorder path (webm/opus) ingests end to end

**Proves:** the MediaRecorder capture path — the one 3a acceptance gate that
mock/unit coverage genuinely cannot stand in for. `VoiceRecorder` emits a Blob
with `type: 'audio/webm'` (`voice-recorder.tsx:19`), which must survive ffmpeg
decode.

**Preconditions:** a real browser with a working mic and permission **granted**.

**Steps**
1. Open the app, go to `#/voices` → My voices → **Clone a voice**.
2. Stay on the **Record** tab. Click record, speak for ≥10 s, stop.
3. Watch `logs\server.log` and the network tab for the `POST /api/voice-library/clone-sample` request (`captureMethod=record`).
4. Confirm the transcript populates in the wizard.
5. Confirm on disk that a candidate dir now exists with a `master.wav`.

**Expected**
- The recorder shows an idle → recording → recorded progression and offers a re-take.
- The upload is `multipart/form-data` with field name **`audio`** and `captureMethod=record`.
- HTTP **202**; a transcript appears in the editable Transcript textarea.
- `candidate.json` records `"captureMethod": "record"` and `"transcriptSource": "whisper"`.
- The candidate `master.wav` is a valid RIFF/WAVE (webm/opus decoded cleanly).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-08 — Mic-permission denial falls back to Upload rather than dead-ending

**Proves:** 267 Invariant 6 — the recorder's `denied` phase.

**Preconditions:** a browser where you can revoke mic permission for the origin
(Chrome: site settings → Microphone → Block), then reload.

**Steps**
1. With the mic **blocked**, open `#/voices` → Clone a voice → Record tab.
2. Click record.

**Expected**
- The component enters the `denied` phase and renders copy to the effect of:
  `Mic access was blocked. Enable microphone permission or use the Upload tab instead.`
- The **Upload** tab is still present and functional — switching to it and
  picking F-1 completes phase 1 normally.
- No dead control, no silent no-op, no thrown error in the console that breaks
  the modal.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-09 — Consent gates Continue

**Proves:** the phase-1 gate — Continue requires a candidate **and** a non-empty
person name **and** the attest checkbox (`clone-capture-panel.tsx:33-34`).

**Preconditions:** a successful ingest (A-01 or A-07) in the open wizard.

**Steps**
1. With a good sample ingested, leave **Person's name** empty → observe Continue.
2. Type a name but leave the **"I attest…"** checkbox unticked → observe Continue.
3. Tick attest → observe Continue.
4. Untick attest again → observe Continue.

**Expected**
- Continue is **disabled** in steps 1, 2 and 4; **enabled** only in step 3.
- The relationship `<select>` defaults to `self` and does not itself gate Continue.
- The attest copy reads: `I attest I have this person's permission to clone their voice.`

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-10 — The write-time consent guard refuses a half-formed cloned entry

**Proves:** 267 Invariant 1 + Invariant 8 — `writeEntry()` throws
`ConsentRequiredError` for a `cloned` entry with structurally-invalid consent,
and `POST /clone` calls `writeEntry` **last**, so nothing lands on disk.

**Preconditions:** a fresh candidate from A-01 (note its `candidateId`).

**Steps**
1. Snapshot the library dir: `Get-ChildItem "$WS\voice-library" -Directory`.
2. `POST /api/voice-library/clone` with a body whose consent is incomplete (no `personName`):

   ```powershell
   $body = @{ candidateId = '<candidateId>'; consent = @{ relationship = 'self' }; name = 'Guard test' } | ConvertTo-Json
   Invoke-RestMethod -Method Post http://localhost:8080/api/voice-library/clone -ContentType 'application/json' -Body $body
   ```

3. Re-list the library dir and the qwen artifact dir.

**Expected**
- HTTP **422**, error names a complete consent record as required.
- **No new entry directory** under `$WS\voice-library\`.
- **No** new `qwen-*.pt` under `$WS\voices\qwen\`.
- The candidate under `_candidates\` is **still there** (not consumed).
- Also confirm the plain-missing case: `POST /clone` with no `candidateId` → **400**;
  with an unknown `candidateId` → **404**.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-11 — `/revoke` stamps `revokedAt` and leaves the rest of consent intact

**Proves:** 267 Invariant 1's C2 carve-out — `revokedAt` is orthogonal to
structural consent validity, so the revoke write passes the same guard.

**Preconditions:** a **real cloned entry** (produced by B-01). Run this after
B-01, on a clone you are willing to lose.

> ⚠️ **Destructive.** Since the 3b2 fix wave, revoke also erases the recording
> and every derived artifact (see C-10). Plan to re-clone afterwards.

**Steps**
1. Record the pre-state: `voice.json`'s `consent` block.
2. `Invoke-RestMethod -Method Post "http://localhost:8080/api/voice-library/$U/revoke"`
3. Re-read `voice.json`.
4. Also check the two error paths: revoke an unknown uuid; revoke an entry with
   no consent record (e.g. a **designed**/promoted voice).

**Expected**
- HTTP **200**; the response body is the **re-read** entry (so `master` is now
  absent — the route re-reads after the purge, `voice-library.ts:980`).
- `consent.revokedAt` is now an ISO-8601 timestamp.
- `consent.personName`, `.relationship`, `.permittedUse`, `.attestedAt`,
  `.attestedBy` are **unchanged**.
- The entry directory and `voice.json` **still exist** (revoke is not delete).
- Unknown uuid → **404**. Entry with no consent → **409**
  `Entry has no consent record to revoke.`

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-12 — The sample/play route refuses a revoked cloned voice

**Proves:** 267 Invariant 4 — `voice-library.ts:428-430`.

**Preconditions:** the revoked entry from A-11, plus one healthy clone for the
control.

**Steps**
1. On a **healthy** clone, `POST /api/voice-library/<uuid>/sample` with `{}` →
   confirm it returns a URL and plays.
2. On the **revoked** entry, `POST /api/voice-library/$U/sample`.
3. In the UI, open `#/voices` and click Play on the revoked card.

**Expected**
- Healthy entry → **200** `{ url, cached }`, audio plays.
- Revoked entry → **403**, error exactly:
  `This cloned voice has no valid consent and cannot be played.`
- The UI surfaces the error rather than silently playing a cached file.
- ⚠️ Cache interaction: `purgeCloneArtifacts` calls
  `purgeVoiceSamples("qwen-<uuid>")` on revoke, so previously-cached mp3s under
  `server\audio\voices\` should also be gone — verify with the §3.2 sample-cache
  listing. A surviving cached mp3 alongside a correct 403 still passes **this**
  test, but record it as a C-10 finding.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### A-13 — The voice library is unconditionally available

**Proves:** the `voices.library.enabled` flag is gone and cannot be resurrected
by a stale persisted override.

**Preconditions:** none. There is no longer any setting that hides the library.

**Steps**
1. Add `"voices.library.enabled": false` by hand to the config overrides in
   `~/.castwright/user-settings.json` (simulating a user who flipped the old
   knob before it was removed), then restart the server.
2. `GET /api/voice-library` and `POST /api/voice-library/clone-sample`.
3. Open `#/voices`, then open a character's profile drawer from the Cast view.

**Expected**
- Neither route 404s — the stale override is inert. `GET` returns the entry
  list; the bodyless `POST` returns its normal **400** validation error, which
  is a pass here, not a failure.
- **My voices** and the "Clone a voice" CTA are present.
- The profile drawer's assign / "Save to my voices" actions work rather than
  failing against dead routes (the failure mode that motivated the removal).
- No "Voice library" group appears in Advanced settings.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

### Section B — 3b1: the first real clone on Qwen

Run **B-01 first** — most of Section C depends on a healthy cloned voice
existing. Record its uuid at the top of your notes; it is `$U` for the rest of
the sheet.

---

#### B-01 — Wizard happy path via **Upload** → a ready cloned entry

**Proves:** 267 Invariant 8 (never persisted half-formed — derive → fidelity →
`writeEntry` last) and the whole 3b1 orchestration.

**Preconditions:** Qwen weights present (P-13); ECAPA `/embed` reachable (P-16);
fixture F-1; session engine = Qwen (P-23).

**Steps**
1. Snapshot `Get-ChildItem "$WS\voice-library" -Directory` and `Get-ChildItem "$WS\voices\qwen"`.
2. `#/voices` → My voices → **Clone a voice**.
3. Upload tab → F-1. Wait for the transcript.
4. Person's name = a real name; relationship = `self`; tick attest. **Continue**.
5. Name the voice (or leave blank — it defaults to the person's name). **Save**.
6. Watch `logs\tts.log` for `Cloned + cached Qwen voice 'qwen-<uuid>' from caller clip.`
7. When the completion screen appears, press the audition play control.
8. Close the wizard; find the new card in My voices.
9. Run the §3.2 artifact listing for the new uuid.

**Expected**
- A progress state, then a **completion screen** reading `Cloned "<name>".` with
  a play/stop control.
- HTTP **200** from `POST /api/voice-library/clone`, body = the `VoiceLibraryEntry`.
- On disk, **new**:
  - `$WS\voice-library\<uuid>\voice.json`
  - `$WS\voice-library\<uuid>\master.wav`
  - `$WS\voices\qwen\qwen-<uuid>.pt`
  - `$WS\voices\qwen\qwen-<uuid>.json` with `"clone": true`, `"designModel": null`,
    `"refText"` = the Whisper transcript
- **No** `preview.mp3` in the entry dir — expected, see §3.1.
- The `_candidates\<candidateId>\` dir is **gone** (consumed).
- `voice.json` shows `provenance: "cloned"`, `engines.qwen.status: "ready"`,
  a non-empty `engines.qwen.baseModel`, a complete `consent` block with **no**
  `revokedAt`, and `master.clipFile: "master.wav"`.
- The new card carries the **'Cloned'** badge and a **Revoke** action, and
  **no** state chip (it is healthy).

**Record:** `$U` = ____________________  `baseModel` = ____________________

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-02 — Wizard happy path via **Record**

**Proves:** the record-capture variant reaches the same persisted shape as the
upload variant (the webm/opus path all the way through derive, not just ingest).

**Preconditions:** as B-01 but using the mic (A-07 must have passed).

**Steps**
1. Repeat B-01 steps 2–9, but record live on the **Record** tab instead of uploading.

**Expected**
- Same as B-01, plus: the candidate's `candidate.json` recorded
  `captureMethod: "record"`, and the persisted entry's
  `master.captureMethod` is `"record"`.
- Audition plays and is recognisably the recorded speaker.

**Record:** second `$U` (keep for D-01) = ____________________

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-03 — The audition **sounds like the person**

**Proves:** 267's owed on-box item (a) — the qualitative half. This is the one
test the automated suite fundamentally cannot make.

**Preconditions:** B-01 complete; the original F-1 clip to hand.

**Steps**
1. Play F-1 (the source clip).
2. Play the wizard audition immediately after.
3. Play the library card's sample (`POST /:uuid/sample`) — a **fresh synth off
   the `.pt`**, not the wizard's in-memory preview, so it is an independent read.
4. Ask a second listener, if one is available, to say whether they are the same
   speaker without being told which is which.

**Expected**
- The audition is clearly the **same speaker** — timbre, pitch range and accent
  carry over. Prosody will differ (different words); that is fine.
- It is **not** a generic Qwen/Kokoro stock voice.
- No pangram/prompt bleed (the audition speaks only the audition line, not
  fragments of the reference transcript).

**Verdict (circle):** same speaker / arguably same / clearly different

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-04 — The ECAPA cosine is a **real** number, not a mock constant

**Proves:** 267's owed on-box item (a) — "the ECAPA cosine reads sane (not
clamped to a mock constant)".

**How to see the real value:** it is persisted on the entry at
`sampleMeta.qualityChecks.cloneCosine` (`voice-library.ts:755-764`). It is
computed by `assessCloneFidelity` → `cosineToCentroid` over two live
`POST /embed` calls against the sidecar; there is **no** hardcoded fallback on
the real path. The mock path (`src/mocks/`) is only reachable with
`VITE_USE_MOCKS` on, which this run must not use (§2.1).

**Steps**
1. Read it:
   ```powershell
   (Get-Content "$WS\voice-library\$U\voice.json" -Raw | ConvertFrom-Json).sampleMeta.qualityChecks
   ```
2. Clone the **same** fixture a second time under a different name and read its cosine.
3. Clone the **low-fidelity** fixture F-8 and read its cosine (this doubles as B-06 setup).
4. Confirm the sidecar actually served `/embed` — check `logs\tts.log` around the clone timestamp.

**Expected**
- `cloneCosine` is a **finite number**, typically in roughly **0.4 – 0.95** for a
  clean same-speaker pair. Anything outside `[-1, 1]` is a defect.
- The two clones of the same fixture give **similar but not byte-identical**
  values — proof it is being computed, not stubbed. Two *identical* values to
  full float precision across different clones is the mock-constant smell:
  investigate before passing.
- F-8's cosine is **materially lower** than F-1's.
- `cloneFidelityUnavailable` is **absent** when `/embed` is reachable.

**Record:** F-1 cosine run 1 = ______ run 2 = ______ · F-8 cosine = ______

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-05 — Fidelity-unavailable is advisory, not fatal

**Proves:** the Task-10 carve-out — a merely-unreachable `/embed` (or a
`NoCapacityError`) must **not** abort a clone whose `.pt` is already written
(`voice-library.ts:712-722`).

**Preconditions:** a way to make `/embed` fail transiently while `/qwen/clone-voice`
still works. Practical options, in order of preference:
1. Fill the GPU so `/embed`'s capacity admission returns 503 (start a large
   render on the same card, then clone). ⚠️ Timing-sensitive.
2. ⚠️ **verify on box** — if you have a way to point the ECAPA embed client at a
   dead port independently of the synth path, use it. There is no dedicated
   config knob for this in the registry; the embed client shares
   `getResolvedSidecarUrl()`, so pointing it away also breaks the clone itself.
   If neither option works, mark this **N/A / blocked** and rely on the
   automated coverage in `voice-library.test.ts`.

**Steps**
1. Arrange the transient `/embed` failure.
2. Run the wizard to Save with F-1.

**Expected**
- The clone still **succeeds** (200), the entry is persisted, the `.pt` exists.
- `sampleMeta.qualityChecks` = `{ cloneFidelityUnavailable: true }` with **no**
  `cloneCosine`.
- No orphaned `.pt` without an entry, and no leaked `_candidates\` dir.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-06 — A low-fidelity clip surfaces the advisory warning but still saves

**Proves:** the advisory-not-blocking design — `CLONE_FIDELITY_MIN = 0.3`
(`clone-fidelity.ts:16`).

**Preconditions:** fixture F-8, iterated until its cosine lands **below 0.30**
(see B-04 step 3).

**Steps**
1. Run the wizard to Save with F-8.
2. Read `sampleMeta.qualityChecks` on the persisted entry.

**Expected**
- The clone **saves** (200) — the warning never blocks.
- The completion screen shows the advisory line, beginning
  `This clone sounds only loosely like the sample (similarity 0.NN).`
- `voice.json` carries both `cloneCosine` (< 0.30) and `cloneFidelityWarning`.
- The card still appears in My voices and is assignable.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-07 — Assign a cloned voice to a character

**Proves:** the assign write shape — `overrideTtsVoices.qwen` gains
`name`/`libraryUuid`/`provenance`, `character.voiceUuid` is untouched, and any
prior emotion `variants` map is dropped (`voice-library.ts`, the `/assign`
handler's `nextCharacters` build, ~`:1222-1246`).

> ⚠️ **Wave 3c (Task 24) changed this beyond a Qwen-only write.** Every
> CLONED entry now qualifies for `shouldWriteCoquiSlot`
> (`voice-library.ts:1132-1134`), so assigning a cloned voice writes **both**
> `overrideTtsVoices.qwen` AND `overrideTtsVoices.coqui` in the same call —
> `coqui` is no longer merely a "sibling slot that survives", it is actively
> written here (see E-08, which tests this same write from the Section-E
> side). Only the FIRST bullet under Expected below is still purely
> Qwen-scoped from B-01/B-07's own frame; the last bullet is corrected.

**Preconditions:** B-01's clone; the Coalfall book analysed and cast confirmed;
the target character routes to **Qwen** (either the book/session default is Qwen
or the character carries `ttsEngine: 'qwen'`).

**Steps**
1. Snapshot `cast.json` for the target character (see the §3.3 cast query).
2. Assign via **either** surface — do both if time allows:
   - Profile drawer → My voices picker → pick the cloned card.
   - `#/voices` My voices card → **Assign** → pick the character.
3. Re-read `cast.json`.

**Expected**
- HTTP **200** `{ updated: 1 }`.
- The character's `overrideTtsVoices.qwen` now has
  `name: "qwen-<uuid>"`, `libraryUuid: "<uuid>"`, `provenance: "cloned"`.
- `character.voiceUuid` is **unchanged**.
- `overrideTtsVoices.qwen.variants` is **absent/undefined** (dropped).
- The character's `overrideTtsVoices.coqui` is **also now written** —
  `name: "xtts-<uuid>"`, `libraryUuid: "<uuid>"`, `provenance: "cloned"`,
  `variants` absent — same as the qwen slot, per Task 24 (see the warning
  above and E-08). A genuinely unrelated sibling slot (e.g. `kokoro`, if the
  character had one) still survives untouched.
- Other characters in `cast.json` are untouched.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-08 — The cast sample plays in the cloned voice

**Proves:** the assignment is live end-to-end through the audition path, and the
sample cache is scoped per library voice (`cacheScope = "qwen-<uuid>"`).

**Steps**
1. In the cast view / profile drawer, press Play on the assigned character.
2. Listen.
3. `Get-ChildItem "$PWD\server\audio\voices" -Filter "$K-*"` — confirm a cached mp3 appeared.
4. Press Play again and confirm it is served from cache (`cached: true` if you
   watch the API response).

**Expected**
- The sample is unmistakably the cloned speaker (same verdict as B-03), not a
  Kokoro/Qwen stock voice.
- A cache file named `qwen-<uuid>-<modelKey>-<hash>.mp3` exists.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-09 — A chapter renders in the cloned voice and stays consistent across lines

**Proves:** the first half of 267's owed item (a) — "renders recognisably and
consistently in the cloned voice across multiple lines".

**Preconditions:** B-07 done; the cloned character has **≥6 lines** in the
chapter under test.

**Steps**
1. Generate the chapter.
2. Confirm it completes (`state.json` has no `generationState: 'failed'` for it,
   and `<bookDir>\audio\<slug>.mp3` exists with a plausible length).
3. Listen to **every** line spoken by the cloned character — not just the first.
4. Note the elapsed wall-clock and whether any re-derive occurred
   (`logs\tts.log` → `Cloned + cached Qwen voice`; there should be **none** on a
   healthy voice).

**Expected**
- Chapter completes; no `cloned-voice-broken`.
- Every one of the character's lines is the **same** cloned voice — no drift to
  a different timbre partway through, no line rendered in a stock voice.
- Other characters render in their own (non-cloned) voices as before.
- No `Cloned + cached Qwen voice` line in the sidecar log for this run (the
  voice was Healthy — the resolver did no derive).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-10 — Consistency holds **across chapters**

**Proves:** the per-chapter pre-pass re-resolving the voice each chapter does not
change the rendered identity.

**Steps**
1. Generate the second chapter in which the cloned character speaks.
2. A/B a line from chapter 1 against a line from chapter 2.

**Expected**
- Same voice, indistinguishable identity across chapters.
- Both chapters complete; no re-derive fired between them.
- `voice.json`'s `engines.qwen.baseModel` is unchanged from B-01.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-11 — Assigning an **un-derived** cloned voice 409s

**Proves:** 267 Invariant 10 — the assign-readiness gate
(`voice-library.ts`, the `/assign` handler, ~`:1094-1096`). Still gated
purely on `engines.qwen.status` even after Wave 3c — a cloned entry whose
Coqui side is broken/stale but whose Qwen side is `ready` still passes this
specific gate; there is no equivalent Coqui-side readiness check here.

**Preconditions:** a cloned entry whose `engines.qwen.status !== 'ready'`. The
wizard never produces one, so create it deliberately:

```powershell
# Work on a THROWAWAY clone. Edit the manifest by hand:
$p = "$WS\voice-library\$U\voice.json"
$j = Get-Content $p -Raw | ConvertFrom-Json
$j.engines.qwen.status = 'stale'
$j | ConvertTo-Json -Depth 10 | Set-Content $p -Encoding utf8
```

**Steps**
1. Attempt to assign that entry to a Qwen-routed character (UI or API).
2. Restore `status` to `ready` afterwards.

**Expected**
- HTTP **409**, error `Cloned voice is not ready to assign yet.`
- `cast.json` is **not** modified.
- The UI surfaces the message rather than appearing to succeed.
- Also confirm the revoked-entry guard on the same route: assigning a **revoked**
  cloned entry → **409** `Consent for this voice has been revoked.`

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-12 — `POST /qwen/clone-voice` under **capacity admission ON**

**Proves:** the known automated-coverage gap carried from 267 (M4) into 268 — the
sidecar's `if _capacity_admission_enabled(): with _placement.reservation(...)`
branch, specifically `/qwen/clone-voice`'s own copy at `main.py:7671-7676`
(there are now many such call sites across the sidecar's engines — the file
grew substantially in Wave 3c — this is the one to watch for THIS test), which
pytest never exercises because admission is off in the test env.

**How admission is controlled:** environment variable **`SEG_CAPACITY_ADMISSION`**,
read by `_capacity_admission_enabled()` at `main.py:2978-2979` (moved from the
pre-3c `:2379-2380` — the file grew ~600 lines before this function during
Wave 3c). **Anything except the literal `"0"` — including unset — means ON.**
`server/.env` ships `SEG_CAPACITY_ADMISSION=1` (`server/.env.example:126`).
**There is no config-registry knob for it** — it is env-only, so it must be
set in `server/.env` (or the sidecar's environment) and the sidecar restarted.

**Steps**
1. Confirm admission is **ON**: `SEG_CAPACITY_ADMISSION` is `1` or absent in
   `server/.env`; restart the sidecar; note the resolved value in P-20.
2. Run a normal clone (B-01 flow). Record which device the reservation landed on
   — `curl -s http://localhost:9000/capacity`, and the structured line in
   `logs\tts.log`.
3. Now force the **no-capacity** branch: occupy the target card (start a large
   render, or load Coqui + Qwen 1.7B together on the 8 GB card), then clone again.
4. Optionally A/B: set `SEG_CAPACITY_ADMISSION=0`, restart the sidecar, clone
   again, and confirm the clone still works via the non-admitted path
   (the `else:` branch right after the reservation block, `main.py:7683-7687`).
   **Restore it to `1` afterwards.**

**Expected**
- Step 2: clone succeeds; the reservation names a concrete device
  (`cuda:0` = 4070 8 GB, or `cuda:1` = 5070 Ti 16 GB). **Record which card.**
- Step 3: when capacity is genuinely unavailable the sidecar returns **503** with
  `{ noCapacity: true, neededMb, deviceKey }`; the server maps it through
  `deriveEngineArtifact`'s `withCapacityRetry`, and the wizard surfaces a
  retryable failure rather than a silent success or a corrupt entry. **Crucially:
  no partial entry is written** — re-run the §3.2 listing and confirm no orphan
  `.pt`/entry dir for the aborted uuid.
- Step 4: identical user-visible outcome with admission off.

**Record:** device used = ______  · `neededMb` on the 503 = ______

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### B-13 — Sidecar failure status is preserved, not flattened

**Proves:** 267 Invariant 11 (regression class of #1801) plus the #1822 status
policy — a sidecar 5xx passes through, a sidecar 4xx surfaces as **502** (the
sidecar rejected *our* request, not the client's).

**Steps**
1. Stop the sidecar entirely (`npm run stop`, or kill just the sidecar process).
2. Run the wizard to Save with a valid candidate.
3. Restart the sidecar. Now provoke a sidecar-side 4xx: ⚠️ **verify on box** — the
   cleanest route is a direct call omitting a required header:
   ```powershell
   curl.exe -s -o NUL -w "%{http_code}\n" -X POST http://localhost:9000/qwen/clone-voice `
     -H "X-Voice-Id: qwen-probe" --data-binary "@<F-1 raw pcm or any bytes>"
   ```
   (missing `X-Sample-Rate` → 400 from the sidecar).

**Expected**
- Step 2: the wizard shows a **failure**, not a fake success. HTTP from
  `POST /api/voice-library/clone` is **503** (sidecar unreachable maps through
  `httpStatusForSidecarError`), **not** a generic 500.
- **Nothing is persisted**: no entry dir, no `.pt`, and the `_candidates\` dir
  survives for a retry.
- Step 3: the sidecar itself returns **400** for the missing header.
- ⚠️ Confirm on box that a sidecar 4xx surfaced through `POST /api/voice-library/clone`
  reads as **502** to the browser (per the #1822 policy comment at
  `voice-library.ts:1024-1030`, moved from the pre-3c `:793-802`), not 4xx.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

### Section C — 3b2: resolver, lifecycle, erasure, failure modes

One test per invariant in plan 268, plus the failure modes. **C-01 is the
highest-value test in this sheet — do not skip it.**

Reset ritual between destructive tests: re-run B-01 to mint a fresh healthy
clone, re-assign it (B-07), and update `$U`/`$K`.

---

#### C-01 — ⭐ **Revoke lands while a repair derive is in flight**

**Proves:** the post-derive re-read + re-purge guard (review C-1,
`statusStampMutate`, `clone-voice-resolver.ts:360-375`, invoked from inside
`deps.updateEntry`'s per-uuid lock at the success/failure write sites around
`:482-491`/`:509-515` — this closure replaced the earlier standalone
`guardPostDeriveWrite` function during the Wave 3c multi-engine rework, same
behaviour, new name/shape). This is the one race the whole lifecycle design
turns on: a GPU derive takes seconds, and a revoke landing inside that window
must not be resurrected by the derive's own post-write.

**Preconditions:** a healthy, assigned clone (`$U`); a chapter where that
character speaks; the sidecar up and Qwen warm (so the derive is fast but not
instant). Have **two** windows ready: the app (or a curl shell) for revoke, and
the generation view.

**How to hit the window** — the derive is the *only* thing happening between the
pre-pass starting and the first synth call, and it takes **seconds** (a real
`create_voice_clone_prompt` on a ~15 s clip). Make it repairable first, so the
render is guaranteed to derive:

```powershell
# 1. Force Repairable: delete the .pt but leave the manifest and master.wav alone.
Remove-Item "$WS\voices\qwen\$K.pt"

# 2. Pre-stage the revoke command in a SECOND shell so it is one keypress:
#    Invoke-RestMethod -Method Post "http://localhost:8080/api/voice-library/$U/revoke"
```

**Steps**
1. Delete `$K.pt` (above). Confirm `voice.json` still has `master` and **no** `revokedAt`.
2. Start tailing `logs\tts.log`.
3. Start generating the chapter.
4. The moment the chapter starts and **before** any audio appears — the "preparing
   voice" dead time, i.e. after the chapter begins but before the first
   group tick — fire the pre-staged **revoke** in the second shell.
   *Aim for the window between the chapter starting and
   `Cloned + cached Qwen voice 'qwen-<uuid>'` appearing in `tts.log`.*
5. Let the chapter finish/fail.
6. Run the §3.2 artifact listing.
7. Re-read `voice.json`.

**Expected (all three must hold)**
- **`revokedAt` survives.** `voice.json`'s `consent.revokedAt` is set. It has
  **not** been clobbered back to un-revoked by the derive's post-write.
- **The chapter fails**, with `generationErrorCode: cloned-voice-broken` and a
  reason naming the character with reason `revoked`.
- **No `.pt` survives on disk.** `$WS\voices\qwen\$K.pt` does **not** exist, even
  though the sidecar wrote one during the derive — `statusStampMutate`
  re-purges it (`clone-voice-resolver.ts:370`, inside `deps.updateEntry`'s
  per-uuid lock).
- Also gone: `$K.json`, `${K}__1.7b.pt` (if it existed), and the entry-dir
  `master.wav`.

**If you miss the window** (the revoke lands after the chapter already failed, or
before the derive started), the outcome is a plain C-02 or C-06 — retry. Budget
3–5 attempts.

**Millisecond-window update (Wave 3c, Task 14):** the earlier version of this
sheet carried a "known-acceptable variant" here, saying `revokedAt` could be
clobbered if you landed inside the millisecond gap between the guard's
re-read and its write, citing §6 KL-j(1)/#1826. That gap is now closed —
`workspace/voice-library.ts`'s `updateEntry(uuid, mutate)` holds a per-uuid
promise-chain lock (`withEntryLock`) across the ENTIRE fresh-read + mutate +
write span, and both the revoke route's `revokedAt` stamp and the resolver's
`statusStampMutate` write go through it, so neither can act on a stale
snapshot of the other's change (see §6 KL-j(1)/(2), now marked
appears-fixed-in-source). **If you land inside the old millisecond window and
`revokedAt` still comes back clobbered, that is now a regression — file it,
don't wave it through as expected.**

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Attempts:** ____  **Notes:**

---

#### C-02 — A revoked voice fails the chapter loud, and produces **no audio at all**

**Proves:** 268 Invariants 1 and 2 — never silently substituted, and fail-fast
wastes zero GPU. Discharges 268's owed item (a).

**Preconditions:** a healthy assigned clone; the chapter's audio deleted so the
"no audio" check is unambiguous.

**Steps**
1. `Remove-Item "$BOOK\audio\<slug>.mp3" -ErrorAction SilentlyContinue`
2. Note the byte length of `logs\tts.log`: `(Get-Item "$PWD\logs\tts.log").Length`
3. Revoke the voice (UI card → **Revoke** → confirm the two-step dialog; see C-09).
4. Start the clock. Generate the chapter. Stop the clock when it reports failure.
5. Immediately re-check `logs\tts.log`'s length and tail the delta.
6. Check `$BOOK\audio\` and `state.json`.

**Expected**
- The chapter fails **within a second or two** of starting — not after minutes of
  synth. Record the elapsed time.
- **Zero audio**: no new/updated `<slug>.mp3` in `$BOOK\audio\`; no partial
  segment files anywhere under the book dir.
- **Zero GPU work**: the `tts.log` delta contains **no** `/synthesize`, no
  `create_voice_clone_prompt`, no `Cloned + cached Qwen voice` line for this run.
  (This is the falsifiable form of "fail-fast wastes zero GPU" — the pre-pass sits
  before the title beat, `synthesise-chapter.ts:~1195-1245` vs the title beat at
  `~1346`.) `nvidia-smi` should show no utilisation spike attributable to the run.
- `state.json` for the chapter:
  - `generationState: "failed"`
  - `generationErrorCode: "cloned-voice-broken"`
  - `generationError` **names the character** and the reason, in the shape
    `Cloned voice(s) unavailable — a cloned voice must never be substituted with another: "<Character>" (revoked). Re-enable Qwen or restore the missing voice(s); reassign the character(s).`
  - `generationRemediation` is non-empty.

**Record:** elapsed to failure = ______ s · `tts.log` grew by ______ bytes

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-03 — A Broken cloned voice **not used in this chapter** does not fail it

**Proves:** 268 Invariant 3 — the readiness gate intersects to *this chapter's*
characters.

**Preconditions:** two cloned voices (`$U` from B-01, second from B-02) assigned
to **two different characters**; a chapter in which only **one** of them speaks.
Confirm the speaking set from the chapter's sentence attribution before starting.

**Steps**
1. Assign clone A to a character who **does** speak in chapter X.
2. Assign clone B to a character who does **not** speak in chapter X (verify!).
3. **Revoke clone B** (making it Broken).
4. Generate chapter X.

**Expected**
- Chapter X **completes normally**. No `cloned-voice-broken`.
- Clone A renders as itself throughout.
- Now generate a chapter where character B *does* speak → **that** chapter fails
  with `cloned-voice-broken` naming character B. (Same-run confirmation that the
  gate is scoping, not just globally passing.)

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-04 — The **title-beat narrator** path is gated

**Proves:** 268 Invariant 3's first narrator inclusion — the narrator is unioned
into the in-chapter set when `Boolean(titleText)`, even though a title beat has
no `SentenceGroup` of its own (`synthesise-chapter.ts:1207-1215`).

**Preconditions:** a chapter with a **narrated title** (chapter-title narration
enabled and a non-empty title); the **narrator** character assigned a cloned
voice; that cloned voice **revoked** (Broken).

**Steps**
1. Assign a cloned voice to the narrator character.
2. Confirm chapter-title narration is on and the chapter has a title.
3. Ideally pick a chapter where the narrator has **no body lines at all** — so the
   title beat is the *only* narrator usage and the test is unambiguous. If none
   exists, note that the chapter also has narrator body lines (weaker but still valid).
4. Revoke the cloned voice.
5. Generate the chapter.

**Expected**
- The chapter fails with `cloned-voice-broken` naming the narrator — proving the
  narrator was pulled into the readiness set **because of the title beat**.
- No title audio is produced (fail-fast is before the title beat).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-05 — The **orphaned-characterId narrator** path is gated

**Proves:** 268 Invariant 3's second narrator inclusion (the IMPORTANT-1 Task-6
review finding) — the narrator is also unioned in when any group carries a
`characterId` that is not in `cast` at all, because `resolveNarratorChar()`
silently substitutes the narrator for it.

**Preconditions:** the narrator assigned a **revoked** cloned voice, and a chapter
with **no** narrated title, plus at least one sentence whose `characterId` does
not exist in `cast.json`.

**How to create the orphan** — hand-edit the book's segments/attribution so one
sentence points at a bogus character id, or delete a character from `cast.json`
while leaving its sentences attributed:

```powershell
# Snapshot first!
Copy-Item "$BOOK\.audiobook\cast.json" "$BOOK\.audiobook\cast.json.bak"
# Remove one non-narrator character object from cast.json's `characters` array,
# leaving that character's sentences attributed to its now-missing id.
```

**Steps**
1. Turn chapter-title narration **off** (or use a chapter with an empty title) so
   `titleText` is falsy and the title path cannot be what triggers the gate.
2. Create the orphan (above).
3. Revoke the narrator's cloned voice.
4. Generate the chapter.
5. Restore `cast.json` from the backup afterwards.

**Expected**
- The chapter fails with `cloned-voice-broken` naming the **narrator**, even
  though the narrator has no title beat — proving the orphan safety net pulled it
  into the readiness set.
- Without the fix this chapter would have rendered the orphaned line in a
  substituted voice. It must not.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-06 — A **Repairable** voice transparently re-derives and the chapter completes

**Proves:** 268's classification → repair path
(`resolveClonedVoicesForChapter`, `clone-voice-resolver.ts:379-524`, the
repairable branch around `:433-520`). Discharges 268's manual step 3.

**Preconditions:** a healthy assigned clone; sidecar up.

**Steps**
1. Confirm the pre-state: `$K.pt` exists; `voice.json` has `master` and
   `engines.qwen.status: "ready"`.
2. Delete **only** the `.pt`: `Remove-Item "$WS\voices\qwen\$K.pt"`
   (leave `$K.json`, `voice.json`, and the entry-dir `master.wav` alone).
3. Note the card state in `#/voices` (see C-16).
4. Generate the chapter. Tail `logs\tts.log`.
5. After completion, re-run the §3.2 listing and re-read `voice.json`.

**Expected**
- The chapter **completes normally** — no error, no toast.
- There is a brief pause at the start of the chapter, now surfaced as a
  **"Preparing voice — `<Character>`…"** row caption/pill (fixed — §6 KL-f /
  [#1813](https://github.com/dudarenok-maker/Castwright/issues/1813)), not a
  silent dead pause. A re-derive with no UI signal at all is a defect.
- `logs\tts.log` shows exactly **one** `Cloned + cached Qwen voice 'qwen-<uuid>' from caller clip.`
- `$WS\voices\qwen\$K.pt` **reappears**, with a fresh `LastWriteTime`.
- `voice.json`'s `engines.qwen.status` is `ready` and `baseModel` equals the
  sidecar's current base model.
- The rendered audio is still the **same cloned voice** (re-derive from the same
  clip, not a substitution) — spot-check against B-03's reference.
- Generating a **second** chapter afterwards fires **no** further derive (the
  voice is Healthy again).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-07 — A **base-model bump** triggers the same re-derive

**Proves:** 268's owed item (b) — the stale-`baseModel` limb of
`classifyClonedVoice`'s `needsDerive` (`clone-voice-resolver.ts:206-207`;
the function itself is at `:196-212`), exercised by a real version change
rather than a deleted `.pt`.

**Preconditions:** the ability to change `currentQwenBaseModel()`'s value. The
honest options:
1. A genuine sidecar model upgrade (the real-world trigger). Best if one is
   available.
2. Simulate the *effect* by editing the entry's recorded `baseModel` to a value
   that cannot match:
   ```powershell
   $p = "$WS\voice-library\$U\voice.json"
   $j = Get-Content $p -Raw | ConvertFrom-Json
   $j.engines.qwen.baseModel = 'qwen-base-OLD-0.0'
   $j | ConvertTo-Json -Depth 10 | Set-Content $p -Encoding utf8
   ```
   This is the same branch from the other side and is an acceptable stand-in —
   **say so in the notes** rather than claiming a real model bump.

**Steps**
1. Ensure `$K.pt` **exists** (this test is about staleness, not absence).
2. Apply option 1 or 2.
3. Generate the chapter.

**Expected**
- The chapter completes.
- Exactly one re-derive fires (`Cloned + cached Qwen voice` in `tts.log`), even
  though the `.pt` was present.
- Afterwards `voice.json`'s `engines.qwen.baseModel` matches the sidecar's
  current base model (the resolver stamps the pre-derive
  `currentArtifactVersion` snapshot — the Task 18 rename of the old
  `currentBaseModel` — onto `baseModel`, `clone-voice-resolver.ts:474-481`).
- The voice still sounds like the person.

**Record:** method used (real bump / simulated) = ______

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-08 — ⭐ A **transient** derive failure reports Broken but does **NOT** brick the voice

**Proves:** 268 Invariant 4 — the anti-brick property. `isTransientDeriveFailure`
treats status `0` (unreachable), any 5xx, and a no-status throw as **transient**,
and a transient failure must **not** persist `engines.qwen.status: 'failed'`
(which classification rule 3 makes terminal). Test this **explicitly** — it is the
difference between a hiccup and a permanently dead voice.

**Preconditions:** a healthy assigned clone; ability to stop just the sidecar.

**Steps**
1. Force Repairable: `Remove-Item "$WS\voices\qwen\$K.pt"`.
2. **Stop the sidecar** (leave the server running). ⚠️ If the server owns the
   sidecar lifecycle (P-25 `autoStartSidecar` on), it may respawn — either turn
   that preference off first, or stop the whole stack and start the server alone
   with `npm run dev` while leaving `npm run tts:sidecar` unstarted.
3. Generate the chapter.
4. **Immediately** read `voice.json`'s `engines.qwen.status`.
5. Restart the sidecar. Wait for `/health` to answer.
6. Generate the **same** chapter again, changing nothing else.

**Expected**
- Step 3: the chapter **fails** with `cloned-voice-broken`; the reason names the
  character with `(derive-failed)`.
- Step 4: **`engines.qwen.status` is NOT `'failed'`.** It should still read
  whatever it was (`ready`/`stale`). *A persisted `'failed'` here is a **fail** —
  it is exactly the bricking this invariant forbids.*
- Step 6: the chapter now **completes**. The `.pt` is re-derived and reappears.
  No manual repair, no re-clone, no manifest editing was needed.

**Record:** status after the failed run = ______  (must not be `failed`)

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-09 — A **permanent** 4xx derive failure persists `failed`

**Proves:** the other half of 268 Invariant 4 — a 4xx means the sidecar rejected
the clip itself, so `'failed'` is persisted and is terminal until a fresh derive
clears it.

**Preconditions:** a way to make the sidecar return 4xx to a repair derive. The
repair path calls `deriveEngineArtifact(uuid, 'qwen', { masterPcm, sampleRate,
refText, auditionText })`. The sidecar 400s when `X-Sample-Rate` ≤ 0 or
`X-Ref-Text` is empty (`main.py:6975-6984`). So:

```powershell
# Corrupt the entry so the repair derive sends an empty ref_text -> sidecar 400.
$p = "$WS\voice-library\$U\voice.json"
$j = Get-Content $p -Raw | ConvertFrom-Json
$j.master.transcript = ''      # empty ref_text
$j | ConvertTo-Json -Depth 10 | Set-Content $p -Encoding utf8
Remove-Item "$WS\voices\qwen\$K.pt"   # force Repairable
```

⚠️ **verify on box** that this actually produces a 4xx and not a Node-side throw
before the HTTP call. If it does not, an alternative is to truncate/corrupt the
entry-dir `master.wav` so the sidecar rejects the clip. If neither reproduces a
genuine 4xx, mark **N/A** and lean on `clone-voice-resolver.test.ts`'s 422 case.

**Steps**
1. Apply the corruption above.
2. Generate the chapter.
3. Read `voice.json`'s `engines.qwen.status`.
4. Restart the sidecar and generate again.
5. Restore the transcript afterwards and re-derive (or re-clone).

**Expected**
- Step 2: chapter fails, `cloned-voice-broken`, reason `derive-failed`.
- Step 3: `engines.qwen.status` **is** `'failed'` (persisted — the opposite of C-08).
- Step 4: the chapter fails **again immediately**, with no derive attempted —
  `'failed'` is terminal (classification rule 3 fires before the `.pt` checks).
  This is the intended behaviour, not a bug.
- The card shows the **danger** "Needs attention" chip (C-16).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-10 — ⭐ **Total erasure on revoke**, including the original recording

**Proves:** 268 Invariant 5 and its owed item (c) — `purgeCloneArtifacts(uuid,
{ deleteMasterClip: true })` erases every listed artifact **and** the entry-dir
recording, confirmed by `ls`, not by a temp-workspace test fixture.

**Preconditions:** a clone that has been through **as many paths as possible** so
the artifact set is maximally populated:
- rendered on the 0.6B tier (base `.pt` + `.json`),
- rendered on the 1.7B tier at least once, so `${K}__1.7b.pt` exists (see C-19),
- auditioned at least once, so the sample cache is populated.

**Steps**
1. **Enumerate the pre-state** with the §3.2 explicit-path listing *and* the
   wildcard sweep *and* the sample-cache listing. Paste the output into your notes.
2. Revoke via the **UI**: `#/voices` → the card → **Revoke**.
3. Read the two-step `ConfirmDialog` carefully before confirming.
4. Confirm with the **Revoke & delete recording** button.
5. Re-run all three listings.
6. Read `voice.json`.

**Expected — the confirm dialog**
- Titled `Revoke "<name>"?`, and states up front that
  `The original recording and everything derived from it are permanently deleted.`
- The confirm button is labelled **`Revoke & delete recording`**.
- Cancelling leaves everything intact (check this too).

**Expected — after confirming, every one of these is GONE**

| Artifact | Path | Gone? |
|---|---|---|
| Base prompt | `$WS\voices\qwen\qwen-<uuid>.pt` | ☐ |
| Sidecar manifest | `$WS\voices\qwen\qwen-<uuid>.json` | ☐ |
| 1.7B prompt | `$WS\voices\qwen\qwen-<uuid>__1.7b.pt` | ☐ |
| Preview prompt | `$WS\voices\qwen\qwen-<uuid>-preview.pt` | ☐ |
| Preview manifest | `$WS\voices\qwen\qwen-<uuid>-preview.json` | ☐ |
| Preview 1.7B prompt | `$WS\voices\qwen\qwen-<uuid>-preview__1.7b.pt` | ☐ |
| Retained design clip | `$WS\voices\qwen\qwen-<uuid>__master.wav` | ☐ |
| Preview design clip | `$WS\voices\qwen\qwen-<uuid>-preview__master.wav` | ☐ |
| **The original recording** | `$WS\voice-library\<uuid>\master.wav` | ☐ |
| Sample cache | `server\audio\voices\qwen-<uuid>-*.mp3` | ☐ |

**Expected — what SURVIVES (revoke ≠ delete)**
- `$WS\voice-library\<uuid>\` still exists.
- `voice.json` still exists, with `consent.revokedAt` set and the rest of consent
  intact, and **`master` now absent/undefined** (cleared so the manifest never
  points at a file that is gone — `purge-clone-artifacts.ts:96`).
- The card is still visible in My voices, in a revoked state.

**Expected — sidecar memory**
- `logs\tts.log` shows a `/qwen/evict-voice` for **both** `qwen-<uuid>` and
  `qwen-<uuid>-preview` (`purge-clone-artifacts.ts:103-113`).

**Expected — response**
- HTTP 200 with **no** `artifactPurgeIncomplete` field (a clean purge). If the
  field is present, that is C-21's scenario — investigate before passing.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-11 — **Delete** erases everything C-10 does, **plus** the entry directory

**Proves:** the `deleteEntryDir: true` branch (`voice-library.ts:1006-1008`) and
the usage-scan/confirm flow.

**Preconditions:** a fresh healthy clone, **assigned** to at least one character
(so the usage scan has something to report).

**Steps**
1. Enumerate the pre-state (§3.2, all three listings).
2. `Invoke-RestMethod -Method Delete "http://localhost:8080/api/voice-library/<uuid>"`
   — **without** `?confirm=1`.
3. Then delete via the **UI** (or re-issue with `?confirm=1`).
4. Re-run all listings; check `cast.json`.

**Expected**
- Step 2: HTTP **409** with a `usage` array naming the book(s)/character(s) that
  reference this voice. Nothing is erased.
- Step 3: HTTP **200** `{ deleted: true }`.
- Everything in C-10's "GONE" table is gone, **and additionally**:
  - `$WS\voice-library\<uuid>\` **no longer exists at all** (dir removed).
- `cast.json`: the referencing character's `overrideTtsVoices.qwen` slot has been
  **cleared** (`clearLibraryVoiceReferences`), leaving that character voiceless on
  Qwen — the fe-46 gate should surface it.
- The entry no longer appears anywhere in `GET /api/voice-library` or in the UI.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-12 — **Atomic `.pt` write**: killing the sidecar mid-write leaves no corrupt `.pt`

**Proves:** 268 Invariant 6 — `_atomic_torch_save` (`main.py:202-224`) writes to a
temp sibling then `os.replace`s, closing the #1804 corruption window.

**Preconditions:** a clone whose `.pt` currently **exists and is good**; the
ability to kill the sidecar process abruptly (not a graceful stop).

**Steps**
1. Record the good `.pt`'s size and hash:
   ```powershell
   Get-FileHash "$WS\voices\qwen\$K.pt" | Select-Object Hash
   (Get-Item "$WS\voices\qwen\$K.pt").Length
   ```
2. Force a re-derive that will rewrite that same path: `Remove-Item` is the wrong
   move here (we want a *rewrite over a live file*). Instead re-clone/redesign
   onto the same voiceId, or start a chapter render after bumping `baseModel`
   (C-07 method 2) so a repair derive rewrites the live `.pt`.
3. Watch `logs\tts.log`; the instant the derive begins (after the request lands,
   before `Cloned + cached Qwen voice`), **hard-kill the sidecar**:
   `Stop-Process -Name python -Force` (⚠️ verify you are killing the sidecar's
   python, not another one — check the PID from `logs\tts.log` / the supervisor).
4. Inspect the qwen dir.
5. Repeat 2–4 a few times to actually land inside the write.

**Expected**
- The live `$K.pt` is **either** the original (byte-identical hash from step 1)
  **or** a complete new one — **never** a truncated/partial file.
- Any leftover temp file is named `qwen-<uuid>.pt.<random>.tmp` (the
  basename-prefixed, `.tmp`-suffixed shape at `main.py:214`). A leftover `.tmp` is
  **acceptable** — it is inert and never loaded. A zero-byte or short
  `qwen-<uuid>.pt` is a **fail**.
- After restarting the sidecar, the voice still loads and renders (or, if the
  `.pt` was the original, renders exactly as before).

```powershell
Get-ChildItem "$WS\voices\qwen" -Filter "$K*" | Select-Object Name,Length
Get-ChildItem "$WS\voices\qwen" -Filter "*.tmp"
```

**Record:** attempts = ____ · truncated `.pt` ever observed? ☐ no ☐ yes (fail)

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-13 — **`wrong-engine`** is diagnosed distinctly at render time

**Proves:** 268 Invariant 7 — `classifyClonedVoice` checks `wrongEngine` **before**
`engineUnavailable` (`clone-voice-resolver.ts:199-200`; line numbers shifted
from the original 268 citation during the Wave 3c engine-partitioning
rework, same order-of-checks), so a cloned voice on a non-Qwen book must
**not** say "Qwen is unavailable".

**Preconditions:** a healthy cloned voice already assigned to a character (assign
it while the book routes to Qwen, so the assign-time guard does not block you —
this test is about *render* time). Qwen itself must be **healthy** — that is the
whole point.

**Steps**
1. With the cloned character assigned and Qwen healthy, switch the **book/session
   engine to Kokoro** (P-23's picker).
2. Generate the chapter.
3. Read `state.json`'s `generationError`.

**Expected**
- The chapter fails with `generationErrorCode: cloned-voice-broken`.
- `generationError` names the character with reason **`(wrong-engine)`** and the
  remedy sentence includes **`switch the book to Qwen`**.
- It must **NOT** say `Re-enable Qwen` as the only remedy, and must not claim Qwen
  is unavailable — Qwen is up. (`UnresolvableClonedVoiceError.fromList`,
  `clone-voice-resolver.ts:101-147`: `wrong-engine` gets its own clause; the shared
  tail is `reassign the character(s)`. Wave 3c widened the `engine-unavailable`
  clause to name whichever engine(s) were actually reported unavailable —
  `Re-enable Qwen or Coqui` when both are, falling back to the literal `Qwen`
  wording for a pre-3c/qwen-only report like this one — but the `wrong-engine`
  clause itself is still hardcoded to `switch the book to Qwen` regardless of
  which engine the voice is actually cloned on; this test's own setup is a
  Qwen-cloned voice, so that wording is correct here. There is no
  Coqui-equivalent of this test in Section E — if a coqui-cloned voice hits
  `wrong-engine`, the remedy would still say "switch the book to Qwen", which
  would misdiagnose the fix; worth a follow-up test/fix if you want the Coqui
  side covered.)
- Contrast case: put the book back on Qwen, **stop the sidecar**, and generate.
  Now the reason should read **`(engine-unavailable)`** with the
  `Re-enable Qwen or restore the missing voice(s)` remedy — the two diagnoses must
  be visibly different.

**Record:** wrong-engine message = ______________________________________
**Record:** engine-unavailable message = ______________________________________

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-14 — The **assign-time wrong-engine guard** 409s, with cause-specific copy

**Proves:** 268 Invariant 7's assign-time half, **widened in Wave 3c Task 24**
from Qwen-only to *either* clone-capable engine — the guard now checks
`CLONE_CAPABLE_ENGINES.has(routedEngine)` (`voice-library.ts`, the
`entry.provenance === 'cloned'` block right after the `shouldWriteCoquiSlot`
computation, ~`:1187-1209`), not "routed engine === qwen". A cloned voice is
no longer blocked from a character routed to **Coqui** — only from one routed
to a genuinely non-clone-capable engine (kokoro/gemini/piper). Discharges
268's manual step 4.

> ⚠️ **This case-2 scenario changed from the original 268 test.** Casting the
> character on `coqui` no longer 409s — Coqui is clone-capable now, so that
> assign should **succeed**. Use a genuinely ineligible engine (kokoro) to
> still exercise the 409 path.

**Preconditions:** a healthy, ready cloned voice; a target character; the ability
to change both the session engine picker (P-23) and a character's own `ttsEngine`.

**Steps — case 1 (book/session default is not clone-capable)**
1. Set the session engine picker to **Kokoro**. Ensure the target character has
   **no** `ttsEngine` override.
2. In the profile drawer, try to pick the cloned voice from My voices.

**Steps — case 2 (the character itself is cast on a non-clone-capable engine)**
3. Set the session picker back to **Qwen**. Give the target character its own
   `ttsEngine: 'kokoro'` override (NOT `'coqui'` — see the warning above; Coqui
   is clone-capable and would 200, not 409).
4. Try to assign the cloned voice again.

**Steps — case 2b (contrast: the character is cast on the OTHER clone-capable engine)**
4b. Give the target character `ttsEngine: 'coqui'` instead and try the assign.
    This should **succeed (200)**, writing both the `qwen` and `coqui` slots
    (see B-07/E-08) — confirming the guard's widening, not a regression.

**Steps — case 3 (the pending picker beats the persisted default)**
5. Leave the **persisted** account default at something non-clone-capable
   (P-22), but set the drawer's **pending** engine choice to Qwen (not yet
   Saved), then assign.

**Expected**
- Case 1: HTTP **409**, message shaped
  `Cloned voices render on Qwen or Coqui XTTS v2, but this book is set to kokoro. Switch the book's engine to Qwen or Coqui XTTS v2 before assigning "<Character>".`
  (the "Qwen or Coqui XTTS v2" phrasing is new in Wave 3c — a message that
  still says only "Qwen" is stale, not a defect in the running code, but
  confirm your SHA is current before assuming so).
- Case 2: HTTP **409**, message shaped
  `Cloned voices render on Qwen or Coqui XTTS v2, but "<Character>" is cast on kokoro. Switch the character's engine to Qwen or Coqui XTTS v2 (or reassign the character) before assigning "<Character>".`
  — i.e. it names the **character** as the cause, not the book.
- Case 2b: HTTP **200** — assigning a cloned voice to a Coqui-routed character
  is allowed.
- Case 3: the assign **succeeds (200)** — the pending `modelKey` wins over the
  persisted default. (Without this, a session pick of Qwen against a non-Qwen
  persisted default would produce a false 409.)
- In every 409 case, `cast.json` is unmodified.
- Remember this guard is **advisory** (§6 KL-(d)) — a caller omitting `modelKey`
  can slip past it. That is expected; the render-time pre-pass (C-13) is the hard
  boundary.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-15 — The `cloned-voice-broken` toast fires immediately, with a help link

**Proves:** 268's frontend surfacing —
`IMMEDIATE_TOAST_ERROR_CODES` in `src/store/generation-stream-runner.ts:72`
includes `cloned-voice-broken`, and `helpHrefForFailureCode` maps it to
`#/help?code=cloned-voice-broken` (`src/data/help-failures.ts:46,69`).

**Preconditions:** any Broken cloned voice (C-02's revoked one is fine); the
generation view **open and visible** when the failure lands.

**Steps**
1. Open the generation view for the book.
2. Start the chapter that will fail.
3. Observe the toast the moment the chapter fails — do not navigate away.
4. Click the toast's help link.
5. Fail the **same** chapter again in the same session and watch for a duplicate toast.
6. Fail a **different** chapter and watch for a second toast.

**Expected**
- A toast appears **immediately** on failure (not deferred to end-of-run), naming
  the problem.
- It carries a help affordance that navigates to `#/help?code=cloned-voice-broken`.
- The Help view shows the entry titled **`Cloned voice can't render as itself`**
  under the **voices** area, with the remediation copy.
- **Per-chapter dedupe:** step 5 produces **no** second toast for the same chapter;
  step 6 **does** produce one for the other chapter.
- The toast copy is **reason-neutral** — it must not claim Qwen is unavailable
  when the underlying reason is `wrong-engine`. Repeat once against C-13's
  wrong-engine setup to confirm.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-16 — The My-voices card **Broken / Repairable** state chip

**Proves:** 268's `deriveClonedVoiceState` chip
(`src/components/voices/voice-library-card.tsx:112-119`, the label/color
rendered inside `ProvenanceMarker` at `:371-391`).

> **Exact labels** (note: not literally the words "Broken"/"Repairable"):
> `broken` → a **danger** pill reading **`Needs attention`**;
> `repairable` → a **warning** pill reading **`Will re-derive`**;
> healthy → **no chip**.
>
> **Wave 3c widened this to worst-of-both-engines, and the two engines are
> NOT symmetric.** `deriveClonedVoiceState` now ranks `engines.qwen.status`
> AND `engines.xtts.status` and takes the worse of the two
> (`qwenEngineState`/`coquiEngineState`/`rank`, `voice-library-card.tsx:95-119`)
> — but a Coqui-side `'failed'` only ranks **repairable** (`coquiEngineState`
> treats `failed` the same as `stale`), while a Qwen-side `'failed'` still
> ranks **broken**. So setting `engines.xtts.status = 'failed'` by hand and
> expecting the danger chip is a **wrong expectation, not a bug** if you
> instead see the warning chip — this asymmetry is deliberate (Qwen is the
> primary engine; Coqui failures self-heal at the next derive). This is
> Section C's row and stays Qwen-scoped in the steps below; a Coqui-specific
> version of this table belongs to Section E, which doesn't currently have
> one — worth adding if you want the Coqui side explicitly exercised.
>
> **Also new in Wave 3c (Task 28), a SEPARATE row of chips**: each entry now
> also renders a per-engine status pill for every engine it has an artifact
> on — `Qwen ✓/…/⟳/⚠` and `Coqui ✓/…/⟳/⚠` (`ENGINE_STATUS_LABEL`/
> `ENGINE_STATUS_COLOR`, `voice-library-card.tsx:42-70`, rendered at
> `:216-222`, ABOVE the tags row, separate from the broken/repairable pill
> this test's table covers). These per-engine chips aren't part of this
> test's table but ARE visible on every card — confirm they show a plausible
> status per engine while you're here; a card missing an engine chip for an
> engine it demonstrably has an artifact on is worth a note.

**Steps** — check each state on `#/voices`, reloading between changes:

| State to induce | How | Expected chip |
|---|---|---|
| Healthy | fresh clone from B-01 | **no chip** |
| Broken — revoked | revoke it | danger `Needs attention` |
| Broken — no master | clear `master` in `voice.json` by hand | danger `Needs attention` |
| Broken — failed | set `engines.qwen.status = 'failed'` (or induce C-09) | danger `Needs attention` |
| Repairable | set `engines.qwen.status = 'stale'` | warning `Will re-derive` |

**Expected**
- Each row renders the chip in the table above.
- ⚠️ The chip is a **client-side approximation** (§6 KL-(h)) — it cannot see `.pt`
  presence on disk or the character's routed engine. Two consequences you should
  **verify as expected, not log as defects**:
  - A voice made Repairable by **deleting the `.pt`** (C-06) shows **no chip**
    (the manifest still says `ready`).
  - A `wrong-engine` case (C-13) shows **no chip at all**, even though the render
    will hard-fail.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-17 — ⭐ §2.3: a **designed** voice self-heals from its retained clip, and its **persona survives**

**Proves:** 268 Invariants 8 and 9 — the missing-`.pt`-only self-heal (the
qwen arm of `resolveDesignedVoicesForChapter`, `clone-voice-resolver.ts:
728-1005`, presence check at `:856-858`), and the plan-149 regression guard
(the sidecar's `clone_voice` truncate-rewrites `qwen-<uuid>.json` into a
bare clone manifest, so `instruct`/`designModel`/`mintMethod`/`fallbackFor`
must be restored from the pre-derive snapshot — `restoredManifest` +
`writeSidecarManifest`, `clone-voice-resolver.ts:884-908`).

**Preconditions:** a **designed** (not cloned) library voice, created **on this
branch** so the sidecar wrote its retained clip. Verify the clip exists before
starting — a voice designed before this branch will have **no** `__master.wav` and
cannot self-heal (that is expected, not a defect).

**Steps**
1. Design a voice (or redesign an existing one) so a fresh
   `qwen-<uuid>__master.wav` is written. Confirm:
   ```powershell
   Test-Path "$WS\voices\qwen\${K}__master.wav"
   ```
2. **Snapshot the persona** before doing anything:
   ```powershell
   Get-Content "$WS\voices\qwen\$K.json" -Raw | ConvertFrom-Json |
     Select-Object voiceId,instruct,designModel,mintMethod,fallbackFor,language,baseModel
   ```
   Copy `instruct` verbatim into your notes.
3. Assign that designed voice to a character who speaks in the chapter, on Qwen.
4. **Delete only the `.pt`**: `Remove-Item "$WS\voices\qwen\$K.pt"`.
5. Generate the chapter.
6. Re-read the sidecar manifest and compare against step 2.
7. Open the character's **Profile Drawer** and look at the persona box.
8. Trigger a **re-design** of that voice.

**Expected**
- Step 5: the chapter **completes** (the self-heal is best-effort but should
  succeed here), with one derive in `logs\tts.log`, and `$K.pt` reappears.
- Step 6 — the manifest still carries, **unchanged**:
  - `instruct` — **byte-identical** to the step-2 snapshot (this is the load-bearing one)
  - `designModel` (not `null`)
  - `mintMethod` and `fallbackFor`, if they were present
  - `voiceUuid`, `language`
  and has been **refreshed** on:
  - `refText`, `baseModel`
  A manifest that now reads `"clone": true` with `"designModel": null` and no
  `instruct` is a **fail** — that is exactly the plan-149 bug.
- Step 6b: `voice.json`'s `engines.qwen` is stamped `status: 'ready'` with the
  derive's fresh `baseModel`.
- Step 7: the Profile Drawer's persona box is **still populated** with the same
  persona text — not blank.
- Step 8: **re-design still works** — it does not trip the empty-persona guard.

**Record:** `instruct` identical after self-heal? ☐ yes ☐ no (fail)

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-18 — §2.3: a **stale** designed `.pt` is deliberately left alone

**Proves:** 268 Invariant 8's narrowness — the QWEN arm of
`resolveDesignedVoicesForChapter` skips entirely when `ptExists` is true,
presence-only, byte-for-byte pre-3c behaviour (`clone-voice-resolver.ts:
856-858`); a stale `baseModel` on a present `.pt` must **not** trigger a
re-derive. (The Coqui arm added in Wave 3c is deliberately different — it
*does* also check `coquiVersion` staleness, `:775-779` — but that's Section
E's D-B/D-F territory, not this Qwen-only test.)

**Steps**
1. With a designed voice whose `.pt` **exists**, set its `voice.json`
   `engines.qwen.baseModel` to a bogus old value (C-07 method 2) and/or
   `status` to `stale`.
2. Note the `.pt`'s `LastWriteTime` and hash.
3. Generate the chapter.

**Expected**
- The chapter completes.
- **No** re-derive fires (`logs\tts.log` shows no `Cloned + cached Qwen voice`
  for this voice).
- The `.pt`'s `LastWriteTime` and hash are **unchanged**.
- The voice renders from the older embedding — "renders fine, just from an older
  embedding" is the intended behaviour, not a defect.
- Contrast with C-06/C-07: for a **cloned** voice, a stale `baseModel` *does*
  trigger a re-derive. The asymmetry is deliberate.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-19 — The **1.7B Quality tier** works for a cloned voice, and its artifact is erased on revoke

**Proves:** spec §5.5 (cloned voices are allowed on the 1.7B tier) plus §5.6 /
268 Invariant 5 (`${K}__1.7b.pt` is a consent-scoped artifact
`purgeCloneArtifacts` must erase — the variant the pre-3b2 ad-hoc cleanup missed).

**Preconditions:** P-14 satisfied (the 1.7B-Base model is available, so the
per-character toggle renders); a healthy assigned cloned voice.

**Steps**
1. Confirm `${K}__1.7b.pt` does **not** yet exist.
2. Open the character's Profile Drawer → the engine picker → tick
   **`Higher quality (1.7B) — uses the larger Qwen model for this character`**.
   (The character gains `ttsModelKey: 'qwen3-tts-1.7b'` in `cast.json`.)
3. Generate the chapter.
4. Check the qwen dir.
5. Listen.
6. Revoke the voice (C-10 flow).
7. Re-check the qwen dir.

**Expected**
- Step 3: the chapter completes on the 1.7B tier.
- Step 4: **`$WS\voices\qwen\qwen-<uuid>__1.7b.pt` now exists** (auto-derived from
  the 0.6B `.pt` by `_load_voice_prompt_17b` on cache miss).
- Step 5: still recognisably the same person — the tier changes quality, not identity.
- Step 7: **`${K}__1.7b.pt` is gone**, alongside everything else in C-10's table.
  A surviving `__1.7b.pt` after a revoke is a **fail** — it is a resynthesis-capable
  artifact of a revoked person's voice.
- ⚠️ VRAM: on the 8 GB card (cuda:0) a 1.7B render alongside the analyzer can be
  tight. **Record which card the run landed on** (`curl -s http://localhost:9000/capacity`).

**Record:** card used = ______ · `__1.7b.pt` present after render? ☐ · gone after revoke? ☐

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-20 — **Pause during a repair derive** does not surface a chapter failure

**Proves:** the review I-1 abort handling — `isAbort` trusts the signal, not
`err.name` (because `deriveEngineArtifact`'s fetch layer converts *every*
rejection, abort included, into a `SidecarDesignError(..., 0)`), and
`abortRejection` rethrows a genuine `AbortError` so
`routes/generation.ts`'s pause detector sees a pause rather than a failure
(`isAbort` at `clone-voice-resolver.ts:315-317`, `abortRejection` at
`:334-337`).

**Preconditions:** a Repairable clone (delete the `.pt`) assigned to a character
in the chapter, so the render is guaranteed to spend seconds in the derive.

**Steps**
1. `Remove-Item "$WS\voices\qwen\$K.pt"`.
2. Start generating the chapter.
3. Hit **Pause** during the now-visible **"Preparing voice…"** window (§6
   KL-f) — the same window as C-01, before the first synth tick.
4. Observe the UI and `state.json`.
5. Resume / re-run the chapter.

**Expected**
- The run **pauses**. There is **no** `cloned-voice-broken` toast and **no**
  chapter-failure banner.
- `state.json` for that chapter does **not** gain `generationState: 'failed'`.
- The voice's `engines.qwen.status` is **not** stamped `'failed'` (an abort must
  never be misread as a derive failure).
- Step 5: resuming/re-running succeeds; the `.pt` gets derived and the chapter
  completes.
- Repeat once for the **designed**-voice self-heal path (C-17 setup + Pause):
  the abort is the one exception `resolveDesignedVoicesForChapter` rethrows, so
  it must also read as a pause, not a failure.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### C-21 — **Partial erasure is reported**, not silently claimed as success

**Proves:** the review I-2 tracking in `unlinkTracked` /
`purgeCloneArtifacts`'s `{ failed }` return, surfaced by the revoke route as
`artifactPurgeIncomplete` / `artifactPurgeFailedPaths`
(`voice-library.ts:981-992`).

**Preconditions:** a way to hold one artifact open so Windows returns
EBUSY/EPERM on the unlink. Practical options:
1. Open the `.pt` with an exclusive handle from a second PowerShell:
   ```powershell
   # Second shell — hold an exclusive handle, then leave it open.
   $fs = [System.IO.File]::Open("$WS\voices\qwen\$K.pt",'Open','Read','None')
   # ... run the revoke in the first shell ...
   $fs.Close()   # afterwards
   ```
   `FileShare.None` is the key — it blocks the delete.
2. Alternatively let the sidecar hold it open mid-`torch.load` (racy; option 1 is
   far more reliable).

**Steps**
1. On a healthy clone, open the exclusive handle (option 1).
2. `Invoke-RestMethod -Method Post "http://localhost:8080/api/voice-library/$U/revoke" | ConvertTo-Json -Depth 6`
3. Read the response and `logs\server.log`.
4. Close the handle; verify the rest of the state.

**Expected**
- HTTP is still **200** and `consent.revokedAt` **is** set — the consent flag
  blocks rendering regardless of on-disk artifacts (the resolver's `revoked`
  classification never consults the disk).
- The response body carries **`artifactPurgeIncomplete: true`** and
  **`artifactPurgeFailedPaths`** listing the held path. It must **not** read as a
  clean success.
- `logs\server.log` contains both:
  - `[purge-clone-artifacts] failed to erase "<path>" for voice "<uuid>" — artifact may still be on disk:`
  - `[voice-library] revoke for "<uuid>" left 1 artifact(s) un-erased:`
- Every **other** artifact in C-10's table is still erased (the purge is
  per-file best-effort, not all-or-nothing).
- After closing the handle, re-revoking (or deleting) clears the straggler.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

### Section D — cross-cutting

---

#### D-01 — Concurrent multi-book render sharing a cloned voice

**Proves:** concurrent multi-book work is a first-class invariant in this
codebase, and a library voice is workspace-level (shared across every book). Also
the practical setup for §6 KL-(j)(2)'s two-worker corner.

**Preconditions:** two imported books; **the same** cloned voice assigned to a
character in **each**; both books routed to Qwen.

**Steps**
1. Assign `$U` to a character in book A and a character in book B.
2. Start a chapter render in book A, then start one in book B while A is running
   (or queue both across books via the cross-book queue).
3. Let both complete.
4. Listen to one line from each.
5. Check `voice.json` and the qwen dir afterwards.

**Expected**
- Both chapters complete.
- The **same** cloned voice renders in both — same identity, no cross-book bleed
  into a different voice.
- No duplicate/competing `.pt` files; `$K.pt` is a single file.
- `voice.json` is intact and parseable (both workers may have written it;
  since Wave 3c's Task 14, `updateEntry`'s per-uuid promise-chain lock
  serialises both workers' read-modify-write, on top of the pre-existing
  tmp+rename atomicity — see §6 KL-j(1)/(2)).
- **Repeat once with a repair in play**: delete `$K.pt` first, then start both
  renders so both workers try to repair the same voice concurrently. Both should
  still complete; one or both derives fire. §6 KL-j(2) (the two-worker corner
  this repeat exists to exercise) now **appears fixed in source** — the same
  per-uuid lock that closes KL-j(1) also serialises worker A's and worker B's
  status-stamp writes here. **A `.pt` surviving a revoke in this scenario is
  now a regression, not an expected KL-j(2) hit** — file it rather than
  recording it against that item.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### D-02 — A full-book render with a cloned character, start to finish

**Proves:** the arc holds over a realistic workload, not just single chapters —
the pre-pass runs per chapter, so this exercises it N times with no accumulated
drift, leak, or spurious re-derive.

**Preconditions:** the Coalfall fixture book, fully analysed and cast, with `$U`
assigned to a character who speaks in most chapters. Start from a clean state
(healthy voice, no failed chapters).

**Steps**
1. Queue the **whole book**.
2. Let it run to completion. Note wall-clock and whether any chapter failed.
3. Grep `logs\tts.log` for `Cloned + cached Qwen voice` occurrences.
4. Spot-listen to the cloned character in the first, a middle, and the last chapter.
5. Check `voice.json` and the artifact set afterwards.
6. Export/assemble the book if that is part of your normal flow, and confirm the
   assembled audio is coherent.

**Expected**
- Every chapter completes. No `cloned-voice-broken`.
- **Zero** re-derives across the whole run (the voice was Healthy throughout) —
  a re-derive mid-book with no provocation is worth investigating.
- The cloned character sounds **identical** in the first, middle and last chapters.
- `voice.json`'s `engines.qwen` is unchanged from the start of the run.
- No stray `.tmp` files under `$WS\voices\qwen\`.
- Record any VRAM/capacity events and which card the run used.

**Record:** chapters = ____ · failures = ____ · re-derives = ____ · card = ______

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### D-03 — Restarting the server **and** sidecar leaves the cloned voice renderable

**Proves:** cache-independence — the clone lives in on-disk artifacts
(`voice.json` + `master.wav` + `qwen-<uuid>.pt`), not in sidecar process memory
(`_prompt_cache`) or a server-side cache.

**Steps**
1. With a healthy assigned clone and a completed chapter, `npm run stop`.
2. Confirm both processes are gone.
3. `npm start` again. Wait for `/api/health` and `/api/sidecar/health`.
4. Delete the previously-rendered chapter audio so the render is genuinely fresh.
5. Generate the chapter again.
6. Also press Play on the library card (a fresh audition through the sample route).

**Expected**
- The chapter completes with **no** re-derive (the `.pt` on disk is enough; the
  sidecar warms its in-memory prompt cache from it).
- The voice sounds the same as before the restart.
- The card sample plays.
- ⚠️ The sample-cache mp3 under `server\audio\voices\` may or may not survive the
  restart depending on whether anything purged it — either is fine; what matters
  is that a fresh synth produces the same voice.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### D-04 — Splice / QA-repair surface the cloned failure as **plain text**, not the structured code

**Proves:** §6 KL-(i) as **expected behaviour**, so nobody logs it as a defect
later. `chapter-splice.ts` and `chapter-qa-repair.ts` both call `synthesiseChapter`
and can hit the same `UnresolvableClonedVoiceError`, but neither classifies it —
they surface `.message` via `fail(...)`. Only `routes/generation.ts` emits the
structured `cloned-voice-broken` code.

**Steps**
1. With a **revoked** cloned voice assigned to a character in the chapter, trigger
   a **chapter splice** on that chapter.
2. Then trigger an **audio-QA repair** on that chapter.
3. Compare with the normal generation failure (C-02/C-15).

**Expected**
- Both operations **fail** — the never-substitute guarantee still holds on these
  paths (that is the important part).
- The failure text is the `UnresolvableClonedVoiceError` message, so it still
  **names the voice and the reason**.
- But: **no** `cloned-voice-broken` toast, **no** help link, and no
  `generationErrorCode` on these paths. **This is expected.** Record it as
  verified-as-expected, not as a defect.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

### Section E — 3c: cloned + designed voices on Coqui XTTS v2

Prep note: `$KX = "xtts-$U"` (the Coqui storage key, analogous to `$K`) is
already set alongside `$U`/`$K` in §3's shared PowerShell block. See §3.1's
"(3c)" rows for the artifact-path shape, and §3.2's artifact listing (now
includes the three xtts paths alongside the qwen ones).

---

#### E-01 — ⭐ Clone → cast on a Coqui-routed (Russian) book → generate

**Proves:** the wave's headline delivery — a cloned voice renders correctly
on Coqui, not just Qwen. Mirrors 268's C-repro pattern (Task 3's Wave-3c
equivalent).

**Preconditions:** a healthy cloned voice (`$U`); a Russian (or other
non-English) book, since that's the common case that routes to Coqui today.

**Steps**
1. Cast `$U` to a character in the Russian book.
2. Confirm the book/character actually routes to Coqui (not Qwen) —
   check the cast picker's resolved engine.
3. Generate the chapter that character speaks in.
4. Listen. Check `$WS\voices\xtts\$KX.pt`/`.json` afterwards.

**Expected**
- The chapter renders. The cloned character sounds like the source person,
  in Russian, on the Coqui engine.
- `$KX.pt` and `$KX.json` exist and are non-empty.
- No re-derive on a second render of the same chapter (the `.pt` is reused).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### E-02 — ⭐ Audition, then revoke — confirm Play refuses afterwards

**Proves:** Property 1/2 hold on the audition surface for Coqui, mirroring
268's C-02/A-12 pattern (Task 2's Wave-3c equivalent).

**Preconditions:** a healthy cloned voice with a Coqui-routed character cast.

**Steps**
1. Play the library card's sample (or the cast-row audition) — confirm it
   plays and sounds like the person.
2. Revoke the voice (My voices → card → Revoke, confirm the two-step
   dialog).
3. Try Play again — card sample, and (if reachable) the cast-row audition.

**Expected**
- Step 1 plays successfully.
- After revoke, Play **refuses** — a 403/409-class response, never a stale
  cached clip of the revoked person.
- The three xtts artifact paths (`.pt`, `.json`, and — if a derive happened
  recently enough that it might still be present — the reference-audio temp
  WAV) are gone from disk.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### E-03 — Revoke lands during an in-flight Coqui derive

**Proves:** the same post-derive re-read + re-purge race 268's C-01 proved
for Qwen, now on the Coqui side — the current implementation is
`statusStampMutate` (`clone-voice-resolver.ts:360-375`, run inside
`deps.updateEntry`'s per-uuid lock; this is the Wave 3c multi-engine
successor to the earlier Qwen-only `guardPostDeriveWrite`, same guarantee,
engine-parametric now) — and Task 11a's specific addition: a forward already
past `_load_voice_latents` when the evict lands still completes and returns
audio (the non-zero revoke-to-silence bound).

**Preconditions:** a healthy, assigned clone cast on a Coqui-routed
character; the sidecar up. Force a repair first (mirroring 268's C-01
technique): delete `$KX.pt` but leave the manifest and the original
recording alone, so the render is guaranteed to derive.

**How to hit the window:** same technique as 268's C-01 — pre-stage the
revoke command in a second shell, fire it the moment the chapter starts
generating and before any audio appears.

**Steps**
1. `Remove-Item "$WS\voices\xtts\$KX.pt"`. Confirm `voice.json` still has
   `master`/the coqui slot and **no** `revokedAt`.
2. Start generating the chapter.
3. Fire the pre-staged revoke in the window between the chapter starting and
   the first synth call.
4. Let the chapter finish/fail. Check the artifact set and `voice.json`.

**Expected (all must hold)**
- `revokedAt` survives (not clobbered back to un-revoked).
- The chapter fails with a reason naming the character and `revoked`.
- No `.pt`/`.json`/reference-audio-temp-WAV survives on disk under
  `$WS\voices\xtts\`, even though the sidecar wrote one during the derive.
- **If** the revoke instead lands after the derive has already progressed
  past latents-load (i.e. you miss the narrow window and land later, inside
  the actual GPU forward), the chapter may still **complete and return
  audio** for that one in-flight request — this is the documented,
  non-zero revoke-to-silence bound (Task 11a), not a bug. Record which
  outcome you hit; both are informative.

**If you miss the window entirely** (revoke lands well before or well after
the derive), retry — budget 3–5 attempts, same as 268's C-01.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Attempts:** ____  **Notes:**

---

#### E-04 — A long sentence on a cloned Coqui voice

**Proves:** the `enable_text_splitting`/language-guard path the golden gate's
`test_xtts_clone_sanity` was specifically written to catch (a crash class
XTTS has on long input without it).

**Preconditions:** a healthy cloned Coqui voice cast on a character.

**Steps**
1. Find or write a chapter line for that character that is unusually long
   (a full paragraph in one sentence, or several clauses).
2. Generate that chapter/line.

**Expected**
- Renders without crashing or truncating audibly mid-sentence.
- No fallback to a stock catalogue voice.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### E-05 — Audition matches render

**Proves:** the card's Play button and the actual chapter render use the
same underlying artifact — no drift between "what you previewed" and "what
you got".

**Preconditions:** a healthy cloned Coqui voice.

**Steps**
1. Play the card's audition sample. Note the voice's character.
2. Generate a chapter using that voice on the same character.
3. Compare by ear.

**Expected:** the audition and the rendered chapter sound like the same
voice — same identity, no perceptible drift. (Note: `POST
/:voiceUuid/sample` itself is engine-aware now (#1887/Task 27) — it will
correctly audition Coqui when asked for it. The **My-voices card's** own
Play button now asks for Coqui too, GATE 1 F2 — it plays Qwen when
`engines.qwen.status === 'ready'`, else Coqui when `engines.xtts.status ===
'ready'`, else falls back to Qwen (and its pre-existing loud 409) — see §6
KL-o (fixed). The **cast-row** audition, unaffected by this fix, already
requests the character's actual routed engine (`cast.tsx:496`). Confirm on
a Coqui-primary card (Qwen not ready) that Play produces Coqui audio, and
record whichever surface you tested.)

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### E-06 — ⭐ A designed voice on a Coqui book — judge it against the stock catalogue voice it replaces (D-B's open question)

**Proves:** the only place D-B's central, explicitly-unresolved quality
question can actually be answered — format-level CI checks can prove the
derive isn't broken, never that it sounds better than what it replaces.
This is the wave's starred acceptance item; treat the verdict as data to
record, not a pass/fail gate on its own.

**Preconditions:** a **designed** (not cloned) Qwen voice, cast on a
character in a Coqui-routed book, with no prior Coqui-side artifact for it.

**Steps**
1. Generate a chapter that character speaks in. This should trigger a
   lazy designed-voice-on-Coqui derive (Task 20a) from the voice's retained
   synthetic calibration clip.
2. Listen to the resulting rendered audio.
3. Separately, listen to (or recall) how that same character sounds on the
   **stock Coqui catalogue voice** it would have used before this wave
   (`COQUI_PROFILE_VOICES`).
4. Judge: does the derived voice sound closer to the designed persona than
   the stock catalogue voice did?

**Expected:** no hard pass/fail — record your honest verdict (better /
worse / about the same) and any specific artifacting you hear. This is
genuinely open per the plan; a "worse" verdict is useful information, not
a failure of this test.

**Result:** ☐ Better ☐ Worse ☐ About the same ☐ B ☐ N/A  **Notes:**

---

#### E-07 — ⭐ A designed voice whose derive is forced to fail still renders the chapter (D-F)

**Proves:** the fail-**soft** policy — the opposite of E-02/E-03's cloned
fail-loud behaviour, on purpose. A designed voice is not a real person's
identity, so falling back to the catalogue on a bad derive is correct,
current, acceptable behaviour, not a regression.

**Preconditions:** a designed voice cast on a character in a Coqui-routed
book, with no existing Coqui artifact for it (so a derive will be
attempted). Force the derive to fail — e.g. stop the sidecar mid-chapter, or
(if reachable) temporarily corrupt/remove the voice's retained calibration
clip on disk before generating.

**Steps**
1. Force the derive-failure condition above.
2. Generate the chapter.
3. Restore whatever you removed/stopped afterwards.

**Expected**
- The chapter **completes** — no `cloned-voice-broken`, no chapter-level
  abort.
- The character renders on the **stock Coqui catalogue voice**
  (`COQUI_PROFILE_VOICES`), not silence and not a crash.
- No coqui slot is written to `cast.json`/the entry for this character (the
  entry stays as it was before the attempt).

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### E-08 — Assign writes both slots, provenance-gated (Task 24)

**Proves:** D-E's amended condition — a cloned entry, or a designed entry
**with** a retained clip, gets both `overrideTtsVoices.qwen` and `.coqui`
written on assign; a designed entry with **no** retained clip gets only the
qwen slot, byte-for-byte as before this wave.

**Preconditions:** three library entries — a cloned one, a designed one with
a retained calibration clip, and (if one exists on your box) a designed one
predating clip retention (no `qwen-<uuid>__master.wav`).

**Steps**
1. Assign each to a different character.
2. Inspect each character's `cast.json` entry (or the API response) for
   `overrideTtsVoices`.

**Expected**
- The cloned entry: both `qwen` and `coqui` slots present, engine-correct
  names.
- The designed-with-clip entry: both slots present.
- The designed-without-clip entry: **only** `qwen` present — no `coqui`
  slot at all.
- Assigning a Kokoro-only or otherwise ineligible entry still 409s as
  before.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

#### E-09 — Total erasure of the three Coqui artifact paths on delete

**Proves:** `purgeCloneArtifacts`'s Coqui erasure set is genuinely three
paths (`.pt`, `.json`, and the reference-audio temp WAV), matching 268's
C-10/C-11 pattern for Qwen.

**Preconditions:** a healthy cloned Coqui voice, recently derived (so a
reference-audio temp WAV may still be on disk if you catch it fast enough —
otherwise this only proves the two persistent paths, which is still
useful).

**Steps**
1. Run the §3.2-style artifact listing against the `$KX`-prefixed paths
   under `$WS\voices\xtts\`.
2. Delete the voice entirely (My voices → card → Delete).
3. Re-run the listing.

**Expected:** every `xtts-<uuid>*` file under `$WS\voices\xtts\` is gone; the
entry no longer appears anywhere in the library; the `xtts-<uuid>`-scoped
sample cache for this voice (populated by any audition that actually
requested the Coqui `modelKey` — see E-05/KL-o's caveat about which UI
surface does that) is also gone.

**Result:** ☐ P ☐ F ☐ B ☐ N/A  **Notes:**

---

## 6. Known limitations — verify as EXPECTED, do not file as defects

Everything in this table is a **documented, accepted** limitation of the shipped
arc (plan 268 "Known limitations", plan 267's out-of-scope list). If you observe
it, tick "seen" and move on. **Do not open a defect for these.**

| ID | What you might see | Why it is expected | Filed as | Seen? |
|---|---|---|---|---|
| **KL-a** | — (this is the acceptance debt this sheet discharges: a real revoked voice failing a live render) | 268 owed item (a) → covered by **C-02** | — | n/a |
| **KL-b** | — (base-model-bump re-derive on live hardware) | 268 owed item (b) → covered by **C-07** | — | n/a |
| **KL-c** | — (artifacts confirmed gone by `ls`, not by fixture) | 268 owed item (c) → covered by **C-10** | — | n/a |
| **KL-d** | An assign that *should* have been blocked goes through — e.g. via a direct API call that omits `modelKey`. | The assign-time `wrong-engine` guard is **advisory only**; a client can omit or misrepresent `modelKey`. The hard boundary is the render-time pre-pass (C-13), which fails loud regardless. | — (by design) | ☐ |
| ~~KL-e~~ | ~~Nothing user-visible — two adjacent engine→modelKey mappers with different semantics and no cross-reference.~~ **Fixed** — `server/src/tts/clone-engines.ts` now centralises the shared engine vocabulary (`CLONE_CAPABLE_ENGINES`, `manifestSlotFor`, `cloneStorageKey`, `isArtifactVersionStale`, etc.) that both mappers and the resolver/routes now share, closing the cross-reference gap. | [#1812](https://github.com/dudarenok-maker/Castwright/issues/1812) (closed) | ☐ |
| ~~KL-f~~ | ~~A multi-second dead pause at the start of a chapter with no UI signal, then synth resumes.~~ **Fixed** — a new `chapter_preparing_voice` SSE tick fires the moment a Repairable/self-heal re-derive starts (`onVoicePrepare`, `clone-voice-resolver.ts`), and the generation row now shows a **"Preparing voice…"** pill and a **"Preparing voice — `<Character>`…"** caption (`src/views/generation.tsx`) instead of going silent. Watch **C-06**, **C-07**, **C-20** (and the Coqui-side **E-01**/**E-03**/**E-06**) for the pill/caption appearing rather than a dead pause — a re-derive with no UI signal at all is now a **defect**, not expected. | [#1813](https://github.com/dudarenok-maker/Castwright/issues/1813) (fixed) | ☐ |
| **KL-g** | A book that **used to render** (a cloned voice on a non-Qwen character, silently substituted) now **hard-fails** with `wrong-engine`. | Intended headline behaviour change — that silent substitution is exactly what this wave exists to stop. There is **no migration/backfill**; the fix is to reassign the character or switch the book/character back to Qwen. | — (by design, 268 KL-g) | ☐ |
| **KL-h** | The My-voices card shows **no chip** for a voice the render will reject (e.g. a `wrong-engine` case, or a voice whose `.pt` was deleted on disk). | `deriveClonedVoiceState` (`voice-library-card.tsx:112-119`) is a client-side approximation of `consent.revokedAt`, `master`, and — since Wave 3c — the **worse of `engines.qwen.status` and `engines.xtts.status`** (a Coqui-side `failed`/`stale` now also drives the danger/warning chip, not just Qwen's). It still cannot see `.pt` presence on disk or the routed engine. **The card is a heads-up; the resolver pre-pass is the source of truth.** Explicitly checked in **C-16**. | — (by design, 268 KL-h) | ☐ |
| **KL-i** | A cloned-voice failure during a **splice** or **QA repair** shows only the raw message — no toast, no help link, no `cloned-voice-broken` code. | The structured `FailureCode` is wired at `routes/generation.ts` only. Both other routes still fail (the guarantee holds); they just don't classify. Explicitly checked in **D-04**. | — (documented, 268 KL-i) | ☐ |
| **KL-j(1)** | ~~After a revoke that raced an in-flight derive, `consent.revokedAt` is missing~~ — should no longer reproduce. | **Appears fixed in source (Wave 3c, Task 14), issue still open — verify the SHA under test.** `workspace/voice-library.ts`'s `updateEntry(uuid, mutate)` now holds a per-uuid promise-chain lock (`withEntryLock`) across the ENTIRE fresh-read + mutate + write span, not just the write, and every read-modify-write call site — the revoke route's `revokedAt` stamp, the resolver's post-derive `statusStampMutate`, PATCH, redesign/promote, and `purgeCloneArtifacts`'s master-clip clear — now routes through it. The commit (`74bff8b3`) explicitly states this closes "the millisecond window the resolver's own doc comment flagged as a known follow-up" — i.e. exactly this row. Cross-process locking (two separate server processes sharing one workspace) is still explicitly out of scope, same carve-out as before, but that's not this sheet's D-01 scenario (one server process, two concurrent chapter workers). If C-01 still reproduces a clobbered `revokedAt` on your SHA, that is now a **regression**, not expected — see C-01's own updated note. | [#1826](https://github.com/dudarenok-maker/Castwright/issues/1826) (open — fix appears present in source) | ☐ |
| **KL-j(2)** | ~~The two-worker corner: B's `.pt` survives a revoke that raced worker A's derive.~~ — should no longer reproduce, for the same reason as KL-j(1). | Same per-uuid `updateEntry` lock (Task 14) serialises worker A's and worker B's status-stamp writes for the same voiceUuid — whichever runs second re-reads the FIRST one's already-written state (including a landed `revokedAt`) before deciding whether to write or re-purge, so B can no longer observe a stale un-revoked snapshot. Watch for this in **D-01**'s repeat-with-repair step; a surviving `.pt` there is now a **regression**, not expected — same caveat as KL-j(1) about verifying the SHA and about the cross-process carve-out. | [#1826](https://github.com/dudarenok-maker/Castwright/issues/1826) (open — fix appears present in source) | ☐ |
| **KL-k** | ~~The wizard's **Transcript textarea is editable, but edits appear to have no effect**.~~ **Confirmed and FIXED** — `CloneVoiceRequest` now carries an optional `transcript`; the panel forwards the edited value, and `POST /clone` distils against it and persists it as `master.transcript` / `sampleTranscript` with `transcriptSource: 'user'`. | Verify the fix rather than the defect: edit the transcript before Save, then confirm the saved entry's `voice.json` shows your corrected text and `transcriptSource: "user"`. A blank edit intentionally falls back to the Whisper text. | [#1836](https://github.com/dudarenok-maker/Castwright/issues/1836) (fixed) | ☐ |
| **KL-l** | The cloned entry directory has **no `preview.mp3`**, though spec §2.2 shows one. | 3b1 deliberately does not persist a preview — the audition is served on demand by `POST /:uuid/sample` + the sample cache (`voice-library.ts:656-662`). Spec text is stale, code is correct. | — (by design) | ☐ |
| **KL-m** | ~~Cloning on **XTTS/Coqui** is nowhere to be found.~~ **Shipped in 3c** — see Section E. | Historical row, kept for context. | — (superseded) | ☐ |
| **KL-n** | `mint_variant` (emotion-variant `.pt`) still uses a **bare `torch.save`**, not the atomic write. | Explicitly out of scope for 268 Invariant 6 — it is off the resolver's re-derive path. Do not test it here. | — (out of scope) | ☐ |
| ~~KL-o~~ | ~~The **My-voices card's** Play button auditions the **Qwen** artifact even for a Coqui-only or Coqui-primary card — E-05's caveat.~~ **Fixed** — `POST /:voiceUuid/sample` became engine-aware in Task 27 (#1887, closed), and the remaining gap — the card's own `playSample()` always sending `modelKeyForEngineChoice('qwen', …)` regardless of readiness — is now closed too (GATE 1 F2): `voice-library-card.tsx` computes `previewEngine` from `entry.engines.qwen?.status`/`entry.engines.xtts?.status`, playing Qwen when ready, else Coqui when ready, else falling back to Qwen's existing loud 409. The **cast-row** audition (`cast.tsx:496`) was already unaffected — it requests the character's routed engine directly (Task 25, #773d4eaa). Confirm the new behaviour in **E-05**: a Qwen-stale/Coqui-ready card should now play Coqui, not 409. | [#1887](https://github.com/dudarenok-maker/Castwright/issues/1887) (closed — route and card caller both fixed) | ☐ |
| **KL-p** | A cloned voice's coqui slot can, in principle, be reachable through a route this sheet does not exercise (the manual cast-link routes), copying a cloned voice onto a character in a book that never had consent captured for it. | **Appears fixed in source, issue still open — verify the SHA under test.** `cast-link-prior.ts` has a `sourceIsCloned`/`targetIsCloned` fail-safe guard (`characterHasClonedSlot`) that refuses to denormalise a cloned voice's slot across a manual link in either direction. `workspace/series-reuse-link.ts`'s `clearStaleLink` now carries the same guard on its destructive half: a stale-linked character with a cloned slot keeps its `overrideTtsVoices`/`voiceStyle`/`ttsEngine`/`voiceUuid` instead of having them wiped (the dead link's `matchedFrom`/`matchFactors` are still cleared either way — only the voice fields are protected). If your SHA predates this, the gap is exactly as originally described. Not directly exercisable from this sheet's normal flows — recorded here so a tester who notices anomalous consent state on a linked/series book knows this is the known (now-fixed-in-source) cause, not a new defect. | [#1885](https://github.com/dudarenok-maker/Castwright/issues/1885) (open — fix appears present in source) | ☐ |
| ~~KL-q~~ | ~~A revoke's `200` could mask a silently-failed sidecar evict.~~ **Fixed** — a failed/timed-out sidecar evict now surfaces via `artifactPurgeFailedPaths` instead of a bare swallowed `catch {}`. Watch **E-02/E-03** for the (separately tracked, non-blocking) residual: a **stopped** sidecar currently reports the same signal as a genuine failure, even though it has no in-process cache to leak from. | — (fixed) | ☐ |
| **KL-r** | A wholesale `PUT /api/books/:bookId {slice:'cast'}` can, in principle, let a client restamp a character's `voiceUuid` and matching engine-slot name directly, with no consent check on this route at all. | **Appears fixed in source, issue still open — verify the SHA under test.** `preserve-cast-voices.ts` now (a) always keeps `voiceUuid` server-owned (the incoming value is ignored whenever an on-disk character already exists) and (b) exports `rejectForeignCloneKeys`, which throws — refusing the whole wholesale write — if any incoming clone-capable engine slot's `libraryUuid`/reserved-prefixed `name` doesn't already match what's on disk for that character. Both are wired into `routes/book-state.ts`'s `PUT` handler. If your SHA predates this, the gap is exactly as originally described: `voiceUuid` was never in `PRESERVED_DESIGN_FIELDS` and nothing rejected a foreign clone key. | [#1899](https://github.com/dudarenok-maker/Castwright/issues/1899) (open — fix appears present in source) | ☐ |

---

## 7. Results summary & sign-off

### 7.1 Result table

Mark each: **P** pass · **F** fail · **B** blocked · **N/A** not applicable.

#### Section A — 3a (13)

| ID | Test | Result | Notes |
|---|---|---|---|
| A-01 | Clean ≥8 s clip → candidate + transcript | **P** | 202; real Whisper transcript; 20.0 s; 24000 Hz; `qualityWarnings` []; `master.wav`+`candidate.json`; header `52 49 46 46 … 57 41 56 45` |
| A-02 | <4 s → 400 duration message | **P** | 400, `Sample too short (2.0s) — need at least 4s.` exact; no candidate dir created |
| A-03 | Near-silent → 400 | **P** | 400, `Sample is silent or too quiet — record closer to the mic.` exact |
| A-04 | 4–8 s → warns, proceeds | **P** | 202; exactly one warning, `Sample is a little short (6.0s) — 8s+ clones better.` |
| A-05 | Clipping → warns, proceeds | **P** | 202; `Audio is clipping — lower the input level or move back from the mic.` |
| A-06 | >60 s → capped, not rejected | **P** | 202; `durationSeconds` 60 not 90; `master.wav` **2,880,044 bytes — delta 0**; no length warning |
| A-07 | Browser recorder (webm/opus) end to end | **B** | needs a real browser + real microphone |
| A-08 | Mic denied → Upload fallback | **B** | needs a browser with mic permission blocked |
| A-09 | Consent gates Continue | **B** | wizard UI; needs a browser |
| A-10 | Write-time consent guard; nothing persisted | **P** | 422 consent message; missing `candidateId` 400; unknown 404; lib entries 0→0; `.pt` 605→605; candidate NOT consumed |
| A-11 | `/revoke` stamps `revokedAt` | **P** | 200; `revokedAt` set, `personName`/`relationship`/`permittedUse`/`attestedAt`/`attestedBy` unchanged; entry dir + `voice.json` survive; `master` now absent; unknown uuid → 404 |
| A-12 | Sample route 403s a revoked voice | **P** | 403 `This cloned voice has no valid consent and cannot be played.` exact; healthy control 200 `cached:true` |
| A-13 | Voice library unconditionally available | | |

#### Section B — 3b1 (13)

| ID | Test | Result | Notes |
|---|---|---|---|
| B-01 | Wizard happy path (Upload) → ready cloned entry | **P** (route + disk) | 200; `$U` = `0abceba4-5eba-4d8f-8bdf-46bee14c931d`; baseModel `Qwen/Qwen3-TTS-12Hz-0.6B-Base`; entry dir `voice.json`+`master.wav`; `qwen-$U.{pt,json}`; `.pt` 605→606; candidate consumed; manifest `clone:true`, `designModel:null`, `refText`=transcript; no `preview.mp3` (expected). **UI assertions (completion screen, card badge) still owed** — driven via the API, not the wizard |
| B-02 | Wizard happy path (Record) | **B** | needs a real browser + microphone |
| B-03 | Audition **sounds like the person** | **B** | requires a human listener. Objective half done: `/embed` cosine audition-vs-source **0.822**, designed-voice control **0.158**. A/B kit left at `C:\fixtures\fs38\_EARCHECK\` |
| B-04 | ECAPA cosine is a real number, not a mock constant | **P** | Three distinct finite values in [-1,1]: F-1 **0.8914416029109107**, F-1 again **0.8812903511976901** (similar, not byte-identical → computed, not stubbed), two-speaker mix **0.7727**. `cloneFidelityUnavailable` absent. A 4th clone post-fix scored 0.8916 on an independent speaker |
| B-05 | Fidelity-unavailable is advisory, not fatal | **B** | no way to fail `/embed` independently of the clone path — the sheet's own caveat |
| B-06 | Low-fidelity clip warns but still saves | **B — not reachable as written** | See **#1945**. The cosine scores clone-vs-source *faithfulness*, so degrading the source degrades the clone equally: clean 0.891, band-limited **0.881** (not lower), two speakers 0.773. Nothing realistic nears `CLONE_FIDELITY_MIN = 0.3`; **the advisory-warning path has never fired on hardware** |
| B-07 | Assign to a character | **P** | 200 `{updated:1, written:["qwen","coqui"]}`; qwen slot `{name:qwen-$U, libraryUuid:$U, provenance:cloned}`; **`variants` map dropped** (had a `whisper` variant); `voiceUuid` unchanged; **coqui slot also written** `{name:xtts-$U,…}` per Task 24; all 13 characters diffed — only the target changed |
| B-08 | Cast sample plays in the cloned voice | | |
| B-09 | Chapter renders, consistent across lines | | |
| B-10 | Consistent across chapters | | |
| B-11 | Un-derived clone assign → 409 | | |
| B-12 | Capacity-admission-**ON** branch of `/qwen/clone-voice` | | |
| B-13 | Sidecar failure status preserved, nothing persisted | | |

#### Section C — 3b2 (21)

| ID | Test | Result | Notes |
|---|---|---|---|
| **C-01** ⭐ | **Revoke lands mid-derive**: `revokedAt` survives, chapter fails, no `.pt` survives | | |
| C-02 | Revoked → fails loud, names the voice, **zero audio, zero GPU** | **B** | needs a full-chapter render — blocked by the side-11 leak (see §7.2 BLOCKER-1) |
| C-03 | Broken voice not in this chapter doesn't fail it | | |
| C-04 | Title-beat narrator path is gated | | |
| C-05 | Orphaned-characterId narrator path is gated | | |
| C-06 | Repairable (`.pt` deleted) → transparent re-derive, chapter completes | | |
| C-07 | Base-model bump → same re-derive | | |
| C-08 ⭐ | **Transient** failure → Broken but **not bricked**; restart + re-run succeeds | | |
| C-09 | **Permanent** 4xx → persists `failed` (terminal) | | |
| C-10 ⭐ | **Total erasure on revoke**, incl. the entry-dir recording | **P** | Pre-state 7 artifacts / 3 locations (`.pt`, `.json`, `__1.7b.pt`, `master.wav`, `voice.json`, 2 cached mp3s). After revoke: 200 with **no `artifactPurgeIncomplete`**; every GONE-table row gone; **wildcard sweep 0 files**; sample cache 0. Survives: entry dir + `voice.json`, `revokedAt` set, rest of consent intact, `master` block absent |
| C-11 | Delete also removes the entry dir + clears cast refs | **P** | Unconfirmed DELETE → **409** with `usage:[{bookId, bookTitle, characterId, characterName}]`, nothing erased. `?confirm=1` → 200 `{deleted:true}`; artifacts 2→0; **entry dir removed**; the referencing character's **qwen *and* coqui** slots both cleared |
| C-12 | Atomic `.pt`: kill mid-write leaves no truncated `.pt` | | |
| C-13 | `wrong-engine` diagnosed distinctly at render time | | |
| C-14 | Assign-time `wrong-engine` 409, cause-specific copy, `modelKey` wins | | |
| C-15 | `cloned-voice-broken` toast + help link, per-chapter dedupe | | |
| C-16 | Broken / Repairable card chip | | |
| C-17 ⭐ | §2.3 designed self-heal + **persona survives** + re-design works | | |
| C-18 | §2.3 stale `.pt` deliberately left alone | | |
| C-19 | 1.7B tier renders; `__1.7b.pt` created **and erased on revoke** | **P** | `qwen3-tts-1.7b` audition 200 in 49.7 s; `qwen-<uuid>__1.7b.pt` created (71,045 bytes); erased by the C-10 revoke above. The per-character 1.7B *toggle* UI was not exercised |
| C-20 | Pause during a repair derive → no failure/toast | | |
| C-21 | Partial erasure is reported, not claimed as success | | |

#### Section D — cross-cutting (4)

| ID | Test | Result | Notes |
|---|---|---|---|
| D-01 | Concurrent multi-book render sharing a cloned voice | | not reached |
| D-02 | Full-book render with a cloned character | **B** | blocked by side-11 (§7.2 BLOCKER-1). **Partially substituted:** a per-character re-record of a cloned character into a real chapter succeeded — `splice_complete`, 58 segments, `resolvedVoiceName` = the clone's key, `asr.verdict: ok`, WER 0 |
| D-03 | Server + sidecar restart → still renders (cache-independent) | **P** (incidentally) | Proven repeatedly while isolating #1941: the on-disk `.pt` survived 6 stack restarts and rendered correctly each time from a cold cache. Not run as the sheet's scripted steps |
| D-04 | Splice / QA-repair surface plain text (expected, KL-i) | | not reached |

#### Section E — 3c: cloned + designed voices on Coqui XTTS v2 (9)

| ID | Test | Result | Notes |
|---|---|---|---|
| **E-01** ⭐ | Clone → cast on a Coqui-routed (Russian) book → generate | | |
| **E-02** ⭐ | Audition, then revoke — Play refuses afterwards | | |
| E-03 | Revoke lands during an in-flight Coqui derive | | |
| E-04 | A long sentence on a cloned Coqui voice | | |
| E-05 | Audition matches render (KL-o caveat) | | |
| **E-06** ⭐ | A designed voice on a Coqui book — judged against the stock voice it replaces (D-B) | | |
| **E-07** ⭐ | A designed voice's forced derive failure still renders the chapter (D-F) | | |
| E-08 | Assign writes both slots, provenance-gated (Task 24) | **P** (via B-07) | Assigning a cloned entry wrote **both** `overrideTtsVoices.qwen` and `overrideTtsVoices.coqui` in one call — `{name: xtts-$U, libraryUuid: $U, provenance: cloned}`, `variants` absent. Confirmed twice (B-07 and the C-11 setup); C-11's delete then cleared both slots |
| E-09 | Total erasure of the three Coqui artifact paths on delete | **N/A this run** | The three `voices\xtts\` paths never existed — no XTTS derive ever ran (see E-01). C-11 confirmed the sweep is issued; it was a no-op here |

**Section E status: BLOCKED, not failed — see #1944.** Coqui/XTTS will not load in
a sidecar that has already served ECAPA `/embed`, and cloning always calls
`/embed`. A fresh sidecar returns a clean 409 `voice_not_designed`; a used one a
bare 500. E-01 was attempted: the Coqui splice reported `splice_complete` but
wrote no `voices\xtts\` artifacts and left `voiceEngine: qwen`, because the
character's own `ttsEngine: 'qwen'` overrides the requested `modelKey`. **No
substitution occurred** — the resulting audio still measured as the cloned
speaker (0.66 / 0.61 vs source), so the never-substitute guarantee held.

#### Totals

Run 1 — 2026-07-29. "not reached" tests are counted as neither P/F/B/N/A.

| Section | Total | P | F | B | N/A | not reached |
|---|---|---|---|---|---|---|
| A (3a) | 13 | 9 | 0 | 3 | 0 | 1 |
| B (3b1) | 13 | 3 | 0 | 4 | 0 | 6 |
| C (3b2) | 21 | 3 | 0 | 1 | 0 | 17 |
| D (cross-cutting) | 4 | 1 | 0 | 1 | 0 | 2 |
| E (3c) | 9 | 1 | 0 | 0 | 1 | 7 |
| **All** | **60** | **17** | **0** | **9** | **1** | **33** |

**Zero failures** — but that is not an acceptance signal: 33 tests were never
reached and 9 are blocked, including all of the highest-risk ⭐ set except C-10.
The one Critical defect this run found (#1941) was discovered *outside* the
scripted steps, while populating an artifact set for C-10.

### 7.2 Defects found

#### Run 1 — 2026-07-29

**DEF-A · CRITICAL · #1941 · fixed in PR #1942 · verified live**
**What:** every freshly cloned Qwen voice returns HTTP 500 on its first
synthesis until the sidecar is restarted — including the wizard's own
completion-screen audition.
**Test ID:** found outside the scripted steps, while populating artifacts for C-10.
**Repro:** 1. `POST /api/voice-library/clone` (200, `.pt` correct on disk).
2. `POST /api/voice-library/{uuid}/sample` → **500**. 3. Restart the sidecar;
the *identical* request → **200**.
**Expected:** the audition plays. **Actual:** `ValueError: not enough values to
unpack (expected 2, got 1)` at `main.py:5510`.
**Evidence:** `clone_voice` (`main.py:5290`) cached a bare `prompt` where
`_prompt_cache` is `dict[str, tuple[Any, str]]` (`:4123`) and the three other
writers store `(prompt, lang)`. Three separate clones reproduced it; post-fix a
new clone synthesised immediately in-process (200, 54.8 s).
**Severity:** blocker.

**DEF-B · MAJOR · #1943 — consent record cannot name the real attester.**
`voice-library.ts:1036` hardcodes `attestedBy: consentDraft.personName`, so for
`family-with-permission` and `guardian-of-minor` the record names the wrong
party — a guardian's attestation is stored as the *minor* attesting to their own
voice being cloned. The wizard has no attester field, and
`voice-library.test.ts:2435` asserts the incorrect behaviour. Needs a product
decision, so filed rather than fixed in-run.

**DEF-C · MINOR · #1945 — the clone-fidelity advisory has never fired.** B-06's
fixture recipe cannot lower a metric that scores clone-vs-source faithfulness.
See the B-06 row above for the three measurements.

**DEF-D · MAJOR · #1944 — Coqui/XTTS unloadable after ECAPA, and `/health` lies
about it.** Blocks all of Section E. `coqui_package_installed: true` comes from
a spec probe that never imports.

**Not defects (recorded so they are not re-filed).** (1) `ASR_DEVICE` and
`ASR_COMPUTE_TYPE` must agree — setting the device to `cpu` while
`ASR_COMPUTE_TYPE=int8_float16` stays pinned 500s every `/transcribe`.
`_compute_type()` is correct; the pairing is simply unenforced. (2) `npm start`
looks like it spawns two sidecars but does not — the venv `python.exe` is a
launcher that re-execs the base interpreter as a child; one process holds :9000.
(3) `npm run stop` reported `[GONE] tts pid=… (already exited)` for a pid
matching neither live process across several restarts — pid tracking drifts;
minor, unfiled.

**Pre-existing, not caused by this wave:** the **side-11 host-memory leak**
(committed memory peaked at 29,395 MB, sidecar recycled 3×) makes full-chapter
renders unreliable on this box. Also observed: `segments.json` attributes a
13.4 s ch.3 span to `wren` whose ASR transcript is plainly narration — an
attribution/segmentation question for the srv side, noted here only because it
briefly produced a false "silent substitution" reading during this run.

---

One block per defect. Copy the template as many times as needed.

```
### DEF-01
**What:**            (one sentence — the observed wrong behaviour)
**Test ID:**         (e.g. C-10)
**Repro:**           1.
                     2.
                     3.
**Expected:**
**Actual:**
**Evidence:**        (log excerpt / file listing / state.json fragment / screenshot path)
**Severity:**        blocker | major | minor | cosmetic
  - blocker  = a never-substitute or consent-erasure guarantee is violated,
               or a voice can be permanently bricked by a transient failure
  - major    = a documented invariant fails, but with a workaround
  - minor    = wrong copy / wrong status code / missing chip
  - cosmetic = presentation only
**Issue filed:**     #____   (must link #624 — see §8.3)
**Blocks acceptance:** yes | no
```

> **Severity guidance for this arc specifically.** Treat as **blocker**:
> a cloned voice rendering as *something else* (C-02, C-03, C-13); any
> resynthesis-capable artifact surviving a revoke (C-01, C-10, C-19); a transient
> failure persisting `'failed'` and bricking a voice (C-08); a persona lost on a
> designed self-heal (C-17); a truncated `.pt` (C-12). Everything else is major or
> below.

### 7.3 Environment deltas encountered

Anything you had to change to make the run possible (env vars flipped, models
loaded, preferences toggled) — and whether you **restored** it:

| # | What changed | Why | Restored? |
|---|---|---|---|
| 1 | | | ☐ |
| 2 | | | ☐ |
| 3 | | | ☐ |

Specifically confirm these are back to their P-20 / P-22 / P-23 values:

- ☐ the hand-added `voices.library.enabled` override removed again (A-13)
- ☐ `SEG_CAPACITY_ADMISSION` restored to `1` (B-12)
- ☐ Session engine picker restored (C-13, C-14)
- ☐ Any hand-edited `voice.json` restored or the voice re-cloned (B-11, C-07, C-09, C-16, C-18)
- ☐ `cast.json` restored from backup (C-05)
- ☐ Any held file handle released (C-21)
- ☐ Sidecar autostart preference restored (C-08)

### 7.4 Overall verdict

> **fs-38 Wave 3 (3a + 3b1 + 3b2) is:  ☐ ACCEPTED  ☐ ACCEPTED WITH DEFECTS  ☐ REJECTED**
>
> **Run 1 (2026-07-29) reaches NONE of these — the run is INCOMPLETE.**
>
> Accept only if **every ⭐ test passed** and there are **zero blocker defects**.
> "Accepted with defects" requires each open defect to be filed, linked, and
> explicitly judged non-blocking above.

**Rationale (2–3 sentences):**

16 of 60 tests were executed (15 pass, 1 blocked); of the ⭐ set only **C-10**
passed, so the acceptance bar is not met and cannot be met until Section E is
unblocked (#1944) and the remaining ⭐ tests C-01 / C-08 / C-12 / C-17 are run.
The run did establish the wave's central claim — a cloned voice renders inside a
real book as the cloned speaker, measured via the production `/embed` (audition
vs human source **0.822**, in-book segments **0.564** / **0.706**, designed-voice
control **0.158**) with `asr.verdict: ok` and WER 0 — and it found one Critical
defect on shipped `main` (#1941, fixed in PR #1942, verified live): every fresh
clone 500'd on its first synthesis, i.e. the wizard's own completion audition
failed for every user until a sidecar restart.

Two environment blockers, not fs-38 defects, gate the remainder: the **side-11
host-memory leak** makes any full-chapter render unreliable (blocks C-02, D-02,
D-04 — use the per-character splice path instead), and **Coqui/XTTS will not
load in a sidecar that has already served ECAPA `/embed`** (#1944), which blocks
all of Section E. `/health` reports Coqui available regardless, which is how this
run was mis-scoped as unblocked.

**Tester:** Claude Code (agent), on the repo owner's dual-GPU box   **Date:** 2026-07-29

**Git SHA accepted (from P-03):** none — `2503bca6` was **tested, not accepted**

---

## 8. What to do with these results

### 8.1 Record the run

1. Fill this sheet in **as you go** — the filled-in copy *is* the record.
2. Commit it into the repo so it survives:
   - Put it at **`docs/features/acceptance/2026-07-XX-fs38-wave3-onbox.md`**
     (create the `acceptance/` folder if it does not exist — ⚠️ **verify on box**
     that no other convention already applies; if `docs/features/` has no such
     subfolder, attach it to the plan instead as a `## On-box acceptance` section
     in 268 and keep the raw sheet in the PR description).
   - Cut a branch: `git switch -c docs/docs-fs38-wave3-onbox-acceptance`.
   - Commit: `docs(docs): record fs-38 Wave 3 on-box acceptance run`.
   - Open a PR with `Refs #624` in the body. A docs-only PR is exempt from the
     `code-review` gate but still needs the issue link.
3. Attach any evidence (log excerpts, `ls` output, screenshots) alongside, or
   paste the relevant fragments inline in the Notes fields.

### 8.2 On a clean run — update the plans

Both plans carry explicit owed-acceptance sections that this run discharges.
Edit them **in the same PR**:

**`docs/features/267-fs38-wave3-voice-clone.md`**
- Replace the blockquote under "Manual acceptance walkthrough" that begins
  **"Owed — on-box live-GPU acceptance (spec §8), not yet run."** with a
  discharged note: date, tester, git SHA, and the test IDs that cover it —
  (a) → **B-03**, **B-04**, **B-09**, **B-10**; (b) → **B-11**, **C-13**.
- If the whole arc is accepted, consider flipping `status:` and filling
  **Ship notes** (shipped date + merge SHA), then `git mv` it to
  `docs/features/archive/` and update `docs/features/INDEX.md`. **Only** if 3c is
  genuinely not going to reopen this plan — 267's Ship notes currently say "to
  fill when the whole Wave-3 arc — 3a through 3c — ships", so if 3c is still
  planned, leave it `active` and just discharge the acceptance debt.

**`docs/features/268-fs38-wave3b2-resolver.md`**
- Replace the blockquote under "Manual acceptance walkthrough" beginning
  **"Owed — on-box live-GPU acceptance, not yet run."** — (a) → **C-02**,
  (b) → **C-07**, (c) → **C-10** (+ **C-19** for `__1.7b.pt`).
- Under "Known limitations / owed on-box acceptance", strike items **(a)**,
  **(b)** and **(c)** and replace them with a one-line pointer to the recorded
  run. Leave **(d)–(j)** exactly as they are — they are design limitations, not
  acceptance debt.
- Fill **Ship notes** with the shipped date and the merge SHA of the 3b2 PR.
- If 268 is now `stable`, `git mv` it to `docs/features/archive/` and re-link it
  from 267 / `docs/features/INDEX.md` / `docs/features/194-voice-cloning.md`.

**Also**
- Update `docs/features/194-voice-cloning.md` (the fs-38 umbrella) with the
  Wave-3 acceptance status and what remains (Wave 2 catalogue rebuild, 3c XTTS).
- Comment the outcome on **[#624](https://github.com/dudarenok-maker/Castwright/issues/624)**
  with a one-paragraph summary and a link to the committed sheet.

### 8.3 On any defect — file it

For **each** defect in §7.2:

1. Open a GitHub issue using the **bug** issue form.
2. Label it `bug` (standalone — bug-shaped work does not take
   `type:`/`moscow:`/`area:` per CONTRIBUTING.md's two-shape convention).
3. **The body must link `#624`** — e.g. `Found during fs-38 Wave 3 on-box
   acceptance, Refs #624.` Include the test ID, the exact repro steps, expected
   vs. actual, and the evidence.
4. Record the issue number back in §7.2's `Issue filed:` field.
5. If the defect is a **blocker** per §7.2's guidance, say so in the issue title
   or first line, and mark the overall verdict in §7.4 accordingly.
6. Do **not** file anything listed in §6 — those are already documented/filed.
   KL-k (the wizard transcript edit) was confirmed and fixed under
   [#1836](https://github.com/dudarenok-maker/Castwright/issues/1836) before this
   run sheet was executed, so it is no longer an exception — verify the fix per
   its §6 row instead of filing it.

### 8.4 Release notes

If this run is purely an acceptance record (no code change), it has **no
shippable delta** — skip `docs/release-notes-next.md` and `RELEASE_NOTES.md`, and
say so explicitly in the PR body. If any defect fix rides along, that fix takes
its own PR with its own notes entries.

---

*End of run sheet.*
