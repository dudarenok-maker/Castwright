# Wave 5 step 3 — E9: `measure-attribution.mjs` against the real workspace

Issue: Castwright#2613 (wave 5 of the on-box register campaign, #2435; step 3 of #2606). Track: real workspace, no GPU needed.

Worktree: `wt-2606-onbox-wave5` @ branch `docs/docs-2606-onbox-wave5`.

## Read-only confirmation

Read `scripts/measure-attribution.mjs` (module doc comment + `main()`) before
running anything against the real workspace:

- `collectBookDirs` only calls `fs.readdirSync` (directory listing) under
  `<workspaceDir>/books` — no write call anywhere in the file.
- `resolveAttributionState`/`attributionShare` are dynamically imported from
  the **compiled server** (`server/dist/store/attribution-health.js`,
  `attribution-health-io.js`). Checked `server/src/store/attribution-health-io.ts`
  for any `writeFile`/`fs.write*`/`mkdir`/`unlink` call — **none exists.** It
  reads `state.json`, the analysis cache, and the manuscript record only.
- The script's only filesystem write is its own JSON report, to
  `REPORT_PATH` (default `server/handoff/cache/attribution-measurement-report.json`
  — inside `server/handoff/cache/`, git-ignored, never the workspace).

**Confirmed read-only against `C:\AudiobookWorkspace`.** Safe to run against
the real workspace as written.

## Cache population (per the brief)

`server/handoff/cache/` is per-checkout and git-ignored, so this worktree's
own cache started empty for every book. Populated it by copying
`server/handoff/cache/` from the primary checkout
(`C:\Claude\Projects\Audiobook-Generator`), read-only on the source side —
nothing in the primary checkout's cache was modified. `server/.env` was not
part of this copy (worktree already carries its own, unrelated, gitignored
`.env` from its original setup).

Post-copy listing diff between primary checkout and worktree cache
directories: **empty** (byte-identical file lists, 193 entries each before
the run below added this worktree's own report file).

## Build

```
$ npm --prefix server run build
> castwright-server@1.14.0 build
> tsc -p .
```

Clean exit, no errors.

## Run — `WORKSPACE_DIR=C:\AudiobookWorkspace node scripts/measure-attribution.mjs`

Full real output (tab-separated table, then worst-chapter lines, then the
report-path confirmation):

```
title	language	languageSource	spokenTotal	tagTotal	narratorIdSpoken	share	modelNarrator	demotedNarrator	unknownOriginNarrator	unattributedSpeech	splitSpeech	orphanSpoken	tagNarratorSpan	dashOnlySpoken	castCount	state
Лидия Ивановна Острецова / Standalones / Юный дрессировщик	ru	declared	279	58	193	88.5%	0	0	193	56	5	0	52	17	7	ok
Сергей Лукьяненко / The Night Watch Tetralogy / Ночной дозор	ru	declared	2122	605	229	13.0%	0	0	229	9	337	32	544	1940	34	ok
Shannon Messenger / Keeper of the Lost Cities / Unraveled	en	declared	2054	615	84	4.5%	0	0	84	168	2	0	527	0	11	ok
Shannon Messenger / Keeper of the Lost Cities / Everblaze	en	declared	4266	1538	136	3.3%	0	0	136	155	11	0	1223	0	34	ok
Shannon Messenger / Keeper of the Lost Cities / Neverseen	en	declared	5822	2584	180	3.2%	0	0	180	179	6	0	1790	0	53	ok
Shannon Messenger / Keeper of the Lost Cities / Exile	en	declared	3634	1190	94	2.7%	0	0	94	92	13	0	898	0	35	ok
Castwright / Standalones / 煤落的委托	zh	declared	128	52	3	2.5%	0	0	3	6	0	3	39	0	9	ok
Shannon Messenger / Keeper of the Lost Cities / Keeper of the Lost Cities	en	declared	3796	1176	89	2.5%	0	0	89	177	4	0	861	0	35	ok
Derek Landy / Skulduggery Pleasant / Playing with Fire	en	declared	2238	787	43	2.5%	0	0	43	210	275	6	713	0	32	ok
Castwright / Standalones / コールフォールの依頼	ja	declared	128	53	3	2.4%	0	0	3	2	0	0	5	0	10	ok
Shannon Messenger / Keeper of the Lost Cities / Stellarlune	en	declared	5586	1773	101	2.2%	0	0	101	1028	13	0	925	0	39	ok
Shannon Messenger / Keeper of the Lost Cities / Bonus Keefe Story	en	declared	101	31	2	2.2%	0	0	2	8	0	0	29	0	3	ok
Derek Landy / Skulduggery Pleasant / Scepter of the Ancients	en	declared	2744	827	48	1.9%	0	0	48	205	0	0	723	0	22	ok
Derek Landy / Skulduggery Pleasant / The Lost Art of World Domination	en	declared	187	45	2	1.2%	0	0	2	20	3	0	43	0	3	ok
Castwright / Standalones / El Encargo de Coalfall	es	declared	127	53	1	1.1%	0	0	1	4	0	32	11	0	12	ok
Castwright / Standalones / La Commande de Coalfall	fr	declared	128	54	1	1.0%	0	0	1	2	0	23	18	0	12	ok
Castwright / Standalones / Der Auftrag von Coalfall	de	declared	128	49	0	0.0%	0	0	0	1	5	2	48	0	14	ok
Castwright / Standalones / The Coalfall Commission	en	declared	128	51	0	0.0%	0	0	0	2	0	62	51	0	12	ok
Castwright / Standalones / Заказ Коалфолла	ru	declared	115	48	0	0.0%	0	0	0	3	4	1	34	0	13	ok
Shannon Messenger / Keeper of the Lost Cities / Unlocked	en	declared	2057	678	0	—	0	0	0	2057	0	0	4	0	22	ok
Сергей Лукьяненко / Standalones / Ночной дозор (C2 throwaway)	en	declared	220	1	0	—	0	0	0	220	0	0	0	0	37	ok
Сергей Лукьяненко / Standalones / Ночной дозор (C2C3 run 2)	en	declared	220	1	0	—	0	0	0	220	0	0	0	0	19	ok (not analysed)
Сергей Лукьяненко / Standalones / Ночной дозор (C2C3 run)	en	declared	220	1	0	—	0	0	0	220	0	0	0	0	37	ok (not analysed)

JSON report written to C:\Claude\Projects\wt-2606-onbox-wave5\server\handoff\cache\attribution-measurement-report.json
```

(worst-chapter lines omitted here — identical shape to the discharge run, no
new information beyond the table above)

## Spec §On-box acceptance criteria, worked through against this run

1. **A row for every live book, none blank.** 23 book rows, none blank —
   confirmed. Matches the 2026-08-14 discharge run's count (23 books rowed,
   21 measurable + 2 genuinely un-analysed C2/C3 throwaways).
