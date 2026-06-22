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
  hosted; fs-55 (#993) variant-fidelity gate — this spec provides the SUBSTRATE
  (variant-canonical vs base-canonical is one comparison away) but does NOT
  perform fs-55's check; keep #993 open (see §0.2); fs-25 (per-emotion variants)
  — supplies the variant storage keys
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
  every carried (series-reused) voice. **Verified load-bearing fact:**
  `resolveReusedVoiceFields` walks the `matchedFrom` chain and carries
  `voiceUuid: source.voiceUuid` onto the reused row (`hydrate-reused-voice.ts:110`),
  so a series-reused character resolves to the **same** storage key across books.
  When the reuse link is absent (re-cast / re-design), the key differs — §0.1.
- **Per-emotion fidelity** needs *no separate subsystem*: a designed variant
  `qwen-<voiceUuid>__angry` is a first-class anchor of its own, checked by the
  exact same comparison. (This is the *substrate* for fs-55 but **not** fs-55
  itself — see §0.2.)
- **Temporal wander** is a trend statistic over the same per-line cosine series.

**Engine scope (load-bearing): cross-book is Qwen-only in v1.** The unique,
collision-free identity that makes the whole scheme work is the Qwen
`voiceUuid`. Coqui voices are *shared catalog speakers* (XTTS built-ins) with no
per-character unique key — two characters can use the same speaker, so a
Coqui-keyed canonical would cross-contaminate. Qwen is the default/main
generation engine anyway (CLAUDE.md), so v1 cross-book scopes to Qwen; Coqui
cross-book is deferred (§10). The spike still measures Coqui's *within-book*
floor (Phase 1 already covers Coqui there).

This is `type:feature`, Large, and — like Phase 0 — **gated on a spike that can
say no, per axis** (§2). Detection stays advisory-and-free; the *fix* is the
gated tier (§5). The build decomposes into waves for the plan (§9.1), not one
undifferentiated push.

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

### 0.2 fs-55 is a sibling, not a casualty
fs-55 (#993) wants *"does this designed variant still sound like the **base
character**?"* — a **variant-canonical vs base-canonical** comparison. This spec
instead checks *"does each storage key match **its own** established canonical?"*
— a different comparison pair. The two share the exact same anchor machinery
(both are cosines between two canonicals/embeddings), so this spec **provides the
substrate** for fs-55 — but it does **not** perform fs-55's check, and #993 must
stay open. Do not close fs-55 against this spec.

## 1. The central risks (all measured on this product's real series data)

None are answerable from the literature; all are measured on **real on-box
series renders**. **On-box data reality (verified, load-bearing — corrects an
earlier assumption):** of the rendered series, only **Keeper of the Lost Cities
(7 books) has ≥2 Qwen-rendered books** with recurring characters. Skulduggery
(Scepter) and Night Watch are **single rendered books**; Castwright/Coalfall are
standalones. **So Keeper is effectively the *only* cross-book corpus on-box** —
the spike's cross-book experiments (G1/G2/G6) are **single-series** and their
calibration is **provisional** until a second ≥2-book Qwen series exists (§2 C-row).
The operator's ears are the ground truth, as in Phase-1 calibration.

- **R1 — cross-book stability (the existential one).** Is the same storage key's
  centroid stable *across books*, with book-to-book variance clearly narrower
  than the gap that would signal real drift? If book-to-book scatter is as wide
  as the within-book stochastic floor (Phase-0 F1), cross-book consistency is
  undetectable → **no-go for the cross-book axis**.
- **R2 — seed divergence (and its cross-book spread).** How far does the
  approved-audition centroid sit from each book's empirical centroid, per storage
  key — and how *stable* is that divergence across books? Near-identical
  everywhere → the maturation step (§3.2) is a no-op and should be dropped
  (YAGNI). Materially different → maturation earns its keep, *and* the divergence
  is itself a useful signal that the audition sample was unrepresentative; the
  *spread* of the divergence across books sets the sanity-gate band (Branch B
  step 3) that distinguishes a normally-diverging voice from an anomalously-off
  debut book.
- **R3 — per-emotion timbre shift (a *partial-no-go* risk, not a tunable knob).**
  Does a **base** voice reading emotional lines (no designed variant) shift ECAPA
  timbre materially vs the neutral canonical? ECAPA is timbre-driven, so the prior
  is "small." But note the asymmetry: a *designed variant* gets its own key and
  its own clean anchor; an *un-designed emotional delivery* on the base voice has
  **no separate render target, so no separate key, so no sub-anchor is possible**.
  If G3 shows the shift is material, a "tolerance" on the base anchor is only a
  band-aid (it widens the band → more false negatives; it does not de-blend the
  emotion). The honest outcome is then a **partial no-go**: cross-book stays
  reliable for designed-variant keys and neutral lines, while emotional base-voice
  lines are scored `inconclusive`. The spec must not pretend a tolerance "solves"
  a material G3.
- **R4 — temporal-wander existence + residual value.** Does monotonic intra-book
  drift exist *above the floor*, AND does it survive a residual-value test
  against per-line + cross-book scoring (a character whose lines each sit inside
  the per-line band but whose cumulative trend is real)? If wander is rare or
  already caught by per-line/cross-book, **no-go for the wander axis** (it is the
  most speculative; the Phase-0/acoustic spec §4 gated it on "F1/F3 show
  headroom" — F1/F3/F4 are that spike's experiment labels, not Phase 1's).

## 2. The spike (the gate — per-axis go/no-go)

A throwaway harness (added to the existing `server/tts-sidecar/spikes/srv36/`
spike directory used in Phase 0/1, alongside its `gates.py` / `metrics.py` /
`calibrate.py`), operator-driven on the GPU box. **No production code, no
settings, no events.** It re-uses real **Qwen** series renders (cross-book is
Qwen-only, §0), embeds with the shipped ECAPA `/embed`, and measures R1–R4.

**Pre-registration (C4 — non-negotiable; Phase-1's own history is the warning).**
Phase-1's `FINDINGS.md` records that its *pre-registered* F3 gate proved the wrong
test, returned a poor EER, and was **discarded and replaced mid-spike** with a
human-listen criterion that supported go. That is post-hoc rationalisation. To
not repeat it, **G1 and G6 numeric thresholds are committed to `FINDINGS.md`
*before* the spike runs** (e.g. "no-go if the G1 centroid-spread/floor ratio > X
regardless of G6"; "G6 separation AUC ≥ Y"), and the go-conditions are evaluated
against those committed numbers. Changing a threshold mid-spike must be logged as
a recorded protocol amendment with its rationale, not a silent swap.

**Keying caveat (C2 — the spike validates the legacy key, not the production one).**
Every series book on-box predates srv-43's `voiceUuid` minting, so
`qwenStorageKey` falls back to `qwen-<voiceId>` (e.g. `qwen-sophie`), **not** the
`qwen-<voiceUuid>` the current code mints. The slug happens to be stable across
Keeper books (same `voiceId`), so cross-book stability *is* exercised — but on the
**legacy voiceId key**, and the `matchedFrom`-chain `voiceUuid` carry
(`hydrate-reused-voice.ts:110`) is **assumed equivalent, not measured**. The spike
must either re-render ≥2 Keeper books through the current voiceUuid-minting path,
or the findings note must state plainly: *"cross-book validated on voiceId-keyed
legacy renders; voiceUuid path assumed equivalent."*

**Single-series calibration (C3).** Because Keeper is the only ≥2-book Qwen series
(§1), G1/G2/G6 and the Branch-B **sanity-gate band are fit on one series' cast
distribution** — weaker than Phase-1's two-series co-fit, and the
"prefer-a-held-out-series" hedge is moot (there is no second ≥2-book Qwen series).
Either **gate Branch B's *shipping* on G2 being recomputed across ≥2 series later**,
or ship Branch B with the band marked **provisional/single-series** and say so.
Phase-1 co-fit its per-line cutoffs on both Scepter and Keeper (`score.ts:39`), so
the reused per-line band is not pristine-held-out either; the *cross-book op* is
new (fit on no series) and so out-of-sample in that narrow sense. State the actual
split in the findings note.

| Exp | Question (risk) | What it gates |
|---|---|---|
| **G0 — same-text content control (C1, prerequisite)** | Re-render the **identical audition text** in each book's config and embed: this isolates *timbre* drift from *phonetic-content* differences. The genuine cross-book signal = G1 distance **minus** the G0 same-text floor. Without it, G1 conflates "different sentences" with "different voice." | Whether any G1 distance is even interpretable as drift. A large G0 ⇒ ECAPA is too content-sensitive here ⇒ cross-book no-go. |
| **G1 — cross-book stability** | Per storage key, cosine spread of book-A vs book-B clean-render centroids — **interpreted only against the G0 same-text floor**, and **per-character-relative** (Phase-1 proved the absolute floor is wide, std 0.09–0.14; only per-char-relative cutoffs work), not against a single global F1 number. (R1) | **Kill-switch for cross-book** — drift-above-G0 indistinct ⇒ no-go. |
| **G2 — seed divergence + per-voice spread** | cosine(approved-audition centroid, **each** book's empirical centroid) per storage key — central divergence AND its **spread across books** (so the sanity gate, Branch B step 3, has a per-voice band). **Single-series (Keeper) only on-box (C3).** (R2) | Whether maturation ships (Branch decision, §3.2) AND the sanity-gate band (marked provisional). |
| **G3 — per-emotion shift** | For base voices reading emotional lines (no variant): timbre delta vs the neutral canonical, where the **neutral canonical is built from manuscript/emotion-metadata neutral-tagged lines, NOT merely gate-OK lines** (else emotional-but-ASR-clean lines contaminate the baseline and G3 under-measures the shift, M3). (R3) | Whether a per-emotion tolerance is needed on the base anchor. |
| **G4 — wander existence + residual** | Monotonic slope of cosine-to-canonical over render position, above the floor; fraction of wander cases NOT already flagged by per-line/cross-book. (R4) | **Go/no-go for the wander detector** (prior: probably no-go — a single config renders the voice near-identically). |
| **G5 — operator listen (BLIND, C5)** | Operator audits ~15–20 clips that are **flagged + matched, interleaved, randomized, and unlabelled** (operator does not know which are drift); FP/FN scored against the blind labels; a **second listener** on a subset where feasible. Not the primed "audit the flagged set" of Phase 1. | The headline FP/FN; confirms R1 with **unbiased** human ground truth. |
| **G6 — runtime-operation fidelity** | The *actual production op*: score **individual** lines of a **held-out Keeper book** (one NOT used to build the G1 anchor) against the anchor — genuinely out-of-sample vs G1, not a second statistic of the same renders (I1). Confirms per-line scatter doesn't swamp the signal. | Whether the per-line cross-book check (§4.1) is viable, **independently** of G1. |

**Go condition (per axis) — evaluated against the pre-registered numbers (C4):**
- *Cross-book ships* iff **G0 same-text floor is small** (drift is separable from
  content) AND **G1 drift-above-G0 clears its pre-registered ratio** AND **G6
  (held-out book) clears its pre-registered separation AUC** AND **blind G5**
  confirms real, human-audible drift at low FP. A loose G1 cannot be rescued by
  G6 — both pre-registered thresholds must hold.
- *Maturation (Branch B) ships* iff G2 shows material approved-vs-empirical
  divergence across the (single-series, provisional — C3) cast distribution
  (§3.2); its sanity-gate band comes from G2's per-voice spread and ships marked
  provisional until recomputed across ≥2 series.
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
designed variant. The embed itself is engine-agnostic (same ECAPA model for
reference and rendered segment), but **cross-book keying is Qwen-only in v1**
(§0): only Qwen's `voiceUuid` gives a collision-free per-voice identity. Coqui
(shared catalog speakers, no unique key) is deferred for cross-book; Kokoro is
deterministic — nothing to drift — and out of scope (Phase-1 rule).

### 3.2 Lifecycle — two branches, decided by G2

**The maturation/freeze machinery is conditional on G2 and must not be built
before the spike runs.** G2 measures, per storage key, how far the
approved-audition centroid sits from each book's empirical centroid. **Branch B
is a superset of Branch A** — a voice whose audition ≈ empirical simply freezes a
canonical ≈ its audition. So the choice is **not per-voice runtime branching**;
it is a single build decision read off the **cast-wide divergence distribution**:
if divergence is universally negligible, skip the maturation machinery entirely
(Branch A); if a meaningful fraction of voices diverge, build Branch B and let it
handle the negligible ones for free. The two branches:

**Branch A — G2 null (audition ≈ empirical): the audition *is* the canonical.**
No maturation, no freeze, no re-score. The anchor is the approved-audition
embedding (K renders of the sample to average sampler noise, as Phase-1 did for
its fallback), keyed by storage key, available from book 1 line 1 and identical
across every book. This is the *simpler* design and the spec's preferred outcome
— most of §3.2's complexity evaporates. **Cost note:** K renders × every Qwen
character is real upfront GPU work on the 8 GB box, serialised against the actual
render. **K reconciliation (I5):** the shipped Phase-1 audition centroid uses
`CENTROID_K = 12` (`audition-centroid.ts:24`), NOT the 3–5 an earlier draft
guessed. So the real upfront cost is **12 renders × cast-size** unless the spike
shows a smaller K gives an equally stable centroid (an explicit spike output — if
so, lower K *and re-validate stability at that K*). The K **embeddings are
persisted once per voice-config-hash** in the canonical file — never re-rendered
on subsequent passes (the audition cache holds a single MP3, so this is a one-time
build-the-embeddings cost per config, not per book). The spike measures
**K=12 × cast-size** audition-render wall-time on the 8 GB box and states the
ceiling (the cost gate in §9 uses the real K, not 5).
**Robustness (both branches):** a valid anchor requires **≥K_min successful
renders**; a sidecar crash mid-build leaving a partial K **withholds** the
canonical (the §3.2 step-3 `withheld` status → lines `inconclusive`) rather than
freezing a degenerate few-render centroid — mirrors Phase-1's null-on-dead-sidecar
→ `inconclusive` handling. The build should ship Branch A first and add Branch B
only if G2 forces it.

**Branch B — G2 material (audition diverges from how the voice renders at
length): warm-start → mature → freeze, with a sanity gate.**
1. **Cold-start:** anchor = approved-audition embedding (as Branch A), so book 1
   has something to score against from line 1.
2. **Mature across book 1:** the anchor moves toward the **clean, trimmed-majority**
   centroid of book-1 renders — Phase-1's robust centroid (trimmed mean;
   `renderedFallbackEngine` segments excluded). It **never matures toward
   fallback/outlier/drift renders** (the anti-"learn-the-disease" guard, Phase-1's
   C1 class). **Outlier-exclusion seeds from the render distribution's *own mode*,
   not the (possibly-diverging) audition** — otherwise, in exactly the Branch-B
   case where the audition is far from the render cluster, anchoring exclusion on
   the audition would mis-classify the true cluster. The audition is used **only**
   as the bimodal tiebreak (a large second cluster ⇒ keep the cluster nearer the
   audition).
3. **Sanity gate at freeze (C2 — prevents canonising a drifted debut book).**
   Before freezing, compare the matured centroid to the approved audition. If it
   is **within G2's measured divergence band**, freeze and persist it. If it
   diverges **beyond** that band, the debut book likely rendered the voice
   off-target across the board — so **do NOT canonise it**: fall back to the
   audition anchor and **flag the book** (`voice rendered off-target in its debut
   book — canonical withheld`). This stops the **common** case (a uniformly-shifted
   debut book, *when the audition is representative*). The harder case — audition
   *also* unrepresentative AND debut book drifted — slips past this gate and is
   caught only later by §3.2.bis (and only once ≥2 later books exist); see that
   section's known limitation.
4. **Re-score, then deferred repair (I1).** With the frozen canonical, **re-score
   book 1's already-persisted embeddings** (no re-embed — embeddings are on disk;
   cheap CPU, not literally "free") for book 1's *final*, deterministic verdict.
   **Auto-repair for book 1 runs in this post-freeze pass, not live during book
   1** — so every book-1 repair decision is made against the *canonical*, not the
   immature/noisy pre-freeze anchor. (Live during book 1 we *detect* provisionally
   for progress UI, but defer the repair action.) Later books, which already have
   the frozen canonical at render time, repair inline as usual.
5. **Forward:** every later book scores against the frozen canonical and **never
   alters it**.

**Which book is "book 1": first-rendered-wins (chronological), not
lowest-seriesPosition** — you may render book 2 before book 1; the first storage
key to *complete* a render establishes the canonical (subject to the sanity gate,
Branch B step 3), and the audition covers the pre-freeze window regardless of series
order. Re-freeze is triggered only by a voice re-tune (§3.4).

**Never-auditioned voices (M1).** A character minted without an approved audition
(Phase-1 mints a sample on first QA pass) has no approval to cold-start from or
to sanity-gate against. Such a voice uses its first minted sample as the
cold-start anchor and is **exempt from the sanity gate (Branch B step 3)** (there
is no approval to compare to) — its canonical is flagged `seed: no-approval` so
fs-51 can surface the weaker guarantee.

### 3.2.bis Canonical self-correction — DEFERRED to a follow-up (not in v1)
**Decision (2026-06-22): the auto-re-freeze machinery below is deferred to a
backlog follow-up, NOT built in v1.** Rationale (YAGNI): it guards a rare
triple-conjunction (unrepresentative audition **and** drifted debut **and** ≥2
later books), and because a shared `voiceUuid`/config renders the voice
near-identically *by construction*, cross-book drift is itself the rare event.
**v1 instead surfaces the limitation, doesn't auto-fix it:** a debut canonical
that the sanity gate withheld is already `canonical-suspect` (§4.2), and the
worst residual case carries the `seed: single-later-book` low-confidence marker
(below) → `inconclusive`, never a false "voice off." File the auto-re-freeze as a
backlog item when Phase 2 ships; the rest of this section is its spec.

The canonical-*establishing* book cannot be validated against anything except the
audition — there are no other books yet. So if the audition is unrepresentative
**and** the debut book is itself drifted, the sanity gate (which only sees the
audition) can still freeze a bad canonical. The only evidence that can expose
this arrives **later**: if **≥2 subsequent books each show *systematic*
disagreement** (per §4.2) with the frozen canonical, the parsimonious explanation
is "the debut book was the outlier," not "every later book independently
drifted." The deferred follow-up would then:

- On ≥2 later-book systematic disagreements against a canonical, mark it
  **`canonical-suspect`**, stop trusting "systematic → voice off" for that key,
  and **surface a re-freeze prompt** (operator-confirmed; auto-re-freeze is a
  later refinement — re-freezing silently could itself chase drift).
- Re-freezing recomputes the canonical from the **agreeing majority of books**
  (not just book 1), then re-scores affected books. This is the cross-book
  analogue of Branch B's within-book trimmed majority.
- This mechanism is **Branch-B-tier** (skipped entirely under Branch A, where the
  audition is the canonical and no debut book can poison it).

**Known limitation (state it, don't hide it):** the worst case — an
unrepresentative audition **and** a drifted debut book **and** only **one** later
book rendered so far — is mis-flagged until a second later book exists (the sanity
gate can't catch it; self-correction needs ≥2). A `seed: single-later-book`
confidence marker surfaces this in fs-51 so the guarantee isn't overstated.

### 3.3 Store
A voice-level `<storageKey>.canonical.json` living beside the audition it is
seeded from (the `voice-sample-cache.ts` neighbourhood), **independent of any
book directory** — because the anchor is a property of the voice identity, not a
book. Because a re-tune mints a new version under the **same** storage key
(§3.4), the file holds a **map of versions keyed by voice-config hash**, not a
single embedding: `{ anchorVersion, versions: { <configHash>: { embedding
(base64 Float32, Phase-1 encoding), seed: 'audition' | 'matured' |
'no-approval', sourceBookId, renderCount, status: 'frozen' | 'withheld' |
'canonical-suspect' } } }`. A segment resolves its version by the config hash
§7 persists. (Filename stays one-per-key; versions live inside.)

### 3.4 Versioning (and the re-tune boundary)
- The canonical is versioned by the **voice-config hash** — a re-design/re-tune
  mints a **new** canonical version under the *same* (immutable) storage key.
  Reuses Phase-1's reference-cache hashing.
- **A segment must resolve the canonical *version* it was rendered against, not
  just the key.** Because the storage key is stable across re-tunes, §7 persists
  the **voice-config hash** alongside the storage key, so re-score / cross-book
  scoring picks the matching canonical version. Without this, a pre-tune book
  would be scored against the post-tune canonical and false-flag wholesale. **The
  config hash is always persisted — no render-timestamp fallback** (a timestamp is
  not a stable equality key, so an unchanged voice re-rendered later would resolve
  to a spurious new cohort).
- **Re-tune boundary:** pre-tune books are **not** judged against the post-tune
  canonical (they predate the voice change — that is an intended edit, not
  drift). Cross-book consistency is evaluated **within a config-hash cohort**;
  the report notes "voice re-tuned at book N" rather than flagging the older
  books inconsistent.
- An `anchorVersion` field invalidates on a model/preprocessing change (mirrors
  Phase-1's `embeddingsVersion`). A stale or missing canonical ⇒ the storage
  key's lines are `inconclusive`, never an error.
- **Canonical deleted mid-series** (operator cleanup / workspace move): treated as
  "no canonical" — later books score `inconclusive`, and the canonical is
  **re-established at the next book completion under the §3.5 storage-key lock**.
  No book errors; the guarantee simply degrades to "unchecked until re-established."

### 3.5 Concurrency — the cross-book shared-state contract (load-bearing)

**Concurrent multi-book rendering is a first-class invariant** here: jobs are
keyed `${bookId}::${chapterId}` and N workers run across *all* books at once.
Phase 1's guards are **per-book** — `scoringInFlight` is keyed by `bookId`
(`generation.ts`) and `centroids.json` is per-book. Phase 2's canonical is
**voice-level, shared across every book of a series** (`qwen-<voiceUuid>`), so
the Phase-1 per-book assumptions **do not transfer**. The normal case — book 1
and book 2 of the same series rendering simultaneously, both using the same
storage key — is the dangerous one. The contract:

1. **The freeze single-flight + write lock is keyed by `storageKey`, NOT by
   book** (cross-book, process-global advisory lock). Two same-series books
   crossing completion in the same tick must serialise on this lock.
   **Precondition (I3):** this is sound *only because generation is single-process*
   (async-concurrent within one Node process; sidecar is a separate process but
   does no canonical writes). A module-scope `Map` lock therefore suffices. If
   generation ever moves to `worker_threads`/`cluster`/child processes, this lock
   silently becomes a no-op and the read-merge-write race returns — so a
   start-up assert (or test) **fails loudly if generation forks workers**.
2. **"First-rendered-wins" tie-break is explicit:** the first book to *acquire
   the storage-key lock* at completion freezes; ties broken by lowest `bookId`.
   "Completion" remains all-story-chapters-rendered (§8), but the *winner* is
   lock-acquisition order, defined even when two books complete together.
3. **The loser must be re-scored.** A concurrently-completing sibling that scored
   its lines against the provisional cold-start anchor is **re-scored against the
   frozen canonical** once the winner freezes (its verdicts/inline-repairs were
   computed against the wrong reference). This is the same re-score machinery as
   the debut book's (§3.2 step 4).
4. **Version-map writes are read-merge-write under the lock.** `writeJsonAtomic`
   is atomic per file but does a whole-object overwrite with no merge — two
   writers freezing different config-hash versions under one key would clobber
   each other. The freeze path **loads the current version map, splices in the
   new version, writes** — never serialises a stale in-memory snapshot. The
   canonical file opts into `{ rotate }` backups (it is expensive-to-rebuild
   voice-identity state, unlike cheap per-book state).
5. **Visibility/ordering for readers.** A reader (a later/sibling book's scoring)
   either sees the fully-frozen canonical or sees none → `inconclusive` (already
   granted, §3.4); it never reads a half-written file (the atomic rename
   guarantees this). The debut book's post-freeze re-score/repair runs **inside
   that book's own `scoringInFlight` single-flight**, so a trailing back-matter
   chapter-done can't race the freeze pass.
6. **If the deferred self-correction (§3.2.bis) is ever built**, its re-freeze
   takes this same storage-key lock and re-scores affected books each within their
   own per-book single-flight. (Out of v1 — noted so the lock design anticipates
   it.)

This section is **Wave-1 work** (it ships with the canonical store + cross-book
scoring), not deferrable — Wave 1 introduces the shared state, so it must
introduce the lock.

## 4. Detection & scoring

### 4.1 Cross-book per-line
`cosine(segment embedding, the canonical for that segment's own storage key)` —
the storage key already encodes the emotion variant (§3.1/§7), so the lookup
**is** the match; there is no separate nearest-emotion step. Below the calibrated
cutoff ⇒ `voice-mismatch` **against series canonical**. Reuses
Phase-1's per-character percentile band machinery and `score.ts`, re-anchored
from the book-local centroid to the frozen canonical. Verdict vocabulary stays
`'voice-match' | 'voice-mismatch' | 'inconclusive'` (avoids the `AsrVerdict
'drift'` collision); events carry `metric: 'render-integrity'` plus a
`scope: 'series-canonical'` discriminator so fs-51 can distinguish a Phase-1
in-book misfire from a Phase-2 cross-book mismatch.

### 4.2 Systematic-vs-per-line classifier (three-way)
Per character per book, compute the **mismatched-line fraction**:
- **Low** ⇒ **per-line** ⇒ repairable (§5).
- **High** ⇒ either the *voice is off in this book* **or** *the canonical itself
  is wrong*. These produce the **identical** signal, so the classifier cannot
  separate them on the fraction alone. It leans on the **sanity gate (Branch B step 3)**:
  - if the canonical passed the sanity gate (it sits within G2's band of the
    approved audition) ⇒ trust "**systematic** — voice off in this book" ⇒
    **escalate to advisory, do NOT run the repair loop** (re-rendering every line
    is futile when each render misses the canonical);
  - if the canonical was **withheld/flagged** by the sanity gate ⇒ emit
    "**suspect-canonical**" instead, and do not blame the book's voice.

So the C2 gate is what makes a high fraction trustworthy as "voice off" rather
than "canonical off." The fraction threshold is a calibrated, pinned constant
(G5 informs it).

### 4.3 Per-emotion (collapsed — with an honest gap)
No separate per-emotion subsystem: designed variants are first-class anchors via
§3.1 keying. The residual is **un-designed emotional delivery on the base voice**
(R3). If G3 is null, nothing more is needed. **If G3 is material, this is a
partial no-go, not a tuning exercise:** emotional base-voice lines are scored
`inconclusive` (you cannot sub-anchor an emotion that has no separate render
target). A widened tolerance on the base anchor is offered *only* as an optional,
clearly-labelled "score-anyway-with-lower-confidence" mode — never presented as
having de-blended the emotion. Windowed short-segment queries (Phase-1's coverage
mitigation) remain **excluded** from per-emotion and wander analysis (averaging
across the emotion axis is exactly what these must not do — Phase-1 rule).

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
  replacing the stale row). **Systematic** findings skip the loop and escalate;
  **suspect-canonical** findings repair nothing (§4.2). **Timing:** later books
  repair **inline** (the canonical already exists); the **debut/seed book repairs
  in the post-freeze pass** (Branch B step 4) or inline (Branch A, where the
  audition is already the canonical) — never against an immature anchor.
- **The post-freeze pass is a *visible* "consistency pass" stage**, not silent
  mutation of a book the user already saw "done." Branch B re-renders some debut-
  book lines *after* completion; surface that as an explicit stage in the
  progress/QA UI, and **do not mutate audio that has already been downloaded or is
  being listened to** without an explicit re-export — flag those lines as
  "consistency-fix available" instead. **The pass is capped** (max repair lines /
  max wall-time budget, surfaced in the stage) so a low-mismatch-fraction debut
  book can't silently trigger a near-full second render pass; the spike records
  the **expected repair-line count** at the calibrated cutoff so the cost is known
  before build.
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
  `autoRepair` barrier** to flip.
- **Disposition of the shipped `qa.speaker.autoRepair` flag (C1).** Phase 1 ships
  a live registry key `qa.speaker.autoRepair` (`registry.ts:263`, env
  `SEG_SPK_AUTO_REPAIR`, `default: false`, gates Phase-1's in-book auto-fix).
  Phase 2's "gate-on ⇒ repair-on" collapse **folds this flag into
  `qa.speaker.enabled`**: the separate flag is **deprecated** (kept as a
  no-op-with-warning for one release, then removed), and repair — in-book *and*
  cross-book — is governed solely by `enabled` + the com-1 entitlement seam.
  **This is a deliberate behavior change from Phase 1** (a user who today runs
  `enabled=true, autoRepair=false` would, post-Phase-2, get repair on) and must be
  called out in the release notes — it is NOT a silent flip. **(Decided
  2026-06-22: fold, don't keep a second flag.)**
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
  exercise yet.) **Caveat: fs-51 (#973) is not yet built**, so until it lands the
  detection is *event-only* (no report UI) — the dogfood "story" is validated via
  the emitted events / logs and the repair actions actually firing, not a visible
  report. Phase-2 detection emitting into a UI-less void until fs-51 is the same
  posture Phase 1 shipped with.

## 7. Emotion / storage-key persistence (the small schema work)

Per-segment, persist the **resolved render-target storage key** plus the
**voice-config hash** active at render time — two fields added to the
`{ characterId, sentenceIds, renderedFallbackEngine }` record (`segments-io.ts:54`)
and its writer. The storage key is cleaner than persisting `group.emotion` (it
already encodes variant-selection **and** `voiceUuid` resolution in one value),
and the config hash is what lets re-score / cross-book scoring pick the correct
canonical **version** across a re-tune (§3.4). Together they let each persisted
embedding be scored against the correct canonical at re-score / cross-book time.
Absent on pre-Phase-2 files ⇒ the segment is `inconclusive` for the cross-book
check, never an error (matches the Phase-1 missing-embedding rule). **Consequence
(state it):** "first-rendered-wins" is among **Phase-2-aware renders only** — a
series whose book 1 predates Phase 2 (no fields) won't establish a canonical from
it, so the first *Phase-2-rendered* book becomes the de-facto debut. Acceptable;
just not silent.

## 8. Reuse (foundations already merged — NOT built here)

- `voiceUuid` immutable identity + `qwenStorageKey` (srv-43, `voice-mapping.ts`).
- Series cast-carry: unified `voiceId`/`voiceUuid` across books
  (`series-reuse-link.ts`, fe-40 / plan 126) — supplies the recurrence that makes
  cross-book meaningful.
- ECAPA `SpeakerEngine` + `POST /embed`, `<slug>.embeddings.json` (base64
  Float32), robust per-character centroid, `score.ts` band machinery, verdict
  vocabulary, `chapter-qa-repair.ts` repair loop (srv-36 Phase 1, #987).
- Optional GPU embed path (srv-47) — embedding cost is not a blocker.
- fs-51 (#973) event consumer — **not yet built**; Phase-2 detection emits events
  it will later render (event-only until #973 lands, §6).
- **Known seam to harden here:** the **book-completion trigger** (a Phase-1
  follow-up: "last-chapter single-flight book-completion trigger"). The Branch-B
  freeze (§3.2) depends on a reliable signal, defined here as **all
  story-chapters rendered** (back-matter excluded — count story-chapter titles,
  not raw chapter count, since trailing back-matter chapters can otherwise read
  as "stalled N from done"), guarded **single-flight per (storage-key, book)**. A
  **partially-rendered book must NOT freeze** a thin canonical (user stops at
  chapter 5): until completion the anchor stays in cold-start/maturing state and
  no canonical is persisted. (Branch A needs none of this — the audition is the
  canonical from the start.)

## 9. Acceptance

**Spike (the deliverable even on no-go):**
- [ ] **Pre-registered G1/G6 thresholds committed to FINDINGS.md *before* running**
      (C4); any mid-spike change logged as a recorded protocol amendment.
- [ ] **G0 same-text content control** measured first (C1); G1 interpreted as
      drift-above-G0, per-character-relative (not vs a single global floor).
- [ ] G0–G6 on **Keeper (the only ≥2-book Qwen series on-box — C3, single-series,
      band marked provisional)**; findings note records G2 spread, G3 (neutral
      canonical from neutral-tagged lines), G4 residual, G6 on a **held-out Keeper
      book**, and a **blind/interleaved/randomized G5** FP/FN (C5).
- [ ] **Keying caveat stated (C2):** which key the spike exercised
      (`qwen-<voiceId>` legacy vs re-rendered `qwen-<voiceUuid>`).
- [ ] A **per-axis** `{ go | no-go }` recommendation. On full cross-book no-go:
      Phase 2 closed `wont-fix-consistency`, this spec marked `superseded`, fs-51
      confirmed unaffected.

**Build (per the axes that went go):**
- [ ] Canonical anchor keyed by render-target storage key, **Qwen-only**;
      **Branch A** (audition *is* canonical) if G2 null, else **Branch B**
      (warm-start → mature → **sanity-gated** freeze → re-score → deferred
      debut-book repair); forward books read-only; voice-level
      `<storageKey>.canonical.json`, versioned by voice-config hash +
      `anchorVersion`; never-auditioned voices flagged `seed: no-approval`.
- [ ] Cross-book per-line scoring re-anchored to the canonical; **three-way**
      classifier (per-line / systematic / suspect-canonical) keyed off the sanity
      gate, calibrated + pinned; `scope: 'series-canonical'` discriminator. (M2:
      the `suspect-canonical` branch is only reachable when the sanity gate
      withholds, i.e. under Branch B — its test is unreachable / N/A until Branch B
      ships.)
- [ ] **Re-tune versioning** (§3.4): per-segment config-hash persisted;
      cross-book evaluated within a config-hash cohort; pre-tune books not flagged
      against the post-tune canonical.
- [ ] Branch-B debut-book repair runs as a **visible post-freeze consistency
      pass**; never silently mutates downloaded/in-listening audio (§5).
- [ ] Per-emotion handled by keying (designed variants first-class); material G3
      ⇒ emotional base-voice lines `inconclusive` (partial no-go), not "tuned
      away"; windowed queries excluded.
- [ ] Temporal-wander detector only if G4 = go (early/late centroid divergence).
- [ ] Per-segment resolved-storage-key **+ voice-config-hash** persistence
      (`segments-io.ts` + writer).
- [ ] **§3.5 concurrency contract:** storage-key-scoped (cross-book) freeze lock
      with lowest-bookId tie-break; read-merge-write on the version map; rotate
      backups; concurrently-completing sibling books re-scored against the frozen
      canonical; debut re-score inside the book's own single-flight; start-up
      assert if generation ever forks workers (I3). **Verified by a GPU-free
      *unit* test** (I2) — mock the synth/embed seams (the codebase already injects
      `synthFn`/`embedFn`, `audition-centroid.ts:41`) and drive two interleaved
      `afterChapterFinalized`-equivalent calls on one storage key, asserting
      single-freeze + no clobber + loser-re-scored — **NOT** a GPU-bound e2e render.
- [ ] **Re-score is no-re-embed (I4):** a unit test asserts the embed client is
      called **zero times** during a re-score (else the "cheap CPU" cost posture is
      unverified — a tautological "verdicts changed" test would not catch it).
- [ ] **Cost gates from the spike:** K × cast-size audition-embed wall-time on the
      8 GB box stated + K_min freeze floor; post-freeze repair pass capped (max
      lines / wall-time) with expected repair-line count recorded at the cutoff.
- [ ] `qa.speaker.enabled` opt-in default-OFF; gate-on ⇒ detection + active
      repair (debut-book repair deferred to post-freeze in Branch B); com-1
      entitlement seam present-but-granted; on-box-ON via local override in the
      test protocol.
- [ ] fs-51 (#973) consumes consistency events as conditional rows; unchecked /
      withheld-canonical / `no-approval` storage keys named, never hidden behind
      "all clear".
- [ ] Calibration + operator-listen FP/FN on the recorded calibration/hold-out
      split (§2 caveat), with the split stated; cutoffs + classifier threshold
      pinned by a normal-tier regression test against committed fixture embeddings.
      **Inherit Phase-0 §3.7's disclaimer verbatim (M1):** the pin guards
      cutoff-/threshold-constant drift **only** — it does NOT re-verify calibration
      correctness in CI (a change to the model / preprocessing / harvest is
      invisible to normal CI); the FP/FN are a periodic manual artifact. Do not
      claim CI-runnable calibration. **out-of-sample cross-book FP/FN** + the
      **wander** residual-value fraction (G4) in Ship notes.

### 9.1 Suggested wave decomposition (for the plan, not binding)
This is at least Phase-1's 15-task magnitude; the plan should wave it, not push
it as one block. Indicative ordering:
- **Wave 0 — the spike** (gate; everything below is conditional on its per-axis
  go).
- **Wave 1 — storage-key + config-hash persistence** (`segments-io.ts` + writer,
  §7/§3.4) + the canonical store + **the §3.5 concurrency contract
  (storage-key-scoped lock + read-merge-write + re-score-the-loser + rotate
  backups)** + Branch-A anchor (audition-is-canonical, K embeddings persisted) +
  cross-book per-line scoring + events + within-cohort re-tune handling. Ships the
  cross-book check for the G2-null case. **The lock ships with the shared state —
  not a later add.**
- **Wave 2 — Branch B** (maturation + sanity-gated freeze + re-score + deferred
  visible-consistency-pass repair + completion-trigger hardening), only if G2
  material.
- **Wave 3 — three-way classifier + auto-repair wiring + com-1 seam.** (Canonical
  self-correction §3.2.bis is deferred to a backlog follow-up, not this wave.)
- **Wave 4 — fs-51 consumption + calibration + Ship notes.**
- **Wave 5 — temporal-wander detector**, only if G4 = go.

## 10. Out of scope (this spec)

- **Coqui cross-book** (§0): no collision-free per-voice key (shared catalog
  speakers), so v1 is Qwen-only. Revisit if/when Coqui voices gain a unique
  identity, or via a `(characterId, speaker)` composite — deferred.
- Cross-engine canonical transfer (a Qwen canonical scoring a Coqui render) —
  engine-systematic; out of scope (each engine, each storage key, its own
  canonical).
- **Canonical self-correction (§3.2.bis)** — the auto-re-freeze-on-≥2-later-book-
  disagreement machinery; deferred to a backlog follow-up (file when Phase 2
  ships). v1 surfaces the residual via `canonical-suspect` / `single-later-book`
  markers but does not auto-fix it.
- A slope/change-point wander detector beyond the early/late-centroid v1.
- Human-rated *perceived*-drift holdout beyond the operator-listen calibration.
- Turning the com-1 paywall on (com-1 owns the flip; the seam is built granted).
- Flipping the shipped default on (stays OFF; on-box override only).

## Ship notes

_(filled on ship: date · commit SHA · per-axis recommendation {go|no-go} ·
cross-book stability vs F1 floor · seed divergence · base-voice emotion shift ·
wander residual-value fraction · systematic threshold · operator-listen FP/FN ·
out-of-sample cross-book FP/FN)_
