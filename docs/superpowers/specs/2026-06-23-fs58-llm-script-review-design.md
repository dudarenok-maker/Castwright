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

> **Decomposed (2026-06-23, after three adversarial review rounds).** fs-58 splits at the mechanics/content
> seam:
> - **Unit A (this spec):** 4 structural-mechanics classes + `fix_emotion`. **Apply is client-side** (§5):
>   the server review pass is read-only; accepted suggestions dispatch the manual-edit reducers. Two new
>   reducers are needed (`setSentenceText`, `mergeSentences`) — see §5.2; this is NOT zero-new-infra.
> - **Unit B (deferred, §13):** `reattribute` + `flag_nonstory`. Carved out — each drags in a real
>   dependency (cast-create wiring; a new `excludeFromSynthesis` field + exclusion-staleness; a fixture).
> - **Deferred to fs-56:** `validate_instruct` (the per-sentence `instruct` field doesn't exist yet).
>
> **Supersedes** the §4.6 sketch in `2026-06-22-expressive-tts-instruct-tiers-design.md` (incl. its
> "before `manuscript-edits.json`" placement). **#998 + the BACKLOG row must be rewritten** (old: 5 classes
> incl `validate_instruct`, "no GPU", "before manuscript-edits"; new: this Unit A scope, "no TTS engine",
> standalone-anytime) — a doc action landing **with the plan**, the hard gate to leave `draft`.

## 1. Summary

An optional, operator-triggered, **per-chapter** QA pass: a **read-only** second LLM pass over
already-attributed sentences proposes annotation repairs, shown as an accept/reject diff; accepted changes
are applied **client-side by dispatching manual-edit reducers**. Additive — off → today's behaviour exactly.

"Engine-agnostic" = **TTS-engine-agnostic** (no Kokoro/Coqui/Qwen load), *not* GPU-free: it reuses the
analyzer compute (local Ollama on GPU, or Gemini cloud). See §4.4.

## 2. Background

Phase-1 attribution (`server/src/routes/analysis.ts`, `runStage2Chapter`) produces per chapter
`Sentence`s `{ id, chapterId, characterId, text, confidence?, emotion?, startMs?, endMs? }`, written
(post-fold/dedup) to `manuscript-edits.json` at `analysis.ts:~4043`. It is good but leaks attribution
tags into dialogue, over-/under-splits at narrator↔dialogue boundaries (often at intra-chapter chunk
seams Phase-1 couldn't see across, `stage2-chunk.ts`), and sometimes sets a wrong `emotion`. Unit A
repairs exactly those.

**fs-33 is backfill-only and cannot correct emotion.** `applyDetectedEmotions`
(`manuscript-slice.ts:288-306`) skips any sentence that already has an emotion (`:302` —
`if (sent.emotion) continue`) and never sends the current emotion to the model. So "correct a *wrong*
emotion" has no home in fs-33 without new overwrite work — which is why `fix_emotion` lives here (a cheap
field-delta; §5.2). fs-33 (fill empty) and `fix_emotion` (correct wrong) are complementary.

## 3. Error classes — Unit A (5 live)

**Mechanics (structural):**
1. `strip_tag` — remove an attribution tag ("she said") that leaked into dialogue text. *Text edit.*
2. `split` — split narration out of a dialogue entry. *Structural (anchor-located, §4.3).*
3. `extract_dialogue` — pull dialogue out of a narrator run into its own sentence. *Structural.*
4. `merge` — merge over-split narrator entries into one. *Structural (new reducer + tombstone, §5.2).*

**Content (rides along):**
5. `fix_emotion` — correct an obviously-wrong `emotion` enum value (calm line marked `angry` → `neutral`).
   *Field delta on `emotion`.* Reuses `setSentenceEmotion`.

**M5 carve-out:** the prompt **never strips intentional non-verbal vocalizations** ("Ah!", "Haah…") as
attribution tags. Hard, tested constraint on `strip_tag`.

(`reattribute`, `flag_nonstory` → Unit B, §13. `validate_instruct` → fs-56.)

## 4. Architecture & flow

### 4.1 Where it slots

A **standalone, per-chapter job** (not inside the analyse SSE), runnable anytime incl. post-generation:

- `POST /api/books/:bookId/script-review` taking an **optional `chapterId`** (default: the chapter being
  edited; whole-book is opt-in). Own SSE stream mirroring the analysis grammar. Per-chapter keeps the diff
  usable at novel scale (fs-35) AND gives the pass the whole-chapter context Phase-1's chunking lacked
  (the right granularity for the mechanics classes; verified round 3).
