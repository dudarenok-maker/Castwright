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
$health = Invoke-RestMethod http://127.0.0.1:9000/health
"$ts  rss=$($mem.process.rss_mb)MB  inflight_synth=$($mem.inflight_synth)  qwen_base17_loaded=$($health.qwen_base17_loaded)"
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
   consecutive checks (8 s of confirmed idle). A 10-minute safety ceiling
   prevents an infinite wait on a busy box.
   
   **Interpreting idle-gate duration:** The idle gate reports elapsed time to
   confirm when the box truly went quiet. If the gate clears in under 120
   seconds, the idle window is likely clean (only genuine background activity
   that was already running, if anything). A gate that takes 120 seconds or
   longer to clear suggests the box was actively working during what should
   have been an idle window — consult the `logs/tts.log` grep (next section)
   to name what was running. This 120 s threshold is separate from the 8 s
   quiet-streak requirement above and the 10-minute ceiling; it is a judgment
   call for how long an otherwise-successful idle-gate wait is "suspiciously
   slow" rather than straightforwardly clean.

   Run this as **one blocking script**, not turn-by-turn polling — it
   self-terminates once idle or after the ceiling:

   ```powershell
   $deadline = (Get-Date).AddMinutes(10)
   $quietStreak = 0
   while ((Get-Date) -lt $deadline) {
     $h = Invoke-RestMethod http://127.0.0.1:9000/health
     if ($h.inflight_synth -eq 0) { $quietStreak++ } else { $quietStreak = 0 }
     if ($quietStreak -ge 5) { break }  # 5 consecutive quiet polls = 8s confirmed idle
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

   Once the gate reports idle, capture as **P3**. **Before treating P3 as a confirmed-idle reading, verify in the capture output that `inflight_synth == 0` — if it is non-zero, the idle gate's poll is stale and the TOCTOU window is open. If so, stop and re-run the idle-gate wait.**

   > **If the strand is gone at P3 the run is already decisive** — the pool
   > self-heals on `main` today (decision-tree row 1). Record it and stop; do
   > not retry until a strand appears.

   **What was active during the wait.** The sidecar's `/health` endpoint with `inflight_synth` tracking (step 4 above — five consecutive zero polls = 8 s confirmed idle) is your PRIMARY signal for genuine idle. As a secondary corroboration and attribution step, grep the sidecar's access log (`logs/tts.log`, from uvicorn) for any requests during the wait window to confirm the window was clean or name what ran.

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
   field indicating whether the reclaim actually ran. Record all three as **P4 before** and **P4 after**. **Before treating P4's readings as valid, capture `/debug/memory` one more time after the reclaim completes and verify that `inflight_synth == 0` — if it has changed, background synthesis occurred between the idle gate and the reclaim, invalidating the confirmed-idle assumption. If so, stop and re-run from step 4.**

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

| Point | When | time to idle | Device | reserved bytes | allocated bytes | inactive_split bytes | reserved − allocated | nvidia-smi used | RSS MB | inflight_synth | Engines loaded | reclaimed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P0 | fresh, 07:53:44 | | cuda:1 | 0 | 0 | 0 | 0 | 197 MiB | 1143.0 | n/a — pre-fix run | none | |
| P1 | mid-render, 07:54:32 (~8 s in) | | cuda:1 | 1,881,145,344 (1794.4 MB) | 1,863,124,480 (1776.7 MB) | 13,826,560 (13.2 MB) | 17,975,296 (17.1 MB) | 2051 MiB | 3965.9 | n/a — pre-fix run | qwen base | |
| P2 | +0 s, 07:58:36 | | cuda:1 | 6,138,363,904 (5853.4 MB) | 5,717,628,928 (5453.7 MB) | 30,664,704 (29.25 MB) | 420,734,976 (401.3 MB) | 6489 MiB | 19914.2 | n/a — pre-fix run | qwen base, whisper | |
| P3 | confirmed idle, 07:58:57 | **21 s** | cuda:1 | 6,138,363,904 (5853.4 MB) — **identical to P2** | 5,717,628,928 (5453.7 MB) | 30,664,704 (29.25 MB) | 420,734,976 (401.3 MB) | 6489 MiB | 19799.1 | n/a — pre-fix run | qwen base, whisper | |
| P4 before | reclaim, 07:58:58 | | cuda:1 | 6,138,363,904 (5853.4 MB) | 5,717,628,928 (5453.7 MB) | 30,664,704 (29.25 MB) | 420,734,976 (401.3 MB) | | | n/a — pre-fix run | | true |
| P4 after | reclaim, 07:58:58 | | cuda:1 | 5,748,293,632 (5481.4 MB) | 5,717,628,928 (5453.7 MB) — **unchanged** | 30,664,704 (29.25 MB) — **unchanged** | 30,664,704 (29.25 MB) | | | n/a — pre-fix run | | true |
| P5 | cuda:1 render, throughout P1–P4 | | cuda:0 | 2,097,152 (2.0 MB, unchanged pre/post) | ≈0 | ≈2.0 MB | | 0–116 MiB (baseline noise) | | n/a — pre-fix run | | |

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

**What was active during the wait:** This run was measured with instruments that are now known to have been broken in two ways, both fixed on this branch but after this run was captured:

1. **The idle gate couldn't see ASR activity.** The sidecar's `/health` endpoint tracked `inflight_synth` only for synthesis requests (`/synthesize`), not transcription (`/transcribe`) or embedding (`/embed`). This gate declared "idle" at 07:58:57 based on five consecutive zero `inflight_synth` polls, but that metric was blind to ASR. *Fixed in commit d4aa7a6c: `/health` and `/debug/memory` now include `/transcribe` and `/embed` in the busy signal.*

2. **The attribution grep read the wrong log file.** The verification step relied on grepping `logs/server.log` for request lines, which never contains per-request entries from the sidecar — a null result that looked like "nothing happened" but actually meant "this instrument cannot report anything, ever." *Fixed in commit 36091ef2: the attribution step now reads `logs/tts.log`, the sidecar's uvicorn access log.*

Real forensic evidence from `logs/tts.err.log` for this specific run: Whisper `small` loaded onto `cuda:1` at 07:58:31–34 and ran continuous transcription through 07:58:51.768. The idle gate reported a quiet streak beginning at ≈07:58:49 (after an 8 s quiet window from ~5 second polls starting after 07:58:41), which **overlaps the live Whisper transcription window (07:58:31–51.768)**. This run's "confirmed idle" window was not clean; it was contaminated by active ASR transcription that the broken idle gate could not detect.

---

## Reading the result

| Observation | Conclusion |
|---|---|
| Strand absent at P3 | Self-heals at the existing TTLs. #1996 criterion 1 is already satisfied on `main`. |
| P4 `reserved` drops sharply | **Uncollected cache.** A scheduled reclaim is the fix — subject to every constraint in §7 of the design. |
| P4 `reserved` barely moves, `inactive_split` dominates, `reclaimed: true` | **Fragmentation.** `empty_cache()` cannot fix this at any cadence; re-open the recycle threshold instead. |
| Idle gate took >120 s to clear | **Contaminated idle.** Legitimate background activity was still running; name it from the `logs/tts.log` grep above. **Do not treat the resulting P3/P4 readings as evidence about a stranded pool at all.** |
| P4 `reserved` barely moves, `reclaimed: false` | **Invalid reading.** The reclaim never ran — CUDA was unavailable or `empty_cache()` threw. Retry once; treat repeated `false` as a separate finding (a live-context problem), not a #1996 answer. |
| Strand present at P3 *and* P4 frees it *and* RSS was above 8192 MB at P2 | Contradicts the 60 s watchdog reclaim having run. Investigate that before designing anything — one of the two observations is wrong. |

### This run's verdict: contaminated idle with misattributed residency — evidence is invalid

This run fits the **"contaminated idle"** row: the idle-gate signal and the attribution verification both relied on broken instruments that are now known to have been blind to the actual work running.

**The contamination:** Whisper ASR was transcribing continuously during what the old idle gate declared "confirmed idle" (07:58:49–07:58:57 vs actual Whisper activity 07:58:31–51.768). The old idle gate could not see this because it tracked only `inflight_synth`, not `/transcribe` or `/embed` (fixed in commit d4aa7a6c). The attribution grep checked the wrong log file (`logs/server.log` instead of `logs/tts.log`, fixed in commit 36091ef2). Legitimate background activity (Whisper) was still running during the supposed idle window — **do not treat the resulting P3/P4 readings as evidence about a stranded pool at all.**

**The misattribution:** The run loaded three resident models — Qwen Base 0.6B (no TTL), Whisper (120s TTL), and Qwen 1.7B-Base (120s TTL) — but the `/debug/memory` endpoint at the time of this run could not represent the 1.7B model (missing the `base17_loaded` key, added retroactively in commit 42dddeb8). The 3677.0 MB gap between P1's `allocated` (1776.7 MB) and P2's `allocated` (5453.7 MB) is the Qwen 1.7B-Base model loading during the run. Log evidence from `logs/tts.err.log` confirms: `07:57:58.112 Qwen 1.7B-Base loaded.` and `07:58:29.275 qwen batch synth: model=1.7b items=7 voices=3`. At the time this run was captured, `/debug/memory` could not track the 1.7B model's residency — but `/health` has exposed a `qwen_base17_loaded` field since well before this branch (main.py:~9645, consumed by `server/src/routes/sidecar-health.ts:~458`). The real issue is that the capture snippet in step "The capture" only calls `/debug/memory`, never `/health`, so a signal that was already available went unrecorded. The 1.7B model's 120s idle TTL means P3 (21 s post-P2) would not have evicted it even if the idle window had been clean — which it was not.

**Conclusion:** This run does NOT provide trustworthy evidence. Its P3/P4 readings show a contaminated-idle state with unattributable residency, not a measurement of a stranded pool. It does not close #1996's criterion 1 (and does not discharge the acceptance row already owed).

**Next step:** A valid re-run is still owed, using the now-fixed instruments (idle gate tracking ASR via the `/transcribe`/`/embed` signals, attribution grepping `logs/tts.log`, and `/debug/memory` with full `base17_loaded` visibility). This is real-hardware work that was not performed as part of this PR-review-gate fix round — no GPU re-run has been executed; only this narrative correction has landed.

Record the outcome as a comment on
[#1996](https://github.com/dudarenok-maker/Castwright/issues/1996), including the
filled table. If the reading contradicts #1976's "fully reclaimable / not
fragmentation" text, correct that issue too — leaving it in place is what would
send a third attempt down the same path.
