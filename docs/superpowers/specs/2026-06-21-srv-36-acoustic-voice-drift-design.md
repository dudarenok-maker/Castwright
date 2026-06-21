---
status: draft
date: 2026-06-21
topic: srv-36 — acoustic voice-drift detection + threshold calibration
issue: srv-36 (#665)
depends_on: fs-33 (per-sentence emotion), fs-25 (per-emotion Qwen variants), srv-31 (ASR-QA hook)
unblocks: fs-51 (#973) per-book QA report — the defensible drift figures
---

# srv-36 — Acoustic voice-drift detection + calibration

## 0. The reframe (why this is a feature, not a chore)

The srv-36 issue (#665, labelled `type:chore`) asks to "calibrate the
per-chapter voice-drift comparator's placeholder thresholds against a labelled
set of drifted-vs-not chapter **audio**." But the comparator that actually
exists (`server/src/routes/revisions.ts`) is **not acoustic**: it diffs each
chapter's `characterSnapshots` (voice / engine / gender / ageRange / tone
scores, all from `cast.json` at render time) against the **current**
`cast.json`. It fires when the user **edits the cast after rendering** — a
deterministic configuration diff. Its only tunable knobs are the two
tone-score delta cuts (`TONE_MODERATE = 25`, `TONE_SEVERE = 40`), which compare
**LLM-assigned cast attributes**, not sound. There is no acoustic metric set to
calibrate.

So "calibrate the drift thresholds against labelled audio" cannot be done as
written. srv-36 is therefore reframed: **build the acoustic comparator the
issue's language implies, then calibrate it.** This is `type:feature`, Large —
the label needs correcting when the issue is updated.

The existing `revisions.ts` signal stays untouched, renamed **in concept** to
**config drift** ("cast changed since render"). The new signal is **acoustic
drift** ("the audio doesn't match the voice"). They are distinct and coexist
(§6).

This unblocks **fs-51** (#973), whose per-book QA report needs a *defensible*
"drift detected" line; until srv-36 lands fs-51 must surface drift as
"detected (uncalibrated)."

## 1. What we measure — two metrics

| Metric | Compares | Catches | Reference |
|---|---|---|---|
| **Identity drift** | each rendered segment's embedding vs the character's **reference set** | wrong-voice / silent fallback (Qwen→Kokoro) / garbled or bled lines | external (§4) |
| **Consistency drift** | each segment vs the character's own cross-book **centroid** | long-render voice *wander* even when config is unchanged | self (no external ref) |

Each produces an independent `mild | moderate | severe` event at calibrated
cosine cutoffs (§6). They are reported separately — a line can be on-identity
but inconsistent, or vice-versa.

## 2. Embedding model + sidecar engine

**ECAPA-TDNN** (SpeechBrain `spkrec-ecapa-voxceleb`), 192-dim embeddings,
cosine similarity. Chosen for its published VoxCeleb EER (~0.9%), which gives a
principled calibration anchor rather than guessed cutoffs, and its
field-standard "industry speaker-verification" provenance for the marketing
claim. Cost: adds `speechbrain` (+`huggingface_hub`) to the sidecar.

It is a **new analysis engine**, modelled exactly on the Whisper ASR engine
(srv-31 / plan 186) — NOT a member of the synth `ENGINES` map:

- New `SpeakerEngine` in `server/tts-sidecar/main.py`; endpoint **`POST /embed`**
  (audio bytes → `{ embedding: number[], dim: 192, sample_rate }`), mirroring
  `/transcribe`.
- **Engine-agnostic by construction**: both the reference and every rendered
  segment are embedded by the *same* ECAPA model, so Qwen / Coqui / Kokoro are
  compared on one common axis. Their internal speaker reps (Qwen `.pt`, Coqui
  latent) are NOT comparable across engines and are never used as embeddings.
- **CPU-first.** Default `SPK_DEVICE=cpu` → zero VRAM, never competes with
  synth. Opt-in `cuda` loads the ~20 MB model under the weighted VRAM semaphore
  (`spk:1`) + an idle-evict watchdog (`SPK_IDLE_TTL`, mirrors the Whisper /
  Qwen-VoiceDesign watchdogs). ECAPA and Qwen VoiceDesign never co-reside
  (design = cast-review; QA = generation), same rule as ASR.
- **OFF unless enabled** (`SEG_SPK_ENABLED`, §3). `speechbrain` ships in
  `requirements/base.txt`; only the model weights fetch on first load (triple
  SKIP gate when absent, like the golden-audio tiers).

### Sidecar tests (required)
`server/tts-sidecar/tests/test_speaker_embed.py` — embedding is deterministic
for identical input; cosine(self, self) ≈ 1; cosine of two different speakers
< cosine of same-speaker-two-utterances; `/embed` is offloaded via
`asyncio.to_thread` (no event-loop block, mirrors `test_concurrent_synthesis`);
CPU path needs no CUDA. SKIP+exit-0 on an unbootstrapped venv / absent weights.

## 3. User-facing device + enable settings (config registry)

Both knobs are registered in `server/src/config/registry.ts` so they surface in
the existing settings UI with label + help, no env editing. Precedent:
`tts.coqui.device`.

```ts
{ key: 'qa.speaker.device', env: 'SPK_DEVICE', group: 'tts-engine',
  label: 'Voice-QA device',
  help: 'Device for the ECAPA speaker-verification model behind acoustic '
      + 'voice-drift QA. "cpu" (default) uses zero VRAM and never competes '
      + 'with synthesis; "cuda" is faster per line but loads the ~20 MB model '
      + 'under the VRAM budget. Changing this restarts the sidecar.',
  type: 'enum', options: ['cpu', 'cuda'], default: 'cpu',
  apply: 'restart-sidecar', risk: 'medium' },

{ key: 'qa.speaker.enabled', env: 'SEG_SPK_ENABLED', group: 'tts-engine',
  label: 'Acoustic voice-drift QA',
  help: 'When on, every rendered line is embedded and checked for voice-match '
      + '(vs the character\'s sample) and consistency. Off by default. '
      + 'Runs on the Voice-QA device above. Changing this restarts the sidecar.',
  type: 'boolean', default: false,
  apply: 'restart-sidecar', risk: 'medium' },
```

The sidecar reads `SPK_DEVICE` at model load (same pattern as
`COQUI_DEVICE` / `QWEN_DEVICE`). Default-CPU means the feature is safe to enable
on any box without a VRAM hit.

## 4. Reference resolution (identity)

The identity reference reuses the **existing per-character voice sample**
(`server/src/tts/voice-sample-cache.ts`) — already a ~12 s render in the
character's exact engine+voice, cached deterministically by voice-config, with
`buildSampleText` feeding it the character's **longest real evidence quote**.
Two additions:

1. **Minimum-duration guarantee.** `buildSampleText` may yield a short clip
   when the longest real quote is short ("even if it's short" — its own
   comment), and ECAPA wants ≥ ~3 s of speech for a stable embedding. A new
   helper targets **≥ 5 s of speech**: concatenate the next-longest evidence
   quotes (newline-joined, no fabricated text — preserving the existing
   "never pad with invented text" rule) and only fall back to the canned
   script when evidence is genuinely empty. Measured on the rendered audio's
   duration, not char count.

2. **Per-emotion reference SET (Qwen).** fs-25 gives a Qwen character
   `overrideTtsVoices.qwen.variants` — a map keyed by emotion, each a distinct
   designed `.pt` with its own cached sample. The reference becomes a **set**:
   the base sample embedding + one per emotion variant. Coqui / Kokoro (no
   per-emotion designs) have a singleton set.

3. **Emotion-matched comparison.** A rendered segment carries an annotated
   emotion (fs-33). Identity drift = cosine distance to the **emotion-matched**
   reference embedding; **nearest-of-set** when no variant matches that
   emotion. This makes identity robust to *legitimate* emotional variation — a
   genuinely angry line is scored against the angry reference, not falsely
   flagged for differing from a neutral one.

Reference embeddings are computed once and **cached, keyed by the
voice-config hash** (engine + voiceId/voiceUuid + per-emotion variant name).
A character never auditioned has its sample minted on the first QA pass — the
artifact does double duty (audition playback + QA reference). Voice-config
change busts the cache (new hash) and the reference re-embeds.

## 5. Detection runtime + storage

- **Per-segment, inline during generation**, piggybacking the existing
  per-sentence **ASR-QA hook** (`server/src/tts/segment-asr-qa.ts`): the
  rendered PCM is already in memory there, so no second decode. When
  `SEG_SPK_ENABLED`, the segment is sent to `/embed` alongside the ASR
  transcription.
- The per-segment **embedding + identity score + (emotion used)** persist in
  `<slug>.segments.json`, beside the ASR verdict and `characterSnapshots`
  (extends `segments-io.ts`).
- **Consistency** needs the character centroid, so it runs as a **cheap
  post-pass** once all of a character's segments in the book are embedded:
  centroid = mean of that character's segment embeddings; each segment's
  consistency score = cosine to the centroid; outliers (calibrated cutoff)
  emit consistency events. Centroid is per-character, cross-chapter
  (book-scoped).
- A Node aggregator turns per-segment scores into **acoustic-drift events**
  (shape in §6) that feed fs-51's report.

## 6. Event model + coexistence with config drift

Acoustic drift is a **separate signal** from `revisions.ts` config drift, not a
replacement. Two honest, non-overlapping meanings:

| Signal | Source | Meaning | fs-51 report line |
|---|---|---|---|
| Config drift | `revisions.ts` | cast edited since this chapter rendered | "cast changes since render" |
| Identity drift | acoustic (new) | line doesn't match the character's voice | "voice-match" |
| Consistency drift | acoustic (new) | character wandered across the render | "voice-consistency" |

Acoustic events get their own type rather than overloading `DriftEvent`
(distinct fields: `metric: 'identity' | 'consistency'`, `cosine`, `threshold`,
`emotionUsed?`, `segmentId`, `characterId`, `chapterId`,
`severity`). They are advisory — like the srv-27 audio-QA verdict, they badge a
line as "suspect voice" and never gate `done` or auto-regen. (Auto-repair is
the gated/paid tier per the monetisation split; *detection stays free*.)

## 7. Calibration — the srv-36 core

**Synthetic injection** from the canonical fixture
`server/src/__fixtures__/the-coalfall-commission.md`, fully scripted and
committed so the calibration is reproducible and CI-runnable:

- **Negatives** — characters rendered in their **correct** assigned voice.
- **Identity positives** — the same lines rendered with a **deliberately wrong**
  voice (another character's / a mismatched preset). Ground-truth "this is the
  wrong speaker."
- **Consistency positives** — a **mid-chapter voice swap** (first half voice A,
  second half voice B for one character). Ground-truth "this character wandered."

A calibration script embeds every clip, computes identity + consistency cosine
distributions for the labelled classes, and picks the cutoffs that best
separate them (Youden's J / target FP rate); ECAPA's published EER
sanity-anchors the absolute scores. Outputs:

1. **The calibrated cutoffs** — `mild / moderate / severe` for each metric,
   committed as named constants (replacing today's placeholder pattern).
2. **A regression test pinning the cutoffs** — fails if a code change shifts
   the labelled-set verdicts (acceptance bullet 2).
3. **A documented FP / FN rate** on the labelled set, written into this plan's
   Ship notes and the QA docs (acceptance bullet 3).

This satisfies all three srv-36 acceptance bullets (labelled set
committed/scripted · cutoffs pinned by a regression test · FP/FN documented).
*Caveat surfaced honestly:* synthetic drift may not perfectly equal
*perceived* drift; a small human-rated holdout is a noted follow-up, not part of
this delivery.

### Calibration test placement
The synth-and-embed calibration is GPU/weights-bound, so it lives in the
**opt-in golden-audio tier** (like `test:golden-audio:sidecar`) — NOT in
`verify`. The lightweight regression test that pins the *already-calibrated*
cutoffs against committed fixture embeddings runs in the normal server tier.

## 8. Out of scope (this delivery)

- Human-rated perceived-drift holdout (follow-up).
- Auto-repair / auto-regen on acoustic drift (gated tier; detection only here).
- Surfacing the report itself — that is **fs-51**; srv-36 produces the
  calibrated numbers and events fs-51 renders/exports.
- Cross-*book* (series) consistency — centroid is book-scoped here.

## 9. Acceptance (maps to #665)

- [ ] `SpeakerEngine` + `/embed` in the sidecar, CPU-first, semaphore + idle
      watchdog; sidecar pytest added.
- [ ] `qa.speaker.device` (default cpu) + `qa.speaker.enabled` (default off)
      registered and surfaced in settings.
- [ ] Reference resolution: ≥5 s guarantee + per-emotion set + emotion-matched
      nearest-of-set comparison; reference embeddings cached by voice-config hash.
- [ ] Per-segment identity + post-pass consistency scoring persisted in
      `segments.json`; Node aggregator emits acoustic-drift events.
- [ ] Scripted synthetic-injection labelled set committed; calibration script
      produces cutoffs.
- [ ] Calibrated cutoffs pinned by a regression test.
- [ ] FP / FN rate documented in Ship notes.
- [ ] fs-51 (#973) can consume calibrated drift figures (its
      "detected (uncalibrated)" fallback can be removed).

## 10. Meta / backlog hygiene

- Re-file #665 from `type:chore` → `type:feature`; note Large.
- It already sits Should (Could→Should promotion in the 2026-06-21 triage as a
  credibility dependency for fs-51).
- Keep the dependency note on fs-51 (#973) current.

## Ship notes

_(filled on ship: date · commit SHA · calibrated cutoffs · FP/FN rate)_
