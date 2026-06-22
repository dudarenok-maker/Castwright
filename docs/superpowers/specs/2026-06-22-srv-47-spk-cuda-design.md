---
status: draft
date: 2026-06-22
topic: srv-47 — optional CUDA path for the render-integrity ECAPA embed
issue: srv-47 (#992)
depends_on: srv-36 (#665 — shipped the SpeakerEngine + /embed + embed-client this hardens) · srv-31 (the ASR cuda pattern this mirrors: semaphore gate + idle watchdog)
relates_to: fs-55 (#993 — variant-fidelity gate; reuses the GPU substrate this lays) · fs-45 (#861 — VRAM telemetry; the gpuSemaphore budget this charges against)
moscow: Could (scale optimisation — CPU embed ~60–65 ms/segment is comfortably fast today on the 8 GB box)
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

### 2. Sidecar — `SpeakerEngine`: load-time degrade + idle evict + runtime demote

**(a) Load-time graceful degrade.** In `ensure_loaded()`, if `self.device ==
"cuda"` and `not torch.cuda.is_available()` → set `self.device = "cpu"` and log
a warning, then load on CPU. A misconfigured env degrades instead of crashing.

**(b) Idle-evict watchdog** (mirror `_asr_idle_watchdog`):
- Add `self._last_used: float` (stamped at the end of each `embed()`), an
  `unload()` (drop model, `gc.collect()`, `torch.cuda.empty_cache()`), and
  `maybe_free_idle(ttl)`.
- **`maybe_free_idle` is a no-op when `self.device == "cpu"`** — there is no
  VRAM to reclaim and reloading ECAPA costs ~1 s; only the cuda path evicts.
- A dedicated `_spk_idle_watchdog()` async loop + `startup`/`shutdown` hooks,
  structured identically to the ASR watchdog (same defensive `try/except`, same
  `interval` formula). TTL via `SPK_IDLE_TTL` (default `120`, 5 s floor) using
  the same resolver shape as `_asr_idle_ttl()`.

**(c) Runtime CPU demote — non-poison errors ONLY.** In `embed()` (or its
`/embed` exception handler), on an exception:
- If `_CUDA_POISON_RE.search(err)` matches (device-side assert, cublas, **CUDA
  OOM**, HIP) → **unchanged**: `_mark_cuda_poisoned` + 503 + supervised recycle.
  The shared CUDA context is corrupt; a "successful" CPU retry would mask a
  sidecar about to crash in-flight synth.
- Else (a non-CUDA-context error: load hiccup, transient `RuntimeError`) →
  sticky-demote `self.device = "cpu"`, reload on CPU, retry the embed **once**,
  return the result. Log the demotion.

### 3. Config — `engine-vram-cost.ts` + `registry.ts` + `.env.example`

- `engine-vram-cost.ts`: add `spk: 1` to `ENGINE_VRAM_COST`; add the
  `case 'spk': return configValue('gpu.weight.spk')` arm to `costForEngine`.
- `registry.ts`: `gpu.weight.spk` (integer, default `1`, live-tunable,
  group `gpu-lifecycle`) and `sidecar.spkIdleTtl` (integer, default `120`,
  restart-sidecar apply, group `gpu-lifecycle`).
- `.env.example`: document `SPK_DEVICE` (default `cpu`) and `SPK_IDLE_TTL`
  (default `120`) alongside the existing `ASR_DEVICE`/`ASR_IDLE_TTL` block —
  both default to the cpu path.

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
cast-review phase where Qwen VoiceDesign is resident. So `spk` co-resides only
with synth (Qwen Base / Kokoro) and possibly ASR, all of which the weighted
semaphore arbitrates within `gpu.vramBudget`. It does **not** stack on top of
the Qwen VoiceDesign 1.7B model (that was the plan-108 OOM trap).

## Tests

**pytest** (`server/tts-sidecar/tests/test_embed.py` — new, or extend; stub
`speechbrain…EncoderClassifier` + `torch.cuda.is_available` like
`test_transcribe.py`):
- load-time degrade: `SPK_DEVICE=cuda` + `is_available()==False` → loads on cpu,
  warns, `SPK.device == "cpu"`.
- runtime non-poison demote: a non-poison exception on first `embed()` →
  demotes to cpu, retries, returns a vector; `SPK.device == "cpu"` after.
- poison error: a `_CUDA_POISON_RE`-matching exception → poisons (503/poisoned),
  **no** demote, **no** CPU retry.
- watchdog: `maybe_free_idle` frees after TTL on the cuda path; **no-ops on
  cpu**; never throws on a transient tick.

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
