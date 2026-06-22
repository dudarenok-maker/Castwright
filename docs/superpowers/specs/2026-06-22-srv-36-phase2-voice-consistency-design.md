---
status: draft
date: 2026-06-22
topic: srv-36 Phase 2 — voice consistency (cross-book / per-emotion / temporal), spike-gated
issue: srv-36 (#665) — Phase 2 follow-on to the shipped Phase-1 render-integrity gate
depends_on: >
  srv-36 Phase 1 (ECAPA /embed + per-character centroid + <slug>.embeddings.json,
  shipped #987), srv-43 (immutable voiceUuid storage key, merged #940),
  fe-40 / plan 126 (series cast-carry: unified voiceId/voiceUuid across books),
  srv-47 (optional GPU embed path, merged)
relates_to: >
  fs-51 (#973) per-book QA report UI — consumes the consistency events as
  conditional rows; com-1 Cast Pass entitlement seam — gates auto-repair when
  hosted; fs-55 (#993) variant-fidelity gate — SUBSUMED by storage-key keying
  (see §4.3); fs-25 (per-emotion variants) — supplies the variant storage keys
supersedes_in_part: >
  the Phase-1 acoustic spec §4 "Phase 2 — deferred" bullets (consistency drift,
  per-emotion reference sets, cross-book/series consistency) — this spec is their
  concrete realisation
---

# srv-36 Phase 2 — Voice consistency (cross-book, per-emotion, temporal)

## 0. The reframe (why this is one feature, not three)

Phase 1 answered *"did this single line misfire against the character's own
in-book centroid?"* — a per-book, per-line render-integrity check. Phase 2's
brief, from the Phase-1 acoustic spec §4, bundles three "consistency" axes:
**cross-book / series consistency**, **per-emotion** reference sets, and
**temporal / intra-render wander**. Treated as three detectors they fragment.
Treated as queries against **one persistent, voice-identity-level anchor** they
collapse into a single mechanism.

The unification turns on two facts that already exist in the codebase (both
merged since the Phase-1 spec was written):

1. **`voiceUuid` (srv-43)** — an immutable per-voice nanoid identity, minted at
   design time, globally unique so there is no cross-series collision
   (`voice-mapping.ts:48`). A durable, book-independent anchor key.
2. **A designed emotion variant is a *suffix on the base voice key*, not a
   separate identity** (`voice-mapping.ts:43`):
   `variants?.[emotion] ? \`${baseVoice}__${emotion}\` : baseVoice`, and emotion
   selection is a strict no-op for every engine except Qwen (line 36).

So if the anchor is keyed by the **resolved render-target storage key**
(`qwen-<voiceUuid>` or `qwen-<voiceUuid>__<emotion>`) rather than the raw
character or the raw `voiceUuid`, then:

- **Cross-book consistency** is "does this book's render of `qwen-<voiceUuid>`
  still match the canonical anchor that storage key established?" — automatic for
  every carried (series-reused) voice.
- **Per-emotion fidelity** needs *no separate subsystem*: a designed variant
  `qwen-<voiceUuid>__angry` is a first-class anchor of its own, checked by the
  exact same comparison. This also **subsumes fs-55** (a designed variant whose
  timbre slips from intent is just a storage key drifting from its own anchor).
- **Temporal wander** is a trend statistic over the same per-line cosine series.

This is `type:feature`, Large, and — like Phase 0 — **gated on a spike that can
say no, per axis** (§2). Detection stays advisory-and-free; the *fix* is the
gated tier (§5).

### 0.1 What this is NOT
- **Not a re-cast detector.** Cross-book consistency only fires for storage keys
  that **recur across books** (carried via series-reuse, fe-40). A book that is
  *independently cast* (a different `voiceUuid` for the "same" character by
  authorial choice) has no canonical to compare and emits no signal — that is a
  different voice *by design*, not drift.
- **Not a synthesis-quality judge.** The canonical is built from this engine's
  own renders, so the check means "matches this voice's own established central
  tendency," not "is acoustically correct" (Phase-1's documented circularity
  limitation carries forward).
- **Not a replacement for Phase 1.** Phase-1 per-line render-integrity stays. The
  canonical anchor *supersedes the book-local centroid as the reference* for
  carried voices, but the scoring/verdict machinery is reused.

## 1. The central risks (all measured on this product's real series data)

None are answerable from the literature; all are measured on **real on-box
series renders** (Skulduggery: recurring characters across multiple books — the
single-book Coalfall fixture cannot exercise cross-book). The operator's ears
are the ground truth, as in Phase-1 calibration.

- **R1 — cross-book stability (the existential one).** Is the same storage key's
  centroid stable *across books*, with book-to-book variance clearly narrower
  than the gap that would signal real drift? If book-to-book scatter is as wide
  as the within-book stochastic floor (Phase-0 F1), cross-book consistency is
  undetectable → **no-go for the cross-book axis**.
- **R2 — seed divergence.** How far does the approved-audition centroid sit from
  the first-book empirical centroid, per storage key? Near-identical → the
  maturation step (§3.2) is a no-op and should be dropped (YAGNI). Materially
  different → maturation earns its keep, *and* the divergence is itself a useful
  signal that the audition sample was unrepresentative of the voice at length.
- **R3 — per-emotion timbre shift.** Does a **base** voice reading emotional
  lines (no designed variant) shift ECAPA timbre materially vs the neutral
  canonical? ECAPA is timbre-driven, so the prior is "small." If material → add
  a per-emotion tolerance on the base anchor (§4.3); if not → emotional delivery
  on the base voice needs no special handling.
- **R4 — temporal-wander existence + residual value.** Does monotonic intra-book
  drift exist *above the floor*, AND does it survive a residual-value test
  against per-line + cross-book scoring (a character whose lines each sit inside
  the per-line band but whose cumulative trend is real)? If wander is rare or
  already caught by per-line/cross-book, **no-go for the wander axis** (it is the
  most speculative; the Phase-1 spec gated it on "F1/F3 show headroom").

## 2. The spike (the gate — per-axis go/no-go)

A throwaway harness (committed under `server/tts-sidecar/spikes/srv36/`, beside
the Phase-0 spike), operator-driven on the GPU box. **No production code, no
settings, no events.** It over-generates / re-uses real series renders for a set
of recurring characters across ≥2 books, embeds with the shipped ECAPA
`/embed`, and measures R1–R4.

| Exp | Question (risk) | What it gates |
|---|---|---|
| **G1 — cross-book stability** | Per storage key, cosine spread of book-A vs book-B clean-render centroids vs the within-book F1 floor. (R1) | **Kill-switch for cross-book** — wide ⇒ no-go. |
| **G2 — seed divergence** | cosine(approved-audition centroid, first-book empirical centroid) per storage key. (R2) | Whether the §3.2 maturation step ships at all. |
| **G3 — per-emotion shift** | For base voices reading emotional lines (no variant): timbre delta vs the neutral canonical. (R3) | Whether a per-emotion tolerance is needed on the base anchor. |
| **G4 — wander existence + residual** | Monotonic slope of cosine-to-canonical over render position, above the floor; fraction of wander cases NOT already flagged by per-line/cross-book. (R4) | **Go/no-go for the wander detector.** |
| **G5 — operator listen** | Operator audits the ECAPA-flagged cross-book mismatches (~15–20 clips, two series): real drift vs false positive. | The headline FP/FN; confirms R1 with human ground truth. |

**Go condition (per axis):**
- *Cross-book ships* iff G1 floor is tight AND G5 confirms real, human-audible
  drift at low FP.
- *Maturation ships* iff G2 shows material approved-vs-empirical divergence.
- *Per-emotion tolerance ships* iff G3 shows material base-voice emotion shift.
- *Wander detector ships* iff G4 shows wander exists above the floor AND is
  non-redundant with per-line/cross-book.

The recommendation output is **one `{ go | no-go }` per axis** — cross-book may
go while wander no-goes. On a full cross-book no-go, Phase 2 closes
`wont-fix-consistency`: Phase-1 per-line render-integrity remains the QA signal,
and fs-51 ships without a consistency row.

## 3. The canonical anchor

### 3.1 Keying
Keyed by the **resolved render-target storage key** as produced by
`qwenStorageKey` (`voice-mapping.ts:20`) composed with `pickEmotionVariantVoice`
(`voice-mapping.ts:30`):
`qwen-<voiceUuid>` for base/neutral renders, `qwen-<voiceUuid>__<emotion>` for a
designed variant. Engine-agnostic embed (the same ECAPA model for reference and
rendered segment); only **stochastic** engines are in scope (Qwen, Coqui) —
Kokoro is deterministic, hence nothing to drift, and out of scope (Phase-1 rule).

### 3.2 Lifecycle: warm-start → mature → freeze → forward
1. **Cold-start (pre-render, always available):** the anchor is the embedding of
   the **approved audition sample** for that storage key (the voice the user
   signed off on; designed variants have their own audition). So book 1, line 1
   already has something to score against.
2. **Maturation across book 1 (conditional on G2):** the anchor matures toward
   the **clean, trimmed-majority** centroid of book-1 renders — reusing Phase-1's
   robust centroid logic (trimmed mean; `renderedFallbackEngine` segments
   excluded; bimodal large-drift cluster ⇒ prefer the audition anchor). It
   **never matures toward fallback/outlier/drift renders** — the guard that
   stops the anchor from "learning the disease" (the same poisoning class as
   Phase-1's C1 fix).
3. **Freeze at book-1 completion:** compute the frozen canonical from the clean
   majority (audition as tiebreak/fallback), **persist it**, then **re-score
   book 1's already-persisted embeddings against the frozen canonical** for book
   1's *final* verdict. Re-scoring is free (embeddings already on disk, no
   re-embed), makes scoring **deterministic w.r.t. render order** (pinnable in a
   regression test), and gives book 1 the *same* canonical treatment as every
   later book — so book 1 is not an unchecked seed-only throwaway.
4. **Forward:** every later book scores against the frozen canonical and **never
   alters it**.

**Which book is "book 1": first-rendered-wins (chronological), not
lowest-seriesPosition.** You may render book 2 before book 1; the first storage
key to *complete a render* freezes the canonical, and the audition covers the
pre-freeze window for every book regardless of series order. (Re-freeze is only
triggered by a voice re-tune, §3.4 — not by later rendering an
earlier-in-series book.)

### 3.3 Store
A voice-level `<storageKey>.canonical.json` living beside the audition it is
seeded from (the `voice-sample-cache.ts` neighbourhood), **independent of any
book directory** — because the anchor is a property of the voice identity, not a
book. Holds the 192-float canonical embedding (base64-packed Float32, matching
Phase-1's `<slug>.embeddings.json` encoding), the seed provenance
(audition-only / matured), and the source book id + render count behind it.

### 3.4 Versioning
- Keyed/invalidated by the **voice-config hash** (re-mint the canonical when the
  voice is re-designed/tuned) — reuses Phase-1's reference-cache hashing.
- An `anchorVersion` field invalidates on a model/preprocessing change (mirrors
  Phase-1's `embeddingsVersion`). A stale or missing canonical ⇒ the storage
  key's lines are `inconclusive`, never an error.

## 4. Detection & scoring

### 4.1 Cross-book per-line
`cosine(segment embedding, emotion-matched frozen canonical)`; below the
calibrated cutoff ⇒ `voice-mismatch` **against series canonical**. Reuses
Phase-1's per-character percentile band machinery and `score.ts`, re-anchored
from the book-local centroid to the frozen canonical. Verdict vocabulary stays
`'voice-match' | 'voice-mismatch' | 'inconclusive'` (avoids the `AsrVerdict
'drift'` collision); events carry `metric: 'render-integrity'` plus a
`scope: 'series-canonical'` discriminator so fs-51 can distinguish a Phase-1
in-book misfire from a Phase-2 cross-book mismatch.

### 4.2 Systematic-vs-per-line classifier
Per character per book, compute the **mismatched-line fraction**. Above a
calibrated threshold ⇒ **systematic** (the voice itself is off in this book) ⇒
**escalate to advisory, do NOT run the repair loop** (per-line re-rendering is
futile when every render misses the canonical). Below ⇒ **per-line** ⇒
repairable (§5). The threshold is a calibrated, pinned constant (G5 informs it).

### 4.3 Per-emotion (collapsed)
No separate per-emotion subsystem. Designed variants are first-class anchors via
§3.1 keying. The **only** per-emotion addition — and only if G3 shows it is
needed — is a tolerance on the **base** anchor for emotional delivery without a
designed variant. Windowed short-segment queries (Phase-1's coverage mitigation)
remain **excluded** from per-emotion and wander analysis (averaging across the
emotion axis is exactly what these must not do — Phase-1 rule, carried forward).

### 4.4 Temporal wander (conditional on G4)
Only built if G4 = go. The v1 statistic is the **simplest viable**: early-half
vs late-half centroid divergence within a book for a character, reusing the
centroid machinery (a slope/regression variant is a later refinement, not v1).
Emits a distinct `metric: 'voice-consistency-wander'` event.

## 5. Action

- **Detection is free and always surfaced.** fs-51 (#973) renders a conditional
  per-book row + a badge: *"character X drifts from series canonical"*; a
  **systematic** finding reads *"voice may need re-pinning in this book."* The
  report **names unchecked storage keys** (insufficient reference / too-short),
  never letting the summary read "all clear" while skipping the riskiest cohort
  (Phase-1's visibility rule).
- **Auto-repair is real and active when the gate is on** (§6) — it extends the
  existing `chapter-qa-repair.ts` best-of-N loop: a **per-line** cross-book
  mismatch re-renders the line and accepts a candidate only if its cosine to the
  **canonical** clears the accept margin (re-embed the pre-resample PCM,
  replacing the stale row). **Systematic** findings skip the loop and escalate
  (§4.2).
- **com-1 Cast Pass entitlement is wired as a route-boundary seam that currently
  returns "granted"** — the paywall is open now (treat-as-on), so the loop runs
  in dev/local today. com-1 flips the seam to real entitlement enforcement later
  with **zero code change at this site**. (com-1 was blocked on srv-43, now
  merged — the seam is unblocked to build against.) Detection free, fix
  (eventually) paid — the series-consistency story is a primary Cast Pass upsell
  surface alongside cast-carry/series-memory.

## 6. Settings & cost posture

- The render-integrity gate **`qa.speaker.enabled` stays opt-in / default-OFF**
  (it costs an embed per line + potential re-renders). When **on**, Phase 2
  detection **and** active auto-repair run — there is **no separate default-off
  `autoRepair` barrier** to flip (the Phase-1 separate flag is *not* the Phase-2
  shape; enabling the gate enables the loop, entitlement-permitting).
- Reuses `qa.speaker.device` (the srv-47 cuda path is already merged); CPU stays
  the default.
- **No new master flag.** Phase 2 extends the existing `qa-gates` group only if
  the spike makes cross-book optional-within-the-gate; otherwise it is "the
  gate."
- **On-box dogfood:** shipped default stays OFF for everyone; **this box runs it
  ON via a local `user-settings.json` override** to validate the upsell story
  end-to-end (drift caught → auto-repaired → consistent series). This is a local
  override, **not** a default change — it preserves the honest cost posture while
  letting the operator live with the feature. (Flipped on this box as the first
  dogfood step once Phase 2 is built; not before — there is no Phase-2 code to
  exercise yet.)

## 7. Emotion / storage-key persistence (the small schema work)

Per-segment, persist the **resolved render-target storage key** — one field
added to the `{ characterId, sentenceIds, renderedFallbackEngine }` record
(`segments-io.ts:54`) and its writer. This is cleaner than persisting
`group.emotion` (the storage key already encodes variant-selection **and**
`voiceUuid` resolution in one value), and it is what lets each persisted
embedding be scored against the correct canonical at re-score / cross-book time.
Absent on pre-Phase-2 files ⇒ the segment is `inconclusive` for the cross-book
check, never an error (matches the Phase-1 missing-embedding rule).

## 8. Reuse (foundations already merged — NOT built here)

- `voiceUuid` immutable identity + `qwenStorageKey` (srv-43, `voice-mapping.ts`).
- Series cast-carry: unified `voiceId`/`voiceUuid` across books
  (`series-reuse-link.ts`, fe-40 / plan 126) — supplies the recurrence that makes
  cross-book meaningful.
- ECAPA `SpeakerEngine` + `POST /embed`, `<slug>.embeddings.json` (base64
  Float32), robust per-character centroid, `score.ts` band machinery, verdict
  vocabulary, `chapter-qa-repair.ts` repair loop (srv-36 Phase 1, #987).
- Optional GPU embed path (srv-47) — embedding cost is not a blocker.
- fs-51 (#973) event consumer.
- **Known seam to harden here:** the **book-completion trigger** (a Phase-1
  follow-up: "last-chapter single-flight book-completion trigger") — the §3.2
  freeze depends on a reliable single-flight "book N finished rendering" signal,
  so this spec hardens it rather than assuming it.

## 9. Acceptance

**Spike (the deliverable even on no-go):**
- [ ] G1–G5 run on ≥2 real series (Skulduggery + one held-out); findings note
      committed with cross-book stability vs the F1 floor (G1), seed divergence
      (G2), base-voice emotion shift (G3), wander existence + residual-value
      fraction (G4), and an operator-listen FP/FN (G5).
- [ ] A **per-axis** `{ go | no-go }` recommendation. On full cross-book no-go:
      Phase 2 closed `wont-fix-consistency`, this spec marked `superseded`, fs-51
      confirmed unaffected.

**Build (per the axes that went go):**
- [ ] Canonical anchor keyed by render-target storage key; warm-start →
      (conditional) mature → freeze-and-re-score at book-1 completion; forward
      books read-only; voice-level `<storageKey>.canonical.json`, versioned by
      voice-config hash + `anchorVersion`.
- [ ] Cross-book per-line scoring re-anchored to the canonical;
      systematic-vs-per-line classifier with calibrated, pinned threshold;
      `scope: 'series-canonical'` event discriminator.
- [ ] Per-emotion handled by keying (designed variants first-class); base-voice
      emotion tolerance only if G3 demands it; windowed queries excluded.
- [ ] Temporal-wander detector only if G4 = go (early/late centroid divergence).
- [ ] Per-segment resolved-storage-key persistence (`segments-io.ts` + writer).
- [ ] `qa.speaker.enabled` opt-in default-OFF; gate-on ⇒ detection + active
      repair; com-1 entitlement seam present-but-granted; on-box-ON via local
      override documented in the test protocol.
- [ ] fs-51 (#973) consumes consistency events as conditional rows; unchecked
      storage keys named.
- [ ] Calibration on real series labels with an **operator listen**; cutoffs +
      systematic threshold pinned by a normal-tier regression test; out-of-sample
      FP/FN + the cross-book residual-value fraction documented in Ship notes.

## 10. Out of scope (this spec)

- Cross-engine canonical transfer (a Qwen canonical scoring a Coqui render) —
  engine-systematic; out of scope (each engine, each storage key, its own
  canonical).
- A slope/change-point wander detector beyond the early/late-centroid v1.
- Human-rated *perceived*-drift holdout beyond the operator-listen calibration.
- Turning the com-1 paywall on (com-1 owns the flip; the seam is built granted).
- Flipping the shipped default on (stays OFF; on-box override only).

## Ship notes

_(filled on ship: date · commit SHA · per-axis recommendation {go|no-go} ·
cross-book stability vs F1 floor · seed divergence · base-voice emotion shift ·
wander residual-value fraction · systematic threshold · operator-listen FP/FN ·
out-of-sample cross-book FP/FN)_
