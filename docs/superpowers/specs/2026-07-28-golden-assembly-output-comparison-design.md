# golden-assembly output comparison — design

**Date:** 2026-07-28
**Issue:** [ops-36 / #1880](https://github.com/dudarenok-maker/Castwright/issues/1880)
**Status:** approved — ready for `writing-plans`
**Revision:** 2 — rewritten after an adversarial `assumption-checker` pass falsified
three of the four "measured" findings in revision 1. See "What revision 1 got wrong".
**Related:** [`docs/features/269-ffmpeg-version-floor.md`](../../features/269-ffmpeg-version-floor.md)
(ops-35 / [#1877](https://github.com/dudarenok-maker/Castwright/issues/1877) — this is
its deferred half),
[`docs/features/archive/185-golden-audio-regression.md`](../../features/archive/185-golden-audio-regression.md)
(ops-11 — the harness this extends)

## Problem

The golden-audio **assembly tier** (Suite B, `npm run test:golden-audio:assembly`) is
described as feeding a committed PCM fixture through the real `synthesiseChapter` +
ffmpeg loudnorm. It does — and then compares the result to nothing.

`server/src/tts/golden-assembly.golden.test.ts` asserts segment count, `sampleRate`,
per-segment `startSec`/`endSec`, and `result.pcm.length` — every one of them
**computed from the input fixture's own byte lengths**, so they restate the input
rather than measure the output. Beyond that it checks file existence for the `.mp3`
and `.segments.json`, and a **20-LU-wide** loudness band (`-30 < i < -10`, `:213-214`).

No assertion touches the produced audio. An ffmpeg upgrade that shifted loudnorm by
2 LU, changed LAME framing, or altered the MP3 byte stream passes silently. This is
the only place in the repo that runs real audio through the real encoder, and it
cannot currently fail for an audio reason.

ops-35 shipped the ffmpeg version floor and asked whether this suite should record
the ffmpeg version its baseline was produced with. It deliberately did not, because
the premise didn't hold: a version stamp on a tolerance-band assertion implies a
comparison the test does not make. Recording provenance for a 20-LU band is
decoration. This spec is the honest remainder.

## What revision 1 got wrong

Revision 1 opened its findings with *"All four were measured on this box, not
assumed."* They were measured — on an artifact the production code never emits. The
probe used `-b:a 128k` CBR and **omitted the output `-ar` pin**, which is the
plan-71 / ffmpeg-8 fix documented at `mp3.ts:161-166`. The result was a **48 kHz**
MP3 exhibiting the exact resample leak `buildMp3FfmpegArgs` exists to prevent:

```
                     revision 1 probe    real path (encodePcmToAudio, verified 2x)
ffmpeg args          -b:a 128k           -ar 24000 -q:a 2 -write_xing 1
output sample rate   48000 Hz            24000 Hz
mp3 bytes            92589               55749
mp3 md5              94f3f429…           d7d6d0aa41ca947da5465dfd289f0f15
```

Three consequences, all corrected below: the committed `mp3Md5` literal was wrong;
the decode round-trip claim was **false** in a way that would have shipped L3 born
red; and the tolerance set was calibrated against nothing. A fourth error was
independent of the probe — L2 pinned a field that is never written to disk.

The lesson is recorded rather than buried: **measure through the production call
path, not through a hand-rolled equivalent.** Every number in this revision was taken
via `encodePcmToAudio` / `decodeAudioToPcm` / `runLoudnormFirstPass` under `tsx`.

## Findings

ffmpeg `8.1.1-full_build-www.gyan.dev`; fixture
`server/src/tts/__fixtures__/golden-chapter.pcm` (274 432 bytes, 24 kHz mono s16le,
137 216 samples, 5.72 s).

**1. The encoded MP3 is byte-identical across repeat runs on one build.**
Through the real `encodePcmToAudio`: `55749` bytes,
md5 `d7d6d0aa41ca947da5465dfd289f0f15`, twice. No ID3 timestamp, no `creation_time`,
no temp path, no cover art; the only version-bearing bytes are `TSSE=Lavf62.12.101`
and the `Lavc62.28` LAME tag, both build-constant. **The MD5 tight path is viable** —
this is load-bearing, and it means the sample-wise machinery is needed only on the
cross-build path.

**2. The decode round-trip is length-preserving only from a SEEKABLE input.**
Revision 1 claimed it was exact and it is not, via the path the code actually uses:

```
decode the real mp3 from a FILE   ->  274 432 B   == input, exactly
decode the real mp3 from a PIPE   ->  275 422 B   +495 samples of untrimmed padding
```

`decodeAudioToPcm` (`mp3.ts:501-516`) feeds the buffer on `pipe:0`. On a non-seekable
input ffmpeg does **not** apply the LAME tag's end-padding trim. The extra samples are
a pure trailing append (the pipe decode contains the file decode as an exact prefix at
lag 0). This design therefore decodes **from the written file** — see Design §1, L3.

From a file the length is `274 432` and stable across every perturbation tested,
including an encoder-quality change: **137 216 samples = 57 full 100 ms windows plus a
416-sample tail**, dropped identically on both sides.

**3. The first-pass loudnorm measurement is bit-stable.**
Repeat analysis passes over the same input bytes return character-identical JSON:
`input_i -21.70`, `input_lra 3.00`, `input_tp -4.15`, `input_thresh -31.75`. Fixed
input, no encoder in the path.

Revision 1 extended this into *"EBU R128 is spec-defined and stable within a version
line"* and used it to justify hard cross-build assertions. **That extension is
withdrawn** — it was unevidenced. What BS.1770 defines is an *algorithm*; what L1 pins
is ffmpeg's `loudnorm` implementation output, including an oversampled true-peak
estimate whose filter is implementation-defined. Cross-build behaviour here is
**unmeasured**, and the design says so rather than asserting otherwise (see §3).

**4. `linear=true` does not hold on this fixture — loudnorm falls back to `dynamic`.**
`buildSecondPassFilterString` requests `linear=true` (`loudnorm.ts:293`). Measured: the
fixture's true peak is `-4.15` dBTP, so the ~5.7 dB gain needed to reach `-16` LUFS
would push the peak past the `-1.5` ceiling. ffmpeg reports
`normalization_type: "dynamic"` and compresses the chapter from **LRA 3.00 to LRA
0.50**. `output_i` lands at **`-16.28`**, not `-16.00`.

This falsifies the assumption this design started from — that the persisted `lufs.i`
converges on target by construction and is near-tautological to assert. It does not
converge exactly, and it is a genuine output of ffmpeg's dynamic-mode algorithm.
Pinning it is worth more than first estimated. Whether the fivefold compression is
*correct* is a separate question — see "Out of scope".

**5. `normalization_type` is parsed and then discarded — it is not on disk.**
`LoudnormSidecarJson` (`loudnorm.ts:73-86`) is `{i, lra, tp, target, twoPass,
measuredAt}`. `encodePcmToAudio` parses the mode at `mp3.ts:440` and drops it when
building the sidecar (`:442-449`); the type's own comment says *"Not surfaced to the
UI today; captured here for log copy."* Verified on disk:

```
{"i":-16.28,"lra":0.5,"tp":-1.5,"target":-16,"twoPass":true,"measuredAt":"…"}
```

Revision 1's L2 pinned a field that does not exist. Resolved by widening the sidecar —
see §2 and the scope note there.

**6. RMS-error between decoded MP3s is dominated by codec noise, not by audio
content.** The full calibration curve, every row through the production path:

| perturbation | RMS-error | worst envelope window |
|---|---|---|
| identical re-encode | 0.00 % | 0.0 % |
| input gain +0.5 dB | 0.41 % | 1.9 % |
| loudnorm drift 0.1 LU | 4.80 % | 4.0 % |
| **encoder quality 2 → 3 (inaudible)** | **8.08 %** | **3.3 %** |
| loudnorm drift 0.5 LU | 8.78 % | 8.5 % |
| **loudnorm drift 2.0 LU** (the issue's own case) | **24.79 %** | **38.7 %** |
| loudnorm drift 3.0 LU | 34.74 % | 61.6 % |
| middle segment silenced | 72.56 % | 100.0 % |

Two things fall out, and both change the design:

- **Input gain is a useless calibration perturbation** — two-pass loudnorm normalises
  it away by construction (+0.5 dB in → 0.41 % out). Revision 1 would have calibrated
  against exactly the thing the pipeline is designed to remove.
- **A 0.1 LU loudnorm drift (4.80 %) sits BELOW the codec-noise floor (8.08 %).**
  RMS-error cannot separate sub-0.5-LU drift from an encoder change. It can separate
  2 LU cleanly. So L4 is a gross-drift and catastrophe detector, not a precision
  instrument — L1 and L2 are the precision instruments, and L1 pins measurement drift
  at ±0.1 LU directly, which L4 could never do.

Revision 1's ±3 % envelope tolerance would have **fired on the inaudible encoder
change** (3.3 %). Its `corr > 0.995` gate would have **passed** it (0.9979).

**7. The envelope's quiet windows cannot carry a relative tolerance.**
Measured on the real decode: 57 windows spanning 56 dB, median RMS `0.1349`, quietest
`4.42e-4` (**-67.1 dBFS**) at window 35. At that window ±3 % is **0.435 LSB** at
int16 — narrower than one quantisation step. Two of 57 windows sit below -50 dBFS.

## Goals

- Make the assembly golden tier able to fail for an audio reason.
- Keep it GPU-free, opt-in, and outside `test:all` / `verify` (ops-11 / plan 185).
- Distinguish "ffmpeg drifted" from "someone changed a loudnorm knob" in the failure
  message, since those are different bugs that otherwise present identically.
- Record the ffmpeg provenance of the baseline and report a mismatch as information.

## Non-goals

- Byte-exact MP3 comparison **across** ffmpeg builds.
- Raising the ffmpeg floor (ops-35 set it at 6.0).
- Fixing the `linear` → `dynamic` fallback (finding 4).
- Changing what `loudnorm.ts` **parses**. (Widening what it *persists* is in scope and
  deliberate — see §2.)

## Design

### 1. Four comparison layers

Four independent assertions over a single pipeline run. There is deliberately **no
arbitration** between them — each fails on its own terms, and which combination fails
is itself diagnostic.

| # | Pins | Source | Tolerance | Catches |
|---|---|---|---|---|
| **L1** | `input_i`, `input_lra`, `input_tp`, `input_thresh` | `runLoudnormFirstPass` on the raw fixture | ±0.1 LU/dB | ffmpeg's EBU R128 **measurement** changing. Same input bytes, no encoder — the most sensitive signal available (finding 3). |
| **L2** | `i`, `lra`, `normalizationType` | the written `.lufs.json` | ±0.3 LU; mode string **exact** | ffmpeg's **gain application** changing, including a silent `dynamic` → `linear` flip (finding 4). |
| **L3** | decoded byte count + per-100 ms RMS envelope | `.mp3` decoded **from the written file** | count **exact** (finding 2); envelope ±10 % relative, windows below -50 dBFS skipped | timing/duration shifts, resampler changes, and **where** a change is located. |
| **L4** | the encoded `.mp3` | file bytes | **tight:** MD5 equality (finding 1) · **loose:** RMS-error < 15 % | anything at all on a matched build; gross drift and catastrophe on a mismatched one. |

**Tolerances are derived from finding 6's curve, not picked:**

- **L4-loose `rmse < 15 %`** sits above the codec-noise floor (8.08 %) and below the
  2 LU drift the issue names (24.79 %). It deliberately does **not** catch sub-0.5-LU
  drift; L1 catches that at ±0.1 LU, forty times more sensitively.
- **L3 envelope ±10 %** sits above the encoder-change worst window (3.3 %) and below
  the 2 LU worst window (38.7 %).
- **Windows below -50 dBFS are skipped, not floored** (finding 7). A floor would leave
  those windows silently unchecked at an absurd effective tolerance; skipping states
  the gap. The skipped count is asserted (`=== 2`) so a fixture change that quietens
  the audio surfaces rather than silently disabling coverage.
- **L2 drops `tp`.** `output_tp = -1.50` is the configured ceiling that loudnorm
  clamps to; pinning it asserts almost nothing. `lra` is the field that actually moves
  (0.50 vs ~3.00 under a mode flip), and `i` is non-tautological per finding 4.

**L3 decodes from the written file, not via `decodeAudioToPcm`** (finding 2). The
tier's job is to pin the *audio*, and pipe-mode padding is an incidental decoder
behaviour, not audio. The cost is that the golden tier no longer exercises the shipped
`decodeAudioToPcm` helper — accepted, because pinning that helper was never this
tier's purpose.

**L3 and L4 are LOOSE-path instruments.** On TIGHT, an MD5 match means the decoded PCM
is bit-identical, so the envelope and RMS-error are exactly zero and both layers are
vacuous. That is not a defect — it is why one tolerance set, sized for cross-build,
suffices.

**What earns L4 alongside L3:** envelope RMS is blind to sign and to within-window
structure. A phase inversion leaves every envelope window identical while RMS-error
goes to 200 %; a single click is averaged away by a 2400-sample window. L4 says
*whether*, L3 says *where*, and neither subsumes the other.

### 2. Widening `LoudnormSidecarJson` (scope, stated plainly)

L2's mode pin requires `normalizationType` on disk. This is a **persisted-contract
change**, and its full cost was not visible when the choice was made — it is recorded
here so it can still be reversed:

| Surface | Change |
|---|---|
| `server/src/tts/loudnorm.ts:73` | add `normalizationType: 'linear' \| 'dynamic'` to `LoudnormSidecarJson` |
| `server/src/tts/mp3.ts:442` | stop discarding the parsed mode; carry it into `pendingSidecar` |
| `openapi.yaml:5370` | add the field to `ChapterLoudness` (the mirrored schema) |
| `src/lib/api-types.ts` | regenerate via `npm run openapi:types` |
| `src/lib/types.ts:52` | hand-mirrored sidecar shape |
| `server/src/routes/book-state.ts:385`, `routes/chapter-audio.ts:79` | read `LoudnormSidecarJson` — must tolerate the field's absence |

**Migration:** existing `.lufs.json` files on disk lack the field. It is therefore
**optional** in the type (`normalizationType?`), and the single-pass path leaves it
undefined (single-pass does no re-measurement, so there is no mode to report). L2
asserts it only when `twoPass === true`.

**Adjacent defect found in the schema being edited:** `openapi.yaml:5380` documents
`i` as *"In two-pass mode this is the FIRST-pass measurement of the source PCM."*
That contradicts `loudnorm.ts:66-70` and reality — measured `i` is `-16.28`, the
*post*-normalisation value; the first-pass measurement was `-21.70`. Since this PR
edits that exact schema block, the wrong sentence is corrected in the same diff. It is
noted rather than folded in silently.

### 3. Baseline artifacts

Two new committed files in `server/src/tts/__fixtures__/`:

```
golden-chapter.pcm            274 432 B  input fixture              (exists)
golden-chapter.json               528 B  segment meta               (exists)
golden-chapter.baseline.json    ~2 KB    L1/L2/L3 + MD5 + provenance   NEW
golden-chapter.decoded.pcm    274 432 B  L4-loose reference            NEW
```

Every literal below is **measured**, except the two marked `«bless»`, which are
written at bless time and appear here only to show the shape:

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
`audio.loudnorm.targetLufs`"* — different bugs that otherwise present identically. The
`encode` block does the same for `-q:a` / `-ar` / `-write_xing`: revision 1's own
failure proves a changed encode parameter produces a completely different artifact,
and the version gate cannot see it.

**A missing baseline is a hard failure**, not a skip, naming the bless command.
Absence means someone deleted a committed file, and skipping would recreate the exact
silent-pass problem this issue exists to close.

### 4. The version gate

`FfmpegProbe` (`diagnostics/ffmpeg.ts:29`) exposes only the parsed `MAJOR.MINOR`; the
raw banner is captured by the module-private `present()` at `:84` and discarded. Two
different `8.1` builds — Gyan on Windows, distro on Ubuntu, different LAME — would
claim a match and then fail a tight comparison.

**Add one named export**, `ffmpegBannerLine(): string | null`, returning the first line
of `ffmpeg -version`. Deliberately **not** a change to `FfmpegProbe`: that shape
crosses into `routes/diagnostics.ts`, `routes/setup-readiness.ts` and the
hand-mirrored `BlockerCause` in `src/lib/api.ts`. Note it **spawns afresh** — the
probe is deliberately uncached (`:93-98`), so there is no captured stdout to reuse.
Trivial cost in an opt-in test.

```
banner === baseline.ffmpegBanner   →  TIGHT   L4 asserts MD5 equality
otherwise                          →  LOOSE   L4 asserts rmse < 15 %
                                              + console.warn naming both versions
```

**L1–L3 remain hard on both paths**, per the approved design. Revision 1 justified
this with a claim that has since been withdrawn (finding 3), so the honest statement
is: *this is an unproven bet.* Cross-build stability of ffmpeg's loudnorm output is
unmeasured here — one box, one build. The bet is that a different build of the same
version lands inside ±0.1, and that a different *version* moving `input_i` is the news
ops-36 exists to deliver. **The first cross-machine run settles it**, and that run is
an owed on-box acceptance (see Documentation). If the bet loses, the fix is to
tolerance-gate L1–L3 on the LOOSE path exactly as L4 already is.

One structural consequence, since L3's exact byte count now gates L4-loose's
equal-length precondition: **the comparison module truncates to `min(len)` before
computing RMS-error**, and the length delta is asserted separately. L4-loose can
therefore always run, even if L3's count assertion is the thing that failed.

### 5. Failure reporting

An opt-in tier that fails once a year is read cold, and `toBeCloseTo`'s diff is
useless for a 57-float array. Every layer's message carries baseline, actual, delta,
tolerance, both ffmpeg versions, the tight/loose mode, and the bless command:

```
L1 first-pass drift: input_i -22.10 (baseline -21.70, delta -0.40 LU, tol 0.10)
  run: ffmpeg 9.0  |  baseline: ffmpeg 8.1  |  mode: LOOSE
  If intended, re-bless: npm run test:golden-audio -- --assembly-only --bless
```

L3 reports the **worst window and its timestamp** (`12.4 % @ w35, t=3.5s`) rather than
dumping both arrays.

### 6. Bless flow

`--bless` becomes **suite-scoped**, composing with the flags already in
`scripts/run-golden-audio.mjs`:

```
npm run test:golden-audio -- --bless                    both suites
npm run test:golden-audio -- --assembly-only --bless    Suite B only
npm run test:golden-audio -- --sidecar-only  --bless    Suite A only  (today's behaviour)
```

The runner passes `GOLDEN_BLESS=1` into the Suite B vitest spawn — today it reaches
only Suite A (`run-golden-audio.mjs:65-74`, inside `if (!assemblyOnly)`). The test
branches on it, writing both artifacts instead of asserting, printing what it wrote
and a "review the diff before committing" line, and exiting 0.

Two precision notes revision 1 got loose:

- Today `--assembly-only --bless` is a no-op **for bless only** — Suite B still runs
  and asserts normally; it does not "exit 0 having done nothing".
- `npm run test:golden-audio:assembly` calls `npm --prefix server run test:golden`
  **directly** (root `package.json:65`), bypassing the runner — so that alias can
  never bless, regardless of flags. The plan must either route it through the runner
  or document that blessing requires the full runner form.

An accidental bless is visible in `git status` as a 274 KB binary diff plus a readable
JSON diff.

### 7. Code layout

**New pure module** `server/src/tts/golden-baseline.ts` — the `AssemblyBaseline` type,
tolerance constants, and the comparison math: `rmsEnvelope`, `pcmRms`, `rmsError`,
`compareEnvelope`, `md5`. No ffmpeg, no I/O. **No `correlation`** — finding 6 shows it
passes (0.9979) changes that move every one of 57 envelope windows, so it was not
earning its place.

**`golden-baseline.test.ts`** is *not* named `*.golden.test.ts`, so it runs in the
ordinary `test:server` tier that gates every push. This matters: the golden tier is
opt-in and may go a year between runs, so its comparison math must be proven by a
suite that runs continuously. Tests drive known signals — silence, full-scale, a
gain-scaled copy, a phase-inverted copy (envelope identical, RMS-error 200 % — the
case that justifies L4's existence), a sample-shifted copy, and an envelope with a
sub--50 dBFS window to pin the skip rule. The TIGHT/LOOSE branch selection is unit-
tested with synthetic banner strings, since a real second ffmpeg build is not
available in CI.

**`golden-assembly.golden.test.ts`** gains a `beforeAll` that runs the pipeline once —
first pass, synth, finalize, decode — into a module-scoped artifacts object, with the
tempdir workspace moving from test 2's `try`/`finally` to `beforeAll`/`afterAll`. The
`it` blocks become thin assertions over it, and bless writes from that one place.

Two accuracy corrections to revision 1's framing of this:

- Its *"one pipeline run, four readings of it"* overstates the economy. L1's source is
  `runLoudnormFirstPass` on the raw fixture — a **separate ffmpeg spawn**, on top of
  the one `encodePcmToAudio` runs internally. Four spawns total. The encode's
  second-pass stderr already re-reports `input_*`, but `encodePcmToAudio` does not
  expose it, so the extra spawn is pragmatic rather than economical. The restructure
  is still right — four *encodes* would mean each layer measuring a different artifact
   — but it should be argued on coherence, not cost.
- The `process.env.WORKSPACE_DIR` set inside test 2 is **already inert**.
  `workspace/paths.ts:35-39` computes `WORKSPACE_ROOT` at module-eval time, and the
  golden test statically imports `synthesise-chapter.js`, which statically imports
  `paths.js` — so the module is fully evaluated before the env assignment runs, and
  the dynamic `import()` returns the cached module. Verified: `WORKSPACE_SOURCE` reads
  `default`, not `env`. The test is not workspace-isolated today and never has been;
  it is harmless only because `finalizeChapterAudioWrite` takes an explicit `bookDir`.
  The plan should delete the inert env-set + dynamic-import pair, or keep them with a
  comment saying why they are inert — not silently relocate them and imply they work.

## Testing

- `golden-baseline.test.ts` in `test:server` — gates every push.
- `npm run test:golden-audio:assembly` green locally.
- **The deliverable is a demonstration, not a green run.** Passing is what the suite
  already does. The PR body records **one perturbation per layer**, each with its
  measured value from finding 6's curve:

  | layer | perturbation | expected |
  |---|---|---|
  | L1 | flip a byte in the input fixture | `input_i` moves; hard fail |
  | L2 | move `audio.loudnorm.targetLufs` | `i` moves ≫ ±0.3; hard fail |
  | L3 | loudnorm drift 2.0 LU | worst window 38.7 % > 10 % |
  | L4-tight | re-encode at `-q:a 3` | MD5 differs |
  | L4-loose | loudnorm drift 2.0 LU | rmse 24.8 % > 15 % |

  That the suite *can* fail is the entire point of ops-36.

## Documentation

- New section in `docs/features/269-ffmpeg-version-floor.md` (active — already frames
  ops-36 as its deferred half): layers, derived tolerances, bless recipe, version gate.
- One pointer line in `docs/features/archive/185-golden-audio-regression.md` → 269.
  (Note: 269's line 28 currently links `185-golden-audio.md`, which does not exist —
  fix that dead link while editing the file.)
- CLAUDE.md Commands section: `--bless`'s new suite-scoped meaning.
- `docs/release-notes-next.md` — **one line**, reversing revision 1's skip. The
  technical register is the right home for a documented CLI behaviour change
  (`--bless` going from Suite-A-only to suite-scoped), especially one this PR is
  simultaneously editing CLAUDE.md for. `RELEASE_NOTES.md` is still skipped: no
  user-facing delta.
- `docs/testing/onbox-acceptance-register.md` — **one row**, reversing revision 1's
  "not applicable" call. GPU-free is not the same as verifiable-in-PR: the entire
  cross-build half of this design (the LOOSE branch, the mismatch warning, and whether
  L1–L3's hard assertions survive another build — the unproven bet in §4) cannot be
  exercised on a box with one ffmpeg, and the golden tier is deliberately outside
  `verify.yml`, so CI's Ubuntu ffmpeg will not exercise it either. **The LOOSE path
  would otherwise ship having never executed.** The row: *run
  `npm run test:golden-audio:assembly` against a second ffmpeg build; record which of
  L1/L2/L3 fire, their deltas, and whether L4-loose was reached.*
- **No new plan file.** One test file, one helper module, one baseline pair, a runner
  flag, and a scoped sidecar-field addition; 269 is the right home.

## Out of scope

Beyond the issue's own list, one item discovered while measuring:

**The `linear` → `dynamic` fallback and the resulting LRA 3.00 → 0.50 compression
(finding 4) is not fixed here.** Whether a fivefold loudness-range reduction is correct
for speech needs listening, not arithmetic, to settle. This design **pins
`normalizationType: "dynamic"` as the baseline — locking in current behaviour,
including behaviour that may turn out to be wrong.** That is the correct call for a
regression harness, whose job is to detect change rather than adjudicate correctness,
but the risk is named: a pin quietly becomes a specification. It gets **filed as its
own backlog issue in the same round**, so the question stays open on the board instead
of being settled by a test fixture.

## Risks

| Risk | Mitigation |
|---|---|
| **L1–L3 hard across builds is an unproven bet** (finding 3's withdrawn claim) | Named as unproven in §4; the owed on-box acceptance row is what settles it; the fallback (tolerance-gate L1–L3 on LOOSE) is pre-described |
| A pin becomes a spec — `dynamic` mode locked in before anyone decides it is right | Filed as a separate issue in the same round; called out in the 269 section |
| Widening `LoudnormSidecarJson` touches the OpenAPI contract | Full surface enumerated in §2; field is optional, so existing sidecars and single-pass output stay valid |
| L4-loose cannot see sub-0.5-LU drift (finding 6) | By design and stated; L1 covers that range at ±0.1 LU, 40× finer |
| An accidental `--bless` masks a real regression | 274 KB binary + readable JSON diff in `git status`; bless prints what it wrote |
| The fixture is 5.7 s of clean English speech, and 2 of its 57 windows are unchecked | Accepted, unchanged from ops-11; the skipped-window count is itself asserted so the gap cannot silently grow |
