# On-box acceptance register — staleness audit

This document is produced by the `#2436` chain (wave 1 of `#2435`). It exists
to spot-check `docs/testing/onbox-acceptance-register.md`'s 74 owed rows
against closed issues, merged PRs, and real repo state before any of the
operator's GPU-box time is scheduled against them — the register warns about
itself that plan prose is frequently not updated after later work discharges
it, and a stale row is worse than a missing one.

**No row has been discharged by this audit and the register is unchanged.**
This document only proposes verdicts; per the register's own governing rule,
a row comes out only when the acceptance was actually run on the box (or the
owner confirms it was exercised on a live book), and an audit verdict is
neither. The owner disposes.

## Verdict legend

- **`STILL OWED`** — the debt is real and unchanged.
- **`PROPOSE DISCHARGE`** — a specific, named, verifiable artifact now proves
  the behaviour. Requires both the artifact (a path, an issue number, or a PR
  number) and the command run, with its actual output pasted into the
  Evidence field.
- **`SHRUNK`** — part of the row is now covered. States precisely what is
  covered and what remains.
- **`AMBIGUOUS`** — the register and its cited sources contradict each other,
  or more than one defensible reading exists. Names the decision owed in one
  sentence and leaves it unresolved — the auditing batch is not authorised to
  decide it.

**Fail closed.** If a cited artifact cannot be resolved — the plan is
missing, the issue number does not exist, a link is dead — the verdict is
`STILL OWED`, never `PROPOSE DISCHARGE`. An instrument that shrinks the
number by being unable to check is worse than no instrument at all.

## Roll-up

_Placeholder — the final verify child of this chain computes this._

## G1 · Quarantine-lane health report — first live dispatch (ops-32, #1864, PR #1873)

- **Verdict:** STILL OWED
- **Evidence:** Three real cron dispatches now exist, not two: `event:
  schedule`, run ids `30789513665` (2026-08-03), `31355401008`
  (2026-08-10), and `31992063988` (2026-08-17) — all `conclusion: success`,
  all logging `# Quarantine lane health report` / `No quarantined tests are
  currently registered in `docs/testing/flaky-register.md` — nothing to
  run. Clean no-op.` The third run's `head_sha` is `1d9ea75c`, confirmed (via
  `git merge-base --is-ancestor`) to be a *descendant* of commit `6a45834b`
  (2026-08-13, "quarantine the flaky #2235 export revoke test"), so its
  checkout of `docs/testing/flaky-register.md` does carry a genuinely
  quarantined row (`#2235`, `routes through `quarantinedIt`; runs only under
  `RUN_QUARANTINE=1``) alongside the pre-existing non-quarantined `#1981`
  row. Despite that, the run still took the empty-register path.

  Read-only reproduction (no tests executed, `parseRegister` only):
  importing `scripts/quarantine-health.mjs`'s exported `parseRegister` and
  calling it against the current `docs/testing/flaky-register.md` returns
  `[]`. Root cause read from `scripts/quarantine-health.mjs:256-267`:
  `parseRegister` extracts test names by matching backtick-quoted spans in
  the Test cell (`` testCell.matchAll(/`([^`]+)`/g) ``) and drops the row
  entirely if that yields zero names. The register's current Test column
  format (e.g. `#2235 — revokes the older same-format manifest when a
  re-export of the same format finishes`) is plain prose with no backticks —
  only the File column is backtick-quoted — so every row in the live
  register is silently dropped before the quarantined/not-quarantined
  distinction is ever reached.
- **What changed since the row was written:** A real quarantined test
  (`#2235`, quarantined 2026-08-13) now exists, which is the precondition
  the row's text names as missing for both remaining halves (`gh issue view`
  auth, and genuine `intermittent` classification on real cross-run
  nondeterminism). But a previously-undocumented bug in `parseRegister`'s
  backtick-matching means the cron job still silently no-ops even with a
  live quarantined row present — the precondition being met has not yet
  translated into any real observation, and won't until that parsing gap is
  fixed. This is a new finding, not previously recorded on this row.
- **Remains owed:** Both original halves (real `gh issue view` auth under
  the injected `GH_TOKEN`; a genuine `intermittent` verdict on real
  cross-run nondeterminism) remain unobserved. Transitively, the
  `parseRegister` backtick-format bug now blocks the cron path from ever
  reaching either observation until it is fixed — that fix is out of this
  audit's scope (docs-only, verdicts not repairs) and is reported here for
  routing, per campaign issue `#2435`.