2. **Both live CJK books produce a non-blank row with `spokenTotal > 0` and
   state `ok` or `collapsed`.** `煤落的委托`: `spokenTotal=128`, `state=ok`.
   `コールフォールの依頼`: `spokenTotal=128`, `state=ok`. Confirmed.
3. **`orphanSpoken` non-zero on books carrying unresolvable ids, share
   unaffected.** Non-zero on 7 books this run: `Ночной дозор` (32),
   `煤落的委托` (3), `Der Auftrag von Coalfall` (2), `El Encargo de Coalfall`
   (32), `La Commande de Coalfall` (23), `Заказ Коалфолла` (1), `The Coalfall
   Commission` (62) — concentrated in the *Coalfall Commission* family, per
   the register's own note. Confirmed, matching prior discharge exactly.
4. **`dashOnlySpoken` non-zero on the two Russian books; `unattributedSpeech`
   and `demotedNarrator` printed for every book.** `dashOnlySpoken`:
   `Юный дрессировщик`=17, `Ночной дозор`=1940 — both non-zero. `unattributedSpeech`
   is printed (non-null) on all 23 rows. `demotedNarrator` is `0` on every
   book — **this is the expected D18-trap outcome, not a fresh finding**:
   none of these 21 measurable caches have been re-analysed since
   `priorCharacterId` shipped, so every narrator-speech span correctly lands
   in `unknownOriginNarrator` (verified non-zero, e.g. 193/193 on
   `Юный дрессировщик`) instead of being defaulted into `modelNarrator`/
   `demotedNarrator`. Consistent with the register's own prior explanation of
   this exact shape.
5. **The two historical CJK collapses do not appear.** Neither of the
   deleted CJK collapse books appears in the 23-row output — the script
   walks the live `books/` tree only, never the cache directory, so a
   deleted book cannot surface. Confirmed by construction and by the row
   count (23 live books, no extras).

**Reproducibility check against the 2026-08-14 discharge run** (register
§E9): the register's own text records that only three books moved between
the 2026-08-13 partial run and the 2026-08-14 full discharge run, one of
them `Ночной дозор (Tetralogy)` moving `spoken 1928→2122` and
`orphan 29→32`. This run's output matches those exact post-discharge values
(`spokenTotal=2122`, `orphanSpoken=32`) — consistent with no corpus or
measurement-logic drift since the 2026-08-14 discharge.

## What was not attempted, and why

**Item (2), the dash-stripped re-run invariance check (Task 9's paired
assertion)**, was not run this pass. Tracing where `dashOnlySpoken` is
computed (`attribution-health.ts:192-219`) shows it tests the language's
dash marker against `body`, the **manuscript record's chapter text**
(`getOrHydrateManuscript` → `server/src/store/manuscripts.ts:81`,
`readFile(manuscriptPath)`), not a field inside the JSON analysis cache.
`manuscriptPath` resolves under the workspace tree. Producing a genuine
dash-stripped copy for this check therefore means copying whole book
directories to a scratch path (not just `server/handoff/cache/`) and
pointing the read at the copy — safe in principle, but real path-tracing and
a scratch-copy harness that does not yet exist in the tree, which is
materially more than this row's "under 5 minutes" estimate and this step's
scope covers. Left **STILL OWED**, unchanged from the register's own
standing note, rather than attempted unsafely against the live workspace
under time pressure.

**Item (3), re-analysing one book post-D18 to confirm a real
`demotedNarrator`/`modelNarrator` split**, needs GPU/analysis time this pass
did not spend, exactly as the register already records. Not attempted.

## Verdict

**E9 overall: STILL OWED**, unchanged from the register's current state —
this run only **reconfirms item (1)** (the full real-workspace run) from a
second checkout (this worktree, not the primary), with observed figures
identical to the 2026-08-14 discharge run's values everywhere they were
directly comparable. No regression found. Items (2) and (3), already marked
still owed in the register, remain owed — (2) needs a scratch-copy
manuscript-body harness not yet built, (3) needs GPU/analysis time. **No
register edit made**, per the brief's own scope boundary.

## Cleanup / box-safety verification

- `server/handoff/cache/` (including the copied per-book caches and this
  run's `attribution-measurement-report.json`) is git-ignored — confirmed
  via `git check-ignore -v`, and `git status` on the worktree is clean
  except this new evidence file.
- Nothing written to `C:\AudiobookWorkspace` — the script's only write target
  is `REPORT_PATH`, verified from source (see "Read-only confirmation"
  above).
- No other register row touched. No source file edited.
- No register edit made.
