---
title: 'Dialogue-structure attribution — deterministic evidence engine, derived confidence, targeted escalation'
status: active
date: 2026-07-09
related:
  - 2026-06-23-fs58-llm-script-review-design.md (script review — the QA gate this spec feeds evidence into)
  - 2026-07-09-script-review-persistence-design.md (concurrent thread; owns persistence/UI guardrails — this spec deliberately does not touch them)
  - ../plans/2026-06-16-russian-attribution-narrator-heuristic.md (plan 221 Wave A — the narrator-default heuristic this spec generalizes and absorbs)
---

# Dialogue-structure attribution — deterministic evidence engine, derived confidence, targeted escalation

## 1. Problem

Full-book analysis of Russian titles (measured on _Ночной дозор_, 9 chapters, 14,065 sentences,
analyzed 2026-07-06 on local `gemma4-e4b-8gb`) produces attribution the user cannot realistically
repair by hand:

1. **Dialogue is under-attributed.** Real spoken lines land on `narrator` or on the
   `unknown-male`/`unknown-female` buckets instead of the character who said them. This cascades:
   under-counted characters look "minor", `foldMinorCast` folds them, and yet more of their lines land
   on the buckets. The user manually reassigned ~150 sentences across five chapters in one session and
   gave up — the error count is far higher.
2. **The low-confidence triage surface never fires.** Every one of the 14,065 sentences carries
   model-self-reported confidence ≥ 0.8 (histogram: 0.8×1708, 0.9×6189, 1.0×6168). The manuscript
   view flags `confidence < 0.75`, so **zero** sentences were flagged despite heaps of genuine
   ambiguity. The stage-2 skill already contains a detailed calibration rubric, including an explicit
   anti-clustering instruction — the local model ignores it wholesale. Prompt-level calibration is a
   proven dead end on small local models (same lesson as plan 221: prompt guards could not stabilize
   attribution either).

The June 2026 investigation (plan 221 / memory `project_russian_stage2_attribution_underproduction`)
already established the durable lesson this spec builds on: **anything that must be reliable has to be
deterministic code, not a prompt instruction.** Its Wave A shipped exactly one such rule
(`applyNarratorDefault`: non-spoken sentence → narrator) and it worked. This spec extends that
strategy from one rule to a full structural evidence engine.

Cloud rerouting is not a fix: Gemini-branded cloud models refuse or truncate copyrighted book text
(RECITATION blocks). Cloud **Gemma** models have a lower protection threshold and remain usable as an
_optional targeted_ escalation on short windows (§6), but the backbone must be local and deterministic.

## 2. Goals

- **Improve attribution for every supported language** (en, ru, es, fr, de — the fs-41/fs-50 set),
  via one shared engine + per-language convention tables. Russian is the acceptance case because it
  is the worst today, not the scope.
- Recover the dominant error class: spoken lines mis-attributed to `narrator` or unknown-buckets when
  the text itself names the speaker (dialogue tags) or the conversation structure implies them
  (two-party alternation).
- Replace model-self-reported sentence confidence with **derived confidence** computed in code from
  observable signals, so the existing `< 0.75` triage UI (pills, J/K navigator, per-chapter amber
  badges) starts flagging what is actually uncertain. No frontend changes: the fix is honest values
  flowing through existing plumbing.
- Correct only what the evidence proves; flag what it cannot. Ambiguity becomes a visible,
  bounded triage queue instead of silent errors.
- Give the script-review QA gate (fs-58) the same structural evidence so its `reattribute` ops are
  grounded in text mechanics rather than model intuition.
- Longer analysis wall-clock is acceptable (user-stated); it trades directly against manual fixing
  time. The deterministic passes add ~zero model time; the default-on local escalation (§6) spends
  bounded extra hours.

## 3. Non-goals

- **No persistence or results-UI work.** The script-review persistence spec
  (`2026-07-09-script-review-persistence-design.md`, concurrent thread) owns that; this spec only
  changes _what gets computed_, never how it is stored or displayed.