- Mounts under `/api` → inherits `requireLanToken` + `requireSameOrigin` CSRF (`app.ts:111-114`), matching
  the annotate-emotion / generation / splice operator-job family.
- **Non-sticky / no resume** (like annotate-emotion): disconnect aborts; re-run from scratch. A book-wide
  run re-spends RPD (§4.5) — surface the expectation.

### 4.2 The review pass — read-only, ~16-site touch-list

The pass writes **no manuscript/cache state** (the analyzer handoff inbox/outbox/error debug files are
written as for every stage); it returns suggestions (§4.3). The `Analyzer` interface is closed/per-stage;
adding a pass is a multi-site extension across server **and frontend** (re-derived from fs-33's
`runEmotionChapter`/`detectEmotions` diff — the prior "~7 / ~13" counts were both low):

*Server:* (1) `runScriptReviewChapter` on `Analyzer` (`index.ts`); (2) `OllamaAnalyzer` impl; (3)
`GeminiAnalyzer` impl; (4) `FallbackAnalyzer` delegation; (5) validation schema + (6) Ollama grammar
schema (distinct artifacts); (7) skill prompt `.md`; (8) `SKILL_FILES` + `SkillName` union
(`gemini.ts:111-125`); (9) `SKILL_TO_PROMPT_ID` (`gemini.ts:130`); (10) **the `prompt.scriptReview`
registry knob in `config/registry.ts`** (`isPrompt:true` — else `readPrompt`/`assertValidId` throws,
`prompts.ts:46-71`); (11) `HandoffKey` (`protocol.ts`); (12) route + SSE; (13) `openapi.yaml` *path* entry.
*Frontend:* (14) `api.ts` **real AND mock** client + registration in both `real`/`mock` objects
(`api.ts:~2654/2736/6803/7064`) + the SSE callback signatures + Error class; (15) the dedicated suggestions
slice file (§5.5) + (16) its registration in `store/index.ts`.

- Model selection reuses `selectAnalyzer` / per-phase selection with a **dedicated review-model knob**
  (persists in **user-settings**, like the analyzer model; defaults to it).
- **Input:** the target chapter's `sentences[]` + the **post-fold** cast roster (cache holds pre-fold
  descriptor ids, `book-state.ts:296-304`).
- **Per-call budget:** assumes a chapter fits one call. A chapter that overflowed Phase-1's ~9000-char
  chunk budget (`stage2-chunk.ts`) is **chunked-with-overlap** for review (don't silently re-introduce the
  chunk-seam blind spot); state overflow behaviour in the plan.

### 4.3 Output format — flat envelope + imperative validation; anchor-located, resolved at accept

Each suggestion is one row `{ id, op, ...payload, rationale, confidence }`. **Decided: flatten both
engines** + imperative per-op validation in the apply layer (§5.6). Rationale: Gemini sends no
`responseSchema` (`gemini.ts:561-566`, free-form JSON); Ollama *can* constrain a discriminated union
(`z.toJSONSchema`, `ollama.ts:336`) but only **softly** (llama.cpp ignores `additionalProperties:false`,
`ollama.ts:330-335`), so an imperative check is required regardless — the asymmetry buys nothing. Don't
claim "schema-constrained" for Gemini.

Payloads:
- **Field edits** keyed by `id`: `strip_tag` (newText), `fix_emotion` (emotion).
- **Structural ops — ANCHOR substring (the model points, never reproduces text):** `split`/
  `extract_dialogue` return a short **boundary-spanning** anchor (last N chars before + first N after the
  split point, joined) + per-piece characterIds; `merge` returns the member `ids`. *(Round 2 picked
  anchor over verbatim-pieces — concat-equality is fragile because LLMs/`gemini.ts:865`'s repair walker
  rewrite quotes/em-dashes. Round 3: the anchor inherits the SAME normalization risk, so the locator
  **NFC- + quote/dash-normalizes both the anchor and the live text before `indexOf`**.)*

**Anchor resolution happens CLIENT-SIDE at accept time** against the **live** `s.sentences[idx].text`
(NOT server-side → offsets) — this closes the TOCTOU where an operator edits the sentence between the
server read and accept (§5.6).

### 4.4 Compute note

Local Ollama (**GPU, same footprint as Phase-1**; holds the analyzer GPU semaphore) or Gemini (cloud).
No TTS model; no new resident GPU model; never co-resident with a TTS engine — clear of the parent spec's
VRAM invariant. On one small (8 GB) GPU it contends with the analyzer and can't run concurrently with a
generation there.

### 4.5 Cost & latency

