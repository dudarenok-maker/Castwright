# Cast/analysis characterId drift — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box, with a real sidecar (Wave 1), a real analyzer (Wave 2), or the
> repair script plus a real sidecar (Wave 3) and the real, already-affected
> book(s). Do not pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-08-01-cast-character-identity-design.md`](../superpowers/specs/2026-08-01-cast-character-identity-design.md)
> Plan of record: [`docs/superpowers/plans/2026-08-01-cast-character-identity.md`](../superpowers/plans/2026-08-01-cast-character-identity.md)
> Regression plan: [`docs/features/278-cast-character-identity.md`](../features/278-cast-character-identity.md)
> Register rows: [`onbox-acceptance-register.md` A29](onbox-acceptance-register.md) (Wave 1, §§1-6 below), B3 (Wave 2, §7 below), [A30](onbox-acceptance-register.md) (Wave 3, §8 below), A45 (#2128 audio currency, §9 below), and [A44](onbox-acceptance-register.md) (#2584/#2570 wrong-direction retirement fix, §10 below) — **B3 is discharged (2026-08-21)
and A45 (2026-08-11); neither is in the register any more, and §7 and §9
below are their records. Do not follow B3 to whatever now sits at that
position — Group B renumbered and today's B2 is an unrelated #2246 row.**
> Issue: [#2040](https://github.com/dudarenok-maker/Castwright/issues/2040)

---

## 1. Purpose & scope

Wave 1 shipped a **read-time** fix only: `buildCastResolver` now resolves a
frozen segment's `characterId` through a Unicode-preserving separator/case
normaliser (`normaliseIdKey`) before falling through to the narrator. It is
entirely unit- and route-tested against synthetic fixtures. What no automated
suite proves is the one thing the feature is *for* — that re-rendering a
chapter on the real, already-drifted workspace now puts the drifted
character's own voice on their lines instead of the narrator's.

A read-only, dry-run measurement of this already happened (see the design
spec §6): running the compiled resolver against the real 20-book workspace at
`C:\AudiobookWorkspace\books`, with an entirely empty history, recovers 68 of
the 188 orphaned segments — via the normalised-id tier alone, no schema
change. **That was an offline id-resolution check, not a render.** This run
sheet is the render: pressing the real "re-record this character" / chapter
regenerate button against a real sidecar and listening to what comes out.

**The fixture is real, not synthetic**, and its exact shape was confirmed by
reading the files directly ahead of this run sheet (2026-08-02):

- **Book:** *Playing with Fire* (Derek Landy, Skulduggery Pleasant), at
  `C:\AudiobookWorkspace\books\Derek Landy\Skulduggery Pleasant\Playing with Fire`
  (`bookId: derek-landy__skulduggery-pleasant__playing-with-fire`, English).
- **`the-torment`** — the analysis-cache id for cast character `the_torment`
  ("Torment", `voiceState: tuned`, `ttsEngine: qwen`, `ttsModelKey:
  qwen3-tts-1.7b`, tuned voice `qwen-YaC5ot82IqTLpeDbHd77F`). RC2: `the_torment`
  was minted by `cast-create.ts`'s underscore slugifier; the analyzer
  independently mints `the-torment` for the same character. **37** segments
  in `19-chapter-fifteen-point-blank.segments.json`, the rest spread across
  chapters 17, 20 and 38 (67 total across the book).
- **`lightning-dave`** — the analysis-cache id for cast character
  `lightning_dave` ("Lightning Dave", `voiceState: generated`, no voice
  override — a catalogue voice). **1** segment, in
  `16-chapter-twelve-barfight.segments.json`.
- **Negative control, same chapter: `pool-player-2`** — cast character
  `pool_player` ("Pool Player"). The analyzer's id carries a `-2` collision
  suffix that Tier B's separator/case normalisation does **not** strip
  (`normaliseIdKey` never equates ids whose letters differ, and `pool-player`
  vs `pool-player-2` differ by more than separators/case). **6** segments in
  `16-chapter-twelve-barfight.segments.json`. Wave 1 must **not** recover
  these — they need Wave 2 or Wave 3. If they resolve too, something is
  matching more aggressively than the design specifies and that is a defect,
  not a bonus.

**Confirmed pre-fix state (read directly from the files, 2026-08-02):** every
`the-torment` / `lightning-dave` / `pool-player-2` segment in the affected
chapters carries `"renderedFallbackEngine": "kokoro"` and **no**
`characterSnapshots` entry under its own id — i.e. today's narrator
substitution, exactly as the design describes. None carry
`renderedFallbackCharacterId` (that stamp postdates these chapters' last
render — #2023 shipped after them), so do not expect to see it flip; judge the
fix by the fields below instead.

## 2. Preconditions

- [ ] Real TTS sidecar running, Qwen resident (or loadable) — Torment's voice
      is on the `qwen3-tts-1.7b` tier. Not mock mode.
- [ ] The real workspace book above is present and untouched (`git status`
      equivalent for the workspace: do not run the Wave-3 repair script or any
      cast edit against it before this run — this row is about the resolver
      alone).
- [ ] **Back up the three affected chapter files first** —
      `16-chapter-twelve-barfight.segments.json`,
      `19-chapter-fifteen-point-blank.segments.json`, and their `.mp3`s —
      before re-rendering, so a bad run can be reverted without re-importing
      the book.
- [ ] SHA and a clean tree recorded below.

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

## 3. Re-render chapter 19 — the high-volume recovery case

1. Open *Playing with Fire* in the app. Re-record chapter 19
   ("Chapter Fifteen: Point Blank") — either via the chapter's own
   regenerate control, or a per-character re-record targeting Torment if the
   UI offers it for an unresolved id.
2. After it completes, read the fresh
   `19-chapter-fifteen-point-blank.segments.json` for the segments with
   `characterId: "the-torment"`.

Expected:

- `characterSnapshots["the-torment"]` now exists, with `voiceEngine: "qwen"`
  and `resolvedVoiceName` naming Torment's own tuned voice
  (`qwen-YaC5ot82IqTLpeDbHd77F`) — **not** `qwen-narrator`.
- Those segments no longer carry `renderedFallbackEngine: "kokoro"` (the
  fallback that only fires when the line is being rendered as a
  *different* character/engine than its own).

Result (`characterSnapshots["the-torment"].resolvedVoiceName`): ______________

Result (`renderedFallbackEngine` still present? Y/N): ________________________

3. **Listen to the chapter.** Torment is a menacing interrogator (his line at
   `groupIndex: 25` is "Kill the child."). Confirm the line at that beat is
   spoken in a distinct voice from the narrator's — not the same voice
   reading every other unattributed line in the chapter.

Result (by ear, distinct voice from narrator): _______________________________

## 4. Re-render chapter 16 — recovery AND the negative control together

4. Re-record chapter 16 ("Chapter Twelve: Barfight").
5. Read the fresh `16-chapter-twelve-barfight.segments.json`.

Expected for **`lightning-dave`** (1 segment, `groupIndex: 39`) — same
recovery shape as Torment: a `characterSnapshots["lightning-dave"]` entry
now exists and `renderedFallbackEngine: "kokoro"` is gone from that segment.

Result: _______________________________________________________________

Expected for **`pool-player-2`** (6 segments) — **must still fall back to the
narrator**, unchanged from before this PR: `renderedFallbackEngine: "kokoro"`
still present, no `characterSnapshots["pool-player-2"]` entry. This is the
row's negative control — Wave 1 explicitly does not close the `-2` collision
suffix case (that needs Wave 2/3), and this chapter is the one place both the
recovered and the not-yet-recovered case sit side by side.

Result (`pool-player-2` still narrator-substituted, unchanged): ______________

## 5. Cast-screen banner cross-check

6. Open the Cast screen for this book (the #2023 orphaned-id banner, per
   `RELEASE_NOTES.md`'s "A line attributed to a character Castwright doesn't
   recognise no longer renders in silence about it").

Expected: after the two re-renders above, the banner no longer names
`the-torment` or `lightning-dave` for this book. It still names
`pool-player-2` (and the book's other genuinely-unresolved ids, if any are
surfaced from the chapters not touched by this run).

Result: _______________________________________________________________

## 6. Outcome

- [ ] All sections run
- [ ] §3 and §4 run (the two that matter — the by-ear check is not
      optional; a resolved `resolvedVoiceName` with a silently-substituted
      voice underneath would not be caught by the JSON fields alone)
- [ ] Defects filed: ____________________________________

Record what was observed, by whom, and when — here and in the register row.
"The JSON fields look right" is not a substitute for the by-ear check in §3
step 3. **Do not run the Wave-3 repair pass or the Wave-2 remap against this
book as part of this acceptance run** — this row is scoped to the resolver
alone; Wave 2 and Wave 3 have their own sections (§7, §8) below.

---

## 7. Wave 2 — stopping new drift at re-analysis time

> Register row: **B3 — discharged 2026-08-21, row removed from the register.**
> There is no current ID for it: Group B renumbered and today's B2 is an
> unrelated #2246 row that reused the position, so do not follow this to
> whatever now sits at B3. The discharge evidence is the run note in §7.2
> below.

### 7.1 Purpose & scope

Wave 1 (§§1-6 above) resolves drift that already exists, at render time. Wave 2 stops a re-analysis from **creating** new drift in the first place — six changes, all landing before anything is persisted to `cast.json`, the analysis cache, or a frozen `segments.json`:

- Every id-retiring code path (the merge's rename and collision handling, the early remap below, `performCastMerge`) now funnels through a single `retireCharacterId` choke point, so `.audiobook/cast-id-history.json` is actually populated in production for the first time — it was always empty before Wave 2, including on the real 20-book workspace (confirmed by Wave 1's own gate scan, see below).
- A new **early remap pass** on both the main and subset analyzer paths: when a re-analysis mints a fresh id for a character the cast already holds under a different id (matched by display name), the fresh roster **adopts** the existing cast id — roster and sentences together — before anything downstream derives from the fresh ids.
- The merge's name-fallback now also matches an **unvoiced** character whose analyzer id drifted (previously gated to voiced/reused characters only), with a voiced-preference rule, a `notLinkedTo` guard, and narrator exclusions.
- `cast-create.ts` mints ids with the shared `safeId` instead of a private underscore slugifier — closes RC2 (`the_torment` vs `the-torment`, and non-ASCII names like "Мэйрин" previously slugged to an empty string).
- A fresh roster that reintroduces a live character whose id is a key in the history **drops** that history entry rather than silently rerouting the segments it covered, and records the displaced pair.

**Read-only, no-render measurement already ran** (Task 15's Wave 2 gate, 2026-08-04, against the real 20-book workspace at `C:\AudiobookWorkspace\books`): 188 orphaned segments confirmed (matching the issue's evidence table row-for-row), 68 recovered by Wave 1's resolver, 120 still orphaned across 9 book/id pairs. **`cast.json` was modified in NONE of the 20 books; `cast-id-history.json` was present in NONE of them.** That measurement proves Wave 2 changed nothing it shouldn't have — it does not and cannot prove the thing this section is for, which is that a live re-analysis run, with a real analyzer minting genuinely non-deterministic ids, now keeps (or correctly records) a character's id instead of drifting it further. Only a real analyzer run can produce that evidence.

### 7.2 Fixture

*Заказ Коалфолла* at `C:\AudiobookWorkspace\books\Castwright\Standalones\Заказ Коалфолла` (13 characters). Confirmed directly (2026-08-04):

- `cast.json` holds `mairin` (Мэйрин), `coalfall-dragon` (Коалфолл) and `brann-weir` (Бранн) today.
- A chapter rendered off an earlier analysis-cache pass already carries the letter-level id variants `mayrin` (8 segments) and `coalfall` (13 segments) — part of the 188-segment corpus (design §6's table) and **not** recoverable by Wave 1's normalised-id tier, since `mayrin` vs `mairin` differ by more than separator/case (RC1, not RC2). This is the book design §1.3 traces in detail: a Jul-14 re-analysis correctly updated `cast.json` to fresh ids, which was then reverted by a `cast.json` restore that did not revert the analysis cache — the exact "two of three surfaces move" shape RC3 describes.
- No `.audiobook/cast-id-history.json` exists for this book yet — Wave 2 has never run against it.

**Do not attempt to repair the existing 21 orphaned segments (8 + 13) as part of this run** — that is Wave 3's job. This section only proves that re-analysing the book again does not add to that count, and that if the id must change, the change is recorded.

### 7.3 Preconditions

- [ ] A real analyzer available — local Ollama (the default engine) or Gemini (`GEMINI_API_KEY` set). No TTS sidecar or GPU rendering is required for this section's own criteria.
- [ ] The real workspace book above is present and untouched.
- [ ] `cast.json` and (absence of) `cast-id-history.json` recorded below *before* re-analysing.
- [ ] SHA and a clean tree recorded below.

SHA: `c0c988eed781`  Clean tree: ☑  Date: `2026-08-20`  Run by: `Claude (wave-3 step 5, wt-2497-onbox-wave3-run)`

### 7.4 Before re-analysis — record the baseline

Read `.audiobook/cast.json` for *Заказ Коалфолла* directly.

Result (`cast.json` id for Мэйрин): `mairin` (matches expected)

Result (`cast.json` id for Коалфолл): `coalfall-dragon` (matches expected)

Result (`.audiobook/cast-id-history.json` present?): **PRESENT — re-resolution discrepancy from this doc's stated precondition.** Contents (read directly before re-analysing): `{"supersededBy":{"mayrin":"mairin","coalfall":"coalfall-dragon"},"seq":1,"recordedAtIso":{"mayrin":"2026-08-11T04:36:43.849Z","coalfall":"2026-08-11T04:36:43.849Z"}}` — dated 2026-08-11, i.e. some prior real run (not this session, and not attributable to any Wave-3 step run before this one) already exercised Wave 2's retirement path against this book once. This section's own §7.2 states the file was absent as of 2026-08-04; that was true then and is stale now. Per `onbox-sitting-plan.md` §6's re-resolution rule, this is recorded rather than silently trusted, and the run below proceeds anyway (the row's job is to re-analyse *again* and confirm the ids are still kept, which is independent of whether an earlier run already produced one supersession).

### 7.5 Re-analyse the book

Trigger a **full** re-analysis of *Заказ Коалфолла* (not a subset/chapter re-analysis — the early remap ships on both the main and subset paths, but only the main path is exercised by simply re-running analysis on an unedited manuscript). Let it complete.

**Run record:** `POST /api/manuscripts/mns_af35ec3ced/analysis` (SSE), local Ollama `qwen36-cw-iq4-32k:latest`, against a worktree server bound to `WORKSPACE_DIR=C:\AudiobookWorkspace` on isolated port 8190. Started 2026-08-20 15:43:07, completed 16:02:50 (real wall-clock ~19m43s — the SSE capture connection itself dropped partway through, but the job ran to completion server-side independent of that connection, confirmed by `server/dist` log timestamps and `cast.json`'s own mtime moving to 16:02:50).

### 7.6 After re-analysis — confirm the id was kept, or the change was recorded

Read `.audiobook/cast.json` and `.audiobook/cast-id-history.json` again.

Result (`cast.json` id for Мэйрин, still `mairin`?): **YES — unchanged.**

Result (`cast.json` id for Коалфолл, still `coalfall-dragon`?): **YES — unchanged.**

**Both ids are unchanged** — the primary proof holds. Stronger than a coincidental match: the analyzer's *raw* fresh ids this run were `мэйрин` and `коалфолл` (lowercase Cyrillic, genuinely different strings from `mairin`/`coalfall-dragon`), confirmed by the new `cast-id-history.json` entries below — so the early remap demonstrably did something, not just reproduced the kept ids on its own.

**Either id changed anyway** — yes, at the raw-analyzer-output layer (see above), correctly caught and recorded.

Result (history entry present and correctly directed, if applicable): **YES.** `cast-id-history.json`'s `supersededBy` map gained three new entries this run (seq 2-4, `recordedAtIso` 2026-08-20T06:02:50.3xxZ, i.e. this session): `"мэйрин": "mairin"`, `"коалфолл": "coalfall-dragon"`, and `"widow-casper": "widow-kasper"` (a third character, Вдова Каспер, whose id the analyzer also drifted this run — same correct mechanism, an extra data point beyond the row's own two named characters). All three are correctly directed (fresh id → the cast's kept id), proving `retireCharacterId` fired and was recorded for all three, not silently dropped.

Result (roster otherwise intact — still 13 characters, no duplicate row, no character silently renamed onto another's id): **FAILS.** Roster grew from 13 to **16** characters. One addition is legitimate (`unknown-man` / "Неизвестный мужчина", a background voice not previously detected — a real, small manuscript, so a miss/catch either way is plausible and not itself a defect). The other two are a genuine regression: `brann-wire` ("Бранн Уир") and `berrin-wire` ("Беррин Уир") are **near-duplicate rows** of the pre-existing `brann-weir` ("Бранн") and `berrin-weir` ("Беррин") — same role ("Один из близнецов-каменщиков"/quarry-working twins), same evidence quotes verbatim (e.g. "Так это, стало быть, дракон?"), confirming these are the same two characters, not new ones. Neither pair appears in `cast-id-history.json`'s `supersededBy` map — the name-fallback match never fired for them, so no retirement happened; they simply coexist as orphaned duplicates now. **Root cause (for a fix agent, cold):** the name-fallback match in `server/src/store/merge-analysis-cast.ts` keys on an exact normalized-name equality (`nameOf()` at `:205-206`, `normaliseForMatch(c.name)`, consumed by the fallback lookup at `:282-284`, `dropMatchCandidateByName.get(key)`). This run's analyzer output included a surname for both twins ("Бранн Уир"/"Беррин Уир") where the existing cast held only the given name ("Бранн"/"Беррин") — the normalized keys differ, so the fallback candidate is never found and a fresh id (`brann-wire`/`berrin-wire`) is minted instead of retiring onto the existing one. This is exactly the split-identity failure mode this row's own text (and B4, riding the same run) names as "the one way this change could make things worse rather than better."

### 7.7 Outcome

- [x] §§7.4-7.6 run — 2026-08-20, real local-Ollama re-analysis against the live workspace book, evidence above.
- [x] Defects filed: **not filed as a GitHub issue by this step** (docs-only wave-3 step, per the campaign rule this is reported for a fix agent to pick up cold rather than fixed or filed here) — full detail recorded in `docs/testing/onbox-wave3-results/step-5-group-b.md` and above. Mechanism: `server/src/store/merge-analysis-cast.ts:205-206,282-284` (exact-name-match fallback has no tolerance for a name gaining/losing a trailing surname token between analyzer runs).

> **Re-run, 2026-08-21 (Castwright#2570, wave-4 step 7) — after #2536's fix
> (PR #2562) merged.** A second full re-analysis of the same fixture, against
> code including the fix, confirmed both effects at once: no NEW
> near-duplicate pair formed, and the ONE existing duplicate pair left by the
> 2026-08-20 run above (`brann-weir`/`brann-wire`, `berrin-weir`/`berrin-wire`)
> was itself retroactively collapsed to a single surviving id apiece via
> `retireCharacterId` — live evidence the fix works, not just that it didn't
> regress further. `mairin`/`coalfall-dragon` remain unchanged. **B3's
> criteria are now met; the row discharges.**
>
> A second, distinct defect surfaced in the same run, unrelated to #2536: the
> established ASCII id `oduvan` was retired IN FAVOUR OF a freshly-minted
> Cyrillic id `одуван` (`cast-id-history.json`: `"oduvan": "одуван"`) —
> backwards from the direction the other three retirements in the same run
> took (fresh id retired in favour of the established one). This is a B4
> failure (ids must stay ASCII kebab-case) but not a B3 failure (no
> duplicate — the character has exactly one id, just the wrong one). Filed as
> [#2584](https://github.com/dudarenok-maker/Castwright/issues/2584) for a fix
> agent. **B4 stays STILL OWED.** Full evidence:
> `docs/testing/onbox-wave4-results/step-7-b3-b4-rerun.md`.

Record what was observed, by whom, and when — here only; register row B3 was
discharged on 2026-08-21 and no longer exists. An id that happens to match this run's non-deterministic analyzer output is a weaker result than a genuine mismatch that gets correctly recorded — if the ids come back unchanged, note whether the analyzer's raw output (before the remap) could be inspected to confirm the remap actually did something, rather than the model simply reproducing `mairin`/`coalfall-dragon` on its own. **Do not run the Wave-3 repair pass against this book as part of this acceptance run** — this section is scoped to the early remap alone; Wave 3 has its own section (§8) below.

> **Wave-5 step 4, 2026-08-23 — register row B2 (current numbering; "B4" above
> in this section's own then-current numbering) DISCHARGED, but against a
> DIFFERENT fixture, not this section's re-analysis.** Per that step's own
> issue instruction, the check ran against the committed short-chapter
> fixture `server/src/__fixtures__/the-coalfall-commission.ru.md` (a fresh
> import with no prior `cast-id-history.json` to merge against) rather than
> re-running *Заказ Коалфолла* here. All six characters' `cast.json` names
> came back in Cyrillic with ASCII-kebab-case ids, no near-duplicate pair,
> and no id-retirement-direction defect. **This does not re-confirm or close
> [#2584](https://github.com/dudarenok-maker/Castwright/issues/2584)** — #2584
> is specific to a re-analysis of *Заказ Коалфолла* against its existing
> `cast-id-history.json` (a second/third pass merging into prior history),
> which a fresh import has no code path to exercise. #2584 stays open,
> tracked on its own issue, independent of register row B2's discharge. Full
> evidence: `docs/testing/onbox-wave5-results/step-4-b2.md`.

---

## 8. Wave 3 — the repair pass's `--apply` run

> Register row: [`onbox-acceptance-register.md` A30](onbox-acceptance-register.md)

### 8.1 Purpose & scope

Waves 1 and 2 (above) prove the *mechanisms* against a single already-drifted
chapter or book each. `scripts/repair-cast-id-drift.mjs` is the pass meant to
sweep the **whole** 20-book workspace in one run, and as of this section being
written **it has never been run with `--apply`** — every dry-run number below
was produced without writing anything. The pure helpers (candidate ranking,
the reserved-source and cross-source-ambiguity guards, the re-render list
shape) are unit-tested against synthetic fixtures
(`scripts/tests/repair-cast-id-drift.test.mjs`), and the `--apply` liveness
probe was verified live against dummy TCP listeners (`task-18-report.md`) —
but nothing has exercised the real write path against the real workspace.
This section is that run.

**Read-only dry-run measurement already ran** (round-2 review fixes applied,
re-measured 2026-08-05 with `CACHE_DIR` correctly pointed at the checkout that
ran this workspace's analysis) against `C:\AudiobookWorkspace\books`:

- **3 auto-recordable aliases, 27 segments** — `mayrin` → `mairin` (8) and
  `coalfall` → `coalfall-dragon` (13), both in *Заказ Коалфолла*; `lady-alina`
  → `dame-alina` (6) in *Everblaze*. Unchanged by the round-2 fixes below.
- **93 ids reported for a human decision, 161 segments** (was misreported as
  93 segments — see below) — including the three reserved fold-bucket rows a
  pre-review version of the script would have wrongly auto-recorded (*Exile*'s
  `unknown-male`/`unknown-female`, *Unlocked*'s `unknown-male`). Also includes
  §1's *Playing with Fire* fixture, `the-torment` (67) and `lightning-dave`
  (1): both already auto-reconcile live via the normalised-id tier, so a
  round-2 fix corrected their reported reason from the misleading "zero
  rendered segments — no damage to repair" to "already auto-reconciles …
  already fixed" — the 68-segment delta between the old 93 and the corrected
  161. Neither is itself damage (both already render under their live id),
  so this doesn't move the re-render/damage total below (still 120) — 161 is
  no longer a proxy for "segments still needing repair".
- **17 re-render rows, 120 segments** (unconditional on auto-record status) —
  the actual damage figure at the time this section was written. **Superseded
  by the #2107 widened fix — see step 9a below: the current figure is 23
  rows/188 segments**, and `the-torment`/`lightning-dave` (68 of those
  segments) also move from "auto-reconciles, no alias needed" into a genuine
  auto-record. This bullet is left as originally measured.
- **0 books modified.**
- **1 book missing analysis-cache evidence, 0 books with an auto-record
  withheld because of it** — two DIFFERENT numbers as of owner-decided
  policy, review round 2 (2026-08-05); **only the second gates `--apply`,
  and it currently reads `0`, so `--apply` is NOT blocked.** A dry run from
  a worktree with no cache of its own for these 20 books instead reports 20
  books missing cache evidence, since the cross-source ambiguity veto can't
  see cache ambiguity without the file (round-2 review fail-closed fix).
  #2093 residual 1 first strengthened the underlying gate from "the file is
  present at that path" to "the file exists AND parses"; independent review
  then found even that was insufficient — the ambiguity veto doesn't
  consume "did it parse", it consumes the cache's actual character-name
  entries, and a validly-parsing cache that names nobody is exactly as
  blind to it as a missing file. The gate now also requires at least one
  name/id entry that `buildNameIndex` itself would keep, not merely one
  `cacheEntriesOf` treats as string-shaped (pre-merge review I1 closed a
  further gap — see below), and against the real cache directory this
  surfaces exactly one book: *Unlocked*'s cache file (`mns_dLurz4I544.json`)
  parses fine but names zero characters (no `stage1.characters`, no
  populated `chapterCast`) — real, not a `CACHE_DIR` misconfiguration.
  **This no longer blocks the run — but not because *Unlocked* has nothing
  orphaned.** It does: **`unknown-male`, 34 segments across ch63/ch67**
  (confirmed by a live pre-merge-review scan, and independently by the real
  `--apply` run — see §8.6). The reason it doesn't block: `unknown-male` is
  a **reserved fold-bucket SOURCE id**, and guard 1 refuses to auto-record
  from a reserved source unconditionally, firing *before* the
  cache-availability gate is ever reached — so *Unlocked*'s blind ambiguity
  veto never actually stood between the pass and a real candidate. `--apply`
  refuses only when a book's blind veto DID withhold a real candidate; that
  count is reported separately and currently reads `0`. **Do not stop just
  because "books missing analysis-cache evidence" reads nonzero** — check
  the withheld-count line instead. The trigger that WOULD change this: a
  non-reserved orphaned id in *Unlocked* with a real Tier A/B match — and,
  per pre-merge review I2, a zero-segment match would NOT trigger it either
  (guard 3 refuses those regardless of cache evidence, before the cache gate
  is reached).

### 8.2 Fixture

The same two books §7's fixture already establishes, plus a third:

- *Заказ Коалфолла* at
  `C:\AudiobookWorkspace\books\Castwright\Standalones\Заказ Коалфолла` — the
  `mayrin`/`coalfall` pair (§7.2 above).
- *Everblaze* — carries `lady-alina` (6 segments, orphaned) against a live
  cast row `dame-alina` ("Dame Alina"); its `chapterCast[60]`/`[61]` name the
  character `lady-alina` even though its finalised `stage1.characters` roster
  already reads `dame-alina` (§4.7's evidence table calls this pair
  "unattributed" — the repair pass's own dry run traced the mechanism: an
  exact, unambiguous Tier A name match against the live cast row, not a
  genuine miss).

No `.audiobook/cast-id-history.json` exists yet for either book.

### 8.3 Preconditions

- [ ] `cd server && npm run build` completed — `--apply` dynamically imports
      the compiled `buildCastResolver`/`retireCharacterId`/etc. from
      `server/dist/**` rather than re-implementing them.
- [ ] `CACHE_DIR` set to the checkout that ran this workspace's analysis —
      default `<repo>/server/handoff/cache` is git-ignored and per-checkout, so
      a fresh worktree's copy is empty for these real books. Run the dry run
      and confirm its summary reads `books with an auto-record withheld for
      missing cache evidence: 0` before doing anything else — `--apply` now
      refuses outright otherwise (round-2 review fail-closed fix: a missing
      cache file silently defeats the cross-source ambiguity veto, since an
      empty cache index reads as "confirmed unambiguous" rather than
      "unknown"; #2093 residual 1 strengthened the underlying gate to ALSO
      refuse a present-but-corrupt/unparseable cache file, and
      independent-review Critical C1 strengthened it once more to ALSO
      refuse a validly-parsing cache file that names zero characters, and a
      later pre-merge review pass (I1) closed a further gap in that same
      check — all used to slip past as "available"). **Owner-decided
      policy, review round 2 (2026-08-05): this precondition is about
      WITHHELD candidates, not the raw missing-cache count** — a nonzero
      `books missing analysis-cache evidence` line is EXPECTED and does NOT
      block `--apply` by itself; only a nonzero `books with an auto-record
      withheld…` line does. **As measured 2026-08-05, this precondition IS
      satisfied**: `books missing analysis-cache evidence` reads `1`
      (*Unlocked* — see §8.1: it DOES have an orphaned id, `unknown-male`
      with 34 segments, but guard 1 refuses to auto-record from it as a
      reserved fold-bucket source before the cache gate is ever reached, so
      nothing was ever withheld for it), and `books with an auto-record
      withheld…` reads `0`. Don't stop at the first number.
- [ ] `WORKSPACE_DIR` must actually point at the real 20-book workspace
      (#2108) — confirm the summary reads `books scanned: 20` alongside the
      cache-evidence lines above. A wrong `WORKSPACE_DIR` (the script's
      default, `<home>/AudiobookWorkspace`, does not exist) scans **0**
      books and, before this fix, printed a clean-looking `books missing
      analysis-cache evidence: 0` and exited `--apply` with code `0` having
      written nothing — an empty tree read as a healthy one, on exactly the
      line this precondition told the operator to trust. `--apply` now
      refuses outright when `books scanned` is `0`.
- [ ] No Castwright server reachable on the configured probe port(s) — default
      `8080` and the LAN HTTPS `8443` — **or their auto-rebind range** (up to
      19 ports above each, matching `listenWithAutoRebind` — #2090). `--apply`
      refuses outright otherwise (it writes out-of-process; no in-process lock
      covers the write). The probe is a plain "is anything listening" TCP
      connect, not a Castwright health check — it refuses on **any**
      listener in `8080`–`8099` or `8443`–`8462`, including an unrelated dev
      service that happens to be bound in that range. A refusal is not proof
      the Castwright server itself is still up — confirmed live on the
      2026-08-05 run below: a plain `npm run dev` bound LAN HTTPS `8443`
      only and never opened `8080`, and it was the `LAN_HTTPS_PORT` half of
      the widened probe that caught it — a probe covering only the default
      `8080` would have missed it entirely.
- [ ] The real workspace is present and untouched since the last dry run.
- [ ] SHA and a clean tree recorded below.

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

### 8.4 Confirm the safety rail against a real server first

1. Start `cd server && npm run dev` (or `npm start`) against the real
   workspace.
2. Run `node scripts/repair-cast-id-drift.mjs --apply`.

Expected: refuses immediately, naming the reachable port(s), exit code 1, no
`cast-id-history.json` written anywhere (confirm via a workspace-wide file
search before and after).

Result: **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS.** `cd server && npm run dev` bound **LAN HTTPS 8443 only** — it never opened 8080 — so this exercised the `LAN_HTTPS_PORT` half of the probe rather than the `PORT` half. `--apply` refused immediately: `Refusing --apply: port(s) 8443 did not return a clear ECONNREFUSED — treating as possibly-live`, exit code **1**. Workspace-wide search for `cast-id-history.json` returned **0** files both before and after. Worth noting for anyone repeating this: had the probe covered only the default 8080, this real server would have been invisible to it.

3. Stop the server before continuing.

### 8.5 Run `--apply`

4. Run `node scripts/repair-cast-id-drift.mjs --apply` against the real
   workspace, with the same `WORKSPACE_DIR`/`CACHE_DIR` as every prior dry
   run.

Expected console output: `mode: APPLY (writing cast-id-history.json)`,
`auto-recordable aliases: 3 (27 segment(s))`, `books missing analysis-cache
evidence: 1` (*Unlocked* — expected, not a blocker, see §8.1/§8.3), and
`books with an auto-record withheld for missing cache evidence: 0` —
matching the dry-run numbers in §8.1 exactly (a diverging number here means
the workspace changed since the last dry run — stop and re-measure before
trusting anything below; if the WITHHELD-count line is nonzero, `--apply`
refuses outright instead — fix `CACHE_DIR` per §8.3 and re-run the dry run
first; a nonzero missing-cache-evidence line alone does NOT refuse).
**Revision-sensitive: the numbers above are against the pre-#2102 gate** —
see the callout below the Result for what changed once #2102 landed (it now
has). **As measured 2026-08-05 (pre-#2102), this precondition WAS satisfied
and this step WAS run** — see the Result immediately below, which is no
longer pending (the repo owner's decision, review round 2: *Unlocked* DOES
have an orphaned id, `unknown-male` with 34 segments, but guard 1 refuses to
auto-record from it as a reserved fold-bucket source before the cache gate
is ever reached, so it has nothing at stake and no longer blocks the
workspace run).

Result (console summary matches §8.1): **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS — exact match.** `mode: APPLY (writing cast-id-history.json)`; books scanned **20**; auto-recordable aliases **3 (27 segment(s))**; reported for human decision **93 id(s) / 161 segment(s)**; re-render candidates **17**; books missing analysis-cache evidence **0**.

> **Read that last figure against the right revision.** This run was made against `main` @ `f3d6ae0f`, i.e. the **pre-#2102** gate, where the cache-evidence count was global and `0` was the go/no-go. **#2102 has since landed**, making the gate honest and scoping the refusal per book — post-#2102 code now reports `books missing analysis-cache evidence: 1` (*Unlocked* parses but names nobody) **plus `books with an auto-record withheld: 0`** — and it is that second line, not the first, that gates `--apply`. Do not read this PASS as "the first line must be 0."
>
> **#2092/#2089 Task 9 (pair-scoped reject filter) has ALSO since landed, on the same branch as #2102's rebase.** It has no effect on the numbers above: neither book involved in this run had a `rejectedPairs` or legacy id-wide `rejected` entry — the Cast-screen "Not the same character" action hadn't shipped to a real run of the app when this `--apply` was performed, so nothing here was ever gated on a reject. The change matters only the NEXT time this pass runs against a workspace where a real reject exists on disk: the old code skipped that id from auto-recording against ANY candidate; the new code only withholds the specific rejected `(from, to)` pairing, so a different, later candidate for the same id can still auto-record.

Invocation: `WORKSPACE_DIR="C:/AudiobookWorkspace" CACHE_DIR="C:/Claude/Projects/Audiobook-Generator/server/handoff/cache" node scripts/repair-cast-id-drift.mjs --apply`. **`WORKSPACE_DIR` must be passed explicitly** — the script does not read `server/.env`, and its `<home>/AudiobookWorkspace` default is empty on this box (see [#2108](https://github.com/dudarenok-maker/Castwright/issues/2108)).

### 8.6 After `--apply` — confirm what was and wasn't written

5. Read `.audiobook/cast-id-history.json` for *Заказ Коалфолла*.

Result (`supersededBy` contains `mayrin: "mairin"` and
`coalfall: "coalfall-dragon"`): **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS.** File reads `{"schema": 1, "supersededBy": {"mayrin": "mairin", "coalfall": "coalfall-dragon"}}`.

6. Read `.audiobook/cast-id-history.json` for *Everblaze*.

Result (`supersededBy` contains `"lady-alina": "dame-alina"`): **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS.** File reads `{"schema": 1, "supersededBy": {"lady-alina": "dame-alina"}}`.

7. Search the whole workspace for `cast-id-history.json`. Expected: **exactly
   two** files — the two above. No other book gained one.

Result (file count and locations): **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS — exactly two.** `Castwright/Standalones/Заказ Коалфолла/.audiobook/cast-id-history.json` and `Shannon Messenger/Keeper of the Lost Cities/Everblaze/.audiobook/cast-id-history.json`. No other book gained one (workspace-wide `find`, 0 before → 2 after).

8. Diff every book's `cast.json` against its pre-run state (mtime, then
   content). Expected: byte-unchanged everywhere — the pass never touches
   `cast.json`.

Result: **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS.** md5 of all **20** `cast.json` files captured before the run and re-captured after — the two sorted digest lists are identical, so every book's cast is byte-unchanged.

9. Re-run the script in **dry-run** mode (no `--apply`) immediately after.
   Expected: the three now-recorded aliases no longer appear in the
   auto-record list (already resolved through history), and the 93
   report-only ids are unchanged from §8.1 — proving the write was durable,
   not merely printed once.

Result: **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS on the stated criteria, but it surfaced a defect.** Auto-recordable aliases **3 → 0**; skipped (already recorded) **0 → 3**; report-only **93 ids / 161 segments — unchanged**. The write is durable. **However** the re-render list moved **17 rows / 120 segments → 13 rows / 93 segments**: the 4 rows covered by the 3 new aliases (`mayrin` ch2 8 seg, `coalfall` ch2 13 seg, `lady-alina` ch55 4 seg + ch61 2 seg = 27 segments) dropped off it. That audio is still narrator-substituted on disk, and `buildRerenderRows`' own doc comment plus register row A30 both state the list is unconditional on auto-record status. Filed as [#2107](https://github.com/dudarenok-maker/Castwright/issues/2107).

**#2107 fix (`fix/scripts-2107-rerender-rows`), then WIDENED by an independent
review + owner decision:** `collectSegmentOrphans`'s resolver reads
`cast-id-history.json` off disk, and any id resolving via ANY successful tier
used to hit the same blanket `continue` as a genuine live match. A first-round
fix moved only the `'history'`/`'normalised-history'` tiers into `orphans` —
both depend on `supersededBy`, which can gain an entry (as it just had, from
this very `--apply` run) strictly after the segment's audio was rendered —
while keeping `'normalised-id'` exempt, reasoned as depending only on the
current live cast, never on `supersededBy`. **Independent review found that
reasoning a non-sequitur**, using §8.1's OWN evidence: `the-torment`/
`lightning-dave` recover under `'normalised-id'` today but were rendered
*before Wave 1's resolver existed at all* (§1's `resolveGroup` substituted the
narrator regardless of tier), so a `'normalised-id'` match today proves no
*rename* happened, not that the rendered bytes are correct. There is no
per-segment evidence on the real workspace to tell the two cases apart —
`renderedFallbackCharacterId`/`characterSnapshots` are absent from all 84,642
real segments. The owner's decision: **only `'exact'` counts as "audio is
fine"; the other three tiers all list, unconditionally.** This ALSO changes
what `--apply` *writes*, not merely the re-render list — an id that used to
silently "auto-reconcile" with no alias ever recorded (the `autoReconciled`
bucket, now removed entirely) can reach a real Tier A/B auto-record instead.
A related gap closed alongside: the "already recorded" skip compared raw
strings against `supersededBy` while the resolver itself also matches on a
normalised key — now a widened id can reach that skip with real segments
behind it, so it checks the same normalised footing the resolver does
(confirmed latent, not live, on the real workspace: all three recorded
aliases are already normalised fixed points). Pinned by a cross-run
regression test in `scripts/tests/repair-cast-id-drift.test.mjs`
(`buildOrphansFromSegments` describe block) reproducing the before/after-alias
sequence over a synthetic fixture, plus a `planBookRepairs` test pinning the
write-set change and one pinning the normalised-footing skip. **That
cross-run test uses two independent `buildOrphansFromSegments` calls with
hand-written fake resolvers — it does not call `collectSegmentOrphans`, build
a real `buildCastResolver`, or read a `cast-id-history.json` file, so the
actual cross-run coupling (this script threading `history.supersededBy` into
the resolver on each run) is verified only by the re-run below, not by the
unit-test suite.**

9a. Re-run the script in dry-run mode again, now on top of the widened #2107
    fix (`cd server && npm run build` off the fixed branch first).

Expected: **auto-recordable aliases, skipped, and report-only do NOT stay the
same as step 9** — the widened fix changes the write-set, not merely the
re-render list (I2, independent review, 2026-08-05; the earlier version of
this run sheet claimed otherwise — that claim was false and has been
corrected here). `the-torment`/`lightning-dave` move from invisible
(auto-reconciled, no alias recorded) into a real 2-alias auto-record; the
report-only total drops by exactly their 68 segments; the re-render list
grows past the original 17/120 baseline, since `'normalised-id'` matches with
real rendered segments (Exile/Unlocked's reserved-bucket ids, `sir-harding`,
`silveny`, `pool-player-2`) now list too.

Result: **RUN 2026-08-05** (`server/dist` rebuilt off `fix/scripts-2107-rerender-rows`
@ `1dbc340f`, dry run only, `WORKSPACE_DIR=C:/AudiobookWorkspace
CACHE_DIR=C:/Claude/Projects/Audiobook-Generator/server/handoff/cache node
scripts/repair-cast-id-drift.mjs`, no `--apply`). **Matches the corrected
expectation above.** Auto-recordable aliases **0 → 2 (68 segments)**
(`lightning-dave -> lightning_dave` 1 segment Tier A, `the-torment ->
the_torment` 67 segments Tier B); skipped (already-recorded) **3, unchanged**
(`mayrin`, `coalfall`, `lady-alina` — all three real aliases from step 4/5
onward); reported for human decision **93 ids/161 segments → 91 ids/93
segments** (161 − 68 = 93, 93 − 2 = 91 — the whole delta is
`the-torment`/`lightning-dave` moving out); re-render candidates **13 rows/93
segments (the #2107-regressed figure) → 23 rows/188 segments** — 188 is the
original full-workspace orphan count (§1), the arithmetic check that this is
now the complete set. Books scanned **20**; books missing analysis-cache
evidence **1** (*Unlocked*, unchanged); books with an auto-record withheld
**0** (unchanged, `--apply` not blocked). Full console output archived with
the PR.

**Fix round 2 (independent review, 2026-08-05) found two more defects in the
#2107 fix itself:** the round-1 already-recorded fix (`supersededByNormKey`,
a hand-built normalised map) diverged from the real resolver on normalised
collisions, tier precedence, and dead alias targets — each a false skip that
would drop an id off the human-decision list. Deleted; the guard now asks the
real, history-aware resolver directly (threaded from `main()`, not
reconstructed) whether an id resolves via `'history'`/`'normalised-history'`.
Separately, the widening opened an undeclared write path: Tier A (name) runs
before Tier B (id shape) with nothing checking a Tier A candidate against
what the id already resolves to today — a stale cache entry naming a
different character could otherwise repoint real segments' attribution onto
the wrong live character, durably. A new guard withholds and reports that
conflict instead of writing it.

9b. Re-run the script in dry-run mode a third time, on top of the fix-round-2
    changes, to confirm neither defect is live on the real workspace.

Expected: **identical numbers to step 9a** — both defects were verified
latent (not live) on the real workspace: the "already recorded" divergence
never triggers because all three recorded aliases are already normalised
fixed points; the Tier A/id-shape conflict never triggers because both real
auto-records (`lightning-dave -> lightning_dave` Tier A, `the-torment ->
the_torment` Tier B) already agree with their own live id-shape resolution.

Result: **RUN 2026-08-05** (same branch, dry run only, same invocation as
step 9a — `server/dist` unchanged, only the `.mjs` script and its tests
changed this round). **Identical to step 9a**: auto-recordable aliases
**2 (68 segments)**; skipped **3**; reported for human decision **91
ids/93 segments**; re-render candidates **23 rows/188 segments**. Confirms
both fix-round-2 defects are latent on this workspace today, as expected.

**Fix round 3 (independent review, 2026-08-05) found the round-2 fix's own
`historyResolver` default was fail-OPEN, closed:** an omitted resolver
defaulted to `{ resolve: () => undefined }` — but `planBookRepairs` no
longer reads `history.supersededBy` directly at all, so a caller that
omitted the resolver while passing a fully populated `history` got zero
protection from either the already-recorded skip or the round-2 conflict
guard, silently. Fixed the same way `cacheAvailable`'s own pre-#2093
fail-open default was fixed: default to building the real resolver from
`liveCast`/`history` (the identical construction `collectSegmentOrphans`
uses), so a missing `historyResolver` is a redundant optimisation for the
production path — which always threads the real one anyway — never a
correctness hole for any other caller. Also: the summary line now prints
the re-render list's segment total (`188`) alongside the row count (`23`),
which previously required summing every row by hand.

9c. Re-run the script in dry-run mode a fourth time, on top of the
    fix-round-3 changes, to confirm the fail-closed default doesn't move
    the real workspace's figures.

Expected: identical numbers to steps 9a/9b, now with the segment total
printed directly in the summary line instead of needing to be hand-summed.

Result: **RUN 2026-08-05** (same branch, dry run only, same invocation).
**Identical to steps 9a/9b**: `re-render candidates: 23 chapter row(s) /
188 segment(s)` (the new segment-total print, matching the hand-summed
figure from every prior run); auto-recordable aliases **2 (68 segments)**;
reported for human decision **91 ids/93 segments**; skipped **3**. Confirms
the fail-closed default is latent on this workspace today, as expected —
the production path in `main()` always threaded the real resolver through
explicitly, so this fix protects a future/test caller, not today's run.

### 8.7 Confirm the fix reaches actual audio

10. Re-render *Заказ Коалфолла* chapter 2 (the chapter carrying the
    `mayrin`/`coalfall` orphaned segments — see §7.2's evidence).
11. Read the fresh `segments.json`.

Expected: `characterSnapshots["mayrin"]` and `characterSnapshots["coalfall"]`
now exist, naming Мэйрин's and Коалфолл's own live voices — not the narrator.

Result: **NOT RUN as of 2026-08-05** — needs the 8 GB card with Qwen resident. Still owed; register row A30 stays open for this and §8.8.

12. **Listen.** Confirm both characters' lines are audibly distinct from the
    narrator, not merely a different id in the JSON.

Result (by ear): **NOT RUN as of 2026-08-05** — depends on step 10/11 above.

### 8.8 Cast-screen banner cross-check

13. Open the Cast screen for *Заказ Коалфолла* and *Everblaze*.

Expected: the auto-reconciled section names `mayrin`/`coalfall` (Заказ
Коалфолла) and `lady-alina` (Everblaze). The needs-your-decision section
still names the untouched ids — spot-check *Exile*'s `unknown-male` as the
negative control (a reserved-bucket source must still refuse to auto-record).

Result: **RUN 2026-08-21 (wave-4 step 5e, Castwright#2563).** PASS, live in
a real browser. *Заказ Коалфолла* Cast screen: the auto-reconciled bucket
("2 character ids auto-reconciled — audio is current") names `mayrin`
(Мэйрин, 8 segments) and `coalfall` (Коалфолл, 13 segments) exactly as
expected. Negative control: *Exile*'s `unknown-male` (21 segments) stayed
in the needs-your-decision list, unmoved. Everblaze's `lady-alina` half is
corroborated by the real `cast-id-history.json` file read directly, not by
a live Everblaze Cast-screen render (Everblaze was not one of the books
copied into this pass's throwaway workspace). Full evidence:
`docs/testing/onbox-wave4-results/step-5e-cast-screen-browser-rows.md`.

### 8.9 Outcome

- [x] §§8.4-8.6 run — **2026-08-05**, all PASS
- [x] §8.8 run — **2026-08-21** (wave-4 step 5e), PASS — see above
- [ ] §8.7 run — still owed (needs the GPU box + a listen)
- [x] Step 9a run — **2026-08-05**, PASS against the corrected expectation: re-render 23 rows/188 segments, auto-recordable 2/68, report-only 91/93, skipped 3 (unchanged)
- [x] Step 9b run — **2026-08-05**, PASS: fix-round-2's two guard fixes (resolver-delegated already-recorded check; Tier A/id-shape conflict veto) confirmed latent on the real workspace — identical numbers to step 9a
- [x] Step 9c run — **2026-08-05**, PASS: fix-round-3's fail-closed `historyResolver` default confirmed latent on the real workspace — identical numbers, segment total now printed directly (`23 rows / 188 segments`)
- [x] Step 9d run — **2026-08-05, round 1**, PASS against a REVISED expectation
  that round 2 review then found was itself wrong: a dry run after #2097 /
  #2135 / #2130 / #2134's FIRST fix reported auto-recordable **2/68 → 0/0**
  and report-only **91/93 → 93/161**, on the reasoning that guard 4's
  `'no-evidence'` outcome should withhold auto-record. **Round 2 review
  replayed `planBookRepairs` with `supersededBy` emptied and found that
  backwards**: `characterSnapshots` is written only for an id LIVE at
  render time, so its ABSENCE for an orphan means the narrator was
  substituted (the actual damage) and its PRESENCE means the audio is
  already fine — a veto on absence blocks exactly the aliases that fix
  real damage. The replay showed it would have blocked `mayrin`/`coalfall`
  (two of the three aliases already applied and accepted on this box) while
  passing the already-fine `lady-alina`. Reverted to an annotation
  (`'no-evidence'` now auto-records, carrying a "guard 4 not evaluable"
  note, rather than withholding).
- [x] Step 9e run — **2026-08-05, round 2**, PASS: fresh dry run after the
  round-2 fix reports figures IDENTICAL to the pre-#2134 baseline —
  re-render **23 rows / 188 segments**, auto-recordable **2 aliases / 68
  segments**, report-only **91 ids / 93 segments**, skipped **3** — all
  unchanged from step 9c, because round 1's veto and round 2's fix cancel
  out on this real data; what changed is the console annotation, not the
  write decision. Also verified: books with unreadable bak evidence **0**,
  books withheld for missing bak evidence **0** (#2135's gap not live on
  this workspace today), books scanned **20** (no drops from #2097's new
  `collectBooks` accounting either). See register row A30 for the full
  writeup, including round 2's five smaller fixes (`collectBooks`
  `Array.isArray` shape check, its `readdirSync` guard, the same shape
  guard in `collectBakNameEntries`, `planApplyRefusal`'s absent-field
  handling, and #2130's relocation into the server test suite).
- [x] Step 9f run — **2026-08-05, round 3**, PASS: round-3 review found
  #2097's own round-1/round-2 discriminator (`castExists || stateExists`,
  cleared by round 1's review as "sound") itself misclassified the ordinary
  mid-import/post-reparse shape — `state.json` present, `cast.json` not yet
  written — as `'unreadable'`, refusing `--apply` for the whole workspace
  over one freshly-imported, otherwise-healthy book. Fixed by judging each
  file independently (a genuinely missing file is never lost evidence; only
  a present-but-unreadable/wrong-shaped one is), pinned by a fixture using
  the exact shape `import.ts` writes. **Not live on the real workspace
  today** — none of the 20 books are mid-import — a fresh dry run reports
  figures identical to step 9e: re-render **23 rows / 188 segments**,
  auto-recordable **2 aliases / 68 segments**, report-only **91 ids / 93
  segments**, skipped **3**, books scanned **20**. See register row A30's
  round-3 correction for the full writeup.
- [x] Defects filed: [#2107](https://github.com/dudarenok-maker/Castwright/issues/2107) (re-render list drops aliased rows after `--apply` — **fixed, then widened, then hardened across three independent-review rounds** — `scripts/repair-cast-id-drift.mjs`; real-workspace re-confirmation done at steps 9a, 9b and 9c), [#2108](https://github.com/dudarenok-maker/Castwright/issues/2108) (a zero-book scan reports the same green summary as a clean one, and `--apply` exits 0 — **fixed**, PR #2102), [#2097](https://github.com/dudarenok-maker/Castwright/issues/2097) + [#2135](https://github.com/dudarenok-maker/Castwright/issues/2135) (evidence that can't be read must count as unknown, not clean — **fixed**, not live on this workspace; #2097's own discriminator itself misclassified an ordinary mid-import book and needed a round-3 correction, see step 9f), [#2130](https://github.com/dudarenok-maker/Castwright/issues/2130) (resolver tier rename would go undetected — **fixed**, then relocated at round 2 after review found the original fix couldn't fire in CI), [#2134](https://github.com/dudarenok-maker/Castwright/issues/2134) (guard 4/ranker inert on drifted ids — **fixed at round 1, found BACKWARDS by round 2 review, corrected to an annotation** — see steps 9d/9e)

Record what was observed, by whom, and when — here and in register row A30.
This is the first time the repair pass has ever written to the real
workspace; if anything here diverges from the dry-run numbers in §8.1, stop
and investigate before treating the run as clean — do not paper over a
discrepancy by re-running until the numbers happen to match.

---

## 9. #2128 — audio currency (`isAudioCurrent` / `castHistorySeq`)

> Register row: **A45 — discharged 2026-08-11, row removed from
> [`onbox-acceptance-register.md`](onbox-acceptance-register.md)** (owed 64 →
> 63, Group A 45 → 44). This section is the surviving record of the run.

### 9.1 Purpose & scope

Waves 1-3 above (§§1-8) resolve and report drift, but neither the Cast banner
nor the repair pass could tell "this row's rendered audio is current" apart
from "this row merely resolves" — a resolution that recovers via `'alias'` or
`'normalised'` carried the same "may still need a re-render" note forever,
even after the chapter behind it had actually been re-rendered. #2128 closes
that: a per-book monotonic `seq` counter on `cast-id-history.json`, a
`castHistorySeq` stamp written by every full-render `segments.json`, and one
shared predicate, `isAudioCurrent`, consulted by both the Cast banner and
`scripts/repair-cast-id-drift.mjs`. Every unit and route test drives a
synthetic fixture; this section is the proof that a real re-render against
the real workspace actually clears a row.

**Why the figure looks unchanged today.** `castHistorySeq` is written at
exactly one production site (`generation.ts`, added by this branch), so no
segments file in the existing workspace can carry it yet. Every real segment
therefore reads `'unknown'` → listed, reproducing the pre-fix output
exactly. A dry run reporting *fewer* rows before the steps below would mean
the unknown rule was inverted.

### 9.2 Preconditions

- [x] Real TTS sidecar running (or loadable) for the re-render in step 2 —
      not mock mode.
- [x] The real workspace is present, with `WORKSPACE_DIR`/`CACHE_DIR` set the
      same way §8.3 establishes for the repair script.
- [x] SHA and a clean tree recorded below.

SHA: `9d7894c7`  Clean tree: ☑  Date: `2026-08-11`  Run by: `dudarenok-maker (Claude Code)`

The server was started from the primary checkout at `9d7894c7`, which carries
`d658e932` (the #2128 merge) as an ancestor. That checkout was moved to
`022e830b` by a concurrent session mid-run; the two differ **only in docs**
(`git diff --name-only 9d7894c7 022e830b -- server/src scripts` is empty), so
the re-render and both dry runs exercised identical production code. Real
sidecar (pid 30076, `engines: [coqui, kokoro, qwen]`, `qwenInstallState:
ready`), real workspace at `WORKSPACE_DIR=C:\AudiobookWorkspace` — note the
script does **not** read `server/.env`, so it must be passed explicitly or it
defaults to `%USERPROFILE%\AudiobookWorkspace`, scans **0 books**, and prints a
full page of clean zeros. `server/dist` also had to be rebuilt first: it
predated `store/cast-audio-currency.js` and the script hard-fails without it.

### 9.3 Stamp, re-render, confirm the row clears

1. Run `node scripts/repair-cast-id-drift.mjs --apply` once. Confirm the
   console line `stamped cast-id-history recordedAtSeq on N book(s) (#2128
   one-shot)` appears, and that a book's `cast-id-history.json` gains a
   `recordedAtSeq` field it previously lacked. This sets `seq` to S+1 and
   every `supersededBy` key's marker to S+1.

Result: **PASS (2026-08-11).** Baseline dry run first: **23 chapter rows /
188 segments** — reproducing the pre-fix figure exactly, as §9.1 predicts.
`--apply` then printed `stamped cast-id-history recordedAtSeq on 4 book(s)
(#2128 one-shot)` — 4 being every book in the workspace that has a
`cast-id-history.json`. Verified against pre-run copies of all four files:
each previously held **only** `schema` + `supersededBy` (no `seq`, no
`recordedAtSeq`), and each now carries `seq: 1` plus a `recordedAtSeq` entry
for **every** `supersededBy` key — Заказ Коалфолла 2/2, Playing with Fire
2/2, Everblaze 1/1, Ночной дозор 4/4 — with a matching `recordedAtIso`. So
S was 0 and S+1 = 1. The `--apply` liveness rail also held: it is the reason
the server had to be stopped, and it refuses on its own rather than trusting
the operator.

2. Re-render **one** chapter named on the re-render list. That render stamps
   `castHistorySeq: S+1` into its segments file.

Result: **PASS (2026-08-11).** Re-rendered *Заказ Коалфолла* ch2 «Глава
первая — Стук» via `POST /api/books/:bookId/generation` with
`{modelKey: 'qwen3-tts-0.6b', chapterIds: [2], force: true}`. Completed
`audioEngines {qwen: 3, coqui: 1}`, `durationSec` 248.02, `audioQa.status:
ok` (LUFS −16.1, true peak −1.3 dB). Its `segments.json` went from
`castHistorySeq: ABSENT` to **`castHistorySeq: 1`** — equal to the book's
new `seq`, exactly S+1 as specified. **This book was chosen deliberately:**
it is the Castwright-owned fixture, so a real re-render costs nothing if the
audio changes, and it owns **two** rows on one chapter rather than one,
which tests "the re-rendered chapter's rows clear" harder than the minimum.

3. Re-run the dry run. **That chapter's row must disappear, and the segment
   total must drop by exactly that chapter's segment count, while every
   other row remains.**

Result: **PASS (2026-08-11), against a prediction registered before the
run.** Expected 23 → 21 rows and 188 → 167 segments (ch2's `mayrin` 8 +
`coalfall` 13 = 21). Observed **exactly** `re-render candidates: 21 chapter
row(s) / 167 segment(s)`. A line-by-line diff of the two re-render lists
shows **removed: exactly those two rows; added: none**; the other 21 rows
are byte-identical. Both halves of the criterion hold — the re-rendered
chapter's rows cleared, and nothing else moved.

**Refinement:** `'normalised-id'`-tier rows clear on **stamp presence
alone**, so they drop off after a re-render even without step 1;
`'history'`-tier rows need step 1 first.

**What step 1 additionally exercises.** It is the only path with no
automated coverage: `scannedBookDirs`'s end-to-end correctness inside a live
`main()`, and `mods.stampRecordedAtSeqIfAbsent`'s runtime resolution and
write behaviour. Every automated run to date was a dry run, which returns
before reaching them.

### 9.4 Outcome

- [x] §9.3 run — **2026-08-11, all three steps PASS.** Register row **A45
      discharged and removed** (owed 64 → 63, Group A 45 → 44).
- [x] Defects filed: **none.** Nothing in the loop misbehaved.

**Observed, by whom, when:** run end-to-end on the dev box 2026-08-11 by
dudarenok-maker via Claude Code, against the real workspace
(`C:\AudiobookWorkspace`, 20 books) and a real sidecar. 23/188 → `--apply`
(4 books stamped) → one real qwen re-render → 21/167, with the diff showing
only the re-rendered chapter's two rows gone.

**What this run additionally proved**, beyond the three numbered steps —
these are the paths §9.3's own note flags as having no automated coverage,
and they only execute inside a live `--apply`:

- `scannedBookDirs` is correct end-to-end inside a real `main()`: it stamped
  4 books, not 20 — i.e. the books that actually have a history file, not
  every scanned directory.
- `mods.stampRecordedAtSeqIfAbsent` resolves and writes at runtime, and is
  genuinely **if-absent**: the second dry run did not re-stamp or move any
  marker, and the four files still read `seq: 1`.
- The dry/apply split is real: the baseline and the final dry run both wrote
  nothing, and only the `--apply` mutated disk.

**Two traps worth recording for whoever runs §9 next**, both of which
silently produce a confident wrong answer rather than an error:

1. **The script does not read `server/.env`.** Without an explicit
   `WORKSPACE_DIR` it scans `%USERPROFILE%\AudiobookWorkspace`, finds **0
   books**, and prints a complete summary of zeros. It does warn — `books
   scanned: 0 — WARNING: … NOTHING WAS SCANNED` — but every figure under it
   still reads like a clean bill of health.
2. **`segments.json` records the engine only at file level.** Individual
   segments carry just `groupIndex`, `characterId`, `sentenceIds`,
   `startSec`, `endSec` — there is no per-segment `modelKey`. Grouping
   segments by `modelKey` therefore returns one silent empty bucket and
   proves nothing; read the file-level `modelKey`, or `state.json`'s
   `audioModelKey`/`audioEngines`, instead.

---

## 10. #2584 fix (PR #2640) — wrong-direction retirement, code-level fix

> Register row: A44 (Group A) in
> [`onbox-acceptance-register.md`](onbox-acceptance-register.md).

### 10.1 Purpose & scope

Wave 2 (§7, Wave-4 step 7 rerun) surfaced a defect that had not been caught at code review time: during a re-analysis of *Заказ Коалфолла*, the established ASCII character id `oduvan` was retired **in favor of** a freshly-minted Cyrillic id `одуван`, recorded as `"oduvan": "одуван"` in `cast-id-history.json` — backwards from the intended direction (fresh id retires onto the established one) and violating the invariant that character ids must remain ASCII kebab-case.

This took three attempts inside PR #2640. Attempt 1 (commit `90032fd6`) added survivor logic directly to `mergeCore`'s name-fallback in `server/src/store/merge-analysis-cast.ts`; a review pass found it broke the sentence-attribution cascade and let a reserved fold-bucket id become a name-fallback survivor. Attempt 2 (commit `2bd7b6ef`) reverted attempt 1 entirely, on the premise that `remapFreshToPriorIds`'s existing exact-name matcher already resolved the case unaided; a second review pass reproduced the real corruption end-to-end **in-process**, byte-identical to the box's own `cast-merges.json`, and falsified that premise. Attempt 3 (this fix) found and fixed the actual root cause described below.

**Actual root cause:** the real analyzer run minted THREE near-duplicate fresh candidate rows for the same character in one pass — raw ids `oduvan`, `owdovan`, `одуван`, all named "Одуван" (the analyzer's own non-determinism, unrelated to the established cast). `dedupeRosterByName` (`server/src/analyzer/roster-dedup.ts`) collapsed those same-run duplicates onto `одуван` as its own internal survivor — an arbitrary choice among fresh duplicates, with no knowledge of which id the established cast already considers stable. The resulting composed rewrite table (`composeRewrites(dd.rewrites, folded.rewrites)`) therefore contained `oduvan -> одуван` purely as a byproduct of fresh-side dedup — but `oduvan` also happens to be the established prior cast row's raw id, purely by coincidence. That one entry reached two downstream sites and both mishandled the coincidence: `remapFreshToPriorIds` (`server/src/store/remap-fresh-to-prior.ts`) read it as "already converged" and skipped, and `applyRewriteToPriorCast` (`server/src/store/merge-analysis-cast.ts`) applied it as a retirement — recording exactly the wrong-direction entry above.

The fix, `stripEstablishedAsciiRewrites` (`server/src/analyzer/roster-dedup.ts`), filters that narrow coincidence — an established ASCII prior id as the rewrite entry's key, a non-ASCII target as its value — out of the composed table before either site consumes it, at all four call sites in `server/src/routes/analysis.ts` (full-analysis and subset/per-chapter paths, each feeding both `remapFreshToPriorIds` and `applyRewriteToPriorCast`). With the offending entry stripped, `remapFreshToPriorIds`'s pre-existing exact-name matcher — untouched by this fix — correctly claims the case and cascades the fresh row and its sentences onto the established id, before sentence attribution is finalized. `mergeCore` in `merge-analysis-cast.ts` is untouched by this fix; it was never the right place, per attempt 1's outcome.

### 10.2 Fixture & owed hardware acceptance

The real, live-corrupted book: *Заказ Коалфолла* at `C:\AudiobookWorkspace\books\Castwright\Standalones\Заказ Коалфолла`.

**Current state on the box (2026-08-25):**
- `.audiobook/cast.json` carries `"id": "одуван", "name": "Одуван"` (Cyrillic id — the defect)
- `.audiobook/cast-id-history.json` carries `"oduvan": "одуван"` (the wrong-direction retirement, recorded 2026-08-21T07:47:44.959Z, seq 12)

**Owed acceptance:** re-analyse *Заказ Коалфолла* (a full manuscript re-analysis, not a subset/chapter re-analysis) against this existing history, and confirm:
1. The character's `cast.json` id comes back as `oduvan` (ASCII), not `одуван` (Cyrillic).
2. If the id changed at the raw-analyzer-output layer, it is recorded in `cast-id-history.json`'s `supersededBy` map with the **correct direction** (fresh → established).

This is the exact real reproduction this issue was filed from, still live on this box today — validating the fix requires a human or agent with real hardware access and a real analyzer (local Ollama, or Gemini). A full re-analysis through the real analyzer pipeline remains the only way to prove the fix end-to-end; nothing below substitutes for it, and register row A44 stays open until it runs.

### 10.3 Code-level proof (PR #2640, shipped)

- A real-shape unit test (`server/src/analyzer/roster-dedup.test.ts`, "#2584/#2570 real-shape regression") reproduces the reviewer's exact composed rewrite-table chain — `{"oduvan":"одуван","owdovan":"одуван"}` against a prior cast holding the established `oduvan` row — byte-identical to what was recorded on the real box's `cast-merges.json`, and drives it through both consuming functions (`remapFreshToPriorIds`, `applyRewriteToPriorCast`) with and without the fix, confirming it fails without `stripEstablishedAsciiRewrites` and passes with it.
- `remap-fresh-to-prior.test.ts` (in `server/src/store/`, not `merge-analysis-cast.test.ts`) still separately proves the exact-name matcher itself handles the simple case unaided — a baseline, not the whole proof, since it doesn't exercise the real collision that made the matcher's own "already converged" guard skip.
- `merge-analysis-cast.test.ts`'s F2 regression (reserved fold-bucket id never a name-fallback survivor via `mergeCore`) is untouched and still passes, since `mergeCore` itself is untouched by this fix.
- The narrowly-scoped bolt-on from attempt 1 (`mergeCore` in `server/src/store/merge-analysis-cast.ts`) was introduced and reverted within this same PR's history (commits `90032fd6` then `2bd7b6ef`) — not, as an earlier draft of this section claimed, part of PR #2633's merge commit.

Defects NOT filed: none. The fix is narrowly scoped (one new function, four call sites) and passes the full server test suite, including `analysis.test.ts`'s 220 tests.