- **Decision owed:** n/a
- **Hardware still required:** GitHub Actions
- **Est. box time:** 5

## G2 · The published release body now comes from the committed file, not the tag annotation (#2137, PR #2168)

- **Verdict:** STILL OWED
- **Evidence:** `gh pr view 2168 --json state,mergedAt,title` → merged
  `2026-08-06T07:46:44Z`. `gh api repos/dudarenok-maker/Castwright/releases`
  and `gh api repos/dudarenok-maker/Castwright/tags` both show `v1.14.0`
  (published `2026-07-23T22:53:38Z`) as the newest tag/release — dated
  *before* PR #2168 merged. No tag has been pushed since. `resolveReleaseBody()`
  running live inside `release.yml` on a real tag push, as the row requires,
  has therefore not happened yet.
- **What changed since the row was written:** Nothing — no release cut has
  occurred since the fix merged.
- **Remains owed:** Exactly the four observations the row already specifies,
  at the next real `vX.Y.Z` tag push: the step exits 0 and logs `FILE` as
  the chosen source; the published body matches `git show
  <tag>:docs/release-notes-next.md`; the annotation checks visibly ran; and
  if the step fails instead, that failure is read as a real signal per the
  row's own guidance.
- **Decision owed:** n/a
- **Hardware still required:** GitHub Actions
- **Est. box time:** 5

## H1 · Kana-trigram richness gate holds at real-book scale for an all-kana (no kanji) Japanese manuscript (#2256 round 3, finding 3(b)/C5)

- **Verdict:** STILL OWED
- **Evidence:** `ls C:\AudiobookWorkspace\books\Castwright\Standalones\`
  lists the same seven Coalfall Commission translations as before, including
  only the two real CJK ones the row already accounts for and excludes
  (`煤落的委托` — zh, and `コールフォールの依頼` — ja **mixed** kanji+kana,
  not all-kana). No new manuscript is present. `git log --oneline -- \
  server/src/tts/prose-units.ts server/src/tts/detect-language.test.ts`
  shows no commits touching the kana-richness logic since round 4
  (`d41392f4`, which the row itself already cites) other than `c1f0a9d5` /
  `b85d3003`, both scoped to the unrelated chapter-marker/TOC-backfill gate
  (`#2341`).
- **What changed since the row was written:** Nothing.
- **Remains owed:** A real, legally usable all-kana (no kanji) Japanese
  manuscript, run through `detectManuscriptLanguageFromChapters` with the
  observed `R`/`digitTokenShare` recorded here, exactly as the row specifies.
- **Decision owed:** n/a
- **Hardware still required:** real CJK manuscript
- **Est. box time:** 15

## H2 · Lexical-richness floor still clears on a FULL-LENGTH real Han (Chinese) book (#2256 round 4, finding B3)

- **Verdict:** STILL OWED
- **Evidence:** Same directory listing as H1 — no new Han-script manuscript
  exists in the workspace. `wc -c` on the existing real zh sample
  (`煤落的委托/manuscript.md`) shows 16,200 bytes, consistent with the row's
  own cited scale (4,425 Han characters, 795 distinct) and one to two orders
  of magnitude short of a full-length book. No commit since round 4
  (`d41392f4`) touches `voteLanguage`'s lexical gates (same `git log` check
  as H1).
- **What changed since the row was written:** Nothing.
- **Remains owed:** A real, legally usable full-length Han (Chinese)
  manuscript, run through detection with N (combined character count), V
  (distinct-Han-character count) and the observed `guiraudR` recorded here,
  exactly as the row specifies.
- **Decision owed:** n/a
- **Hardware still required:** real CJK manuscript
- **Est. box time:** 15

## A1 · fs-38 Wave 3 — voice cloning (now incl. 3c) · 20 of 60 run (2026-07-29, 2026-07-31) · ~40 still owed · 3 run-2 results retracted

