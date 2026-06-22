---
status: stable
date: 2026-06-22
topic: srv-47 — optional CUDA path for the render-integrity ECAPA embed
issue: srv-47 (#992)
depends_on: srv-36 (#665 — shipped the SpeakerEngine + /embed + embed-client this hardens) · srv-31 (the ASR cuda pattern this mirrors: semaphore gate + idle watchdog)
relates_to: fs-55 (#993 — variant-fidelity gate; reuses the GPU substrate this lays) · fs-45 (#861 — VRAM telemetry; the gpuSemaphore budget this charges against)
moscow: Could (scale optimisation — CPU embed ~60–65 ms/segment is comfortably fast today on the 8 GB box)
revised: 2026-06-22 R1 (adversarial, code-grounded vs origin/main). Corrected: SPK_DEVICE is ALREADY a registry knob `qa.speaker.device` + already in .env.example (don't re-add); sidecar env propagation is GENERIC (spawn-sidecar.ts Layer-2 loop auto-injects any non-default restart-sidecar knob — no manual wiring); watchdog mirrors ASR's SIMPLE maybe_free_idle (mid-inference free is benign under refcounting — no Qwen-style in-flight counter); help-text flip for `qa.speaker.device` ("cuda is Phase 2" → shipped).
revised: 2026-06-22 R2 (deeper adversarial). R2-A (serious, corrects an R1 error): GPU budget DEFAULT is 1, not 4 (gpu.vramBudget=0→gpu.concurrency=1), so cuda embed serialises against synth at default budget and is likely SLOWER than the free parallel cpu embed — only worth it at GPU_VRAM_BUDGET≥2; added a one-time WARN guard + budget≥2 prerequisite + measurement-under-set-budget. R2-B (correctness): /embed's poison fence does NOT cover model load (ensure_loaded is outside the try) — a cuda load poison would escape unclassified; move ensure_loaded inside the fence. R2-C (simplification): all device handling collapses into ensure_loaded() (load-time degrade/demote); the R1 "first-embed synchronous reload under _infer_lock" path (F8) is dropped. R2-D: re-verified the embed IS gated by qa.speaker.enabled (claim holds).
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

### Prerequisite: `SPK_DEVICE=cuda` is only worth it with `GPU_VRAM_BUDGET ≥ 2` (R2-A)

The honest perf reality, surfaced by the adversarial round: the **CPU** embed
costs **zero** VRAM tokens, so it runs **concurrently** with synth. The **cuda**
embed costs `spk: 1`. At the **default budget of 1** (`GPU_VRAM_BUDGET` unset →
`gpu.concurrency` = 1), one `spk` token consumes the whole budget, so the cuda
embed **serialises behind every synth/analyzer op** — almost certainly *slower*
end-to-end than the free, parallel CPU embed. The cuda path only helps when the
operator has set `GPU_VRAM_BUDGET ≥ 2` so `spk` can co-reside with one synth
(`1 + 1 ≤ budget`). srv-47 therefore ships a **one-time WARN** (R2-A guard, see
component 1) when `SPK_DEVICE=cuda` and the effective budget < 2, and the
operator-owed measurement (DoD §4) must run under a set budget. This is the
core reason srv-47 is a measure-first **Could**, not a default flip.

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
- **`/embed` endpoint (`main.py:3497`)** — honours the CUDA-poison +
  recycle-drain fences for the **embed call** (returns 503 + `poisoned:true`
  and schedules the supervised exit when `_CUDA_POISON_RE` matches), **but
  `await SPK.ensure_loaded()` sits OUTSIDE that `try`** — so a cuda *load*
  poison is currently unfenced (harmless on cpu; the R2-B gap srv-47 fixes).
- **`embed-client.ts` (`server/src/tts/embed-client.ts`)** — a **bare `fetch`**
  with **no VRAM arbitration**. This is the safety gap vs. `transcribe-client.ts`.
- **`transcribe-client.ts`** — the pattern to mirror: an `asrRunsOnGpu()` gate
  (reads `ASR_DEVICE` env, in lockstep with the sidecar under `npm start`)
  acquires `gpuSemaphore.acquire(costForEngine('asr'))` **only on cuda**, with a
  guaranteed `release?.()` in `finally`; uses an `undici` `Agent` dispatcher
  (headers/body timeout 0, connect 10 s); tags unreachable/5xx as `transient`.
- **VRAM semaphore (`server/src/gpu/semaphore.ts`)** — FIFO weighted token
  pool; `acquire(cost)` → release fn. **Budget default is `1`, NOT 4 (R2-A):**
  `gpu.vramBudget` defaults to `0` → fall back to `gpu.concurrency`, which
  defaults to `1` (`registry.ts:447,457`). The "4" is only a *suggested* value
  the operator must set explicitly via `GPU_VRAM_BUDGET`. **`engine-vram-cost.ts`**
  maps engine → weight (`asr: 1`) and `costForEngine()` reads `gpu.weight.*`
  live from the registry.
- **Idle watchdog precedent** — `_asr_idle_watchdog()` / Qwen's
  `_qwen_design_idle_watchdog()` in `main.py`: an async loop
  (`interval = min(30, max(5, ttl/4))`) that calls `maybe_free_idle(ttl)` on a
  worker thread, started/stopped via `@app.on_event("startup"|"shutdown")`, and
  defensively never dies on a transient tick error.
- **Poison classifier (`main.py:179` `_CUDA_POISON_RE`)** — matches liberally
  and **deliberately includes `CUDA out of memory`** (comment: _"we never want
  to MISS a poison — over-classifying is harmless"_). This is load-bearing for
  the fallback design.

## Design — three components (+ tests)

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
- **R2-A budget-misconfig WARN:** on the first cuda-path acquire, if
  `spkRunsOnGpu()` and the effective GPU budget < 2 (`resolveGpuBudget()`),
  emit a one-time WARN — _"SPK_DEVICE=cuda but GPU budget < 2: the speaker
  embed will serialise behind synth and may be slower than the free cpu path;
  set GPU_VRAM_BUDGET ≥ 2."_ One-shot (module-level `let warned = false`), no
  behavior change. The budget is a Node concept, so this lives Node-side, not
  in the sidecar.

### 2. Sidecar — `SpeakerEngine`: load-time degrade/demote + idle evict + load-poison fence

**(a) All device handling lives in `ensure_loaded()` — load-time only (R2-C).**
The realistic broken-but-"available" cuda fails at `from_hparams(device="cuda")`
(the load is the first thing to touch CUDA), not at a later encode — so there is
**no** per-embed try/reload wrapper and **no** synchronous reload under
`_infer_lock` (the round-1 F8 hazard is dropped entirely). `ensure_loaded()`:
1. **Degrade if unavailable:** `self.device == "cuda"` and `not
   torch.cuda.is_available()` → `self.device = "cpu"` + warn, load on CPU.
2. **Try cuda, demote on non-poison failure:** attempt the cuda load; on an
   exception that does **not** match `_CUDA_POISON_RE` → sticky-demote
   `self.device = "cpu"`, reload on CPU, log the demotion. (This is the
   genuinely-CPU-fixable case: cuda present but broken at load — cuDNN/driver
   mismatch.)
3. **Re-raise poison:** an exception matching `_CUDA_POISON_RE` (device-side
   assert, cublas, **CUDA OOM**, HIP) → **re-raise** so the `/embed` fence (b)
   classifies it and triggers the supervised recycle. A CPU retry would mask a
   corrupt shared context that's about to crash in-flight synth.

**(b) `/embed` poison fence must cover the LOAD (R2-B — correctness gap).**
Today `await SPK.ensure_loaded()` sits **outside** the poison-fenced `try` in
the `/embed` handler (`main.py:3497`), so a cuda **load** poison escapes as an
unclassified 500 with **no** recycle — the poisoned context then silently
persists for every later embed. (ASR avoids this because `WhisperEngine`
loads *inside* `transcribe()`, which runs inside the fenced `to_thread`.) Fix:
move `await SPK.ensure_loaded()` **inside** the existing `try` so the same
`except _CUDA_POISON_RE → _mark_cuda_poisoned` path catches a re-raised load
poison from (a.3).

**(c) Idle-evict watchdog** (mirror `_asr_idle_watchdog`):
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
load-time CPU-demote (§2a.2), the Node side keeps acquiring a `spk` token
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
- load degrade (unavailable): `SPK_DEVICE=cuda` + `is_available()==False` →
  loads on cpu, warns, `SPK.device == "cpu"`.
- load demote (non-poison, R2-C): a non-poison exception from the cuda
  `from_hparams` in `ensure_loaded()` → sticky-demotes to cpu, reloads, loads
  successfully; `SPK.device == "cpu"` after.
- load poison fenced (R2-B): a `_CUDA_POISON_RE`-matching exception during the
  cuda load is **re-raised** and the `/embed` handler (with `ensure_loaded`
  moved inside the try) returns 503/poisoned + marks poison — **no** demote.
- watchdog: `maybe_free_idle` frees after TTL on the cuda path; **no-ops on
  cpu**; never throws on a transient tick; the simple recency check (no
  in-flight counter) is asserted.

**vitest** (`server/src/tts/embed-client.test.ts` — new, mirror
`transcribe-client.test.ts`):
- token acquired **only** when `SPK_DEVICE=cuda`; **none** on cpu.
- `release` called in `finally` on both success **and** a thrown error.
- cost passed == `costForEngine('spk')`.
- R2-A WARN: `SPK_DEVICE=cuda` + effective budget < 2 → one-time WARN; budget
  ≥ 2 → silent; the WARN fires at most once across many embeds.
- plus an `engine-vram-cost` case asserting `spk` resolves to `gpu.weight.spk`.

## Definition of Done

1. Three components above implemented; both test tiers green.
2. `npm run verify` green on the integrated tree.
3. PR off `feat/sidecar-srv-47-spk-cuda` with `Closes #992`; remove the srv-47
   row from `docs/BACKLOG.md`; stamp this spec's Ship notes + flip `status:
   stable`, keeping the spec in-place under `docs/superpowers/specs/` (match
   srv-36, which used no archive subdir).
4. **Operator-owed acceptance (does NOT block the PR merge — mirrors how
   srv-43/fs-45 ship):** on the GPU box, with `SEG_SPK_ENABLED=1
   SPK_DEVICE=cuda` **and `GPU_VRAM_BUDGET=4`** (NOT the default 1 — at budget 1
   the cuda embed serialises and the measurement is meaningless, R2-A), record
   CPU-vs-cuda ms/segment **and** end-to-end chapter throughput, confirming no
   synth regression from contention (reboot first per the perf-baseline
   practice). Also sanity-check the default-budget case shows the R2-A WARN.
   Note the numbers on the PR. If cuda shows no real win even at budget 4,
   that's an expected outcome for a Could-tier substrate item — the value is the
   safe switch + the substrate fs-55 reuses, not a guaranteed speedup today.

## Ship notes

**Shipped 2026-06-22** — PR #1003, merge commit `a1f58744`. Built via subagent-driven development (6 tasks + opus whole-branch review, all clean). All three components landed: Node `embed-client.ts` semaphore gate + budget WARN, sidecar `SpeakerEngine` load-time degrade/demote + idle-evict watchdog, and the R2-B `/embed` load-poison-fence fix. `SPK_DEVICE` stays `cpu` by default; `gpu.weight.spk` (default 1) + `sidecar.spkIdleTtl` (default 120) added.

**On-box validation:** full `npm run verify` green including the REAL sidecar pytest (`test:sidecar` ran, not skipped); `test_speaker_embed.py` 12/12. Running the tests on a venv box caught two bugs the no-venv `py_compile` gate + reviews missed — a `from_hparams` shadowing `NameError` in the new stub helper, and two pre-existing srv-36 tests calling `SPK.embed()` without `ensure_loaded()` (failing on `main` too) — both fixed in this PR.

**Owed (non-blocking, DoD §4):** operator CPU-vs-cuda ms/segment + end-to-end throughput measurement with `SEG_SPK_ENABLED=1 SPK_DEVICE=cuda GPU_VRAM_BUDGET=4` (reboot first), confirming the default-budget WARN fires. The functional path is validated; this is the perf-number step. fs-55 reuses the GPU embed substrate this lays.
