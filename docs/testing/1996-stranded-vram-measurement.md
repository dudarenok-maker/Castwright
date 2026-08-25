# #1996 — what is actually stranded: measurement run sheet

**Purpose:** decide whether the VRAM pool a finished render leaves behind is
*uncollected cache* (a scheduled reclaim fixes it) or *allocator fragmentation*
(`empty_cache()` can never return it, and a boundary recycle is the fix). Design
and decision tree:
[`docs/superpowers/specs/2026-08-18-stranded-vram-reclaim-design.md`](../superpowers/specs/2026-08-18-stranded-vram-reclaim-design.md).

**This is a diagnostic run, not an acceptance run.** Nothing is being accepted,
so it takes no row in the on-box acceptance register.

**Prerequisites**

- A CUDA box with the render card. The dual-GPU box #1976 was measured on
  (`cuda:0` RTX 4070 8187 MB, `cuda:1` RTX 5070 Ti 16302 MB) is preferred — it is
  the topology the original report came from — but a single 8 GB card is enough
  for every reading except step 6.
- The `/debug/memory` per-device extension and `POST /debug/reclaim` from §4 of
  the design. **Without them this run sheet cannot produce readings 1 and 2** —
  the existing `/debug/memory` is current-device-only and carries no
  `inactive_split_bytes`.
- A book with at least two chapters. `the-coalfall-commission.md` (the canonical
  fixture) is fine.
- Qwen as the generation engine.
- **Start the app via `npm start`** (not `npm run dev`) so that `logs/server.log`
  and `logs/tts.err.log` capture the full timeline. `npm run dev` does not
  redirect console output to the log files, which is why the Aug 23 run's
  Node-side eviction log only survives as a manually-pasted GitHub comment line
  and a burst of unexplained post-render Qwen activity could not be attributed to
  a caller.
- **Confirm `QWEN_DEVICE` and `ASR_DEVICE` are `cuda:1`** (the box's standing
  device policy — `server/.env.example:528-534`) before starting. `cuda:1` is
  the RTX 5070 Ti (16 GB); `cuda:0` (the 8 GB 4070 Laptop) is deliberately left
  free for other work. Do not deviate from the pinned `cuda:1` policy unless
  there is a documented reason — and if you must, record the deviation exactly
  like the Aug 23 run did.
- **Confirm no other chapter or book job is queued** and no Cast Review or
  audition session is open in another browser tab. The last run's extra Qwen
  activity during its supposed idle window is suspected to be exactly this kind
  of confound — this run needs to rule it out or name it.

Sidecar is at `http://127.0.0.1:9000` unless `LOCAL_TTS_PORT` says otherwise.

---

## The capture

Run this at each capture point and paste the output into the table below.

```powershell
$ts = (Get-Date).ToString('HH:mm:ss')
$mem = Invoke-RestMethod http://127.0.0.1:9000/debug/memory
"$ts  rss=$($mem.process.rss_mb)MB"
$mem.memory_stats | ConvertTo-Json -Depth 4
$mem.engines | ConvertTo-Json -Depth 3
nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader
```

Record, per device: `reserved`, `allocated`, `inactive_split`, and
`reserved - allocated`.

---

## Steps

1. **Fresh sidecar.** Restart it, run no synthesis, capture as **P0**. This is
   the baseline every later figure is read against.

2. **Mid-render.** Start a chapter render on Qwen. While it is generating,
   capture as **P1**.

3. **Immediately post-render.** The moment the chapter completes, capture as
   **P2**. Note the wall-clock time — steps 4 and 6 are relative to it.
   Record which engines report loaded; specifically whether **Coqui, Kokoro or
   Qwen Base 0.6B** is among them (the three engines with no idle TTL).

   Stamp the P2 capture time so the idle gate in step 4 can report elapsed:

   ```powershell
   $captureP2Time = Get-Date
   ```

