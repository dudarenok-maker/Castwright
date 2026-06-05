---
status: active
shipped: null
owner: null
---

# 185 — Golden-audio regression harness (ops-11)

> Status: active
> Key files: `server/tts-sidecar/tests/golden/*`, `server/tts-sidecar/run-golden-tests.ps1`, `server/src/tts/golden-assembly.golden.test.ts`, `server/src/tts/__fixtures__/golden-chapter.{pcm,json}`, `server/vitest.config.golden.ts`, `scripts/run-golden-audio.mjs`
> URL surface: none (dev tooling)
> OpenAPI ops: none

## Benefit / Rationale

The five test tiers stub every TTS model and feed trivial 1-sample PCM into the
assembly path, so a regression that changes the **actual audio output** — wrong
length, silence, a voice/version drift, a silent voice fallback, a broken
loudnorm/encode, a text-normalization shift — passes green. This harness is a
deterministic, opt-in gate that synthesizes a fixed fixture and asserts the
output.

- **User:** n/a (dev tooling) — but it protects the audio the listener hears.
- **Technical:** locks the audio-output contract (duration/sample-count within
  tolerance) against engine/sidecar/weights regressions unit tests can't see,
  and the assembly/loudnorm/encode/segments contract on realistic speech.
- **Architectural:** establishes a "golden" tier convention parallel to the
  Playwright visual baselines — committed baselines + a `--bless` reproduce path
  + SKIP-gating for boxes without models. Surfaces silent voice fallback as an
  assertable signal for the first time.

## Architectural impact

Two layers, one opt-in orchestrator (`npm run test:golden-audio` →
`scripts/run-golden-audio.mjs`). **Never wired into `test:all` / `verify` /
pre-push** — run on demand only (see Invocation guide). Only the cheap
pure-logic unit tests ride in the normal tiers.

- **Suite A — model golden (GPU, SKIP-gated).** `server/tts-sidecar/tests/golden/`
  pytest, marked `@pytest.mark.golden` (the fast `test:sidecar` tier runs
  `-m "not golden"`). Loads the real `KokoroEngine`, asserts each fixture line's
  sample-count vs `kokoro-baseline.json` within `tolerance` (default 5%), a
  not-silent RMS guard, no voice substitution, and a determinism double-run.
  `test_cross_engine_sanity.py` adds loose format/non-silent/plausible-duration
  checks for Coqui + Qwen behind explicit env opt-ins (`GOLDEN_COQUI=1`,
  `GOLDEN_QWEN_VOICE=<id>`). `run-golden-tests.ps1` triple-gates (venv / pytest /
  Kokoro weights) and SKIP+exit-0 when any is absent.
- **Suite B — assembly golden (GPU-free, runs in CI when invoked).** A committed
  recorded-Kokoro-PCM fixture (`server/src/tts/__fixtures__/golden-chapter.{pcm,json}`,
  captured by `capture_assembly_fixture.py`) is fed through a stub `TtsProvider`
  → real `synthesiseChapter` → real `finalizeChapterAudioWrite` (real ffmpeg
  2-pass loudnorm). Asserts segment count + per-segment boundaries + total
  duration + LUFS-in-band + segments.json shape + `evaluateSegmentPcm` ok. Lives
  in `*.golden.test.ts`, EXCLUDED from the default `test:server` and run via
  `server/vitest.config.golden.ts`.

- **New seams:** optional `voiceSubstitutedFrom` on `SynthesizeOutput`
  (`server/src/tts/index.ts`) + on `ChapterSegment`
  (`server/src/tts/synthesise-chapter.ts`); the sidecar's
  `X-Voice-Substituted-From` header now flows to the segment instead of being
  only `console.warn`'d. The `golden` pytest marker (registered in `conftest.py`).
- **Invariants preserved:** raw 16-bit LE mono PCM contract (`pcm.ts`); the
  segment build still assembles in index order. `voiceSubstitutedFrom` is additive
  + optional → backwards-compatible with persisted `segments.json` and the
  frontend `ChapterSegment` (derived from `ChapterAudio['segments']`, unchanged).
- **Reversibility:** delete the golden dir + the three npm scripts + the config;
  the optional field is inert if unread.

## Invariants to preserve

