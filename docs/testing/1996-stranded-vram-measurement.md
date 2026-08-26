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
   if ($quietStreak -ge 5) {
     "Confirmed idle after $((Get-Date) - $captureP2Time)"
   } else {
     "CEILING TIMEOUT after 10 minutes -- box never went idle. STOP: do not capture P3/P4."
   }
   ```

   Record the actual elapsed time in the results table's **"time to idle"**
   column. **If the gate never clears within 10 minutes, stop and report** —
   do not force P3/P4 on a busy box.

   Once the gate reports idle, capture as **P3**.

   > **If the strand is gone at P3 the run is already decisive** — the pool
   > self-heals on `main` today (decision-tree row 1). Record it and stop; do
   > not retry until a strand appears.

   **What was active during the wait.** The sidecar's `/health` endpoint with `inflight_synth` tracking (step 4 above — five consecutive zero polls = 10 s confirmed idle) is your PRIMARY signal for genuine idle. As a secondary corroboration and attribution step, grep the sidecar's access log (`logs/tts.log`, from uvicorn) for any requests during the wait window to confirm the window was clean or name what ran.

   The sidecar access log has no per-line timestamps, so use a line-count-diff to extract the appended lines: capture the line count of `logs\tts.log` at P2, capture it again at the confirmed-idle point, and extract the lines in between. If all appended lines are `/health`, `/capacity`, `/speakers`, or `/debug/memory` polling (harmless self-polling from the run sheet's own idle-gate and capture steps), the window is clean. If a `/synthesize`, `/transcribe`, or `/embed` line appears, name it — that's the confound the decision tree's fourth row keys on.

   At P2, after capturing the memory figures, save the line count:

   ```powershell
   $ttsLogCountAtP2 = (Get-Content logs\tts.log -ErrorAction Stop).Count
   if ($null -eq $ttsLogCountAtP2) { $ttsLogCountAtP2 = 0 }  # empty log
   "Line count at P2: $ttsLogCountAtP2"
   ```

   Then, once the idle gate clears and you're about to capture P3, get the current line count and print the appended lines:

   ```powershell
   $ttsLogCountAtIdle = (Get-Content logs\tts.log -ErrorAction Stop).Count
   if ($null -eq $ttsLogCountAtIdle) { $ttsLogCountAtIdle = 0 }
   $appendedCount = $ttsLogCountAtIdle - $ttsLogCountAtP2
   "Appended lines during wait: $appendedCount"
   if ($appendedCount -gt 0) {
     Get-Content logs\tts.log -Tail $appendedCount
   }
   ```

   If the output shows no appended lines, or only `/health`/`/capacity`/`/speakers`/`/debug/memory` noise, record that the idle window was clean. If it shows `/synthesize`, `/transcribe`, or `/embed`, list those in the results as evidence of what was active during the wait.

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

Run: 2026-08-26, this box (`cuda:0` RTX 4070 Laptop 8188 MB, `cuda:1` RTX 5070 Ti
16303 MB). Book: *The Coalfall Commission*, Chapter 3 ("Chapter One — The Knock",
41 lines), re-rendered with `force:true` on `qwen3-tts-0.6b`. Both GPUs were idle
(0 MiB used, 0% util) before the run started.

| Point | When | time to idle | Device | reserved bytes | allocated bytes | inactive_split bytes | reserved − allocated | nvidia-smi used | RSS MB | Engines loaded | reclaimed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P0 | fresh, 07:53:44 | | cuda:1 | 0 | 0 | 0 | 0 | 197 MiB | 1143.0 | none | |
| P1 | mid-render, 07:54:32 (~8 s in) | | cuda:1 | 1,881,145,344 (1794.4 MB) | 1,863,124,480 (1776.7 MB) | 13,826,560 (13.2 MB) | 17,975,296 (17.1 MB) | 2051 MiB | 3965.9 | qwen base | |
| P2 | +0 s, 07:58:36 | | cuda:1 | 6,138,363,904 (5853.4 MB) | 5,717,628,928 (5453.7 MB) | 30,664,704 (29.25 MB) | 420,734,976 (401.3 MB) | 6489 MiB | 19914.2 | qwen base, whisper | |
| P3 | confirmed idle, 07:58:57 | **21 s** | cuda:1 | 6,138,363,904 (5853.4 MB) — **identical to P2** | 5,717,628,928 (5453.7 MB) | 30,664,704 (29.25 MB) | 420,734,976 (401.3 MB) | 6489 MiB | 19799.1 | qwen base, whisper | |
| P4 before | reclaim, 07:58:58 | | cuda:1 | 6,138,363,904 (5853.4 MB) | 5,717,628,928 (5453.7 MB) | 30,664,704 (29.25 MB) | 420,734,976 (401.3 MB) | | | | true |
| P4 after | reclaim, 07:58:58 | | cuda:1 | 5,748,293,632 (5481.4 MB) | 5,717,628,928 (5453.7 MB) — **unchanged** | 30,664,704 (29.25 MB) — **unchanged** | 30,664,704 (29.25 MB) | | | | true |
| P5 | cuda:1 render, throughout P1–P4 | | cuda:0 | 2,097,152 (2.0 MB, unchanged pre/post) | ≈0 | ≈2.0 MB | | 0–116 MiB (baseline noise) | | | |

Reclaim delta on `cuda:1`: `reserved` dropped 390,070,272 B (**372.0 MB, 6.4% of
the 5853.4 MB reserved**). `allocated` and `inactive_split` did not move at all.
After the reclaim, `reserved − allocated` (30,664,704 B) exactly equals
`inactive_split` — i.e. every byte of *freeable* cache was already reclaimed;
nothing else in `reserved` is fragmentation.

**P5 (dual-GPU cross-device check):** satisfied by the readings already taken
rather than a second render — this box's standing device policy pins Qwen/Coqui/
ASR to `cuda:1` exclusively (`server/.env.example:528-534`), so every render on
this box **is** the cross-device case. `cuda:0` stayed at its 0–116 MiB baseline
(OS/driver noise, not app-caused) across the entire P0→P4 window while `cuda:1`
went from 197 MiB to 6489 MiB. No VRAM bleed onto the idle card.

**RSS at P2 vs 8192 MB:** ☒ above ☐ below (19914 MB, 2.4× the threshold).
*(Above means the memory watchdog's unconditional 60 s `gc+empty_cache` was
already firing throughout — confirmed directly in `logs/tts.err.log`: `"sidecar
memory crossed 8192MB (rss=17128MB) → forced gc+empty_cache reclaimed -0MB (now
17128MB)"`, fired once during the render itself, before P2 was even captured.
The watchdog was already running and reclaiming ~0 MB — it cannot touch this
pool either, for the same reason `/debug/reclaim` mostly couldn't.)*

