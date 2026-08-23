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

4. **180 s post-render.** Leave the box completely idle — no UI interaction, no
   transcribe, nothing that would touch an engine. Capture as **P3**.

   > 180 s is past every existing 120 s TTL. **If the strand is gone at P3 the
   > run is already decisive** — the pool self-heals on `main` today
   > (decision-tree row 3). Record it and stop; do not retry until a strand
   > appears.

5. **The bare reclaim.** With the box still idle, one request:

   ```powershell
   Invoke-RestMethod -Method Post http://127.0.0.1:9000/debug/reclaim | ConvertTo-Json -Depth 5
   ```

   It returns the per-device figures **before and after** a bare
   `empty_cache()`, bracketed with nothing in between. Record both as **P4**.

   > Do **not** substitute a load/unload cycle. A load is an allocation pass that
   > refills and coalesces segments — conflating the two is the unsound inference
   > that sent two design attempts down the wrong path.

6. **Dual-GPU only — the cross-device check.** Start a render pinned to `cuda:1`
   and, while it runs, capture `cuda:0`'s figures. This establishes whether a
   stranded pool on an idle card coexists with live work on another, which
   constraint 1 in §7 of the design turns on.

---

## Results

| Point | When | Device | reserved MB | allocated MB | inactive_split MB | reserved − allocated | nvidia-smi used | RSS MB | Engines loaded |
|---|---|---|---|---|---|---|---|---|---|
| P0 | fresh | | | | | | | | |
| P1 | mid-render | | | | | | | | |
| P2 | +0 s | | | | | | | | |
| P3 | +180 s | | | | | | | | |
| P4 before | reclaim | | | | | | | | |
| P4 after | reclaim | | | | | | | | |
| P5 | cuda:1 render | | | | | | | | |

**RSS at P2 vs 8192 MB:** ☐ above ☐ below
*(Above means the memory watchdog's unconditional 60 s `gc+empty_cache` was
already firing throughout — `main.py:7915`, `:7953-7960`.)*

---

## Reading the result

| Observation | Conclusion |
|---|---|
| Strand absent at P3 | Self-heals at the existing TTLs. #1996 criterion 1 is already satisfied on `main`. |
| P4 `reserved` drops sharply | **Uncollected cache.** A scheduled reclaim is the fix — subject to every constraint in §7 of the design. |
| P4 `reserved` barely moves, `inactive_split` dominates | **Fragmentation.** `empty_cache()` cannot fix this at any cadence; re-open the recycle threshold instead. |
| Strand present at P3 *and* P4 frees it *and* RSS was above 8192 MB at P2 | Contradicts the 60 s watchdog reclaim having run. Investigate that before designing anything — one of the two observations is wrong. |

Record the outcome as a comment on
[#1996](https://github.com/dudarenok-maker/Castwright/issues/1996), including the
filled table. If the reading contradicts #1976's "fully reclaimable / not
fragmentation" text, correct that issue too — leaving it in place is what would
send a third attempt down the same path.