4. **Wait for confirmed idle.** Leave the box idle — no UI interaction, no
   transcribe, nothing that would touch an engine. Instead of a fixed 180 s
   wall clock, poll the sidecar's `/health` endpoint for `inflight_synth` (an
   int; `0` means nothing is generating) until it has been quiet for five
   consecutive checks (10 s of confirmed idle). A 10-minute safety ceiling
   prevents an infinite wait on a busy box.

   Run this as **one blocking script**, not turn-by-turn polling — it
   self-terminates once idle or after the ceiling:

   ```powershell
   $deadline = (Get-Date).AddMinutes(10)
   $quietStreak = 0
   while ((Get-Date) -lt $deadline) {
     $h = Invoke-RestMethod http://127.0.0.1:9000/health
     if ($h.inflight_synth -eq 0) { $quietStreak++ } else { $quietStreak = 0 }
     if ($quietStreak -ge 5) { break }  # 5 consecutive quiet polls = 10s confirmed idle
     Start-Sleep -Seconds 2
   }
   "Went idle after $((Get-Date) - $captureP2Time)"
   ```

   Record the actual elapsed time in the results table's **"time to idle"**
   column. **If the gate never clears within 10 minutes, stop and report** —
   do not force P3/P4 on a busy box.

   Once the gate reports idle, capture as **P3**.

   > **If the strand is gone at P3 the run is already decisive** — the pool
   > self-heals on `main` today (decision-tree row 1). Record it and stop; do
   > not retry until a strand appears.

   **What was active during the wait.** Before moving to P3/P4, grep
   `logs/server.log` for every request timestamped between the P2 capture and
   the confirmed-idle point. List each one (route + any chapter/job id in the
   log line) in a new **"What was active during the wait"** subsection of the
   results. This closes the attribution gap the Aug 23 run left open — a burst
   of unexplained post-render Qwen activity could not be attributed to a caller
   because `npm run dev` did not write to `logs/server.log`.

   ```powershell
   $idleTime = Get-Date
   Select-String -Path logs\server.log -Pattern 'GET |POST |PUT |PATCH |DELETE ' |
     ForEach-Object {
       $line = $_.Line
       if ($line -match '(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})') {
         $ts = [datetime]::Parse($matches[1])
         if ($ts -ge $captureP2Time -and $ts -le $idleTime) { $line }
       }
     }
   ```

   If the grep returns nothing, the idle window was genuinely clean. If it
   returns entries, name them in the results — the decision tree's fourth row
   uses this to tell a contaminated idle from a real strand.

5. **The bare reclaim.** With the box still idle, one request:

   ```powershell
   Invoke-RestMethod -Method Post http://127.0.0.1:9000/debug/reclaim | ConvertTo-Json -Depth 5
   ```

   It returns the per-device figures **before and after** a bare
   `empty_cache()`, bracketed with nothing in between, plus a `reclaimed: bool`
   field indicating whether the reclaim actually ran. Record all three as **P4**.

   > Do **not** substitute a load/unload cycle. A load is an allocation pass that
   > refills and coalesces segments — conflating the two is the unsound inference
   > that sent two design attempts down the wrong path.

6. **Dual-GPU only — the cross-device check.** Start a render pinned to `cuda:1`
   and, while it runs, capture `cuda:0`'s figures. This establishes whether a
   stranded pool on an idle card coexists with live work on another, which
   constraint 1 in §7 of the design turns on.

---

## Results

| Point | When | time to idle | Device | reserved bytes | allocated bytes | inactive_split bytes | reserved − allocated | nvidia-smi used | RSS MB | Engines loaded | reclaimed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P0 | fresh | | | | | | | | | | |
| P1 | mid-render | | | | | | | | | | |
| P2 | +0 s | | | | | | | | | | |
| P3 | confirmed idle | _elapsed_ | | | | | | | | | |
| P4 before | reclaim | | | | | | | | | | |
| P4 after | reclaim | | | | | | | | | | |
| P5 | cuda:1 render | | | | | | | | | | |

**RSS at P2 vs 8192 MB:** ☐ above ☐ below
*(Above means the memory watchdog's unconditional 60 s `gc+empty_cache` was
already firing throughout — `main.py:7957-7964` (`_mem_warn_threshold_mb()`).)*

**What was active during the wait** (from `logs/server.log`, P2 → confirmed-idle):

<!-- List each request line here: route + chapter/job id. If none, write "idle window clean". -->

---

## Reading the result

| Observation | Conclusion |
|---|---|
| Strand absent at P3 | Self-heals at the existing TTLs. #1996 criterion 1 is already satisfied on `main`. |
| P4 `reserved` drops sharply | **Uncollected cache.** A scheduled reclaim is the fix — subject to every constraint in §7 of the design. |
| P4 `reserved` barely moves, `inactive_split` dominates, `reclaimed: true` | **Fragmentation.** `empty_cache()` cannot fix this at any cadence; re-open the recycle threshold instead. |
| Idle gate took >120 s to clear | **Contaminated idle.** Legitimate background activity was still running; name it from the `logs/server.log` grep above. **Do not treat the resulting P3/P4 readings as evidence about a stranded pool at all.** |
| P4 `reserved` barely moves, `reclaimed: false` | **Invalid reading.** The reclaim never ran — CUDA was unavailable or `empty_cache()` threw. Retry once; treat repeated `false` as a separate finding (a live-context problem), not a #1996 answer. |
| Strand present at P3 *and* P4 frees it *and* RSS was above 8192 MB at P2 | Contradicts the 60 s watchdog reclaim having run. Investigate that before designing anything — one of the two observations is wrong. |

Record the outcome as a comment on
[#1996](https://github.com/dudarenok-maker/Castwright/issues/1996), including the
filled table. If the reading contradicts #1976's "fully reclaimable / not
fragmentation" text, correct that issue too — leaving it in place is what would
send a third attempt down the same path.
