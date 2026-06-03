---
status: active
shipped: null
owner: null
---

# 174 — Post-synthesis audio QA gate (advisory) (srv-27)

> Status: active — automated coverage green; live acceptance owed.
> Key files: `server/src/tts/audio-qa.ts`, `server/src/routes/generation.ts`, `src/lib/types.ts`, `src/views/generation.tsx`, `src/components/listen/listen-player-region.tsx`
> URL surface: `#/books/<id>/generate` + `#/books/<id>/listen` (per-chapter "Suspect" badge)
> OpenAPI ops: none new — adds a `ChapterQaVerdict` schema referenced from chapter / tick shapes

## Benefit / Rationale

- **User:** a garbled / empty / truncated render is flagged with a "Suspect" badge + reason before the listener hits it, instead of silently shipping a bad chapter.
- **Technical:** reuses the loudnorm first-pass stats already measured per chapter (`i` integrated LUFS, `tp` true peak) plus `result.durationSec` — no second analysis pass over the audio.
- **Architectural:** the verdict is **advisory metadata** persisted on the chapter; it never gates the `done` flip (decision locked this round — avoids false-positive regen storms on legitimately quiet passages).

## Architectural impact

- **New module** `audio-qa.ts`: `evaluateChapterQa({ durationSec, expectedSec, lufs, truePeakDb }, thresholds?) → ChapterQaVerdict { status:'ok'|'suspect', reasons[], measuredLufs, truePeakDb, durationSec, expectedSec, checkedAt }`. `DEFAULT_QA_THRESHOLDS` (nearSilentLufs -40, clipTpDb -0.1, minDurationRatio 0.5, maxDurationRatio 2.5) with env overrides `QA_NEAR_SILENT_LUFS` / `QA_CLIP_TP_DB` / `QA_MIN_DUR_RATIO` / `QA_MAX_DUR_RATIO`.
- `generation.ts` stashes the loudnorm stats from the `onLoudnessMeasured` callback, derives `expectedSec` from analysed sentence chars ÷ ~14 chars/sec, computes the verdict in the assembly block, adds `qa?` to `ChapterSegmentsFile`, persists `audioQa` on the success path, and carries `qa` on the `chapter_complete` broadcast.
- Frontend: `Chapter.audioQa` (carried via tick + hydrate); an amber "Suspect" badge (reason as tooltip) in the Generate row and Listen row, rendered only when `status === 'suspect'`.

## Invariants to preserve

1. **Advisory only** — the chapter still flips to `done`; no auto-regen, no done-gating.
2. Thresholds are conservative + tunable via env; the documented chars-per-second constant drives `expectedSec`.
3. Caveat (in code): in two-pass loudnorm mode `i`/`tp` are post-normalisation, so the **duration band** is the most robust signal; near-silent/clip detection is strongest when loudnorm is off.
4. The badge never renders for an `ok` verdict.

## Test plan

- **Automated:** `server/src/tts/audio-qa.test.ts` — one crafted case per validator: near-silent (`lufs -55` / `-Infinity`), clipped (`tp -0.05`), truncated (`dur 10, exp 60`), runaway (`dur 200, exp 60`), healthy (`-16 / -1.5 / dur≈exp` → ok, empty reasons), env-override. `src/views/generation.test.tsx` — `suspect` renders the badge, `ok` renders none.
- **Manual:** generate a chapter and confirm `audioQa` is persisted on `state.json`; craft a near-silent fixture and confirm the "Suspect" badge appears in both Generate and Listen rows.

## Ship notes

Shipped on `feat/server-generation-quality` (integration round 2026-06-03), commit `84a45ff`. Closes #465. Automated server + frontend coverage green via `npm run verify`. **Owed:** live acceptance with a deliberately degraded render.
