---
status: stable
shipped: null
owner: null
---

# Recover dialogue lines stage-2 stranded on the narrator (+ fold keeps tagged speakers)

> Status: active
> Key files: `server/src/analyzer/recover-tagged-lines.ts`, `server/src/analyzer/fold-minor-cast.ts`, `server/src/routes/analysis.ts`
> URL surface: indirect — Phase-1 finalisation of `POST /api/manuscripts/{id}/analysis` and `…/analysis/chapters`
> OpenAPI ops: none

## Benefit / Rationale

The plan-182 roster-coverage guard ensures a tagged speaker is in the roster, but
stage-2 attribution still sometimes leaves their *quoted lines on `narrator`*
(observed: The Drowning Bell ch16 — `"…," Behnam noted.` with the quote stuck on
narrator even though Behnam was in the cast). Those 0-line speakers were then
**deleted by the minor-cast fold** on every re-analysis (#537), so a found
character never persisted and never spoke (#529). Re-analysing via the UX
therefore did **not** recover these characters.

- **User:** re-analysing a chapter now actually attributes a prose-tagged
  speaker's lines to them (they speak), and a tagged speaker is never silently
  dropped from the cast.
- **Technical:** a deterministic post-stage-2 pass catches stage-2's "left a
  tagged line on narrator" misses; the fold no longer deletes a prose-tagged
  speaker just because stage-2 gave them 0 lines.
- **Architectural:** complements the stage-1 roster guard (gets the speaker into
  the roster) with a stage-2 attribution backstop (gets their lines).

## Architectural impact

- **New pure module** `server/src/analyzer/recover-tagged-lines.ts`:
  - `recoverTaggedNarratorLines(sentences, roster)` — for a `<Name> <speech-verb>`
    tag sentence, flips the immediately-preceding sentence to the resolved speaker
    **only when** it's currently `narrator` and `<Name>` resolves to exactly one
    rostered character (ambiguous first names / unknown names / pronouns are
    skipped). Same conservative heuristic as `recover-missing-character.mjs`;
    a correctly-attributed book is a no-op. Returns a new array (input unmutated).
  - `taggedSpeakerIds(sentences, roster)` — ids of rostered characters the prose
    tags; consumed by the fold.
- **`fold-minor-cast.ts`** — a 0-line character whose name is prose-tagged is now
  treated like the `narrator-mention` protected-role exemption: it bypasses both
  the zero-line drop AND the `<minLines` fold, keeping its own slot. Descriptors
  ("The Jogger") still fold. (#537)
- **`analysis.ts`** — both Phase-1 finalisation sites (main + subset) run
  `recoverTaggedNarratorLines(allSentences, stage1.characters)` **before**
  `foldMinorCast`, so recovered speakers have lines (and aren't dropped). Logged
  per-id. No schema change; reuses the shared `DIALOGUE_VERBS`.

## Invariants to preserve

1. Recovery only moves a line OFF `narrator` onto a rostered speaker, never
   between two real speakers, and never on an ambiguous/unknown name
   (`recover-tagged-lines.test.ts`).
2. The fold still drops genuine non-speakers (pets/0-line untagged) and still
   folds descriptor names — only prose-tagged speakers are newly protected
   (`fold-minor-cast.test.ts`).

## Test plan

### Automated coverage
- Vitest (`recover-tagged-lines.test.ts`, 10) — Behnam/ch16 regression (flip the
  narrator quote before `Behnam noted.`); first-name match; no overwrite of a
  non-narrator quote; no cross-chapter flip; unknown/ambiguous/pronoun skipped;
  no-op on a correct book; input not mutated; `taggedSpeakerIds`.
- Vitest (`fold-minor-cast.test.ts`) — a 0-line prose-tagged speaker is kept
  (#537), while untagged 0-line non-speakers still drop and descriptors still fold.
- Vitest (`analysis.test.ts`) green — both fold sites wired.

### Manual acceptance (live)
1. Re-analyse a chapter where a speaker is prose-tagged (e.g. The Drowning Bell ch16
   Behnam): the speaker ends with non-zero lines, stays in the cast, and survives
   a subsequent re-analysis of another chapter. Then design their voice + regen.

## Relationship to plan 187

Plan **187** (already on main) fixes **#528** (large-chapter stage-2 truncation,
via `stage2-chunk.ts`) and **#529** (attribution-coverage audit) — so stage-2 now
*completes* even for big chapters (e.g. ch19, 507 sentences). This plan is the
complementary piece: even when stage-2 completes, it can still strand a
prose-tagged speaker's lines on `narrator` (the ch16 Behnam case — stage-2 ran but
Behnam got 0 lines), and the fold then deletes them. 187 + this plan together make
a re-analysis fully recover such speakers *with* their lines.

## Out of scope

- Stage-2's underlying attribution quality (why it picks narrator for a clearly
  tagged quote) — this is a deterministic backstop, not a model change.

## Ship notes

Shipped 2026-06-06 (merge 1accb11, PR #557). Closes #537. Builds on plan 187
(#528/#529). Refs #519. Live acceptance confirmed: The Drowning Bell ch16 (Behnam) ends
with non-zero lines and survives a subsequent re-analysis of another chapter;
voice designed + chapter regenerated.
