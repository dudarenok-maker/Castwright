---
status: active
shipped: null
owner: null
---

# Missing-speaker roster-coverage guard (Layer 2b)

> Status: active
> Key files: `server/src/analyzer/roster-coverage.ts`, `server/src/analyzer/dialogue-verbs.ts`, `server/src/routes/analysis.ts`, `skills/audiobook-character-detection-per-chapter.md`, `scripts/audit-missing-speakers.mts`
> URL surface: indirect — Phase 0a/Phase 1 of `POST /api/manuscripts/{id}/analysis` and `…/analysis/chapters`
> OpenAPI ops: none (server-internal analyzer behaviour)

## Benefit / Rationale

The per-chapter character-detection model (Phase 0a) occasionally drops a speaker
from a chapter's roster even when the prose clearly quotes them. Stage-2
attribution is constrained to roster ids, so every line of a dropped speaker is
demoted to `narrator` — and because they end with 0 lines, the minor-cast fold
keeps them out of the cast entirely. They vanish silently.

Concrete trigger (2026-06-05): **Stellarlune ch19** ("Chapter Sixteen") —
**Prentice** speaks 12 times (`"…," Prentice repeated.`, `"Fine," Prentice
agreed.`) yet never made the cast; all his lines became narrator voiceover. A
book-wide audit found 4 more victims in the same book (ch16 Behnam, ch33 Cadence,
ch34 Woltzer, ch47 Prentice again).

- **User:** a character who speaks gets a cast slot + their own voice instead of
  being read in the narrator's voice. Existing damaged books are findable and
  repairable.
- **Technical:** a prose dialogue tag (`<Name> <speech-verb>`) is now binding at
  two layers — a strengthened prompt rule AND a deterministic code guard that
  recovers a missed speaker before stage-2 can demote them.
- **Architectural:** adds a pure, env-tunable guard module mirroring the
  `stage2-coverage.ts` (plan 181) shape — `validate*` + injected-`call` runner —
  and a single source of truth for the dialogue-verb list shared by the guard and
  the `recover-missing-character.mjs` hotfix.

## Architectural impact

- **New module** `server/src/analyzer/roster-coverage.ts` (pure; no I/O, no model
  calls — the stage-1 call is injected). `validateRosterCoverage(body, rosterNames)`
  + `runStage1WithRosterGuard({…})` (retry → auto-add) + `chapterDriftExceeded(…)`.
- **New module** `server/src/analyzer/dialogue-verbs.ts` — canonical `DIALOGUE_VERBS`.
  `scripts/recover-missing-character.mjs` keeps a literal mirror (it runs under
  plain `node`, can't import the `.ts`); a drift test
  (`scripts/tests/dialogue-verbs-drift.test.mjs`) fails if they diverge.
- **Wiring** in `server/src/routes/analysis.ts`: both stage-1 call sites (main
  Phase-0a loop + subset-retry route) are wrapped by `runStage1Guarded`, which
  validates the chapter's detected roster against its prose, retries detection
  (`STAGE1_ROSTER_RETRIES`, default 1) on a miss, then auto-adds the still-missing
  tagged speaker with a WARN + SSE log. Auto-added entries are
  `detectionSource: 'dialogue'` (a tag IS a verbatim utterance) with the recovery
  noted in `description` — **no schema change** (the closed `detectionSource`
  enum and `.strict()` `characterSchema` are preserved).
- **Secondary net** `warnPerChapterDrift` at both reconcile sites: WARN-only when a
  single chapter's narrator-demotion rate is high (closes the dilution hole where
  the book-wide `attributionDriftExceeded` 5% gate never noticed ch19's ~30
  demotions).
- **Prompt fix** (Layer 2a) in both copies of the stage-1 rules
  (`skills/audiobook-character-detection-per-chapter.md` + the inline block in
  `buildStage1ChapterInbox`): a `<Name> <speech-verb>` tag is binding.
- **Audit** `scripts/audit-missing-speakers.mts` — read-only; re-parses each EPUB
  and runs `validateRosterCoverage` per chapter against `cast.json` names+aliases.
- **Reversibility:** the guard is gated by `STAGE1_ROSTER_RETRIES` (set `0` to
  disable retries) and `ROSTER_GUARD_IGNORE_NAMES`; a false auto-add gets folded
  back out by the existing minor-cast fold if it gets 0 attributed lines.

## Invariants to preserve

1. `characterSchema` (`server/src/handoff/schemas.ts:30`) stays `.strict()` and
   `detectionSource` stays the closed enum `['dialogue','narrator-mention']` —
   auto-recovered characters use `'dialogue'`, never a new value.
2. `DIALOGUE_VERBS` in `server/src/analyzer/dialogue-verbs.ts` and the mirror in
   `scripts/recover-missing-character.mjs` are set-equal (drift test enforces).
3. `runStage1Guarded` must run BEFORE `chapterCast[ch.id] = result.characters` at
   both call sites so the recovered speaker is a valid roster id before stage-2.
4. The book-wide `attributionDriftExceeded` (`analysis.ts`) remains the only
   abort gate; `chapterDriftExceeded` is WARN-only.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/roster-coverage.test.ts`, 18 cases) —
  flags an absent tagged speaker (Prentice/ch19 regression); does NOT flag a
  rostered speaker; **matches by first name** (`"Sophie said"` ↔ `"Sophie
  Foster"` — the bug the live audit caught); last-token / title match;
  possessives + contractions ignored; pronoun openers ignored; single-hit
  quote-adjacency bound; `ROSTER_GUARD_IGNORE_NAMES`; `runStage1WithRosterGuard`
  retry-then-auto-add and `maxRetries=0`; `chapterDriftExceeded`.
- node:test (`scripts/tests/dialogue-verbs-drift.test.mjs`, 3 cases) — `.mjs`
  list ≡ canonical TS list; no duplicates; Prentice's tags covered.
- The audit script's logic is `validateRosterCoverage` (covered above); the
  script itself is read-only I/O glue verified by the live Stellarlune run (no
  dedicated test, matching the untested sibling `audit-stage2-coverage.mts`).

### Manual acceptance walkthrough (live, real backend + GPU)

1. `npx tsx scripts/audit-missing-speakers.mts --book Stellarlune` → reports
   chapterIds `[16, 19, 33, 34, 47]` with the missing speakers.
2. Re-run stage1+stage2 for those chapters: `POST
   /api/manuscripts/<mid>/analysis/chapters` `{ "chapterIds": [16,19,33,34,47] }`.
   Watch SSE for the roster-guard auto-add WARN.
3. Re-audit → clean; `cast.json` now has `prentice` (+ behnam/cadence/woltzer)
   with non-zero lines; ch19 narrator bucket shrunk from 221.
4. **[GPU]** Design/assign voices for the recovered characters; regenerate the
   affected (already-rendered) chapters' audio.

## Out of scope

- ASR/audio-level QA of the regenerated chapters (srv-31, #508).
- The plan-181 stage-2 coverage guard (sentence truncation/loop) — orthogonal.

## Ship notes

(Filled in when status flips to `stable`.)
