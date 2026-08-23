# Wave 4 step 1 — E9 item (2) re-run after #2537's fix

Issue: [#2571](https://github.com/dudarenok-maker/Castwright/issues/2571) · Gated on [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)'s
verify child [#2541](https://github.com/dudarenok-maker/Castwright/issues/2541) (PASSED, PR [#2577](https://github.com/dudarenok-maker/Castwright/issues/2577))
· Filed by wave 4 step 5 (#2554), part of the on-box register campaign (#2435).

## E9 — item (2) re-run only; item (3) not this issue's job

Re-running exactly the recipe wave 3 already ran once
(`docs/testing/onbox-wave3-results/step-4-real-workspace-scripts.md`), against
`fix/server-2537-dash-invariant-align` now that its fix has landed, to confirm
whether the fix actually closes the 14-field divergence wave 3 found on
*Ночной дозор*.

### Setup

- Worktree: `C:/Claude/Projects/wt-2537-dash-invariant-align`, branch
  `fix/server-2537-dash-invariant-align`, rebased onto `origin/main` before
  this run (two conflicts in `docs/release-notes-next.md` — both append-only
  bullet collisions, resolved by keeping both entries in commit order; no
  source file touched by the rebase). **Commit run against: `d9eb03ad`**
  (`fix/server-2537-dash-invariant-align`, rebased, containing #2537's full
  fix series `40bee7ff`, `6dddbdc0`, `3053f5dd`).
- `npm --prefix server run build` — clean, `tsc -p .`, no errors, exit 0.
- `server/handoff/cache/` was NOT empty going in (per-checkout, git-ignored) —
  it held a handful of unrelated test fixtures (`m_*_test.json`,
  `test-fresh-lock-*.json`, `test-rename-midrun-*.json`), left alone
  throughout. 32 `mns_*.json` files (the full analysis-cache set; 4 more
  `.bak*` files in the primary checkout excluded by the `mns_*.json` glob)
  copied in **read-only** from the primary checkout
  (`C:\Claude\Projects\Audiobook-Generator\server\handoff\cache\`). Deleted
  again after the run — see Box-safety below.
- `WORKSPACE_DIR=C:\AudiobookWorkspace` throughout — real workspace, **never
  written to**. Only `books/` was read.
- **First straight pass was run before the cache copy landed** and correctly
  came back `ok (not analysed)` for every book with all-zero measured fields
  (`dashOnlySpoken` aside, which reads straight from the manuscript body, not
  the cache) — caught before drawing any conclusion from it, discarded, and
  re-run after the cache was populated. The numbers below are all from the
  cache-populated re-run.

### Item (2) — dash-stripped invariance check

Command, straight run (cache populated):
```
WORKSPACE_DIR=C:\AudiobookWorkspace REPORT_PATH=<scratch>/attribution-report-straight.json node scripts/measure-attribution.mjs
```
Exit 0. 23 rows. `Ночной дозор` (Tetralogy): `narratorIdSpoken` 229,
`share` 0.13018760659465606, `unattributedSpeech` 9, `splitSpeech` 337,
`tagNarratorSpan` 544, `dashOnlySpoken` 1940 — matches wave 3's own straight-run
figures exactly, confirming the corpus and cache state line up with that
earlier run.

Then, on a **scratch-path copy** of each cache file (the worktree's own
git-ignored `server/handoff/cache/`, originals backed up first): every
sentence's `text` field had its leading dash stripped via a small Node script
applying `s/^\s*[-–—]\s*//` to every `text` property under each file's
`chapters` map (walked recursively; matches the run sheet's own regex
exactly). 32 cache files, 116,764 sentences, 4,894 stripped (wave 3 measured
117,047 / 4,921 against a slightly different corpus snapshot — same order of
magnitude, not a discrepancy worth chasing).

Command, dash-stripped run:
```
WORKSPACE_DIR=C:\AudiobookWorkspace REPORT_PATH=<scratch>/attribution-report-dashstripped.json node scripts/measure-attribution.mjs
```
Exit 0. 23 rows.

Originals restored from the pre-strip backup immediately after (spot-checked
by `diff -rq` against the backup directory — no differences reported for any
`mns_*.json` file), then all copied/restored cache files deleted from the
worktree — `server/handoff/cache/` back to holding only the unrelated test
fixtures it had before this step. Primary checkout's own cache directory was
never written to; spot-checked with `md5sum` on one file
(`mns_-8zHQk0f3q.json`) against the pre-run backup — identical.

**Diff, field-by-field, every row** (`text` and `reason` excluded from the
diff on purpose, same as wave 3):

- **22 of 23 books: zero diffs.** Every measured field identical between the
  two runs.
- **`Сергей Лукьяненко / The Night Watch Tetralogy / Ночной дозор`: 7
  top-level field diffs, same shape as wave 3's 14 (top-level + per-chapter
  counted separately there; this diff counts the `chapters` array as one
  field):**
  - `narratorIdSpoken` 229 → 223
  - `share` 0.13018760659465606 → 0.12728310502283105
  - `unknownOriginNarrator` 229 → 223
  - `unattributedSpeech` 9 → 7
  - `splitSpeech` 337 → 346
  - `tagNarratorSpan` 544 → 536
  - per-chapter `narratorIdSpoken`/`attributableSpoken`/`unattributedSpeech`
    shifted in chapters 1, 6, 7, 8 (chapter 1: `attributableSpoken` 387→381,
    `narratorIdSpoken` 67→62; chapter 6: `attributableSpoken` 88→87; chapter
    7: `attributableSpoken` 131→133, `unattributedSpeech` 4→2; chapter 8:
    `attributableSpoken` 114→113, `narratorIdSpoken` 31→30)
  - `dashOnlySpoken` did **not** move (1940 both runs), same as wave 3 —
    computed straight from the manuscript body, never from the cached `text`
    this transform touches.

**These are the same field names, the same direction, and materially the
same magnitude as wave 3's pre-fix numbers** (wave 3: `narratorIdSpoken`
229→223, `share` moved, `unattributedSpeech` 9→7, `splitSpeech` 337→346,
`tagNarratorSpan` 544→536 — identical to this run's numbers).

**Verdict: STILL FAILS on real data, after the fix.** The fix in PR #2577
(commits `40bee7ff`, `6dddbdc0`, `3053f5dd`) is confirmed present in this
run's source (`aligner.ts:317-360`'s dash-invariant needle-search comment
block) and in the compiled `server/dist` actually exercised (`aligner.js`
contains the same comment, file freshly rebuilt from this commit). Its own
unit test (`aligner.test.ts`, a synthetic 20-line dash-dense RU scene) and
the six-item parent-acceptance checklist both passed per #2541's PASS verdict
— but that coverage does not reach whatever in `Ночной дозор`'s full 2,122-
sentence, 1,940-dash-only-span real chapter structure still produces a
divergent needle match after the fix. This is not the same failure
re-appearing unfixed; it is either a narrower residual case the fix's
synthetic fixture didn't reach, or a different code path in the same
function not covered by the targeted fix. Root-causing the residual is out
of scope for this on-box re-run (dry-run/measurement only, no source diff
made against this worktree this pass) — routed back for a fresh fix attempt,
same as wave 3 routed the original defect.

### Item (3) — post-D18 re-analysis — not this issue's job

Per the parent issue's own scope note, item (3) is a separate re-analysis
that rides Group B/C's session. **Not run, not this issue's concern.**

## Box-safety

- **Dry-run only, confirmed.** No `--apply`, `--write`, `--fix`, or any
  mutation flag invoked anywhere in this run.
- **No mutation of `C:\AudiobookWorkspace`.** Only `books/` was read.
- **No server, sidecar, or model was stopped or touched.** Pure Node/tsc
  processes only.
- **No other lane's process was touched.** Other lanes' in-flight work in the
  same workspace and worktree list were left alone.
- **Cache scratch space left clean.** All copied/restored `mns_*.json` files
  deleted from `server/handoff/cache/` after the diff was captured; directory
  back to its pre-run contents (the unrelated test fixtures only).
- **Primary checkout's cache byte-verified unchanged** after this run
  (`md5sum` spot-check, one file, identical).

## Commit run against

`d9eb03ad9f1a9734bbcef1923dcdd77b7fea4f1e` on
`fix/server-2537-dash-invariant-align` (rebased onto `origin/main`; PR #2577).
