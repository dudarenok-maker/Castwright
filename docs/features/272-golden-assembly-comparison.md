---
status: active
shipped: null
owner: null
---

# 272 — Golden-assembly output comparison (ops-36)

> Status: active
> Key files: `server/src/tts/golden-baseline.ts` (pure comparison math + `TOL`
> + `selectMode`), `server/src/tts/golden-assembly.golden.test.ts` (Suite B,
> the 8-test tier this plan builds), `server/src/tts/__fixtures__/golden-chapter.baseline.json`
> + `.decoded.pcm` + `golden-chapter.linear.baseline.json` (committed
> baselines), `server/src/audio/measure-loudness.ts` (real `ebur128`
> post-write measurement), `server/src/audio/finalize-chapter-write.ts` (calls
> it after the rename), `server/src/tts/loudnorm.ts` (`normalizationType` on
> `LoudnormSidecarJson`), `server/src/tts/mp3.ts` (`decodeAudioFileToPcm`, the
> seekable-input decode `golden-assembly.golden.test.ts` needs for an exact
> byte count), `server/src/diagnostics/ffmpeg.ts` (`ffmpegBannerLine`),
> `scripts/run-golden-audio.mjs` (suite-scoped `--bless`),
> `src/components/listen/listen-player-region.tsx` (the Listen-view loudness
> badge these numbers feed), `openapi.yaml` (`ChapterLoudness`)
> URL surface: none (dev tooling) — except the Listen-view loudness badge,
> which now renders real measurements instead of loudnorm self-reports
> URL surface (badge): `#/books/<id>/listen`
> OpenAPI ops: none new — `ChapterLoudness` field descriptions corrected

