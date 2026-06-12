---
status: stable
shipped: 2026-05-20
owner: null
---

# Audio loudness normalization (EBU R128 two-pass)

> Status: stable
> Key files: `server/src/tts/loudnorm.ts`, `server/src/tts/mp3.ts`, `server/src/routes/generation.ts`, `server/src/routes/voice-sample.ts`
> URL surface: none direct — affects every `<bookDir>/audio/<slug>.mp3` produced by chapter generation
> OpenAPI ops: implicit on `POST /api/books/{id}/generation`; the sidecar JSON is workspace-local, not an HTTP surface
> Paired tests: `server/src/tts/loudnorm.test.ts`, `server/src/tts/mp3.test.ts`, `server/src/tts/mp3-spawn-args.test.ts`
> Cross-links: [28 — Audio output format](28-chapter-audio-format.md), Could #3 (LUFS report card, Wave 2 — plan 77 when scaffolded)

## Benefit / Rationale

Per-voice volume drift across chapters today forces the listener to ride the volume knob. Different TTS engines and per-character voices produce wildly different program loudness — a quiet narrator followed by a loud antagonist on the same chapter, or two consecutive chapters with the same narrator but different gain. EBU R128 program-level normalization closes the gap.

- **User:** the book sits at one perceived loudness end-to-end. No more knob-riding between chapters or between narrators within a chapter.
- **Technical:** the encoder boundary now carries a generic loudness contract (`LoudnormOptions` + `LoudnormSidecarJson`) the future report-card UI (Could #3 / plan 77) consumes off disk. No frontend changes needed; the sidecar JSON drops next to the MP3 atomically.
- **Architectural:** keeps the format-discriminator (`format: 'mp3'`) clean — loudnorm is an orthogonal `loudnorm?: LoudnormOptions` field on `EncodePcmToAudioOptions`. AAC/Opus (BACKLOG Could #2) can pick it up without re-touching the dispatch.

## Architectural impact

- **New seams added:**
  - `EncodePcmToAudioOptions.loudnorm?: LoudnormOptions` — opt-in per call. Undefined = legacy behaviour (no filter). Voice-sample call site at `server/src/routes/voice-sample.ts:198` deliberately omits this.
  - `EncodePcmToAudioOptions.onLoudnessMeasured?: (stats) => Promise<void> | void` — optional callback fired after a successful loudnorm encode so the caller can persist the measurement. Generation.ts uses it to write `<slug>.lufs.json`.
  - `writeChapterLufsFile(payload, lufsPath)` — sibling to `writeChapterPeaksFile`, same atomic temp-then-rename pattern.
  - Env var `AUDIO_LOUDNORM_ENABLED` (default ON; opt out with `=false`) gates the wiring in `generation.ts`.
- **Invariants preserved:**
  - Plan 28's `format: 'mp3'` discriminator stays single-valued; loudnorm is orthogonal to format choice.
  - The atomic temp-then-rename pattern (plan 56 — `writeChapterPeaksFile`) is mirrored for the new sidecar.
  - Voice-sample encodes (plan 28 — short auditions) DO NOT apply loudnorm — would add ~20 % latency to every Play-sample click with no listening benefit.
- **Migration story:**
  - Chapters rendered before plan 71 have NO `<slug>.lufs.json` sidecar. Wave 2 plan 77 (report-card UI) must degrade gracefully on missing sidecar — same contract as plan 56's peaks file.
  - No on-disk format change to existing MP3s — the loudnorm filter runs DURING encode, so every newly-rendered chapter is implicitly normalised. Old chapters can be re-rendered to pick up normalisation.
- **Reversibility:** set `AUDIO_LOUDNORM_ENABLED=false` in `server/.env` and re-render. The `.lufs.json` sidecars stay on disk but become stale; the new MP3 has no normalisation.

## Defaults

Audiobook-friendly EBU R128 preset, matches the Audible / ACX submission spec:

| field      | default | meaning                                                          |
| ---------- | ------- | ---------------------------------------------------------------- |
| `target`   | `-16`   | Integrated loudness target (LUFS). ACX accepts `-23 … -18`.      |
| `lra`      | `11`    | Target loudness range (LU). 11 is the audiobook common pick.     |
| `tp`       | `-1.5`  | True-peak ceiling (dBTP). Leaves codec inter-sample headroom.    |
| `twoPass`  | `true`  | Two-pass measure-then-apply (±0.5 LU vs ±1.5 LU for single-pass). |

Exported as `DEFAULT_LOUDNORM_OPTIONS` from `server/src/tts/loudnorm.ts` so the call site and the tests share one source.

## Env var

- `AUDIO_LOUDNORM_ENABLED=false` — opt out per server install. Default is ON (anything other than the literal string `"false"` keeps loudnorm enabled, including unset).
- No frontend toggle in v1 — power users edit `server/.env`. Per-book toggle UI is out of scope (see Out of scope below).

## Sidecar JSON shape

Persisted at `<bookDir>/audio/<chapterSlug>.lufs.json` after every chapter encode that landed a loudnorm pass. Stable contract — Wave 2 plan 77 (LUFS report card) reads these fields back.

```json
{
  "i": -16.02,
  "lra": 8.4,
  "tp": -2.1,
  "target": -16,
  "twoPass": true,
  "measuredAt": "2026-05-20T12:00:00.000Z"
}
```

Fields:

- `i` — measured integrated loudness (LUFS) of the rendered chapter. In two-pass mode this is the POST-normalisation `output_i` parsed from the second-pass loudnorm filter's stderr JSON (per the 2026-05-22 correction below) — i.e. what the chapter actually sounds like after the gain pass, NOT the pre-filter input. In single-pass mode it's the nominal target (single-pass doesn't re-measure post-filter; consumers gate on `twoPass`).
- `lra` — measured loudness range (LU). Post-normalisation `output_lra` in two-pass mode; nominal target in single-pass.
- `tp` — measured true peak (dBTP). Post-normalisation `output_tp` in two-pass mode; nominal target in single-pass.
- `target` — target integrated loudness used for normalisation. Matches `LoudnormOptions.target`.
- `twoPass` — `true` when the measure-then-apply flow ran; `false` when single-pass streaming normalisation ran. Consumers MUST check this before treating `i`/`lra`/`tp` as ground truth — single-pass values are nominal.
- `measuredAt` — ISO-8601 timestamp the measurement was taken (encode time).

Missing sidecar = "this chapter wasn't loudnormed" (legacy / `AUDIO_LOUDNORM_ENABLED=false` / silent-source fallthrough). Consumers degrade to "no data" — the report card UI shouldn't infer a target from absence.

## Silent-source fallthrough

ffmpeg's first-pass loudnorm emits `"input_i": "-inf"` on dead-silent input. The encoder detects non-finite measurements (`isMeasurementUseable` in `loudnorm.ts`) and:

1. Skips the second-pass filter (would receive garbage `measured_*` parameters).
2. Falls through to a plain libmp3lame encode.
3. Does NOT fire the `onLoudnessMeasured` callback — no measurement to record.

The chapter still lands on disk; only the `.lufs.json` sidecar is missing. Real-world trigger: a chapter that's 100 % silent (corrupt sentence data, or a test fixture using `Buffer.alloc(N)` for PCM).

## Invariants to preserve

1. `EncodePcmToAudioOptions.format` stays `'mp3'`-only — plan 28's contract. AAC/Opus add format variants; they do NOT replace the loudnorm field.
2. The voice-sample call site (`server/src/routes/voice-sample.ts:198`) MUST NOT pass `loudnorm` — only chapter audio gets the EBU R128 pass.
3. `<slug>.lufs.json` writes use the temp-then-rename pattern (`writeChapterLufsFile` in `mp3.ts`) — same convention as `writeChapterPeaksFile` (plan 56) and `writeJsonAtomic` (plan 27). No half-written sidecars on crash.
4. The `onLoudnessMeasured` callback fires AFTER a successful encode. A failed encode (ffmpeg non-zero exit) MUST NOT leave a `.lufs.json` sidecar describing audio that never landed on disk.
5. Default values live in `DEFAULT_LOUDNORM_OPTIONS` — one source for the wiring in `generation.ts` and for tests.

## Test plan

### Automated coverage

- `server/src/tts/loudnorm.test.ts` — pure unit + real-ffmpeg integration:
  - `parseLoudnormFirstPassJson` — real-shape ffmpeg JSON, missing fields throw, `-inf` is coerced to `-Infinity` (not thrown), non-numeric non-inf strings throw.
  - `isMeasurementUseable` — true on finite stats, false on `-Infinity` (silent source).
  - `buildSecondPassFilterString` — exact filter string format with all `measured_*` fields + `linear=true:print_format=json` (the JSON form is what `encodePcmToAudio` parses post-encode to persist `output_i` into the sidecar — see 2026-05-22 correction).
  - `parseLoudnormSecondPassJson` — input + output stat fields from a real-shape second-pass JSON block, missing `output_i` throws, `-inf` is coerced, missing `normalization_type` (string field) throws.
  - `isSecondPassMeasurementUseable` — true on finite output stats, false on `-Infinity` (degenerate second pass).
  - `buildSinglePassFilterString` — no `measured_*` fields (single-pass needs no analysis).
  - `runLoudnormFirstPass` (real ffmpeg) — returns finite stats for a non-silent input.
  - `encodePcmToAudio` two-pass (real ffmpeg) — normalised encode is closer to target than baseline encode of the same PCM; `onLoudnessMeasured` fires with `twoPass: true` after a successful encode.
  - `encodePcmToAudio` silent-source two-pass (real ffmpeg) — silent PCM does NOT fire the callback and still produces a playable MP3.
  - `encodePcmToAudio` single-pass (real ffmpeg) — produces a playable MP3 and reports the nominal target as the measurement with `twoPass: false`.
- `server/src/tts/mp3-spawn-args.test.ts` — module-level mock of `node:child_process.spawn`:
  - No `loudnorm` option → no `-af loudnorm` flag in args (back-compat).
  - `twoPass: false` → exactly one ffmpeg spawn with `-af loudnorm=I=-16:LRA=11:TP=-1.5:linear=true`.
  - With loudnorm → every codec builder (mp3 / aac-m4a / opus) emits an output `-ar` between `-af` and `-c:a` matching the input sample rate (locks the 2026-05-21 ffmpeg-8 fix — see "Post-ship correction" below).
- `server/src/tts/mp3.test.ts` — `writeChapterLufsFile` coverage: round-trips payload, atomic rename leaves no `.tmp-*` droppings.

### Manual acceptance walkthrough

Requires a real chapter generation against a live sidecar (or the cached PCM trick from plan 28).

1. **Set `AUDIO_LOUDNORM_ENABLED=true`** (or unset — default is ON) in `server/.env`. Start the server.
2. **Generate a chapter** with mixed voices (the canonical the Coalfall Commission works — multiple speakers per chapter).
3. **Confirm the sidecar lands.** Inspect `<workspace>/<bookId>/audio/<chapterSlug>.lufs.json`:
   - File exists.
   - `target: -16`, `twoPass: true`.
   - `i` is within ±1.0 LU of -16.
4. **Listen and A/B against a non-loudnormed render** (toggle `AUDIO_LOUDNORM_ENABLED=false`, re-render, swap files). The loudnormed chapter should sit at perceptually one volume across speakers; the un-normalised version should have audible per-voice gain swings.
5. **Re-run the same chapter generation** — the `.lufs.json` overwrites atomically. No `.tmp-*` droppings in the audio dir.
6. **Set `AUDIO_LOUDNORM_ENABLED=false`** and regenerate. The new MP3 is unfiltered; the stale `.lufs.json` from step 3 remains on disk (consumers must check the file's `measuredAt` against the audio's mtime to detect staleness — Wave 2 plan 77 territory).

## Out of scope

- **Per-book toggle UI.** v1 is env-var only. Future surface area: a checkbox in the book-meta modal that overrides the env default per book.
- **LUFS report card frontend.** Wave 2 (plan 77 when scaffolded) reads the sidecar JSON and renders a "Loudness drift" card on the listen view. This plan only ships the writer side.
- **Single-pass measurement.** Single-pass mode records the nominal target in the sidecar, not a post-filter re-measurement. Two-pass mode now captures `output_i` from the encoder's stderr JSON (see the 2026-05-22 post-ship correction); single-pass would need a separate post-encode ebur128 pass — out of scope here.
- **Voice-sample normalisation.** Voice samples (auditions) stay unnormalised — would add ~20 % latency to every Play-sample click for no listening benefit.

## Ship notes

Shipped 2026-05-20 on branch `feat/server-audio-loudnorm`. Implementation adds `server/src/tts/loudnorm.ts` (new file, ~220 lines) + extends `server/src/tts/mp3.ts` with the `loudnorm` option + sibling `writeChapterLufsFile`. Generation call site at `server/src/routes/generation.ts` wires `AUDIO_LOUDNORM_ENABLED` (default ON) and the sidecar write callback. Voice-sample call site annotated to make the deliberate skip explicit. 17 new automated tests across `loudnorm.test.ts` (12), `mp3-spawn-args.test.ts` (2), `mp3.test.ts` (3 — `writeChapterLufsFile` coverage).

### Post-ship correction (2026-05-21) — ffmpeg 8.x sample-rate output drift

Bug: 5 chapters of *The Ebb* regenerated on 2026-05-21 produced MP3s with duration **3.05–3.07× the segments.json `durationSec`**. Audio played at correct pitch and ran the full inflated length on disk (verified: `ffprobe 03-chapter-one-one.mp3` = 2061 s vs `segments.json.durationSec` = 674 s). Chapters generated 2026-05-20 with the same engine / sample rate / loudnorm config were unaffected.

Root cause: ffmpeg's `loudnorm` filter resamples internally to 192 kHz for EBU R128 processing. Under ffmpeg 7.x the filter chain reached libmp3lame at the input sample rate; under ffmpeg 8.x (the user upgraded from 7.x to 8.1.1-full_build-www.gyan.dev between the two synth dates) the filter's output stream metadata reached the encoder at the wrong rate, producing the 3.05× duration stretch on 24 kHz mono Kokoro PCM. The MP3 declares 48 kHz / 32 kbps — both wrong (input is 24 kHz, V2 VBR should be ~190 kbps) and both explained by the broken sample-rate pipeline.

Fix: explicit output `-ar String(opts.sampleRate)` in `server/src/tts/mp3.ts` `buildMp3FfmpegArgs` / `buildAacFfmpegArgs` / `buildOpusFfmpegArgs`, threaded between the `-af <filter>` and `-c:a <codec>` flags. The encoder boundary now owns the rate contract regardless of filter-chain behaviour. Filter strings in `loudnorm.ts` unchanged.

Regression test: `server/src/tts/mp3-spawn-args.test.ts` adds three parameterised cases (mp3 / aac-m4a / opus) asserting an output `-ar` flag exists strictly between `-af` and `-c:a` and carries the input sample rate. Contract-level rather than ffprobe-end-to-end because the bug only manifests on real-speech PCM with non-trivial dynamic range — synthetic sine / noise PCM does not reproduce the 3× stretch even on the broken pipeline.

Backfill: re-synthesize the 5 affected The Ebb chapters (`03-chapter-one-one`, `04-chapter-two-two`, `05-chapter-three-three`, `06-chapter-four-four`, `08-chapter-six-six`) and delete their stale `.previous.mp3` rollback files (same corrupted bytes — accepting a rollback would replay the bug). Discovery rule for any future audit: broken iff `ffprobe duration / segments.json durationSec > 1.5`.

### Post-ship correction (2026-05-22) — sidecar `i` was input loudness, not output

Bug: regenerating a chapter shifted its per-chapter LUFS pill (e.g. -21.9 → -21.5 across sibling chapters of a single book) even though every chapter was normalised to -16 LUFS on disk. User-visible symptom: the Loudness Report card flagged every chapter as drifting by ~6 LU from the -16 LUFS target, and the same chapter regenerated twice showed different pill values within ±1 LU.

Root cause: `encodePcmToAudio`'s two-pass branch wrote `stats.input_i` (the pre-filter measurement of the raw PCM) into the `<slug>.lufs.json` sidecar as the `i` field. The second-pass loudnorm filter was correctly normalising the encoded MP3 to ~-16 LUFS, but the sidecar carried the un-normalised input loudness — so the pill displayed the loudness the chapter *would have had* without normalisation, not what it actually sounds like. Per-regen drift was just variance in the per-render synth PCM (different per-sentence gain, silence-gap distribution, VAD trims) — the on-disk MP3 was correct each time.

The bug was acknowledged in this doc's own field definitions ("In two-pass mode this is the FIRST-PASS measurement") and in the Out of scope ("Wave 2 must add a post-encode ebur128 pass") — but Wave 2 plan 77 shipped the report card UI without the post-encode measurement, so the report card classified every chapter as off-target.

Fix: switch the second-pass filter from `print_format=summary` to `print_format=json` and capture the encoder's stderr during the encode. After a successful encode, parse the trailing JSON block via the new `parseLoudnormSecondPassJson` and persist its `output_i` / `output_lra` / `output_tp` (post-normalisation values reported by the filter) into the sidecar. Zero extra ffmpeg invocations — the second-pass encode already runs `loudnorm` end-to-end, we just consume the existing summary output. On any parse failure (missing JSON block, missing `output_i`, non-finite output), the sidecar falls back to the input-side measurement and a `console.warn` fires — the MP3 is already on disk, a parse failure must not fail the encode.

Required adjustment: `loudnorm` filter only emits its summary at `info` log level. The encode builders previously passed `-loglevel error`; with the fix in place we now pass `-loglevel info -nostats` when `loudnormFilter` is set. `-nostats` suppresses the per-frame progress noise that would otherwise drown the JSON block.

Regression tests:
- `loudnorm.test.ts` adds `parseLoudnormSecondPassJson` / `isSecondPassMeasurementUseable` unit coverage and a real-ffmpeg integration test (`sidecar i carries the post-normalisation output loudness near the target`) asserting the sidecar value lands within ±2 LU of -16 (rather than 6+ LU off).
- `mp3-spawn-args.test.ts` adds three two-pass sidecar payload tests: parseable second-pass JSON → sidecar carries `output_i`; malformed stderr (no JSON block) → sidecar falls back to `input_i` with a warning; first-pass-shape JSON (no `output_i`) → same fallback path with a different warning.

Backfill: existing chapters on disk still carry the wrong (input-loudness) sidecar value. The MP3 itself is correct — only the displayed pill is wrong on legacy chapters. `scripts/relufs-existing.mjs` (new in this PR) walks `<workspace>/<bookId>/audio/*.mp3`, runs a one-pass ebur128 measurement on each (cheap — ~3 s per chapter, measurement only, no re-encode), and atomically rewrites the sibling `.lufs.json`. Run once after this fix lands:

```
node scripts/relufs-existing.mjs            # rewrites every book under the configured workspace
node scripts/relufs-existing.mjs --dry-run  # prints planned rewrites without touching disk
node scripts/relufs-existing.mjs --book <bookId>  # restrict to one book
```
