---
status: draft
date: 2026-06-21
topic: srv-36 — acoustic render-integrity check (was "voice-drift") + calibration
issue: srv-36 (#665)
depends_on: srv-31 (ASR-QA hook + qa-gates settings pattern)
phase2_internal: fs-33 (emotion persistence), fs-25 (per-emotion variants) — Phase-2 work INSIDE srv-36, not external blockers
relates_to: fs-51 (#973) — srv-36 OPTIONALLY enriches it; fs-51 is NOT blocked on srv-36 (see §0.1)
revised: 2026-06-21 (4th pass — drift is a non-deterministic phenomenon: spike measures Qwen/Coqui stochastic floor + REAL misfires from the existing QA gates, no synthetic injection; Kokoro out of scope; gate decided by residual value over ASR+audio-QA)
---

# srv-36 — Acoustic render-integrity check + calibration

## 0. The reframe (why this is a feature, not a chore)

The srv-36 issue (#665, labelled `type:chore`) asks to "calibrate the
per-chapter voice-drift comparator's placeholder thresholds against a labelled
set of drifted-vs-not chapter **audio**." But the comparator that exists
(`server/src/routes/revisions.ts`) is **not acoustic**: it diffs each chapter's
`characterSnapshots` (voice / engine / gender / ageRange / tone scores, from
`cast.json` at render time) against the **current** `cast.json`. It fires when
the user **edits the cast after rendering** — a deterministic configuration
diff. Its only tunable knobs are two tone-score delta cuts
(`TONE_MODERATE = 25`, `TONE_SEVERE = 40`) over **LLM-assigned attributes**, not
sound. There is no acoustic metric set to calibrate.

So "calibrate the drift thresholds against labelled audio" cannot be done as
written. srv-36 is reframed: **build the acoustic check the issue's language
implies, then calibrate it** — but with a hard gate that proves it measures
something the existing config-drift detector cannot (§1, §2). This is
`type:feature`, Large.

### 0.1 What this is NOT (the redundancy trap)

Two earlier drafts called this "voice-drift detection." Adversarial review
(2026-06-21, two passes) showed that framing hides a fatal overlap:
**config-drift already deterministically knows when the cast/voice config
changed.** An acoustic detector calibrated to separate *different characters*
(`af_heart` vs `bm_george`) catches only that easy case — which config-drift
already has — and is blind to the subtle, same-config residue that would
justify it.

So v1 is **not** "voice-drift detection." It is a **render-integrity check**:
*did the engine produce audio acoustically consistent with this character's
approved audition sample?* Its target is the failure modes config-drift is
structurally blind to, because the config is unchanged and correct:

- **silent engine fallback** (Qwen→Kokoro) whose audio no longer matches the
  approved Qwen sample (config-drift records `renderedFallbackEngine` in the
  snapshot but emits **no drift event** for it — verified: `revisions.ts`
  compares the *configured* `snapshot.voiceEngine`, not the fallback);
- **voice bleed** (another character's timbre leaks into a line),
- **garbled / glitched renders** that still carry roughly the right words,
- the **wrong preset** actually reaching synth despite a correct config (engine
  bug, not a config diff).

Whether ECAPA can actually separate these *same-intended-voice* defects from
clean renders is **unproven** and is the entire question Phase 0 answers
(§2). If it can't, srv-36 is a **no-go** (§2.2), not a descope — a detector
that only flags different-character swaps adds nothing over config-drift.

### 0.2 fs-51 is decoupled (a Must cannot hang off a maybe)

fs-51 (#973) is a **Must**. Phase 0 may return no-go. Therefore **fs-51 is NOT
blocked on srv-36.** fs-51 ships its per-book QA report on the QA signals that
already exist and are genuinely defensible: **ASR-verified content-QA** (srv-31),
**acoustic audio-QA** (srv-27, near-silent / clipped / duration), and
**config-drift** (`revisions.ts`). The render-integrity "voice-match" line is a
**conditional enrichment row** that appears only if srv-36 reaches Phase-1 ship.
This spec's only fs-51 obligation: if it goes, emit events fs-51 can render; if
it no-goes, fs-51 is unaffected.

## 1. The central risk this spec is built around

**Drift is a non-deterministic phenomenon.** A deterministic engine renders the
same (voice, text) to identical audio — it *cannot* drift, so there is nothing
acoustic to check. Kokoro (deterministic ONNX) is therefore **out of scope**.
The render-integrity check exists for the **stochastic engines — Qwen and Coqui
XTTS** (both unseeded) — where the *same correctly-configured voice* occasionally
renders **wrong**: off-timbre, voice-bled, or degraded, with the config
unchanged. That misfire is the model's own random output; it **cannot be injected
on demand** (no seed surface), so the spike measures real model behaviour, not
synthetic defects.

The load-bearing risks — none answerable from the literature; all must be
measured on this product's own Qwen/Coqui output:

- **R1 — the stochastic floor.** A correct voice already varies render-to-render
  (unseeded sampler). Is that natural spread tight enough that a genuine misfire
  is distinguishable in ECAPA space — or does the floor already swamp it? If the
  floor swamps it, no acoustic check can ever work.
- **R2 — real-defect separability.** Measured on **real misfires** (not injected),
  does ECAPA cosine-to-reference separate them from clean renders *above the R1
  floor*? (ECAPA's ~0.9% VoxCeleb EER is a real-human number and is **not** a
  valid anchor — TTS voices cluster tighter; measure in-domain.)
- **R3 — residual value over existing gates (the existential one).** The pipeline
  already flags many bad renders via **ASR content-QA** (wrong words) and
  **audio-QA** (near-silent/clipped/duration). Does acoustic catch **drift they
  miss** — voice wrong, *words right and audio clean*? If it only re-flags what
  those gates already catch, it is **redundant → no-go**.
- **R4 — short-segment reliability & coverage.** ECAPA is high-variance below
  ~2–3 s; audiobook dialogue is dominated by short lines, so a duration floor
  risks marking the *majority of character lines* `inconclusive`.

## 2. Phase 0 — stochastic-drift spike (a GATE that can say no)

A throwaway harness (committed under `scripts/` or an opt-in sidecar test) that
over-generates the canonical fixture on the **stochastic engines**, embeds with
ECAPA, and measures real behaviour. **No production code, no settings, no events,
no synthetic injection.** Real drift only appears at volume, so the spike needs a
**decent over-generation run** (render every fixture line many times per engine).
The findings note supersedes Phases 1–2 wherever reality differs.

### 2.0 Reference under stochasticity
Because the engine is stochastic, a *single* correct render is itself noisy. The
per-character reference is the **centroid of K correct renders** (K from F1) of
the character's audition sample — averaging out the sampler's noise to get a
stable "what this voice is" anchor. How large K must be for a stable centroid is
itself an F1 output.

| Exp | Question (risk) | What it gates |
|---|---|---|
| **F1 — stochastic floor** | Render the *same* line N times, and one character across its lines, all correctly configured (Qwen AND Coqui). Distribution of cosine-to-centroid for a *correct* voice. (R1) | The noise floor; the centroid size K; **kill-switch** — if the floor is wide, no-go immediately. |
| **F2 — harvest real misfires** | Over-generate the fixture; collect the lines the **existing ASR-QA + audio-QA gates flag** as bad. These are real drift labels, free. Record per engine. (R3 input) | The real labelled positive set — no injection. |
| **F3 — real-defect separability** | Does ECAPA cosine-to-centroid separate the F2 misfires from clean renders, *above the F1 floor*? In-domain EER on real labels. (R2) | Whether acoustic detects real drift at all. |
| **F4 — residual value over existing gates** | Of the lines ECAPA flags (low cosine), which did **ASR + audio-QA NOT** flag (words right, audio clean)? A human spot-listens this set: are they real voice drift? (R3) | **The go/no-go** (§2.1). |
| **F5 — clip length & coverage** | cosine-to-centroid variance vs clip length (0.5–5 s) on real renders; fraction of character segments below the candidate floor. (R4) | min scorable duration; checked-coverage %; whether windowing is mandatory. |

### 2.1 Go condition (Phase 1 proceeds)
Anchored to measurement, not round numbers:

- **F1 floor is tight** — a correct voice's cosine-to-centroid clusters with a
  spread clearly narrower than the gap to F2 misfires (a necessary condition; a
  wide floor is an immediate no-go); AND
- **F3 separates real misfires** above that floor (in-domain EER below a stated
  ceiling on the real F2 labels); AND
- **F4 shows residual value** — a non-trivial fraction of ECAPA-flagged lines were
  **missed by ASR + audio-QA** and human listening confirms they are real voice
  drift (not false positives); AND
- **F5 coverage** above a stated bar (windowing if needed).

The decisive criterion is **F4**: acoustic must catch drift the existing gates
miss. Re-flagging only what ASR/audio-QA already catch is redundancy, not value.

### 2.2 No-go (srv-36 is abandoned — a real outcome, not a descope)
If F1's floor is too wide (correct renders scatter as much as misfires), OR F3
can't separate real misfires, OR **F4 shows acoustic only re-flags what ASR +
audio-QA already catch** (no residual value), srv-36 closes **wont-fix-acoustic**:
#665 reverts to "config-drift + ASR + audio-QA ARE the QA signals; an acoustic
voice layer adds nothing," and fs-51 ships on those existing signals (§0.2) with
**no** voice-match row. The findings note's recommendation is exactly one of
`{ go, no-go }`.

### 2.3 #665's literal ask, resolved in BOTH branches
#665 literally asks to *calibrate the comparator's thresholds*. The reframe
builds a new acoustic check instead, so the **config-drift tone cuts
(`TONE_MODERATE = 25` / `TONE_SEVERE = 40`) stay uncalibrated under both go and
no-go.** That loop is closed explicitly, not silently dropped: those cuts gate an
**advisory-only, low-stakes** signal (config-drift never blocks `done`), so this
spec **declares them good-enough-as-placeholder and retires the config-threshold
calibration** — or, if the user prefers, re-files it as a separate low-priority
chore. Either way #665 does not leave a dangling calibration ask. Recorded in §8.

## 3. Phase 1 — v1 render-integrity check (only if Phase 0 = go)

Identity-style scoring of each rendered segment against the character's approved
audition sample. CPU-only, singleton reference.

### 3.1 Embedding engine (sidecar)
**ECAPA-TDNN** (SpeechBrain `spkrec-ecapa-voxceleb`), 192-dim, cosine. New
`SpeakerEngine` in `server/tts-sidecar/main.py`; endpoint **`POST /embed`**
(audio → `{ embedding, dim, sample_rate }`), modelled on `WhisperEngine` /
`/transcribe`. **Engine-agnostic**: reference and rendered segment use the
*same* model (Qwen/Coqui/Kokoro on one axis; internal speaker reps never used).

- **CPU-only in v1.** `SPK_DEVICE=cpu`, zero VRAM, no semaphore, no watchdog.
  The cuda path + Node-side VRAM-semaphore plumbing (new `ENGINE_VRAM_COST` key,
  `costForEngine` case, `gpu.weight.spk` registry entry, `spkRunsOnGpu()`
  embed-client — ~5 files the "mirror ASR" framing hides) is **Phase 2**.
- **Benchmark gate (decides inline vs post-pass — see §3.4).** Measure ECAPA
  single-clip CPU latency on the target box (4070-class) × a real book's segment
  count *before* committing the runtime. The forward pass, not decode, is the
  cost.
- OFF unless `SEG_SPK_ENABLED`. `speechbrain` (+`huggingface_hub`) in
  `requirements/base.txt`; weights fetch on first load (triple SKIP gate).

**Sidecar test** `tests/test_speaker_embed.py`: deterministic embedding;
cosine(self,self) ≈ 1; same-speaker-two-utterances > different-speaker;
`asyncio.to_thread` offload; CPU needs no CUDA; SKIP+exit-0 on absent
venv/weights.

### 3.2 Settings (config registry, group `qa-gates`)
Mirrors `qa.asr.enabled`:

```ts
{ key: 'qa.speaker.enabled', env: 'SEG_SPK_ENABLED', group: 'qa-gates',
  label: 'Render-integrity QA (voice match)',
  help: 'When on, each rendered line of sufficient length is embedded (ECAPA '
      + 'speaker model) and checked for acoustic match against the character\'s '
      + 'voice centroid, flagging stochastic misfires. Off by default. CPU (zero VRAM).',
  type: 'boolean', default: false, apply: 'live', risk: 'low' },

{ key: 'qa.speaker.device', env: 'SPK_DEVICE', group: 'qa-gates',
  label: 'Voice-QA device',
  help: '"cpu" (default) uses zero VRAM and never competes with synthesis. '
      + '"cuda" is faster per line but loads the model under the VRAM budget '
      + '(Phase 2). Changing the device restarts the sidecar.',
  type: 'enum', options: ['cpu', 'cuda'], default: 'cpu',
  apply: 'restart-sidecar', risk: 'medium' },
```

`enabled` is **`apply: 'live'`** (lazy model load on first `/embed`, like ASR);
only **device** is `restart-sidecar`. Env threads through `spawn-sidecar.ts`
(`...process.env`) for free.

### 3.3 Reference resolution (stochastic centroid, bounded duration floor)
Because the engines are stochastic (§1), a single render is itself noisy, so the
reference is the **centroid of K correct renders** (K from Phase-0 F1) of the
per-character voice sample (`voice-sample-cache.ts`) — a ~12 s render in the
character's exact engine+voice. The centroid averages out the sampler's noise
into a stable "what this voice is" anchor; each rendered segment is scored by
cosine to it. The duration floor (F5 sets the number, ~3 s) applies to the
renders that form the centroid:

- Decode the rendered sample MP3 once and measure (`pcmDurationSec` over decoded
  PCM — the cache holds an MP3 with no stored duration). If under floor, **extend
  the sample text with the next-longest evidence quotes** (no fabricated text —
  preserves the existing rule) and re-render. This is a render→measure→re-render
  step, budgeted as such.
- **Bounded terminal case (F5):** if **all** available evidence quotes
  concatenated still render under floor, accept the best-effort reference and
  stamp the character `reference-too-short`. Its lines are then `inconclusive`
  by construction — the loop runs **at most once at full-corpus** and is never
  re-attempted (an `evidence-exhausted` marker is part of the reference cache
  key so it doesn't re-render across QA passes).
- **Minor-character blind spot — make it VISIBLE (F5/P5).** A
  `reference-too-short` character (typically a minor one with little dialogue) is
  entirely unchecked — exactly where wrong-voice / bleed is *least* likely to get
  human attention. So fs-51's report must **name** it ("N characters unchecked:
  insufficient reference audio — *A, B, C*"), never let the QA summary read
  "all clear" while silently skipping the riskiest cohort.
- Reference embedding cached, keyed by voice-config hash. A never-auditioned
  character has its sample minted on first QA pass.
- **Documented limitation (circularity):** the centroid is itself built from
  renders of the same engine, so the check means *"matches the voice's own
  central tendency,"* NOT *"is acoustically correct."* Engine-systematic
  mis-rendering (every render of this voice is subtly wrong, centroid included)
  is out of scope — a synthesis-quality problem.

### 3.4 Runtime + storage
- **Runtime is benchmark-conditional (§3.1).** *Preferred:* inline during
  generation, piggybacking the per-sentence ASR-QA pass in
  `synthesise-chapter.ts` (per-group PCM is live in `results[group.index].pcm` —
  a `/embed` consumer there avoids a re-decode; clone the optional `asr` pass as
  a `spk` pass). *Fallback (if the §3.1 benchmark shows inline materially slows
  generation):* a post-pass over the rendered chapter audio (re-decode cost
  accepted, mirroring `chapter-qa-repair.ts`). The runtime is **not fixed until
  the benchmark clears.**
- **Short-segment policy (R4 / F5):** a segment whose voiced duration is below
  the F5 floor is **not scored** → `'inconclusive'`, never a noisy cosine
  (mirrors ASR's `minChars`→`inconclusive`). If F5 shows coverage below bar,
  consecutive same-speaker short lines are **windowed** into one ≥-floor query
  before embedding (required mitigation, not optional). A windowed query mixes
  content (and possibly emotions); that is fine for a **timbre/identity** check
  (ECAPA is timbre-driven) but **windowed segments are excluded from any Phase-2
  consistency/per-emotion analysis** — averaging across the emotion axis is
  precisely what Phase 2 must not do. Flag windowed queries so the two
  mechanisms can't quietly contradict.
- **Storage — sibling file (F6).** 192 floats/segment (~1.5–2 KB JSON each)
  would bloat `<slug>.segments.json` by ~15 MB on a big book — and that file is
  read **whole** on hot paths that ignore embeddings (`revisions.ts:128`,
  voices/fallback collectors). Embeddings persist in a **sibling
  `<slug>.embeddings.json`** as **base64-packed Float32**, written in the **same
  `finalize-chapter-write` transaction** as the segments file. **Join key:**
  `chapterId` + `characterId` + a `sentenceIds` hash (matching segments-io's
  existing addressing); the aggregator treats a segment with **no matching
  embedding row as `inconclusive`, never an error**. An `embeddingsVersion`
  field invalidates the sibling on a model/preprocessing change.
- A Node aggregator turns per-segment scores into render-integrity events for
  fs-51 (if enabled).

### 3.5 Verdict model + naming (avoid the `'drift'` collision)
`AsrVerdict` already uses the literal `'drift'` (`segment-asr-qa.ts:31`). The
acoustic segment verdict is **`'voice-match' | 'voice-mismatch' |
'inconclusive'`**, aggregated into events with `metric: 'render-integrity'`,
`cosine`, `threshold`, `severity`, and the join key (§3.4). **Advisory only** —
badges a line "suspect voice," never gates `done` or auto-regens (auto-repair is
the gated/paid tier; detection stays free).

### 3.6 Calibration (on real misfires, not injection)
Cutoffs are picked on the **real labelled set Phase-0 produced** — the F2
misfires (flagged by ASR + audio-QA) as positives, clean renders as negatives —
NOT synthetic defects. The cosine-to-centroid distributions of the two classes
set `mild/moderate/severe` cutoffs, anchored to the **measured in-domain EER**
from F3 (NOT VoxCeleb 0.9%). Outputs: named cutoff constants; a normal-tier
**regression test pinning them** against committed fixture embeddings; a
**documented FP/FN rate** in Ship notes, with the **F4 residual-value fraction**
(drift caught that ASR + audio-QA missed) as the headline number.

**Single-fixture / single-run overfit risk:** cutoffs picked on one book's
over-generation run can overfit. Ship-notes FP/FN MUST be reported on a
**held-out** set of renders (a second over-generation run or a second fixture)
not used to pick the cutoffs, so the documented number is out-of-sample.

### 3.7 Honest CI scope
The over-generate-and-embed calibration is GPU/weights-bound → **opt-in
golden-audio tier**, not `verify`. The normal-tier pinning test guards
**cutoff-constant drift only** — it does NOT re-verify calibration correctness,
so a change to the model / preprocessing / the harvest gates is invisible to
normal CI. Stated as a known limitation: the FP/FN numbers are a periodic manual
artifact, not a per-push gate. (Do **not** claim "CI-runnable calibration.")

## 4. Phase 2 — deferred (only after Phase 1 ships + measurements justify)

- **Consistency drift** (intra-render wander) — only if F1/F3 show headroom and a
  Phase-2 emotion measurement validates an anchor. **Per-emotion** or *temporal*
  monotonic-wander, never a single global centroid. Needs emotion persisted first.
- **Per-emotion reference sets** (fs-25) + emotion-matched nearest-of-set — only
  if a Phase-2 measurement shows emotion materially shifts embeddings AND books
  carry variants (fixture cast carries a few; ~0–2 chars/book today — YAGNI until
  proven).
- **Emotion persistence** — `group.emotion` is NOT written to the persisted
  `ChapterSegment` (`synthesise-chapter.ts:1399-1411`); emotion-matching needs it
  threaded into `segments-io.ts` + the writer. **Internal Phase-2 work, not a
  satisfied dependency.**
- **cuda path + `spk:1` VRAM semaphore** (~5-file Node plumbing, §3.1).
- **Cross-book (series) consistency**; **human-rated perceived-drift holdout.**

## 5. Coexistence with config drift

Separate signals, not a replacement; `revisions.ts` untouched:

| Signal | Source | Meaning | fs-51 line |
|---|---|---|---|
| Config drift | `revisions.ts` | cast edited since this chapter rendered | "cast changes since render" |
| Render-integrity | acoustic (v1, **if Phase 0 = go**) | line strays from the voice's **own centroid** (stochastic misfire) | "voice-match" (conditional) |
| Consistency | acoustic (**Phase 2 — conditional, may not ship**) | character wandered across the render | "voice-consistency" (conditional) |

## 6. Acceptance (maps to #665)

**Phase 0 (gate — the deliverable if no-go):**
- [ ] F1–F5 run on a Qwen + Coqui over-generation of the fixture; findings note
      committed with the measured stochastic floor + centroid size K (F1), the
      real-misfire labelled set (F2), in-domain EER on real labels (F3), the
      **residual-value fraction** (drift caught that ASR + audio-QA missed, F4 —
      the headline), min scorable duration + checked-coverage % (F5), and a
      recommendation of exactly `{ go | no-go }`.
- [ ] On **no-go**: #665 closed wont-fix-acoustic; this spec marked `superseded`;
      fs-51 confirmed unaffected (it never depended on srv-36).
- [ ] **#665's literal ask closed (§2.3) regardless of branch:** the config-drift
      tone cuts (`25`/`40`) are explicitly retired as good-enough-placeholder
      (advisory-only signal) or re-filed as a separate low-priority chore — not
      left dangling.

**Phase 1 (only if go):**
- [ ] `SpeakerEngine` + `/embed`, CPU-only; sidecar pytest; CPU latency
      benchmarked → inline-vs-post-pass runtime chosen on evidence.
- [ ] `qa.speaker.enabled` (`live`) + `qa.speaker.device` (`restart-sidecar`),
      group `qa-gates`, defaults off / cpu.
- [ ] Centroid reference (K correct renders) with a **bounded** duration-floor
      loop (terminal `reference-too-short`→`inconclusive`); query-segment floor
      with windowing if F5 coverage demands it; embeddings in sibling
      `<slug>.embeddings.json` (base64 Float32, joined + written transactionally,
      `embeddingsVersion`).
- [ ] Scoring runtime per the benchmark; Node aggregator emits render-integrity
      events; verdict naming avoids the `'drift'` collision.
- [ ] Calibration on the **F2 real-misfire labels**, anchored to the F3 in-domain
      EER; cutoffs pinned by a normal-tier regression test; FP/FN + residual-value
      documented on a **held-out** run; the "calibration not re-verified in CI"
      limitation stated.
- [ ] fs-51 (#973) can consume render-integrity events as a **conditional**
      voice-match row (it ships regardless).

## 7. What the reviews confirmed is RIGHT

The §0 reframe; advisory-not-gating; engine-agnostic common-axis embedding; env
threading through `spawn-sidecar.ts`. The inline PCM-in-memory advantage is real
**but contingent on the §3.1 benchmark** — it stands only if the inline runtime
is chosen.

## 8. Meta / backlog hygiene

- Re-file #665 `type:chore` → `type:feature`; note Large; add the Phase-0 spike
  as the gating sub-task with its `{go|no-go}` outcome.
- Keep its Should placement (Could→Should in the 2026-06-21 triage). **Update
  the fs-51 (#973) note from "blocked on srv-36" to "optionally enriched by
  srv-36"** — fs-51 is not blocked.
- **Close #665's original calibration ask (§2.3):** decide retire-as-placeholder
  vs re-file the config-drift tone-cut (`25`/`40`) calibration as its own chore,
  and record that decision on the issue so the reframe doesn't orphan it.

## Ship notes

_(filled on ship: date · commit SHA · Phase-0 recommendation {go|no-go} ·
residual-value fraction · in-domain EER · min scorable duration · checked-
coverage % · calibrated cutoffs · out-of-sample FP/FN rate)_