Implementation plan: [`docs/superpowers/plans/2026-07-28-golden-assembly-output-comparison.md`](../superpowers/plans/2026-07-28-golden-assembly-output-comparison.md)
Related: [`archive/185-golden-audio-regression.md`](archive/185-golden-audio-regression.md)
(Suite B's original assembly tier, extended here) · [`269-ffmpeg-version-floor.md`](269-ffmpeg-version-floor.md)
(the ffmpeg-version contract this plan gates output comparison on) · ops-36 ·
[#1880](https://github.com/dudarenok-maker/Castwright/issues/1880)

## Benefit / Rationale

- **User:** two shipped defects on the Listen view's per-chapter loudness
  badge are fixed. The loudness sidecar now persists a real `ebur128`
  measurement of the **finished** audio file instead of loudnorm's own
  self-reported `output_*` figures — `output_tp` in particular is the
  ceiling loudnorm was **asked** to hit, not what the file measured, and can
  read below the true sample peak. On the golden fixture, `lra` moved from
  a self-reported `0.5` to a measured `1.7`, and `tp` from the requested
  `-1.5` to a real reading; because the badge formats with `toFixed(1)`, the
  integrated-loudness pill itself only moves `-16.3 → -16.2` (rounding), but
  the loudness-range and true-peak numbers were previously not measurements
  at all.
- **Technical:** Suite B (the GPU-free assembly golden tier, plan 185) used
  to assert a 20-LU loudness band and fixture-derived durations — it could
  not have caught either of the above, or a real audio-content regression,
  because it never compared output bytes to anything recorded. It now
  compares the finished chapter against a committed, ffmpeg-build-stamped
  baseline across **five** independent layers (L1–L5, the fifth — spectral
  tilt — folds in [ops-44 / #1910](https://github.com/dudarenok-maker/Castwright/issues/1910))
  plus a dedicated linear-arm baseline
  ([ops-46 / #1912](https://github.com/dudarenok-maker/Castwright/issues/1912),
  below), so a regression in assembly, loudnorm, encode, or decode now has
  to survive five different instruments to pass unnoticed.
- **Architectural:** establishes the TIGHT/LOOSE version gate
  (`selectMode()` in `golden-baseline.ts`) as the pattern for comparing
  ffmpeg-produced output across builds without either false-flagging a
  routine LAME-framing difference or going blind to a real regression. Pins
  `dynamic` loudnorm as the recorded baseline behaviour — correct for a
  regression harness, but see "Pin risk" below before treating it as spec.

## Architectural impact

- **New seams:**
  - `golden-baseline.ts` — pure, unit-tested (`golden-baseline.test.ts`, in
    the ordinary `test:server` tier) comparison math: `rmsEnvelope`,
    `pcmRms`, `rmsError`, `spectralTilt`, `compareEnvelope`, `selectMode`,
    `md5`, `dbfs`, `toInt16`, and the derived `TOL` tolerance table. Kept
    separate from the opt-in `*.golden.test.ts` file specifically so the
    tier's own math is proven on every push, not only when someone
    remembers to run the year-between-runs golden tier.
  - `measureLoudnessFile()` (`server/src/audio/measure-loudness.ts`) — a
    real `ebur128` pass over the encoded file, run by
    `finalizeChapterAudioWrite` after the atomic rename. Fails soft: the
    audio is already on disk by the time it runs, so a measurement failure
    leaves loudnorm's self-reported figures in place rather than breaking
    the write.
  - `LoudnormSidecarJson.normalizationType?: 'linear' | 'dynamic'`
    (`loudnorm.ts`) — optional, and **absence is meaningful in two
    different ways**: single-pass mode never has one, and a two-pass encode
    whose second-pass stderr JSON failed to parse falls back *without* one
    while still reporting `twoPass: true`. Consumers must not infer
    presence from `twoPass`. `scripts/relufs-existing.mjs` legitimately
    omits it too — `ebur128` has no notion of a normalisation mode, so a
    sidecar it rewrites has nothing to put there.
  - `ffmpegBannerLine()` (`diagnostics/ffmpeg.ts`) — the full first line of
    `ffmpeg -version`, deliberately a superset of `FfmpegProbe.version`
    (which is MAJOR.MINOR only, the right granularity for plan 269's floor
    check but not for "will two installs produce byte-identical MP3
    output" — two 8.1 builds can ship different LAME).
  - `decodeAudioFileToPcm()` (`mp3.ts`) — decodes from a **seekable file**,
    not a pipe. A pipe decode skips the LAME gapless-trim tag and appends
    ~495 samples of padding; a file input round-trips to the exact source
    length, which L3/L4 depend on for an exact byte count.
- **Invariants preserved:** the golden tier stays opt-in — `*.golden.test.ts`
  stays excluded from `server/vitest.config.ts`, and `test:golden-audio` is
  not wired into `test:all` / `verify` / any `verify:fast*` / CI. Suite B
  stays GPU-free (no model, no sidecar — a stub `TtsProvider` replays the
  committed recorded-PCM fixture).
- **Migration:** `normalizationType` is additive + optional on
  `LoudnormSidecarJson` / `ChapterLoudness` (openapi.yaml, regenerated into
  `src/lib/api-types.ts`) — no schema bump, no lazy migration needed. The
  `i`/`lra`/`tp` re-definition (self-reported → measured) is a **behaviour**
  change, not a shape change: existing `.lufs.json` files on disk keep their
  old, loudnorm-self-reported values until that chapter next renders: there
  is no backfill.
- **Reversibility:** delete the `measureLoudnessFile()` call in
  `finalize-chapter-write.ts` to fall back to loudnorm's self-reports (the
  pre-ops-36 behaviour); the golden tier's five layers are independent of
  that call and would keep working against whichever figures the sidecar
  carries, since only L1/L2 read the sidecar and L1 reads the first-pass
  stats, not the post-write measurement.

## Invariants to preserve

1. **The golden tier never gates a push.** `server/vitest.config.ts` excludes
   `src/**/*.golden.test.ts`; `npm run test:golden-audio[:assembly|:sidecar]`
   is never added to `test:all` / `verify` / `verify:fast*` / any CI
   workflow.
2. **Tolerances are derived, not picked.** `TOL` in `golden-baseline.ts`:
   L1 (first-pass loudnorm stats) `±0.1` LU, L2 (persisted sidecar) `±0.3`
   LU, L3 (100 ms RMS envelope) `±10 %` relative with a `-50 dBFS` skip
   floor and a `-45 dBFS` audibility ceiling on windows the baseline
   recorded as quiet, L4-loose (cross-build MP3 RMS-error) `<16 %`, L5
   (spectral-tilt proxy) `±3.5 %`. Each is a documented geometric-mean or
   noise-floor derivation in `golden-baseline.ts` — do not adjust without
   re-deriving against the same perturbation curve.
3. **TIGHT/LOOSE selection is unit-tested, not inlined in the golden
   file.** `selectMode(runBanner, baselineBanner)` lives in
   `golden-baseline.ts` specifically so the branch has coverage — on any
   one box only one of the two arms ever executes inside the golden test
   itself, and an arm that only ever runs on someone else's machine is
   effectively untested.
4. **A passing LOOSE run still announces itself.** `beforeAll` in
   `golden-assembly.golden.test.ts` `console.warn`s when
   `selectMode(...) === 'LOOSE'`, even when every layer passes — without
   this, an operator running the owed on-box acceptance row (a second
   ffmpeg build) would get a green run with no way to tell whether the
   LOOSE branch executed at all.
5. **`writeBaseline` refuses to record a baseline missing
   `normalizationType`.** If the second-pass loudnorm JSON failed to parse
   at bless time, `normalizationType` would be `undefined`, and a naive
   comparison would then read `undefined === undefined` on every future run
   and pass forever — silently defeating the exact diagnosis L2 exists to
   make. Blessing under that condition throws instead.
6. **`dynamic` is the pinned baseline, and that is a regression-harness
   choice, not a specification.** See "Pin risk" below.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/golden-baseline.test.ts`) — the comparison
  math (`rmsEnvelope`, `pcmRms`, `rmsError`, `spectralTilt`,
  `compareEnvelope`, `selectMode`, `dbfs`, `toInt16`, `md5`) runs in the
  ordinary `test:server` tier, so the golden tier's statistics stay proven
  on every push independent of whether anyone runs the opt-in tier itself.
- Vitest server (`server/src/audio/measure-loudness.test.ts`) —
  `parseEbur128Summary` across a real Summary block, an `-inf` (silent)
  input, and a partial/malformed block; `measureLoudnessFile` against a
  real ffmpeg spawn.
- Vitest server (`server/src/audio/finalize-chapter-write.test.ts`) — a new
  case asserts the persisted `.lufs.json` matches an independent `ebur128`
  reading of the produced MP3 rather than loudnorm's `output_*` figures,
  and explicitly that `sidecar.tp` is **not** the requested `-1.5` ceiling.
- Vitest server (`server/src/tts/mp3-spawn-args.test.ts`) — the
  `normalizationType` success path against the file's existing
  `"normalization_type": "linear"` second-pass fixture (no new fixture
  needed); `server/src/tts/decode-audio-to-pcm.test.ts` — the file-vs-pipe
  decode length difference this tier depends on.
- Vitest server, opt-in (`server/src/tts/golden-assembly.golden.test.ts`,
  Suite B) — **8 tests**, `beforeAll` running the real pipeline twice
  (~1.9 s total): the shipped `-16` target (the primary run) and `-20` (the
  dedicated linear-arm run). Assembly/finalize sanity, then **L1** (ffmpeg
  first-pass loudnorm stats, `±0.1` LU), **L2** (persisted sidecar loudness
  + `normalizationType`, `±0.3` LU), **L3** (decoded byte length exact +
  100 ms RMS envelope, `±10 %` relative with the quiet-floor/ceiling
  guards), **L4** (encoded MP3 — exact md5 on TIGHT, `<16 %` RMS-error on
  LOOSE), **L5** (spectral-tilt proxy, `±3.5 %` — the one layer that is not
  purely an energy instrument, so a cross-build resampler/lowpass change
  that dulls the top end is visible here and nowhere else), and
  **L-linear** (the dedicated `-20` LUFS run: asserts loudnorm actually took
  the `linear` arm, then the same sidecar/length/envelope checks against
  `golden-chapter.linear.baseline.json`).
- `npm run test:hooks` (`scripts/tests/run-golden-audio.test.mjs`) —
  `--bless` follows suite selection: bare `--bless` blesses both suites,
  `--assembly-only --bless` only Suite B, `--sidecar-only --bless` only
  Suite A; `npm run test:golden-audio:assembly` (the direct alias,
  intentionally left alone) can never bless.

### Manual acceptance walkthrough

1. `npm run test:golden-audio:assembly` on this box → 8/8 green, TIGHT mode
   (banner matches the committed baseline), no LOOSE warning printed.
2. Perturb `golden-chapter.baseline.json`'s `sidecar.i` by more than `0.3` →
   L2 fails with the sidecar-drift message, naming the delta and the
   tolerance.
3. Corrupt `golden-chapter.decoded.pcm` (flip a run of bytes mid-file) → L4
   fails on TIGHT (md5 mismatch) even though L1–L3 may still pass, showing
   the layers are independent.
4. `npm run test:golden-audio -- --assembly-only --bless` → both
   `golden-chapter.baseline.json` + `.decoded.pcm` **and**
   `golden-chapter.linear.baseline.json` rewrite; `git diff` shows the
   change; no assertions ran (bless mode returns early in every `it`).
5. **Owed cross-build walkthrough** — see the on-box acceptance row below;
   requires a box with a different ffmpeg build.

## Out of scope

- **Fixing the `linear` → `dynamic` fallback itself.** ops-36 measures and
  pins the *current* behaviour as the golden baseline; it does not change
  it. Filed as [#1909](https://github.com/dudarenok-maker/Castwright/issues/1909)
  (`bug`, `area:srv`) — loudnorm rides syllables on most real chapters
  because the shipped `-16` target's crest factor routinely exceeds the
  true-peak headroom, tripping the dynamic fallback instead of the linear
  gain the code requests. See that issue for the measured gain-spread data.
- **Routing `test:golden-audio:assembly` through `run-golden-audio.mjs`.**
  Task 5 deliberately leaves the direct alias alone (it bypasses the
  runner and so can never bless) because the owed on-box acceptance row
  below prescribes running exactly that alias against a second ffmpeg
  build, unmediated by the runner's suite-selection logic.
- **A content assertion** (wrong voice, truncated/repeated words, gross
  voice damage). Suite B replays fixed PCM by construction, so it is
  structurally blind to content — that gap is
  [#1911](https://github.com/dudarenok-maker/Castwright/issues/1911)
  (ops-45, `moscow:should`), deliberately deferred rather than folded in:
  it lives in Suite A (Python/pytest, real Kokoro weights), and folding it
  in here would make this a two-harness PR whose new leg cannot be
  verified from this repo checkout.
- **Reordering the QA true-peak check.** [#1922](https://github.com/dudarenok-maker/Castwright/issues/1922) —
  `finalize-chapter-write.ts` feeds `evaluateChapterQa` from the
  **pre-rename** measurement, which is loudnorm's requested `-1.5` dBTP
  ceiling, not a real reading. `audio-qa.ts`'s default `clipTpDb` is `-0.1`,
  so the clipping check is fed a value that can never reach it under
  default config — the check is currently inert. This is the answer to
  Task 4c step 4's open question (resolved during implementation, not
  left open): moving the QA call after the rename has its own blast
  radius and is left as a separate fix.
- **Gating the Listen-view loudness UI on real single-pass data.**
  [#1923](https://github.com/dudarenok-maker/Castwright/issues/1923) — the
  UI (`loudness-report.tsx`, `listen-player-region.tsx`) gates every figure
  on `twoPass === true`, which was correct when single-pass `i`/`lra`/`tp`
  were nominal targets. Single-pass chapters now carry a real post-write
  `ebur128` measurement (`measureLoudnessFile` runs regardless of
  `twoPass`), so the gate now discards real data. Not a regression — a
  lost opportunity, deliberately left as a follow-up rather than widening
  this PR into a UI change.

## Pin risk

`dynamic` loudnorm is what the golden fixture measures and is therefore
what the committed baseline pins. That is the correct call **for a
regression harness** — it locks in whatever the pipeline currently does so
a future change is visible — but it must not be read as "dynamic is the
specified behaviour." The code **requests** `linear`
(`loudnorm.ts:293`, `linear=true`); `dynamic` is ffmpeg's own fallback when
the linear gain would breach the true-peak ceiling, and #1909 argues that
fallback is probably the common path on real chapters, not an edge case.
The day #1909 lands and the primary path flips to linear more often, the
**existing** L-linear arm (Task 9c / `golden-chapter.linear.baseline.json`)
already has this covered — it does not need a new fixture, only a
re-bless if the flip changes what target reaches it.

## Ship notes

(Filled in when status flips to `stable`.)
