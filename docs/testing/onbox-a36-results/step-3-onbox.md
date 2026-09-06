# A36 step 2 — real on-box confirmation of the widened synthetic-only band

Parent: #2934 (A36 audition-band chain). Register row A36 ([#1969](https://github.com/dudarenok-maker/Castwright/issues/1969),
PR #2402, [#2700](https://github.com/dudarenok-maker/Castwright/issues/2700)) — discharged 2026-09-05. Owner ruling 2026-09-05.
Reproduces the exact false-positive scenario the 2026-08-29 on-box run found
(`docs/testing/onbox-acceptance-register.md`, row A36 — discharged 2026-09-05) against step 1's fix
(`server/src/audio/render-integrity/{aggregate,audition-centroid,score}.ts`,
commit c7a1dfac).

## Setup

Live Coqui/XTTS resident sidecar on this worktree's own isolated port
(`LOCAL_TTS_PORT=9120`, slot 12, `wt-2934-a36-audition-band`, branch
`fix/server-2934-a36-audition-band`) — no mocking, real network calls for
every render and embed.

A throwaway fixture (`mkdtemp`, never the operator's real book/workspace):
a synthetic character `wren` given only **2 in-book anchor vectors** — two
fabricated, mutually-orthogonal unit vectors, deliberately far from any real
speaker embedding, standing in for the register's own "too few, badly
clustered anchors" precondition (well below `AUDITION_POOL_TARGET_N=6`) —
assigned to the real catalogue voice **Claribel Dervla** on `coqui-xtts-v2`.
Six real evidence quotes were pulled from the committed fixture manuscript
`server/src/__fixtures__/the-coalfall-commission.md` (narration/dialogue
lines, 16–40 words each) and threaded through `cast.json`'s `evidence` field,
exactly as `buildHintFromCast`/`auditionCentroid` expect.

`scoreBook()` was called directly, unmocked, against this fixture (probe
script: a throwaway `tsx` script under `server/src/`, deleted after the run
and never committed — same precedent as the 2026-08-29 run). One transient
retry was needed: the first attempt hit `NoCapacityError` (3412 MB free vs.
3584 MB needed) because another lane's idle sidecar on this box was holding
cached VRAM on the same physical GPU; the retry succeeded once that
contention cleared.

## What happened — Phase B triggered for real

The 2 fabricated anchors were far enough from the 6 real XTTS renders
(embedded for real via `/embed`, ECAPA 192-d) to trip `buildCentroid`'s
bimodal check, exactly like the register's own 2026-08-29 finding:
`auditionCentroid` correctly ran Phase B (anchors dropped, synthetic-only
pool topped up/rebuilt to N=6). The persisted reference:

```
referenceKind: "audition"
cleanMean:     0.94425
pSevere:       0.89070
pBand:         0.91747
auditionVoice: { voiceName: "Claribel Dervla", modelKey: "coqui-xtts-v2", cloned: false }
```

`pSevere`/`pBand` sit far below the old percentile-of-pool edges (which the
2026-08-29 run measured at ~0.9409/0.9446, right at the sample minimum) —
confirming step 1's `syntheticOnlySpread()` sigma band, not the normal
percentile cutoffs, was the one actually used for this synthetic-only pool.

## Criterion 2 — correctly-cast voice, fresh text: no longer `severe` (MET)

Real XTTS render of the CORRECT voice (**Claribel Dervla**) against fresh
text never in the evidence pool ("*The note went out the door and up the
lane and over the roofs, even-handed, unhurried, the kind of sound that
doesn't ask permission.*"), embedded for real:

- **cosine = 0.90230**
- **verdict = `inconclusive`, severity = `inconclusive`** — NOT
  `voice-mismatch`/`severe`.

This is the exact false positive the 2026-08-29 run found (that run's
correct-voice renders scored 0.928/0.934 and were both wrongly flagged
`severe`). Here the same cosine range (0.902, just under the widened
`pBand=0.91747`) lands in the deliberately non-committal `inconclusive` tier
per step 1's calibration design — the false positive is gone.

## Criterion 3 — genuinely wrong voice, same text: still `severe` (MET)

Real XTTS render of a clearly different catalogue voice (**Damien Black**)
against the identical fresh text, embedded for real:

- **cosine = 0.16213**
- **verdict = `voice-mismatch`, severity = `severe`, fixable = true.**

Mismatch detection is intact — the widened band did not erase real drift
detection, only the synthetic-only false positive.

## Bonus confirmation — the fabricated anchors themselves

The run's `mismatchCount` was 3, not 1: alongside the wrong-voice render
above, both of `wren`'s original 2 fabricated anchor vectors also scored
`voice-mismatch`/`severe` against the rebuilt centroid (they are, by
construction, nowhere near the real voice's embedding space) — the same
"stale reference correctly discarded" shape the 2026-08-29 run confirmed for
criterion 1/2 of the original A34/A36 split, reproduced here incidentally.

## Verdict

**DISCHARGED.** Both of step 2's acceptance criteria are met on real
hardware, live sidecar, unmocked `scoreBook()`:

1. The correctly-cast voice, re-rendered on fresh text, is no longer
   false-flagged `voice-mismatch`/`severe` under the synthetic-only pool.
2. A genuinely different voice against the same pool is still correctly
   flagged `voice-mismatch`/`severe`.

No code was changed by this run (on-box confirmation only, per parent #2934
scope). The throwaway fixture, probe script, and mkdtemp workspace were not
committed and have been discarded; the operator's real book/workspace was
never touched.
