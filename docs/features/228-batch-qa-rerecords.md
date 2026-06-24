---
status: active
shipped: null
owner: null
---

# Batch the QA re-record loops (fix the ~2× Qwen RTF regression)

> Status: active
> Key files: `server/src/tts/synthesise-chapter.ts`,
> `server/src/tts/synthesise-chapter-asr.test.ts`,
> `server/src/tts/synthesise-chapter.test.ts`
> URL surface: none (internal synthesis path)
> OpenAPI ops: none

## Benefit / Rationale

_Benefit (user / technical):_ restores Qwen chapter throughput from ~RTF 1.9–2.0
back to ~RTF 1.2 by routing the per-sentence QA **re-records** through the same
batched dispatch the initial synth uses, instead of one unbatched `synthesize`
call per suspect/drift sentence.

## Problem

After the signal-QA gate (plan 179) and the ASR content-QA pass (srv-31) were
wired into live generation, Qwen chapters that used to render at ~RTF 1.0–1.2
started rendering at ~RTF 1.9–2.0. The QA passes themselves were cheap; the cost
was the **re-records they trigger**.

### Measured evidence (KotLC "Chapter Three", qwen3-tts-0.6b, 8 GB GPU)

| Stage | Measurement | Share of the 1158 s render |
|---|---|---|
| Batched initial synth | ~621 s for ~604 s audio (~1.03 RTF) | the floor — generation is fine |
| Voice-drift `/embed` pass (CPU ECAPA) | 0.29 s/call × ~155 ≈ 45 s | ~4% |
| ASR `/transcribe` pass (CUDA Whisper) | 0.42 s/call × ~154 ≈ 65 s | ~6% |
| **Unbatched re-records** | remainder | the regression |

Disabling just the signal-QA re-records (`qa.seg.maxRerecords = 0`, live config
override) dropped the same chapter from **RTF 1.94 → 1.66** with no other change.
The synth phase isolated to ~1.03 RTF; the remaining overhead was the still-on
**ASR re-records**, also unbatched.

## Root cause

The initial body synth packs Qwen groups into size-capped, modelKey-bucketed,
length-sorted, token-budgeted batches sent as one `synthesizeBatch` call. Both
QA re-record loops, however, called `synthGroup(group)` — a **single,
unbatched** `synthesize` per suspect/drift sentence, serially. A single short
sentence is the worst-case Qwen RTF (per-call dispatch amortized over almost no
audio), and runaway sentences re-record up to N times, so the re-record tax
compounds.

## The fix

Extract the existing partition + pack + worker-pool dispatch into a reusable
`synthGroupsBatched(groupList, onDone?)` helper, and rewrite both QA loops to be
**round-based**: each round collects the groups still failing, re-synths them in
one batched dispatch, re-verifies, keeps the best take per group, and drops the
ones that recovered — up to `maxRerecords` rounds.

- The **initial body pass** calls the helper with `onDone = (g, r) => { results[g.index] = r; fireComplete(g); }` — behaviour byte-identical to the pre-extraction inline pool (the determinism tests in `synthesise-chapter.test.ts` are the regression net).
- The **signal-QA loop** and **ASR loop** call the helper with the round's pending subset and use the returned `Map<index, GroupResult>` for best-of-N.

## Invariants preserved

- **Best-of-N** per group across rounds (verdict held in `segmentQaByIndex` /
  `segmentAsrByIndex`; a group leaves the pending set once it recovers).
- **Per-group re-record budget** unchanged (≤ `maxRerecords` re-synths per group,
  one per round).
- **Determinism** — scatter-back by `group.index`; batch composition never
  changes assembled order.
- **modelKey isolation** — 0.6B and 1.7B groups never share a batch (the
  per-modelKey partition is inside the helper).
- **Non-Qwen degrade** — Coqui/Kokoro/Gemini groups (no `synthesizeBatch`) stay
  single calls in re-records too (byte-identical).
- **Abort** checked each round; **recycle-recovery** wraps each batched call;
  the **no-progress watchdog** stays fed (per-group `onSegmentRerecord` /
  `onRerecord` ticks + the `synthGroup`/`synthBatch` heartbeat).
- `maxRerecords = 0` skips the gate exactly as before.

## Tests

`server/src/tts/synthesise-chapter-asr.test.ts`:
- ASR drift re-records all sampled-drift sentences in **one** batch, not N
  single calls (RED before the fix: 4 single calls, expected 1 anchor).
- A recovered group drops out of later rounds — exactly one re-record batch
  despite a budget of 2.

`server/src/tts/synthesise-chapter.test.ts`:
- Signal-QA re-records suspect sentences in one batch, not N single calls.
- All pre-existing Qwen true-batching / determinism / scatter-back tests stay
  green (the helper extraction is byte-identical for the initial pass).

## Acceptance (manual, on-box) — OWED

Regenerate a QA-flagging Qwen chapter (e.g. KotLC "Chapter Three") with the full
gate stack on (`SEG_ASR_ENABLED=1`, signal-QA + ASR re-records at 2) and confirm
RTF lands near ~1.2 (down from ~1.9), with the same suspect/asrSuspect flagging
behaviour. Deferred until the GPU box is free.

## Out of scope

- The "quick brown fox" pangram splice (issue #1) — that is a *quarantine-not-flag*
  fix for runaway/drift segments; batching only gives runaways more efficient
  retries. Tracked separately.
- The `SPK_DEVICE` CPU→CUDA question — measured at ~4% of wall-time, not the RTF
  lever; left as-is.

## Ship notes

_Pending merge + on-box acceptance._
