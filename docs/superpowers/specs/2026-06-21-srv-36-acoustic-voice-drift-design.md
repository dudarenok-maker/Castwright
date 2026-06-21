---
status: draft
date: 2026-06-21
topic: srv-36 — acoustic voice-drift detection + threshold calibration
issue: srv-36 (#665)
depends_on: srv-31 (ASR-QA hook + qa-gates settings pattern)
unblocks: fs-51 (#973) per-book QA report — the defensible drift figures
revised: 2026-06-21 (post adversarial review — gated by a measurement spike, v1 descoped)
---

# srv-36 — Acoustic voice-drift detection + calibration

## 0. The reframe (why this is a feature, not a chore)

The srv-36 issue (#665, labelled `type:chore`) asks to "calibrate the
per-chapter voice-drift comparator's placeholder thresholds against a labelled
set of drifted-vs-not chapter **audio**." But the comparator that exists
(`server/src/routes/revisions.ts`) is **not acoustic**: it diffs each chapter's
`characterSnapshots` (voice / engine / gender / ageRange / tone scores, all from
`cast.json` at render time) against the **current** `cast.json`. It fires when
the user **edits the cast after rendering** — a deterministic configuration
diff. Its only tunable knobs are the two tone-score delta cuts
(`TONE_MODERATE = 25`, `TONE_SEVERE = 40`), which compare **LLM-assigned cast
attributes**, not sound. There is no acoustic metric set to calibrate.

So "calibrate the drift thresholds against labelled audio" cannot be done as
written. srv-36 is reframed: **build the acoustic comparator the issue's
language implies, then calibrate it.** This is `type:feature`, Large — the label
needs correcting on the issue.

The existing `revisions.ts` signal stays untouched, renamed **in concept** to
**config drift** ("cast changed since render"). The new signal is **acoustic
drift** ("the audio doesn't match the voice"). They are distinct and coexist
(§6). This unblocks **fs-51** (#973), whose per-book QA report needs a
*defensible* "drift detected" line.

## 1. The central risk this spec is built around

An adversarial review (2026-06-21) found the architecture sound but the
**measurement science unvalidated**. The load-bearing assumptions:

- **R1 — separability headroom.** Calibrating on *wrong-voice* positives
  (a different character) optimises a cutoff between two well-separated speaker
  clusters. That cutoff says nothing about where a *correctly-rendered* voice
  ends and a *slightly-wandering* same voice begins — those share one tight
  cluster. If there is no headroom, identity-drift only ever catches wrong-voice
  (which config-drift already catches) and is blind to subtle drift, **which is
  the entire reason consistency-drift was proposed.**
- **R2 — out-of-domain EER.** ECAPA's published ~0.9% VoxCeleb EER is a
  *real-human* number. TTS output is out-of-domain and TTS voices cluster
  *tighter* than humans (shared vocoder fingerprint); two same-gender presets
  (`af_heart` vs `af_bella`) may be inseparable. The VoxCeleb number is NOT a
  valid calibration anchor.
- **R3 — emotion sensitivity (unmeasured).** Per-sentence emotion (fs-33) and
  per-emotion voice variants (fs-25) exist. If emotion meaningfully shifts the
  embedding, a neutral reference mis-scores every emotional line and a global
  consistency centroid blurs across a deliberately expressive performance,
  flagging the most dramatic lines hardest. If it does not, the per-emotion
  machinery is pure complexity.
- **R4 — short-segment reliability.** ECAPA is high-variance below ~2–3 s.
  Audiobook dialogue is full of sub-second lines (`"No."` `"Run!"`). Scoring
  those produces noise on the most common content.

**None of R1–R4 can be reasoned about from the literature — they must be
measured on this product's own TTS output.** Phase 0 does exactly that and its
results rewrite Phases 1–2. The feature does not proceed to a full build until
Phase 0 passes.

## 2. Phase 0 — measurement spike (GATES the build)

A throwaway measurement harness (committed under `scripts/` or a sidecar test
marked opt-in) that embeds clips from the canonical fixture renders and reports
distributions. **No production code, no settings, no events.** ~2–3 days.

| Experiment | Question (risk) | Decision it gates |
|---|---|---|
| **E1 — separability** | intra-speaker cosine spread (same voice, 50 lines) vs inter-speaker, plus a *graduated* set (correct → prosody-bumped → cross-emotion → wrong-character). In-domain EER. (R1, R2) | Does identity-drift have headroom for *subtle* drift, or only wrong-speaker? If no headroom → descope identity to honest "wrong-speaker detection" and **cut consistency-drift**. |
| **E2 — clip length** | embed the same line truncated to 0.5 / 1 / 2 / 3 / 5 s; cosine variance vs length. (R4) | The minimum **query** duration below which we emit `inconclusive` instead of a score; whether short lines need windowing. |
| **E3 — emotion shift** | one character rendered neutral/angry/sad/whisper; pairwise cosine vs cross-character distance. (R3) | Is emotion-matching mandatory or droppable? Is a global consistency centroid valid or must it be per-emotion? |
| **E4 — preset near-miss** | two same-gender same-accent presets from one engine (`af_*`). (R2) | Whether wrong-voice positives must be drawn from *acoustically distant* pairs only, and which swaps the detector honestly cannot catch. |

**Phase 0 output:** a short findings note (committed) recording the measured
in-domain EER, the min scorable duration, the emotion-shift magnitude, and a
go / descope / no-go recommendation. Phases 1–2 below are written for the
*expected* outcome; the note supersedes them where reality differs.

## 3. Phase 1 — v1 (descoped: identity-only, CPU-only, singleton reference)

The minimum that delivers srv-36's actual ask — a calibratable acoustic
comparator — assuming E1 shows usable headroom.

### 3.1 Embedding engine (sidecar)
**ECAPA-TDNN** (SpeechBrain `spkrec-ecapa-voxceleb`), 192-dim, cosine. A new
`SpeakerEngine` in `server/tts-sidecar/main.py`; endpoint **`POST /embed`**
(audio bytes → `{ embedding, dim, sample_rate }`), modelled on `WhisperEngine` /
`/transcribe`. **Engine-agnostic by construction**: reference and rendered
segment are embedded by the *same* model, so Qwen / Coqui / Kokoro compare on one
axis (their internal speaker reps are never used as embeddings).

- **CPU-only in v1.** `SPK_DEVICE=cpu`, zero VRAM, no semaphore, no watchdog.
  The cuda path + the Node-side VRAM-semaphore plumbing (new `ENGINE_VRAM_COST`
  key, `costForEngine` case, `gpu.weight.spk` registry entry, `spkRunsOnGpu()`
  embed-client) is **Phase 2** — it is ~5 files of work the "mirror ASR" framing
  hides, and CPU is the default/recommended path anyway.
- **Benchmark gate.** Before committing to inline scoring, measure ECAPA
  single-clip CPU latency on the target box (4070-class, not a Xeon) × a real
  book's segment count. The forward pass — not decode — is the cost. If it
  materially slows generation, batch segments or move to a post-pass; do not
  ship "inline + free."
- OFF unless `SEG_SPK_ENABLED`. `speechbrain` (+`huggingface_hub`) ships in
  `requirements/base.txt`; weights fetch on first load (triple SKIP gate when
  absent).

**Sidecar test** `tests/test_speaker_embed.py`: deterministic embedding;
cosine(self,self) ≈ 1; same-speaker-two-utterances > different-speaker;
`asyncio.to_thread` offload (no event-loop block); CPU path needs no CUDA;
SKIP+exit-0 on unbootstrapped venv / absent weights.

### 3.2 Settings (config registry, group `qa-gates`)
Mirrors `qa.asr.enabled` exactly (NOT `tts-engine`):

```ts
{ key: 'qa.speaker.enabled', env: 'SEG_SPK_ENABLED', group: 'qa-gates',
  label: 'Acoustic voice-drift QA',
  help: 'When on, each rendered line is embedded (ECAPA speaker model) and '
      + 'checked for voice-match against the character\'s audition sample. '
      + 'Off by default. Runs on CPU (zero VRAM).',
  type: 'boolean', default: false, apply: 'live', risk: 'low' },

{ key: 'qa.speaker.device', env: 'SPK_DEVICE', group: 'qa-gates',
  label: 'Voice-QA device',
  help: '"cpu" (default) uses zero VRAM and never competes with synthesis. '
      + '"cuda" is faster per line but loads the model under the VRAM budget '
      + '(Phase 2). Changing the device restarts the sidecar.',
  type: 'enum', options: ['cpu', 'cuda'], default: 'cpu',
  apply: 'restart-sidecar', risk: 'medium' },
```

`enabled` is **`apply: 'live'`** (toggling the gate needs no restart — the model
loads lazily on first `/embed`, exactly like ASR); only the **device** knob is
`restart-sidecar`. Env threads through `spawn-sidecar.ts` (`...process.env`
spread) for free.

### 3.3 Reference resolution (singleton, with a duration floor)
Reuse the existing per-character voice sample (`voice-sample-cache.ts`) — a
~12 s render in the character's exact engine+voice, cached by voice-config — as a
**single** reference (no per-emotion set in v1). One addition, sized honestly:

- **Reference duration floor.** ECAPA needs ≥ ~3 s (E2 sets the exact number).
  `buildSampleText` returns char-truncated text and the cache holds an MP3 with
  no duration, so the floor is enforced by **decoding the rendered sample MP3
  once and measuring** (`pcmDurationSec` over decoded PCM); if under floor,
  extend the sample text with the next-longest evidence quotes (no fabricated
  text — preserves the existing rule) and re-render. This is a
  render→measure→maybe-re-render step, not a string helper — budget it as such.
- Reference embedding cached, keyed by voice-config hash. A never-auditioned
  character has its sample minted on first QA pass (audition + QA reuse).
- **Documented limitation (R-circularity):** the reference is itself a render
  from the same engine, so identity-drift measures *"matches the approved
  audition sample,"* NOT *"is acoustically correct."* Engine-systematic
  mis-rendering (the engine renders this voice subtly wrong on every line,
  reference included) is out of scope — that is a synthesis-quality problem.

### 3.4 Detection runtime + storage
- **Identity only, inline during generation**, piggybacking the per-sentence
  ASR-QA pass in `synthesise-chapter.ts` (the per-group PCM is live in
  `results[group.index].pcm` — a second `/embed` consumer there genuinely
  avoids a re-decode; clone the optional `asr` pass as a `spk` pass).
- **Short-segment policy (R4 / E2):** a segment whose voiced duration is below
  the E2 floor is **not scored** — it gets an `inconclusive` verdict, never a
  noisy cosine. Mirrors the ASR gate's `minChars`→`inconclusive` pattern.
- **Storage — sibling file, not `segments.json`.** A 192-float array per
  segment (~1.5–2 KB of JSON each) would bloat `<slug>.segments.json` by
  ~15 MB on a large book — and that file is read **whole** on hot paths that
  ignore embeddings (`revisions.ts:128 loadSegmentsFiles`, the voices/fallback
  collectors). Embeddings persist in a **sibling `<slug>.embeddings.json`**
  (base64-packed Float32, not JSON floats), loaded only by the QA aggregator.
- A Node aggregator turns per-segment identity scores into **acoustic-drift
  events** feeding fs-51.

### 3.5 Verdict model + naming (avoid the `'drift'` collision)
`AsrVerdict` already uses the literal string `'drift'`
(`segment-asr-qa.ts:31`). To avoid two different "drift" verdicts in the QA
layer, the acoustic verdict is **`'voice-match' | 'voice-mismatch' |
inconclusive`** at the segment level, aggregated into events with
`metric: 'identity'`, `cosine`, `threshold`, `severity`, `segmentId`,
`characterId`, `chapterId`. Advisory only — like the srv-27 audio-QA verdict it
badges a line "suspect voice"; it never gates `done` or auto-regens. (Auto-repair
is the gated/paid tier; *detection stays free*.)

### 3.6 Calibration (the srv-36 core)
**Synthetic injection** from `server/src/__fixtures__/the-coalfall-commission.md`,
scripted and committed:

- **Negatives** — characters in their correct assigned voice.
- **Identity positives** — same lines rendered with a *deliberately wrong* voice,
  drawn from **acoustically distant** pairs only (E4 dictates which pairs are
  fair; document the swaps the detector cannot catch).

A calibration script embeds every clip, computes the identity cosine
distribution per class, and picks `mild/moderate/severe` cutoffs that separate
them — anchored to the **measured in-domain EER from Phase 0**, NOT the VoxCeleb
number. Outputs:

1. Calibrated cutoffs, committed as named constants.
2. **A regression test pinning the cutoffs** against committed fixture
   embeddings (normal server tier — see §3.7).
3. **A documented FP/FN rate** on the labelled set, in Ship notes.

### 3.7 Honest CI scope
The synth-and-embed calibration is GPU/weights-bound → **opt-in golden-audio
tier**, not `verify`. The normal-tier pinning test guards against *cutoff-constant
drift* only — it does **not** re-verify calibration correctness, so a change to
the embedding model / injection harness / preprocessing is invisible to normal
CI. This is an accepted limitation, stated plainly: the FP/FN numbers are a
periodic manual artifact, not a per-push gate. (Do not claim "CI-runnable
calibration.")

## 4. Phase 2 — deferred (only after Phase 1 ships + measurements justify)

- **Consistency drift** — only if E1 shows headroom for subtle drift and E3
  validates the anchor. Computed **per-emotion** (or as a *temporal* monotonic-
  wander signal), never as a single global centroid (R3). Requires emotion to be
  persisted first (§5 below).
- **Per-emotion reference sets** (fs-25) + emotion-matched nearest-of-set — only
  if E3 shows emotion materially shifts embeddings AND books actually carry
  variants (today the fixture has **zero**; ~0–2 characters/book in practice —
  YAGNI until proven).
- **Emotion persistence** — `group.emotion` is NOT written to the persisted
  `ChapterSegment` (`synthesise-chapter.ts:1399-1411`); emotion-matching needs it
  threaded into `segments-io.ts` + the generation writer. This is work *inside*
  srv-36's emotion features, not a satisfied `depends_on`.
- **cuda path + `spk:1` VRAM semaphore** — the ~5-file Node plumbing (§3.1).
- **Cross-book (series) consistency** — centroid is book-scoped.
- **Human-rated perceived-drift holdout** — validates that synthetic cutoffs
  match what listeners notice.

## 5. Coexistence with config drift (unchanged)

Acoustic drift is a **separate signal** from `revisions.ts` config drift, not a
replacement:

| Signal | Source | Meaning | fs-51 report line |
|---|---|---|---|
| Config drift | `revisions.ts` | cast edited since this chapter rendered | "cast changes since render" |
| Identity drift | acoustic (v1) | line doesn't match the **approved audition sample** | "voice-match" |
| Consistency drift | acoustic (Phase 2) | character wandered across the render | "voice-consistency" |

## 6. Acceptance (maps to #665)

**Phase 0 (gate):**
- [ ] E1–E4 run on fixture renders; findings note committed with measured
      in-domain EER, min scorable duration, emotion-shift magnitude, and a
      go/descope/no-go call.

**Phase 1 (if Phase 0 ⇒ go):**
- [ ] `SpeakerEngine` + `/embed`, CPU-only; sidecar pytest added; CPU
      latency benchmarked against a real book before inline is committed.
- [ ] `qa.speaker.enabled` (`live`) + `qa.speaker.device` (`restart-sidecar`)
      in group `qa-gates`, defaults off / cpu.
- [ ] Singleton reference with a measured duration floor; `inconclusive` on
      sub-floor query segments; embeddings in a sibling `<slug>.embeddings.json`
      (base64 Float32).
- [ ] Identity scoring inline; Node aggregator emits acoustic-drift events;
      verdict naming avoids the `'drift'` collision.
- [ ] Scripted synthetic-injection labelled set (acoustically-distant positives)
      committed; calibration script produces cutoffs anchored to the Phase-0 EER.
- [ ] Cutoffs pinned by a normal-tier regression test; FP/FN documented in Ship
      notes; the "calibration is not re-verified in normal CI" limitation stated.
- [ ] fs-51 (#973) can consume calibrated identity figures (drop its
      "detected (uncalibrated)" fallback for the voice-match line).

## 7. What the review confirmed is RIGHT

The §0 reframe; advisory-not-gating; engine-agnostic common-axis embedding; the
inline PCM-in-memory claim (no re-decode on the inline path); env threading
through `spawn-sidecar.ts`. These stand.

## 8. Meta / backlog hygiene

- Re-file #665 `type:chore` → `type:feature`; note Large; add a Phase-0 spike
  sub-task.
- Keep its Should placement (Could→Should in the 2026-06-21 triage as a
  credibility dependency for fs-51) and the fs-51 (#973) dependency note current.

## Ship notes

_(filled on ship: date · commit SHA · Phase-0 findings · measured in-domain EER ·
min scorable duration · calibrated cutoffs · FP/FN rate)_