- **No frontend changes.** The low-confidence UI, thresholds, and navigation stay as-is.
- **No new cast-dedup logic.** Roster id canonicalization shipped (PR #962); out of scope.
- **No full multi-party dialogue disambiguation.** When neither a tag nor clean alternation proves
  the speaker, the sentence is flagged (and optionally escalated), not guessed harder.
- **No per-model prompt tuning.** The engine must be model-independent (June lesson: verdicts tuned
  on one model do not transfer).
- **No new analyzer model requirements.** Everything works with the currently configured analyzer;
  cloud escalation is optional and off by default.

## 4. Architecture

One new pure-code module family `server/src/analyzer/dialogue-structure/` with three units, wired
into two existing seams.

```
chapter.body (raw, paragraphs intact)     stage-1 roster (id/name/aliases/gender)
        │                                        │
        ▼                                        ▼
①  STRUCTURE PARSER (pure, per-language convention table)
        │   → StructuralEvidence per paragraph/span
        ▼
②  CROSS-EXAMINER (pure)
        │   aligns model sentences ↔ evidence; corrects / confirms / flags;
        │   derives ALL confidence values
        ▼
③  ESCALATION SELECTOR + RUNNER (optional, model-calling)
        │   flagged sentences → conversation windows → focused re-query
        ▼
   final sentences → coverage-verdict unchanged → fold / reconcile / persist
```

**Placement.** ① + ② replace the `applyNarratorDefault(result.sentences)` call inside
`attributeChapterStage2` (`server/src/routes/analysis.ts:1576`) — same position: after the coverage
verdict (coverage keys on text, not characterId, so it is unaffected), upstream of fold/reconcile so
corrected line counts reach `foldMinorCast` and break the minor-character cascade. The Wave A
narrator-default rule is absorbed into ② as one rule among several (behaviour preserved, plus a new
structural exemption — §5.3). ③ runs per chapter after ②, inside the same function, budget-capped.
Both stage-2 call sites (main analysis and the chapter-subset retry route) flow through
`attributeChapterStage2`, so both get the engine for free.

**Language reaches the seam** through the channel that already exists: both call sites already pass
the resolved book language on the stage call (`opts.stageCall.language` — analysis.ts:3614 main,
:4900 subset). No new opts field. An unknown/unsupported language yields an empty convention table:
the parser emits no evidence, the cross-examiner falls back to exactly today's behaviour
(narrator-default only, model confidence passed through). Behaviour for unsupported languages is
byte-identical to current.

## 5. Components

### 5.1 Structure parser (①)

Input: `chapter.body` (raw text, paragraph = line, as produced by the EPUB/MD parsers), the stage-1
roster, and a `LanguageConventions` table. Output: `StructuralEvidence[]` — one entry per paragraph,
with sub-spans.

`LanguageConventions` (data, not code — one file per language under `dialogue-structure/lang/`):

| Field | ru | en | es | fr | de |
|---|---|---|---|---|---|
| dialogue-open markers (paragraph start) | `—` `–` `-` `&mdash;` | `"` `“` | `—` (raya) | `—` after `«…»` blocks; guillemet spans | `„` `»` |
| quote pairs (embedded speech) | `«»` `„“` | `“”` `""` | `«»` `“”` | `«»` | `„“` `»«` |
| speech-verb lemmas (tag detection) | сказал/ответил/спросил/прошептал/крикнул/… | said/asked/replied/whispered/… | dijo/preguntó/respondió/susurró/… | dit/demanda/répondit/murmura/… | sagte/fragte/antwortete/flüsterte/… |
| name matcher | stem match (strip case endings: -а/-у/-ом/-е/-ой/-ей/…) | exact + possessive strip | exact | exact | exact |
| pronoun map (gendered anaphora) | он/она → gender | he/she | él/ella | il/elle | er/sie |

Per dialogue paragraph the parser segments **speech spans** from **tag/beat spans** using the
language's punctuation grammar (for dash-dialogue: `— speech, — tag. — speech.` alternation; for
quote languages: inside-quotes vs outside-quotes — the same split the stage-2 skill already asks the
model to perform, now verified in code).