1. The golden tier is opt-in — `npm run verify` must NOT run any `@golden` pytest
   or any `*.golden.test.ts`. Enforced by `run-tests.ps1`'s `-m "not golden"` and
   the `src/**/*.golden.test.ts` exclude in `server/vitest.config.ts`.
2. Suite A asserts on duration / sample-count within tolerance, NEVER a raw PCM
   content hash (ONNX sample VALUES drift across GPU/driver/hardware; LENGTH is
   portable). `compare.py:compare_to_baseline`.
3. `kokoro-baseline.json` records `metadata.model_sha256` + `kokoro_onnx_version`
   so an intentional weights upgrade is legible.
4. Suite B is GPU-free — the recorded-PCM fixture is committed; no test in this
   harness synthesizes through a real model except Suite A.

## Test plan

### Automated coverage

- Pytest sidecar (`tests/golden/test_golden_compare.py`) — the tolerance/RMS
  comparison maths (no model; runs in the normal fast `test:sidecar` tier).
- Pytest sidecar `@golden` (`tests/golden/test_golden_regression.py`) — Kokoro
  length-vs-baseline + not-silent + no-substitution + determinism (real model;
  opt-in).
- Pytest sidecar `@golden` (`tests/golden/test_cross_engine_sanity.py`) — Coqui +
  Qwen format/non-silent/duration (real models; env-gated opt-in).
- Vitest server (`server/src/tts/sidecar.test.ts`) — `voiceSubstitutedFrom`
  surfaced from the header (and omitted when absent).
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — the segment
  carries `voiceSubstitutedFrom` on a provider fallback, undefined on a clean
  render.
- Vitest server `*.golden.test.ts` (`server/src/tts/golden-assembly.golden.test.ts`)
  — the GPU-free assembly + real-ffmpeg encode contract (opt-in).

### Manual acceptance walkthrough

1. **Fast tiers stay model-free:** `npm run test:sidecar` (golden compare unit
   green, the `@golden` tests deselected) and `npm run test:server` (the fallback
   plumbing units green, `*.golden.test.ts` excluded).
2. **Suite B, no GPU:** `npm run test:golden-audio:assembly` → 2 tests green
   through real ffmpeg.
3. **Suite A, box with Kokoro weights:** `npm run test:golden-audio:sidecar` →
   Kokoro golden + determinism green; cross-engine SKIP without their env flags.
4. **Bless after a fixture/model change:** `npm run test:golden-audio -- --bless`
   rewrites `kokoro-baseline.json`; commit it. Re-capture the Suite B fixture with
   `capture_assembly_fixture.py` if its segment set changes.
5. **Regression proof:** perturb a fixture line / a Kokoro voice → Suite A red
   with a per-line mismatch; corrupt the recorded PCM to silence → Suite B red via
   `evaluateSegmentPcm`; force a substitution → both red.

## Invocation guide — when to run which

| You changed… | Run |
|---|---|
| Node assembly/encode path (`synthesise-chapter.ts`, `finalize-chapter-write.ts`, `mp3.ts`, `segment-qa.ts`, `pcm.ts`) | `npm run test:golden-audio:assembly` (GPU-free) |
| Sidecar engine/synth code (`main.py` engines, voice mapping) | `npm run test:golden-audio:sidecar` (box with weights) |
| Voice-mapping / fallback plumbing | `npm run test:golden-audio` (both) |
| Nothing audio-specific | nothing — the cheap pure-logic units ride in the normal tiers |
| Before a release / after an intentional model-weights upgrade | `npm run test:golden-audio`, then `--bless` |

## Out of scope

- ASR content verification ("fluent but wrong words") — that's `srv-31` (#508),
  building on plan 179's `segment-qa.ts`.
- A CI `workflow_dispatch` job that downloads Kokoro weights to run Suite A in the
  cloud — deliberately not built (the harness is run on demand on a dev box;
  Suite B already runs GPU-free wherever it's invoked).

## Ship notes

(Filled when status → stable. Owed: live re-bless of `kokoro-baseline.json` +
`golden-chapter.{pcm,json}` is already done on the maintainer's GPU box at author
time; cross-engine sanity (Coqui/Qwen) acceptance under their env flags remains.)
