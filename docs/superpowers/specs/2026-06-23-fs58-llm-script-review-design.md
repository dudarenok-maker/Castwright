---
title: 'fs-58 — LLM Script Review, Unit A: annotation mechanics + emotion correction'
status: draft
date: 2026-06-23
issue: '#998'
related:
  - 2026-06-22-expressive-tts-instruct-tiers-design.md (§4.6 — fs-58's original sketch; this spec supersedes it, incl. placement)
  - fs-56 (#996) — per-line `instruct` field; owns the deferred `validate_instruct` class
  - fs-33 (#596) — emotion-only BACKFILL pass; cannot correct an existing emotion (see §2), so `fix_emotion` stays here
  - fs-44 (#721) — MCP/agent surface; client-side apply (§5) is browser-only → a server apply path is an fs-44 dependency (§9)
  - fs-35 — per-chapter scoping precedent (whole-book pass is too coarse)
  - fs-25 (#479) — per-quote emotion enum (the field `fix_emotion` repairs)
  - Russian stage-2 attribution under-production (plan 221) — the attribution pain Unit B's `reattribute` targets
inspiration: github.com/Finrandojin/alexandria-audiobook (Alexandria — LLM Script Review)
---

# fs-58 — LLM Script Review (Unit A)

> **Decomposed (2026-06-23, after two adversarial review rounds).** fs-58 splits at the mechanics/content
> seam:
> - **Unit A (this spec):** 4 structural-mechanics classes + `fix_emotion`. Self-contained, fully testable,
>   no unmet dependencies. **Apply is client-side** (§5).
> - **Unit B (deferred, §13):** `reattribute` + `flag_nonstory`. Carved out — each drags in a real
>   dependency that isn't fs-58's job (cast-create wiring; a new `excludeFromSynthesis` field + an
>   exclusion-staleness fix; an artifact-bearing test fixture).
> - **Deferred to fs-56:** `validate_instruct` (the per-sentence `instruct` field doesn't exist yet).
>
> **Supersedes** the §4.6 sketch in `2026-06-22-expressive-tts-instruct-tiers-design.md`, **including its
> placement** ("before `manuscript-edits.json` is written"): this runs as a standalone job *over* the
> manuscript, anytime. **#998 + the BACKLOG row must be updated** (5 classes + "no GPU" → this scope +
> "no TTS engine") before leaving `draft`.

## 1. Summary

An optional, operator-triggered, **per-chapter** QA pass: a **read-only** second LLM pass over
already-attributed sentences proposes annotation repairs, shown as an accept/reject diff; accepted changes
are applied **client-side by dispatching the same reducers a manual edit uses**. Additive — off → today's
behaviour exactly.

"Engine-agnostic" = **TTS-engine-agnostic** (no Kokoro/Coqui/Qwen load), *not* GPU-free: it reuses the
analyzer compute (local Ollama on GPU, or Gemini cloud). See §4.4.

## 2. Background

Phase-1 attribution (`server/src/routes/analysis.ts`, `runStage2Chapter`) produces per chapter
`Sentence`s `{ id, chapterId, characterId, text, confidence?, emotion?, startMs?, endMs? }`, written
(post-fold/dedup) to `manuscript-edits.json` at `analysis.ts:~4043`. It is good but leaks attribution
tags into dialogue, over-/under-splits at narrator↔dialogue boundaries, and sometimes sets a wrong
`emotion`. Unit A repairs exactly those.

**fs-33 is backfill-only and cannot correct emotion.** Its apply path `applyDetectedEmotions`
(`manuscript-slice.ts:288-306`) skips any sentence that already has an emotion (`:302` —
`if (sent.emotion) continue`), and its prompt never sends the current emotion to the model. So "correct a
*wrong* emotion" has no home in fs-33 without new overwrite-mode work — which is why `fix_emotion` lives
here (it's a cheap field-delta; §5.2). fs-33 (fill empty) and `fix_emotion` (correct wrong) are
complementary, not duplicative.

## 3. Error classes — Unit A (5 live)

**Mechanics (structural):**
1. `strip_tag` — remove an attribution tag ("she said") that leaked into dialogue text. *Text edit.*
2. `split` — split narration out of a dialogue entry. *Structural (anchor-located, §4.3).*
3. `extract_dialogue` — pull dialogue out of a narrator run into its own sentence. *Structural.*
4. `merge` — merge over-split narrator entries into one. *Structural.*

**Content (rides along — ready, no unmet deps):**
5. `fix_emotion` — correct an obviously-wrong `emotion` enum value (calm line marked `angry` → `neutral`).
   *Field delta on `emotion`.* Reuses `setSentenceEmotion`; carries the neutral-direction staleness fix
   (§5.3).

**M5 carve-out:** the prompt **never strips intentional non-verbal vocalizations** ("Ah!", "Haah…") as
attribution tags. Hard, tested constraint on `strip_tag`.

(`reattribute`, `flag_nonstory` → Unit B, §13. `validate_instruct` → fs-56.)

## 4. Architecture & flow

### 4.1 Where it slots

A **standalone, per-chapter job** (not inside the analyse SSE), runnable anytime incl. post-generation:

- `POST /api/books/:bookId/script-review` taking an **optional `chapterId`** (default: the chapter being
  edited; whole-book is opt-in). Own SSE stream mirroring the analysis grammar. Per-chapter keeps the diff
  usable at novel scale (fs-35 precedent).
- Mounts under `/api` → inherits `requireLanToken` + `requireSameOrigin` CSRF (`app.ts:111-114`).
- **Non-sticky / no resume** (like fs-33's annotate-emotion): a disconnect mid-run aborts; re-run from
  scratch. On a book-wide run this re-spends RPD (§4.5) — surface the expectation.

### 4.2 The review pass — read-only, ~13-site touch-list

The pass **writes nothing**; it returns suggestions (§4.3). The `Analyzer` interface is closed and
per-stage; adding a pass is a multi-site extension across server **and frontend** (re-derived from the
fs-33 `runEmotionChapter` diff — the round-1 "~7 sites" was undercounted):

*Server:* (1) `runScriptReviewChapter` on the `Analyzer` interface (`index.ts`); (2) `OllamaAnalyzer`
impl; (3) `GeminiAnalyzer` impl; (4) `FallbackAnalyzer` delegation; (5) the **validation** schema +
(6) the **grammar** schema for Ollama constrained-decode (distinct artifacts, cf. `stage1ChapterGrammarSchema`);
(7) the skill prompt `.md`; (8) `SKILL_FILES` + the `SkillName` union (`gemini.ts:123`); (9)
`SKILL_TO_PROMPT_ID` (`gemini.ts:130`); (10) a `HandoffKey`; (11) the route + SSE; (12) the
`openapi.yaml` *path* entry. *Frontend:* (13) the `api.ts` client method + its SSE-event/Opts/Result
types (cf. fs-33's `detectEmotions`, `api.ts:~2655`).

- Model selection reuses `selectAnalyzer` / per-phase selection with a **dedicated review-model knob**
  (defaults to the analyzer's model).
- **Input:** the target chapter's `sentences[]` + the **post-fold** cast roster (the cache holds pre-fold
  descriptor ids, `book-state.ts:296-304`; post-fold avoids spurious drops).

### 4.3 Output format — flat envelope + imperative validation; anchor-located structural ops

Each suggestion is one row `{ id, op, ...payload, rationale, confidence }`. The Zod schema validates the
**envelope only**; per-op payload shape is validated **imperatively in the apply layer** (§5.6), because
the Gemini path sends no `responseSchema` (`gemini.ts:561-566`) — output is free-form JSON. *(Asymmetry to
decide at plan time: Ollama **can** enforce a discriminated union via constrained decode / `z.toJSONSchema`
— `ollama.ts:312-328`; Gemini cannot. Either keep a union for Ollama + imperative checks for Gemini, or
flatten both. Don't claim "schema-constrained" for Gemini.)*

Payloads:
- **Field edits** keyed by `id`: `strip_tag` (newText), `fix_emotion` (emotion).
- **Structural ops — ANCHOR-LOCATED, not verbatim pieces.** The LLM returns a **short unique anchor
  substring** marking the split point (`split`/`extract_dialogue`) or the member `ids` (`merge`). The
  apply layer locates the anchor with `indexOf` in the *original* text (+ uniqueness check) and **slices
  the pieces itself**. The model only *points*; it never reproduces text. *(Round 2 reversed the round-1
  "content-addressed pieces" fix: verbatim-piece concat-equality is MORE fragile here — LLMs normalize
  curly quotes / em-dashes, and the Gemini JSON-repair walker rewrites quotes inside strings,
  `gemini.ts:865`, so quote/dash-bearing dialogue — the main split target — would fail equality and drop
  silently. Anchor-locate keeps the server the sole source of truth for text.)*

**Apply order** (same-id collisions): structural ops first (merge → split/extract), then field edits vs
surviving ids; reject a field edit whose id was consumed, and a 2nd structural op on one id.

### 4.4 Compute note

Reuses the analyzer path — local Ollama (**GPU, same footprint as Phase-1**; holds the analyzer GPU
semaphore, `ollama.ts:523`) or Gemini (cloud). Loads no TTS model; adds no new resident GPU model; never
co-resident with a TTS engine — clear of the parent spec's §4.7 VRAM invariant. On one small (8 GB) GPU it
**contends with the analyzer and evicts/evicted-by TTS** — can't run concurrently with a generation there.

### 4.5 Cost & latency

Per-chapter = **one LLM call/run** (book-wide = one per chapter). Free-tier RPD bites on book-wide:
`gemini-2.5/3.5-flash` RPD **20** (`rate-limit.ts:37-43`) — a 20+-chapter book can't finish in a day;
`gemini-3.1-flash-lite` RPD 500, `gemma` 1500. **Stronger models have the LOWEST RPD**, so the review-model
knob's "stronger model" worsens book-wide cost. The UI knob **warns when book-wide chapters > model RPD**;
recommended default is local Ollama or a high-RPD Gemma. Non-sticky (§4.1) + RPD-capped means an
interrupted book-wide run is unrecoverable within the day — another reason per-chapter is the default.

## 5. Apply — client-side dispatch (the inversion)

### 5.1 The model

The server review pass **writes nothing**. Accepted suggestions are applied in the browser by
**dispatching the existing manual-edit reducers**. Consequence: Unit A **inherits manual-edit semantics
wholesale** — ID allocation (the global `maxId+1` rule in `splitSentence`/restructure), persistence (the
debounced `putBookState` manuscript PUT), staleness derivation, the change-log, and in-flight-generation
behaviour all come for free, because an accepted suggestion *is* a manual edit. This dissolves the round-1/2
server-apply hazards (wrong write-lock, refetch-clobbers-unflushed-edits, server can't reuse the frontend
restructure reducer, tombstone has no consumer) — none arise when apply never leaves the client.

**fs-44 note (filed, §9):** this makes apply browser-only. A headless/MCP agent (no Redux) cannot apply,
so an equivalent **server apply path is an explicit fs-44 dependency** — captured so the agent surface
doesn't silently inherit a browser-only assumption.

### 5.2 Per-class reducer mapping

| Class | Reducer | Status |
|---|---|---|
| `split` / `extract_dialogue` | `splitSentence` (`manuscript-slice.ts:330`) | exists; server resolves the anchor (§4.3) → offsets before dispatch |
| `merge` | `applyChapterRestructure` via the existing `/chapters/merge` route + remap (`restructure.tsx`, `manuscript-slice.ts:378`) | exists; **merge uses the same path manual merges use**, so re-analysis resurrection is handled by the path that already handles it |
| `fix_emotion` | `setSentenceEmotion` (`manuscript-slice.ts:269`) | exists |
| `strip_tag` | **NEW `setSentenceText` reducer** | **no text-edit reducer exists today** — see §5.3 |

### 5.3 Two staleness/reducer gaps Unit A must close (honest)

The precise staleness path (`stale-chapters.ts:58-70`) diffs **`characterId` only** of rendered sentences.
Two Unit A edits change neither id-set nor characterId, so they would NOT mark audio stale:

1. **`strip_tag` (text change).** Needs (a) a new `setSentenceText` reducer (persists via the existing
   whole-array manuscript PUT, `book-state.ts:570`) and (b) extending the rendered-sentence diff to flag a
   **text change** on a rendered id (the spoken words changed → audio is stale). NEW.
2. **`fix_emotion` neutral-direction.** The emotion-staleness rule (`sentence-emotion-control.tsx:77-87`)
   only marks stale when the *new* value is `≠ neutral` (+ Qwen + a designed variant). Correcting
   `angry → neutral` — `fix_emotion`'s signature case — leaves the angry-variant audio in place silently.
   Fix: compare *rendered* emotion-variant vs *new* emotion, not just `≠ neutral`. (A latent bug in the
   existing manual emotion-edit flow; worth fixing regardless.)

`split`/`extract`/`merge` need no staleness work — they change the rendered id-set, which the precise path
already detects.

### 5.4 In-flight generation

Applying during a generation = manually editing during a generation: **inherits existing semantics** (no
bespoke per-chapter guard, no book-level block). Whatever the app does for a manual edit mid-render, it
does here — by construction.

### 5.5 Suggestion lifetime & storage

Ephemeral per run, in a **dedicated, non-polled, bookId-keyed** slice — **NOT** `revisions.pending`
(`applyPoll` replaces it wholesale, `revisions-slice.ts:160-163`, which would wipe an in-progress review
and break the concurrent-multi-book invariant). The modal's read-selector reads **only the active book's
bucket**. "Extends the revisions/DriftReport pattern" = the **UI pattern only**. A reload discards the run
(consistent with non-sticky, §4.1); persisting suggestions is a follow-up (§9). No cross-tab sync
(manuscript isn't broadcast, `broadcast-middleware.ts:60-62`) — consistent with manual edits.

## 6. Operator UX

- A **"Review Script"** button on the manuscript editing surface (per-chapter; whole-book is an explicit
  opt-in). Fires `POST …/script-review`; per-chapter progress reuses the analysis SSE `phase` grammar.
- Results in a **`ScriptReviewDiff` modal** (the DriftReport accept-reject *pattern*, dedicated slice
  §5.5), grouped by class, per-class accept/reject + per-change drill-down. Each row: before → after,
  class, rationale, confidence.
- **Defaults:** all Unit A classes are corrective/low-risk → pre-selected **ON** (operator deselects).
  **Apply** dispatches the §5.2 reducers, which trigger the inherited staleness/change-log/persistence.
  (The high-risk default-OFF tiering applies to Unit B's content classes, not Unit A.)

## 7. Error handling

- LLM unreachable → Gemini fallback; both down → SSE `error`, no suggestions, no state change.
- Throttle / RPD → `onThrottle` SSE event; book-wide may hit `DailyQuotaExhaustedError` mid-run (§4.5).
- Malformed / invalid op (anchor not found / not unique, consumed-id edit) → dropped + logged + surfaced
  as un-appliable; the run continues.
- Cancel / abort → `signal` propagates; ephemeral suggestions discarded.

## 8. Testing & acceptance

- **Server unit, per class (5):** before/after fixtures; the anchor-locator resolution (found + unique →
  correct slice; not-found / ambiguous → rejected); apply-order on mixed same-id ops (§4.3); op-validation
  rejections (§5.6/§7).
- **Staleness regressions (§5.3):** `strip_tag` on a rendered sentence marks the chapter stale;
  `fix_emotion` `angry → neutral` on a rendered sentence marks it stale (the neutral-direction fix).
- **Apply-via-reducer:** accepted `split`/`merge`/`fix_emotion`/`strip_tag` dispatch the mapped reducers
  and produce the same state a manual edit would (incl. global ID allocation, survives re-analysis).
- **M5 abstention:** `strip_tag` must NOT strip intentional vocalizations ("Ah!").
- **Frontend unit:** `ScriptReviewDiff` selection logic → dispatch payload; the dedicated slice is **not
  wiped** by a revisions poll and **shows only the active book** (concurrent-multi-book).
- **E2E (Playwright):** per-chapter trigger → diff → accept a subset → manuscript updates → chapter reads
  stale. Append a case to `e2e/responsive/coverage.spec.ts`.
- **No sidecar/golden-audio tier** — Unit A loads no TTS model.

## 9. Non-goals & follow-ups

**Non-goals (Unit A):** no TTS-engine involvement (§4.4); no `reattribute`/`flag_nonstory` (Unit B, §13);
no `validate_instruct` (fs-56); no headless/server apply (browser-only, §5.1 — fs-44 dep below); no
suggestion persistence (below); no auto-apply without review; no free-form rewriting beyond `strip_tag`;
no entitlement gate ("premium" dropped).

**Follow-ups — FILE NOW (issue + thin BACKLOG row, per the project rule); the #998/BACKLOG update is a
hard gate to leave `draft`:**
1. **Update #998 + BACKLOG** to Unit A scope + the "no TTS engine" correction.
2. **fs-58 Unit B** (`reattribute` + `flag_nonstory`) — file with its deps (§13).
3. **`validate_instruct`** — blocked on fs-56's per-sentence `instruct`; **also edit the fs-56 issue/spec**
   to carry the move-here note (bidirectional in tracked artifacts).
4. **fs-44 server apply path** — headless equivalent of §5's client apply.
5. **Persist suggestions** across reload (`script-review-suggestions.json`).

## 10. Dependencies & linkage

- **Reuses (no new infra):** `splitSentence`, `applyChapterRestructure` + the `/chapters/merge` route,
  `setSentenceEmotion`, the debounced `putBookState` manuscript persistence, the change-log + staleness
  derivation, the analyzer call path + `RateLimiter`, the DriftReport accept-reject UI pattern.
- **New:** `setSentenceText` reducer + text-change staleness (§5.3.1); the neutral-direction emotion
  staleness fix (§5.3.2); the dedicated suggestions slice (§5.5); the review pass + endpoint + diff modal.
- **fs-56 (#996)** — `validate_instruct` parked there (§9.3). **fs-33 (#596)** — backfill, complementary to
  `fix_emotion` (§2). **fs-44 (#721)** — server apply path (§5.1, §9.4).

## 11. Implementation ordering (for the plan)

1. **Apply foundations (client-side):** the `setSentenceText` reducer + text-change staleness; the
   neutral-direction emotion staleness fix; the per-class reducer mapping (§5.2) + anchor→offset
   resolution; with the §8 apply-via-reducer + staleness regressions. *Self-contained, test-first.*
2. **Read-only review pass + endpoint:** the ~13-site extension (§4.2); the flat-envelope schema +
   imperative op-validation (decide Ollama-union vs flatten, §4.3); the per-chapter endpoint + optional
   book-wide; the review-model knob + RPD warning (§4.5); the prompt + M5 carve-out + abstention prompting.
3. **Operator UX:** the dedicated slice (§5.5); `ScriptReviewDiff` (per-chapter, per-class toggles); the
   accept → dispatch wiring; the E2E spec.

## 12. Adversarial review — resolutions (R1 + R2, 2026-06-23)

Two rounds, three code-grounded reviewers each. Net effect: decompose to Unit A + invert apply to the
client.

**Round 1 → revision 1:** server-side invalidation was fictional (staleness is client-derived);
merge-as-drop resurrected on re-analysis; Gemini `responseSchema` unwired; offsets fragile; mixed-op order
undefined; maxId global not per-chapter; "wholesale reuse" overstated; `excludeFromSynthesis` cosmetic;
pre-selected-all unsafe; whole-book unusable. *(Revision 1 fixed several but introduced new errors —
caught in round 2.)*

**Round 2 → this spec (Unit A):**
- **Server apply fights the architecture (C3/C4/H1) → §5 client-side apply.** Wrong write-lock,
  refetch-clobbers-unflushed-edits, and the frontend-only restructure reducer all dissolve when apply
  never leaves the client.
- **`boundary_move` is the wrong staleness primitive for rendered chapters → §5.3.** The precise
  characterId-diff supersedes it; `strip_tag`/`fix_emotion` need explicit staleness fixes.
- **Verbatim-pieces MORE fragile than offsets → §4.3 anchor-locator.**
- **`fix_emotion`→fs-33 was a silent capability regression → kept in Unit A (§2/§3).** fs-33 is
  backfill-only.
- **`reattribute_blocked` advisory points at a non-existent add-cast path; `flag_nonstory` is
  import-residue-specific + untestable on the canonical fixture → both carved to Unit B (§13).**
- **Touch-list undercounted → §4.2 ~13 sites incl. frontend.**
- **Decompose at the mechanics/content seam → Unit A / Unit B.**
- **Folded:** per-chapter trigger (fs-35); flat-envelope honesty + Ollama-union asymmetry (§4.3);
  dedicated non-polled slice + reload story + active-book selector (§5.5); RPD cost (§4.5); `.strict()`
  safe on disk; dropping `startMs/endMs` on structural ops (no runtime consumer — verified); the count
  corrected to **5 live (Unit A)**; the `isLikelyFrontMatter` precedence note dropped (real chapter
  exclusion is `excludedSlugs`, pre-analysis, so no sentences exist to interact — moved to Unit B's
  concern).

## 13. Unit B (deferred — carved out, file as a follow-up)

`reattribute` + `flag_nonstory`. Same harness as Unit A (review pass, diff modal, client-side apply); each
adds a class plus an unmet dependency:

**`reattribute`** — re-assign a dialogue line to the correct **existing** cast member (field delta on
`characterId` via `setSentenceCharacter`; detected by the precise staleness path). Deps:
- **Off-roster actionability.** When the correct speaker isn't in the roster (folded into `unknown-*`), the
  intended `reattribute_blocked` advisory has **nowhere to go** — there is no "add a never-detected
  character" path (the "Add character" button `manuscript.tsx:1053` is inert; only `add-from-roster` +
  alias-unlink exist). Needs net-new cast-create wiring, or the advisory must be narrowed to the cases
  that work.
- **Cross-chapter context.** Tagless turn-taking can straddle a chapter boundary; per-chapter review
  inherits Phase-1's boundary blind spot. Book-wide is the only way to catch chapter-straddling
  reattributions (in tension with the RPD/usability limits).
- **Default OFF** in the diff (high-risk — re-voices dialogue + invalidates audio).

**`flag_nonstory`** — flag import residue (page numbers, running headers) so the TTS doesn't read them.
Deps:
- **New `excludeFromSynthesis` field** (OpenAPI → types → Zod) + a synth-side filter in
  `buildSentenceGroups` (`synthesise-chapter.ts:~659`, location verified) — without it the flag is
  cosmetic.
- **Exclusion-staleness fix:** excluding a sentence changes no `characterId`, so the precise path won't
  mark the chapter stale — already-rendered audio keeps speaking the junk line. Needs an exclusion-aware
  branch in `isChapterReassignedSinceRender` (`stale-chapters.ts`).
- **A positive test fixture:** the canonical `the-coalfall-commission.md` is clean markdown with zero
  artifact lines (markdown/plaintext import strips none); needs a PDF/synthetic artifact-bearing fixture —
  the class is **import-residue-specific** (mostly PDF/EPUB), narrower than "front-matter" implies.
- **Default OFF** in the diff (can silently mute real story lines if it over-fires).
