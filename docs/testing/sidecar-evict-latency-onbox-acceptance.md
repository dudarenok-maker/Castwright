# Sidecar evict-off-event-loop — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box, with the real GPU + real TTS sidecar. Do not pre-fill them.
>
> Plan of record: [`docs/features/archive/273-sidecar-lock-event-loop.md`](../features/archive/273-sidecar-lock-event-loop.md) §7
> Register row: [`onbox-acceptance-register.md` A17](onbox-acceptance-register.md)
> Issues: [#1919](https://github.com/dudarenok-maker/Castwright/issues/1919) (fixed here), [#1925](https://github.com/dudarenok-maker/Castwright/issues/1925) (closed as superseded — see the plan §1.2)

---

## 1. Purpose & scope

Automated tests (`test_placement.py`, the T7/T8 pytest additions) prove that
every eviction step — and the reclaim that follows it — now runs on a worker
thread via `asyncio.to_thread`, off the asyncio event loop. They cannot prove
the user-visible claim: that `/health`, and every other in-flight request,
stays responsive while a **real** multi-GB `gc.collect()`/`empty_cache()` and a
**real** contended engine lock are in play. That needs the GPU box.

The recipe below exercises the **default** Qwen path — no opt-in env var, no
non-default configuration. This is deliberate: the plan's own analysis
(§1.1) found the race reachable in the default configuration, wider than the
originating issue assumed.

## 2. Preconditions

- [ ] Dual-GPU dev box (`cuda:0` 4070 8 GB, `cuda:1` 5070 Ti 16 GB), pinned to
      one card via `CUDA_VISIBLE_DEVICES=0` for this run.
- [ ] `SEG_CAPACITY_ADMISSION=1` (the default) and Qwen selected as the
      generation engine (also the default) — neither needs an explicit flip.
- [ ] A book with at least one character whose voice is mid-**design**
      (Qwen VoiceDesign warm-resident) and a second admission target ready to
      trigger — a Coqui `/load`, or an `/xtts/clone-voice` call.
- [ ] A second shell free to poll `GET /health` throughout.

Runnable in the same session as A19/A5/A20 (same card, same box) — no need for
a dedicated sitting.

## 3. Procedure

1. Run a cast-review **voice design** so Qwen VoiceDesign is warm-resident
   (`QWEN_DESIGN_IDLE_TTL` keeps it resident ~120 s).
2. Start a Qwen **chapter render** on the same card — each sentence's forward
   holds `_synth_lock` for its duration.
3. While the render is in flight, trigger a second admission on the same
   card: `POST /load` for Coqui, or an `/xtts/clone-voice` call. Its
   `qwen.design` eviction step's fast-out passes (nothing is *designing*), so
   it blocks on `_synth_lock`, held by the in-flight Base forward — the exact
   race #1919 describes.
4. From the second shell, poll `GET /health` every 250 ms **throughout** —
   starting before the render begins, through the second admission
   resolving — and record every response's timestamp.
5. Compute the **maximum inter-response gap**, in milliseconds, across the
   whole poll.
6. Confirm the second admission **actually succeeds** (the evict really
   freed the VRAM) rather than 503-ing `noCapacity`. A near-zero `/health`
   gap because the evict silently declined and did nothing would look like
   a pass and isn't one.
7. **Optional second pass:** repeat with `SEG_ASR_ENABLED=1` +
   `ASR_DEVICE=cuda` to exercise the `asr` eviction step too. Not required
   for this row to clear.

## 4. Expected result

Before this fix, the expected maximum gap is on the order of one Qwen
forward pass (seconds) — the eviction step and its reclaim ran synchronously
on the event loop, so `/health` (and everything else) queued behind them.
After the fix, the maximum gap should stay near the poll interval (well
under ~1 s), because the evict and its reclaim now run on a worker thread.

## 5. Result

**Maximum `/health` inter-response gap:** _(fill in, ms)_
**Second admission outcome (fit vs. `noCapacity`):** _(fill in)_
**Run by:** _(fill in)_ **Date:** _(fill in)_
**Optional ASR pass run?** _(yes/no; gap if yes)_

_(Once run, mark the register row A17 discharged with a summary of this
result and remove it from the "owed" count.)_
