---
status: active
shipped: null
owner: null
---

# 154 — A local Qwen timeout no longer reports "Gemini TTS rate-limited" (and no longer stops the run)

> Status: active — code + tests landed; live acceptance (regenerate the The Drowning Bell tail across a recycle) pending.
> Key files: `server/src/routes/generation-error.ts` (classifier), `server/src/routes/generation.ts` (classifier callsite + srv-17c recovery trigger)
> URL surface: indirect (generation SSE `chapter_failed` reason + queue paused-on-fatal)
> OpenAPI ops: none
> Related: [[148-recycle-inflight-recovery]] (srv-17c loop this extends), [[143-sidecar-process-recycle]], [[137-sidecar-fetch-timeout]] (the per-call ceiling that throws the timeout)

## The incident (2026-05-31, the Hollow Tide *The Drowning Bell*)

A 100%-local **Qwen** run (`defaultTtsEngine: local`, every chapter stamped
`audioModelKey: qwen3-tts-0.6b`) died at **CH24 "Chapter Twenty-One"** with the
banner **"Synthesis failed — Gemini TTS rate-limited — stopped run; resume later
or switch to a local engine."** Two things were wrong:

1. **No Gemini request was ever made.** Gemini is wired for *analysis only*
   (`ANALYZER=gemini`, cloud). Gemini *TTS* has no free tier; a real call would
   429 instantly — none happened.
2. **It stopped the whole book.** The underlying failure was a
   `ChapterSynthTimeoutError` (`server.err.log`: *"TTS batch call exceeded 600s
   with no result — likely runaway/degenerate input. Skipping this chapter so the
   queue can advance."*) thrown after a host-RAM **recycle** (plan 143) respawned
   the sidecar mid-synth and the re-issued call stalled into the 600 s ceiling
   ([[137-sidecar-fetch-timeout]]).

### Root cause A — the substring bug

`describeSynthesisError` classified quota errors with `/429|quota|rate/i`. The bare
token **`rate`** matches inside **"dege·nerate"**, so the timeout's own message was
tagged `isQuota` → the Gemini wording **and** `fatal: true`. That timeout was
*designed* to be non-fatal ("…so the queue can advance"); the misclassification
flipped it to a run-stopping fatal.

### Root cause B — the timeout bypassed the recovery loop

The srv-17c chapter recovery loop ([[148-recycle-inflight-recovery]]) rides out a
recycle for *transient* errors, but `ChapterSynthTimeoutError` is non-transient by
construction, so it bubbled straight to the fatal path instead of getting a
readiness-gated re-render.

## The fix

### #1 — classifier (`generation-error.ts`)

- **Tightened the rate-limit match**: a real HTTP `429`, or an unambiguous phrase
  (`\b429\b | too many requests | \bquota\b | rate[-\s]?limit | resource…exhausted`).
  The bare `rate` token is gone, so `degenerate`/`generated` can't trip it.
- **Engine-gated the wording**: `describeSynthesisError(err, engine?)`. A genuine
  429 is always upstream (Gemini), but a rate-limit-*shaped* message on a local
  engine (`engine !== 'gemini'`) is surfaced as a non-fatal raw reason — never
  "Gemini TTS …". Callsite (`generation.ts`) now passes the run's `engine`.
- **Explicit non-fatal branch for `ChapterSynthTimeoutError`** (matched by `name`,
  no import cycle), with a memory-pressure-aware reason, classified FIRST so a
  future regex change can't re-escalate it.

### #2 — recovery loop (`generation.ts`)

`ChapterSynthTimeoutError` is now recoverable in the srv-17c loop alongside
transients: on a stall it waits on the readiness gate (`ensureSidecarEngineReady`,
~210 s budget) and re-renders against a sidecar that is actually ready, bounded by
`MAX_RECYCLE_RECOVERIES`. After the budget is exhausted it bubbles — and is now
**non-fatal** (skip & advance), so one stalled chapter never halts the book again.

## Test plan

Automated (`server/src/routes/generation-error.test.ts`, all green):
- The exact CH24 `ChapterSynthTimeoutError` message is **non-fatal** and **never**
  mentions Gemini / rate-limited.
- A real `status: 429` is still Gemini-rate-limited fatal (even with `engine:'qwen'`).
- A rate-limit-shaped message on a local engine is non-fatal / not-Gemini.
- A real Gemini quota message (`engine:'gemini'`) is still fatal.
- The word `generated` in an unmapped error is non-fatal, not a rate-limit.

Manual acceptance (pending live run): with a clean VRAM baseline (reboot), resume
the The Drowning Bell queue from CH24 on Qwen and force a recycle mid-chapter — the
chapter re-renders rather than failing, and no run shows the Gemini banner.

## Out of scope (tracked separately)

The **Qwen reload VRAM leak** that *caused* the recycle pressure (orphaned CUDA
tensors: ~9.9 GB allocated with no model loaded) and **recycle-at-chapter-boundary**
are sidecar-side work on their own branch — see `docs/BACKLOG.md` (`side-11`). This
plan only stops the local failure from masquerading as a Gemini stop and from
halting the whole book.
