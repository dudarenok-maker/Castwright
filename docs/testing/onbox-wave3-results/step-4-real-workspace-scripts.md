# Wave 3 step 4 — real-workspace script rows

Issue: Castwright#2504 · Parent: #2497 · Plan of record: `docs/testing/onbox-wave3-plan.md` §4 (step 4)

Row assignment per the plan (not the issue title, which indicatively lists
A33/A43/E11): **step 4 shrinks to E11 only.** A33 and A43 are ruled OPERATOR
by the plan's own §2/§3 adjudication and are recorded below with no work run
against them, per the plan's explicit instruction.

## A33 — OPERATOR (no work run this step)

Re-resolved 2026-08-20 against `docs/testing/onbox-wave3-plan.md` §2, itself
citing the register verbatim (L1623-1627). The remaining owed work is §8.7
(re-render *Заказ Коалфолла* ch2 and **listen** — a live TTS render plus
human judgement of audio) and §8.8 (Cast-screen banner cross-check — a
browser render-state observation). Neither is agent-runnable. **Nothing
excluded**: the plan's verdict is adopted as-is, no new evidence found that
would move this row. Joins `onbox-sitting-cloning-identity.md` per the plan;
this step does not edit the sitting plan itself (out of scope, parent
issue's own "not in scope" section).

## A43 — OPERATOR (no work run this step)

Re-resolved 2026-08-20 against `docs/testing/onbox-wave3-plan.md` §3, itself
citing #2238 acceptance criterion 5 and the register (L2332-2336). Steps 2-3
of the row's own procedure require opening `#/books/<id>/cast` in a real
browser and reading rendered state ("needs your decision" → "auto-reconciled"
row movement) — no API-only substitute is stated anywhere in the row.
**Nothing excluded.** Joins `onbox-sitting-cloning-identity.md` alongside A32
and A33 per the plan.

## E11 — item (2) run; item (3) not this step's job

Re-resolved 2026-08-20 against the register (`docs/testing/onbox-acceptance-register.md`
L3204-3270) and the run sheet (`docs/testing/attribution-collapse-visibility-onbox-acceptance.md`
§4). Both still describe item (2) (dash-stripped invariance check) as owed
and item (3) (post-D18 re-analysis) as needing a live analyzer session —
confirmed current, nothing moved since those docs were written. **Nothing
excluded.**

### Setup

- Worktree: `wt-2497-onbox-wave3-run` @ `f260ce93` (HEAD at run time,
  unchanged by this step — no commit-worthy source diff, see below).
- `server/handoff/cache/` was empty in this worktree (per-checkout,
  git-ignored). Populated **read-only** by copying `mns_*.json` (32 files —
  the full analysis-cache set, including a few non-library manuscripts;
  harmless, since the script walks `<workspace>/books/**`, never the cache
  directory, so unmatched cache entries are simply never read) from the
  primary checkout (`C:\Claude\Projects\Audiobook-Generator\server\handoff\cache\`).
  Deleted again after the run — see Box-safety below.
- `WORKSPACE_DIR=C:\AudiobookWorkspace` throughout — real workspace, **never
  written to**. Only `books/` was read; `.upgrade-backups/` was never
  entered (walk is rooted at `books/`, same as the script's own design).
- `cd server && npm run build` — clean, `tsc -p .`, no errors.

### Item (2) — dash-stripped invariance check (Task 9's paired assertion)

Command, straight run:
```
WORKSPACE_DIR=C:\AudiobookWorkspace REPORT_PATH=<scratch>/attribution-report-straight.json node scripts/measure-attribution.mjs
```
Exit 0. 23 rows (23 real book dirs under `C:\AudiobookWorkspace\books`,
confirmed by direct `find` count before running — matches the register's own
"23 books" account, including three transient `Ночной дозор (C2*)` throwaway
directories other agent lanes are using for the Group C block right now;
read-only, not touched).

Then, on a **scratch-path copy** of each cache file (not the live workspace —
`server/handoff/cache/` itself, which is this worktree's own git-ignored
scratch space per the header note in `measure-attribution.mjs` and CLAUDE.md's
own `CACHE_DIR` note; the compiled server hardcodes `CACHE_DIR` relative to
`server/dist`, so there is no env var to point it at a separate scratch
directory — the swap has to happen in place, with the untouched originals
backed up first and restored after): every sentence's `text` field had its
leading dash stripped, `s/^\s*[-–—]\s*//`, matching the run sheet's own
regex exactly. 32 cache files, 117,047 sentences, 4,921 stripped.

Command, dash-stripped run:
```
WORKSPACE_DIR=C:\AudiobookWorkspace REPORT_PATH=<scratch>/attribution-report-dashstripped.json node scripts/measure-attribution.mjs
```
Exit 0. 23 rows.

Originals restored from backup immediately after (`server/handoff/cache/`
verified back to its pre-transform bytes by spot-check), then **all copied
cache files and both report JSONs deleted** from the worktree — nothing left
behind in scratch space that a later step could mistake for live state.

**Diff, field-by-field, every row** (raw `text` and the `reason` field
excluded from the diff on purpose — `reason` can echo raw sample text in one
corroboration path, and the criterion is about measured fields, not the
transformed text itself):

- **22 of 23 books: zero diffs.** Every measured field (including
  `dashOnlySpoken`, `orphanSpoken`, `share`, per-chapter columns) identical
  between the two runs.
- **`Сергей Лукьяненко / The Night Watch Tetralogy / Ночной дозор`: 14
  diffs.** `narratorIdSpoken` 229→223, `unknownOriginNarrator` 229→223,
  `share` 0.13018760659465606→0.12728310502283105, `unattributedSpeech`
  9→7, `splitSpeech` 337→346, `tagNarratorSpan` 544→536, and per-chapter
  `attributableSpoken`/`narratorIdSpoken`/`unattributedSpeech` in chapters
  0, 5, 6, 7, 8 (each shifting by 1-2). `dashOnlySpoken` itself did **not**
  move (1719 both runs) — expected, since that field is computed straight
  from the manuscript body (`attribution-health.ts:198-219`), never from the
  cached `text` this transform touched.

**Verdict: STILL OWED — the criterion FAILS on real data**, for exactly one
book (the corpus's heaviest dash-convention book). This is a real,
reproducible property gap, not test-harness noise: 22/23 books being
byte-identical rules out a broken diff or a nondeterministic script, and the
one failing book is the corpus's own worst-case for the property being
tested, which is the shape a real defect takes rather than the shape flaky
output would.

**Root cause (for a fix agent, cold):** `alignSentences`
(`server/src/analyzer/dialogue-structure/aligner.ts:317` and `:360`) builds
its search needles as `normalize(s.text)` — the **cached** sentence's own
text — and substring-locates each needle inside the normalized chapter
**body**. Stripping a leading dash from the cache's copy of `text` changes
the needle without changing the body being searched, and for this book's
dash-led lines that shifts which body offsets the needle locates at for at
least some lines, moving spans between `unattributedSpeech` / `splitSpeech`
/ attributed buckets with no actual attribution change underneath. This is
precisely the D14 invariant the metric's own module header says must hold
(`server/src/store/attribution-health.ts:9-11`, "a field whose value can
change when the model re-punctuates its output without changing any
attribution is wrong"). The equivalent property is pinned and passes in
`server/src/store/attribution-health.criteria.test.ts`'s Tier A/B
punctuation-invariance suite — synthetic fixtures don't reach the dash
density this real book has (1719 of 1940 spoken spans are dash-only), which
is why the gap only shows up against real data. **Fix decision owed:**
whether `alignSentences`' matching should itself be dash-tolerant (treat a
leading paragraph-dash marker as optional in the needle, so a transcript
that includes or omits it locates the same span either way) — scoped
entirely to `server/src/analyzer/dialogue-structure/aligner.ts`. Per the
campaign rule, this is reported for a fix agent to pick up cold, not fixed
in this diff (out of scope for a docs-only wave-3 step; also, per this
issue's own dry-run-only rule, no source diff was made against this
worktree at all this pass).

Run sheet's own `Result:` line updated in place:
`docs/testing/attribution-collapse-visibility-onbox-acceptance.md` §4.

### Item (3) — post-D18 re-analysis — not this step's job

Per the plan (§4, step 4 preconditions): item (3) needs a live analyzer and
rides whichever of step 5 (Group B) or step 6 (Group C) runs first, rather
than spending its own GPU/analysis time here. **Not run.** No action needed
from this step beyond noting it — the plan already assigns it elsewhere.

## Box-safety

- **Dry-run only, confirmed.** No `--apply`, `--write` or `--fix` invocation
  appears anywhere in this run — `measure-attribution.mjs` is read-only by
  construction (module doc comment) and nothing else was invoked.
- **No mutation of `C:\AudiobookWorkspace`.** Only `books/` was read; no file
  under the real workspace was created, edited, or deleted.
- **No server, sidecar, or model was stopped.** This step never touched a
  running service — the script and the build are both pure Node/tsc
  processes with no service dependency.
- **No other lane's process was touched.** The three `Ночной дозор (C2*)`
  throwaway directories visible in the workspace during this run belong to
  other lanes' in-flight Group C work; they were read (as part of walking
  `books/**`) and nothing else.
- **Cache scratch space left clean.** All copied `mns_*.json` files and both
  generated report JSONs were deleted from `server/handoff/cache/` after the
  diff was captured; the directory is empty again, matching its state before
  this step ran.

## Dated re-resolution note

2026-08-20. E11's register entry (L3204-3270), the run sheet's §4 (dash
invariance) and §1/§3 (item 3), and the wave-3 plan's step-4 section (§4)
were all re-read live against this worktree's tree at the time of the run.
A33 and A43's OPERATOR verdicts (plan §2/§3) were re-read against the same
register lines they cite. **Nothing excluded** from any of the three rows —
each row's remaining owed work matches what its governing document already
said, confirmed by an actual run for E11 item (2), and by re-reading citied
prose (no new evidence available) for A33/A43.
