---
status: draft
date: 2026-06-21
topic: srv-36 — acoustic render-integrity check (was "voice-drift") + calibration
issue: srv-36 (#665)
depends_on: srv-31 (ASR-QA hook + qa-gates settings pattern)
phase2_internal: fs-33 (emotion persistence), fs-25 (per-emotion variants) — Phase-2 work INSIDE srv-36, not external blockers
relates_to: fs-51 (#973) — srv-36 OPTIONALLY enriches it; fs-51 is NOT blocked on srv-36 (see §0.1)
revised: 2026-06-21 (3rd pass — gated on a residual-value spike with a real no-go; v1 reframed as render-integrity; fs-51 decoupled)
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

The architecture is sound; the **measurement science is unvalidated.** The
load-bearing assumptions, none answerable from the literature (they must be
measured on *this product's own TTS output*):

- **R1 — residual value (the existential one).** Can an acoustic cutoff flag
  *same-config, same-engine* defects (bleed / glitch / clean-reference fallback)
  that config-drift provably cannot see? Or does it only separate different
  characters (redundant)?
- **R2 — out-of-domain & near-miss.** ECAPA's ~0.9% VoxCeleb EER is a
  *real-human* number; TTS voices cluster tighter (shared vocoder fingerprint).
  Two same-gender presets (`af_heart` vs `af_bella`) may be inseparable. The
  VoxCeleb figure is **not** a valid calibration anchor — measure in-domain.
- **R3 — short-segment reliability & coverage.** ECAPA is high-variance below
  ~2–3 s. Audiobook **dialogue** (the content whose voice-correctness matters
  most) is dominated by short lines, so a duration floor risks marking the
  *majority of character lines* `inconclusive` — silently unchecked.
- **R4 — emotion sensitivity** (Phase 2 only). If emotion shifts embeddings, a
  neutral reference mis-scores emotional lines and a global centroid blurs.

## 2. Phase 0 — residual-value spike (a GATE that can say no)

A throwaway harness (committed under `scripts/` or an opt-in sidecar test) that
embeds clips from the canonical fixture renders and reports distributions. **No
production code, no settings, no events.** ~3–4 days (the injection harness, §2.0,
is real work). Its findings note supersedes Phases 1–2 wherever reality differs.

### 2.0 Defect injection — what is actually producible (verified against synth code)

E1's gate is only as good as the defects it can produce. Verified against the
synth path: **there is no seed surface** (`Engine.synthesize` takes no seed),
**Kokoro is deterministic ONNX** (never stochastically glitches), and **Qwen is
explicitly unseeded** — so a "bad-seed glitch" is not reproducible, and
deterministic "voice bleed" reduces to synthesising a line with another
character's prompt, i.e. the different-character swap §0.1 rejects as redundant.
E1 therefore uses only **deterministically producible** same-config defects:

| Class | Mechanism | Tier |
|---|---|---|
| **Silent fallback** | force `applyQwenFallback` (Node route swap, `synthesise-chapter.ts:718`) so the line renders in Kokoro while the reference stayed Qwen-clean | gross + subtle (fallback to a near vs far Kokoro voice) |
| **Wrong preset** | render the line with a different preset than the reference — **stratified**: same-gender same-engine near-miss (`af_*`, subtle) AND distant (gross) | subtle + gross |
| **Constructed garble** | deterministic post-synth corruption of a clean render: truncate / clip / time-reverse a span / splice a known-bad recorded fragment | gross |

**Voice bleed is observational-only**, not injected: it is an emergent
non-deterministic artifact of batched Qwen forwards (the prompt-flatten hazard
near `main.py:1734`). E1 does **not** depend on bleed for its go/no-go; any real
occurrences harvested from existing renders are reported as a bonus, never as the
gate. This is stated so the timeline and the gate aren't built on a defect we
can't summon.

| Exp | Question (risk) | What it gates |
|---|---|---|
| **E1 — residual value** | Run the §2.0 injectable defects through the real synth path and measure, **per tier (gross / subtle)**, what fraction land **beyond** the candidate cutoff vs clean same-config renders. (R1) | **The go/no-go** (§2.1). |
| **E2 — separability & in-domain EER** | intra-speaker spread (same voice, 50 lines) vs inter-speaker; graduated set (correct → prosody-bumped → wrong-character); measured in-domain EER; same-gender same-engine preset near-miss (`af_*`). (R2) | Whether wrong-preset/bleed is even separable; which positive pairs are fair; the EER cutoffs anchor to. |
| **E3 — clip length & coverage** | embed the same line truncated 0.5/1/2/3/5 s → cosine variance vs length; AND the **fraction of the fixture's character (non-narrator) segments below the candidate floor**. (R3) | The min scorable **query** duration; the realistic checked-coverage %; whether short-line **windowing** is mandatory. |
| **E4 — emotion shift** (informs Phase 2) | one character neutral/angry/sad/whisper; pairwise cosine vs cross-character. (R4) | Phase-2: is emotion-matching needed; is a global consistency centroid valid. |

### 2.1 Go condition (Phase 1 proceeds)
The bar is **anchored to a measurement, not a round number, and judged on the
subtle tier** (the gross tier clearing proves nothing — gross fallback/distant-
preset are trivially separable and near the redundant boundary). Go requires:

- the **subtle-tier** defects (near-miss preset, fallback-to-near-voice) separate
  from clean same-config renders by a margin **clearly above the same-voice
  intra-speaker spread measured in E2** — i.e. a real cluster gap, not noise;
  AND
- a clean-render false-positive rate at that cutoff ≤ a stated ceiling; AND
- E3 character-segment checked-coverage above a stated bar (windowing if needed).

E1 reports the flagged fraction **per tier**; a high *pooled* number carried by
the gross tier alone does **not** clear the gate.

### 2.2 No-go (srv-36 is abandoned — this is a real outcome, not a descope)
If the subtle tier does not separate (acoustic only catches the gross / different-
character case config-drift already covers), srv-36 closes **wont-fix-acoustic**:
#665 reverts to "the existing config-drift comparator IS the drift signal; an
acoustic layer adds nothing over it," and fs-51 ships on its existing signals
(§0.2) with **no** voice-match row. The findings note's recommendation field is
exactly one of `{ go, no-go }` — there is no "descope to wrong-speaker," because
that product is the redundant one.

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
      + 'audition sample. Off by default. CPU (zero VRAM).',
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

### 3.3 Reference resolution (singleton, bounded duration floor)
Reuse the per-character voice sample (`voice-sample-cache.ts`) — a ~12 s render
in the character's exact engine+voice, cached by voice-config — as a **single**
reference. The duration floor (E3 sets the number, ~3 s):

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
- **Documented limitation (circularity):** the reference is itself a render from
  the same engine, so the check means *"matches the approved audition sample,"*
  NOT *"is acoustically correct."* Engine-systematic mis-rendering (the engine
  renders this voice subtly wrong on every line, reference included) is out of
  scope — a synthesis-quality problem.

### 3.4 Runtime + storage
- **Runtime is benchmark-conditional (§3.1).** *Preferred:* inline during
  generation, piggybacking the per-sentence ASR-QA pass in
  `synthesise-chapter.ts` (per-group PCM is live in `results[group.index].pcm` —
  a `/embed` consumer there avoids a re-decode; clone the optional `asr` pass as
  a `spk` pass). *Fallback (if the §3.1 benchmark shows inline materially slows
  generation):* a post-pass over the rendered chapter audio (re-decode cost
  accepted, mirroring `chapter-qa-repair.ts`). The runtime is **not fixed until
  the benchmark clears.**
- **Short-segment policy (R3 / E3):** a segment whose voiced duration is below
  the E3 floor is **not scored** → `'inconclusive'`, never a noisy cosine
  (mirrors ASR's `minChars`→`inconclusive`). If E3 shows coverage below bar,
  consecutive same-speaker short lines are **windowed** into one ≥-floor query
  before embedding (required mitigation, not optional). A windowed query mixes
  content (and possibly emotions); that is fine for a **timbre/identity** check
  (ECAPA is timbre-driven) but **windowed segments are excluded from any Phase-2
  consistency/per-emotion analysis** (E4/R4) — averaging across the emotion axis
  is precisely what Phase 2 must not do. Flag windowed queries so the two
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

### 3.6 Calibration
**Synthetic injection** from `server/src/__fixtures__/the-coalfall-commission.md`,
scripted + committed. Positives = same lines rendered with the **defect classes
E1/E2 proved separable** (bleed/glitch/fallback, plus acoustically-distant
wrong-voice only where E2 says it's fair). A script embeds every clip, computes
the cosine distribution per class, and picks `mild/moderate/severe` cutoffs
anchored to the **measured in-domain EER** (NOT VoxCeleb 0.9%). Outputs: named
cutoff constants; a normal-tier **regression test pinning them** against
committed fixture embeddings; a **documented FP/FN rate** in Ship notes.

**Single-fixture overfit risk (F9):** cutoffs picked on one book's presets can
overfit. Ship-notes FP/FN MUST be reported on at least one **held-out**
voice/preset pairing not used to pick the cutoffs, so the documented number is
out-of-sample.

### 3.7 Honest CI scope
The synth-and-embed calibration is GPU/weights-bound → **opt-in golden-audio
tier**, not `verify`. The normal-tier pinning test guards **cutoff-constant
drift only** — it does NOT re-verify calibration correctness, so a change to the
model / injection harness / preprocessing is invisible to normal CI. Stated as a
known limitation: the FP/FN numbers are a periodic manual artifact, not a
per-push gate. (Do **not** claim "CI-runnable calibration.")

## 4. Phase 2 — deferred (only after Phase 1 ships + measurements justify)

- **Consistency drift** (intra-render wander) — only if E2 shows subtle-drift
  headroom and E4 validates an anchor. **Per-emotion** or *temporal* monotonic-
  wander, never a single global centroid (R4). Needs emotion persisted first.
- **Per-emotion reference sets** (fs-25) + emotion-matched nearest-of-set — only
  if E4 shows emotion materially shifts embeddings AND books carry variants
  (fixture has **zero**; ~0–2 chars/book today — YAGNI until proven).
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
| Render-integrity | acoustic (v1, **if Phase 0 = go**) | line doesn't match the **approved audition sample** | "voice-match" (conditional) |
| Consistency | acoustic (**Phase 2 — conditional, may not ship**) | character wandered across the render | "voice-consistency" (conditional) |

## 6. Acceptance (maps to #665)

**Phase 0 (gate — the deliverable if no-go):**
- [ ] E1–E4 run on fixture renders; findings note committed with the measured
      residual-value fraction, in-domain EER, min scorable duration, character-
      segment checked-coverage %, emotion-shift magnitude, and a recommendation
      of exactly `{ go | no-go }`.
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
- [ ] Singleton reference with a **bounded** duration-floor loop (terminal
      `reference-too-short`→`inconclusive`); query-segment floor with windowing
      if E3 coverage demands it; embeddings in sibling `<slug>.embeddings.json`
      (base64 Float32, joined + written transactionally, `embeddingsVersion`).
- [ ] Scoring runtime per the benchmark; Node aggregator emits render-integrity
      events; verdict naming avoids the `'drift'` collision.
- [ ] Calibration on E1/E2-proven defect classes, anchored to the in-domain EER;
      cutoffs pinned by a normal-tier regression test; FP/FN documented on a
      **held-out** pairing; the "calibration not re-verified in CI" limitation
      stated.
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