**Interior-dash disambiguation (dash-dialogue languages).** Russian (and Spanish) use `—` as
ordinary punctuation too (`X — это Y`), so an interior dash is NOT treated as a speech/tag toggle by
default. Only two conservative patterns toggle, both anchored to the standard typographic
convention:

- `<speech>{,|!|?|…} — <lowercase word>` where the word matches a speech-verb stem → closes speech,
  opens a tag span.
- `<tag>{.|!|?|…} — <uppercase letter>` inside a paragraph that opened with a dialogue dash →
  closes the tag, resumes speech.

Any interior dash matching neither pattern is plain text inside the current span. When a paragraph's
dash pattern is ambiguous (e.g. a candidate tag clause with no speech-verb match), the parser does
NOT guess a split: the remainder of the paragraph is classified `unanchored` so the cross-examiner
flags rather than corrects. Mis-toggling into confident wrong corrections is the failure mode this
rule exists to prevent.

**Turns, not paragraphs.** Alternation and participant tracking operate on *turns* (one speech span
by one speaker), not paragraphs. In dash-dialogue a paragraph is usually one turn; in quote-style
prose one paragraph can contain several quoted turns with interleaved narration (the repo's own
`the-coalfall-commission.ru.md` fixture is exactly this shape), and the parser must segment
sub-paragraph turns from the quote spans. Where turn segmentation within a paragraph is uncertain,
those spans degrade to `unanchored` — same conservative rule as above.

Each speech span gets a `speakerEvidence`:

- `tag-name` — an adjacent tag span contains a speech verb + a roster name/alias match
  (via the language's name matcher). Strongest evidence.
- `tag-pronoun` — tag has speech verb + gendered pronoun; resolved against the current conversation
  window's participants when exactly one is gender-compatible. (`я` in a first-person book resolves
  to the established narrator-voice character when the roster has one — the _Night Watch_ `я`→Антон
  case.) Medium.
- `alternation` — untagged span in a two-party window whose turns alternate cleanly. Medium-weak.
- `unanchored` — speech with no structural anchor. No speaker claim; this is what gets flagged.

**Conversation windows** are contiguous runs of dialogue paragraphs (narration paragraphs shorter
than a threshold do not break a window — action beats). Participants = the set of tag-resolved
speakers in the window.

The parser is pure and deterministic: no I/O, no model calls, no language branching outside the
convention tables.

### 5.2 Sentence↔evidence alignment

Model sentences are near-verbatim copies of source text but drift on whitespace and glyphs. The
aligner walks sentences and body sequentially (two-pointer), matching on normalized text (collapse
whitespace; unify dash variants, quote glyphs, ellipses; strip the HTML dash entities the parsers can
leak). A sentence that cannot be aligned gets evidence `unaligned` — it is never corrected and keeps
pass-through confidence capped at 0.74 so it lands in the triage queue rather than silently passing.
Alignment failures are counted and logged per chapter; a chapter whose alignment rate falls below a
floor (start at 80%) disables correction for that chapter entirely (flag-only mode) — a misaligned
engine must never rewrite attributions.

### 5.3 Cross-examiner (②) — decision matrix

All confidence values below are **derived**; the model's self-reported number is discarded (kept only
in a diagnostic log line). Values are starting points, tunable in one constants block; the invariant
is the *ordering*, and that flag-worthy cases land < 0.75.

