---
status: active
shipped: null
owner: null
---

# 144 — Sidecar CUDA-fragmentation OOM guard (`expandable_segments`)

> Status: active — fix landed; live confirmation (long run without a mid-run CUDA OOM) pending.
> Key files: `server/tts-sidecar/main.py` (via the spawn env), `server/src/tts/spawn-sidecar.ts`
> URL surface: indirect (sidecar process env)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** a long Qwen run stops crashing mid-book with `CUDA error: out of memory` — fewer failed chapters, fewer self-heal interruptions.
- **Technical:** PyTorch's CUDA allocator stops fragmenting fixed `cudaMalloc` blocks; variable-length batch tensors reuse freed VRAM via CUDA VMM segments.
- **Architectural:** distinct from the host-RAM leak (plan 143) — this is GPU VRAM, addressed independently.

## The incident (2026-05-30)

~40 min into a clean default-ceiling run (host RAM healthy, 61% free, sidecar 19 GB), a **32-item Qwen batch 500'd with `CUDA error: out of memory`** on the 8 GB GPU — even though total VRAM use had been modest (~2–8 GB) all run. Chapters 15–19 had rendered fine; the OOM appeared only after the sidecar had been up a while. Signature of **CUDA allocator fragmentation**: variable sentence/batch lengths churn the allocator into many fixed blocks until a wide batch can't find a contiguous one. (This is NOT the host-memory leak — that's plan 143; host RAM was fine here.)

**It auto-recovered:** the sidecar detected CUDA poison → self-exited (code 42) → the srv-15 supervisor respawned a fresh process (clean VRAM) → generation resumed. So the run self-healed, but two in-flight chapters were marked `failed` and the user saw a crash. The host-RSS recycle (plan 143, ~37 GB / ~90 min) doesn't prevent this — the VRAM OOM hits earlier, at low host RAM.

## The fix

Default **`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`** (PyTorch ≥2.1) into the sidecar's spawn environment (`spawn-sidecar.ts`, after `...process.env` so an explicit override wins — e.g. `expandable_segments:True,max_split_size_mb:256`). Set via env, not `torch.backends`, because it must be in place **before** torch initialises the CUDA context — a spawn-env default is guaranteed pre-import. CUDA VMM grows/shrinks virtual segments instead of allocating fixed blocks, so fragmented free space stays reusable and a wide batch won't spuriously OOM.

This is the research report's recommendation #4 for exactly this symptom. If a CUDA OOM still recurs with it on, the fallbacks are a tighter VRAM envelope — lower `QWEN_BATCH_TOKEN_BUDGET` (3600 → 2400, ~3.9 GB peak vs ~5.6 GB) or `QWEN_BATCH_SIZE` (32 → 16) — traded against throughput; not changed here since the default config is otherwise performing well (ch19 RTF 0.90).

## Architectural impact

- **New seam:** `PYTORCH_CUDA_ALLOC_CONF` defaulted in the spawn env; overridable from the parent env.
- **Invariants preserved:** the rest of the spawn env (PRELOAD_*, QWEN_VOICES_DIR) and the spawn/probe/stale-replace flow unchanged. Independent of plan 143's host-RSS recycle and the srv-15 poison-respawn (which remains the safety net if a CUDA OOM still slips through).
- **Reversibility:** set `PYTORCH_CUDA_ALLOC_CONF` to anything else (or empty) in the parent env to override.

## Invariants to preserve

- The flag is defaulted AFTER `...process.env`, so an explicit parent-env value wins.
- It must reach the child as an env var (pre-torch-import), never as a post-import `torch.backends` call.

## Test plan

Automated (`npm run test:server`, `spawn-sidecar.test.ts`):

- The kokoro-default spawn env includes `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.
- An explicit `process.env.PYTORCH_CUDA_ALLOC_CONF` override is passed through unchanged.

Manual acceptance (pending): run a full Qwen book; confirm no mid-run `CUDA error: out of memory` (the 32-item-batch crash) over a multi-hour render that previously OOM'd.

## Ship notes

_Pending._ Branch `fix/sidecar-cuda-frag-oom` (off main, post-#353). Fill shipped date + SHA on merge; flip → `stable` after a long run completes without a CUDA OOM. Related: plan 143 (host-RAM recycle), `side-11` (eliminate the host leak). Research input: the user-supplied Qwen-leak report (#4 — `expandable_segments` for allocator fragmentation).
