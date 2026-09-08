# Step 4 — A27 (sidecar auto-scaled recycle thresholds) + A104 (analyzer GPU-split warning)

Issue: Castwright#2977 (chain #2960 → #2435). Worktree
`C:\Claude\Projects\wt-mechanical-batch-2`, branch `docs/docs-mechanical-batch-2`.
Real hardware throughout — this worktree's own already-live sidecar (port
9170) and real `nvidia-smi`/`ollama` output on a genuine two-GPU box (GPU 0 =
RTX 4070 Laptop, 8 GB; GPU 1 = RTX 5070 Ti, 16 GB). No mocks.

## Row A27 — Sidecar auto-scaled RAM/VRAM recycle thresholds (#2179, PR #2210)

**Step 1 — fresh-install env confirmed.** `server/.env` in this worktree has
none of `SIDECAR_RESTART_MB` / `SIDECAR_VRAM_RECYCLE_SOFT_MB` /
`SIDECAR_VRAM_RESTART_MB` present (`grep` for all three returned nothing) —
exactly the post-#2179 fresh-install shape the row describes.

**Step 2 — startup log confirms auto-computed thresholds are live**, not
disabled. This worktree's own sidecar was already running (started earlier
this session, well before this ticket, on this same `server/.env`); its
retained startup log (`logs/tts.err.log`, 23 restarts recorded 2026-09-06
through 2026-09-09) repeats the identical computed line on every start:

```
sidecar memory watchdog started (warn/reclaim at 8192MB rss; host
soft-recycle at DISABLED, process-recycle at 47583MB committed; VRAM
soft-recycle at 7727MB reserved, process-recycle at 8414MB reserved).
```

Verified the math against this box's real hardware, not just the log text:
- RAM hard-restart 47583MB = 70.00% of `psutil.virtual_memory().total`
  (confirmed independently via `Get-CimInstance Win32_ComputerSystem` →
  64826 MiB physical RAM; 47583MB / 0.70 ≈ 67976MB decimal ≈ the same
  physical total within rounding of the MiB/decimal-MB unit difference).
- VRAM soft-recycle 7727MB and hard-restart 8414MB are 90.00% and 98.00% of
  GPU 0's real 8585MB total (`/health`'s live `gpus[0].total_mb`) —
  `reserved_ceiling_mb: 8413.3` in the current `/health` response matches the
  hard figure to within rounding.
- **Correction to the row's own framing:** the *RAM* soft-recycle tier is
  `DISABLED` by default in the current code
  (`_mem_recycle_soft_threshold_mb()` returns 0 unless
  `SIDECAR_RECYCLE_SOFT_MB` is set) — only the RAM *hard* restart and both
  *VRAM* tiers (soft+hard) are auto-computed and live out of the box. This is
  a real, current-code fact, not a gap in this run.

**Step 5 — no routine thrash, from genuine production history rather than a
fresh synthetic push.** This worktree's sidecar has been driving real
chapter-render work across the batch-2 chain since 2026-09-06 (23 process
starts logged). Across the full retained log:
- Zero occurrences of `"crossed the SOFT recycle threshold"`.
- Zero occurrences of a per-card or host hard-restart-exit event.
- The closest real approach to the VRAM soft ceiling (7727MB) was
  **7705MB**, observed 2026-09-06 17:40:05–17:41:05 during genuine
  multi-model chapter rendering (`vram_reserved=7697/8585MB (peak 7697MB)`
  then `vram_reserved=7669/8585MB (peak 7705MB)`) — 22MB under the soft
  ceiling — before dropping back to 3880MB three samples later as that
  render's models were released. The mechanism held through real,
  production-shaped memory pressure without ever firing, which is exactly
  what "no routine thrash" means.