| Structural evidence | Model says | Action | Derived confidence |
|---|---|---|---|
| `tag-name` → X | X | confirm | 0.95 |
| `tag-name` → X | anything else (narrator, unknown-bucket, other char) | **auto-correct to X**, record machine-readable reason | 0.9 |
| tag/beat span itself | any character | demote to narrator (Wave A rule, kept) | 0.9 |
| `tag-pronoun` → X | X | confirm | 0.85 |
| `tag-pronoun` → X | other | auto-correct to X only when window has a single gender-compatible participant; else keep + flag | 0.8 / 0.6 |
| `alternation` → X | X | confirm | 0.8 |
| `alternation` → X | narrator or unknown-bucket | correct to X, flag for review | 0.7 |
| `alternation` → X | other named char | keep model (it may know something structure doesn't), flag | 0.6 |
| `unanchored` speech | named char | keep, flag | 0.65 |
| `unanchored` speech | narrator or unknown-bucket | keep, flag hard (likely the dominant error class) | 0.5 |
| narration span | narrator | confirm | 0.95 |
| narration span | named char | demote to narrator (Wave A) | 0.9 (first of block ≤ 0.5 flag — kept) |
| **lumped entry** (one model entry spans BOTH a speech span and a tag/beat span) | any | keep model id, never auto-correct (a reattribute-only engine cannot un-lump; retagging the whole entry to the speaker would voice the tag words) — flag, `structureNote: 'lumped'` | 0.65 |
| `unaligned` | any | pass through, never correct | min(model, 0.74) |

Two hard invariants:

- **Continuation exemption.** A sentence inside a speech span (e.g. the second sentence of a
  multi-sentence dash-utterance, which has no leading dash of its own) is classified _speech_, not
  narration — it inherits the span's speaker/evidence and is **exempt from the narrator-default
  demotion**. This closes a self-inflicted error path in the shipped Wave A heuristic.
- **Tags outrank everything.** Nothing — not the model, not alternation, not escalation (§6) — may
  override a `tag-name` attribution.

Every correction carries a `structureNote` (machine-readable reason: rule id + evidence) logged to
the server log and counted in the run report (§7). The sentence schema is unchanged — corrections
mutate `characterId`/`confidence` only, so downstream (fold, reconcile, persistence, OpenAPI shapes)
is untouched.

### 5.4 What this does to the triage queue — MEASURED, not assumed

A sentence-level pilot of the anchoring rules was run against the real 2026-07-06 _Ночной дозор_
stage-2 output (14,065 sentences; probe scripts in session scratchpad, methodology reproduced in the
plan's acceptance baseline):

- 2,861 speech turns (dash-open, non-tag); 366 dash tag-fragments.
- **Tag/pronoun anchoring resolves 32%** (863 turns: 78 in-sentence name, 407 adjacent-fragment
  name, 433 pronoun→first-person, ~53 clean two-party parity).
- **~1,900 turns (68%) remain unanchored** at sentence granularity. Clean alternation recovers
  almost nothing on this book — first-person narration constantly interrupts conversations, so
  strict parity rarely holds.

Two consequences are baked into the design rather than hoped away:

1. **A flag-only design fails.** ~1,900 flags is as unreviewable as 0 flags. Deterministic evidence
   alone cannot get the queue to triage scale on dialogue-dense Russian prose.
2. **Escalation (§6) is therefore part of the default pipeline, not an optional extra** — default
   `'local'`, sized for ~500–600 conversation windows per book (measured: 553 runs on this book).
   The triage queue is what survives ①+②+③: tag-proven corrections never reach it, escalation
   answers land at 0.8 (unflagged), and flags are the residual the system genuinely cannot decide.

The paragraph-aware parser should beat the sentence-level pilot (paragraph adjacency is exact there,
and the pilot used a partial verb-stem list), but the design must not depend on that improvement —
it depends only on the measured floor.

## 6. Targeted escalation (③) — approach C

A second model pass over **only** what ② flagged. **Default `'local'`** — the §5.4 measurement
shows the deterministic passes alone leave an unreviewably large residue, so escalation is part of
the standard pipeline; registry setting `attributionEscalation: 'off' | 'local' | 'cloud'` (`'off'`
restores flag-only behaviour for constrained boxes). All new registry knobs added by this spec
(this one, the budgets below, and the §10 kill-switch) get rows in the wiki's Advanced-Settings
page in the delivering PR.

- **Selector:** flagged sentences (confidence ≤ 0.65 with evidence `unanchored` or contested
  `alternation`) are grouped into their conversation windows, ± up to 2 adjacent narration paragraphs
  of context, capped ~1,500 chars per window.
- **Prompt:** window text with the flagged lines marked, the window's participant candidates (plus
  roster ids), the structural annotations, and a single narrow ask: assign a `characterId` to each
  marked line. Strict small JSON output. Short focused windows are exactly the regime where even the
  small local models behave (the June collapse was long-context).
- **Routing:** `'local'` uses the configured analyzer; `'cloud'` uses the Gemini-API **Gemma** model
  (`GEMINI_MODEL` default `gemma-4-31b-it` — lower recitation-protection threshold than Gemini-branded
  models; short excerpts reduce but do not eliminate the risk on famous in-copyright books; free
  tier, 1,500 RPD, already gated by the per-model rate limiter). A failed window skips — flags stay,
  nothing is lost. **Failure detection must cover the RECITATION signature specifically: an EMPTY
  response body, not an exception** (memory `project_gemini_recitation_empty_response`), alongside
  refusals, parse failures, and timeouts.
- **Acceptance rules (code, not trust):** a proposed id is applied only if (a) it is a roster id,
  (b) it does not contradict any `tag-name` evidence, and (c) the response parses. Applied answers
  get confidence 0.8 (above flag threshold, below tag-proven). Everything else keeps its flag.
- **Budgets:** max windows per chapter and per book (registry knobs with sane defaults), per-window
  timeout. `attributeChapterStage2` is per-chapter and stateless across the chapter loop, so the
  per-book cap is a mutable budget accumulator created by the route and threaded through opts (both
  call sites). Escalation never blocks analysis completion — on budget exhaustion the remaining
  flags simply stand.
- **Acceptance never depends on CLOUD escalation.** §9's on-box acceptance runs the default
  pipeline (deterministic passes + `'local'` escalation); `'cloud'` is a quality upgrade whose
  total blockage (RECITATION on a famous in-copyright book) degrades gracefully to local behaviour,
  never a design failure. Wall-clock at default: ~550 windows × ~15–30 s local ≈ 2–5 h added on a
  _Night Watch_-scale book — acceptable per the user's stated trade (analysis time vs. manual
  fixing time), and capped by the budgets above.

