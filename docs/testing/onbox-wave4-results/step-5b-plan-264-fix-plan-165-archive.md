# Step 5b — fix plan 264 self-contradiction, archive plan 165

Issue: Castwright#2559 ("wave 4 step 5b - fix plan 264 and archive plan 165").

## Chore 1 — plan 264 contradicts itself

`docs/features/264-vram-aware-gpu-placement.md`'s status header claimed `S6`
was part of the force-driven "on-box synthesis-path acceptance (S1/S2/S4/S6
below)" in the same paragraph that says the manual evict-under-contention
rows "6–8: cold `/load` steer, `design_voice` evicts Ollama, GPU-ASR
503→evict→retry ... were **not** force-driven on-box". S6 is walkthrough item
6 ("2-card boot, cold `/load`"), so it was claimed both force-driven and not
force-driven in the same paragraph.

Per the issue's ruling, the closing sentence ("rows 6–8 are not force-driven
and rest on automated coverage") is authoritative. Fix applied — removed `S6`
from the force-driven list:

```
- coverage (sidecar + Node) plus the on-box **synthesis-path** acceptance
- (S1/S2/S4/S6 below). The manual **evict-under-contention** rows (6–8: cold
+ coverage (sidecar + Node) plus the on-box **synthesis-path** acceptance
+ (S1/S2/S4 below). The manual **evict-under-contention** rows (6–8: cold
```

No other wording in the section was touched — this is a contradiction fix,
not an edit pass, per the issue's explicit instruction.

**Judgment call, reported for the record:** the issue also names a "for
context" owner ruling that rows 6-8 are "not a debt" / "deferred by choice,
not blocked", and says Plan 264 "itself calls them" that. A full-file read
found no such literal phrase anywhere in the plan (checked with `grep -n
"Deferred by choice"` — zero hits). The plan's own text already conveys the
substance of that framing ("were not force-driven on-box — they rest on
automated coverage for now"), just not verbatim. The Acceptance criteria
("Plan 264 states one consistent position on rows 6-8, matching its closing
sentence") is satisfied by the S6 fix alone, and the issue's own contradiction
paragraph says not to reword or restructure beyond it, so no further wording
change was made to the "flips to stable... once rows 6–8 are driven on-box"
closing sentence. Flagging this judgment call in case step 6 or the operator
wants the "deferred, not owed" framing made more explicit in the plan itself.

## Chore 2 — plan 165 archived

### Frontmatter + Ship notes fix

`docs/features/165-fe-15-16-language-and-revision-e2e.md` frontmatter said
`status: active` / `shipped: null` while the body (`> Status: stable...`) and
Ship notes ("Shipped 2026-06-01... PR pending") already agreed it shipped.
Fixed the frontmatter to match:

```
-status: active
-shipped: null
+status: stable
+shipped: 2026-06-01
 owner: null
```

### Resolving the "(PR pending)" SHA

`git log --all --oneline --grep="fe-15" -i` and a branch search located the
feature commit and its merge:

```
a4e0ec27 feat(frontend): revision A/B player e2e + library/cast language UX (fe-15 + fe-16)
1198fd01 Merge pull request #391 from dudarenok-maker/feat/frontend-fe-15-16
d5db66f9 Merge pull request #391 from dudarenok-maker/feat/frontend-fe-15-16
```

Two SHAs carry the identical merge message (this repo's history has a known
duplicate-timeline artifact from an earlier rewrite). Checked which is
actually reachable from `origin/main`:

```
> git merge-base --is-ancestor 1198fd01 origin/main; echo $?
1
> git merge-base --is-ancestor d5db66f9 origin/main; echo $?
0
```

`d5db66f9e929486fe12a52ae89a7432c2467cc90` (2026-06-01 19:05:36 +1000, PR
#391) is the ancestor of `origin/main` and is the real merge. Ship notes
updated:

```
-Shipped 2026-06-01 on branch `feat/frontend-fe-15-16` (PR pending). fe-15 BACKLOG
+Shipped 2026-06-01 on branch `feat/frontend-fe-15-16` (merged `d5db66f9e929486fe12a52ae89a7432c2467cc90`, PR #391). fe-15 BACKLOG
```

### Move + link re-pointing

`git mv docs/features/165-fe-15-16-language-and-revision-e2e.md
docs/features/archive/165-fe-15-16-language-and-revision-e2e.md`

Found every reference with `grep -rn "165-fe-15-16-language-and-revision-e2e"`
(excluding `.claude/worktrees/` and `node_modules/`) before and after the
move, and re-pointed each to the archive path:

- `docs/features/INDEX.md:43` — removed the old in-flight "Plans by area"
  entry (superseded by the archive-list entry) and added a new entry in the
  numerically-sorted "Shipped (archive)" section between plan 158 and plan
  166, matching the existing archive-entry format (short summary + Shipped
  date + PR).
- `docs/testing/onbox-acceptance-staleness-audit.md` — both occurrences
  (an inline evidence path and a `git log --oneline --` command target)
  re-pointed to `docs/features/archive/...`.
- `docs/testing/onbox-sitting-vram-contention.md` — the one markdown link
  (`../features/165-...` → `../features/archive/165-...`).

Confirmed after the move, no stale (non-archive) path remains:

```
> grep -rn "165-fe-15-16-language-and-revision-e2e" . (excluding node_modules, .claude/worktrees)
docs/features/INDEX.md:363:            (archive entry, correct)
docs/testing/onbox-sitting-vram-contention.md:174:    ../features/archive/165-... (correct)
docs/testing/onbox-acceptance-staleness-audit.md:696,705:  docs/features/archive/165-... (correct)
```

### Register/live-view reference found — reported, not edited (out of scope)

`docs/testing/onbox-acceptance-register.md:816` — row **A16** ("fe-16 Qwen
auto-load on a Russian book (plan 165)") names the plan by number only (no
markdown link/path), so the move itself doesn't break it. But its body
carries a stale ⚠️ note:

> ⚠️ *Frontmatter says `status: active` while the body's own `> Status:` line
> says `stable`* — worth reconciling while you are there.

That contradiction is now fixed by this step (frontmatter reads `stable`).
Per this issue's scope, `docs/testing/onbox-acceptance-register.md` is step
6's sole-writer file — reporting this for step 6 to remove the now-stale ⚠️
note, not editing it here.

## Verify

`npm run test:hooks` (full run, includes the `docs/testing` intra-repo link
scan):

```
✔ intra-repo .md links in the governance docs and skills resolve to real files and headings (76.7266ms)
...
ℹ tests 1448
ℹ suites 27
ℹ pass 1448
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 46946.7758
EXIT=0
```

`grep -rn "165-fe-15-16-language-and-revision-e2e"` (excluding
`.claude/worktrees/` and `node_modules/`) — all 4 surviving hits (the file
itself + the three referrers) point at `docs/features/archive/...`. Verified
above.

## Not touched (out of scope, per the issue)

- `docs/testing/onbox-acceptance-register.md`, its live view, and any
  `onbox-sitting-*.md` acceptance pack content beyond the one link fix in
  `onbox-sitting-vram-contention.md` (that file's own criteria-source link,
  explicitly named as one of the three referrers to re-point).
- No rewording/restructuring of plan 264 beyond the S6 fix.
- No other plan doc, no source file.
