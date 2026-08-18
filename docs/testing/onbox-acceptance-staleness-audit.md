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
