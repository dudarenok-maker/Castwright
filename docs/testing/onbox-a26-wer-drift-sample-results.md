# A26 invented-name WER-drift false-positive pass — larger sample, real hardware

Issue: Castwright#3131 (chain #3118 → #2960 → #2435 → #2055). Worktree
`C:\Claude\Projects\wt-3118-a26-wer-drift-sample`, branch
`docs/docs-3118-a26-wer-drift-sample`. Real hardware throughout — real
Coqui/XTTS + real Whisper, real production `classifyTranscript()`, same
technique as the prior 2-sample finding (`docs/testing/onbox-mechanical-batch2-results/step-3-content-correctness.md`,
row A26, "False-positive control").

## Setup

`server/.env` (this worktree, junctioned `.venv`/`voices` from the primary
checkout rather than reinstalling):

```
SEG_ASR_ENABLED=1
ASR_DEVICE=cuda:1
COQUI_DEVICE=cuda:1
PRELOAD_COQUI=0
```

GPU 1 (RTX 5070 Ti, 16 GB) was idle at the start (`nvidia-smi` ~200 MiB used
by desktop compositor only) and was pinned explicitly via `cuda:1` so as not
to disturb any other lane possibly using GPU 0 (RTX 4070 Laptop, 8 GB — also
idle at the time, left untouched). Sidecar version `1.14.0`. Sidecar and dev
server were started fresh in this worktree.

