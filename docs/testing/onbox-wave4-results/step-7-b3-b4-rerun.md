# Wave 4 step 7 — B3/B4 acceptance re-run after #2536's fix (PR #2562, merged)

Issue: [Castwright#2570](https://github.com/dudarenok-maker/Castwright/issues/2570) · Filed by wave 4 step 5 (#2554), gated on #2536's surname-tolerant name comparator, part of the on-box register campaign (#2435).

## Provenance note — this run was already complete when this pass began

This issue is a **resumable claim**. An earlier run of this same issue (scratch
stamp `claude-2570-20260821-071823`, `AGENT CLAIMED` at `2026-08-21T07:19:49Z`)
already triggered the real re-analysis this row needs and the run completed —
`.audiobook/cast.json` and `.audiobook/cast-id-history.json` for *Заказ
Коалфолла* both carry a final write timestamp of `2026-08-21T07:47:44Z`
(confirmed via filesystem mtime, converted from the box's local `+10:00`
`17:47:44` — matches the history file's own `recordedAtIso` entries exactly).
No evidence file or register update existed yet, and the worktree
`wt-2570-b3-b4-rerun` (branch `docs/docs-2570-b3-b4-rerun`) was clean at
`origin/main`'s tip with no local commits — i.e. the earlier run did the real
work and stopped before writing it up, per the runner prompt's own
"parked-claim" case. This pass reconstructs the evidence from the artifacts
the completed run left behind rather than re-triggering a second ~20-minute
re-analysis, which would have been wasteful and would have overwritten the
very state being verified.

**Which code ran:** the earlier run's `AGENT CLAIMED` note records that PR
#2562 (the #2536 fix) was already merged into `main` by the time it claimed,
so it worked "against latest main instead of the (now-merged) PR branch". The
primary checkout (`C:\Claude\Projects\Audiobook-Generator`, whose `server/.env`
points `WORKSPACE_DIR` at the real `C:\AudiobookWorkspace` and whose `npm
--prefix server run dev` process is what was live on this box through the run
window) is at `88fe477a`, confirmed an ancestor-inclusive descendant of the fix
merge commit `1a09755a` (`git merge-base --is-ancestor 1a09755a 88fe477a` →
true). So the re-analysis whose output is examined below ran against code that
includes the fix.

## Fixture and baseline

*Заказ Коалфолла* (`C:\AudiobookWorkspace\books\Castwright\Standalones\Заказ
Коалфолла`), the same fixture B3/B4 have used since Wave 2. **Baseline for
this run is Wave 3's own after-state** (`docs/testing/onbox-wave3-results/step-5-group-b.md`,
2026-08-20), the last recorded state before today: **16 characters**,
including the pre-fix defect's two near-duplicate pairs coexisting —
`brann-weir`/`brann-wire` and `berrin-weir`/`berrin-wire` — none of the four
linked via `retireCharacterId`.

## Re-analysis run

A full re-analysis ran against the fixture between (at latest) `07:25:12Z` and
`07:47:44Z` today (2026-08-21) — inferred from `cast-id-history.json`'s own
`recordedAtIso`/`recordedAtSeq` entries added this run (seq 9, 12-14), which
land inside that window in ascending seq order, consistent with characters
being retired as chapters are merged sequentially through one continuous
run. This resumed pass did not capture the originating run's own SSE/API
transcript (the claiming run's process had already exited); the evidence
below is the after-state read directly from both JSON files, which is what
B3/B4's own row text asks be confirmed regardless of how the run was driven.

## Result — `cast.json` after re-analysis (14 characters)

| id | name |
|---|---|
| narrator | Рассказчик |
| **одуван** | Одуван |
| ren | Рен |
| mairin | Мэйрин |
| coalfall-dragon | Коалфолл |
| pell-hollis | Пелл Холлис |
| widow-kasper | Вдова Каспер |
| brann-wire | Бранн Уир |
| berrin-wire | Беррин Уир |
| father-lessom | Отец Лессом |
| ivo | Иво |
| sela | Села |
| hart | Харт |
| unknown-male | Незнакомый Парень |

## Result — `cast-id-history.json` `supersededBy` (new entries this run, in bold)

```
mayrin        -> mairin            (2026-08-11, pre-existing)
coalfall      -> coalfall-dragon   (2026-08-11, pre-existing)
мэйрин        -> mairin            (2026-08-20, wave-3)
коалфолл      -> coalfall-dragon   (2026-08-20, wave-3)
widow-casper  -> widow-kasper      (2026-08-20, wave-3)
**brann        -> brann-wire**       (2026-08-21T07:47:44Z)
**berrin       -> berrin-wire**      (2026-08-21T07:47:44Z)
**lessom       -> father-lessom**    (2026-08-21T07:25:12Z)
**oduvan       -> одуван**           (2026-08-21T07:47:44Z)
**brann-weir   -> brann-wire**       (2026-08-21T07:47:44Z)
**berrin-weir  -> berrin-wire**      (2026-08-21T07:47:44Z)
```

## B3 — verdict: **PASSED, discharge**

- `mairin` / `coalfall-dragon` — **unchanged**, exactly as Wave 2/3 recorded. ✅
- **No near-duplicate row formed, and the pre-existing pair from Wave 3's bug was actually cleaned up**: `brann-weir`/`brann-wire` and `berrin-weir`/`berrin-wire` — each pair that coexisted un-retired since Wave 3 is now correctly linked via `retireCharacterId` and collapsed to a single surviving id apiece (`brann-wire`, `berrin-wire`). This is stronger evidence than "the bug didn't reproduce" — the same mechanism that stops a *new* duplicate from forming also repaired the *existing* one, live, on the real fixture. ✅
- Roster count: 16 → 14. Net change accounts fully: −2 for the two pairs collapsing to one id each, ±0 for `unknown-man`→`unknown-male` (re-detected, same single row, not a second id) and `oduvan`→`одуван` (see B4 below — an id change, not an added row). No unexplained growth. ✅

`#2536`'s core defect (near-duplicate roster ids on a surname-token-drifted name-fallback match) does not reproduce, and the fix's mechanism also retroactively repaired the one instance already on disk. **B3 discharges.**

## B4 — verdict: **STILL OWED — new, distinct defect found**

- Cyrillic names, zero Latin transliteration: **PASSED** — all 14 `name` fields above are Cyrillic.
- No character gained a second id: **PASSED** — see B3 above, no duplicate pair exists post-run.
- Roster size vs. B3's original 13: now 14, +1 (`unknown-male`, a legitimate re-detection carried over from Wave 3's `unknown-man`) — consistent with "no recall lost", not a regression.
- **Every id is ASCII kebab-case: FAILED.** `одуван` (id, not name) is Cyrillic. `cast-id-history.json` records `"oduvan": "одуван"` — i.e. the system correctly recognised this run's fresh detection as the *same* character previously held under the established ASCII id `oduvan`, called `retireCharacterId`, but chose the **freshly-generated Cyrillic id as the survivor** instead of keeping the established ASCII one. `Одуван` is a plain first-name-only Cyrillic string with no surname-drift shape at all — unrelated to #2536's surname-token fallback — so this is not a recurrence of #2536, it is a new failure of the *same criterion* B4 exists to guard (design plan `docs/superpowers/plans/2026-08-01-cast-character-identity.md`, `cast-create.ts`'s `safeId` call is documented to keep ids ASCII/transliteration-free-but-still-kebab for the common case; here the retirement path picked the wrong side).

**Root cause (routed to a fix agent, not fixed here):** `server/src/util/safe-id.ts`'s `unicodeKebab` deliberately preserves non-Latin letters by design (plan 219, "Option C, transliteration deliberately NOT used") — so a *brand-new* character's Cyrillic name legitimately mints a Cyrillic id, which is correct. The defect is one layer up, in whichever caller of `retireCharacterId` in `server/src/store/merge-analysis-cast.ts` decided, for `oduvan`/`одуван`, that the fresh raw id should be the survivor (`from=oduvan, to=одуван`) rather than the existing cast id (which the `мэйрин→mairin` / `коалфолл→coalfall-dragon` / `lessom→father-lessom` cases in the SAME run correctly kept as the survivor). Filed as **[#2584](https://github.com/dudarenok-maker/Castwright/issues/2584)** for a fix agent to pick up cold.

Because a row-defined criterion genuinely failed against real evidence, **B4 stays STILL OWED**, not discharged, per the register's own governing rule.

## Files written this step

- `docs/testing/onbox-wave4-results/step-7-b3-b4-rerun.md` (this file)
- `docs/testing/cast-id-drift-onbox-acceptance.md` §7 — dated addendum recording this run
- `docs/testing/onbox-acceptance-register.md` — B3/B4 dated notes

## Box safety

No book other than *Заказ Коалфолла* was touched by this pass (read-only —
the write already happened before this pass started). No server, sidecar or
model was stopped by this pass. No `--apply`/`--fix` flag invoked. Worktree
`wt-2570-b3-b4-rerun` stayed clean except for this step's own three docs
edits.
