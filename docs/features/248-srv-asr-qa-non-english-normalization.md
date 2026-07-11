---
status: active
shipped: null
owner: null
---

# 248 — srv: ASR content-QA non-English normalization (#1084)

> Status: active (deterministic engineering half shipped; on-box calibration follow-up #1527 open)
> Key files: `server/src/tts/asr-language-normalization.ts` (new),
> `server/src/tts/segment-asr-qa.ts` (`normalizeForWer`), `server/src/config/registry.ts`
> (`qa.asr.maxWer.{fr,de}`), `server/src/tts/segment-asr-qa.test.ts`
> URL surface: none (server-only, no frontend change)
> OpenAPI ops: none

Design of record for the deterministic engineering half of #1084 — the on-box
calibration half is explicitly out of scope (see below) and tracked as a
separate follow-up filed at implementation-PR time.

Spec: [`docs/superpowers/specs/2026-07-10-srv-asr-qa-non-english-normalization-design.md`](../superpowers/specs/2026-07-10-srv-asr-qa-non-english-normalization-design.md)
(2 rounds of Opus-tier `assumption-checker` review — round 1 caught a Critical
French-numeral-grammar error and a data/closure layering defect, both fixed
and independently re-verified in round 2).
Plan: [`docs/superpowers/plans/2026-07-10-srv-asr-qa-non-english-normalization.md`](../superpowers/plans/2026-07-10-srv-asr-qa-non-english-normalization.md)
(8-task bite-sized breakdown, TDD steps, ready for `subagent-driven-development`
or `executing-plans`).

## Benefit / Rationale

- **User:** Non-English books (es/fr/de/ru) get a real ASR content-QA gate
  instead of one whose normalization only ever accounted for English —
  spoken numbers and German prepositional contractions stop reading as
  content errors they aren't, on the same footing the gate has given English
  books since srv-31.
- **Technical:** Closes the gap plan 186 flagged as owed ("Russian/etc.
  accuracy is owed validation") for the normalization half; the per-language
  `maxWer` override scaffold (`.es`/`.ru`, landed at `3a56bf74`) is completed
  to all four supported non-English languages and its architecture is now an
  explicit, documented decision rather than an implicit side-effect.
- **Architectural:** Establishes `server/src/tts/asr-language-normalization.ts`
  as a new, purely-declarative per-language data module scoped to the
  ASR-QA concern specifically — deliberately kept separate from
  `language-registry.ts` (which serves heading/front-matter parsing) after
  adversarial review flagged that coupling the two would mix unrelated
  concerns into one interface.

## Architectural impact

- **New seams / extension points:** `WER_INTEGERS`/`WER_CONTRACTIONS` exports
  from the new module; two new registry knobs (`qa.asr.maxWer.fr`/`.de`)
  completing the existing per-language-override pattern.
- **Invariants preserved:** English's `normalizeForWer` path (`ONES`, `TENS`,
  `CONTRACTIONS`, `spellInteger`) stays byte-for-byte unchanged — see
  "Invariants to preserve" below. `qa.asr.enabled` (`SEG_ASR_ENABLED`) stays
  default-off.
- **Migration story:** none — every change is additive (new module, new
  registry knobs default to the existing global `0.4`, `normalizeForWer`'s
  non-English branch only changes behavior for es/fr/de/ru, which previously
  no-op'd on digits/contractions).
- **Reversibility:** the new registry knobs are per-language overrides on top
  of the existing global `qa.asr.maxWer`; reverting is a knob change, not a
  code rollback. The normalization change itself is bounded to
  `normalizeForWer`'s non-English branch and can be reverted by restoring the
  prior no-op behavior if the calibration follow-up finds it net-harmful for
  a given language.

## Invariants to preserve

- English's `if (english)` branch in `normalizeForWer`
  (`server/src/tts/segment-asr-qa.ts`) — contraction expansion via
  `CONTRACTIONS`, then `spellInteger` — must stay byte-for-byte unchanged.
  Any diff to that branch in the implementing PR is a regression, not a fix.
- `WER_INTEGERS[lang]` arrays cover indices `0..99` only; a value at index
  `>= 100` is never queried — numbers that large fall through to the existing
  digit-stays-a-digit behavior (matching English's `spellInteger`, which also
  declines 3+ digit numbers).
- `qa.asr.maxWer.{fr,de}` (this plan) and the pre-existing `.es`/`.ru` all
  default to the global `qa.asr.maxWer` value (`0.4`) — none of the four
  should ship at a different value without real on-box calibration evidence
  behind it (tracked separately; see "Out of scope").

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/segment-asr-qa.test.ts`) — per-language
  `WER_INTEGERS`/`WER_CONTRACTIONS` table assertions (Tasks 1-4 of the plan,
  spot-checking the linguistically tricky boundaries: Spanish 21 vs. 31,
  French's full 70-99 base-20 table, German's 16/17 teen-root truncation and
  21 fused compound, Russian 21); `normalizeForWer` integration tests across
  all four languages plus the German contraction expansion and the es/fr/ru
  contraction no-op proof (Task 5); `classifyTranscript` faithful/drift
  coverage for es/fr/de (Task 6); a `resolveAsrThresholds`/`allKnobs()`
  plumbing test for the new `fr`/`de` knobs (Task 7).

No frontend, e2e, or sidecar surface is touched — this is a server-only,
pure-function change with no router/redux/layout seam, so no Playwright spec
is warranted per the testing-discipline bar.

### Manual acceptance walkthrough

Not applicable — no UI surface. The functional acceptance walkthrough for
this feature IS the on-box calibration follow-up (rendering real es/fr/de/ru
audio and inspecting the gate's behavior against it), which is explicitly out
of scope for this plan (see below) and tracked as its own issue.

## Out of scope

- **On-box calibration** — actually rendering audio in es/fr/de/ru,
  transcribing it, and picking real `maxWer` values from the WER
  distribution. Tracked as a follow-up issue, filed at implementation-PR
  time (plan Task 8), covering both the general threshold-tuning acceptance
  criteria and two specific residual risks this design names but doesn't
  resolve: gendered-number mismatch rates (Spanish/French "one", Russian
  "one"/"two"), Russian oblique-case numeral declension mismatch rates, and
  whether Whisper's German output actually matches the single-fused-token
  assumption for compound numbers (see the design spec's "Known residual
  risks" section for the full reasoning and existing partial mitigations).
- **Belgian/Swiss French** (`septante`/`octante`/`nonante`) — the French
  table targets standard France French only.
- **Additional German contraction forms** beyond the seven implemented
  (`im`/`zum`/`beim`/`am`/`ins`/`ans`/`vom`) — e.g. `aufs`/`fürs`/`durchs`/
  `ums`. Flagged by the second `assumption-checker` round as an unstated
  "these seven suffice" assumption; left as a known minor gap rather than
  expanded blind.
- Languages beyond the five in `language-registry.ts` (`en`/`es`/`fr`/`de`/
  `ru`) — e.g. zh/ja, which aren't in that registry at all yet (fs-59).

## Ship notes

Shipped <merge date TBD>, commit <merge commit SHA TBD>. Behaviour delta vs. spec: none —
implemented exactly as designed. Calibration remainder tracked in #1527; this plan's
own status stays `active` (not `stable`) until that follow-up closes, since #1084 itself stays
open to represent it.