## 7. Script-review integration (the QA gate)

Reuses ① verbatim; no new model passes.

- `buildScriptReviewChapterInbox` (`server/src/routes/script-review.ts`) gains an optional
  per-sentence evidence suffix, rendered **only** where structure disagrees with the current
  attribution or the line is unanchored: `[structure: speech, tag→антон]`,
  `[structure: speech, speaker unproven]`, `[structure: narration]`. A chapter with no annotations
  renders byte-identical to today (same additive pattern as the fs-64 prior-exchange block).
- `skills/audiobook-script-review.md` gains an attribution-audit section: structural annotations are
  strong hints; propose `reattribute` ops that cite them; verify speech/tag splits in dash-dialogue
  languages.
- No change to op classes, persistence, or UI — the concurrent persistence thread owns those; this
  slots in behind its API unchanged.
- **Known staleness interaction (named here so it isn't rediscovered as a bug):** this engine
  changes sentence `characterId` at analysis time, so a persisted `reattribute` finding generated
  *before* the engine ran can become redundant or unappliable when replayed against corrected
  attributions. That is ordinary finding-staleness under the persistence spec's own invalidation
  rules — expected behaviour, not data loss.

## 8. Provenance & run report

Found during this investigation: nothing records which analyzer/model produced an analysis (we could
not determine _Night Watch_'s analyzer from any artifact). Two small additive fields fix the
forensics gap and make acceptance measurable:

- `state.json` gains `analysisProvenance`: `{ engine, model, at, structureEngineVersion }` written at
  analysis completion — at **both** completion sites (the main whole-book route AND the
  chapter-subset retry route), so a partial re-analysis never leaves stale provenance (additive,
  schema-tolerant).
- The analysis completion log (and SSE stream) reports engine counters:
  `{ aligned%, confirmed, corrected, flagged, escalated, escalationAccepted }` per chapter and per
  book. This is the before/after instrument for acceptance and for the self-service-observability
  working practice.

## 9. Testing

Five-tier discipline; everything in ①/② is pure and unit-testable without models.

- **Parser fixtures per language** (vitest, colocated): ru dash-dialogue (tag before/after speech,
  mid-quote tag interruption, multi-sentence utterances, pronoun tags, `&mdash;` leakage,
  interior-punctuation dashes that must NOT toggle), en quote pairs, es raya, fr guillemets, de „…“
  — plus the existing Wave A regression suite folded in (narrator-default behaviour must survive).
  **Every ru test states which dialogue convention it targets.** The repo's existing ru fixture
  (`the-coalfall-commission.ru.md`) is guillemet-style with multi-turn paragraphs — it exercises the
  quote path, NOT the paragraph-leading dash-dialogue path the acceptance book uses. A dedicated
  Castwright-owned **dash-dialogue ru fixture** is a required deliverable; without it the
  integration test greenlights the wrong convention.
- **Name matcher:** Russian case-form matching (Антон/Антона/Антону/Антоном/Антоне), alias hits,
  no-false-positive on substrings; identity matchers for en/es/fr/de.
- **Aligner:** glyph/whitespace drift, dropped sentences, below-floor alignment → flag-only mode;
  idempotence under duplicated model spans (the stage-2 loop-and-truncate failure mode can re-emit
  spans — the aligner must not silently mis-anchor evidence when duplication stays above the
  alignment floor).
- **Cross-examiner:** the full §5.3 matrix as table-driven tests; the two invariants (continuation
  exemption; tag-name never overridden) as dedicated cases; derived-vs-model confidence replacement.
- **Escalation:** selector windowing, acceptance rules, RECITATION-skip, budget caps — mock analyzer.
- **Integration:** `attributeChapterStage2` with a mock analyzer over the Russian canonical fixture
  (`server/src/__fixtures__/the-coalfall-commission.ru.md`), asserting corrected ids + honest
  confidence reach fold/persist. The ru fixture covers ch1 only; the plan should extend it (or add a
  sibling Castwright-owned fixture) with a dialogue-dense scene per error class — never copyrighted
  text in the repo.
- **On-box acceptance (manual, owed after ship):** re-analyze _Ночной дозор_ on the default
  pipeline (structure engine on, `'local'` escalation); success =
  (a) flagged sentences land at triage scale — target ≤ ~500 (measured baseline: 0 flagged today,
  ~1,900 structurally unanchored speech turns, §5.4) — concentrated on genuinely ambiguous lines;
  (b) the hard-error class (structure-says-speech attributed to narrator/unknown-bucket) drops to
  near-zero after correction + escalation, from a 2026-07-06 baseline of ~859 dash-speech-on-narrator
  sentences (probe methodology in the plan);
  (c) named-character line counts rise / unknown-bucket share falls;
  (d) a spot-check of chapters 1 and 9 (the most hand-corrected) shows the manual-fix rate per
  chapter dropping to triage-queue scale.

## 10. Risks & mitigations

- **Parser wrong on real-world formatting** (EPUB quirks, mixed conventions) → alignment floor +
  flag-only fallback per chapter (§5.2); corrections are logged with reasons; the whole engine sits
  behind one registry kill-switch (`structureEngine: on/off`, default on) so a bad interaction
  degrades to today's behaviour, not worse.
- **Morphology false positives** (a name stem matching an unrelated word) → stems must match a
  roster name/alias token with a minimum stem length; tag must also contain a speech verb; tested
  per language.
- **Escalation model misbehaving** → acceptance rules are code-side (§6); worst case = flags remain.
- **Wall-clock** → ①/② are string processing (milliseconds per chapter); ③ is budget-capped and
  can be turned off entirely (`attributionEscalation: 'off'`).
- **Scope creep toward NLP** — the parser handles the _mechanical_ conventions only; anything needing
  semantics stays with the model or the flag queue. YAGNI applies to additional evidence types until
  the run report shows they would pay.