- **Verdict:** SHRUNK
- **Evidence:** Every artifact this row cites resolves exactly as described,
  confirmed live rather than taken at the row's word:
  - Bug fixes it claims closed/merged all check out: `gh issue view` shows
    `#1941`, `#1967`, `#1969`, `#1972`, `#1943`, `#2017`, `#2023`, `#2180`,
    `#1945`, `#1962`, `#1963`, `#1944` all `state: closed`,
    `state_reason: completed`. `gh pr view` shows `#1942` merged
    `2026-07-29T22:58:51Z`, `#1978` merged `2026-07-31T06:06:02Z`, `#2039`
    merged `2026-08-01T02:05:35Z`, `#2041` merged `2026-08-01T02:30:37Z`,
    `#2205` merged `2026-08-07T01:07:18Z` — all consistent with the dates
    and content the row attributes to them.
  - `#2026` (Russian XTTS quality, cited as opened by run 3) is still
    `state: open` (`reopened`) — correctly left off the "discharged" list.
  - Plans `docs/features/267-fs38-wave3-voice-clone.md`,
    `268-fs38-wave3b2-resolver.md`, `271-fs38-wave3c-xtts.md` all carry
    `status: active` in frontmatter, matching the row's framing that none
    archive until this walkthrough runs; 271's own Ship notes (`:756-761`)
    name row A1 by path as the gate.
  - The run sheet `docs/testing/fs38-wave3-onbox-acceptance.md` exists;
    its §7.1 result table (`:2703-`) is genuinely filled — e.g. `A-01 | **P**
    | 202; real Whisper transcript; 20.0 s; 24000 Hz; …` — with real,
    specific evidence per row, not placeholder text. (Note: the *inline*
    `**Result:** ☐ P ☐ F ☐ B ☐ N/A` checkboxes under each individual test's
    own write-up, e.g. `:534`, are all still blank across all 62 occurrences
    checked — only §7.1's summary table carries the actual marks. Cosmetic:
    the row cites "§7.1 completed," which is accurate; it does not claim the
    inline checkboxes are filled.)
  - Cited automated-coverage-is-mock-only claims hold up:
    `server/src/routes/chapter-qa-repair.test.ts` and
    `server/src/routes/voice-library.clone-fidelity.test.ts` exist (the
    latter is the one the row says discharges B-06 without on-box
    acceptance — its existence is the entire basis for that sub-claim), and
    `src/components/voices/voice-library-card.test.tsx` exists for the
    Preview-engine follow-up check. None of these reach the real sidecar, so
    none discharge anything past what the row already credits them for.
- **What changed since the row was written:** One thing not yet reflected in
  the row's text: **`#1972`** — the stale-attribution bug that forced the
  three run-2 retractions (A24 identity half, E-01 identity half, C-17's
  `F`) — is now `closed`/`completed`. The row already treats those three
  results as withdrawn rather than failing, which is still the correct
  reading; a closed root-cause bug does not retroactively restore a result
  that was never actually observed. It does mean a re-run of those three
  specific sub-tests is no longer blocked by the bug that invalidated them
  the first time — worth noting for wave-2 session planning, since it was
  previously an open question whether re-running them would just retract
  again.
- **Remains owed:** Everything the row's own "Still owed (~40)" section
  lists, independently confirmed still unresolved: browser/mic (A-07, A-08,
  A-09, B-02 — real browser + real mic); by-ear (B-03, E-06 — no instrument
  substitutes); Section E's E-03, E-06, E-07 (runnable, not yet run); the
  rest of Section C (18, incl. the starred, highest-risk C-01/C-08/C-12/
  C-17) and all of Section D (3) — untouched; C-02/D-02 and any full-book
  work, still blocked by the side-11 host-memory leak on this row's own
  account (no single open issue number is cited for the *current* recurrence
  of that leak, so this audit cannot independently re-verify it beyond the
  row's own description — treated as still owed, fail-closed); a genuine
  re-run of the three `#1972`-retracted sub-tests now that the blocking bug
  is fixed; and all six of the post-32 follow-up campaign checks
  (`preparing-voice` phase, end-to-end XTTS render, revoke-then-render on
  Coqui, VRAM partitioning across a mixed chapter, the `voice_language_mismatch`
  toast on the real stream, and Preview-on-ready-engine), none of which have
  a real-hardware run recorded anywhere this audit could find.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card | 2-card boot | real browser
  with microphone (both cited by sub-tests within this row; unlike the
  register's single-value field, this row does not reduce to one hardware
  class — see the row text's own per-bullet hardware notes)
- **Est. box time:** multi-hour (row's own estimate, unchanged; the six
  follow-up checks add a further short session per `271`'s pass/fail
  criteria, same box, no additional prerequisites)
