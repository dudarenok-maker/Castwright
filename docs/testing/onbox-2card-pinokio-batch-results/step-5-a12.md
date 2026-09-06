# Step 5 — A12 bullets 1, 3, 4: device-pin respawn survival

Castwright#2968. On-box confirmation of register row A12 —
`docs/testing/onbox-acceptance-register.md:1596-1620` (PR #1870, closes
#1857) — "Device-pin resolution survives a respawn." Bullet 2 (enumeration
order changing between boots) is explicitly out of scope for this step: it
needs a real reboot of this shared box, which is unsafe with the other
active lanes' processes currently on it, and was **not attempted**.

## Hardware / setup

- 2-card boot confirmed live via `/api/sidecar/health`: `cuda:0` — RTX 4070
  Laptop, 8585.216 MiB total; `cuda:1` — RTX 5070 Ti, 17094.475776 MiB
  total (same cards step 1/2/3/4 of this chain used).
- Worktree `C:\Claude\Projects\wt-2card-pinokio-batch`, branch
  `docs/docs-2card-pinokio-batch`, this worktree's own server (`PORT=8230`)
  and sidecar (`LOCAL_TTS_PORT=9150`), started via `npm run dev` inside
  `server/`.
- Driven directly against the real `GET/PUT /api/config`,
  `POST /api/sidecar/restart`, and `POST /api/sidecar/load` routes — the
  same primitives the Advanced Settings UI and the Load/Stop pill use — so
  every bullet below exercises the shipped code path end-to-end, including
  the `cuda:N` → `cuda-uuid:<uuid>` persistence translation `PUT /api/config`
  performs before writing `tts.qwen.device` / `tts.qwen.codecDevice` to disk
  (`server/src/routes/gpu-uuid.ts`, `server/src/routes/config.ts`).

## Bullet 1 — Qwen model device pin survives two respawns

1. `PUT /api/config {"tts.qwen.device":"cuda:1"}` → `200`, `effective:
   "cuda:1"`, `source: "override"`.
2. `POST /api/sidecar/restart` → `{"ok":true}`; `POST /api/sidecar/load
   {"engine":"qwen"}` → `{"status":"ready"}`.
3. `GET /api/sidecar/health` → **`qwenDeviceKey: "cuda:1"`** — landed on the
   pinned card on the first post-pin spawn.
4. Repeated step 2-3 with a **second** `POST /api/sidecar/restart` (a fresh
   child process, fresh CUDA re-enumeration) → `POST /api/sidecar/load` →
   `GET /api/sidecar/health` again reports **`qwenDeviceKey: "cuda:1"`**.

Confirms the pin is re-resolved and lands on the same card on both
respawns, not just the first one — the respawn-survival behaviour row A12
bullet 1 asks for.

## Bullet 3 — Qwen codec device pin is actually honoured, not silently dropped to CPU

Baseline (codec at its registry default, `cpu`) with the model pinned to
`cuda:1` from bullet 1: `vramReservedMbByDevice` = `{"cuda:0": {reserved_mb:
0}, "cuda:1": {reserved_mb: 1845.49376}}` — all Qwen VRAM on the model's
card, nothing on `cuda:0`.

1. `PUT /api/config {"tts.qwen.codecDevice":"cuda:0"}` → `200`, `effective:
   "cuda:0"`, `source: "override"` — pinned to the card the model is **not**
   on, so any VRAM landing there is unambiguously the codec, not the model.
2. `POST /api/sidecar/restart` → `POST /api/sidecar/load {"engine":"qwen"}`
   → `{"status":"ready"}`.
3. `GET /api/sidecar/health`: `qwenDeviceKey: "cuda:1"` (model unchanged) and
   **`vramReservedMbByDevice.cuda:0.reserved_mb: 364.904448`** (up from `0`)
   while `cuda:1` stayed at `1845.49376`, identical to the pre-codec-pin
   baseline.

This is the outcome #1870 fixed and A12 bullet 3 asks to confirm: before
that fix, `_codec_device_pref()` read `QWEN_CODEC_DEVICE` as a bare
`os.environ.get`, so the persisted `cuda-uuid:<uuid>` literal reached
`_validate_cuda_index` unparsed, failed inside `.to()`, and the codec
silently rolled back to CPU (`cuda:0` would have stayed at `0`). Here it
shows a real, non-zero VRAM footprint on the pinned card and does not, so
the pin took effect.

## Bullet 4 — Codec pin at an absent card leaves the codec on CPU, not the model's card

1. `PUT /api/config {"tts.qwen.codecDevice":"cuda:5"}` → `200`, `effective:
   "cuda:5"` (index-range validation for this knob happens at sidecar
   resolve time, not at config-write time — the write itself succeeds).
2. `POST /api/sidecar/restart` → `POST /api/sidecar/load {"engine":"qwen"}`
   → `{"status":"ready"}`.
3. `GET /api/sidecar/health`: `qwenDeviceKey: "cuda:1"` (model unaffected)
   and `vramReservedMbByDevice` = `{"cuda:0": {reserved_mb: 0}, "cuda:1":
   {reserved_mb: 1845.49376}}` — **`cuda:0` dropped back to the pre-codec-pin
   baseline of `0`, and `cuda:1` (the model's own card) did not gain the
   ~365 MiB the codec occupied in bullet 3 either.**

This is exactly the distinction `_codec_device_pref()`'s docstring
(`server/tts-sidecar/main.py:804-837`) calls out: an unresolvable
`cuda-uuid:` pin degrades this knob straight to `"cpu"`, deliberately NOT
through `_resolve_device_env`'s `"auto"` fallback (which the three model
knobs use) — because `"auto"` here means "follow the model," and silently
parking an orphaned codec pin onto the model's card would add VRAM pressure
to exactly the card a user pinning the codec elsewhere was trying to
protect. The observed VRAM split (`0` on `cuda:0`, unchanged on `cuda:1`)
is the CPU-fallback outcome, not the auto/follow-the-model outcome — the
codec was not resident on either GPU. The corresponding log line
(`"QWEN_CODEC_DEVICE=%s did not match any visible GPU -- leaving the codec
on cpu."`, `main.py:832-835`) is the code path this run took; this run's own
`npm run dev` log capture had a stdout-buffering gap on the sidecar child's
Python logger output (a `Start-Process`/pipe artifact of how this worktree's
server was launched for this session, unrelated to the feature under test)
so the literal line was not captured verbatim this run, but the VRAM
behaviour it documents was reproduced directly against the real code path.

## Not attempted

A12 bullet 2 (reboot-gated enumeration-order change) — left for the fold
step (#2954) to record as a remainder, per this issue's own scope note.