**Method:** drove the sidecar's raw `/synthesize` (`engine:"coqui"`,
`model:"xtts_v2"`, `voice:"Damien Black"`, `language:"ru"`) and `/transcribe`
endpoints directly (bypassing the app's book/cast/render pipeline), then fed
the REAL Whisper transcript + REAL signals (`avg_logprob`, `no_speech_prob`,
`compression_ratio`) into the REAL production `classifyTranscript()`
(`server/src/tts/segment-asr-qa.ts`, imported directly via `npx tsx`, not
mocked). No `nameAllowlist` entry was passed for any invented name, per the
issue's instruction to measure default behaviour. Throwaway probe script
`scripts/qa-3118-a26-sample-probe.mts`, deleted after this run — not part of
the test suite.

All 30 planned round trips (15 lines × 2 attempts) completed cleanly —
no transport errors, no sidecar crash, no reduction needed.

## Line-by-line results

### Invented-name, short (2–4 words) — 6 lines × 2 attempts = 12

| Line | Attempt | Transcript | WER | Verdict | Reason |
|---|---|---|---|---|---|
| Мастер Одуван кивнул. | 1 | Мастер Адуван кивнул понтарё. | 0.67 | drift | WER 0.67 exceeds 0.45 (1 sub, 0 del, 1 ins vs 3 words) |
| Мастер Одуван кивнул. | 2 | Мастер Адуван кивнул пандалу. | 0.67 | drift | WER 0.67 exceeds 0.45 (1 sub, 0 del, 1 ins vs 3 words) |
| Смородинка вздохнула тихо. | 1 | Смородинка вздохнула тихо. | 0.00 | ok | — |
| Смородинка вздохнула тихо. | 2 | Смородинка вздохнула тихо. | 0.00 | ok | — |
| Ветролом ушёл прочь. | 1 | Ветровом ушел прочь. | 0.67 | drift | WER 0.67 exceeds 0.45 (2 sub, 0 del, 0 ins vs 3 words) |
| Ветролом ушёл прочь. | 2 | Ветровом ушел прочь. | 0.67 | drift | WER 0.67 exceeds 0.45 (2 sub, 0 del, 0 ins vs 3 words) |
| Тихо сказал Бузимир. | 1 | Тихо сказал Бузимир. | 0.00 | ok | — |
| Тихо сказал Бузимир. | 2 | Тихо сказал Бузимир. | 0.00 | ok | — |
| Кошкодрёма моргнула сонно. | 1 | Кашкадрема моргнула сонно. | 0.33 | ok | — |
| Кошкодрёма моргнула сонно. | 2 | Кашкадрема моргнула сонно. | 0.33 | ok | — |
| Позвал старый Дубонрав. | 1 | Позвал старый Дубан Раф в Пентихи. | 1.33 | drift | WER 1.33 exceeds 0.45 (1 sub, 0 del, 3 ins vs 3 words) |
| Позвал старый Дубонрав. | 2 | Позвал старый Дубан Раф. | 0.67 | drift | WER 0.67 exceeds 0.45 (1 sub, 0 del, 1 ins vs 3 words) |

**Subtotal: 6/12 drift (50%).**

### Invented-name, longer (6+ words) — 4 lines × 2 attempts = 8

| Line | Attempt | Transcript | WER | Verdict | Reason |
|---|---|---|---|---|---|
| Одуван медленно поднял голову и посмотрел на дорогу. | 1 | Адуван медленно поднял голову и посмотрел на дорогу Поньта. | 0.29 | ok | — |
| Одуван медленно поднял голову и посмотрел на дорогу. | 2 | Адуван медленно поднял голову и посмотрел на дорогу. | 0.14 | ok | — |
| Смородинка вышла на крыльцо и позвала соседей ужинать. | 1 | Смародинка вышла на крыльцо и позвала соседей ужинать. | 0.14 | ok | — |
| Смородинка вышла на крыльцо и позвала соседей ужинать. | 2 | Смородинка вышла на крыльцо и позвала соседей ужинать. | 0.00 | ok | — |
| Старик Ветролом сидел у костра и рассказывал старую историю. | 1 | Старик ветровым сидел у костра и рассказывал старую историю. Потто. | 0.29 | ok | — |
| Старик Ветролом сидел у костра и рассказывал старую историю. | 2 | Старик ветровом сидел у костра и рассказывал старую историю Понта. | 0.29 | ok | — |
| Бузимир быстро собрал вещи и вышел на холодную улицу. | 1 | Бузимир быстро собрал вещи и вышел на холодную улицу. | 0.00 | ok | — |
| Бузимир быстро собрал вещи и вышел на холодную улицу. | 2 | Бузимер быстро собрал вещи и вышел на холодную улицу. | 0.13 | ok | — |

**Subtotal: 0/8 drift (0%).**

### Control, no invented names — 5 lines × 2 attempts = 10 (same-session baseline)

| Line | Attempt | Transcript | WER | Verdict | Reason |
|---|---|---|---|---|---|
| Мальчик кивнул тихо. | 1 | Мальчик кивнул тихо. | 0.00 | ok | — |
| Мальчик кивнул тихо. | 2 | Мальчик кивнул тихо. | 0.00 | ok | — |
| Дождь идёт весь день. | 1 | Дождь идет весь день. Пойдем. | 0.50 | drift | WER 0.50 exceeds 0.45 (1 sub, 0 del, 1 ins vs 4 words) |
| Дождь идёт весь день. | 2 | Дождь идет весь день демми по. | 0.75 | drift | WER 0.75 exceeds 0.45 (1 sub, 0 del, 2 ins vs 4 words) |
| Она вышла на крыльцо и позвала соседей ужинать. | 1 | Она вышла на крыльцо и позвала соседей ужинать. | 0.00 | ok | — |
| Она вышла на крыльцо и позвала соседей ужинать. | 2 | Она вышла на крыльцо и позвала соседей ужинать. | 0.00 | ok | — |
| Старик сидел у костра и рассказывал старую историю. | 1 | Старик сидел у костра и рассказывал старую историю тона. | 0.17 | ok | — |
| Старик сидел у костра и рассказывал старую историю. | 2 | Старик сидел у костра и рассказывал старую историю. Тон. | 0.17 | ok | — |
| Он быстро собрал вещи и вышел на холодную улицу. | 1 | Он быстро собрал вещи и вышел на холодную улицу. | 0.00 | ok | — |
| Он быстро собрал вещи и вышел на холодную улицу. | 2 | Он быстро собрал вещи и вышел на холодную улицу. | 0.00 | ok | — |

**Subtotal: 2/10 drift (20%).**

## Summary — drift rate comparison

| Group | Attempts | Drift | Rate |
|---|---|---|---|
| Invented-name, short (2–4 words) | 12 | 6 | 50% |
| Invented-name, longer (6+ words) | 8 | 0 | 0% |
| **Invented-name, combined** | **20** | **6** | **30%** |
| Control (same-session baseline) | 10 | 2 | 20% |

**Observation 1 — the drift is concentrated entirely in short (2–4 word)
lines, both invented-name and control.** Every drift in the invented-name
group came from the short subgroup (6/6); the longer invented-name subgroup
had zero drift across 8 attempts, actually *below* the control rate. This
matches the register row's own "short-reference fragility" caveat: on a
3-word reference, a single substitution or one inserted hallucinated word is
33–133% of the line, so WER swings past the 0.45 threshold on almost any
imperfect transcription, name-related or not.

**Observation 2 — the control group is not clean either.** One control line
(`Дождь идёт весь день.`, 4 words, no invented name) drifted on both
attempts, both times from Whisper appending a short hallucinated tail word
after the sentence-final period (`"Пойдем."`, `"демми по."`) rather than
mistranscribing any real content — a known short-utterance ASR continuation
artifact, not a name-specific effect. This is the same failure signature
(fluent nonsense appended past the true utterance boundary on a short
synth) noted for unrelated lines in the prior batch-2 results file.

**Observation 3 — combined invented-name rate (30%) vs. control rate (20%)
is a 10-point gap, not a dramatic one, and it does not survive controlling
for line length.** Comparing short-to-short: this sample only has one short
control line (`Мальчик кивнул тихо.`, 0/2 drift) vs. six short invented-name
lines (6/12 drift), so the short-vs-short comparison itself is underpowered
here — but at the length-matched level available, the mechanism producing
drift (short-line WER fragility from any mistranscription) is the same one
firing on the control line, not something exclusive to invented names.

**Net read:** this sample does not show invented names causing a materially
higher false-positive rate than ordinary short lines suffer from already.
The original 2-sample finding (2/2 drift on one short invented-name line) was
real but consistent with generic short-reference WER fragility rather than a
name-specific #2055-override regression — the longer invented-name lines,
which are the more realistic case for actual book content (most character
name mentions sit inside full sentences, not 2–3-word fragments), showed no
drift at all in this sample. No incidents, no reduced sample — the full
20/10 split was completed as specified.

## Cleanup

Throwaway probe script `scripts/qa-3118-a26-sample-probe.mts` deleted after
this run — not part of the test suite. `server/tts-sidecar/.venv` and
`server/tts-sidecar/voices` are directory junctions to the primary checkout
(created for this run to avoid a full reinstall) — junctions, not real
directories, so no additional disk usage and safe to leave. No source file
under `server/src/**` modified. `docs/testing/onbox-acceptance-register.md`
not touched — left for the verify/decision child.

## Run by

claude, 2026-09-10 (scheduler heartbeat, issue #3131).
