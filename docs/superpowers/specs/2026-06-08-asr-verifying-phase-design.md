# Surface the ASR "Verifying speech" phase in the Generate view

**Date:** 2026-06-08
**Status:** approved (design)
**Area:** frontend + server (full-stack, tightly scoped)

## Problem

The ASR content-QA pass (srv-31, gated by `SEG_ASR_ENABLED`) runs inside
`synthesiseChapter` **after** all synthesis groups finish and **before** chapter
assembly. It transcribes sampled lines on CPU and word-error-rates them against
the manuscript, re-recording "fluent but wrong words" drift.

While that pass runs, the only callback that fires is `asr.onRerecord`, which
re-broadcasts the **last synthesis `progress` tick** (`server/src/routes/generation.ts:1251`).
So the per-chapter row in the Generate view stays frozen at
"Synthesising {name} · line N of Y" / ~99% (`src/views/generation.tsx:1336`) with
no signal that ASR is actually working. The user reads it as stuck.

A latent server bug rides alongside: a chapter with **no** ASR drift fires
`onRerecord` zero times, so the entire ASR pass emits no ticks — long enough to
risk tripping the server's no-progress watchdog into a false stall.

## Precedent

The `chapter_assembling` tick already sets a UI-only `chapter.phase = 'assembling'`
(`src/store/chapters-slice.ts:407`) that flips the row to "Assembling…"
(`src/views/generation.tsx:1240-1245`). We mirror that path exactly with a new
`verifying` phase. Per-chapter order becomes:

> Synthesising X · line N of Y → **Verifying speech…** → Assembling… → Done

## Decisions (confirmed with user)

- **Note wording:** "Verifying speech…"
- **Surface:** per-chapter row only. The global top-bar `GenerationPill` is
  unchanged (stays "Generating").

## Changes

Each step mirrors the existing assembling path.

1. **Wire schema** — `openapi.yaml`: add `chapter_verifying` to the
   `GenerationTick.type` enum (line ~3217). Reuses the existing
   `chapterId`/`progress`/`currentLine`/`totalLines` fields; no new properties.
   Regenerate `src/lib/api-types.ts` via `npm run openapi:types`.

2. **Server `server/src/tts/synthesise-chapter.ts`** — add an
   `asr.onProgress?.({ verified, total })` callback to `AsrPassOptions`, fired at
   the **top of every sampled-group iteration** in the `if (asr)` block (line
   ~1246) — including `ok` verdicts. `total` = number of groups that will be
   sampled; `verified` = count completed so far. Besides driving the phase, this
   feeds the no-progress watchdog throughout an all-`ok` pass (closes the latent
   false-stall bug).

3. **Server `server/src/routes/generation.ts`** —
   - Wire `asr.onProgress` → `bumpProgress()` +
     `broadcast(job, { type: 'chapter_verifying', chapterId, progress: ~0.99, currentLine: totalLines, totalLines })`.
   - Change the existing `asr.onRerecord` handler to broadcast
     `chapter_verifying` instead of re-broadcasting the stale `progress` tick
     (a `progress` tick resets `ch.phase` to `null`, flickering the caption back
     to "Synthesising"). Keep `bumpProgress()`.

4. **Frontend `src/lib/types.ts`** — widen `Chapter.phase` to
   `'assembling' | 'verifying' | null`.

5. **Frontend `src/store/chapters-slice.ts`** — handle `chapter_verifying`:
   `ch.phase = 'verifying'`, `ch.state = 'in_progress'`, carry
   `progress`/`currentLine`/`totalLines` (mirror of the `chapter_assembling`
   handler at line 407).

6. **Frontend `src/views/generation.tsx`** —
   `const verifying = chapter.phase === 'verifying'`; the in-progress pill label
   gains a `verifying → "Verifying speech…"` branch; the live caption
   (line 1331-1338) renders "Verifying speech…" instead of the frozen
   "Synthesising …" line when `verifying`.

## Scope guards

- Global top-bar `GenerationPill` unchanged.
- The code path is gated on the existing `asr` options, so it is a strict no-op
  when ASR is disabled. **In the current production deployment ASR is ON**
  (`server/.env`: `SEG_ASR_ENABLED=1`, `SEG_ASR_SAMPLE_EVERY=1`, `ASR_DEVICE=cuda`,
  `ASR_MODEL=base`), so the verifying phase shows on **every chapter of every
  run** — this is the live symptom being fixed, not an edge case.
- Multi-worker overlap is fine: chapter N can read "Verifying speech…" while
  N+1 reads "Synthesising…" — per-chapter rows carry independent phase.

## Test plan

- **Server unit** (`server/src/tts/synthesise-chapter-asr.test.ts`): `onProgress`
  fires once per sampled group **including `ok` verdicts**, with correct
  `verified`/`total`.
- **Slice unit** (`src/store/chapters-slice.test.ts`): `chapter_verifying` sets
  `phase='verifying'`; a subsequent `chapter_assembling`/`chapter_complete`
  clears it.
- **View unit** (`src/views/generation.test.tsx`): the in-progress row caption
  renders "Verifying speech…" when `phase='verifying'`.
- **e2e** (best-effort): add a `chapter_verifying` frame to the mock generation
  stream if it is scripted there; otherwise note that mock-mode does not run ASR
  and the slice + view units carry the behaviour.

## Out of scope

- Showing a numeric "N of M" count in the caption (the chosen wording is the
  ellipsis form).
- Reflecting the verifying phase in the global pill or anywhere outside the
  per-chapter row.
- Any change to ASR thresholds, sampling, or re-record policy (srv-31 owns those;
  see `docs/features/archive/186-asr-content-qa.md`).
