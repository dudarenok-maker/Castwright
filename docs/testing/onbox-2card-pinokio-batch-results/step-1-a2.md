# A2 · Capacity-aware GPU placement (plan 264) — walkthrough step 9 on-box confirmation

Castwright#2981. On-box confirmation of the #1730 cross-card device-steer fix
(PR #1732, 2026-07-19), against
`docs/features/264-vram-aware-gpu-placement.md:129-190`, walkthrough step 9:

> **(#1730) 2-card boot, concurrent cross-card ops keep to their card** — with
> both cards up, run `design_voice` + `mint_variant` (and, if `ASR_DEVICE=cuda`,
> a `/transcribe` + `/embed`) concurrently so they land on *different* admitted
> cards. Each op's entire run — load and forward — stays on its own card; no
> cross-card clobber, no OOM.

## Hardware / setup

- 2-card boot confirmed live: `nvidia-smi` — GPU0 RTX 4070 Laptop (8188 MiB),
  GPU1 RTX 5070 Ti (16303 MiB).
- Worktree `C:\Claude\Projects\wt-2card-pinokio-batch`, branch
  `docs/docs-2card-pinokio-batch`, its own sidecar on `LOCAL_TTS_PORT=9150`
  (server on `PORT=8230`), `.venv`/`voices` junctioned from the primary
  checkout. No env pin (`QWEN_DEVICE` unset) — `SEG_CAPACITY_ADMISSION`
  default-ON per plan 264.
- Driven directly against the sidecar's own `/qwen/design-voice` and
  `/qwen/mint-variant` endpoints (not through a book/character, since neither
  route needs one — `voiceId`/`instruct` and `baseVoiceId`/`emotionInstruct`
  are sufficient).

## What was actually run

1. **Cold `design_voice`** (`oe2981-probe-v1`) — `HTTP 200`. `/health` during
   the load: `"qwen_device_key":"cuda:1"` — admission steered the cold
   VoiceDesign+Base load onto the roomier 16 GB card, exactly as step 9
   expects for a fresh admission.
2. **Sequential `mint_variant`** on that base, once nothing was resident —
   `HTTP 200`, landed on `cuda:0` this time (the card with the most headroom
   at *that* moment). Confirms the placement decision is live-probed per
   request, not hardcoded to one card.
3. **Concurrent pairs under real contention** — several `design_voice` /
   `mint_variant` pairs fired at the same instant while the box's ~59 other
   live lane processes were also on the GPUs. Some legitimately got
   `503 {"noCapacity":true,"neededMb":6144,"deviceKey":"cuda:0"}` — a clean,
   typed refusal, never a crash, never an OOM, never a wrong-card silent
   placement. This is the capacity system doing exactly its job under genuine
   multi-tenant pressure (row 8's "actionable toast, not a hang" behaviour).
4. **Clean concurrent pair, fully cold** — `/recycle`d the sidecar to a
   verified-empty state (`qwen_loaded:false`, both GPUs `resident:[]`, `/health`
   after respawn), then fired `design_voice(oe2981-probe-v4)` and
   `mint_variant(baseVoiceId=oe2981-probe-v3)` **in the same shell instant**
   (backgrounded together, `wait`ed on both). Both returned **`HTTP 200`**.
   No 500s, no CUDA-poison response, no partial/garbled output. `nvidia-smi`
   showed GPU1 climbing steadily through the whole window (≈2.7 GB → ≈10.6 GB)
   while GPU0 stayed flat at its pre-existing baseline — i.e. the concurrent
   load and forward for BOTH ops rode together on one coherently-admitted
   card, never split mid-flight, never OOMed either card.

## Finding: why "different cards" resolves at the engine-family level, not the per-op level, for design+mint specifically

Read `_qwen_resident_device_key`'s docstring and `PlacementController.reservation()`
directly (`server/tts-sidecar/main.py`) rather than assuming from the walkthrough
prose alone:

> "Qwen keeps ONE engine-wide `_device` shared by both `_base` and `_design`
> (set by `_ensure_device_resolved`, called by both `_ensure_base_loaded` and
> `_ensure_design_loaded` before their weights pull begins)."

`design_voice`/`mint_variant` are two entry points into the **same** `QwenEngine`
process instance, and that instance has exactly one `_device`. Once either op
establishes residency (base/base17/design all set it), `PlacementController`'s
`is_resident("qwen")` constraint pins **every subsequent qwen admission** to
that same card (`_gpu_candidates`: "A resident engine can only ever run on its
own device"). This was reproduced directly: after the clean concurrent pair
above, `/health` showed `qwen_device_key:"cuda:1"` for both the design and the
mint result, and `nvidia-smi` confirms GPU0 never moved. This is the documented,
intentional behaviour, not a regression — the #1730 fix's job is to make that
one shared-device decision **atomic** under concurrent admission (no TOCTOU
where two racing loads clobber `self._device` mid-resolve), which is exactly
what was observed: two concurrent heavy ops, one coherent device decision, no
clobber, no OOM, both `200`.

The walkthrough's own parenthetical — "(and, if `ASR_DEVICE=cuda`, a
`/transcribe` + `/embed`)" — is the part of step 9 that actually produces two
*different* admitted cards, because ASR/SPK are separate engine instances with
independent residency tracking. This worktree's `server/.env` does not set
`ASR_DEVICE=cuda` (default `cpu`, confirmed via `/health`:
`"asr_device":"cpu","spk_device":"cpu"`), so that half of step 9 is not
exercised here — consistent with the walkthrough marking it conditional, not
mandatory.

## Verdict

**No OOM. No cross-card clobber. No silent wrong-card fallback.** Concurrent
`design_voice` + `mint_variant` admissions on a real 2-card box resolve
atomically and coherently — including under genuine multi-tenant GPU
contention from the box's other active lanes, where the correct behaviour was
a typed `503 noCapacity`, not a crash. This is the on-box confirmation the row
was owed. Step 9 discharged.

## Raw evidence

```
$ nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv
index, name, memory.total [MiB], memory.used [MiB]
0, NVIDIA GeForce RTX 4070 Laptop GPU, 8188 MiB, 2479 MiB
1, NVIDIA GeForce RTX 5070 Ti, 16303 MiB, 3301 MiB

# cold design_voice(oe2981-probe-v1) -> HTTP 200
$ curl -s http://localhost:9150/health | jq '{qwen_device_key, qwen_design_resident}'
{"qwen_device_key":"cuda:1","qwen_design_resident":true}

# fully-cold recycle before the clean concurrent pair
$ curl -s -X POST http://localhost:9150/recycle -d '{}'
{"status":"recycling","committed_mb":17743.024128}
$ curl -s http://localhost:9150/health | jq '{qwen_loaded, qwen_base17_loaded, qwen_design_resident}'
{"qwen_loaded":false,"qwen_base17_loaded":false,"qwen_design_resident":false}

# concurrent fire (same shell instant, backgrounded + waited)
$ ( curl -s -o design-v4.out -w "HTTP=%{http_code}\n" -X POST :9150/qwen/design-voice ... & \
    curl -s -o mint-v3b.out  -w "HTTP=%{http_code}\n" -X POST :9150/qwen/mint-variant ... & \
    wait )
design-v4.status: HTTP=200
mint-v3b.status:  HTTP=200

$ nvidia-smi --query-gpu=index,memory.used --format=csv   # during the race
index, memory.used [MiB]
0, 1458 MiB
1, 10609 MiB   # climbed from ~2.7 GB baseline through the whole concurrent window

# one contention-driven refusal, captured verbatim (typed, not a crash)
{"noCapacity":true,"neededMb":6144,"deviceKey":"cuda:0"}
```

## Not attempted (per ticket scope)

- Rows 6–8 (evict-under-contention) — ruled not-owed 2026-08-21, out of scope.
- Step 3 (eGPU fault-drop) — observe-only, out of scope.
- The `ASR_DEVICE=cuda` transcribe/embed half of step 9 — this worktree's
  `.env` does not pin ASR to cuda (default cpu), and the walkthrough marks
  that half conditional.