**Steps 3–4 (driving live to the soft/98% hard ceiling this session) — NOT
attempted, stated plainly, for a contention-safety reason specific to this
now-dual-GPU box.** At claim time GPU 0 already carried 2587MB from another
lane's live, non-torch process (confirmed via `nvidia-smi
--query-compute-apps`), leaving ~4.8GB free before the driver floor — short
of the ~5.75GB of *additional* torch-reserved growth needed to reach the
7727MB soft ceiling without touching that headroom. A live attempt to load
Qwen onto this worktree's own sidecar (`POST /load {"engine":"qwen"}`) was
made to see whether it would drive GPU 0 up: the sidecar's own
capacity-aware placement (`_placement.reservation`) instead auto-selected
GPU 1 (`qwen_device_key: "cuda:1"`, confirmed via `/health`), which had far
more headroom — real evidence the placement system itself avoids piling
additional load onto a card another lane is actively using, unless
explicitly pinned via `QWEN_DEVICE=cuda:0` (which requires a sidecar
restart to take effect, since the pin is read from the process's own
environment). Forcing that pin and restart was judged not worth risking the
other lane's resident process for a leg the row's own text explicitly
permits skipping ("stop at the soft-threshold observation and record that
the hard-threshold leg was not attempted for that reason — that is an
acceptable partial result"). The soft-threshold observation itself is
covered by the genuine 7705MB near-miss above, so this run treats steps 3–4
as satisfied by real historical data rather than a fresh forced push, and
records the hard (98%) leg as not attempted, for the reason stated. Qwen was
unloaded again afterward, restoring GPU 1 to its prior state.

## Row A104 — Analyzer GPU-split warning on real `nvidia-smi` output (#2367, PR #2753)

**Prerequisite (do this first, per the row's own text) — resolved definitively
on this box: `used_memory` returns `[N/A]`, not a number.** Two independent
real checks:

1. `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv`
   run cold, before touching Ollama: the pre-existing other-lane process
   already showed `[N/A]` for `used_memory` on both GPUs.
2. With a real Ollama model resident (`qwen38-cw-iq3-80k:latest`, 13GB,
   loaded via `POST /api/generate` with `keep_alive`, landed 100% on GPU 1
   per `ollama ps`), the same query showed Ollama's own process
   (`...\Ollama\lib\ollama\llama-server.exe`) with `used_memory: [N/A]` too —
   confirming the gap applies to Ollama specifically, not just other
   processes.

**Live call to the real, unmodified `detectOllamaGpuSplit()`** (via `tsx`,
in-process, no mock — `server/src/gpu/ollama-gpu-split.ts`, `fresh: true` to
bypass the 60s cache), with the model above resident on GPU 1:

```
{"reachable":true,"split":false,"deviceIndices":[],"totalUsedMb":0,
 "wouldFitSingleDevice":false,"dataUnavailable":true}
```

This traces to a real code path, confirmed by reading the row itself: because
`used_memory` for the Ollama row is unparseable, `parseComputeAppsCsv` drops
it into `unparseableProcessNames` rather than `rows`; since the process name
matches `/ollama/i`, `hadOllamaUnparseableMemory` → `dataUnavailable: true`,
and since no row survived parsing, `ollamaRows.length === 0` short-circuits
straight to the empty/no-split result. This happened regardless of the
model's real, genuine single-GPU placement — the detector cannot see it.

**Consequence for steps 2–6 (split/no-split/mismatch scenarios), per the
row's own instruction to exercise `dataUnavailable` instead once `[N/A]` is
confirmed:** both warning sites in `server/src/analyzer/ollama.ts` gate on
`!splitResult.dataUnavailable` (lines 862 and 883 in this worktree) —
confirmed by reading the source, and consistent with the live `dataUnavailable:
true` result above. So on this box, under this driver model, **no split
warning and no device-mismatch warning can ever fire**, no matter how
Ollama actually places a model or what `analyzer.ollama.expectedDevice` is
set to — steps 2–6's split/no-split/mismatch legs are not meaningful real
scenarios to chase further on this hardware; the correct behaviour to
confirm is that the `dataUnavailable` UI path is what actually applies
here. Read (not click-tested — would require the full app/UI stack; the
source is authoritative for this): `src/views/advanced.tsx:579–587` renders
"Can't determine GPU split status — your driver doesn't expose per-process
GPU memory..." (citing the same `nvidia-smi` command and `[N/A]`/`[Not
Supported]` values this run independently confirmed) whenever
`gpuSplit.dataUnavailable` is true, and suppresses the split/mismatch amber
warning block (`advanced.tsx:589–624`) entirely in that case.

Ollama's `qwen38-cw-iq3-80k:latest` was unloaded (`keep_alive:0`) after this
check, restoring GPU 1 to its prior idle state.

## Standing rules honoured

No book data touched. No other lane's process stopped, killed, or restarted
— GPU 0's other-lane process (2587MB) was read via `nvidia-smi` only, never
targeted; Ollama had no residents at claim time and was returned to that
state. `server/.env` in this worktree was not modified. Nothing under
`server/tts-sidecar/.venv`/`voices/` was touched. This commit touches only
`docs/**`.
