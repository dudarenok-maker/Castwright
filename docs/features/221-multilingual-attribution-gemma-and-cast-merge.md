---
status: active
shipped: null
owner: null
---

# 221 — Multilingual attribution: Russian prompt guards + local model + cast de-duplication

> Status: active — **Wave A shipped** (#852, narrator-default heuristic + dash-tag
> guard); **Wave D shipped** (#856, localized cast buckets); **Wave B core already
> works** via #851's model picker + the existing `defaultAnalysisModel` setting
> (set gemma in Account → Model settings — admin-selectable, no hardcoding; only
> per-language auto-default would be net-new, optional); **Wave C RE-OPENED + SHIPPED**
> (2026-06-20, branch `fix/server-ru-cast-dedup-and-tone`) — the "OBSOLETE, 0 dups"
> re-measure was a **false negative** (a single stochastic gemma probe got consistent
> ids; a real run drifts). User hit byte-identical duplicate display names with
> transliterated ids (`ольга`/`olga`, `ilya`/`илья`, `semen`/`семен`,
> `тигренок`/`tigrenok`) on a real gemma4-e4b run. Fixed model-independently via a
> finalization `dedupeRosterByName` pass (Tier-1 exact + Tier-2a full-vs-short
> auto-merge + Tier-2b diminutive SUGGESTIONS), canonical id = `safeId(name)`, with
> a voiceState-ranked prior-cast remap so designed voices follow the merge, plus a
> two-schema `runStage` (required-tone GRAMMAR / tolerant VALIDATION) + deterministic
> `fillToneFromAttributes` backstop closing the tone-0% root cause (tone was
> `.optional()` in the constrained-decoding schema). Follow-ups: srv-44 #960,
> srv-45 #961. Design+plan: `docs/superpowers/{specs,plans}/2026-06-20-russian-cast-dedup-and-tone*`.
> **Wave E implemented** (2026-06-19, `fix/server-ru-cast-tone-localization-aliases`):
> Russian cast-field under-population — tone 0%→100% + localized role/description via
> a `languagePreamble` cast-field guard, plus same-id alias capture in the roster merge.
> **Wave F implemented** (2026-06-19, `fix/server-ru-descriptor-fold-phrases`): Russian
> descriptor-phrase fold (safe-tier `isDescriptorName` widening — function-word phrases +
> оператор/водитель), closing Wave D's stated `isDescriptorName` limitation. Byline-author
> mis-roster (author ate Anton's lines) split out to **bug #938** for a dedicated brainstorm.
> The Russian pipeline is functional end-to-end. Investigation reproduced cold; the
> **prompt-guard fix is empirically validated**, model choice settled. Extends [162 (fs-2 multilanguage)](162-fs2-multilanguage.md)
> and [187 (large-chapter stage-2 + attribution coverage)](archive/187-large-chapter-stage2-and-attribution-coverage.md).
> Trigger: full analysis of a Russian book (Ночной дозор / Night Watch, 9 ch,
> 43-char cast, run on the **local** engine with `qwen3.5:9b`) never completes —
> stage-2 attribution fails the coverage guard, and the cast is full of
> un-merged duplicates.

## Benefit / Rationale

- **User:** a non-English manuscript (Russian first) completes a full local
  analysis, with sentences attributed *correctly* (dialogue to speakers,
  narration to the narrator), the cast collapsed to the real people, and one-off
  background speakers folded into localized generic voices.
- **Technical:** the stage-2 attribution prompt becomes script-aware (Russian
  dash-dialogue + third-person-narration rules); the recommended local model for
  non-English is one proven robust on Cyrillic dialogue; cross-chapter roster
  merging stops minting duplicates.
- **Architectural:** no contract change — `language` stays an open BCP-47 string
  (162); model id stays a free string routed by `selectAnalyzer`.

---

## Root cause (reproduced, with correctness measured — not just coverage)

Driven through the **real** pipeline (real EPUB parse → real chunker → real
skill prompt → exact Ollama `/api/chat` body). Probe scripts:
`server/repro-*.mts` (untracked scratch — delete before any commit).

**Critical methodology note:** the stage-2 coverage guard (`stage2-coverage.ts`)
**never inspects `characterId`** — `ok` is computed purely from word-overlap of
sentence *text*. So "coverage PASS (ratio 0.9)" means *"~90% of words were
transcribed back"*, NOT *"speakers are correct."* All model judgements below
were therefore re-measured on **attribution correctness** (per-sentence speaker
labels), not coverage.

### Defect 3 — stage-2 under-production + mis-attribution on Russian dialogue (blocker)

`qwen3.5:9b`, under constrained JSON decoding, attributes the opening narration
then **collapses at the first em-dash («—») dialogue line**, emits a tiny valid
JSON, and stops (`done_reason: stop`, not `length` — the truncation guard never
fires; only coverage catches it). **Stochastic — ~⅔ of attempts fail** at temp
0.2 (small-N estimate), which is why all 3 coverage retries failed. The current
coverage-guard retry re-runs the **identical call at the same temperature**;
bumping temperature made it *worse* in testing — grammar-off ~doubled Qwen's
completion rate but didn't fix it.

Independently, **both** Qwen and Gemma mis-handle two Russian-specific things
even when they complete:
1. **Third-person narration labelled as the character** (`Егор засунул руки в
   карманы` → `egor`) instead of `narrator` — would read narration in the
   character's voice.
2. **Dash-dialogue narrative *tags*** (`— коротко сказал юноша`, `— Девушка
   улыбнулась`) attributed to a speaker instead of `narrator`. Root cause: the
   attribution skill's "split dialogue from tags" rules + examples are
   English-quote-centric (`"…," he said`); Russian `— speech — tag` gets
   segmented into tag-fragments that look like speech.

### Defect 1 — cross-chapter cast merge is exact-id only

`mergeRosterChapter` (`server/src/routes/analysis.ts:545`, key line `:550`
`roster.get(incoming.id)`) merges by **exact id**, with no name/alias fallback.
The analyzer emits divergent ids for the same Russian person across chapters
(transliteration + name-form drift) → 43 unmerged duplicates, every
`aliases: []`: `boris-ignatyevich`/`boris-ignatievich`/`shef`,
`anton`/`anton-gorodetsky`, `egor`/`yegor`, `tigrenok`/`tigerlet`,
`olga`/`olya`, `svet`/`svetlana`/`svetlana-nazarova`. This is *also* the source
of the residual attribution slips — e.g. the young vampire "юноша" has **no
roster character**, so his lines (`— Сильнее`) land on `egor`/`yegor`. No
prompt or model fixes a missing roster entry.

### Defect 2 — `unknown-male/female` fold never ran + is English-only

`foldMinorCast` (`server/src/analyzer/fold-minor-cast.ts`) runs **post-stage-2**
(needs line counts; main call `analysis.ts:~3787`). Stage-2 failed (Defect 3) →
the fold never ran → **buckets never created** (as observed). And it's
English-only: `GENERIC_ROLE_TAIL` can't catch девушка/парень/Депутат/Следователь;
`makeBucket` hardcodes English names; and the **canonicalizer invariant**
(`fold-minor-cast.ts:368-373`) *re-stamps* `name:'Unknown male'/'Unknown female'`
on every fold pass — so localizing `makeBucket` alone is a no-op unless the
canonicalizer is localized too (it has no `language` in scope today).

---

## Empirical findings (this is the new core — measured on the failing section)

Same section (7576 chars / 1095 words), production-shaped inbox, real 43-char
roster, `think:false`, `num_ctx 32768`, RTX 4070 (8 GB).

**Prompt guards are the biggest quality lever** (Russian narration rule +
dash-tag splitting, injected into the system instruction):

| | Gemma e4b, **no guards** | Gemma e4b, **+ guards** |
|---|---|---|
| narrator ratio | 67% | **88%** |
| Narration-about-Egor correct | ❌ many → `egor` | ✅ **9/10** (one `[11]` straggler) |
| Dialogue tags → narrator | ❌ → speaker | ✅ mostly |
| Completes / deterministic | ✅ | ✅ |

Guards are **model-specific**: they sharply help Gemma; they *regressed* Qwen
(53% narrator — Qwen keys on the many mid-sentence dashes in Russian prose).

**Model comparison (with guards, correctness + speed):**

| Model | gen tok/s | prefill | quality | verdict |
|---|---|---|---|---|
| **gemma e4b UD-Q4** (`gemma4-e4b-8gb`) | **~56** | <2 s | 88% narr, `[11]` stray | ✅ **production pick** |
| gemma e4b UD-Q5 (`gemma4-e4b-q5`) | ~52 | low | 83–86% narr, `[11]` stray | ≈ Q4, no gain — skip |
| gemma 12B (`gemma4-12b-8gb`) | **~7** | **~50 s** | 91% narr, `[11]` fixed | ❌ ~24 h/book, 16k didn't help |
| qwen3.5:9b | ~22–26 | — | 85% narr *when it completes* (~⅓) | ❌ unreliable; guards hurt it |
| qwen3.5:4b | — | — | unparseable JSON | ❌ |

**Conclusions:** (1) `gemma4-e4b` **UD-Q4** + guards is the sweet spot — fast,
fits, reliable, good quality. (2) Climbing quant (Q5) or size (12B) yields no
usable gain — Q5 ≈ Q4, the 12B is fatally slow on an 8 GB card (compute/bandwidth
bound; KV reduction to 16k did not help). (3) Residual errors (`[11]`
action-narration, the missing "юноша") are **prompt + roster**, not model
fidelity. (4) **Wall-clock is a real constraint**: even the fast e4b is ~158 s
per ~9k-char section → **~3 h for this ~72-section book.** The 12B would be
~24 h. This bounds any model choice.

---

## The plan

TDD throughout (CLAUDE.md): each behaviour ships a paired test; each fix a
regression test that fails before. Implementation branches off `main` (the
current `fix/server-gpu-eviction-…` branch holds unrelated work).

### Wave A — Russian attribution prompt guards (the validated quality fix) — IMPLEMENTED

**Status: shipped.** Implemented as a deterministic post-model heuristic plus a
preamble guard, rather than guard-text-only:

1. **Narrator-default heuristic** (`server/src/analyzer/narrator-default.ts`,
   wired into `attributeChapterStage2` in `server/src/routes/analysis.ts`, gated
   on `isNonEnglish(language)`): after stage-2 returns, every NON-spoken sentence
   is forced to `narrator`. Mechanically catches third-person narration labelled
   as a character (`Егор засунул руки в карманы` → `narrator`) without trusting
   the model. Runs after coverage (which keys on text, not `characterId`), so the
   verdict is unchanged; English is a byte-identical no-op. Empirically (the
   model's narration correctness 0–1/6 → a deterministic 6/6 every run, dialogue
   untouched). See [162](162-fs2-multilanguage.md) for the full write-up.
2. **Russian dash-dialogue tag guard** in `languagePreamble`
   (`server/src/analyzer/gemini.ts`): the one class the heuristic deliberately
   leaves to the model is the dashed narrative TAG (`— сказал юноша`,
   `— Девушка улыбнулась`), which looks spoken — the Russian preamble now tells
   the model that such a line is the narrator, only the spoken words → the
   speaker.

- **Tests:** `server/src/analyzer/narrator-default.test.ts` (pure unit:
  `isSpokenLine`, `forceNarratorOnNonSpokenLines`, `applyNonEnglishNarratorDefault`,
  + the `foldMinorCast` interaction); `server/src/analyzer/gemini.test.ts`
  (dash-tag guard present for `ru`, absent for `en`/absent).
- **Known limitation:** a genuine spoken line with no leading dash/quote and no
  quoted span would be wrongly forced to `narrator` (model-marker-preservation
  dependency). The deterministic narration rule from the original guard-text plan
  (heavy stage-2-only guard block threading the stage through `languagePreamble`)
  was superseded by the code-side heuristic, which is more reliable; untagged
  dashed-line speaker-continuation remains a model-only concern (Wave C roster).

### Wave B — language-aware local default model for non-English  *(reconciled with PR #851)*

**Reconciliation (2026-06-16):** a concurrent effort — **PR #851 `feat/dynamic-analyzer-models` (OPEN, also tagged "plan 221 Part A")** — overlaps this wave and **subsumes its selection mechanics**. #851 ships: analyzer-model pickers rendering the UNION of curated `MODEL_OPTIONS` + **live Ollama tags** (so a pulled `…gemma-4-E4B-it-GGUF:UD-Q4_K_XL` is selectable with no code change), `pullable` models from the server `DEFAULT_ALLOWED_MODELS` install list, a list-independent `engineForModelId()` `:`-heuristic (GPU-contention guard fires for uncurated tags), and the `ANALYZER_KEEP_ALIVE` knob (default `'5m'`). So **"add gemma to the list" / "make it selectable + pullable" / engine-classification / keep-alive are DONE by #851** — do NOT re-implement them here.

Also note the residency landscape changed: **plan 222 / #840** shipped a GPU-residency system on main (`withGpuLoad` + `residency.ts` + `vram-state.ts`, `keepAliveFor(model, accelerator)`, extended `RESIDENT_MODELS`); the measured-VRAM eviction half is **deferred to #845 / fs-45**. Wave B must layer on #840's residency, not fight it.

**What remains UNIQUE to Wave B (the actual deliverable): an ADMIN-SELECTABLE default analyzer model — NO hardcoded model choices.** #851 is per-run user selection; nothing yet lets the operator set the *default*. The hard requirement (user-stated, critical): **the default model must be selectable in Admin; do NOT hardcode any model (no `isNonEnglish → gemma4-e4b` code rule, no baked tag).** Code provides plumbing + the picker; the *choice* lives in settings.

1. **Admin-settable default(s):** surface the default analyzer model in the **Admin** UI using #851's picker (the union of curated `MODEL_OPTIONS` + live Ollama tags), persisted to user-settings. Support **per-language defaults** (e.g. an admin sets the default model for `ru`, separately from the global/English default) so a Russian book can default to a Cyrillic-robust model **because the admin chose it**, not because code hardwired it. Absent an admin choice for a language, fall through to the existing global default. No language→model mapping in code.
2. **Resolution order (all data-driven):** explicit per-run pick (#851) → admin per-language default (settings) → admin global default (settings) → existing `DEFAULT_OLLAMA_MODEL`/`OLLAMA_MODEL` fallback. Nothing in this chain is a hardcoded model literal beyond the pre-existing `DEFAULT_OLLAMA_MODEL` last-resort.
3. **Install presence:** `gemma4-e4b` must be *pullable/selectable* in Admin (it already is via #851's live-tags ∪ `DEFAULT_ALLOWED_MODELS`). Confirm the canonical tag is in the install allowlist so the admin can pick it without hunting — but it is offered, never auto-selected.
4. **Residency + fallback:** whatever model the admin selects is kept warm via #840's `keepAliveFor`/`RESIDENT_MODELS` (reconcile with #840; do NOT touch the #845-deferred measured-eviction). If an admin-chosen default isn't installed, fall back to the existing default + an actionable "pull <tag>" diagnostic (reuse #851's `pullable` surface). Never hard-fail.

- **Recommendation lives in DOCS/Help, not code:** the Help/troubleshooting copy *recommends* a Cyrillic-robust model (e.g. gemma4-e4b) for non-English and notes the qwen collapse — but the operator makes the call in Admin.
- **Depends on #851 merging first** (builds on its picker + `engineForModelId` + keep-alive knob). **Interim path until Wave B:** in Admin/the picker, pull `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` and select it (post-#851), or set `OLLAMA_MODEL` — then re-run the Russian analysis (Wave A's heuristic applies to the completed output).
- **Tests:** unit on the data-driven resolution order (admin per-language default wins over global; explicit per-run pick wins over both; unset → existing fallback; **no test encodes a language→model constant**); admin persistence round-trip; model-missing fallback path.

> **⚠ Adversarial review corrections (2026-06-17) — apply before coding:**
> - **Wave B:** the default-model setting lives in **`src/components/model-settings-form.tsx` (Account view)**, already wired to #851's picker (`buildModelOptionGroups`/`AnalysisModelPicker`) — NOT `src/views/admin.tsx` (a diagnostics console with no settings write-path). Structural prerequisite: `selectAnalyzerForPhase` (analysis.ts:1978/4195) runs **before** `bookLanguage` is resolved (2113/4275) — must hoist `resolveBookLanguageForManuscript` ahead of selection in both route entrypoints and add a `language?` param. Per-language default = real schema+precedence surface (interacts with `analyzerPhase{0,1}Model`); **v1 = single admin-settable global default** unless per-language is explicitly wanted. "No hardcoding" = no *language→model* code rule; pre-existing engine literals (`DEFAULT_OLLAMA_MODEL`, Gemini-fallback id, factory default) stay.
> - **Wave C: RE-MEASURE on current `main` FIRST.** The duplicate set in Defect 1 below is **pre-219** (transliteration removed in 219; ids are now Cyrillic via `unicodeKebab`; roster threaded into later chunks). The real residual must be re-collected before designing the tiering. Use `normaliseNameKey` (`safe-id.ts:76`), not `normaliseForMatch` (no combining-mark stripping). Run the fuzzy merge **once at finalisation** (analysis.ts:~3795), NOT inside the per-rebuild `mergeRosterChapter` (order-sensitive live-SSE path — keep that exact-id). **Tier-1 (exact normalized-name) only for v1** — Russian patronymic/surname token-sharing makes Tier-2 false-merge-prone (219 notes the 4B smears surnames). Russian `DIALOGUE_VERBS` extension needs the `.mjs` drift-copy + verb-initial word-order pattern, and may be redundant with Wave A.
> - **Wave D:** thread `language` through `previewFoldForLiveView` AND the exported `buildInterimCast` (signature change + 6 preview call sites) or live/interim buckets show English then flip; `cast-merge.ts:84` `makeBucket` has no book language in scope — resolve it from the book record. Russian descriptor detection (`isDescriptorName`) is English-structured (no "the", inflection) → partial coverage for v1, state the limitation.

### Wave C — name/alias-aware cross-chapter merge (Defect 1) — ✅ RE-OPENED + SHIPPED 2026-06-20 (branch `fix/server-ru-cast-dedup-and-tone`)

> **The "OBSOLETE" verdict below was a FALSE NEGATIVE.** It rested on one stochastic
> gemma4-e4b probe run that happened to emit consistent Cyrillic ids. A real
> full-book run on the SAME model drifts: 2026-06-20 the user's persisted `cast.json`
> showed duplicate pairs, each a byte-identical display name with one Cyrillic-kebab
> id + one Latin-transliterated id (`ольга`/`olga`, `ilya`/`илья`, `semen`/`семен`,
> `тигренок`/`tigrenok`). Root cause is model-INDEPENDENT: the analyzer's emitted
> character `id` is trusted verbatim and `mergeRosterChapter` merges by exact id only.
> **Shipped fix** (subagent-driven TDD, 12 tasks, 3× adversarially reviewed spec +
> opus whole-branch review): a finalization `dedupeRosterByName` pass — **Tier-1**
> exact normalized-name auto-merge (gender-gated, narrator-safe, canonical id =
> `safeId(name)`); **Tier-2a** full-vs-short token-subset auto-merge (single-superset
> gate); **Tier-2b** diminutive → SUGGESTION only (sibling `cast-merge-suggestions.json`
> + list/accept/dismiss routes + cast-review cards) — with a `kind:'dedup'` journal,
> sentence-id rewrite + transitive `composeRewrites`, and a voiceState-ranked
> `applyRewriteToPriorCast` so designed voices follow `olga→ольга` (the carry-forward
> BLOCKER). Tone-0% (the other defect) fixed via two-schema `runStage` +
> `fillToneFromAttributes`. Design+plan: `docs/superpowers/{specs,plans}/2026-06-20-russian-cast-dedup-and-tone*`.
> Follow-ups: srv-44 [#960](https://github.com/dudarenok-maker/Castwright/issues/960),
> srv-45 [#961](https://github.com/dudarenok-maker/Castwright/issues/961).

_Obsolete-verdict evidence retained for history:_

**Re-measured 2026-06-17 on current `main` (real Phase-0, all 9 chapters, gemma4-e4b): 17 distinct characters, ZERO same-person duplicate groups.** Plan 219 (transliteration removed → Cyrillic `unicodeKebab` ids + accumulated roster threaded into each chapter's detection prompt) already deduplicates the cast. The 43-character pre-219 duplicate set (egor/yegor, boris-ignatyevich/boris-ignatievich/shef, anton/anton-gorodetsky…) no longer occurs — a single `anton` ("Антон Сергеевич Городецкий"), single `egor`, single `boris-ignatiyevich`, etc. **Do NOT build the cross-chapter fuzzy merge — it would solve an already-fixed problem** (the adversarial-review BLOCKER on this was confirmed). Residuals (NOT dedup; possible small follow-ups): stage-1 occasionally emits schema-invalid JSON on a chapter (bare probe lost ch1/ch7; the real `runStage1WithRosterGuard` + parse-retry likely recovers); cosmetic id↔name model quirks.

_Original (obsolete) design retained for history:_

Add a name/alias fallback to `mergeRosterChapter` when exact-id misses. Tiered:
(1) exact normalized-name/alias match → merge (safe; kills the
`boris-ignatyevich`≡`boris-ignatievich`, `egor`≡`yegor`, `tigrenok`≡`tigerlet`
duplicates); (2) high token-overlap → merge with a single-dominant-candidate +
high-floor guard (`Антон`/`Антон Городецкий`); (3) diminutives/epithets
(`Оля`/`Ольга`, `шеф`) → manual UI for v1. Reuse `text-match.ts`
(`normaliseForMatch`/`nameTokens`/`jaccard`) and export/reimplement
`exactNameOverlap` (currently private in `voice-match.ts`).

- **Scope caveat:** `mergeRosterChapter` returns `void`, has no sentence access,
  and is called from 5+ sites incl. intra-chapter chunk union (first-wins) —
  so a sentence-`characterId` rewrite must be threaded out as a rewrite-table
  (parallel to `foldMinorCast.rewrites`), and the fuzzy match must be
  order-deterministic. This is a structural change, not a one-line fallback.
- **Tests:** unit fixtures — identical-name/drifted-id merge; token-overlap
  merge; **non-merge** of two distinct same-token names; gender-disagreement
  (`tigrenok`/`tigerlet`) without corrupting gender; chunk-union determinism.

### Wave D — localized minor-cast fold (Defect 2)

Thread `language` into `foldMinorCast` → `makeBucket` **and** the canonicalizer
(`:368-373`); Russian → **Незнакомый Парень** / **Незнакомая Девушка**. Make
`isDescriptorName`/`GENERIC_ROLE_TAIL` language-keyed (add девушка/парень/
мужчина/женщина/незнакомец/незнакомка/человек/голос). Localize `cast-merge.ts`
manual-downgrade `makeBucket` call too.

- **Tests:** `makeBucket('ru')` names survive the canonicalizer; Russian
  `isDescriptorName` positives/negatives; fold threads language.

### Wave E — Russian cast-field under-population (tone + localization + same-id aliases) — IMPLEMENTED

**Status: implemented** (`fix/server-ru-cast-tone-localization-aliases`). A separate
defect from the attribution ones above, found 2026-06-19 on the same _Ночной дозор_
book: cast **metadata** comes back under-populated even when attribution completes.

**Root cause (measured on the persisted analysis cache + a live gemma4-e4b probe).**
Across **188 raw per-chapter character emissions**, gemma4-e4b emitted `gender` and
`ageRange` **100%** but `tone` **0%** and `aliases` **0%**. The per-chapter detection
skill says _"`tone`: Skip a field rather than guess"_, so the model takes the skip
option for every character on Russian → the drawer falls back to a neutral 50/50/50/50
(`profile-drawer.tsx:213`). Role/description came back in mixed English/Russian
(the skill's English JSON example leaks; the preamble never told it to localize).
Alias forms (Антон / Антон Городецкий) were never captured: the model reuses the
short name under one id, and `mergeRosterChapter` (`analysis.ts`) **dropped** any
divergent same-id name form instead of recording it.

**Fix (two surgical changes, both TDD'd):**

1. **`languagePreamble` cast-field guard** (`gemini.ts`, reaches the local path via
   `ollama.ts:305`): for any non-English manuscript, instruct the model to ALWAYS
   emit `tone`, and to write `role`/`description`/`attributes` (incl. the narrator)
   in the manuscript's language. Phrased "when you output a character" so it is a
   no-op for the stage-2 attribution pass. **Live-validated: tone 0% → 100%, role +
   description returned in Russian** on gemma4-e4b. English is byte-identical (empty
   preamble). Tests: `gemini.test.ts` "Russian cast-field guards".
2. **Same-id alias capture in `mergeRosterChapter`** (`analysis.ts`): a divergent
   name form for the same id (plus any incoming `aliases`) is appended to `aliases`
   (case-insensitive dedup, never the display name) instead of dropped — runs at the
   Phase-1 finalisation rebuild. Tests: `analysis.test.ts` "mergeRosterChapter".

**Deliberately NOT done (evidence-backed decisions):**
- **No deterministic attribute→tone fill** — the prompt nudge already hits 100%, and
  a fill keyed on attributes would be fragile once attributes are localized.
- **No prompt `aliases` nudge** — the model ignored an explicit alias instruction in
  both live probes (0% compliance).
- **No automatic cross-id fuzzy fold** (`anton`≡`anton-gorodetsky`). On this book the
  full name was mis-attributed once to the **narrator's id** (12k lines); a name-based
  fold would merge the narrator into Anton. Cross-id same-person linking stays a
  **manual merge at cast review** (which already records aliases) — confirming Wave C's
  obsolete/risky verdict. Re-confirms: exact-name Tier-1 wouldn't catch full-vs-short anyway.

- **Acceptance:** full re-analysis of _Ночной дозор_ on local gemma4-e4b → cast carries
  Russian role/description + populated tone; same-id name drift surfaces as aliases.

### Wave F — Russian descriptor-phrase fold (closes the Wave D `isDescriptorName` limitation) — IMPLEMENTED

**Status: implemented** (`fix/server-ru-descriptor-fold-phrases`, #938-adjacent). Wave D
flagged its own gap: Russian `isDescriptorName` was "English-structured… partial coverage
for v1." Observed live on _Ночной дозор_ (2026-06-19): the model names nameless background
speakers with multi-word **descriptive phrases** ("женщина с двумя овчарками на поводке",
"молодой в яркой оранжевой куртке", "женщина — с сонным малышом") that the bare-single-noun
rule missed, so they leaked into the live cast instead of folding.

**Fix (safe-tier widening of `isDescriptorName`, Russian path only — TDD'd):**

1. A multi-word phrase carrying a standalone **function-word** token (preposition/conjunction:
   `с/во/в/на/у/из/к/и…`, see `RU_FUNCTION_WORDS`) is a description, not a proper name — a real
   Russian name (first · patronymic · surname · diminutive) structurally never contains one.
   Near-zero false-positive risk. Leading/trailing dashes are stripped per token so a "Имя — с …"
   dash beat tokenises cleanly.
2. Bare occupational role nouns added to `GENERIC_ROLE_RU`: `оператор`, `водитель`.

**Deliberately NOT done (precision over recall — the #938 lesson):** no "`<adjective> <role-noun>`"
rule, so "Тёмный маг" is **not** folded by name (it can be a meaningful faction role); it falls to
the post-stage-2 line-count fold if genuinely minor (<3 lines). The guard tests assert Антон /
Антон Городецкий / Сергей Лукьяненко / Борис Игнатьевич / Светлана Назарова / Завулон never fold;
the widening is Russian-only (no effect under `en`/undefined).

**Not addressed here (separate, bug #938):** the byline **author** (`Сергей Лукьяненко`) being
rostered as a speaking character and absorbing the protagonist's dialogue — a roster-inclusion /
attribution defect, not a fold gap. Tracked for a dedicated brainstorm.

- **Tests:** `fold-minor-cast.test.ts` "Wave E — Russian descriptor phrases (safe tier)" (function-word
  phrases, bare role nouns, the proper-name guard, the adjective+role-noun exclusion, Russian-only
  scoping, and a `foldMinorCast` integration that folds a 6-line phrase descriptor while keeping a
  4-line Anton).

### Cross-cutting — reliable completion + wall-clock

- **Perturbed retry (required, not optional):** on a coverage failure, retry
  with a perturbation chosen *empirically* — grammar-off is the lever that
  helped (temperature-up made it worse). Bounds the all-fail probability for any
  model. Extend `runStage2WithCoverageGuard`.
- **Wall-clock:** measure full-chapter (all 13 sections of ch1) end-to-end with
  the chosen model; confirm full-book time against an acceptable target before
  declaring done.

---

## Open questions

1. **Local non-English default = `gemma4-e4b` UD-Q4** — confirm the canonical
   Ollama tag to ship (the tuned `gemma4-e4b-8gb` vs an upstream tag).
2. **Wave C aggressiveness** — Tier 1 (exact-name, safe) only, or +Tier 2
   (token-overlap)?
3. **How does gemma reach installs** — Model Manager auto-fetch, installer
   bundle, or documented manual pull (with qwen fallback) for now?
4. **Cloud-gemini on Russian untested** — the shipped default (cloud
   `gemini-3.1-flash-lite`) was never run on this book; if cloud handles Russian
   well, the local fix is the only gap. Worth one confirmation run.

## Out of scope (v1)

- Automatic diminutive/epithet merging (Оля/Ольга, шеф) — manual UI.
- CJK / non-Russian tuning (no data; no claims).
- Chunker / coverage thresholds (187) — unchanged.
- Quant above UD-Q4 / models larger than e4b — measured, no usable gain on 8 GB.
