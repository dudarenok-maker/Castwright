# Cast/analysis characterId drift — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box, with a real sidecar (Wave 1), a real analyzer (Wave 2), or the
> repair script plus a real sidecar (Wave 3) and the real, already-affected
> book(s). Do not pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-08-01-cast-character-identity-design.md`](../superpowers/specs/2026-08-01-cast-character-identity-design.md)
> Plan of record: [`docs/superpowers/plans/2026-08-01-cast-character-identity.md`](../superpowers/plans/2026-08-01-cast-character-identity.md)
> Regression plan: [`docs/features/278-cast-character-identity.md`](../features/278-cast-character-identity.md)
> Register rows: [`onbox-acceptance-register.md` A32](onbox-acceptance-register.md) (Wave 1, §§1-6 below), [B3](onbox-acceptance-register.md) (Wave 2, §7 below), and [A33](onbox-acceptance-register.md) (Wave 3, §8 below)
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

> Register row: [`onbox-acceptance-register.md` B3](onbox-acceptance-register.md)

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

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

### 7.4 Before re-analysis — record the baseline

Read `.audiobook/cast.json` for *Заказ Коалфолла* directly.

Result (`cast.json` id for Мэйрин): ______________ (expect `mairin`)

Result (`cast.json` id for Коалфолл): ______________ (expect `coalfall-dragon`)

Result (`.audiobook/cast-id-history.json` present?): ______________ (expect: absent)

### 7.5 Re-analyse the book

Trigger a **full** re-analysis of *Заказ Коалфолла* (not a subset/chapter re-analysis — the early remap ships on both the main and subset paths, but only the main path is exercised by simply re-running analysis on an unedited manuscript). Let it complete.

### 7.6 After re-analysis — confirm the id was kept, or the change was recorded

Read `.audiobook/cast.json` and `.audiobook/cast-id-history.json` again.

Result (`cast.json` id for Мэйрин, still `mairin`?): ______________

Result (`cast.json` id for Коалфолл, still `coalfall-dragon`?): ______________

**If both ids are unchanged:** that is the primary proof — the early remap adopted the cast's existing ids instead of persisting whatever the analyzer minted this run, even though the analyzer is free (and was observed, on the run that produced the 21 already-orphaned segments) to mint a different string for the same character.

**If either id changed anyway** (the analyzer's output is non-deterministic in both directions — a match this run isn't guaranteed either): confirm `.audiobook/cast-id-history.json` now exists and its `supersededBy` map records an entry from the analyzer's fresh id to the cast's kept id (e.g. `"mayrin": "mairin"`) — proving the retirement went through `retireCharacterId` and was recorded, rather than silently dropped the way every pre-Wave-2 rebuild-from-field-list site did (design §4.1).

Result (history entry present and correctly directed, if applicable): ______________

Result (roster otherwise intact — still 13 characters, no duplicate row, no character silently renamed onto another's id): ______________

### 7.7 Outcome

- [ ] §§7.4-7.6 run
- [ ] Defects filed: ____________________________________

Record what was observed, by whom, and when — here and in register row B3. An id that happens to match this run's non-deterministic analyzer output is a weaker result than a genuine mismatch that gets correctly recorded — if the ids come back unchanged, note whether the analyzer's raw output (before the remap) could be inspected to confirm the remap actually did something, rather than the model simply reproducing `mairin`/`coalfall-dragon` on its own. **Do not run the Wave-3 repair pass against this book as part of this acceptance run** — this section is scoped to the early remap alone; Wave 3 has its own section (§8) below.

---

## 8. Wave 3 — the repair pass's `--apply` run

> Register row: [`onbox-acceptance-register.md` A33](onbox-acceptance-register.md)

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
  the actual damage figure.
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
see the callout below the Result for what changes once #2102 lands. **As
measured 2026-08-05 (pre-#2102), this precondition WAS satisfied and this
step WAS run** — see the Result immediately below, which is no longer
pending (the repo owner's decision, review round 2: *Unlocked* DOES have an
orphaned id, `unknown-male` with 34 segments, but guard 1 refuses to
auto-record from it as a reserved fold-bucket source before the cache gate
is ever reached, so it has nothing at stake and no longer blocks the
workspace run).

Result (console summary matches §8.1): **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS — exact match.** `mode: APPLY (writing cast-id-history.json)`; books scanned **20**; auto-recordable aliases **3 (27 segment(s))**; reported for human decision **93 id(s) / 161 segment(s)**; re-render candidates **17**; books missing analysis-cache evidence **0**.

> **Read that last figure against the right revision.** This run was made against `main` @ `f3d6ae0f`, i.e. the **pre-#2102** gate, where the cache-evidence count was global and `0` was the go/no-go. #2102 makes the gate honest and scopes the refusal per book, after which the expected output is `books missing analysis-cache evidence: 1` (*Unlocked* parses but names nobody) **plus a new `books with an auto-record withheld: 0`** — and it is that second line, not the first, that gates `--apply`. Do not read this PASS as "the first line must be 0" once #2102 lands.

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

Result: **2026-08-05, Claude Code session on the dev box (dudarenok-maker).** **PASS on the stated criteria, but it surfaced a defect.** Auto-recordable aliases **3 → 0**; skipped (already recorded) **0 → 3**; report-only **93 ids / 161 segments — unchanged**. The write is durable. **However** the re-render list moved **17 rows / 120 segments → 13 rows / 93 segments**: the 4 rows covered by the 3 new aliases (`mayrin` ch2 8 seg, `coalfall` ch2 13 seg, `lady-alina` ch55 4 seg + ch61 2 seg = 27 segments) dropped off it. That audio is still narrator-substituted on disk, and `buildRerenderRows`' own doc comment plus register row A33 both state the list is unconditional on auto-record status. Filed as [#2107](https://github.com/dudarenok-maker/Castwright/issues/2107).

**#2107 fix (`fix/scripts-2107-rerender-rows`):** `collectSegmentOrphans`'s
resolver reads `cast-id-history.json` off disk, and any id resolving via the
`'history'`/`'normalised-history'` tiers used to hit the same blanket
`continue` as a genuine `'exact'` live match — but both of those tiers depend
on `supersededBy`, which can gain an entry (as it just had, from this very
`--apply` run) strictly after the segment's audio was rendered. Fixed by
routing those two tiers into `orphans` instead. Pinned by a cross-run
regression test in `scripts/tests/repair-cast-id-drift.test.mjs`
(`buildOrphansFromSegments` describe block) that reproduces this exact
before/after-alias sequence over a synthetic fixture. **Not yet re-confirmed
against the real workspace** — see step 9a below, still owed.

9a. Re-run the script in dry-run mode again, now on top of the #2107 fix
    (`cd server && npm run build` off the fixed branch first).

Expected: the re-render list reads **17 rows / 120 segments** again — the
same figure as the original §8.1 measurement, no longer regressed to 13/93 —
while auto-recordable aliases, skipped, and report-only stay exactly as
measured in step 9 above (the fix only changes which ids land in the
re-render list, nothing else).

Result: **NOT RUN as of the #2107 fix landing** — needs a rebuilt
`server/dist` off the fixed branch and the real workspace; still owed (see
§8.9).

### 8.7 Confirm the fix reaches actual audio

10. Re-render *Заказ Коалфолла* chapter 2 (the chapter carrying the
    `mayrin`/`coalfall` orphaned segments — see §7.2's evidence).
11. Read the fresh `segments.json`.

Expected: `characterSnapshots["mayrin"]` and `characterSnapshots["coalfall"]`
now exist, naming Мэйрин's and Коалфолл's own live voices — not the narrator.

Result: **NOT RUN as of 2026-08-05** — needs the 8 GB card with Qwen resident. Still owed; register row A33 stays open for this and §8.8.

12. **Listen.** Confirm both characters' lines are audibly distinct from the
    narrator, not merely a different id in the JSON.

Result (by ear): **NOT RUN as of 2026-08-05** — depends on step 10/11 above.

### 8.8 Cast-screen banner cross-check

13. Open the Cast screen for *Заказ Коалфолла* and *Everblaze*.

Expected: the auto-reconciled section names `mayrin`/`coalfall` (Заказ
Коалфолла) and `lady-alina` (Everblaze). The needs-your-decision section
still names the untouched ids — spot-check *Exile*'s `unknown-male` as the
negative control (a reserved-bucket source must still refuse to auto-record).

Result: **NOT RUN as of 2026-08-05.** Partial evidence from the CLI only: the post-`--apply` dry run still reports *Exile*'s `unknown-male` as report-only with the reserved-fold-bucket refusal reason intact, so the negative control holds at the script level. The Cast-screen rendering of both sections has not been checked.

### 8.9 Outcome

- [x] §§8.4-8.6 run — **2026-08-05**, all PASS
- [ ] §§8.7-8.8 run — still owed (needs the GPU box + a listen)
- [ ] Step 9a (post-#2107-fix dry run confirms re-render list back to 17/120) — still owed (needs a rebuild off the fixed branch + the real workspace)
- [x] Defects filed: [#2107](https://github.com/dudarenok-maker/Castwright/issues/2107) (re-render list drops aliased rows after `--apply` — **fixed**, `scripts/repair-cast-id-drift.mjs`; real-workspace re-confirmation via step 9a still owed), [#2108](https://github.com/dudarenok-maker/Castwright/issues/2108) (a zero-book scan reports the same green summary as a clean one, and `--apply` exits 0)

Record what was observed, by whom, and when — here and in register row A33.
This is the first time the repair pass has ever written to the real
workspace; if anything here diverges from the dry-run numbers in §8.1, stop
and investigate before treating the run as clean — do not paper over a
discrepancy by re-running until the numbers happen to match.
