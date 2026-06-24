---
title: fs-57 — Non-verbal vocalizations in narration with live context-aware instruct
status: draft
date: 2026-06-24
issue: fs-57 (#997)
related:
  - 2026-06-22-expressive-tts-instruct-tiers-design.md — parent spec (this drills §4.5 into a delivery)
  - fs-56 (#996) — per-line instruct on the Qwen 1.7B tier (tier *selection* shipped; live instruct *payload* did not — this spec builds it)
  - fs-58 (#998) — LLM Script Review (vocalization-protection guard already shipped + tested)
  - srv-31 (plan 186) — per-sentence ASR content-QA gate (gets the vocalization carve-out)
  - fs-33 (#596) — emotion-annotation backfill pass (the structural template for Stage 3)
  - reference: Qwen VoiceDesign persona/instruct stays English (accent rides a separate calibration channel)
---

# fs-57 — Non-verbal vocalizations + live context-aware instruct

## 1. Summary

Give narration lifelike non-verbal reactions — gasps, sighs, laughter ("Ah!", "Haah…",
"Haha!") — with no bracket-tag hacks, by teaching the analysis LLM to write **pronounceable
vocalizations into a sentence's `text`** plus a **matching free-text delivery `instruct`**, and
by making that `instruct` **audible end-to-end** through a live per-line instruct path on the
Qwen 1.7B Base.

This is the full vertical (the parent spec's "Option B"): data model + analysis emission +
runtime synthesis + the two guardrails (Script Review must not strip vocalizations; ASR
content-QA must not false-flag them). It is **additive at the data layer** — a pre-fs-57 analysis
loads and validates unchanged, and the 0.6B/Kokoro/Coqui audio paths stay byte-identical — but the
**1.7B audio path changes by design** (a new live-instruct synth path, gated per book). See §2.1
for the honest scope of "additive".

**Draft gate.** This spec stays `status: draft` until the **C2 sidecar gate** (what empty/neutral
instruct actually produces) and the **re-established perf baseline** (§5) land — mirroring the
parent spec's R2-C1 gate. fs-57 does not assume the parent spike's audio/perf findings.

**Scope correction vs. the parent spec.** The parent assumed fs-56 had already shipped a
per-sentence `instruct` field and a live instruct synth path. It had not: fs-56 shipped only the
1.7B **tier selection** scaffolding (per-character `ttsModelKey`, the "Higher quality (1.7B)"
toggle, `tts.preload.qwenBase17`, install-side 1.7B-Base prefetch). The `instruct` field and the
live synth payload **do not exist** and are built here.

## 2. Decisions (locked with the operator, 2026-06-24)

1. **`instruct` is a separate additive field**, not a replacement for `emotion` — they do
   different jobs (`emotion` = bounded enum; `instruct` = free-text live direction + the home for
   a vocalization's "how to perform it").
2. **Emit path = a first-class Phase-1 Stage 3** (Stage 1 cast → Stage 2 attribution+emotion →
   **Stage 3 instruct+vocalization**). Surfaced in the analysis form and wired to the **same
   operator trigger as the existing emotion-annotation button** (one action runs emotion +
   instruct/vocalization). Strict non-re-attributing envelope, like fs-33.
3. **Synthesis = unified live-instruct channel on the 1.7B**: one main base voice + per-line
   instruct, **no anchored multi-variants** on this tier — this is the model's intended use. *(This
   is the end state once a book opts in via the per-book `liveInstruct` flag of §4.1; the flag
   bridges the migration so flag-off 1.7B books keep variants until they opt in — §4.3 R3-M1.)*
   Per-emotion intensity tuning is explicitly **deferred**. Anchored variants remain the **0.6B
   Fast-tier** mechanism, untouched.
4. **Vocabulary = open-ended / LLM-driven** (a style guide, not a hardcoded list) — chosen so the
   feature is **multilingual without per-language maintenance**.

### 2.1 Additivity boundary (honest scope of "additive")

"Additive" holds at the **data/schema layer**: a pre-fs-57 analysis (no `instruct`, no
vocalization marker) validates and loads unchanged, and the **0.6B Fast tier, Kokoro, and Coqui
paths are byte-identical to today**. It does **not** hold at the **audio layer for the 1.7B
tier**, once a book opts in via `liveInstruct` (§4.1): §4.3 then moves its 1.7B synthesis from the
`generate_voice_clone` wrapper to a raw-`generate` bypass and drops anchored `__emotion` variant
selection — so 1.7B audio changes even for neutral lines and for books previously rendered with
tuned variants. This is an accepted, operator-known consequence of decision 3 (the model's intended
use), not a regression to hide; the flag (default off) keeps it from touching existing renders
until the operator chooses it. See §4.3 (C1/C2) for the migration + verification gates.

## 3. The multilingual split (the key constraint this design respects)

The Qwen instruct channel is **English-coupled**: the model interprets the `instruct` text as
English regardless of the book's language (see the `reference_qwen_voicedesign_persona_english`
finding — persona/instruct stays English on a Russian book; accent rides a separate calibration
channel). So the two halves of a vocalization split by language:

| Field | Language | Source |
|---|---|---|
| Vocalization **`text`** (`"Ах!"`, `"¡Ay!"`, `"Haah…"`) | the **book's** language | LLM writes it natively — no hardcoded per-language list |
| Delivery **`instruct`** (`"a long, tired sigh"`) | **English** | LLM writes it in English — zero per-language maintenance |

This is why "open-ended" and "multilingual" are the *same* decision: an LLM-authored English
instruct + an LLM-authored native vocalization needs no per-language vocab tables. Supported
languages for vocalization *text* follow the existing language roster (en/es/ru live; fr/de ride
along since the instruct is English regardless).

## 4. Architecture

### 4.1 Data model (additive)

- Add **optional** `instruct?: string` to `sentenceSchema` (`server/src/handoff/schemas.ts`),
  `openapi.yaml` (Sentence schema), and regenerate `src/lib/api-types.ts` (`npm run
  openapi:types`). `sentenceSchema` is `.strict()` — add an **absent-still-parses** test so a
  pre-fs-57 analysis validates unchanged.
- Thread `instruct` through the synth grouping (`SentenceGroup` in
  `server/src/tts/synthesise-chapter.ts`, alongside the existing `emotion` carry at ~line 265).
- **Precedence ladder** (3-way, additive — absent `instruct` ⇒ today's behaviour exactly):

  > **manual edit › analyzer `instruct` › emotion-derived English phrase (1.7B + `liveInstruct`) › neutral.**

  Manual edits win (consistent with `emotion`'s "manual wins"). On the 1.7B tier a sentence with
  `emotion` but no `instruct` derives an English phrase from the enum; on the 0.6B tier `emotion`
  keeps driving anchored-variant selection unchanged. **The emotion→phrase derivation runs
  synth-side (R2-M4)** (`synthesise-chapter.ts`), not the analyzer — so the stored `instruct` field
  holds only genuine analyzer/manual instructs, and the phrase map can evolve without re-analysis.
- **Live-instruct enable is a per-book flag, separate from tier (R2-M3).** Selecting the 1.7B tier
  alone does **not** switch a character to the live-instruct path; a per-book `liveInstruct` opt-in
  (book-meta, default **off**) gates it. So existing 1.7B-cast books keep today's behaviour until
  the operator opts in and re-renders — this is what makes the "no silent restyle" promise (§4.3
  C1) actually hold. With the flag off, 1.7B stays on `generate_voice_clone` + anchored variants
  exactly as today. **v1 simplification (R3-Mi1):** the flag is **per-book**, while tier selection
  is per-character — so it enables live instruct for *all* of a book's 1.7B characters at once; a
  per-character live-instruct toggle is a deferred follow-up.
- Manuscript edits are **not** cross-tab broadcast (`broadcast-middleware.ts`) — no sync worry;
  `instruct` follows `emotion`'s persistence (cast/manuscript state + manuscript-edits).
- **Vocalization marker (M3).** Add an optional `vocalization?: boolean` to the Sentence schema
  (+ OpenAPI + types), set by Stage 3 when it authored a non-verbal sound. This is the **explicit
  signal** the srv-31 carve-out reads (§4.4) — chosen over the fuzzy "short text + non-empty
  instruct" heuristic so the carve-out is precise and language-agnostic. Absent ⇒ false ⇒ today's
  ASR behaviour. **Note (R2-M1):** the flag marks a sentence as *containing* a vocalization; it does
  **not** by itself blanket-relax WER — §4.4 gates the relaxation on the vocalization being
  *dominant*, so a gasp prepended onto a long lexical line keeps ASR protection on the words.

### 4.2 Analysis — Phase-1 Stage 3 (instruct + vocalization)

- **New skill** `skills/audiobook-instruct-annotation.md` + a `prompt.instructAnnotation` registry
  knob (user-forkable, live) + `runStage3Chapter` on the analyzer (mirror `runStage2Chapter` /
  the fs-33 emotion-annotation pass in `server/src/analyzer/gemini.ts` / `ollama.ts`).
- **Strict, non-re-attributing envelope** (the fs-33 invariant — never regress attribution to
  gain instruct): `{ annotations: [{ sentenceId, text?, instruct?, vocalization? }] }`. `text` is
  emitted only when the LLM authors a vocalization; `instruct` is the English delivery direction;
  `vocalization: true` marks it for QA (§4.1). No `characterId`, no re-splitting. **Stage-3 `text`
  edits persist independently of `liveInstruct` (R3-Mi2):** the inserted vocalization stays in the
  manuscript even if the flag is off (or the tier is 0.6B) — only the *expressive delivery* is
  gated, so a flag-off render reads the `"Ah!"` flatly (the §4.4 M5 degradation, also reachable on
  1.7B-flag-off).
- **Edit-in-place only for v1 (M2).** Stage 3 may only **prepend/edit a vocalization within an
  existing sentence's `text`** — it never inserts a *new* sentence. Consequence to accept and
  document: a gasp and the words after it (`"Ah! I didn't see you."`) share **one** `instruct`, so
  they can't be delivered independently. Splitting a vocalization into its own sentence (which
  would pull in the sentence-ID-allocation / Script-Review-collision machinery) is a deferred
  follow-up, not v1.
- **Idempotency guard (R2-M2).** Unlike the emotion pass, a text-prepend is **not** naturally
  idempotent — and the trigger is re-runnable (like "Detect emotions"). Re-running must **skip any
  sentence already `vocalization:true`** (and never re-edit `text` for it), so a second click can't
  produce `"Ah! Ah! …"`. The fill-only rule covers `instruct`/`vocalization`; the skip-if-flagged
  rule covers `text`.
- **Open-ended dialect with a style guide** in the prompt: when the narrative makes a non-verbal
  reaction explicit (a gasp, sigh, laugh, hesitation), write the pronounceable vocalization into
  `text` in the **book's language** and an **English** `instruct`. Conservative — omit when not
  clearly signalled. Bounded by *guidance*, not an enum.
- **Apply path is a NEW reducer, not the emotion one (M1).** `applyDetectedEmotions` is
  emotion-only + fill-only-empty and **cannot carry `text` edits**. Stage 3 needs its own reducer
  (`applyDetectedInstruct`-style) that (a) sets `instruct` + `vocalization` fill-only (a hand-set
  `instruct` always wins, mirroring emotion), and (b) applies the `text` edit via the existing
  `setSentenceText` path. **Audio-staleness (M1):** a `text` edit invalidates any already-generated
  segment for that sentence (`segments.json` binding) — Stage 3 must mark the sentence dirty for
  re-gen, exactly as a manual text edit does. The emotion pass never faced this; Stage 3 must.
- **Order-independence vs Script Review (M4, reframed per R2-Mo1).** Script Review and Stage 3 are
  **both operator-triggered post-analysis passes** with no fixed pipeline order — the operator may
  run them in either order, repeatedly. So the guarantee is **not** "Stage 3 runs after"; it is that
  **both passes are order-independent and TOCTOU-safe**: every apply revalidates `{ sentenceId }`
  targets against the live manuscript (reuse fs-58's index-map / staleness check), and Script
  Review's tested vocalization guard protects vocalizations regardless of when Stage 3 ran. A
  merged/split/renumbered sentence drops its Stage-3 annotation rather than mis-applying it.
- **UI wiring + endpoint (R2-Mo2).** Add Stage 3 to the analysis form; the shipped
  **`DetectEmotionsButton`** (`src/components/detect-emotions-button.tsx`, used at
  `src/views/manuscript.tsx:776`) is the operator entry point. **Don't overload the emotion-named
  contract:** `api.detectEmotions` / its SSE events / `DetectEmotionsError` stay emotion-only;
  Stage 3 gets its **own endpoint + SSE + error type + reducer**, and the button fires both passes
  (its confirm copy + progress must cover the heavier text-mutating, audio-invalidating work).
  **Live-generation race:** a Stage-3 `text` edit to a sentence whose audio is generating
  concurrently (the multi-book invariant) follows the same dirty-then-regen path as a manual edit —
  the in-flight render finishes against the old text and the sentence is re-queued; no special
  locking beyond today's manual-edit behaviour.
- **Language preamble work is explicit (m3).** `languagePreamble` (`gemini.ts`) returns empty for
  English and carries per-language blocks for es/ru/fr/de; Stage 3 adds a clause to **each**
  block: vocalization text in the book's language, `instruct` in English. This is concrete
  per-language prompt work, not an emergent property.

### 4.3 Synthesis — unified live-instruct on the 1.7B Base

- **Promote `_icl_instruct_synth`'s mechanism into the batched generation path.** Today
  `_icl_instruct_synth` (`server/tts-sidecar/main.py:~1553`) is a single-shot **design-time**
  helper that calls raw `model.generate(instruct_ids=…, voice_clone_prompt=…)`. Lift its core
  (build `ref_ids` from `ref_text`, prepend `ref_code`, trim the ref-prefix, add per-item
  `instruct_ids`) into `synthesize_batch` so a single 1.7B-Base forward carries **per-item,
  heterogeneous `instruct_ids`** alongside the existing per-item voices. The parent spike *claimed*
  this batches cleanly (mixed voices + per-item instruct, RTF 0.67, instruct ≈ free) — but that
  number is from **uncommitted, non-reproducible** scripts (parent R2-C1, m1 below); treat it as a
  hypothesis the §5 perf guard must re-establish, not an established baseline.
- **One main voice, no variants on 1.7B — *when `liveInstruct` is on* (R3-M1).** With the flag on,
  the 1.7B tier stops selecting `__emotion` variant `.pt`s and emotion becomes an English instruct
  phrase (the §4.1 fallback). With the flag **off**, 1.7B keeps `generate_voice_clone` + anchored
  variants exactly as today. `pickEmotionVariantVoice` therefore stays live for 0.6B **and** for
  1.7B-flag-off; it is a no-op only on the 1.7B-flag-on path. **Dual-path cost (accepted):** the
  flag means both 1.7B synth paths are carried until books migrate — a deliberate migration-safety
  tradeoff. Deleting the variant path once 1.7B books have opted in is a tracked future cleanup
  (§6), not v1.
- **Sidecar request body** gains a **batch-level `liveInstruct` flag** plus optional per-item
  `instruct`: `{ engine, model, liveInstruct, items: [{ voice, text, instruct? }] }` (and the single
  `/synthesize` shape). **Path selection is batch-level, not per-item (P-C1):** one batched
  `generate` forward cannot mix the `generate_voice_clone` wrapper and the raw bypass, so the flag —
  not the presence of an `instruct` string — decides the path. When on, every 1.7B item runs the
  bypass (neutral items use the pinned neutral-instruct form); when off, the whole batch uses the
  wrapper. Server side (`server/src/tts/sidecar.ts`) threads both from the resolved `SentenceGroup`
  + book flag. **Instruct length cap (m4):** the per-line path clamps/rejects pathological instruct
  length, mirroring the `design_voice` char cap, to protect the tokenizer/batcher.
- **C1 — the 1.7B audio changes; this is accepted, not byte-identical.** Routing 1.7B through the
  raw-`generate` bypass (a different code path from `generate_voice_clone`) **and** dropping
  variant selection means 1.7B output differs from today even for neutral lines, and books
  previously rendered with tuned `__emotion` variants now deliver emotion via untuned live
  instruct. Per §2.1 this is an operator-known consequence. **Migration:** the per-book
  `liveInstruct` flag (§4.1, default off) gates this path, so existing 1.7B books are **not**
  silently restyled — they keep `generate_voice_clone` + anchored variants until the operator opts
  in and re-renders. The 0.6B Fast tier and non-Qwen engines stay byte-identical regardless.
- **C2 — "empty instruct = no-op" is a hard sidecar gate, not an assumption.** Whether the batched
  raw `generate` accepts a truly empty per-item instruct, or needs a neutral placeholder that
  itself biases delivery, is **unverified**. Before any "neutral parity" language is trusted, a
  sidecar pytest must establish what empty/neutral instruct actually produces and pin the chosen
  neutral form. This rides the parent spec's still-open **R2-C1 reproducible-benchmark gate** (§9
  of the parent) — fs-57 does not get to assume the spike's audio findings.
- **Version fragility (parent M2):** pin `qwen-tts` 0.1.1 and add a sidecar test that **fails
  loudly** if the raw-`generate` signature drifts (both `instruct_ids` and `voice_clone_prompt`
  accepted, no `tts_model_type` guard).
- **Batch packing (parent R2-M4):** per-item instruct adds variable tokens to the length-bucket
  batcher (`synthesise-chapter.ts:~536`). Decide whether instruct counts against
  `qwenBatchTokenBudget`; add a heterogeneous-instruct-length batch test so packing regressions
  surface.
- **VRAM / Base-swap (parent R2-M5):** the 1.7B-Base resident + idle-watchdog guards already
  exist (`_base17_activity`, `QWEN_BASE17_IDLE_TTL`, single-flight load lock). The live path runs
  on the **already-resident** 1.7B Base; the VRAM invariant (never two heavy models co-resident)
  is unchanged. Concurrent multi-book Base-tier pinning is per-run today (each generation POST
  pins its `modelKey`); document that a mixed 0.6B/1.7B concurrent render serialises Base loads at
  the sidecar (existing behaviour, not regressed here).

### 4.4 Guardrails

- **fs-58 Script Review — already protected.** `skills/audiobook-script-review.md:38-40` carries a
  tested "NEVER strip intentional non-verbal vocalizations" guard. fs-57 adds **one round-trip
  regression**: a sentence whose `text` is a vocalization **and** carries an `instruct` survives a
  Script Review pass unchanged (text not stripped, instruct not dropped). A `validate_instruct`
  Script-Review op stays **out of scope** (deferred follow-up, per fs-58 Unit B).
- **srv-31 ASR content-QA — marker-driven, dominance-gated carve-out** (not a lexical allowlist —
  that can't scale to open-ended multilingual). In `classifyTranscript`
  (`server/src/tts/segment-asr-qa.ts`), a sentence whose `vocalization` flag (§4.1) is true relaxes
  the verdict to `inconclusive` rather than `drift` (mirroring the existing `nameAllowlist`
  carve-out shape at ~lines 328-339). **Token-tolerance, not a length gate (refined at plan time):**
  the existing `minChars` floor already returns `inconclusive` for bare short vocalizations
  (`"Haah…"`/`"Haha!"`), so the only open case is edit-in-place prepending a gasp onto a *long*
  lexical line. There, when `vocalization===true`, the server derives the leading vocalization
  token(s) from `text` (the leading run up to the first terminal mark `! … . ?`) and passes them as
  a `vocalizationAllowlist` — tolerated exactly like `nameAllowlist`, so the gasp token doesn't
  count as drift while **the lexical words are still fully scored**. This is strictly better than a
  whole-sentence length gate (which would blanket-relax the words too) and needs no stored span
  field. See plan Task 17. The gate is OFF by default and the 12-char floor
  already short-circuits bare interjections — so this is a narrow, targeted add, not a new
  subsystem.
- **0.6B Fast-tier degradation (M5).** On the 0.6B tier `instruct` is ignored (no live-instruct
  capability), so a vocalization's `text` (`"Haah…"`) is read by the plain/variant voice with **no
  sigh delivery** — at worst the literal phonemes. v1 accepts this: the vocalization text still
  renders (additive — it's real spoken content), just flatly. Document it; do not strip
  vocalization text on 0.6B (that would desync `text` across tiers). Operators wanting expressive
  vocalizations select the 1.7B tier.

## 5. Testing & acceptance

- **Schema:** `instruct?` **and** `vocalization?` absent-still-parse (`.strict()` safety); present
  round-trips through OpenAPI types.
- **Analysis:** Stage 3 fixture — given a manuscript line with an explicit reaction, the pass
  emits a native-language vocalization in `text` + an English `instruct` + `vocalization: true`,
  with the strict envelope (no re-attribution). Negative fixtures: an unsignalled line emits
  nothing; a stale `sentenceId` (post-merge/split) drops rather than mis-applies (M4).
- **Apply path (frontend):** the new instruct reducer is fill-only (hand-set `instruct` wins); a
  `text` edit marks the sentence dirty for re-gen (audio-staleness, M1).
- **Synthesis (sidecar pytest) — C2 gate:** establish what an empty/neutral per-item instruct
  actually produces and pin the neutral form; assert the batched ICL+instruct path gives per-item
  delivery change with identity intact; the drift-guard test for the raw-`generate` signature; the
  instruct length-cap clamp (m4).
- **Golden-audio** (`test:golden-audio`): a Qwen instruct fixture asserting (a) identity stability
  across instructs (ECAPA cosine within tolerance) and (b) an audible delivery change. **Reconcile
  with fs-55 (R2-Mi1):** the existing anchored-variant-near-base golden test stays scoped to the
  **0.6B** Fast tier (variants live there now); the new instruct fixture covers the 1.7B
  live-instruct path — they don't overlap.
- **Guardrails:** the Script-Review round-trip regression (vocalization `text` + `instruct`
  survive); an ASR carve-out unit test (a `vocalization:true` sentence → `inconclusive`, not
  `drift`).
- **Perf guard — re-establish the baseline first (m1).** The parent's RTF 0.67 is non-reproducible;
  record a **committed** batched-RTF baseline (incl. a heterogeneous-instruct-length batch) before
  asserting "instruct ≈ free," then guard against regression from it.
- **e2e:** the operator trigger runs Stage 3 alongside emotion and the analysis form reflects it
  (one Playwright spec on the analysis surface).

## 6. Non-goals / deferred

- No instruct on Kokoro / Coqui, nor live instruct on the **0.6B** synth (0.6B keeps anchored
  variants).
- **Single `/synthesize` (voice previews / auditions / samples) stays neutral** — the live-instruct
  path lands batch-only; a preview is an identity check, not a per-line delivery (PR2-M3).
- **Per-emotion intensity tuning of the live instruct** is deferred (operator's call) — the 1.7B
  carries delivery on one main voice; calibration of whisper-softer / angry-louder phrasing is
  tuning debt, not a v1 blocker.
- A `validate_instruct` Script-Review operation class (defer to an fs-58 follow-up).
- **Deleting the 1.7B anchored-variant path** once books have migrated to `liveInstruct` (R3-M1) —
  a tracked future cleanup, not v1; the dual path is carried for safe migration.
- A **per-character** `liveInstruct` toggle (v1 is per-book, R3-Mi1).
- fr/de vocalization *text* is unvalidated on a canary (rides along because the instruct is
  English regardless); es/ru vocalization text validated on their existing Coalfall canaries.
- **Disclosure (R2-Mi2):** vocalizations are performance content the **manuscript never
  contained** — Stage 3 adds words ("Ah!") the author didn't write. This is intentional for an
  audiobook *performance*, but it diverges from source text; the conservative-by-default Stage 3
  (omit unless clearly signalled) + the operator-gated trigger are the safeguards, and the
  `vocalization` flag makes every insertion auditable/reversible.

## 7. Open tuning debt

- Instruct phrasing vocabulary + sampling (temperature) per intensity — one temperature per
  batched forward may bound per-emotion control (parent R2-Mi).
- Whether instruct tokens count against `qwenBatchTokenBudget` (settle with the §5 packing test).

## 8. Delivery waves

1. **Data model + schema** — `instruct?` + `vocalization?` fields, per-book `liveInstruct` flag,
   OpenAPI, types, precedence ladder, **synth-side** emotion→English-phrase map (the 1.7B
   fallback), absent-parses tests.
2. **Synthesis** — batched ICL+instruct on the 1.7B; the **C2 empty/neutral-instruct gate first**;
   sidecar body + server threading; instruct length cap; drift-guard + packing tests; the
   re-established perf baseline; golden-audio fixture. Validated on **hand-authored instruct
   fixtures** (Wave 2 lands before Stage 3, so there is no analyzer instruct to render yet — m2).
3. **Analysis — Stage 3** — new skill/prompt/`runStage3`, **own endpoint/SSE/error type** (not the
   emotion contract), strict envelope, edit-in-place-only + **idempotency guard**, multilingual
   `languagePreamble` clauses, new instruct reducer + audio-staleness, analysis-form +
   `DetectEmotionsButton` wiring, `vocalization` flag, order-independent TOCTOU apply.
4. **Guardrails** — Script-Review round-trip regression; srv-31 **dominance-gated** `vocalization`
   carve-out; 0.6B degraded-render documentation.

(Waves are an ordering aid; delivered per the project's branch/PR conventions. **Closes #997.**)

## 9. Adversarial review — resolutions (round 1, 2026-06-24)

Findings folded into the sections cited. Direction unchanged; the framing of "additive" and the
borrowed perf evidence were the main corrections.

- **C1 — "neutral byte-identical" false on 1.7B → FIXED in §2.1 + §4.3.** Additivity is
  data-layer, not audio-layer, for the 1.7B tier; migration = opt-in re-render, never a silent
  restyle of accepted renders.
- **C2 — empty-instruct no-op unverified → FIXED in §4.3 + §5.** Promoted to a hard sidecar gate
  (pin the neutral form) riding the parent's R2-C1 reproducible-benchmark gate.
- **M1 — Stage 3 text mutation under-specified → FIXED in §4.2.** New reducer (not the emotion
  one), fill-only instruct, and explicit audio-staleness (a `text` edit dirties the segment).
- **M2 — insert-vs-edit undefined → FIXED in §4.2.** Edit-in-place only for v1; one instruct per
  sentence; new-sentence split deferred.
- **M3 — QA marker absent from the model → FIXED in §4.1.** Added `vocalization?: boolean`;
  carve-out keys off it, not a heuristic.
- **M4 — Stage 3 ↔ Script Review ordering → FIXED in §4.2.** Stage 3 after attribution/review;
  later reviews protect via the guard; stale IDs revalidated (fs-58 TOCTOU).
- **M5 — 0.6B vocalization degradation → FIXED in §4.4.** Documented flat-read fallback; text not
  stripped on 0.6B.
- **m1 — borrowed perf baseline → FIXED in §4.3 + §5.** RTF 0.67 demoted to hypothesis; commit a
  baseline first.
- **m2 — wave order inverts a dependency → FIXED in §8.** Wave 2 validates on hand-authored
  fixtures; emotion→phrase map assigned to Wave 1.
- **m3 — language-preamble work implicit → FIXED in §4.2.** Per-language Stage-3 clauses named as
  concrete work.
- **m4 — no instruct length cap → FIXED in §4.3.** Per-line clamp mirrors `design_voice`.

## 10. Adversarial review — resolutions (round 2, 2026-06-24)

Round 2 caught one self-introduced contradiction from the round-1 fold plus two real correctness
bugs the first pass missed. Architecture unchanged.

- **R2-C1 — §1 still claimed "byte-identical" → FIXED in §1.** Summary now says additive at the
  data layer; 1.7B audio path changes by design.
- **R2-M1 — marker over-relaxed ASR on edit-in-place lines → FIXED in §4.1 + §4.4.** Carve-out is
  now **dominance-gated**: relax only when the lexical remainder is below the floor, so a gasp on a
  long line keeps WER on the words.
- **R2-M2 — re-runnable text-prepend was non-idempotent → FIXED in §4.2.** Skip-if-`vocalization`
  guard prevents `"Ah! Ah! …"` on a second run.
- **R2-M3 — "opt-in re-render" had no mechanism → FIXED in §4.1 + §4.3.** Added a per-book
  `liveInstruct` flag (default off) distinct from tier selection, so existing 1.7B books aren't
  silently restyled.
- **R2-M4 — emotion→phrase placement unspecified → FIXED in §4.1.** Derivation is synth-side; the
  stored `instruct` field holds only real instructs.
- **R2-Mo1 — ordering was operator-controlled, not pipeline-fixed → FIXED in §4.2.** Reframed as
  order-independent + TOCTOU-safe for both passes.
- **R2-Mo2 — emotion endpoint conflation + live-gen race → FIXED in §4.2.** Stage 3 gets its own
  endpoint/SSE/error/reducer; text edits follow the manual-edit dirty-then-regen path.
- **R2-Mi1 — golden-audio overlap with fs-55 → FIXED in §5.** fs-55 variant test scoped to 0.6B;
  instruct fixture covers 1.7B.
- **R2-Mi2 — source-text divergence undisclosed → FIXED in §6.** Added a disclosure + the
  conservative/auditable safeguards.
- **R2-Mi3 — no draft gate → FIXED in §1.** Stays `draft` until the C2 sidecar gate + perf
  baseline land.

## 11. Adversarial review — resolutions (round 3, 2026-06-24)

Round 3 was a convergence pass: one contradiction the round-2 flag *created*, one predicate gap,
and wording/scope minors. No new architectural problems — the spec is stable.

- **R3-M1 — the `liveInstruct` flag re-created a dual 1.7B path; §4.3 contradicted itself →
  FIXED in §4.3 + §6 (operator chose KEEP the flag).** "No variants on 1.7B" scoped to
  `liveInstruct=on`; the dual-path maintenance cost is accepted, with variant-path deletion tracked
  as a future cleanup.
- **R3-M2 — dominance gate needed a span the boolean flag lacks → FIXED in §4.4.** Predicate
  redefined as total-`text`-length below the `minChars` floor; no new span field.
- **R3-Mi1 — per-book vs per-character flag → FIXED in §4.1 + §6.** v1 is per-book; per-character
  toggle deferred.
- **R3-Mi2 — Stage-3 text edits persist regardless of the flag → FIXED in §4.2.** Only delivery is
  gated; the inserted text stays (reads flat when flag off).
- **R3-Mi3 — ladder wording → FIXED in §4.1.** "(1.7B + `liveInstruct`)".