Per-chapter = **one LLM call/run**. Free-tier RPD bites book-wide: `gemini-2.5/3.5-flash` RPD **20**
(`rate-limit.ts:37-43`) — a 20+-chapter book can't finish in a day; `flash-lite` 500, `gemma` 1500.
Stronger models have the LOWEST RPD. The UI knob **warns when book-wide chapters > model RPD**; default
local Ollama / high-RPD Gemma. Non-sticky + RPD-capped ⇒ interrupted book-wide is unrecoverable that day
— another reason per-chapter is the default.

## 5. Apply — client-side dispatch (the inversion)

### 5.1 The model

The server review pass **writes no manuscript state**. Accepted suggestions are applied in the browser by
**dispatching the manual-edit reducers**. What is inherited *automatically*: **ID allocation** (the global
`maxId+1` in `splitSentence`, `manuscript-slice.ts:347`) and **persistence** (the debounced
`putBookState` manuscript PUT, a blind whole-array write, `book-state.ts:570`). What the apply layer must
dispatch **explicitly per class** (these are call-site responsibilities, NOT reducer freebies — round-3
correction): **staleness** and the **change-log** event. See §5.2/§5.3.

**fs-44 (#721) dependency:** this makes apply browser-only; a headless/MCP agent can't apply. A server
apply path is an explicit fs-44 dependency — to be **filed against #721** with the plan (§9), not assumed.

### 5.2 Per-class reducer mapping

| Class | Reducer | Status |
|---|---|---|
| `split` / `extract_dialogue` | `splitSentence` (`manuscript-slice.ts:330`, takes `offsets[]`+`characterIds[]`; supports narrator/dialogue/narrator 3-piece, `manuscript.tsx:533`) | exists; client resolves the live anchor → offsets at accept (§4.3) |
| `fix_emotion` | `setSentenceEmotion` (`manuscript-slice.ts:269`) | exists |
| `strip_tag` | **NEW `setSentenceText` reducer** | no text-edit reducer exists today |
| `merge` | **NEW `mergeSentences` reducer** | NO sentence-merge path exists — `/chapters/merge` is CHAPTER-level (`restructure.ts:528`); not reusable. New reducer: concat adjacent same-`characterId` texts, drop the consumed id(s); + a **tombstone** so re-analysis can't resurrect the dropped id(s) (§5.3) |

After each dispatch the apply layer also emits the matching **change-log** event (e.g.
`bumpBoundaryMove` for structural ops, `manuscript.tsx:537`) and triggers staleness (§5.3).

### 5.3 Staleness — one unified content-hash mechanism

Today the precise staleness path (`stale-chapters.ts:58-70`) diffs **`characterId` only** of rendered
sentence ids. That misses **every** Unit A edit that doesn't drop/move an id: `strip_tag` (text change),
`split`/`extract` (the retained first piece keeps its id + characterId, only its text shrinks — round-3
THIRD gap), and `fix_emotion` `angry → neutral` (the `value !== 'neutral'` gate,
`sentence-emotion-control.tsx:82`). Rather than patch each:

**Extend the render-time map to carry a per-sentence content hash** (`hash(text + characterId +
emotion-variant)`) — server-side in the GET that builds `renderedSpeakersByChapter` + `segments.json`
(the map is currently `id → characterId` only, `chapters-slice.ts:98`). The precise path then flags any
rendered id whose **current hash ≠ rendered hash**. One mechanism covers all four cases (and the
`fix_emotion` neutral-direction bug — a real latent bug in today's manual flow). `merge` is also covered
(the dropped id disappears from the current set).

### 5.4 In-flight generation

Applying during a generation = manually editing during one: **inherits existing semantics** (no bespoke
guard).

### 5.5 Suggestion lifetime & storage

Ephemeral per run, in a **dedicated, non-polled, bookId-keyed** slice — **NOT** `revisions.pending`
(`applyPoll` wholesale-replaces it, `revisions-slice.ts:160-163`). The modal's read-selector reads **only
the active book's** bucket (concurrent-multi-book invariant). "Extends the DriftReport pattern" = the **UI
pattern only**. A reload discards the run (non-sticky, §4.1); persisting is a follow-up (§9). No cross-tab
sync (manuscript isn't broadcast, `broadcast-middleware.ts:60-62`) — consistent with manual edits.

### 5.6 Imperative op-validation (at accept, against live state)

The apply layer validates each accepted suggestion against the **live client manuscript** immediately
before dispatch; any failure → the suggestion is marked **un-appliable** (the §7 drop path), never
mis-applied:

- **Anchor (structural):** NFC+quote/dash-normalize the anchor and the live sentence text; require
  `indexOf` found **and unique** (`indexOf === lastIndexOf`). A non-unique/absent anchor (common on
  repeated quote chars, or after a mid-review edit) → un-appliable. *(Closes the TOCTOU.)*
- **Apply order (same-id collisions):** structural ops first (merge → split/extract), then field edits vs
  surviving ids; reject a field edit whose id was consumed, and a 2nd structural op on one id.
- **Referenced ids exist** in the live manuscript; `merge` members are adjacent + same `characterId`;
  `fix_emotion` target value is a valid enum.

## 6. Operator UX

- A **"Review Script"** button on the manuscript editing surface (per-chapter; whole-book opt-in). Fires
  `POST …/script-review`; per-chapter progress reuses the analysis SSE `phase` grammar.
- Results in a **`ScriptReviewDiff` modal** (DriftReport accept-reject *pattern*, dedicated slice §5.5),
  grouped by class, per-class accept/reject + per-change drill-down. Each row: before → after, class,
  rationale, confidence.
- **Defaults:** all 5 Unit A classes are corrective/low-risk → pre-selected **ON** (operator deselects).
  **Apply** dispatches the §5.2 reducers + change-log + staleness (§5.1/§5.3). (Default-OFF tiering is a
  Unit B concern.)

## 7. Error handling

- LLM unreachable → Gemini fallback; both down → SSE `error`, no suggestions, no state change.
- Throttle / RPD → `onThrottle` SSE; book-wide may hit `DailyQuotaExhaustedError` mid-run (§4.5).
- Invalid op (anchor absent/non-unique, consumed-id edit, stale id) → dropped + logged + surfaced
  un-appliable; run continues.
- Cancel/abort → `signal` propagates; ephemeral suggestions discarded.

## 8. Testing & acceptance

- **Server unit, per class (5):** before/after fixtures; op-envelope parse + imperative validation.
- **Client apply-via-reducer:** accepted `strip_tag`/`split`/`extract`/`merge`/`fix_emotion` dispatch the
  mapped reducers (incl. the new `setSentenceText` + `mergeSentences`) and produce the same state a manual
  edit would, incl. global ID allocation.
- **Staleness (unified hash, §5.3):** `strip_tag`, a `split` retained piece, and `fix_emotion`
  `angry → neutral` each mark a *rendered* chapter stale (the three gaps the characterId-only diff missed).
- **`merge` re-analysis survival:** a sentence-merge + a subsequent re-analysis does NOT resurrect the
  dropped id / duplicate content (the tombstone works).
- **Anchor locator:** found/unique → correct split; non-unique → un-appliable; **quote-normalization**
  (LLM returns a curly-quote/em-dash anchor; live text has straight) → resolves or rejects deterministically.
- **TOCTOU:** a well-formed suggestion whose target sentence was edited between run and accept is rejected
  as un-appliable (anchor no longer unique / id text changed), not mis-applied.
- **M5 abstention:** `strip_tag` must NOT strip intentional vocalizations ("Ah!").
- **Frontend unit:** `ScriptReviewDiff` selection → dispatch; the dedicated slice is **not wiped** by a
  revisions poll and **shows only the active book**.
- **E2E (Playwright):** per-chapter trigger → diff → accept a subset → manuscript updates → chapter reads
  stale. Append a case to `e2e/responsive/coverage.spec.ts`.
- **No api-types regen** (suggestions are ephemeral — no new persisted type); **no sidecar/golden tier**
  (no TTS model).

## 9. Non-goals & follow-ups

**Non-goals (Unit A):** no TTS-engine involvement (§4.4); no `reattribute`/`flag_nonstory` (Unit B, §13);
no `validate_instruct` (fs-56); no headless/server apply (browser-only, §5.1); no suggestion persistence;
no auto-apply without review; no free-form rewriting beyond `strip_tag`; no entitlement gate.

**Follow-ups — to FILE WITH THE PLAN (none are filed yet; the spec does not claim otherwise):**
1. **Rewrite #998 + the BACKLOG row** to Unit A scope + "no TTS engine" — the hard gate to leave `draft`.
2. **fs-58 Unit B** issue (`reattribute` + `flag_nonstory`) with its deps (§13).
3. **`validate_instruct`** issue (blocked on fs-56's `instruct`) **+ edit fs-56 (#996)** to carry the
   move-here note (bidirectional capture in tracked artifacts).
4. **Edit fs-44 (#721)** with the server-apply dependency note (§5.1).
5. **Persist suggestions** across reload (can wait).

## 10. Dependencies & linkage

- **Reuses:** `splitSentence`, `setSentenceEmotion`, the debounced `putBookState` persistence, the
  change-log (`bumpBoundaryMove`), the analyzer call path + `RateLimiter`, the DriftReport UI pattern,
  the SSE operator-job pattern.
- **New:** `setSentenceText` reducer + the **`mergeSentences`** reducer + the merge **tombstone**; the
  unified content-hash on the render map (server GET + `segments.json` + `chapters-slice` type, §5.3); the
  dedicated suggestions slice (§5.5); the review pass + endpoint + diff modal; the `registry.ts` prompt
  knob (§4.2). **No `api-types.ts` regen** (ephemeral suggestions).
- **fs-56 (#996)** `validate_instruct`; **fs-33 (#596)** complementary backfill; **fs-44 (#721)** server
  apply path.

## 11. Implementation ordering (for the plan)

1. **Apply foundations (client-side, test-first):** the `setSentenceText` + `mergeSentences` reducers; the
   unified content-hash staleness (render map + server GET + precise-path diff); the client anchor
   resolver (§4.3/§5.6); per-class change-log emission. With the §8 apply/staleness/merge-resurrection/
   anchor/TOCTOU regressions. *Highest-risk; carries the latent-bug staleness fixes.*
2. **Read-only review pass + endpoint:** the ~16-site extension (§4.2); the flat-envelope schema +
   imperative validation; the per-chapter endpoint + optional book-wide + overflow chunking; the
   review-model knob + RPD warning; the prompt + M5 carve-out + abstention prompting.
3. **Operator UX:** the dedicated slice + `store/index.ts` registration; `ScriptReviewDiff`; the accept →
   dispatch wiring; the E2E spec.

*Smallest still-valuable slice if scope must shrink later: steps share the harness, so a field-edits-only
cut (`strip_tag` + `fix_emotion` + the staleness fixes, no anchor/structural reducers) remains a clean
fallback — recorded per the round-3 recommendation, not the chosen scope (all 5).*

## 12. Adversarial review — resolutions (R1+R2+R3, 2026-06-23)

Three rounds, three code-grounded reviewers each.

- **R1:** server-side invalidation fictional; merge-as-drop resurrects; Gemini `responseSchema` unwired;
  offsets fragile; mixed-op order undefined; maxId global; reuse overstated; pre-selected-all unsafe;
  whole-book unusable.
- **R2:** server apply fights the client-driven architecture (wrong lock / refetch-clobber / frontend-only
  restructure) → **invert apply to the client (§5)**; `boundary_move` wrong primitive; verbatim-pieces
  more fragile than offsets → **anchor (§4.3)**; `fix_emotion`→fs-33 a silent regression → **kept (§2)**;
  `reattribute`/`flag_nonstory` deps → **Unit B**; touch-list undercounted; **decompose**.
- **R3:** **`merge` has no reducer** (`/chapters/merge` is chapter-level) → **new `mergeSentences` +
  tombstone (§5.2/§5.3)**; **TOCTOU** (server offset vs live text) → **client-side anchor resolution at
  accept (§4.3/§5.6)**; "inherits wholesale" overstated → **staleness/change-log are call-site dispatches
  (§5.1)**; **third staleness gap** (split/extract retain ids) → **unified content-hash (§5.3)**;
  touch-list ~16 (registry knob + mock api + store registration); **§5.6 created**; flatten-both
  **decided (§4.3)**; per-chapter verified the right granularity; #998 stale + follow-ups unfiled →
  **file with the plan (§9)**.

## 13. Unit B (deferred — file as a follow-up)

`reattribute` + `flag_nonstory`. Same harness as Unit A; each adds a class + an unmet dependency:

**`reattribute`** — re-assign a dialogue line to the correct existing cast member (field delta on
`characterId` via `setSentenceCharacter`; covered by the §5.3 hash). Deps: **off-roster actionability** —
no path to add a never-detected character (the "Add character" button `manuscript.tsx:1053` is inert; only
`add-from-roster` + alias-unlink exist), so the intended `reattribute_blocked` advisory has nowhere to go
without new cast-create wiring; **cross-chapter context** (tagless turn-taking straddles chapters → needs
book-wide, in tension with RPD); **default OFF**.

**`flag_nonstory`** — flag import residue (page numbers, running headers). Deps: **new
`excludeFromSynthesis` field** (OpenAPI → types → Zod) + a synth filter in `buildSentenceGroups`
(`synthesise-chapter.ts:~659`, location verified) + **`api-types.ts` regen**; **exclusion-staleness** (an
excluded sentence changes no `characterId` and isn't dropped — needs the §5.3 hash to also notice the
exclude flag); **a positive fixture** (the canonical `the-coalfall-commission.md` is clean markdown with
zero artifacts — the class is **import-residue-specific**, mostly PDF/EPUB); **default OFF**.
