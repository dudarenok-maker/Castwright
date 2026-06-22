---
status: stable
date: 2026-06-21
topic: srv-36 Phase 1 — render-integrity check (production integration + calibration + auto-fix)
issue: srv-36 (#665)
phase0: docs/superpowers/specs/2026-06-21-srv-36-acoustic-voice-drift-design.md (the GATE spec) · FINDINGS at server/tts-sidecar/spikes/srv36/FINDINGS.md (recommendation = GO)
depends_on: srv-31 (ASR-QA hook + qa-gates settings pattern); the existing audio-qa-repair route
relates_to: fs-51 (#973 — per-book QA report; renders the issues-outline) · com-1 (Cast Pass entitlement; gates the auto-fix action) · fe-40 (cast-carry / series memory; the co-headline Cast Pass prop)
supersedes_phase1_in: the Phase-0 spec §3 wherever this differs (this is the built design; that was the conditional sketch)
revised: 2026-06-21 (rounds 2–3 adversarial — code-grounded against origin/main. R2: corrected six "mirror/reuse" claims, the centroid-poisoning hole, the auto-fix under-scope (§1.1), plus self-review (filter location, race-free derive, symmetric windowing, accept-margin, availability probe). R3: fixed the dep premise (torch is in cpu.txt, not only nvidia — pin huggingface_hub via a speaker-qa.txt fragment), split the verdict store from the 192-float vectors so derive-on-read is cheap, pinned which PCM the auto-fix re-embeds, and added the large-drift-cluster/bimodal centroid guard)
---

# srv-36 Phase 1 — render-integrity check + calibration + auto-fix

Phase 0 returned **GO** (`FINDINGS.md`): an ECAPA-TDNN speaker-embedding timbre
check catches real, listener-perceived voice drift that the existing ASR
content-QA and audio-QA gates miss. This spec is the production integration —
its own interfaces, calibrated on this product's real renders, with the value
loop (auto-fix + upsell surface) the Phase-0 gate deferred.

## 0. What Phase 0 locked (carried in, not re-litigated)

1. **Stochastic engines only** — Qwen + Coqui XTTS. Kokoro is deterministic and
   cannot drift; excluded. This metric is distinct from `revisions.ts`
   config-drift (a deterministic cast-edit diff), which is untouched.
2. **Per-character-relative cutoff, not one global line.** Qwen's clean
   cosine-to-centroid floor is wide (per-char std 0.09–0.14; p05 0.47–0.65).
   Confirmed drift sits below each character's *own* clean p05.
3. **3-tier verdict** — severe / inconclusive-band / pass, plus a min
   duration gate (short quotes → inconclusive regardless; the ambiguous zone is
   dominated by short quotes).
4. **The decisive gate is human/perceptual validation of acoustic-only flags,
   not separability against ASR labels.** ASR measures words, ECAPA measures
   timbre; their poor correlation (EER 0.29–0.40) *proves* non-redundancy. So
   calibration ground truth is operator listening, never the existing flags.
5. **Centroid can be mildly contaminated by drift; p05 needs calibration on a
   larger labelled set** — a Phase-1 work item discharged in §6.

## 1. Scope of this session

Four production units + one calibration pass + one product-positioning design.

| # | Unit | Tier touched |
|---|---|---|
| 1 | `SpeakerEngine` + `POST /embed` | sidecar (Python) |
| 2 | Embed step — inline, piggybacking ASR-QA; sibling `<slug>.embeddings.json` | server (Node) |
| 3 | Score step — post-pass aggregator: hybrid centroid → 3-tier verdict → render-integrity events | server (Node) |
| 4 | Auto-fix — acoustic candidate source + acoustic accept-check built *into* the `audio-qa-repair` route, behind a default-off flag | server (Node) |
| C | Calibration — embed real on-box renders, pick band params on a calibration book, validate out-of-sample on held-out books with an operator listen | on-box, GPU-free |
| P | The issues-outline as the primary Cast Pass upsell surface (event-shape obligation now; UI lands with fs-51/com-1) | spec/positioning |

**Out of this session:** the cuda path + VRAM-semaphore plumbing (Phase 2); the
fs-51 report UI (separate Must, #973); the com-1 entitlement gate (parked); the
Coalfall spike re-key (deferred); consistency/per-emotion drift (Phase 2 of the
Phase-0 spec); a VAD-based *voiced*-duration measure (v1 uses raw decoded
duration — §4.2).

## 1.1 Reuse reality (code-grounded, round-2 correction)

An earlier draft described this as mirroring/reusing six existing seams. A
fact-check against `origin/main` showed most of those are **net-new work wearing
a reuse label**. The plan must budget accordingly:

| Spec claimed | Code reality | Consequence for the plan |
|---|---|---|
| `/embed` "modelled on `/transcribe`" | `/transcribe` is **raw `audio/L16` body + `X-Sample-Rate` header**, not JSON (`main.py:3425-3433`) | `/embed` uses the same raw-body transport, not a JSON `{pcm}` envelope (§2) |
| "Productionize the spike's `embed.py`" | its `functools.lru_cache` loader **double-loads under `to_thread`** | replace the loader with Whisper's `_ensure_loaded` + `asyncio.Lock` + `threading.Lock` (`main.py:1821-1826`) (§2) |
| `speechbrain` → `requirements/base.txt` | `base.txt` is the **torch-free** layer; torch is in **both** `cpu.txt:16` and `nvidia-cuda.txt:22` (AMD: out-of-band ROCm wheels). `huggingface_hub` is **unpinned** anywhere today | `speechbrain` + an **explicit `huggingface_hub` pin** go in a shared `speaker-qa.txt` overlay fragment `-r`-included by all three vendor profiles (which already supply torch) — not `base.txt` (§2) |
| "mirror `qa.asr.device`" | **no such key** — `ASR_DEVICE` appears only in help text | `qa.speaker.device` is the *first* device key in `qa-gates`; valid per `ApplyMode`, but not a mirror (§9) |
| Option B renders via `voice-sample-cache.ts` | that module is **filename/text primitives only** (caches an MP3, no render, no duration) | render via `provider.synthesize` (the `voice-sample.ts` route machinery), raw PCM; the cache module only supplies sample text + key (§4.1) |
| Auto-fix "feeds candidates to" the repair route | the route's scan **and** accept-criterion are **hardwired to signal+ASR**, no pluggable seam, no re-embed/re-score (`chapter-qa-repair.ts:165-194, 292-293`) | build an acoustic candidate source *and* an acoustic accept-check **inside** the route (§5) |
| Embeddings written "in the same transaction" as segments | `finalizeChapterAudioWrite` is a **sequence of independent atomic single-file writes** — no multi-file atomicity (`finalize-chapter-write.ts:193-233`) | the sibling is a separate atomic write that can **tear**; the join tolerates present-segments / missing-embeddings independently of `embeddingsVersion` (§3) |

What *did* check out as genuinely solid: the inline PCM piggyback (`results[group.index].pcm`, raw int16 LE, pre-loudnorm — `synthesise-chapter.ts:1101,1320-1376`), the `revisions.ts:128` whole-file hot path that justifies the sibling, the `'drift'` collision (`segment-asr-qa.ts:31`), `sentenceIds` persisted / `emotion` not, the settings apply-modes + `...process.env` threading (`spawn-sidecar.ts:435`), CPU-only cleanly bypassing the **client-side** VRAM semaphore (`transcribe-client.ts:14-18`), the `to_thread` contract (`main.py:3437`), and per-book on-disk isolation (no cross-book centroid contamination).

## 2. Unit 1 — `SpeakerEngine` + `POST /embed` (sidecar)

Productionizes the spike's `embed.py` **math** (decode `<i2` int16 LE → resample
16 k → ECAPA `encode_batch` → L2-normalize — already unit-tested). ECAPA-TDNN
(SpeechBrain `spkrec-ecapa-voxceleb`), 192-dim, cosine. A `SpeakerEngine`
singleton `SPK = SpeakerEngine()` beside `ASR` (the 5th engine on the same
**non-`ENGINES`** special path Whisper uses — `main.py:1801,1931`); endpoint
**`POST /embed`**.

- **Transport mirrors `/transcribe` exactly:** request body = **raw int16 LE
  PCM bytes**, `X-Sample-Rate` header; response = `{ embedding: float[192], dim,
  sample_rate }` JSON. No JSON/base64 request envelope.
- **Loader is the Whisper idiom, NOT the spike's `lru_cache`** (which races and
  double-loads under concurrency): `_ensure_loaded` guarded by an `asyncio.Lock`
  for the cold load + a `threading.Lock` around the forward pass (ECAPA/torch
  CPU forward, defensive, matching `WhisperEngine._infer_lock`).
- **`asyncio.to_thread` offload** of the (synchronous) forward pass — required;
  a bare forward blocks the event loop (`main.py:3437` is the pattern).
- **Resample with `numpy` (`np.interp`), not `torchaudio`.** `main.py:1860`
  deliberately avoids `torchaudio` in the hot path (the venv pins it but never
  calls it); the embed engine follows suit.
- **CPU-only in v1** (`SPK_DEVICE=cpu`): zero VRAM. The VRAM semaphore is
  *client-side* and opt-in by device (`transcribe-client.ts:58`), so a CPU embed
  takes no token and needs no registration — nothing forces a cost entry. **No
  watchdog** (CPU model can stay resident). The cuda path + an `spk` VRAM cost is
  Phase 2.
- **Engine-agnostic:** reference and rendered segment go through the *same* ECAPA
  model regardless of TTS engine; engines' internal speaker reps are never used.
- OFF unless `SEG_SPK_ENABLED`.

**Dependency placement (the install risk).** Torch already exists on every
profile a CPU embed runs on — `torch==2.11.0` is pinned in **`cpu.txt:16`** (so
opt-in Coqui can import) *and* `nvidia-cuda.txt:22`, and ROCm torch is
pre-installed out-of-band on AMD — so **CPU ECAPA is viable for free; no torch
needs adding.** The real risk is that **`huggingface_hub` is unpinned today**
(it arrives transitively via transformers/kokoro), and speechbrain will now
co-constrain it against the pinned `transformers>=4.45,<5.0` (`base.txt:36`).
So: put `speechbrain` **and an explicit `huggingface_hub` pin** in **one shared
`speaker-qa.txt` overlay fragment**, `-r`-included by `cpu.txt` /
`nvidia-cuda.txt` / `amd-rocm.txt` (single source of truth, kept out of the
torch-free `base.txt`). The plan **must** resolve the combined set and **record
the pinned `speechbrain` + `huggingface_hub` versions** in Ship notes — a
different resolution on a different box is the single most likely install break.
onnxruntime is untouched (speechbrain doesn't use it, so the Kokoro
onnxruntime/onnxruntime-gpu swap is unaffected). Weights fetch on first load.

**Hand-wired mirror sites (name them so the plan budgets them):** a new
`spk_loaded`/`spk_device` field in `/health` (`main.py:2899`); the poison/recycle
fences in `/transcribe` re-stated in `/embed` (copy-paste, not a shared helper);
the idle-watchdog loop is **left alone** (no `SPK` watchdog by design).

**Sidecar test** `tests/test_speaker_embed.py`: deterministic embedding for fixed
input; `cosine(self,self) ≈ 1`; same-speaker-two-utterances > different-speaker;
`to_thread` offload intact; cold-load lock prevents double-load under two
concurrent first hits; CPU path needs no CUDA. Unit tier stubs `speechbrain` via
`sys.modules` (like `test_transcribe.py`); the weights-bound assertions are
`importorskip`/`pytest.skip` (golden tier). Triple gate (venv/pytest/weights).

## 3. Unit 2 — embed step (inline) + storage

When `qa.speaker.enabled`, each rendered group **whose character's configured
engine is stochastic** (`qwen` | `coqui`) has its PCM — already in memory beside
the ASR-QA pass in `synthesise-chapter.ts` (`results[group.index].pcm`, raw
int16 LE, pre-loudnorm) — sent to `/embed`. **Deterministic (Kokoro) characters
are skipped at the embed step** (§0: they cannot drift) — that is where the
"stochastic engines only" filter lives, so no compute is spent embedding or
scoring them and they never receive a verdict. Clone the optional `asr` pass
(`:1320-1376`) as a parallel `spk` pass; **no re-decode**. **Pass the per-group
`results[group.index].sampleRate`** — engines render at different rates and
resample-to-anchor happens only at concat (`:1390`), so the chapter anchor rate
is wrong here. If the §2 CPU benchmark (incl. the concurrent-multi-book worst
case, since ECAPA shares CPU with the existing Whisper pass) shows inline
materially slows generation, the embed drops to the post-pass alongside scoring
(re-decode accepted) — a runtime fallback, not a redesign.

**Storage — two stores, deliberately split (vectors vs verdicts).** 192
floats/segment would bloat `<slug>.segments.json` (~15 MB on a big book), and
that file is read *whole* on hot paths that ignore embeddings (`revisions.ts:128`,
voices/fallback collectors). So the **192-float vectors** persist in a sibling
**`<slug>.embeddings.json`** (base64-packed Float32) — read **only** by the
re-score/auto-fix/calibration paths that genuinely need floats. The **tiny
per-segment verdict** (enum + cosine + join fields, §4.3) lives in a **separate
cheap per-chapter store** so the book-outline derive (§4.3) never has to open
the ~5–8 MB of vectors. Splitting them is the point: a 7452-seg book is ~5–8 MB
of vectors but well under 1 MB of verdicts.

- **Not transactional with the segments file.** `finalizeChapterAudioWrite` is a
  *sequence* of independent `writeJsonAtomic` (tmp+rename) writes — there is no
  multi-file transaction primitive. The sibling is one more atomic write in that
  function; a crash between the two leaves them inconsistent **by design
  tolerance**, not by atomicity.
- **Join key:** `chapterId` (file-level) + `characterId` + the raw `sentenceIds`
  array (the de-facto segment address today — there is no existing "hash"
  scheme; don't invent one). A segment with **no matching embedding row** (never
  embedded, or a torn write) → `inconclusive`, never an error — independent of
  `embeddingsVersion`.
- **`embeddingsVersion` is a distinct state, not silent loss.** A version bump
  (model/preprocessing change) marks existing rows **stale**; stale ≠ missing:
  the report shows *"embeddings stale — re-embed needed (N books)"* rather than a
  silently-calm "all inconclusive." A re-embed path (the §6 calibration harness,
  reused) regenerates the sibling. Missing-vs-stale are reported differently.

## 4. Unit 3 — score step (post-pass): hybrid centroid + 3-tier verdict

Scoring needs the per-character centroid, which needs the segments embedded
first → inherently a post-pass. After a chapter (or book) finishes embedding, a
Node aggregator builds centroids, scores every segment, and emits events.

### 4.1 Reference centroid — hybrid (A primary, B fallback)

The anchor must represent the character's **expected (configured) engine+voice**,
so it is built **only from segments rendered in that engine** — never from
fallback renders (see the poisoning guard below).

- **Option A (majority case) — in-book clean renders.** A character's centroid =
  the L2-renormalized robust mean (`metrics.centroid` + the trimming below) of
  their **anchor-eligible** segment embeddings in the book. Anchor-eligible =
  (a) **gate-passing** (not flagged by ASR-QA or audio-QA — labels we hold) AND
  (b) **`renderedFallbackEngine` unset** (rendered in the configured engine, not
  a silent Qwen→Kokoro fallback — `synthesise-chapter.ts:279`,
  `segments-io.ts:34`). Requires **≥ N anchor-eligible segments** (N calibrated;
  candidate 10).
  - **Poisoning guard (the load-bearing one).** A fallback-Kokoro render is
    deterministic, says the right words, and passes ASR + audio-QA — so without
    the `renderedFallbackEngine` exclusion it would fold into the centroid and
    pull the anchor toward the *exact defect this gate exists to catch*. Fallback
    segments are therefore **excluded from the anchor and scored as candidates**
    (they will, correctly, tend to flag).
  - **Robust centroid, not one trim pass.** Pre-exclude all *known* labels
    (ASR/audio-QA positives + fallback) first; then, because acoustic-only drift
    is unlabelled and can still sit in the eligible set, estimate the centroid
    with a **deterministic iterate-to-convergence trimmed mean** (drop the
    lowest-cosine fraction α, re-centroid, repeat until the centroid shift < ε or
    a fixed iteration cap M — α/ε/M are named constants so the regression test
    pins the behaviour). A single pass against an already-contaminated centroid
    can trim the wrong lines.
  - **Blind spot — a *large* drift cluster (not sparse contamination).** Trimming
    handles a few stray drifted lines, but **not** a whole sub-chapter rendered
    subtly-off that passed the gates: that forms a *second mode*, and a trimmed
    mean converges to a blend (under-flagging the drift, over-flagging the clean).
    Mitigation: if a character's eligible cosine distribution is **bimodal**
    (a detectable gap), the in-book set is contaminated → **prefer the
    drift-free Option-B audition centroid** for that character (audition renders
    are fresh from approved text, so contamination-free by construction). Where
    both A and B exist, a low `cosine(centroidA, centroidB)` is the same
    tripwire. **Small-N Option A is statistically fragile** (at N≈10, trimming α
    removes ~1 line and one contaminant dominates) — so the calibrated N is set
    where trimming is meaningful, and sub-N characters route to B, not to a
    fragile A.
- **Option B (minor characters, < N anchor-eligible) — audition-sample
  centroid.** Render the character's approved audition sample **K times**
  (K calibrated; candidate 12) via `provider.synthesize` (the `voice-sample.ts`
  route machinery, raw PCM out), in the character's exact engine+voice;
  `voice-sample-cache.ts` supplies the sample **text + cache key** only.
  Centroid = mean of those K embeddings. Stamped `reference-from-audition`.
  - **Duration floor on the centroid renders:** if a single audition render is
    under the min-duration floor (§4.2), extend the sample text with the
    next-longest *evidence* quotes (no fabricated text) and re-render. Bounded
    terminal case: if all available evidence concatenated still renders under
    floor, accept best-effort and stamp `reference-too-short`. Loop runs at most
    once at full-corpus; an `evidence-exhausted` marker is part of the reference
    cache key so it never re-renders across QA passes.
- **Terminal blind spot — made visible.** A character with neither ≥ N
  anchor-eligible lines nor a sufficient audition sample → `reference-too-short`;
  all their lines are `inconclusive` and the report **names them explicitly**
  ("N characters unchecked: insufficient reference audio — *A, B, C*"). Never a
  silent "all clear" over the cohort where wrong-voice/bleed is *least* likely to
  get human attention.
- Reference embeddings cached, keyed by voice-config hash (+ the
  `evidence-exhausted` marker for B).

**Documented limitation (circularity):** an Option-A centroid is built from
renders of the same engine, so the check means *"matches this voice's own central
tendency,"* not *"is acoustically correct."* Engine-systematic mis-rendering
(every render subtly wrong, centroid included) is out of scope — a
synthesis-quality problem, not a drift one.

### 4.2 3-tier verdict — per-character-relative

Each character's cutoffs derive from **that character's own anchor-eligible
cosine spread** (`spread_stats` → mean/std/p05). Two monotonic per-character
cutoffs, **E** (severe edge) < **U** (band upper bound), both calibrated in §6:

| Verdict | Rule | Phase-0 anchor |
|---|---|---|
| **`voice-mismatch` (severe)** | cosine **< E** (E calibrated near the character's clean p05–p07; the hardening listen found p05 slightly lax, so E may sit a touch above p05) | all 7 confirmed-drift clips sat below their char's p05 |
| **`inconclusive` (band)** | **E ≤ cosine < U** (U calibrated near p10), **or** duration below the min floor | hardening: ambiguous zone is short quotes |
| **`voice-match`** | cosine **≥ U** | — |

- **Duration measure (v1):** the **raw decoded `pcmDurationSec`** of the
  segment, not a VAD-measured *voiced* duration (a VAD is Phase 2). Cheap and
  matches Phase-0's clip-length basis. **Known risk:** a long-but-mostly-silent
  segment clears the floor yet embeds noisily — noted as a v1 limitation, not
  silently assumed away.
- **Short-segment policy** (mirrors ASR's `minChars`→`inconclusive`): a segment
  below the calibrated min floor is not scored → `inconclusive`. If calibration
  shows coverage below bar, consecutive same-speaker short lines are **windowed**
  into one ≥-floor query before embedding. **Windowing must be symmetric:** the
  per-character clean spread (E/U) is then estimated on windowed units too, or
  the cutoffs end up scaled to single-segment cosines while queries are
  multi-segment — a silent mismatch. Windowed queries are flagged and excluded
  from any future Phase-2 per-emotion analysis.
- **What calibration tunes** (§6): the *band parameters* — the severe-edge
  percentile, the band width, N, K, and the min-duration floor. **Not** absolute
  cosine values; those stay per-character at runtime. The regression test (§7)
  pins these *rule parameters* against committed fixture embeddings.

### 4.3 Verdict naming + events

Avoids the `AsrVerdict` `'drift'` collision (`segment-asr-qa.ts:31`). Segment
verdicts are **`'voice-match' | 'voice-mismatch' | 'inconclusive'`**, aggregated
into events with:

```
metric: 'render-integrity'
characterId, chapterId, sentenceIds          // the join key (raw sentenceIds, §3)
severity: 'severe' | 'inconclusive'
cosine, threshold                            // the per-character E applied
expectedEngine, renderedEngine               // renderedEngine != expectedEngine ⇒ a fallback flagged this
fixable: boolean                             // see definition below
referenceKind: 'in-book' | 'audition' | 'too-short'
windowed: boolean
```

- **`fixable` definition (refined):** `severity === 'severe'` **AND** the
  character's **configured** engine is stochastic (`qwen` | `coqui`) **AND** that
  engine is currently available. A severe flag whose cause is a *structural*
  fallback (configured Qwen but the box fell back to Kokoro because Qwen was
  unavailable) is **not** `fixable` — re-rendering would just fall back again and
  burn compute; it surfaces as a non-auto-fixable issue ("engine unavailable —
  re-render won't help").
- **Persistence home (events must live somewhere now — fs-51 isn't built).**
  Per-segment verdicts persist in a **tiny per-chapter verdict store** — a
  small `<slug>.render-integrity.json` sibling (verdict enum + cosine + join
  fields per flagged/scored segment), **separate from the heavy
  `<slug>.embeddings.json` vectors** (§3). This mirrors the established
  per-chapter rollup grain: `loadSegmentsFiles` + `collectRenderedFallbackEngines`
  already derive book-level views by scanning small per-chapter summaries
  (`segments-io.ts:85`, read at `revisions.ts:128`) — not 7452-row arrays.
- **Book outline DERIVED ON READ** by scanning those per-chapter verdict files —
  **no separate writable `<book>` aggregate file**, because two chapters of the
  same book finishing concurrently would race-write it (per-book state is
  chapter-keyed RMW — `finalize-chapter-write.ts:208`). Each verdict file is one
  single-chapter atomic write; the derive reads kilobytes/chapter, never the
  vectors. auto-fix (§5) and the "N suspect / N fixed" surfacing read the derived
  view; fs-51 later renders from the same derivation.

**Advisory only** — never gates `done`. The `fixable` flag and the per-issue
shape are exactly what the issues-outline upsell (§8) and the auto-fix (§5)
consume.

## 5. Unit 4 — auto-fix (the value action)

Auto-fix routes through the **existing** repair endpoint —
`POST /api/books/:bookId/chapters/:chapterId/audio-qa-repair`
(`chapter-qa-repair.ts`) — but it is **not** a free ride: that route's candidate
scan (`:165-194`) and its accept criterion (`:292-293`, `signal-ok && asr≠drift`)
are **hardwired to signal+ASR** with no pluggable seam and **no acoustic check**.
That said, the route is *friendlier* than "no seam" implies — it is already
`async`-throughout (it `await`s `synthesiseChapter` + `verifyAsr` inside the
retry loop) and **already does best-of-N with a 2-retry default**
(`maxRerecords`), so the acoustic accept-check is **~6 localized edits, not a
restructure**. This unit *builds*, inside that route:

1. **An acoustic candidate source** — feed the `voice-mismatch`-severe,
   `fixable: true` segments (from the §4.3 events) into the route's `flagged[]`
   alongside the signal/ASR scans.
2. **An acoustic accept-check inside the synth callback** — after a candidate is
   re-rendered (stochastic engine → fresh take), **re-embed it via `/embed` and
   re-score against the same centroid.** Accept only if the new take clears a
   **comfortable margin above U** (candidate: ≥ the character's clean mean, or
   p25 — calibrated), not merely ≥ U: with the wide stochastic floor, "just over
   U" can be luck and would report a false "fixed." Take **best-of-N** re-renders.
   *The accept margin and the retry cap are a yield-vs-precision tradeoff — too
   high a margin / too few retries "fixes" almost nothing and undercuts the
   value story; too low reports false fixes. Both are calibrated in §6, and the
   cap may exceed 2.*
   Before attempting any of this, **probe that the configured engine is actually
   available** (a fallback flagged this line *because* the engine was down — see
   `fixable`); if it isn't, skip the re-render and mark `inconclusive` ("engine
   unavailable").
3. **Persist the fix completely** — on accept, the take's new embedding
   **replaces** the stale row in `<slug>.embeddings.json` and its verdict in
   `<slug>.render-integrity.json`, so the next QA pass doesn't re-score stale
   data. **Embed the same PCM the generation-time embed used** — the
   **pre-resample, pre-loudnorm** take (`r.pcm` at the engine's native rate),
   *not* the chapter-grid-resampled bytes `buildSynthReplacements` splices to
   disk — so the stored row matches what a future pass would re-embed. Capture
   `{segmentIndex → newEmbedding}` in the synth-callback scope and write the
   sibling rows **after** `finalizeChapterAudioWrite` returns (one more atomic
   single-file write — do **not** widen that shared helper's signature, since
   the splice path and generation also call it).
4. **Bounded:** up to **~2 retries**; if none clears the margin, **leave the
   original** and downgrade to `inconclusive` ("couldn't auto-fix — manual look").

- **Surfacing:** the route's `qa_repair_complete.repaired` list gives the
  **"N lines auto-fixed"** count; render-integrity repairs are tagged in the
  per-chapter verdict rows so the derived book view can attribute them to the
  voice gate.
- **Gating — two independent gates:**
  1. **Local control:** a default-off `qa.speaker.autoRepair` setting
     (self-hosted operators flip it on — *not* entitlement-gated; local auto-fix
     is intentionally free).
  2. **Hosted paywall (later):** the com-1 Cast-Pass entitlement wraps the
     *action* when it lands — a clean later seam at the route boundary (no
     entitlement code in the server today).
- **Trust gate (sequencing):** auto-fix is built this session but its default
  stays off until the §6 held-out operator listen confirms the severe tier's
  out-of-sample FP is low enough to auto-act on (auto-acting on a false positive
  burns compute *and* can replace a fine line with a worse take).

## 6. Calibration (real on-box data, operator-validated)

Discharges Phase-0 caveat #5. **Engine note:** the on-box library is **Qwen**;
v1 calibrates Qwen. **Coqui rides the same per-character percentile rule but is
documented uncalibrated** until Coqui over-generation data exists (the
per-character-relative design absorbs cross-engine floor differences in
principle, but this is stated, not assumed).

1. **Embed on-box** — run `/embed` (or a thin harness reusing the spike's
   `probe_real_library.py` / `cutoff_scan.py` / `analyze.py`) over real renders
   on disk. CPU, GPU-free, multi-thousand-segment serial pass → background. This
   same harness is the `embeddingsVersion` re-embed path (§3).
   - **Calibration book:** *Skulduggery — Scepter of the Ancients* (7452 segs,
     182 flagged) → per-character anchor-eligible distributions → pick the band
     parameters (severe-edge percentile, band width, N, K), the **min-duration
     floor** (cosine-variance-vs-clip-length on real renders — the F5 number),
     and **checked-coverage %**.
   - **Held-out, two books for two error types:** *Unlocked* (169 flagged, same
     series → **FN** signal) **and** a **different-voice book** — *The Coalfall
     Commission* (clean → **FP**-only signal, testing the percentile against a
     voice set the calibration never saw). Parameters chosen on Scepter are
     **applied, never tuned**, on both.
2. **Operator-listening validation (needs the operator's ears).** Per §0 item 4,
   the existing ASR/audio-QA flags are *not* valid ground truth. On the held-out
   books, surface the flagged tail + the straddle band (~15–20 clips, the spike's
   `f4_listen` mechanism); the operator listens and judges. Record the
   **out-of-sample FP/FN** and the **F4 residual-value fraction** — the headline
   Ship-notes number.
3. **Overfit guard:** documented FP/FN are the **held-out** numbers, never the
   Scepter ones.

**Build-vs-listen boundary (this is not fully autonomous).** The *build*
delivers: the embed harness, the cutoff-fitting, and the listen-set generator +
a results-recording slot. The **FP/FN recording and the `autoRepair`
default-flip are an explicit post-listen manual step.** Detection ships
regardless of the listen outcome; if the listen reveals high FP, re-tune →
re-listen is a **bounded follow-up**, not a branch blocker (auto-fix simply
stays off). The embed-and-calibrate pass is GPU/weights-bound → **opt-in
golden-audio tier, not `verify`**; the normal-tier regression test (§7) guards
cutoff-*constant* drift only, not calibration correctness (stated honestly).

## 7. Testing

- **Sidecar pytest** (`test_speaker_embed.py`) — §2, incl. the cold-load-lock
  no-double-load case.
- **Node unit:** centroid build — Option A with **fallback-exclusion**,
  **deterministic iterate-to-converge trim** (fixed α/ε/M, asserted convergent),
  **bimodal-distribution → prefer-Option-B** + the `cosine(A,B)` tripwire, Option
  B (K-render via mocked `provider.synthesize`), terminal `reference-too-short`;
  3-tier scoring against committed fixture embeddings; verdict store **separate
  from vectors** — the book-outline derive reads only the small
  `<slug>.render-integrity.json` files, never the embeddings; sibling-file join
  incl. **torn-write tolerance** (segments present, embeddings missing →
  inconclusive) and **stale-vs-missing** `embeddingsVersion`; per-group sampleRate
  passed through; event shape incl. `fixable` (structural-fallback ⇒ not fixable);
  auto-fix accept-check (margin-above-U, best-of-N, **re-embed (pre-resample PCM)
  replaces stale row**, retry cap, couldn't-fix → inconclusive) with a mocked
  re-record + mocked `/embed`.
- **Regression pin:** the calibrated band-parameter constants against committed
  fixture embeddings.
- **CI scope:** calibration is opt-in golden-audio; normal CI runs the pure Node
  tiers + the pytest-skip tier.

## 8. The issues-outline as the primary Cast Pass upsell surface

Detection + the issues-outline are **free, on purpose** — that outline is the
highest-value upsell real estate. A user who hasn't enabled auto-QA (or later,
hasn't paid for Cast Pass) still sees the full outline of detected voice issues
("Chapter 4 · Skulduggery — 3 lines suspect voice"); seeing the problem is the
hook. The **fix** is the paid action.

- Each issue carries an **"Auto-fix with Cast Pass"** CTA, positioned
  **alongside cast-carry (series memory, fe-40)** as the two headline Cast Pass
  props — *"carry your cast across the whole series, and auto-fix voice drift so
  your listeners never hear a bad line."* Two reasons to pay, one surface.
- **Free / non-paid:** outline shown, fix CTA gated.
  **Paid (com-1):** same outline with issues already resolved — "N lines
  auto-fixed" + remaining inconclusive ones flagged for a manual look.
- **This session's obligation:** the render-integrity events (§4.3) + the
  derived book view carry the per-issue structure an upsell outline needs. fs-51
  (#973) renders the outline from that derivation; com-1 gates the fix; both
  build *to* this shape. The upsell UI itself is **not** on this branch.

## 9. Settings (config registry, group `qa-gates`)

`qa.speaker.enabled` follows the `qa.asr.enabled` shape (`registry.ts:194`).
**`qa.speaker.device` is the first device-shaped key in `qa-gates`** — there is
no `qa.asr.device` to mirror (`ASR_DEVICE` lives only in help text); it is valid
per the `ApplyMode` union (`config/types.ts:6`), just not a copy of an existing
ASR setting.

| key | env | apply | default | risk |
|---|---|---|---|---|
| `qa.speaker.enabled` | `SEG_SPK_ENABLED` | `live` (lazy model load on first `/embed`) | `false` | low |
| `qa.speaker.device` | `SPK_DEVICE` (`cpu`/`cuda`) | `restart-sidecar` | `cpu` | medium |
| `qa.speaker.autoRepair` | `SEG_SPK_AUTO_REPAIR` | `live` | `false` (until §6 clears) | medium |

Env threads through `spawn-sidecar.ts` (`...process.env`, `:435`) for free. The
cuda option is wired in the enum now but its plumbing is Phase 2.

## 10. Coexistence with config drift

Separate signals; `revisions.ts` untouched.

| Signal | Source | Meaning |
|---|---|---|
| Config drift | `revisions.ts` | cast edited since this chapter rendered (deterministic) |
| Render-integrity | acoustic (this spec) | a line strays from the voice's own centroid (stochastic misfire) |
| Consistency | acoustic (Phase 2 — conditional) | character wandered across the render |

## 11. Acceptance

- [ ] `SpeakerEngine` + `POST /embed`, CPU-only, **raw-body transport**,
      Whisper-idiom loader (no `lru_cache` double-load), numpy resample; sidecar
      pytest green; `speechbrain` **+ an explicit `huggingface_hub` pin** in a
      shared `speaker-qa.txt` overlay fragment (not `base.txt`), resolved set
      recorded in Ship notes; CPU `/embed` latency benchmarked (incl.
      concurrent-book case) → inline-vs-post-pass chosen.
- [ ] Embed step passes per-group sample rate; **vectors** in
      `<slug>.embeddings.json` (base64 Float32) **separate from** the small
      per-chapter **verdict** store `<slug>.render-integrity.json`; join tolerates
      torn writes; `embeddingsVersion` stale ≠ missing (re-embed path exists).
- [ ] Stochastic-only filter at the embed step (Kokoro-configured characters
      skipped); hybrid centroid with **fallback-exclusion** + deterministic
      robust-trim + **bimodal→prefer-B** guard (A), K-render-via-
      `provider.synthesize` fallback (B), terminal `reference-too-short` →
      inconclusive, named in the derived report.
- [ ] 3-tier per-character verdict (raw-duration floor, limitation noted;
      symmetric windowing); events carry the §4.3 shape incl.
      `expectedEngine`/`renderedEngine` + the refined `fixable`; per-chapter
      verdict rows persisted, **book aggregate derived on read** (no racy file).
- [ ] Auto-fix built **into** `chapter-qa-repair.ts` (~6 localized edits;
      route already async + best-of-N): acoustic candidate source (parallel merge
      after the scan loop) + acoustic accept-check (margin-above-U, best-of-N) +
      **re-embed (pre-resample PCM) replaces the stale row, written post-finalize**;
      engine-availability probe; structural-fallback ⇒ not fixable; default-off
      `qa.speaker.autoRepair` (until §6 clears); `repaired` count = "N auto-fixed".
- [ ] Calibration: band params + min-duration floor picked on Scepter; FP/FN +
      residual-value documented on the **held-out** Unlocked (FN) + Coalfall (FP)
      sets after an operator listen; Coqui documented uncalibrated; cutoff
      constants pinned by a normal-tier regression test; "calibration not
      re-verified in CI" limitation stated. Build delivers the listen-set
      generator; FP/FN recording + default-flip are an explicit post-listen step.
- [ ] Settings (`qa.speaker.enabled` live/off, `qa.speaker.device` restart/cpu —
      first device key in `qa-gates`, `qa.speaker.autoRepair` live/off).
- [ ] Event + derived-book-view shape ready for fs-51's issues-outline +
      com-1's fix gate (§8); no upsell UI on this branch.

## Ship notes

**Shipped:** 2026-06-22 · merged to `main` as `372eeeae` (PR #987) — built +
calibrated on `feat/sidecar-srv-36-phase1`. On-box calibration + operator listen
completed 2026-06-22. fs-51 (per-book QA report UI) + com-1 (entitlement / paid
auto-repair) remain as separate follow-on work.

- **Centroid params:** in-book minimum `CENTROID_MIN_N = 10` anchor renders;
  Option-B audition fallback `CENTROID_K = 12` renders; bimodal min-side
  fraction 0.2. Anchor set = gate-OK, per-segment `renderedFallbackEngine`
  unset, stochastic-configured (qwen/coqui); Kokoro characters skipped
  (deterministic engine, no drift risk).
- **Verdict cutoffs (calibrated, retained):** per-character percentile —
  `severeEdgePctl = 6` (E, voice-mismatch), `bandUpperPctl = 10` (U, above =
  voice-match; E→U = inconclusive), `minDurationSec = 3.0` (sub-floor →
  inconclusive). **Per-character percentile is mandatory, not a global absolute
  cosine** — operator-verified drift/clean boundaries differ sharply per voice
  (china-sorrows reads *clean* at cosine 0.478 while narrator is *drift* at
  0.507), so no single absolute threshold separates them. An absolute-cutoff
  alternative was prototyped during calibration and **rejected** on this
  evidence. 6/10 fit verdicts near-exactly for stephanie/skulduggery; a thin
  ~0.05-wide over-flag band remains for the tightest voices (narrator) — no
  percentile value improves all characters simultaneously, so 6/10 is the
  balance. `minDurationSec=3.0` because every operator "borderline" call was a
  <3 s clip.
- **Calibration data:** real on-box Qwen renders — Skulduggery/_Scepter of the
  Ancients_ (22 characters, 4,799 gate-OK segments) + Keeper/_Unlocked_. Fit on
  Scepter; cross-book confirmation on Unlocked.
- **Held-out FP/FN:** **27/27 extreme-tail flags (cosine 0.05–0.27) confirmed
  real voice drift by operator listen — 0 false positives**, across two series.
  Decision-band listen (16 add'l clips, 0.30–0.68) mapped per-character
  boundaries and validated the percentile structure. _Coalfall dropped from the
  FP baseline_ — its audio is fine (operator-confirmed), but its two-pass
  voice-ID naming fragments per-character centroids, making it unsuitable as a
  clean-FP set (fs-22 Wave2-redo territory, not a gate defect).
- **Residual value:** all 27 confirmed-drift segments had already passed ASR +
  audio-QA — i.e. drift these gates structurally miss, now caught. The severe
  tier is ~6% per character by construction; its extreme sub-tail (≤0.27) was
  100% real drift.
- **CPU `/embed` latency:** ~60–65 ms/segment observed during calibration
  (4,799 Scepter segments embedded in ~5 min on CPU, incl. per-chapter cached
  ffmpeg decode). Not a dedicated micro-benchmark, but confirms the **inline**
  embed choice (piggybacks the ASR-QA pass with PCM already in memory) is
  acceptable; post-pass not needed.
- **Resolved dependency pins** (`requirements/speaker-qa.txt`): `speechbrain==1.1.0`,
  `huggingface_hub==0.36.2` (the prior `<0.26` ceiling was a bug — would have
  blocked the resolved version). torch 2.11.0+cu128 (already pinned in cpu.txt).
- **Defaults:** all `qa.speaker.*` remain default-OFF. `autoRepair` stays off
  by design — it is the paid "fix" half, turned on by the Cast Pass entitlement
  (com-1), not a static default. Detection free, fix paid.
- **Known v1 limitation:** the thin ~0.05-wide over-flag band on the tightest
  voices means a small fraction (~1–2% of those characters' segments) of clean
  low-tail reads can surface as inconclusive/mismatch. Acceptable for v1
  (gate default-off); revisit with a z-score/per-character-σ cutoff if it bites.
