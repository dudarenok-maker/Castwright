---
status: draft
date: 2026-06-22
topic: srv-47 — optional CUDA path for the render-integrity ECAPA embed
issue: srv-47 (#992)
depends_on: srv-36 (#665 — shipped the SpeakerEngine + /embed + embed-client this hardens) · srv-31 (the ASR cuda pattern this mirrors: semaphore gate + idle watchdog)
relates_to: fs-55 (#993 — variant-fidelity gate; reuses the GPU substrate this lays) · fs-45 (#861 — VRAM telemetry; the gpuSemaphore budget this charges against)
moscow: Could (scale optimisation — CPU embed ~60–65 ms/segment is comfortably fast today on the 8 GB box)
revised: 2026-06-22 (adversarial round, code-grounded vs origin/main). Corrected: SPK_DEVICE is ALREADY a registry knob `qa.speaker.device` + already in .env.example (don't re-add); sidecar env propagation is GENERIC (spawn-sidecar.ts Layer-2 loop auto-injects any non-default restart-sidecar knob — no manual wiring); the runtime CPU-demote is narrowed to FIRST-USE-ONLY (steady-state failures are poison→recycle or input-deterministic, so a per-embed wrapper is mostly dead path); watchdog mirrors ASR's SIMPLE maybe_free_idle (mid-inference free is benign under refcounting — no Qwen-style in-flight counter); help-text flip for `qa.speaker.device` ("cuda is Phase 2" → shipped).
---

# srv-47 — optional CUDA path for the render-integrity ECAPA embed

## Goal

srv-36 shipped the render-integrity ECAPA speaker-embedding check **CPU-only by
design** (its spec §"Deps gotcha": _"CPU-only v1 (cuda + VRAM semaphore = Phase
2)"_). The `SpeakerEngine` (`server/tts-sidecar/main.py`) already reads a
`SPK_DEVICE` env var (default `cpu`) and passes it straight to the model loader,
so `SPK_DEVICE=cuda` **naively loads on GPU today — but unsafely**: there is no
VRAM arbitration (the embed runs inline during a chapter pass and would race
Qwen/Kokoro synth → OOM on the 8 GB box), and the model pins VRAM forever once
loaded (no idle evict).

srv-47 is **this deferred Phase 2**: make `SPK_DEVICE=cuda` *safe* by bringing
the embed path up to the standard the ASR engine (srv-31) already uses —
weighted-semaphore-gated when on GPU, idle-evicting, with a defined CPU
fallback. **CPU stays the hard default + automatic fallback.** This is a
hardening task, not a new capability.

Framed **Could**: the CPU embed (~60–65 ms/segment) is comfortably fast today,
and adding a GPU model during synth is exactly the co-residence pressure point
on an 8 GB card — so this ships behind a default-off switch and lays the GPU
substrate **fs-55** can reuse, rather than changing the default path.

## What is NOT in scope (carried in from srv-36, not re-litigated)

1. **Detection scoring is unchanged.** A 192-d unit-norm ECAPA vector is
   byte-for-byte device-agnostic, so the centroids, `score.ts`, the
   per-character percentile cutoffs, the 3-tier verdict, and every `*-io.ts`
   store are **untouched**. srv-47 changes *where the vector is computed*,
   never *what it means*.
2. **render-integrity stays default-OFF** (`SEG_SPK_ENABLED`). `SPK_DEVICE=cuda`
   only ever matters when the QA gate is enabled; the cuda switch is a knob
   under a knob.
3. **No process isolation / separate embed process.** The embed shares the
   sidecar process + CUDA context with synth, as today. (This is what makes the
   poison-fence reasoning below load-bearing.)

## As-shipped baseline (origin/main @ srv-36)

- **`SpeakerEngine` (`server/tts-sidecar/main.py:1935`)** — `self.device =
  os.environ.get("SPK_DEVICE", "cpu")`; `ensure_loaded()` calls
  `EncoderClassifier.from_hparams(..., run_opts={"device": self.device})`;
  `embed()` runs under a `threading.Lock`. **No `_last_used`, no `unload()`, no
  idle watchdog.** `/health` already reports `"spk_device": SPK.device`.
- **`/embed` endpoint (`main.py:3497`)** — already honours the CUDA-poison +
  recycle-drain fences exactly like `/transcribe` (returns 503 + `poisoned:true`
  and schedules the supervised exit when `_CUDA_POISON_RE` matches).
- **`embed-client.ts` (`server/src/tts/embed-client.ts`)** — a **bare `fetch`**
  with **no VRAM arbitration**. This is the safety gap vs. `transcribe-client.ts`.
- **`transcribe-client.ts`** — the pattern to mirror: an `asrRunsOnGpu()` gate
  (reads `ASR_DEVICE` env, in lockstep with the sidecar under `npm start`)
  acquires `gpuSemaphore.acquire(costForEngine('asr'))` **only on cuda**, with a
  guaranteed `release?.()` in `finally`; uses an `undici` `Agent` dispatcher
  (headers/body timeout 0, connect 10 s); tags unreachable/5xx as `transient`.
- **VRAM semaphore (`server/src/gpu/semaphore.ts`)** — FIFO weighted token
  pool; `acquire(cost)` → release fn; budget resolved from `gpu.vramBudget`
  (default ~4 on the 8 GB box). **`engine-vram-cost.ts`** maps engine → weight
  (`asr: 1`) and `costForEngine()` reads `gpu.weight.*` live from the registry.
- **Idle watchdog precedent** — `_asr_idle_watchdog()` / Qwen's
  `_qwen_design_idle_watchdog()` in `main.py`: an async loop
  (`interval = min(30, max(5, ttl/4))`) that calls `maybe_free_idle(ttl)` on a
  worker thread, started/stopped via `@app.on_event("startup"|"shutdown")`, and
  defensively never dies on a transient tick error.
- **Poison classifier (`main.py:179` `_CUDA_POISON_RE`)** — matches liberally
  and **deliberately includes `CUDA out of memory`** (comment: _"we never want
  to MISS a poison — over-classifying is harmless"_). This is load-bearing for
  the fallback design.

## Design — four components

### 1. Node — `embed-client.ts`: semaphore gate (mirror `transcribe-client.ts`)

- Add `spkRunsOnGpu(): boolean` → `(process.env.SPK_DEVICE ?? 'cpu').trim().toLowerCase() === 'cuda'`.
- Acquire `gpuSemaphore.acquire(costForEngine('spk'))` **only when
  `spkRunsOnGpu()`**; `release?.()` in a `finally`. On the cpu default path,
  take **no** token (taking one would needlessly serialise the embed behind
  synth — same rationale as ASR).
- Swap the bare `fetch` for the shared `undici` `Agent` dispatcher pattern
  (`headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000`) so a busy
  sidecar under cuda contention never aborts an in-flight embed mid-call.
- Tag sidecar-unreachable and 5xx errors as `transient` (mirrors
  `transcribe-client.ts`) so the existing retry/queue logic treats them right.

### 2. Sidecar — `SpeakerEngine`: load-time degrade + idle evict + first-use demote

**(a) Load-time graceful degrade.** In `ensure_loaded()`, if `self.device ==
"cuda"` and `not torch.cuda.is_available()` → set `self.device = "cpu"` and log
a warning, then load on CPU. A misconfigured env degrades instead of crashing.

**(b) Idle-evict watchdog** (mirror `_asr_idle_watchdog`):
- Add `self._last_used: float` (stamped at the end of each `embed()`), an
  `unload()`, and `maybe_free_idle(ttl)`.
- `unload()` reuses ASR's `_reclaim_host_and_vram()` helper (drop ref + a
  **cuda-guarded** `empty_cache()`) — do NOT inline an unguarded
  `torch.cuda.empty_cache()` on the cpu path (F7).
- **`maybe_free_idle` is a no-op when `self.device == "cpu"`** — there is no
  VRAM to reclaim and reloading ECAPA costs ~1 s; only the cuda path evicts.
  (This is a deliberate divergence from ASR, which frees on cpu too; for srv-47
  the reload churn isn't worth freeing ~80–200 MB of host RAM.)
- Mirror ASR's **simple** `maybe_free_idle` — a recency check on `_last_used`,
  **no in-flight lock/counter**. Freeing mid-inference is benign: the in-flight
  `encode_batch` holds its own model ref (CPython refcounting), and a cuda-guarded
  `empty_cache()` only frees *unreferenced* VRAM. Do NOT port Qwen VoiceDesign's
  `_design_in_flight` guard — it solves a problem this path doesn't have (F6).
- A dedicated `_spk_idle_watchdog()` async loop + `startup`/`shutdown` hooks,
  structured identically to the ASR watchdog (same defensive `try/except`, same
  `interval = min(30, max(5, ttl/4))` formula). TTL via `SPK_IDLE_TTL`
  (default `120`, 5 s floor) using the same resolver shape as `_asr_idle_ttl()`.

**(c) First-use CPU degrade — non-poison errors ONLY** (narrowed from "every
embed" after the adversarial round, F5). The realistic CPU-fixable failure is a
cuda that reports `is_available()==True` but is actually broken at load /
first use (cuDNN / driver mismatch) — which §2a's `is_available()` check can't
catch. Steady-state failures are either poison (→recycle) or input-deterministic
(a CPU retry fails identically), so wrapping every embed is mostly dead path.
- Guard **`ensure_loaded()` + the first `embed()`** (not steady-state calls):
  on a non-poison exception there, sticky-demote `self.device = "cpu"`, reload
  on CPU **synchronously** via `EncoderClassifier.from_hparams(...,
  run_opts={"device": "cpu"})` under the already-held `_infer_lock` (the embed
  runs in a worker thread and cannot await the asyncio `_load_lock` — F8), retry
  once, and proceed on cpu for the process lifetime. Log the demotion.
- If `_CUDA_POISON_RE.search(err)` matches (device-side assert, cublas, **CUDA
  OOM**, HIP) → **unchanged**, even at first use: `_mark_cuda_poisoned` + 503 +
  supervised recycle. The shared CUDA context is corrupt; a "successful" CPU
  retry would mask a sidecar about to crash in-flight synth.

### 3. Config — `engine-vram-cost.ts` + `registry.ts` + `.env.example`

**Already exists (srv-36) — do NOT re-add (F1):** the device knob is
`qa.speaker.device` (group `qa-gates`, `apply: restart-sidecar`, `env:
SPK_DEVICE`, default `cpu`), and `server/.env.example:510` already carries
`SPK_DEVICE=cpu`. srv-47 only flips that knob's help text — it currently reads
_"cuda is Phase 2,"_ which srv-47 ships (F3).

**srv-47 adds:**
- `engine-vram-cost.ts`: add `spk: 1` to `ENGINE_VRAM_COST`; add the
  `case 'spk': return configValue('gpu.weight.spk')` arm to `costForEngine`.
  (Note: an unregistered key already falls back to cost 1 via the `default`
  arm — the explicit case is what makes it **live-tunable**.)
- `registry.ts`: `gpu.weight.spk` (integer, default `1`, **`apply: 'live'`**,
  group `gpu-lifecycle` — a Node-side knob read per-op by `costForEngine`,
  never sent to the sidecar; mirrors `gpu.weight.asr`) and `sidecar.spkIdleTtl`
  (integer, default `120`, **`apply: 'restart-sidecar'`**, **`env:
  'SPK_IDLE_TTL'`**, group `gpu-lifecycle`; mirrors `sidecar.asrIdleTtl`).
- `.env.example`: add `SPK_IDLE_TTL=120` + a `GPU_WEIGHT_SPK` doc line beside
  the existing `ASR_IDLE_TTL`/`GPU_WEIGHT_ASR` block. (`SPK_DEVICE` is already
  there.)

**Propagation is automatic — no `spawn-sidecar.ts` edit (F2).** `buildSidecarEnv`
(`spawn-sidecar.ts:454-471`) iterates all knobs and injects any
`apply:'restart-sidecar'` knob with an `env` field **whose value is non-default**
into the Python child env. So registering `sidecar.spkIdleTtl` correctly is
sufficient. **Critical corollary:** because only *non-default* values inject, the
sidecar's own `_spk_idle_ttl()` default MUST equal the registry default (120 =
120), or a default-config sidecar silently uses a different TTL than the UI shows.

Weight `1` rationale: the semaphore is integer-weighted (cost clamps to ≥1), so
1 is the floor; ECAPA-TDNN (~80–200 MB) is far smaller than a synth model, but
charging it 1 token keeps it inside the budget alongside synth and matches ASR.
Live-tunable via `gpu.weight.spk` if the on-box measurement shows it should
co-reside more freely.

## Known limitation (documented, not fixed in v1)

The Node gate reads the **`SPK_DEVICE` env**, not live sidecar state. After a
runtime CPU-demote (§2c), the Node side keeps acquiring a `spk` token
needlessly — a minor serialisation, not a correctness bug. This is the same
env-coupling ASR already lives with. `/health` already exposes the live
`spk_device`, so a future enhancement could poll it to close the gap; out of
scope here.

## Concurrency note (why this is safe on the 8 GB box)

The embed runs in the **generation/repair** phase (inline, piggybacking the
ASR-QA pass on in-memory PCM) — the same phase as Whisper ASR, **never** the
cast-review phase where Qwen VoiceDesign is resident. Verified against all three
call sites: `synthesise-chapter.ts:362` (inline synth), `chapter-qa-repair.ts`
(repair), and `audition-centroid.ts` — the last reached via `aggregate.ts:127`
in the **scoreBook** path, which srv-36 wired to the per-chapter-done generation
hook (VoiceDesign is already freed by the first real `/synthesize`). So `spk`
co-resides only with synth (Qwen Base / Kokoro) and possibly ASR, all of which
the weighted semaphore arbitrates within `gpu.vramBudget`. It does **not** stack
on top of the Qwen VoiceDesign 1.7B model (that was the plan-108 OOM trap).

_Residual caveat:_ this holds only while no future caller invokes
`scoreBook`/`aggregate` during cast-review. If one is ever added, re-check this
co-residence assumption (spk + VoiceDesign on an 8 GB card would need its own
arbitration).

## Tests

**pytest** (`server/tts-sidecar/tests/test_embed.py` — new, or extend; stub
`speechbrain…EncoderClassifier` + `torch.cuda.is_available` like
`test_transcribe.py`):
- load-time degrade: `SPK_DEVICE=cuda` + `is_available()==False` → loads on cpu,
  warns, `SPK.device == "cpu"`.
- first-use non-poison degrade: a non-poison exception at `ensure_loaded()` /
  first `embed()` → sticky-demotes to cpu, reloads, retries, returns a vector;
  `SPK.device == "cpu"` after, and a subsequent embed does NOT re-attempt cuda.
- poison error: a `_CUDA_POISON_RE`-matching exception (incl. OOM) → poisons
  (503/poisoned), **no** demote, **no** CPU retry — even at first use.
- watchdog: `maybe_free_idle` frees after TTL on the cuda path; **no-ops on
  cpu**; never throws on a transient tick; the simple recency check (no
  in-flight counter) is asserted.

**vitest** (`server/src/tts/embed-client.test.ts` — new, mirror
`transcribe-client.test.ts`):
- token acquired **only** when `SPK_DEVICE=cuda`; **none** on cpu.
- `release` called in `finally` on both success **and** a thrown error.
- cost passed == `costForEngine('spk')`.
- plus an `engine-vram-cost` case asserting `spk` resolves to `gpu.weight.spk`.

## Definition of Done

1. Four components above implemented; both test tiers green.
2. `npm run verify` green on the integrated tree.
3. PR off `feat/sidecar-srv-47-spk-cuda` with `Closes #992`; remove the srv-47
   row from `docs/BACKLOG.md`; stamp this spec's Ship notes + flip `status:
   stable`, keeping the spec in-place under `docs/superpowers/specs/` (match
   srv-36, which used no archive subdir).
4. **Operator-owed acceptance (does NOT block the PR merge — mirrors how
   srv-43/fs-45 ship):** on the GPU box, with `SEG_SPK_ENABLED=1
   SPK_DEVICE=cuda`, record CPU-vs-cuda ms/segment and confirm no synth
   throughput regression from contention (reboot first per the perf-baseline
   practice). Note the numbers on the PR. If cuda shows no real win at current
   scale, that's an expected outcome for a Could-tier substrate item — the
   value is the safe switch + the substrate fs-55 reuses, not a guaranteed
   speedup today.

## Ship notes

_(filled at ship time)_
