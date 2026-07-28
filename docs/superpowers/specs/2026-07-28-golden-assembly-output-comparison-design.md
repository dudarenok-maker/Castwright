# golden-assembly output comparison — design

**Date:** 2026-07-28
**Issue:** [ops-36 / #1880](https://github.com/dudarenok-maker/Castwright/issues/1880)
**Status:** approved — ready for `writing-plans`
**Revision:** 3. Revision 1 was falsified by an adversarial pass (three of four
"measured" findings taken through a hand-rolled ffmpeg call). Revision 2 was reviewed by
two independent adversarial passes — one empirical, one design — which confirmed those
fixes but found two Criticals in the *hardening*. See "Review history".
**Regression plan:** [`docs/features/272-golden-assembly-comparison.md`](../../features/272-golden-assembly-comparison.md)
**Related:** [`269-ffmpeg-version-floor.md`](../../features/269-ffmpeg-version-floor.md)
(ops-35 / [#1877](https://github.com/dudarenok-maker/Castwright/issues/1877) — this is
its deferred half),
[`archive/185-golden-audio-regression.md`](../../features/archive/185-golden-audio-regression.md)
(ops-11 — the harness this extends)

## Problem

The golden-audio **assembly tier** (Suite B, `npm run test:golden-audio:assembly`) is
described as feeding a committed PCM fixture through the real `synthesiseChapter` +
ffmpeg loudnorm. It does — and then compares the result to nothing.

`server/src/tts/golden-assembly.golden.test.ts` asserts segment count, `sampleRate`,
per-segment `startSec`/`endSec`, and `result.pcm.length` — every one of them **computed
from the input fixture's own byte lengths**, so they restate the input rather than
measure the output. Beyond that it checks file existence for the `.mp3` and
`.segments.json`, and a **20-LU-wide** loudness band (`-30 < i < -10`, `:213-214`).

No assertion touches the produced audio. An ffmpeg upgrade that shifted loudnorm by
2 LU, changed LAME framing, or altered the MP3 byte stream passes silently. This is the
only place in the repo that runs real audio through the real encoder, and it cannot
currently fail for an audio reason.

ops-35 shipped the ffmpeg version floor and asked whether this suite should record the
ffmpeg version its baseline was produced with. It deliberately did not, because the
premise didn't hold: a version stamp on a tolerance-band assertion implies a comparison
the test does not make. This spec is the honest remainder.

## Review history

Recorded because the failure mode repeated, and the repeat is the lesson.

**Revision 1 → 2.** The findings section opened *"All four were measured on this box,
not assumed."* They were measured on an artifact production never emits: the probe used
`-b:a 128k` CBR and **omitted the output `-ar` pin** (the plan-71 / ffmpeg-8 fix at
`mp3.ts:161-166`), yielding a **48 kHz** MP3 exhibiting the exact resample leak
`buildMp3FfmpegArgs` exists to prevent. Three defects followed: a wrong committed
`mp3Md5`; a **false** decode-round-trip claim that would have shipped L3 born red; and
tolerances calibrated against nothing. A fourth was independent — L2 pinned
`normalization_type`, which is parsed and then discarded, never written to disk.

**Revision 2 → 3.** An empirical pass re-derived every number through the production
path and **confirmed the fixes**, including the highest-risk one:
`finalizeChapterAudioWrite` writes a byte-identical file to `encodePcmToAudio`
(`Buffer.compare === 0`), stable across fresh processes, so the committed md5 is
correct. But it found the revision-1 error class recurring in miniature — two rows of
the calibration curve were measured **without the skip rule the design itself
mandates** (finding 6). A parallel design pass found two Criticals in the new
machinery: the `twoPass === true` gate introduced to fix revision 1's L2 defect is
itself unsound (finding 5), and the first bless is impossible as specified (§4).

**The durable lesson, twice earned:** measure through the production call path, and
measure with the *same rule the design will apply*. An adjacent artifact or an adjacent
metric produces numbers that look like evidence and are not.

## Findings

ffmpeg `8.1.1-full_build-www.gyan.dev`; fixture
`server/src/tts/__fixtures__/golden-chapter.pcm` (274 432 bytes, 24 kHz mono s16le,
137 216 samples, 5.7173 s — `ffprobe` `duration=5.717333`). Every number independently
reproduced by a second party.

**1. The encoded MP3 is byte-identical across repeat runs, processes, and call paths.**
`encodePcmToAudio` → `55749` bytes, md5 `d7d6d0aa41ca947da5465dfd289f0f15`.
**`finalizeChapterAudioWrite` writes a byte-identical file** — it calls
`encodePcmToAudio(pcm, sr, {format:'mp3', quality: 2, loudnorm: resolveLoudnormOptions()})`
and writes the returned buffer verbatim, adding no metadata (`Buffer.compare === 0`).
Stable across two separate fresh processes. `synthesiseChapter`'s output PCM is also
byte-identical to the raw fixture, so measuring the first pass against the raw fixture
is legitimate. No ID3 timestamp, no `creation_time`, no temp path, no cover art; the
only version-bearing bytes are `TSSE=Lavf62.12.101` and the `Lavc62.28` LAME tag, both
build-constant. **The MD5 tight path is viable.**

**2. The decode round-trip is length-preserving only from a SEEKABLE input.**

```
decode the real mp3 from a FILE   ->  274 432 B   == input, exactly
decode the real mp3 from a PIPE   ->  275 422 B   +495 samples of untrimmed padding
```

`decodeAudioToPcm` (`mp3.ts:501-516`) feeds the buffer on `pipe:0`; on a non-seekable
input ffmpeg does **not** apply the LAME tag's end-padding trim. The extra samples are a
pure trailing append (the pipe decode contains the file decode as an exact lag-0
prefix). This design therefore decodes **from the written file** — see §1 L3 and §8.

File-decode length is `274 432` at `-q:a` 0/2/3/5/9 (mp3 sizes 70269 / 55749 / 52389 /
40437 / 23997) and under every perturbation in finding 6 — all 14 rows had length delta
0. **137 216 samples = 57 full 100 ms windows + a 416-sample tail**, dropped identically
on both sides.

**3. The first-pass loudnorm measurement is bit-stable.** Five consecutive
`runLoudnormFirstPass` calls → one distinct result: `input_i -21.70`, `input_lra 3.00`,
`input_tp -4.15`, `input_thresh -31.75`, `target_offset 1.17`.

Revision 1 extended this into *"EBU R128 is spec-defined and stable within a version
line"* and used it to justify hard cross-build assertions. **That extension is
withdrawn** — it was unevidenced. BS.1770 defines an *algorithm*; L1 pins ffmpeg's
`loudnorm` implementation output, including an oversampled true-peak estimate whose
filter is implementation-defined. Cross-build behaviour is **unmeasured** (see §5).

**4. `linear=true` does not hold on this fixture — loudnorm falls back to `dynamic`.**
The fixture's true peak is `-4.15` dBTP, so the +5.70 dB needed to reach `-16` LUFS
would land at `+1.55` dBTP, past the `-1.5` ceiling. ffmpeg reports
`normalization_type: "dynamic"` and compresses **LRA 3.00 → 0.50**; `output_i` lands at
**`-16.28`**, not `-16.00`. So the persisted `lufs.i` does *not* converge on target by
construction, and pinning it is worth more than first estimated.

**5. `normalization_type` is parsed then discarded — and `twoPass: true` does NOT imply
a mode is present.** `LoudnormSidecarJson` (`loudnorm.ts:73-86`) is
`{i, lra, tp, target, twoPass, measuredAt}`. `mp3.ts:440` parses the mode; `:442-449`
drops it.

Revision 2's fix — "L2 asserts the mode only when `twoPass === true`" — is **unsound**.
The provisional sidecar is stamped `twoPass: true` at `mp3.ts:296-304` **before the
encode**, and is replaced only when the second-pass stderr JSON exists, parses, and is
finite. Three fallback branches leave it untouched, all with pinned tests in
`mp3-spawn-args.test.ts`:

| branch | site | sidecar |
|---|---|---|
| no JSON block in stderr | `mp3.ts:466` | `twoPass: true`, `i` = **input** side, no mode |
| parse throw | `mp3.ts:457` | same |
| non-finite `output_i` | `mp3.ts:450` | same |
| unusable first pass (silent input) | `mp3.ts:305-312` | **no sidecar written at all** |

Independently corroborated on disk: **`scripts/relufs-existing.mjs:235` is a second
writer** of `.lufs.json` and also emits `twoPass: true` with structurally no mode
(`ebur128` has none). Resolution in §2.

**6. RMS-error between decoded MP3s is dominated by codec noise, not audio content.**
Every row through the production path, **with the envelope column computed under L3's
own skip rule** (windows below -50 dBFS excluded — revision 2 reported two of these rows
without it, and both happened to be window 35, the -67.1 dBFS window L3 skips):

| perturbation | RMS-error | worst envelope window *(skip rule applied)* |
|---|---|---|
| identical re-encode | 0.00 % | 0.0 % |
| input gain +0.5 dB | 0.41 % | 0.3 % (w17) |
| **encoder quality 2 → 3 (inaudible)** | **8.08 %** | **1.6 % (w49)** |
| **encoder quality 2 → 4** | **10.55 %** | **2.0 %** |
| loudnorm drift 0.1 LU | 4.80 % | 4.0 % |
| loudnorm drift 0.5 LU | 8.78 % | 8.5 % |
| loudnorm drift 0.75 LU | 11.07 % | 12.7 % |
| loudnorm drift 1.0 LU | 13.01 % | — |
| loudnorm drift 1.5 LU | 19.23 % | — |
| **loudnorm drift 2.0 LU** (the issue's own case) | **24.79 %** | **38.7 %** |
| loudnorm drift 3.0 LU | 34.74 % | 61.6 % |
| middle segment silenced | 72.56 % | 100.0 % |

Three consequences, all of which shape §1:

- **Input gain is a useless calibration perturbation** — two-pass loudnorm normalises it
  away by construction (+0.5 dB in → 0.41 % out).
- **A 0.1 LU drift (4.80 %) sits below the codec-noise floor (8.08–10.55 %).** RMS-error
  cannot separate sub-0.5-LU drift from an encoder change. L1 covers that range at
  ±0.1 LU, forty times finer.
- **RMS-error is a low-dynamic-range instrument.** Its noise floor (10.55 %) and its
  target signal (24.79 %) are only **2.35× apart**. No threshold has comfortable margins
  on both sides — see §1's derivation.

**7. The envelope's quiet windows cannot carry a relative tolerance.** 57 windows
spanning 56.1 dB; median RMS `0.1349`; minimum `4.422e-4` (**-67.1 dBFS**) at window 35.
At that window ±3 % is **0.435 LSB** at int16 — narrower than one quantisation step.
Exactly **2** windows sit below -50 dBFS (w35 at -67.1, w56 at -66.6); the third-quietest
is w16 at **-44.7 dBFS, 5.3 dB of headroom**, and the count stays exactly 2 under every
perturbation tested (at 2.0 LU drift w16 moves only to -41.9 dB).
`quietWindowsSkipped === 2` is therefore a safe hard assertion, not a latent flake.

## Goals

- Make the assembly golden tier able to fail for an audio reason.
- Keep it GPU-free, opt-in, and outside `test:all` / `verify` (ops-11 / plan 185).
- **Discriminate causes in the failure message** — "ffmpeg drifted", "someone moved a
  loudnorm knob", and "ffmpeg's log format changed so the second-pass JSON went
  unparsed" are three different bugs that must not present identically.
- Record the ffmpeg provenance of the baseline and report a mismatch as information.

## Non-goals

- Byte-exact MP3 comparison **across** ffmpeg builds.
- Raising the ffmpeg floor (ops-35 set it at 6.0).
- Fixing the `linear` → `dynamic` fallback (finding 4).
- Changing what `loudnorm.ts` **parses**. Widening what it *persists* is in scope: the
  parser already extracts `normalization_type` correctly, and this design changes only
  whether that already-parsed value survives to disk.

## Design

### 1. Four comparison layers

Four independent assertions over one pipeline run. There is deliberately **no
arbitration** between them; which combination fails is itself diagnostic.

| # | Pins | Source | Tolerance | Catches |
|---|---|---|---|---|
| **L1** | `input_i`, `input_lra`, `input_tp`, `input_thresh` | `runLoudnormFirstPass` on the raw fixture | ±0.1 LU/dB | ffmpeg's EBU R128 **measurement** changing (finding 3). |
| **L2** | `i`, `lra`, `normalizationType` | the written `.lufs.json` | ±0.3 LU; mode **exact**, absence gets its own message | ffmpeg's **gain application** changing, a `dynamic` → `linear` flip, **and** a second-pass-JSON parse failure (finding 5). |
| **L3** | decoded byte count + per-100 ms RMS envelope | `.mp3` decoded **from the written file** | count **exact** (finding 2); envelope ±10 %, windows below -50 dBFS on **either** side skipped, union count asserted `=== 2` | timing/duration shifts, resampler changes, and **where** a change is located. |
| **L4** | the encoded `.mp3` | file bytes | **tight:** MD5 equality · **loose:** RMS-error < 16 % | anything at all on a matched build; gross drift and catastrophe on a mismatched one. |

**Tolerances derived from finding 6, not picked:**

- **L3 envelope ±10 %.** Noise floor under the skip rule is 1.6–2.0 %; the threshold
  fires at **≈0.6 LU** of drift. Separation from noise ≈ **5–6×**. Well-founded.
- **L4-loose 16 %.** Noise floor 10.55 %, target signal 24.79 % — only 2.35× apart, so
  no threshold has comfortable margins. 16 % is the **geometric mean**
  (√(10.55 × 24.79) = 16.17), giving a balanced 1.52× below / 1.55× above. It fires at
  ≈1.2 LU.
- **L4-loose is the weakest layer and is labelled as such.** It exists for the
  cross-build path, where a different LAME is precisely what has not been measured; its
  calibration rests on `-q:a` steps as a proxy. If any layer produces a false red on a
  second build, it is this one. **L3's envelope is the sound LOOSE instrument**;
  L4-loose is a catastrophe-and-gross-drift backstop.
- **A characterised gap band:** 0.6–1.2 LU of drift trips L3 but not L4-loose (e.g.
  0.75 LU → 12.7 % envelope, 11.07 % rmse). Harmless under "no arbitration", but named
  so the failure-combination diagnostic has no unlabelled regime.
- **L2 drops `tp`.** `output_tp = -1.50` is the configured ceiling loudnorm clamps to;
  pinning it asserts almost nothing. `lra` is the field that moves under a mode flip
  (0.50 → ~3.00), and `i` is non-tautological per finding 4.

**L3 decodes from the written file** (finding 2). The tier pins the *audio*; pipe-mode
padding is an incidental decoder behaviour. Cost: the tier no longer exercises
`decodeAudioToPcm` — accepted, since pinning that helper was never its purpose.

**L3 and L4-loose are LOOSE-path instruments.** On TIGHT, an MD5 match means the decoded
PCM is bit-identical, so both are exactly zero and vacuous. (L4-**tight** is the
strongest assertion in the design — "vacuous on TIGHT" applies to L4-loose only.) This
is why one tolerance set, sized for cross-build, suffices. When MD5 *differs* on the
TIGHT path, L3 and L4-loose run with cross-build-sized tolerances looser than a
same-build comparison warrants; the design accepts that rather than carrying a second
tolerance set, because a TIGHT-path MD5 mismatch is already a hard failure.

**What earns L4 alongside L3:** envelope RMS is blind to sign and to within-window
structure. A phase inversion leaves every envelope window identical while RMS-error goes
to 200 %; a single click is averaged away by a 2400-sample window. L4 says *whether*, L3
says *where*.

### 2. L2, the sidecar mode, and the `twoPass` trap

Finding 5 kills the `twoPass === true` gate. The replacement:

**L2 asserts `normalizationType === 'dynamic'` unconditionally, and gives absence its
own diagnosis.** Absence is not "the mode flipped" — it means the second-pass JSON was
never parsed, i.e. ffmpeg changed its loudnorm log format. That is a *different bug*, and
telling the two apart is exactly the discrimination §Goals promises:

```
L2 sidecar: normalizationType is absent (baseline "dynamic")
  This is NOT a mode flip. The sidecar fell back to the input-side
  measurement, which means the second-pass loudnorm stderr JSON was not
  parsed — most likely an ffmpeg log-format change. Check `i`: it will
  read ~-21.70 (input side) rather than ~-16.28 (output side).
  run: ffmpeg 9.0  |  baseline: ffmpeg 8.1  |  mode: LOOSE
```

The compounding case is handled by the same message: on a fallback `i` is the input-side
`-21.70`, so L2's ±0.3 band fires too — and the message pre-empts the misread by naming
the expected value.

`mp3.ts` is **not** changed to stamp a mode in the fallback branches: there is no mode to
stamp. The fallback is **not** changed to flip `twoPass` to `false` either — that would
be a behaviour change with its own blast radius across `loudness-report.tsx`'s drift
gating, and it is out of scope.

**The silent-input path writes no sidecar at all** (`mp3.ts:305-312`). L2 therefore
asserts the sidecar file exists before reading it, with its own message.

**Surfaces the widening touches** — enumerated, corrected, and verified:

| Surface | Change |
|---|---|
| `server/src/tts/loudnorm.ts:73` | add `normalizationType?: 'linear' \| 'dynamic'` to `LoudnormSidecarJson` |
| `server/src/tts/mp3.ts:442-449` | carry the already-parsed mode into `pendingSidecar` (success branch only) |
| `openapi.yaml:5254` | add the field to `ChapterLoudness` — **not** to its `required:` list at `:5256` |
| `src/lib/api-types.ts` | regenerate via `npm run openapi:types` |

Two rows revision 2 listed are **removed as wrong**: `src/lib/types.ts:56` is
`export type ChapterLoudness = components['schemas']['ChapterLoudness']` — a re-export of
the generated type needing zero change (hand-editing it would violate the "OpenAPI is the
type source of truth" convention); and the two route readers (`book-state.ts:396-400`,
`chapter-audio.ts:83`) duck-type on `i`/`target` and already tolerate absence.

**Verified safe:** no zod or schema validation of the sidecar exists anywhere; the schema
has no `additionalProperties: false`; no test asserts the encoder-produced sidecar's exact
key set; `src/lib/api.ts:889-908`'s mock builder stays valid under an optional field and
`src/mocks/canned-data.ts` carries no lufs at all; and `npx openapi-typescript
./openapi.yaml` reproduces `src/lib/api-types.ts` **byte-for-byte** today, so the
regeneration diff is scoped to `ChapterLoudness` alone.

**A known second writer stays as-is:** `scripts/relufs-existing.mjs:235` writes
`twoPass: true` with no mode because `ebur128` has none. That is correct and the field is
optional; it is named here so the "absence means a parse failure" diagnosis is understood
to apply *to the encoder's sidecars*, not to relufs-produced ones.

**Adjacent defect in the schema being edited:** `openapi.yaml:5266-5269` documents `i` as
*"In two-pass mode this is the FIRST-pass measurement of the source PCM."* That
contradicts `loudnorm.ts:66-70` and reality — measured `i` is `-16.28`
(post-normalisation); the first pass read `-21.70`. Since this PR edits that exact block,
the wrong sentence is corrected in the same diff.

### 3. Baseline artifacts

```
golden-chapter.pcm            274 432 B  input fixture              (exists)
golden-chapter.json               505 B  segment meta               (exists)
golden-chapter.baseline.json    ~2 KB    L1/L2/L3 + MD5 + provenance   NEW
golden-chapter.decoded.pcm    274 432 B  L4-loose reference            NEW
```

Every literal is **measured**, except the one marked `«bless»`:

```jsonc
{
  "recordedAt": "2026-07-28",
  "ffmpegBanner": "ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026 …",
  "ffmpegVersion": "8.1",
  "encode":    { "format": "mp3", "quality": 2, "sampleRate": 24000, "writeXing": true },
  "loudnorm":  { "target": -16, "lra": 11, "tp": -1.5 },
  "firstPass": { "input_i": -21.70, "input_lra": 3.00, "input_tp": -4.15, "input_thresh": -31.75 },
  "sidecar":   { "i": -16.28, "lra": 0.50, "normalizationType": "dynamic" },
  "decoded":   { "bytes": 274432, "quietWindowsSkipped": 2 },
  "envelope100ms": [ /* «bless» — 57 floats */ ],
  "mp3Md5": "d7d6d0aa41ca947da5465dfd289f0f15"
}
```

The `loudnorm` block separates *"ffmpeg changed"* from *"someone moved
`audio.loudnorm.targetLufs`"* — and L2 asserts it, so the two cannot be confused.

The `encode` block is **provenance only, not an assertion.** Revision 1's own failure
proves a changed encode parameter produces a completely different artifact, but
`finalizeChapterAudioWrite` hardcodes `-q:a` internally, so the test cannot observe it
and comparing a recorded literal against another recorded literal would prove nothing.
What actually guards a changed encode parameter is **L4-tight's md5**, which any `-q:a`
change moves. The block is recorded so a human reading a failure knows what the baseline
was taken under.

### 4. Bless ordering (and why the first bless must not hard-fail)

Revision 2 said *"a missing baseline is a hard failure"* **and** that bless writes the
artifacts — with no ordering. Since both artifacts are NEW, a literal implementation
hard-fails on the first bless, naming the bless command that just failed. Ordering, now
explicit:

```
if (GOLDEN_BLESS) {
  // do NOT load the baseline; do NOT assert any layer.
  run the pipeline, write both artifacts, print what was written, exit 0
} else {
  // baseline load is mandatory
  missing baseline -> HARD FAIL naming the bless command
  run the pipeline, assert L1..L4
}
```

**Each `it` block early-returns under bless.** The alternative reading — bless writes in
`beforeAll` while the `it` blocks still run — would compare the run against a baseline
derived from *that same run* and pass **vacuously**: green, exit 0, nothing verified.
That reading is rejected explicitly, because an accidental bless would otherwise produce
a meaningless green whose only mitigation is the `git status` diff.

**A missing baseline on the asserting path stays a hard failure** — both artifacts are
committed, so absence means someone deleted a file, and skipping would recreate the
silent-pass problem this issue exists to close.

### 5. The version gate

`FfmpegProbe` (`diagnostics/ffmpeg.ts:29`) exposes only the parsed `MAJOR.MINOR`; the raw
banner is captured by the module-private `present()` at `:84` and discarded. Two different
`8.1` builds — Gyan on Windows, distro on Ubuntu, different LAME — would claim a match and
then fail a tight comparison.

**Add one named export**, `ffmpegBannerLine(): string | null`, returning the first line of
`ffmpeg -version`. Deliberately **not** a change to `FfmpegProbe`: that shape crosses into
`routes/diagnostics.ts`, `routes/setup-readiness.ts` and the hand-mirrored `BlockerCause`
in `src/lib/api.ts`. It **spawns afresh** — the probe is deliberately uncached (`:93-98`),
so there is no captured stdout to reuse. Its paired test goes in the existing
`diagnostics/ffmpeg.test.ts`.

```
banner === baseline.ffmpegBanner   →  TIGHT   L4 asserts MD5 equality
otherwise                          →  LOOSE   L4 asserts rmse < 16 %
                                              + console.warn naming both versions
```

**L1–L3 remain hard on both paths**, per the approved design — and this is an **unproven
bet**, stated as one. Cross-build stability of ffmpeg's loudnorm output is unmeasured: one
box, one build. The bet is that a different build of the same version lands inside ±0.1,
and that a different *version* moving `input_i` is the news ops-36 exists to deliver.
**The first cross-machine run settles it** — that run is an owed on-box acceptance
(§Documentation). If the bet loses, the fix is to tolerance-gate L1–L3 on the LOOSE path
exactly as L4 already is.

The comparison module truncates to `min(len)` before computing RMS-error so the math
cannot NaN on unequal lengths, and asserts the length delta separately. Note this is *not*
what gives L4 independence from L3 — separate `it` blocks are (§8).

### 6. Failure reporting

An opt-in tier that fails once a year is read cold, and `toBeCloseTo`'s diff is useless for
a 57-float array. Every layer's message carries baseline, actual, delta, tolerance, both
ffmpeg versions, the tight/loose mode, and the bless command:

```
L1 first-pass drift: input_i -22.10 (baseline -21.70, delta -0.40 LU, tol 0.10)
  run: ffmpeg 9.0  |  baseline: ffmpeg 8.1  |  mode: LOOSE
  If intended, re-bless: npm run test:golden-audio -- --assembly-only --bless
```

L3 reports the **worst window and its timestamp** (`12.4 % @ w35, t=3.5s`), not both
arrays.

### 7. Bless flow

`--bless` becomes **suite-scoped**, composing with the flags already in
`scripts/run-golden-audio.mjs`:

```
npm run test:golden-audio -- --bless                    both suites
npm run test:golden-audio -- --assembly-only --bless    Suite B only
npm run test:golden-audio -- --sidecar-only  --bless    Suite A only  (today's behaviour)
```

**Plumbing is verified clean and the change is one line.** `run-golden-audio.mjs:46-50`
spawns with `env: { ...process.env, ...env }`; `server/vitest.config.golden.ts` declares no
`env`/`define`; its only setup file `server/src/test-setup.ts` sets exactly one variable
(`USER_SETTINGS_FILE`, with `??=`); `pool: 'forks'` inherits `process.env`. The work is
adding `{ env: bless ? { GOLDEN_BLESS: '1' } : {} }` to the Suite B `run(…)` at `:63`,
which today passes no env object.

Today `--assembly-only --bless` is a no-op **for bless only** — Suite B still runs and
asserts normally.

**Unresolved at plan level, with a constraint:** `npm run test:golden-audio:assembly`
calls `npm --prefix server run test:golden` directly (root `package.json:65`), bypassing
the runner, so that alias can never bless. Either route it through the runner or document
the full-runner form as the bless path. **Whichever is chosen must keep the alias working
as a plain assert-only invocation**, because the owed on-box acceptance row prescribes
running exactly that alias against a second ffmpeg build.

### 8. Code layout

**New pure module** `server/src/tts/golden-baseline.ts` — the `AssemblyBaseline` type,
tolerance constants, and the comparison math: `rmsEnvelope`, `pcmRms`, `rmsError`,
`compareEnvelope`, `md5`. No ffmpeg, no I/O.

**`correlation` is not included.** Revision 2 justified dropping it by citing a single row
where `corr > 0.995` passed the encoder change — but that row shows correlation *agreeing*
with L3 and L4-loose, which is correct behaviour, not uselessness. The honest reason is
simplicity: one fewer statistic to explain and calibrate, and RMS-error already separates
the 2 LU case. Stated as a design call, not as a measurement. (For the record: encoder
quality 2→3 gives Pearson **0.9967** over samples and 0.9999 over envelope windows —
revision 2's "0.9979" was wrong in both readings.)

**A file decode helper does not exist and must be written.** `decodeAudioToPcm` is
hardcoded to `'-i', 'pipe:0'` and takes a `Buffer`; nothing in `server/src` decodes audio
from a path. **Decision: add `decodeAudioFileToPcm(path, sampleRate)` to `mp3.ts`** beside
its pipe sibling, with a paired case in the existing `mp3.test.ts`. The alternative — a
test-local helper in the golden file — was rejected because it puts the decode path
outside any continuously-running suite, which is the same argument this section uses to
justify `golden-baseline.test.ts`. This is production code added for a test; it is ~15
lines mirroring an existing function, and it is counted in the file inventory rather than
smuggled in.

**`golden-baseline.test.ts`** is *not* named `*.golden.test.ts`, so it runs in the ordinary
`test:server` tier (`server/vitest.config.ts` excludes precisely `src/**/*.golden.test.ts`).
The golden tier is opt-in and may go a year between runs, so its comparison math must be
proven by a suite that runs continuously. Tests drive known signals: silence, full-scale, a
gain-scaled copy, a **phase-inverted copy** (envelope identical, RMS-error 200 % — the case
that justifies L4's existence), a sample-shifted copy, and an envelope containing a
sub--50 dBFS window to pin the skip rule. TIGHT/LOOSE branch selection is unit-tested with
synthetic banner strings, since a real second ffmpeg build is not available in CI.

**`golden-assembly.golden.test.ts`** gains a `beforeAll` that runs the pipeline once —
first pass, synth, finalize, decode — into a module-scoped artifacts object, with the
tempdir workspace moving from test 2's `try`/`finally` to `beforeAll`/`afterAll`. The `it`
blocks become thin assertions over it.

Three accuracy notes:

- **Separate `it` blocks are what give the layers independence.** A failing `expect` in one
  Vitest `it` does not abort a sibling. But a **`beforeAll` throw** (ffmpeg absent, spawn
  failure, decode error) fails all four at once, and §1's "which combination fails is
  diagnostic" collapses to one opaque hook error. The hook therefore wraps its failures
  with a message saying the pipeline itself did not complete, so a hook error is never
  misread as a layer verdict.
- **Timeout budget changes.** `vitest.config.golden.ts` sets `hookTimeout: 30_000`; today's
  test 2 makes **2** ffmpeg spawns under `testTimeout`, and the redesign moves **4** (raw
  first pass, finalize's internal first pass, encode, decode) into that one hook on
  `maxWorkers: 1`. Ample for 5.7 s of audio, but it is a real budget change and the plan
  confirms rather than assumes it.
- **The `WORKSPACE_DIR` env-set being relocated is already inert.**
  `workspace/paths.ts:35-39` computes `WORKSPACE_ROOT` at module-eval time, and the golden
  test statically imports `synthesise-chapter.js` → `paths.js`, so the module is evaluated
  before the assignment runs and the dynamic `import()` returns the cached module
  (`WORKSPACE_SOURCE` reads `default`, not `env`). The test is not workspace-isolated today
  and never has been; it is harmless only because `finalizeChapterAudioWrite` takes an
  explicit `bookDir`. The plan deletes the inert env-set + dynamic-import pair rather than
  silently relocating it and implying it works.

## Testing

- `golden-baseline.test.ts` and the `mp3.test.ts` / `diagnostics/ffmpeg.test.ts` additions
  run in `test:server` — they gate every push.
- `npm run test:golden-audio:assembly` green locally.
- **The deliverable is a demonstration, not a green run.** Passing is what the suite
  already does. The PR body records **one perturbation per layer**:

  | layer | perturbation | expected | source |
  |---|---|---|---|
  | L1 | −3 dB gain on the fixture PCM | `input_i` moves ≈3 LU ≫ ±0.1 | reasoned |
  | L2 | move `audio.loudnorm.targetLufs` | `i` moves ≫ ±0.3 | reasoned |
  | L3 | loudnorm drift 2.0 LU | worst window 38.7 % > 10 % | finding 6 |
  | L4-tight | re-encode at `-q:a 3` | MD5 differs | findings 1–2 |
  | L4-loose | loudnorm drift 2.0 LU | rmse 24.8 % > 16 % | finding 6 |

  A single flipped byte in the fixture — revision 2's L1 perturbation — is **not** used:
  one sample in 137 216 moves integrated loudness by orders of magnitude less than ±0.1 LU,
  so the demonstration would show L1 *not* failing. It could move `input_tp`, a different
  field; a −3 dB gain moves `input_i` as the row claims.

## Documentation

- **New regression plan `docs/features/272-golden-assembly-comparison.md`** — reversing
  revision 2's "no new plan file". The change is ~18-20 files across four scopes
  (server / generated-frontend / scripts / docs) and alters a persisted on-disk contract
  plus the OpenAPI schema; that is "substantial/cross-cutting" under Before-shipping step
  1, and it pulls a `high`-effort code-review gate as a multi-scope PR. (Plan numbers 270
  and 271 are taken — `270-openapi-setup-surface.md` and, in a worktree,
  `271-fs38-wave3c-xtts.md`.)
- `docs/features/INDEX.md` — entry under ops.
- `docs/features/269-ffmpeg-version-floor.md` — cross-link to 272, and fix its dead link at
  line 28 (`archive/185-golden-audio.md` does not exist; the file is
  `archive/185-golden-audio-regression.md`).
- `docs/features/archive/185-golden-audio-regression.md` — pointer to 272.
- CLAUDE.md Commands section — `--bless`'s new suite-scoped meaning.
- `docs/release-notes-next.md` — one line for the `--bless` behaviour change.
  `RELEASE_NOTES.md` skipped: no user-facing delta.
- `docs/testing/onbox-acceptance-register.md` — **one row.** GPU-free is not
  verifiable-in-PR: the entire cross-build half of this design (the LOOSE branch, the
  mismatch warning, and whether L1–L3's hard assertions survive another build — the
  unproven bet in §5) cannot be exercised on a box with one ffmpeg, and the golden tier
  sits outside `verify.yml`, so CI's Ubuntu ffmpeg will not exercise it either. **The LOOSE
  path would otherwise ship having never executed.** Row: *run
  `npm run test:golden-audio:assembly` against a second ffmpeg build; record which of
  L1/L2/L3 fire, their deltas, whether L4-loose was reached, and its rmse.*
- `docs/BACKLOG.md` — the thin row for the follow-up issue below, in the same round.

## Out of scope

**The `linear` → `dynamic` fallback and the LRA 3.00 → 0.50 compression (finding 4) is not
fixed here.** Whether a fivefold loudness-range reduction is right for speech needs
listening, not arithmetic. This design **pins `normalizationType: "dynamic"` as the
baseline — locking in current behaviour, including behaviour that may be wrong.** That is
correct for a regression harness, whose job is to detect change rather than adjudicate
correctness, but the risk is named: a pin quietly becomes a specification. It is **filed as
its own backlog issue plus its `docs/BACKLOG.md` row in the same round**, so the question
stays open on the board instead of being settled by a fixture.

## Risks

| Risk | Mitigation |
|---|---|
| **L1–L3 hard across builds is an unproven bet** (finding 3's withdrawn claim) | Named as unproven in §5; the owed on-box row settles it; the fallback (tolerance-gate L1–L3 on LOOSE) is pre-described |
| **L4-loose's margins are thin** — 1.5× either side, calibrated on `-q:a` steps as a proxy for a build change | Labelled the weakest layer in §1; L3 is the sound LOOSE instrument; the on-box row records L4-loose's actual rmse on a second build |
| A pin becomes a spec — `dynamic` locked in before anyone decides it is right | Separate issue + BACKLOG row in the same round; called out in 272 |
| Widening `LoudnormSidecarJson` touches the OpenAPI contract | Surfaces enumerated and verified in §2; field optional; regeneration proven to scope to `ChapterLoudness` alone |
| A `beforeAll` throw masks all four layers | Hook wraps failures with a "pipeline did not complete" message so it cannot be misread as a layer verdict |
| An accidental `--bless` masks a real regression | Bless skips all assertions (§4) so it cannot produce a vacuous green; 274 KB binary + readable JSON diff in `git status` |
| The fixture is 5.7 s of clean English speech, and 2 of its 57 windows are unchecked | Accepted, unchanged from ops-11; the skipped count is asserted so the gap cannot silently grow |
