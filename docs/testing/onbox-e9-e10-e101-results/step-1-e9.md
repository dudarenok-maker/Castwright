# Step 1 — E9 item (2) re-run against current main

Issue: [#2965](https://github.com/dudarenok-maker/Castwright/issues/2965) · Parent
[#2948](https://github.com/dudarenok-maker/Castwright/issues/2948), campaign #2435.

Re-running exactly the recipe wave 3/wave 4 already ran
(`docs/testing/onbox-wave3-results/step-4-real-workspace-scripts.md`,
`docs/testing/onbox-wave4-results/step-1-e11-item2-rerun.md`), this time against
current `main`, to confirm whether the final fix mechanism (attempt 4, commit
`5a60b088`) plus the two later blocking-regression fixes (P1/P2, both merged via
PR #2577) close the 14-field divergence on `Ночной дозор` that both prior runs
observed. **No code work — read-only confirmation only.**

## Setup

- Primary checkout: `C:\Claude\Projects\Audiobook-Generator`. **Commit tested:
  `76aa7c6d951839aa655aab9b44cecf6fc3836adb`** (current `main` tip at run time),
  confirmed a descendant of `5a60b088` via
  `git merge-base --is-ancestor 5a60b088 HEAD` (exit 0 — yes).
- `server/dist` was **not** rebuilt: its mtime is newer than
  `server/src/analyzer/dialogue-structure/aligner.ts`, and grepping the
  compiled `server/dist/analyzer/dialogue-structure/aligner.js` confirms the
  dash-invariant needle-search code (`buildNeedle`, `dashRunStart`) is present
  in the build actually exercised. The only source files newer than
  `server/dist/index.js` were test files (`*.test.ts`) and two unrelated
  modules (`config/registry.ts`, `workspace/user-settings.ts`) — none on the
  attribution/aligner path — so rebuilding would have changed nothing this
  check depends on.
- `WORKSPACE_DIR=C:\AudiobookWorkspace` throughout — real workspace, **never
  written to**. Only `books/` was read.
- `server/handoff/cache/` (git-ignored, per-checkout) already held the real
  23-book library's analyses going in — nothing copied in, matching this
  issue's read-only setup.

## Item (2) — dash-stripped invariance check

Cache path is hardcoded in the compiled server
(`server/dist/store/analysis-cache.js`: `CACHE_DIR = resolve(__dirname, '..',
'..', 'handoff', 'cache')`) with no env var to redirect it — same constraint
wave 3's evidence already noted. So per that precedent: all 32 `mns_*.json`
cache files were copied to a scratch backup path first
(`%TEMP%\...\cache-backup\`), then the dash-strip was applied **in place** to
the real `server/handoff/cache/` files, then reverted from the scratch backup
immediately after pass 2.

Command, pass 1 (straight):
```
WORKSPACE_DIR=C:\AudiobookWorkspace REPORT_PATH=<scratch>/pass1-report.json node scripts/measure-attribution.mjs
```
Exit 0. 23 rows (20 measurable + 3 `ok (not analysed)` throwaway rows, as in
every prior run). `Ночной дозор` (Tetralogy): `narratorIdSpoken` 229, `share`
0.13018760659465606, `unattributedSpeech` 9, `splitSpeech` 337,
`tagNarratorSpan` 544, `dashOnlySpoken` 1940 — matches wave 3/4's own
straight-run figures exactly.

Dash-strip applied to the real cache directory in place (regex
`s/^\s*[-–—]\s*//` against every sentence's `text` field under each file's
`chapters` map, walked recursively — same regex wave 3/4 used): **32 cache
files, 117,064 sentences, 4,920 stripped** (wave 3: 117,047/4,921; wave 4:
116,764/4,894 — same order of magnitude across three separate cache
snapshots, not a discrepancy worth chasing).

Command, pass 2 (dash-stripped):
```
WORKSPACE_DIR=C:\AudiobookWorkspace REPORT_PATH=<scratch>/pass2-report.json node scripts/measure-attribution.mjs
```
Exit 0. 23 rows.

Cache **restored from the scratch backup immediately after** pass 2, then
verified byte-identical to the pre-strip backup for all 32 files via `cmp -s`
in a loop (zero mismatches reported). Nothing in `C:\AudiobookWorkspace` was
ever touched — only `server/handoff/cache/` (git-ignored) was mutated, and
only transiently.

## Diff, field-by-field, every row

(`text`/`reason` excluded from the diff on purpose, same as prior waves.)

- **22 of 23 books: zero diffs.** Confirmed two ways: the raw tabular stdout
  is byte-identical for every row except `Ночной дозор` (`diff` of the two
  runs' captured output shows exactly one row line changed), and a
  programmatic field-by-field walk of both JSON reports (`pass1-report.json`
  vs `pass2-report.json`) found no diffs anywhere outside that one row.

- **`Сергей Лукьяненко / The Night Watch Tetralogy / Ночной дозор`: STILL
  DIVERGES.** Top-level fields:
  - `narratorIdSpoken` 229 → 223
  - `share` 0.13018760659465606 → 0.12728310502283105
  - `unknownOriginNarrator` 229 → 223
  - `unattributedSpeech` 9 → 7
  - `splitSpeech` 337 → 346
  - `tagNarratorSpan` 544 → 536
  - `dashOnlySpoken` did **not** move (1940 both runs) — computed straight
    from the manuscript body, never from the cached `text` this transform
    touches, same as every prior wave.

  Per-chapter shifts (`attributableSpoken` / `narratorIdSpoken` /
  `unattributedSpeech`):
  - chapter 1: `attributableSpoken` 387→381, `narratorIdSpoken` 67→62
  - chapter 6: `attributableSpoken` 88→87
  - chapter 7: `attributableSpoken` 131→133, `unattributedSpeech` 4→2
  - chapter 8: `attributableSpoken` 114→113, `narratorIdSpoken` 31→30
  - **chapter 9: `attributableSpoken` 231→230** — this one is **new relative
    to wave 4's write-up**, which listed only chapters 1, 6, 7, 8 as shifting.
    It is a small, same-direction, same-shape shift (one sentence's
    attribution moved), consistent with the same root cause rather than a
    different one, but it was not present (or not reported) in the wave-4
    run against `d9eb03ad`. Given the fix mechanism has iterated twice more
    since then (attempt 4 `5a60b088`, plus P1/P2), a slightly wider footprint
    on the same book is plausible and not itself alarming — noted here rather
    than silently omitted.

**These are the same field names, same direction, and same order of
magnitude as wave 3's pre-fix numbers and wave 4's post-#2577-fix numbers**
(wave 3/4 both: `narratorIdSpoken` 229→223, `unattributedSpeech` 9→7,
`splitSpeech` 337→346, `tagNarratorSpan` 544→536 — identical to this run).

## Verdict: FAIL

**Item (2) is STILL OWED — the criterion fails again, against the fully
current fix (attempt 4 `5a60b088` + P1/P2, all on `main` at
`76aa7c6d951839aa655aab9b44cecf6fc3836adb`).** The divergence on `Ночной
дозор` is unchanged in kind, direction, and magnitude from both prior
observations, with one additional small per-chapter shift (chapter 9) not
previously reported. This is not new evidence that the fix regressed — it is
the same residual real-data gap wave 4 already characterized: the fix's own
unit test and the #2541 parent-acceptance checklist reach a synthetic
dash-dense scene, but not whatever in `Ночной дозор`'s real 2,122-sentence,
1,940-dash-only-span structure still produces a divergent needle match.

Per this issue's framing: a FAIL is a valid, complete discharge of the
re-run debt itself (fresh evidence recorded, debt stays open) — this step is
DONE.

## Box-safety confirmation

- `C:\AudiobookWorkspace` was never written to (only `books/` read).
- `server/handoff/cache/` originals verified byte-identical to the pre-strip
  backup for all 32 files after restore.
- Scratch backup and both report JSON files live only under
  `%TEMP%\open-engine-scratch\claude-2965-...\`, not in any git checkout.
- No process was stopped, started, or restarted for this check.