**What was active during the wait** (from `logs/server.log`, P2 07:58:36 →
confirmed-idle 07:58:57): **idle window clean** — the grep returned zero
request lines in that 21 s window. No confound; this run's P3/P4 readings are
trustworthy evidence, not a contaminated idle.

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

### This run's verdict: none of the five rows above fit — a sixth case

The observed shape is internally consistent but doesn't match any listed row:

- Not "self-heals" — the strand is byte-identical at P2 and P3 (21 s of
  confirmed-clean idle).
- Not "uncollected cache" — reclaim only recovered 372.0 MB of the 5853.4 MB
  reserved (6.4%), nowhere near "drops sharply".
- Not "fragmentation" — `inactive_split` is 29.25 MB, a rounding error next to
  the 5453.7 MB sitting in `allocated`. Fragmentation is not what's dominant.
- Not "contaminated idle" — the gate cleared in 21 s (well under the 120 s
  threshold) and the attribution grep is empty.
- Not "invalid reading" — `reclaimed: true` both times.

**What actually explains it:** `allocated` (5453.7 MB) never moved at all,
before or after `/debug/reclaim`. `empty_cache()` only returns *reserved-but-
unallocated* cache to the driver — by definition it cannot touch memory PyTorch
still considers live. At P2/P3, `qwen.base_loaded=true` and
`whisper.model_loaded=true` — and per CLAUDE.md's engine-lifecycle notes, **Qwen
Base 0.6B has no idle TTL at all** (button-driven, evicts only on explicit
`/unload`), and Whisper's `ASR_IDLE_TTL=120s` had only 21 s elapsed against it.
So the 5.45 GB of `allocated` VRAM this run measured is, as far as this reading
can tell, **the two resident models' own live weights/KV state — normal
residency, not a leak** on top of it.

This run cannot distinguish "the resident-model floor is exactly what #1976
measured and mistook for stranded" from "there is a genuine leak sitting on top
of that floor, currently masked by residency." Answering that needs a follow-up
reading that either (a) waits past both TTLs (impossible for Qwen Base, which
has none — would need an explicit `/unload` call first) or (b) captures
`allocated` immediately after an explicit Qwen-Base unload and diffs against
this run's P3. Recorded as the next open question rather than closing #1996's
criterion 1 — this run neither confirms nor refutes #1976's "fully reclaimable"
claim; it shows the claim's own measurement never separated "resident" from
"stranded" in the first place.

Record the outcome as a comment on
[#1996](https://github.com/dudarenok-maker/Castwright/issues/1996), including the
filled table. If the reading contradicts #1976's "fully reclaimable / not
fragmentation" text, correct that issue too — leaving it in place is what would
send a third attempt down the same path.
