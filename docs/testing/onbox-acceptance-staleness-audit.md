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

**No row has been discharged by this audit. The register is unchanged.**

**Verdict counts (74 rows total):**

| Verdict | Count |
|---|---|
| STILL OWED | 69 |
| PROPOSE DISCHARGE | 0 (legitimate — no row's evidence cleared the artifact-plus-pasted-output bar) |
| SHRUNK | 2 |
| AMBIGUOUS | 3 |

**Counts and estimated box time per hardware prerequisite** (bucketed by the row's leading hardware phrase; rows whose field lists more than one prerequisite are grouped under "multi-hardware"):

| Hardware | Rows | Est. minutes |
|---|---|---|
| single 8 GB card | 39 | 830 |
| real workspace, no GPU | 12 | 465 |
| phone / Mac / browser | 5 | 90 |
| sidecar venv, no GPU | 4 | 75 |
| none / no GPU needed | 4 | 50 |
| real CJK manuscript | 3 | 50 |
| 2-card boot | 3 | 85 |
| GitHub Actions | 2 | 10 |
| Coqui/XTTS resident, ASR content-QA | 1 | 40 |
| Android device (+ CarPlay/Android Auto head unit for one item) | 1 | not estimated |

**Total estimated box time: 1695 minutes (~28.2 hours)** across the 72 rows carrying a numeric estimate. Two rows fall outside that total and are not batchable into it:

- **A1** — "multi-hour" (the row's own unchanged estimate; same box, no additional prerequisites beyond what's already counted for the rest of its family).
- **F1** — "not estimated in the plan — an entire untested axis, not batchable with any other group" (needs a real Android device, and for one item a CarPlay/Android Auto head unit).

**AMBIGUOUS rows — the operator's design-pass queue (3):**

- **A2** (Capacity-aware GPU placement, plan 264) — whether plan rows 6-8 count as already-exercised on-box, per the walkthrough section's declarative step wording and the header's own "S1/S2/S4/S6" claim, or as still-owed-and-deferred-by-choice, per the same header's closing sentence.
- **A16** (fe-16 Qwen auto-load on a Russian book, plan 165) — whether the plan is `active` (frontmatter) or `stable` (its own body line) — a direct self-contradiction in the plan file the audit is not authorised to resolve.
- **A22** (Real-corpus true-peak distribution, plan 274, feeds #1909) — whether #1909's closure ("no change," decided by subjective A/B listen) retires A22, or whether A22's real-corpus true-peak-vs-`QA_CLIP_TP_DB` observation remains independently owed.

**PROPOSE DISCHARGE rows — the operator's confirmation queue:** none. No row in this audit proposed a discharge.

### G1 · Quarantine-lane health report — first live dispatch (ops-32, #1864, PR #1873)

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

### G2 · The published release body now comes from the committed file, not the tag annotation (#2137, PR #2168)

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

### H1 · Kana-trigram richness gate holds at real-book scale for an all-kana (no kanji) Japanese manuscript (#2256 round 3, finding 3(b)/C5)

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

### H2 · Lexical-richness floor still clears on a FULL-LENGTH real Han (Chinese) book (#2256 round 4, finding B3)

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

### A1 · fs-38 Wave 3 — voice cloning (now incl. 3c) · 20 of 60 run (2026-07-29, 2026-07-31) · ~40 still owed · 3 run-2 results retracted

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

### A2 · Capacity-aware GPU placement (plan 264) · **two distinct debts**

- **Verdict:** AMBIGUOUS
- **Evidence:** `docs/features/264-vram-aware-gpu-placement.md` frontmatter
  `status: active` (`:2`). Header (`:9-22`) reads: "The manual
  **evict-under-contention** rows (6–8: cold `/load` steer, `design_voice`
  evicts Ollama, GPU-ASR 503→evict→retry) were **not** force-driven on-box —
  they rest on automated coverage for now," and closes "This plan flips to
  `stable` (and archives) once the evict-under-contention rows 6–8 are driven
  on-box." But the manual walkthrough section (`:129-179`) step 1 reads: "8 GB
  card alone, render a book → no OOM; if the analyzer is resident, a heavy
  synth (or a cold `/load` / `design_voice`) 503s → Node evicts Ollama (idle)
  → retries → succeeds" — worded as an executed observation, not a pending
  step, and step 6 (2-card cold `/load` steer) and step 7 (`design_voice`
  evicts Ollama) restate items 6–7 as still-numbered walkthrough steps with no
  internal "done" marker either way. Re-running the cited grep confirms a
  match, not a miss: `grep -n "S6" docs/features/264-vram-aware-gpu-placement.md`
  → `16:> (S1/S2/S4/S6 below). The manual **evict-under-contention** rows (6–8: cold`.
  The header's "S1/S2/S4/S6" is shorthand for walkthrough steps 1, 2, 4, and 6
  (S1→step 1, S2→step 2, S4→step 4 name the same analyzer/render-pressure
  synthesis-path steps as the walkthrough numbering), so S6 corresponds to
  walkthrough item 6 — it is not a distinct label from the "rows 6-8" the next
  sentence names. That means the header's own claim that S1/S2/S4/S6 were part
  of the exercised "on-box synthesis-path acceptance" directly contradicts its
  next sentence, which lists rows 6-8 (including item 6, the 2-card cold
  `/load` steer) as "not force-driven on-box." The register's original
  self-contradiction claim holds up: the header names step 6 as both exercised
  (via S6) and not-force-driven (via row 6-8) within the same paragraph.
  Separately, PR #1732
  ("fix(sidecar): keep every heavy-GPU op's device on its admitted card
  (#1730)") confirmed `state: MERGED`, `mergedAt: 2026-07-19T22:44:02Z` —
  matches the row's citation. Automated coverage confirmed real:
  `server/tts-sidecar/tests/test_placement.py`, `test_load_admission.py`,
  `test_footprints.py`, `test_devices.py` all exist; the plan's own text
  (`:105-127`) lists the matching Vitest/pytest suite. None of it substitutes
  for the owed on-box walkthrough per the plan's own gating sentence.
- **What changed since the row was written:** Nothing found in the plan text
  or PR history since the row's framing was written; #1732 remains merged and
  unconfirmed on-box exactly as the row states.
- **Remains owed:** Walkthrough step 9 (2-card cross-device-steer confirmation
  of #1730) unconditionally, regardless of how the 6-8 ambiguity resolves.
  Step 3 (eGPU fault-drop) stays observe-only/Blocked-N-A per the plan's own
  instruction. Steps 6-8 (evict-under-contention) status depends on the
  decision below.
- **Decision owed:** Whether plan rows 6-8 count as already-exercised
  on-box (per the walkthrough section's declarative step wording, and per the
  header's own "S1/S2/S4/S6" on-box synthesis-path acceptance claim) or as
  still-owed-and-deferred-by-choice (per the header's closing sentence listing
  rows 6-8 as not force-driven) is a single-sentence-resolvable disagreement
  inside the plan text itself that this audit is not authorised to settle; the
  header's own text confirms the register's original "S6 listed as both
  exercised and item-6-not-force-driven" self-contradiction — S6 is shorthand
  for walkthrough step 6 (S1/S2/S4 map to steps 1/2/4 the same way), and that
  step is named as both exercised (via S6) and not-force-driven (as row 6 of
  rows 6-8) in the same header paragraph.
- **Hardware still required:** 2-card boot
- **Est. box time:** 20 (step 9 alone, short); steps 6-8 (if owed) add ~15
  more on the single 8 GB card

### A3 · srv-57 Multi-GPU Wave 2 · **2-card boot**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1230 --repo dudarenok-maker/Castwright --json state,title,closedAt`
  → `{"closedAt":null,"state":"OPEN","title":"srv-57 — Multi-GPU Wave 2 — on-box
  acceptance + Task 16/16.5 auto-revert follow-up"}`. Issue body lists all ten
  checklist items as unchecked `- [ ]` boxes, matching the row's "ten unchecked
  items" count exactly, including per-card UUID confirmation, the
  `SIDECAR_VRAM_FREE_FLOOR_MB` starve-to-code-43 check, same-card vs
  different-card `QWEN_DEVICE`/`KOKORO_DEVICE` pinning, the two three-code-43-
  in-ten-minutes streak-guard variants (card-specific vs not), and the
  analyzer CPU/GPU serialization checks. Issue body confirms Task 16/16.5 is
  "deliberately excluded from Plan 2a (#1222, shipped 2026-07-03)... gated on
  item 1" — matches the row's framing verbatim. `test:sidecar` is called out
  in the issue body itself as "venv-gated so CI never exercises the real CUDA
  paths" for this checklist.
- **What changed since the row was written:** Nothing — issue #1230 is still
  open with all ten items unchecked.
- **Remains owed:** All ten checklist items in #1230, on a real 2-card boot;
  Task 16/16.5 remains unbuilt and gated on item 1 as stated.
- **Decision owed:** n/a
- **Hardware still required:** 2-card boot
- **Est. box time:** 45

### A4 · Audition engine + tier fidelity ([#1849](https://github.com/dudarenok-maker/Castwright/pull/1849))

- **Verdict:** STILL OWED
- **Evidence:** `gh pr view 1849 --repo dudarenok-maker/Castwright --json state,mergedAt,title`
  → `{"mergedAt":"2026-07-26T21:39:59Z","state":"MERGED","title":"fix(frontend,server):
  audition in the character's engine at the book's tier"}` — confirms the fix
  merged as the row states. No run sheet or issue references a subsequent
  on-box listening pass; this row's four listening checks (Kokoro-override
  preview, 1.7B-tier preview, instant-replay cache, Coqui-named capacity
  error) are not covered by any Playwright/Vitest suite located (all are
  audio-output/perceptual checks by construction — "never listened to" per
  the row is an accurate description of a fix verified only by tests and CI).
- **What changed since the row was written:** Nothing — no evidence of an
  on-box listening session since the PR merged.
- **Remains owed:** All four listening checks, on the real sidecar with
  Kokoro, Coqui and both Qwen tiers installed, plus VRAM pressure sufficient
  to force a genuine capacity refusal with Coqui resident.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A5 · fs-60 XTTS per-language engine eligibility (plan 249)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/249-fs60-xtts-language-eligibility.md`
  frontmatter `status: active` (`:2`); header (`:9`) reads "Live-GPU
  acceptance owed (mock-mode e2e only...)"; body (`:58`) states verbatim:
  "**Explicitly not covered — Live-GPU acceptance is owed.** The e2e spec
  above is mock-mode UI-seam + pill coverage only; the real render-time Coqui
  fallback... has not been exercised on an 8 GB box. This plan's status stays
  `active`, not `stable`, until that walkthrough runs." The five-step manual
  walkthrough (`:60-68`) matches the row's description exactly, and step 4
  is explicitly annotated "(real sidecar required)" in the plan text itself.
  `e2e/generation/coqui-fallback-non-english.spec.ts` exists and its own
  header comments (grepped) explicitly disclaim real-render coverage: "which
  mock-mode generation never calls," "out of scope here," "mock generation
  has no per-..." — confirming the plan's own claim that this is mock-only.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** All five walkthrough steps on a real sidecar, 8 GB-class
  GPU, a Russian book with an undesigned character, and the Chinese
  hard-block regression check.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A6 · Bulk voice-design recycle resilience (plan 200)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/200-bulk-design-recycle-resilience.md` Ship
  notes (`:104-115`): "Shipped to `main` 2026-06-10 in **274522d0**... Closes
  bug **#690**... Live-GPU acceptance (restart via `start-prod.bat` so the
  sidecar comes up with the correct `.env` ceilings) is the **only remaining
  check**." `gh issue view 690 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-06-09T21:29:55Z","state":"CLOSED",
  "title":"Design full cast halts after the first voice (sidecar recycle not
  recovered)"}` — closed, matching the row. No run sheet or subsequent commit
  references the forced-`/recycle`-mid-run walkthrough having executed.
- **What changed since the row was written:** Nothing — the row's own note
  that bugs #1156/#1532/#1557/#1570 exercised the flow informally is
  unchanged and still does not substitute for the specific forced-recycle
  walkthrough the ship notes gate on.
- **Remains owed:** The full "Design full cast" bulk run over a multi-voice
  cast on the 8 GB box with the sidecar started via `start-prod.bat`, plus a
  forced `/recycle` mid-run with confirmation the pill rides through the
  respawn.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A7 · Design full cast — bulk Qwen voice design (plan 195)

- **Verdict:** STILL OWED
- **Evidence:** `gh pr view 637 --repo dudarenok-maker/Castwright --json
  state,mergedAt,title` → `{"mergedAt":"2026-06-07T11:37:03Z","state":"MERGED",
  "title":"feat(frontend,server): Design full cast (bulk Qwen voice design)"}`;
  `gh pr view 638 ... ` → `{"mergedAt":"2026-06-07T11:57:28Z","state":"MERGED",
  "title":"docs(docs): fill plan 195 ship notes (date + commit SHA)"}` — both
  merged as the row states. `docs/features/195-design-full-cast.md` Ship
  notes (`:74-82`): "Shipped: 2026-06-07 · commit `7f0d5f4b`... Plan stays
  `active` — it flips to `stable` once the live-GPU acceptance below is
  signed off. **Live-GPU acceptance owed**... pill ticks + survives
  navigation; reload mid-run resumes the pill; rows flip; terminal
  ... summary; series propagation to a sibling book; VRAM headroom across a
  long run (VoiceDesign 1.7B + resident Ollama is the plan-108 OOM); a 2nd-tab
  single design is serialized... designed voices survive an attempted
  re-analysis (409)." — matches the row's list of checks, still phrased as
  owed, unedited by PR #638 beyond filling the SHA.
- **What changed since the row was written:** Nothing — the acceptance bullet
  in the ship notes remains open exactly as the row describes.
- **Remains owed:** All items in the ship-notes acceptance bullet: pill
  survival across navigation/reload-mid-run, terminal summary counts, series
  propagation, VRAM headroom across a long run, 2nd-tab serialization, and the
  409-on-reanalysis check.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 30 (a full bulk-cast run plus a sibling-book series check)

### A8 · GPU residency safety + coexistence (plan 222)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/222-gpu-residency-and-analysing-honesty.md`
  frontmatter `status: active`, `shipped: 2026-06-16` (`:2-3`); header
  (`:9`): "**on-box GPU acceptance owed** (real 8 GB eviction + 409 refusal +
  12/16 GB coexistence)." Manual walkthrough (`:54-59`) is titled
  "USER-RUN, live GPU — OWED" and lists the five steps the row describes
  verbatim (VRAM steady during analysis, eviction before generation, 409
  refusal under contention, eviction before voice design, no-eviction on
  12/16 GB). `gh pr view 840 --repo dudarenok-maker/Castwright --json
  state,mergedAt,title` → merged 2026-06-16T11:02:20Z, "evict resident Ollama
  before sidecar loads + safe keep_alive flip"; `gh pr view 841` → merged
  2026-06-16T11:02:59Z, "analysing-view model honesty + per-chapter section
  progress" — both match the GPU-residency/coexistence feature. **Finding
  (not routed, reported per #2435):** `gh pr view 839` → merged
  2026-06-16T11:29:25Z but titled "fix(server): tolerate stray model keys in
  analyzer schema validation," and its body (fetched) is about Ollama JSON
  schema salvage, unrelated to GPU residency/eviction — the register's PR
  list for this row (#839/#840/#841) appears to misattribute #839; #840 and
  #841 are the real match. This does not change the row's verdict since the
  walkthrough-owed statement is independently confirmed from the plan's own
  header and ship-notes text.
- **What changed since the row was written:** Nothing found regarding the
  walkthrough itself; the #839 citation discrepancy is a new finding, not a
  change in debt status.
- **Remains owed:** All five walkthrough steps, including the 12/16 GB
  coexistence check which needs a second, roomier card the 8 GB box alone
  cannot provide.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card | 2-card boot (step 5 alone
  needs a 12/16 GB card; steps 1-4 run on the 8 GB box)
- **Est. box time:** 25

### A9 · Batch the QA re-record loops (plan 228)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/228-batch-qa-rerecords.md` (`:95-100`):
  "## Acceptance (manual, on-box) — OWED / Regenerate a QA-flagging Qwen
  chapter... and confirm RTF lands near ~1.2 (down from ~1.9)... Deferred
  until the GPU box is free." `gh pr view 1072 --repo dudarenok-maker/Castwright
  --json state,mergedAt,title,body` → merged 2026-06-24T06:02:36Z, body's own
  final line: "On-box RTF acceptance (~1.2 target) to be confirmed on the next
  clean multi-chapter render." — matches the row's claim that the PR itself
  never asserted the RTF target was hit. `server/src/tts/synthesise-chapter-asr.test.ts`
  exists and covers the batching logic (round-based re-record batching,
  drop-on-recovery) but is a Vitest unit suite exercising mocked dispatch, not
  a real-sidecar RTF measurement — it does not discharge the on-box timing
  claim.
- **What changed since the row was written:** Nothing — no subsequent commit
  or run sheet records a real multi-chapter RTF measurement.
- **Remains owed:** A real regenerate of a QA-flagging Qwen chapter (e.g. KotLC
  "Chapter Three") with `SEG_ASR_ENABLED=1` and re-records at 2, measuring RTF
  against the ~1.2 target with the same suspect/asrSuspect flagging behaviour.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A10 · Per-character re-record / splice (plan 176)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/176-character-splice.md` frontmatter
  `status: active` (`:2`), body `> Status: active` (`:9`). Ship notes
  (`:53-59`) state the substantive scope (remix + re-record engine, route,
  cast-drawer UI, the fs-10 line-level Listen entry via `#480`) fully shipped
  but "Status remains `active` (not `stable`) until the owed **live-GPU
  re-record acceptance** runs." The 2026-07-24 correction section (`:61-93`,
  closes fs-10/`#412`) is a bug-fix + regression-pin round for the
  marker→segment index-alignment bug, not a live-GPU walkthrough — it adds
  four *automated* pin points (`chapter-audio.test.ts`,
  `resolve-segment-for-sec.test.ts`, `splice-chapter.test.ts:224`,
  `chapter-splice.test.ts` "fs-10 title-led index mapping"), all unit/route
  tests against fixtures, none touching a real sidecar. `gh pr view 500
  --repo dudarenok-maker/Castwright --json state,mergedAt,title` →
  `{"mergedAt":"2026-06-03T08:52:45Z","state":"MERGED","title":"feat(server,frontend):
  per-character re-record / splice (fs-26)"}` — matches the row. `gh issue
  view 412 --repo dudarenok-maker/Castwright --json state,title,closedAt` →
  `{"closedAt":"2026-07-24T03:23:40Z","state":"CLOSED","title":"fs-10 — Render
  the chapter-title segment on the Listen view timeline"}` — the fix that
  prompted the correction is closed, but closing the *bug* is not the same as
  running the *acceptance*. `e2e/character-splice.spec.ts` exists and is
  mock-mode only (`the mock api.streamSplice resolves…`, `:16`) — confirms
  the row's framing that no automated path substitutes for the live-GPU gain
  + re-record walkthrough.
- **What changed since the row was written:** The fs-10 index-alignment bug
  (which would have made a live re-record acceptance run land on the wrong
  line) is now fixed and pinned by four automated tests, so a future live
  acceptance run is less likely to trip over that specific defect. The debt
  itself — the live-GPU +3 dB gain and re-record walkthrough — is unchanged
  and still unrun.
- **Remains owed:** The full manual walkthrough per `:50-51`: rendered book →
  a character's profile → Fix audio → +3 dB gain across all chapters
  (louder, duration unchanged, `.previous.*` written, A/B works, ≈−16 LUFS),
  then re-record one chapter's lines (timing integrity, no seam, no doubled
  title), on the canonical manuscript.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A11 · Structured failure taxonomy (plan 173, fs-19)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/173-failure-taxonomy.md` frontmatter
  `status: active` (`:2`), body `> Status: active — automated coverage
  green; live multi-failure acceptance owed.` (`:9`). Ship notes (`:43-51`)
  confirm shipped commit `affa489`, closes `#469`, and state "**Owed:** live
  acceptance across ≥2 distinct real failure modes," followed by a
  description of later, unrelated work (analysis-path classification, fe-29
  Help deep-links) that extends the taxonomy's downstream consumers but does
  not touch the owed live-failure walkthrough. `gh issue view 469 --repo
  dudarenok-maker/Castwright --json state,title,closedAt` →
  `{"closedAt":"2026-06-03T00:28:08Z","state":"CLOSED","title":"fs-19 —
  Structured failure taxonomy + plain-language remediation"}` — closed as a
  dev-complete ticket, matching the row; closing the implementation ticket is
  not the acceptance itself. `server/src/routes/failure-taxonomy.test.ts`
  feeds captured error *strings* (a synthetic XTTS tensor error, a synthetic
  CUDA assert, a synthetic 429 body) — confirmed by the plan's own test-plan
  text (`:40`) — not a live sidecar kill or a real VRAM oversubscription.
- **What changed since the row was written:** Nothing found that touches the
  live multi-failure walkthrough; later plan-173 work only extended
  classification to the analysis path and added a Help-view deep-link
  consumer of the existing codes.
- **Remains owed:** Force ≥2 distinct real failure modes on the live sidecar
  — stop the sidecar mid-run (`sidecar-unreachable`) and oversubscribe VRAM
  (`vram-spill`) — and confirm the friendly message plus remediation line on
  both the Generate row and the toast.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A12 · Post-synthesis audio QA gate (plan 174, srv-27)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/174-audio-qa-gate.md` frontmatter
  `status: active` (`:2`), body `> Status: active — automated coverage
  green; live acceptance owed.` (`:9`). Ship notes (`:38-40`): "Shipped on
  `feat/server-generation-quality`... commit `84a45ff`. Closes #465...
  **Owed:** live acceptance with a deliberately degraded render." `gh issue
  view 465 --repo dudarenok-maker/Castwright --json state,title,closedAt` →
  `{"closedAt":"2026-06-03T00:28:04Z","state":"CLOSED","title":"srv-27 —
  Post-synthesis audio QA gate"}` — closed as dev-complete, matching the row.
  `server/src/tts/audio-qa.test.ts` (per the plan's own test-plan text,
  `:35`) crafts near-silent/clipped/truncated/runaway cases as *numeric
  fixtures* fed straight to `evaluateChapterQa`, not a real degraded audio
  file run through the actual synthesis + loudnorm pipeline.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Craft a near-silent / clipped / truncated chapter on the
  real sidecar and confirm the amber "Suspect" badge appears on both the
  Generate row and the Listen row, per the plan's own manual test-plan line
  (`:36`).
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A13 · Per-run resource telemetry + admin trend panel (plan 175, fs-20)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/175-resource-telemetry.md` frontmatter
  `status: active` (`:2`), body `> Status: active — automated coverage
  green; live acceptance owed.` (`:9`). Ship notes (`:42-44`): "Shipped on
  `feat/server-generation-quality`... commit `ee22859`. Closes #470...
  **Owed:** live acceptance after a multi-chapter run on the GPU box." `gh
  issue view 470 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-06-03T00:28:10Z","state":"CLOSED",
  "title":"fs-20 — Per-run resource telemetry log + trend view"}` — closed as
  dev-complete, matching the row. The plan's own architectural-impact notes
  (`:22,27-28`) describe two later polish rounds (2026-06-07 `bookTitle`
  grouping/scroll fix, 2026-07-06 QA column + column-alignment fix) — both
  are UI/data-shape fixes confirmed by Vitest/Playwright per the test plan
  (`:39`), not a live multi-chapter GPU run; `e2e/admin.spec.ts` is
  explicitly described as using "the mock's value" for the QA column.
- **What changed since the row was written:** Two rounds of polish landed
  (per-book grouping/scroll, QA column + alignment fix) since the row's
  framing, all covered by mock-mode/unit tests only — neither substitutes
  for the owed live multi-chapter run the ship notes still gate on.
- **Remains owed:** A real multi-chapter run on the GPU box, then confirm
  `#/admin` → "Resource trends" shows RTF / QA / VRAM / wall-time rows and
  the sparkline actually tracks RTF.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A14 · Qwen VoiceDesign persona-prompt rewrite (plan 160) · **oldest debt here**

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/160-voicedesign-persona-format.md`
  frontmatter `status: active` (`:2`), body `> Status: active — code
  shipped, GPU audition validation owed to the user` (`:9`). Ship notes
  (`:132-136`) are still the unfilled placeholder: "(Filled in when status
  flips to `stable` after the GPU audition confirms the quality delta.
  Append shipped date + commit SHA, then move to `docs/features/archive/`.)"
  — no shipped date or SHA recorded, matching the row's framing exactly.
  `git log --oneline -- docs/features/160-voicedesign-persona-format.md`
  shows commit `0a2f8bd8` ("feat(server): align Qwen voice-design persona
  prompt with official VoiceDesign format (plan 160)") plus a later
  2026-06-16 follow-up ("make age audible," `ca4b4a93`) that is itself
  framed in the plan text (`:108-130`) as landing from a *manual demo-book
  audition* that surfaced the age-acoustics gap — i.e. someone did listen at
  least once informally, but the plan's own text does not treat that as
  discharging the acceptance walkthrough: it stays a "Follow-up," the
  Ship-notes placeholder is unchanged, and the walkthrough's own step 2
  ("Design voice → audition. Compare against a character still on an
  old-format persona") specifically calls for an A/B against the old format,
  which the informal fix-driving audition did not do. Automated coverage
  (`server/src/analyzer/voice-style.test.ts`, cited `:80-86`) asserts prompt
  *text* contains the right words (pitch, purpose clause, objective-quality
  language, word-count band) — it cannot assert the rendered audio actually
  sounds different, which is the entire point of the row.
- **What changed since the row was written:** The 2026-06-16 age-audibility
  follow-up is new since the plan's initial framing and is genuinely informed
  by a live listen, but it addresses a narrower defect (age not translated to
  acoustics) found informally, not the full three-step walkthrough
  (regenerate persona → design → audition → A/B against old format) the plan
  itself still lists as owed.
- **Remains owed:** All three walkthrough steps in `:88-98`: regenerate a
  persona and confirm it hits the pitch/purpose-clause format; design voice →
  audition, compared against a character still on the old-format persona,
  confirming the new wording changes the rendered voice; confirm an
  un-regenerated character's existing designed voice is unaffected.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A15 · A/B "current vs proposed" voice audition (plan 161)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/161-voice-design-compare.md` frontmatter
  `status: active` (`:2`), body `> Status: active — code shipped, GPU
  audition validation owed` (`:9`). Ship notes (`:117-121`) are the same
  unfilled placeholder pattern as A14: "(Filled in when status flips to
  `stable` after the GPU audition confirms the non-destructive re-design +
  the audible delta...)" — no shipped date or SHA. `git log --oneline --
  docs/features/161-voice-design-compare.md` shows one commit,
  `6fb41b7a` ("feat(frontend): A/B current-vs-proposed voice audition in the
  Qwen design flow (plan 161)") — no later commit revisits the file, so
  nothing has moved since. Automated coverage (`:76-98`) is extensive
  (Vitest unit + route + Playwright e2e) but every listed suite is mock-mode
  or mocked-dispatch; the pytest sidecar suite (`test_qwen_evict.py`) is
  explicitly flagged in the plan's own text as "venv-gated → CI skips; runs
  on a bootstrapped dev box," i.e. it exercises the evict *endpoint*
  mechanics, not an audible A/B delta.
- **What changed since the row was written:** Nothing found — no commit
  since the initial landing touches this plan file or its acceptance state.
- **Remains owed:** All four manual walkthrough steps in `:100-109`: the A/B
  modal opens with current on Side A / proposed on Side B; edit persona on
  Side B → re-design → audition again; Cancel after a re-design leaves the
  live `.pt` byte-for-byte untouched (only `-preview` artifacts written then
  discarded); "Use proposed voice" → Save → generate a chapter confirms the
  new voice is actually used. Directly downstream of A14 — the plan's own
  text recommends running them together.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A16 · fe-16 Qwen auto-load on a Russian book (plan 165)

- **Verdict:** AMBIGUOUS
- **Evidence:** `docs/features/archive/165-fe-15-16-language-and-revision-e2e.md`
  frontmatter `status: active` (`:2`) directly contradicts its own body
  `> Status: stable (shipped together; manual acceptance owed only for the
  live Qwen auto-load)` (`:9`) — confirmed by direct read, not just the
  register's paraphrase. Ship notes (`:103-108`): "Shipped 2026-06-01 on
  branch `feat/frontend-fe-15-16` (PR pending)... fe-16 Qwen auto-load is
  wired and unit-covered; live GPU acceptance is the only owed item." No PR
  number is filled in anywhere in the file — "(PR pending)" is still literal
  text, not a placeholder later replaced. `git log --oneline --
  docs/features/archive/165-fe-15-16-language-and-revision-e2e.md` shows the plan
  was renumbered from 163 (`6ed2fb8d`, "renumber fe-15/16 plan 163 -> 165")
  but no subsequent commit revisits acceptance state or fills the PR number.
  Automated coverage (`src/views/cast.test.tsx`, cited `:76`) asserts "Qwen
  auto-loads when installed" against a mocked install probe — mock-mode
  only, does not reach a real Qwen load or a real analyzer eviction.
- **What changed since the row was written:** Nothing found regarding the
  live-GPU walkthrough itself.
- **Remains owed:** Open a real Russian book's cast view and confirm the
  Qwen banner shows and Qwen auto-loads with the analyzer evicted (walkthrough
  step 4, `:94-95`), on real hardware.
- **Decision owed:** Whether this plan is `active` (per frontmatter, meaning
  the whole plan is still open work) or `stable` (per its own body line,
  meaning only the live-GPU item remains) is a direct self-contradiction in
  the plan file itself, which this audit is not authorised to resolve — a
  human must pick the correct frontmatter value and, separately, decide
  whether "PR pending" with no PR number anywhere in the file is itself a
  second, unrelated staleness problem worth routing.
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 15

### A17 · Emotion-chip preview from the manuscript (plan 180, fe-31)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/180-fe31-emotion-chip-preview.md`
  frontmatter `status: active` (`:2`), body `> Status: active` (`:9`), and
  Ship notes (`:55-57`) still read the bare placeholder "(Filled in when
  status flips to `stable`.)" — no shipped date, no commit SHA, confirming
  the row's "Ship notes still a placeholder — no shipped date recorded."
  Body text (`:48`) states verbatim: "**Live GPU acceptance owed:** the
  audible difference between a designed variant and the base voice can only
  be confirmed on a real sidecar (CI has no sidecar venv). Mock mode proves
  the wiring + cache-scope selection only." `e2e/manuscript-emotion-preview.spec.ts`
  exists (per the plan's own test-plan text, `:39`) and runs "in the
  manuscript view (mock mode)... assert the sample `play()` path fires and
  no error note surfaces" — confirmed mock-mode-only, asserting the play
  call fires, not that the audio differs.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** The full manual walkthrough in `:41-46` (mock-mode steps
  1 and 3-4 are already covered by the e2e spec; step 2 — flip the speaking
  character to Qwen with a designed `angry` variant and confirm the ▶
  preview audibly plays the designed variant, not the base voice — is the
  live-GPU step and is unrun), plus the plan's own explicit live-GPU
  acceptance line (`:48`): confirming an audible difference between a
  designed variant and the base voice on a real sidecar.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A18 · Device-pin resolution survives a respawn ([#1870](https://github.com/dudarenok-maker/Castwright/pull/1870), closes [#1857](https://github.com/dudarenok-maker/Castwright/issues/1857)) · **2-card boot**

- **Verdict:** STILL OWED
- **Evidence:** `gh pr view 1870 --repo dudarenok-maker/Castwright --json state,mergedAt,title` →
  `{"mergedAt":"2026-07-27T01:53:26Z","state":"MERGED","title":"fix(server,sidecar):
  deterministic device env for the sidecar; codec knob resolves UUID pins"}`.
  `gh issue view 1857 --repo dudarenok-maker/Castwright --json state,title,closedAt` →
  `{"closedAt":"2026-07-27T01:53:27Z","state":"CLOSED","title":"GPU device-list cache is
  never warmed unless Advanced settings is opened"}`. `server/src/tts/sidecar-env.test.ts`
  exists and covers `buildSidecarEnv` at unit level. The row's own text (register.md:825-827)
  states the behaviour was "Verified by unit tests and CI; **never watched on real cards**,"
  and names the respawn-after-enumeration-change case as "the regression the change exists to
  prevent" — precisely the part no CI test can reach.
- **What changed since the row was written:** Nothing found. The PR merged and the issue
  closed before this row was written (2026-07-27), and no later commit, run sheet, or
  register annotation records a real two-card respawn test.
- **Remains owed:** All four on-box bullets in register.md:829-842 — pin-survives-respawn,
  pin-survives-enumeration-reorder, codec pin actually lands on the named card, and
  codec pin against an absent card falls back to CPU rather than `auto`'s GPU choice.
- **Decision owed:** n/a
- **Hardware still required:** 2-card boot
- **Est. box time:** 20

### A19 · Mixed Qwen+Coqui evict fails soft ([#1893](https://github.com/dudarenok-maker/Castwright/issues/1893)) · **single 8 GB card**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1893 --repo dudarenok-maker/Castwright --json state,title,closedAt`
  → `{"closedAt":"2026-07-27T23:44:24Z","state":"CLOSED","title":"srv — fs-60's trailing
  coqui-for-qwen VRAM evict has no failure isolation"}`. `gh issue view 1898` (the criteria
  issue cited in register.md:930) → `{"closedAt":"2026-07-27T23:44:23Z","state":"MERGED",
  "title":"fix(server): fail soft when the mixed-phase Qwen evict fails"}`. The row's own
  2026-08-01 correction block (register.md:879-908) is the authoritative current state: a
  **quiet-box** rerun of the ordinary (non-forced-evict) mixed Qwen+Coqui chapter completed
  71/71 with both engines resident at 3.7 GB combined — comfortably inside 8 GB — reversing
  the earlier 2026-07-31 OOM observation, which the correction attributes to a foreign
  process (another worktree's real-GPU Qwen pytest suite) holding cuda:0, not to a card-size
  limit. The block's own conclusion, verbatim: "**So A19's question is still entirely open**
  — the unforced case does not reliably spill on an 8 GB card... Caveat in the other
  direction: our own peak across a 1,588-sample trace was 6,727 MB... which on an 8 GB card
  leaves little headroom." The block further records a **box policy change since 2026-08-01**
  pinning renders to the 16 GB card via `server/.env` (`COQUI_DEVICE=cuda:1` /
  `QWEN_DEVICE=cuda:1` / `ASR_DEVICE=cuda:1`), and states explicitly: "A19's forced-evict run
  must temporarily undo those pins, or it will not exercise the single-8 GB-card scenario
  this row is about." `server/.env` is git-ignored and not present in this worktree, so its
  current pin state cannot be verified from the repo alone.
- **What changed since the row was written:** Two real on-box datapoints were gathered
  (2026-07-31 and 2026-08-01) but neither exercises the row's actual scenario — a *forced*
  evict failure. The 2026-08-01 correction explicitly retracts the 2026-07-31 reading and
  leaves the row's central question open. A box-level env pin change (2026-08-01) now sits
  between any future run and the 8 GB card, and must be temporarily undone to run this row.
- **Remains owed:** The forced-evict scenario itself (register.md:910-923) — proxy or stub
  `POST /unload` to 500, confirm the chapter completes with the
  `fs-60 Qwen→Coqui evict failed; continuing into the Coqui phase` log line, and classify the
  outcome as clean completion / self-describing sidecar OOM / crash-recycle-storm. Also the
  pause-during-stalled-evict abort check (register.md:922-923). The `server/.env` device
  pins must be temporarily reverted first.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A20 · Idle Coqui is reclaimed under VRAM pressure ([#1894](https://github.com/dudarenok-maker/Castwright/issues/1894)) · **single 8 GB card**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1894 --repo dudarenok-maker/Castwright --json state,title,closedAt`
  → `{"closedAt":"2026-07-28T05:48:34Z","state":"CLOSED","title":"srv — fs-60's Coqui VRAM
  residency is never evicted after the last Coqui chapter"}`. `gh issue view 1921` (the Stop
  control fix referenced in register.md:961-963) → `{"closedAt":"2026-07-28T11:27:04Z",
  "state":"CLOSED","title":"Stop during a Coqui render reports a 2s timeout, then unloads
  anyway"}`. `server/tts-sidecar/main.py:7829-7849` confirms `_COQUI_IDLE_TTL_DEFAULT = 30.0`
  is still the shipped default, matching the row's stated "30 s TTL" with no evidence it was
  ever retuned against real chapter gaps. No run sheet, register annotation, or ship-notes
  entry records any of the row's four on-box bullets (pinned-card admission test, idle-TTL
  tuning observation, Stop-during-Coqui-render behaviour) having been exercised on real
  hardware — unlike A19, this row carries no dated observation block at all.
- **What changed since the row was written:** Nothing found beyond the two cited issues and
  #1921 merging (2026-07-28), all of which predate the row and are already reflected in its
  text ("Since #1921, `POST /api/sidecar/unload` carries its own 90 s budget").
- **Remains owed:** All four bullets in register.md:941-967 — the pinned-card
  `CUDA_VISIBLE_DEVICES=0` admission test (idle Coqui reclaim actually admits a blocked Qwen
  op), the mixed-book evict/reload-cycle observation to validate or retune
  `COQUI_IDLE_TTL`, and the Stop-button-during-Coqui-render behaviour/timing observation.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 25

### A21 · Real-book QA/badge agreement after the loudness measurement hoist (plan [274](../features/archive/274-loudness-measurement-provenance.md), [#1922](https://github.com/dudarenok-maker/Castwright/issues/1922), [#1923](https://github.com/dudarenok-maker/Castwright/issues/1923))

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/archive/274-loudness-measurement-provenance.md` frontmatter
  `status: stable`, `shipped: 2026-07-29` (`:2-3`); Ship notes (`:975-995`) confirm T1-T10
  landed exactly as designed and record on-box rows A21-A23 as registered but explicitly
  state "none block this merge" (`:995`) — i.e. shipping did not require running them.
  `gh issue view 1922` / `gh issue view 1923` both `CLOSED` `2026-07-29T22:43:34Z`. Plan §6
  (`:856-864`) names A21's exact criterion: "for every chapter, the Suspect badge's true-peak
  reason (when present) and the Listen-view loudness badge's dBTP figure quote the same
  number." The only real-hardware render found in the repo's history since is #1909's
  closing A/B (2026-07-31, 4-pass real cast render measured with independent `ebur128`), but
  that comparison measured LRA/gain-delta between two loudnorm treatments for a listening
  test — it did not check or report Suspect-badge-vs-Listen-badge dBTP agreement.
- **What changed since the row was written:** Nothing found that discharges this specific
  observation; the only adjacent real-render evidence (#1909's A/B) answers a different
  question.
- **Remains owed:** A full multi-chapter real-book render with per-chapter confirmation that
  the Suspect badge's true-peak reason and the Listen-view dBTP figure agree, per plan 274
  §6 row 1.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 10

### A22 · Real-corpus true-peak distribution (plan [274](../features/archive/274-loudness-measurement-provenance.md)) · feeds [#1909](https://github.com/dudarenok-maker/Castwright/issues/1909)

- **Verdict:** AMBIGUOUS
- **Evidence:** `gh issue view 1909 --repo dudarenok-maker/Castwright --json state,title,closedAt`
  → `{"closedAt":"2026-07-31T08:24:47Z","state":"CLOSED","title":"srv — loudnorm rides
  syllables on most chapters: linear requested, dynamic applied"}`. The closing comment
  (2026-07-31T08:24:45Z) reads: "**Verdict: the current pipeline is preferred. Closing
  without a code change.**" — a 4-pass real cast render A/B (dynamic vs. linear+alimiter),
  judged by the repo owner listening, decided to keep the current loudnorm mode/target/
  ceiling as-is. The row's own text (register.md:997-999) frames its purpose as feeding
  "#1909's ceiling/mode question," and states Decision 3 of plan 274 "deliberately left
  `QA_CLIP_TP_DB` untuned... once #1909 settles the ceiling/mode question." #1909 has now
  settled that question (no change), but the #1909 closure evidence measured LRA/gain-delta
  for a listening comparison, not the per-chapter true-peak spread against `QA_CLIP_TP_DB`
  that A22 specifically asks for (register.md:1001-1003).
- **What changed since the row was written:** The issue A22 was written to feed (#1909) is
  now closed, and closed with a decision (no mode/ceiling/target change) rather than left
  open pending A22's data.
- **Remains owed:** A22's literal on-box criterion — recording the measured `tp` spread per
  chapter across a real book render and confirming whether any chapter approaches the
  `-0.1` dBTP clip threshold — has still never been run.
- **Decision owed:** Whether #1909's closure ("no change," decided on different evidence —
  a subjective A/B listen, not a `tp`-per-chapter distribution) retires A22 as no-longer-
  needed, or whether A22's real-corpus `tp` observation remains independently owed for any
  future `QA_CLIP_TP_DB` retune now that #1909 is no longer a blocker on it.
- **Hardware still required:** single 8 GB card
- **Est. box time:** 10

### A23 · Measurement-failure path renders as untrusted, not as a fabricated reading (plan [274](../features/archive/274-loudness-measurement-provenance.md))

- **Verdict:** STILL OWED
- **Evidence:** Plan 274 §6 row 3 (`:869-872`): "A chapter whose `ebur128` pass fails renders
  as untrusted, not as `-1.5`-measured... Hard to force naturally, T6 covers it at unit
  level, this row confirms on real hardware." Ship notes (`:975-995`) record no on-box run
  of this row; it is listed among A21-A23 as registered but not blocking the merge. No later
  run sheet, register annotation, or issue comment records a real `ebur128` failure being
  caught or forced during a live render.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** The entire opportunistic observation — catch or force a real-render
  `ebur128` failure and confirm the sidecar carries `measurementSource: 'loudnorm'` with
  both the Listen-view badge and the report-card row showing "No measurement" rather than a
  fabricated figure.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 10 (opportunistic — no dedicated session; ride along with any real render)

### A24 · A cloned voice renders a non-English book in the book's language (plan [275](../features/275-clone-voice-language.md), [#1951](https://github.com/dudarenok-maker/Castwright/issues/1951))

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/275-clone-voice-language.md` frontmatter `status: active`
  (`:2`) — not yet `stable` (`:401-402`: "**Not yet `stable`**... register row A24 is only
  partly discharged"). `gh issue view 1951` → `CLOSED` `2026-07-30T04:26:44Z` (the shipped
  fix). The row's own 2026-07-31 correction block (register.md:1027-1061) withdraws the
  chapter-level claim and names two blockers: `gh issue view 1972` →
  `{"closedAt":"2026-07-31T09:45:45Z","state":"CLOSED","title":"Splice picks target segments
  from segments.json but resolves their voices from the analysis cache — stale attribution
  renders a character in another character's voice"}`, fixed by PR #1992 (merged
  2026-07-31T09:45:44Z, "refuse a splice when the render and analysis disagree on a
  segment's owner"); and `gh issue view 1969` →
  `{"closedAt":"2026-08-16T03:56:07Z","state":"CLOSED","title":"Reassigning a character's
  voice keeps scoring it against the old voice's persisted audition centroid"}`, fixed by PR
  #2402 (merged 2026-08-16T03:56:05Z, "rebuild the audition centroid when a character's
  voice is reassigned"). Both blockers named in the row's correction are now resolved in
  code. Neither resolution is itself an on-box observation, though: plan 275's own Ship
  notes (`:407-456`) record Step 2 (designed self-heal → restart → identical) and Step 3 /
  C-17 as "**NOT RUN**," and no later run sheet or register annotation records a rerun of
  the chapter-level criterion, the self-heal/restart check, or the QA voice-mismatch
  sub-check on real hardware since #1972 and #1969 landed.
- **What changed since the row was written:** Both code blockers the correction block named
  (#1972, #1969) are now merged and closed — #1969 as recently as 2026-08-16, two days
  before this audit. That removes the two reasons the correction gave for the chapter-level
  and QA-sub-check portions being unrunnable/invalid, but no on-box rerun exploiting the
  fixes has happened yet.
- **Remains owed:** Re-run the chapter-level criterion (a non-English chapter with a cloned
  voice, transcribed via Whisper auto-detect) now that #1972 no longer corrupts splice
  attribution; the designed-self-heal → sidecar-restart → identical-output check (Step 2,
  still NOT RUN); Step 3 / C-17 (still NOT RUN); and the QA `voice-mismatch` sub-check on the
  cloned character, now that #1969's centroid-rebuild fix is in place.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 30 (one chapter render plus a sidecar restart, per plan 275's own
  estimate)

### A25 · `/health` stays live through a contended eviction on the default Qwen path (plan [273](../features/archive/273-sidecar-lock-event-loop.md), [#1919](https://github.com/dudarenok-maker/Castwright/issues/1919)) · **single 8 GB card**

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/archive/273-sidecar-lock-event-loop.md` frontmatter
  `status: stable`, `shipped: 2026-07-31` (`:2-3`); Ship notes (`:1006-1056`) confirm T1-T8
  landed as designed (commits `0245e4b7` through `89799cdf`) and record "On-box acceptance
  row A25 recorded... does not block this merge; run sheet at
  `docs/testing/sidecar-evict-latency-onbox-acceptance.md`" (`:1054-1056`). `gh issue view
  1919` → `{"closedAt":"2026-07-31T00:32:59Z","state":"CLOSED","title":"an idle-evict that
  loses the race to a starting forward blocks the sidecar event loop"}`. The run sheet
  `docs/testing/sidecar-evict-latency-onbox-acceptance.md` §5 "Result" section (`:72-77`) is
  entirely unfilled: `**Maximum /health inter-response gap:** _(fill in, ms)_`,
  `**Second admission outcome (fit vs. noCapacity):** _(fill in)_`,
  `**Run by:** _(fill in)_ **Date:** _(fill in)_`, `**Optional ASR pass run?** _(yes/no...)_`
  — a template with no data entered, confirming the run has not happened. The row's own text
  (register.md:1107-1111) states automated tests prove the eviction step runs off the loop
  but explicitly cannot prove `/health` stays responsive under a real contended lock.
- **What changed since the row was written:** The underlying code shipped and #1919 closed
  (2026-07-31), and a follow-up plan-273 gap (three more Qwen in-lock-cold-load sites) was
  separately found and fixed via PR #1968, #2019, #2064 (merged through 2026-08-01) — but
  none of that is an on-box `/health`-latency measurement, which is what this row asks for.
- **Remains owed:** The entire run-sheet procedure — warm-resident Qwen VoiceDesign, an
  in-flight Qwen chapter render, a concurrent second admission on the same card, and a
  `GET /health` poll throughout to record the maximum inter-response gap and confirm the
  second admission actually succeeds rather than 503-ing `noCapacity`.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A26 · Cloned-voice derive on Coqui no longer needs torchcodec ([#1967](https://github.com/dudarenok-maker/Castwright/issues/1967)) · **single 8 GB card + a real static-FFmpeg box; item 4 needs a Pinokio install**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1967` → `{"closedAt":"2026-07-31T06:06:03Z","state":"CLOSED"}` — matches the row's own claim that #1967 is merged. The register's own prose (register.md:1143) already marks items 1 and 3 DISCHARGED 2026-07-31 with pasted command output for both; that is not re-litigated here. Item 2 (register.md:1173) still names an unrun step — "derive the same cloned voice with and without the `patched_xtts_load_audio()` wrap on a shared-FFmpeg box" — with no later run sheet or comment recording it. Item 4 (register.md:1186) is explicitly batched with row **E1** (`onbox-acceptance-register.md:2907`, `### E1 · ops-16 Pinokio installer ([#822](...)) · **macOS is the gap**`), which is still an open, unrun row in the register today — so the Pinokio install item 4 depends on hasn't happened. `gh issue view 1998` (the offshoot finding from item 1's run) → `{"closedAt":null,"state":"OPEN"}`, unrelated to items 2/4 but confirms no further closure activity has landed against this row's family since 2026-07-31.
- **What changed since the row was written:** Nothing found for items 2 and 4 specifically. No new PR, issue, or run-sheet entry references `patched_xtts_load_audio` decode-vs-render equivalence or a Pinokio `import torchcodec` check since the 2026-07-31 partial discharge.
- **Remains owed:** Item 2's audible half — derive the same cloned voice with and without the patch wrap on a genuinely shared-FFmpeg box and confirm equivalent output; item 4 — run `import torchcodec` inside the nested Pinokio `.venv` and record success/failure, batched with E1 (still open).
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A27 · A missing Kokoro/Qwen package surfaces as Install, a present-but-unimportable one as Repair ([#1965](https://github.com/dudarenok-maker/Castwright/issues/1965), PR #1986; missing-variant copy corrected and Setup-checker coverage added by [#1999](https://github.com/dudarenok-maker/Castwright/issues/1999), PR #2010) · **no GPU needed, sidecar venv only**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1965` → `{"closedAt":"2026-07-31T21:03:42Z","state":"CLOSED"}`; `gh pr view 1986` → `{"state":"MERGED"}`; `gh issue view 1999` → `{"closedAt":"2026-07-31T21:03:42Z","state":"CLOSED"}`; `gh pr view 2010` → `{"mergedAt":"2026-07-31T21:03:41Z","state":"MERGED"}` — all four artifacts resolve and are merged/closed, matching the row's citations exactly. The row's own text (register.md:1194-1200) already states the defining shape — `find_spec` succeeding while a real `import` raises — "cannot be manufactured in CI" and that every automated test injects the flag rather than forcing a genuinely broken install. No run sheet exists for this row (the row says so itself); searched for a later filled-in run sheet or register annotation recording the on-box steps (breaking `kokoro_onnx`/`qwen_tts` `__init__.py`, forcing loads, polling `/health` and `GET /api/diagnostics`) and found none.
- **What changed since the row was written:** All four cited artifacts merged before the row's text was finalized (the row already narrates #1999/PR #2010's fix to the missing-variant copy). Nothing has landed since that would let CI substitute for the on-box steps — the row's own architectural claim (CI cannot manufacture "present but unimportable") is still true today.
- **Remains owed:** The entire on-box walkthrough — break-import/confirm-null-baseline/force-load/observe-Repair for Kokoro, the missing-variant Install check, Model Manager badge-vs-toggle agreement (#2010 m1), the Setup checker's `blockers.tts` copy for both fault shapes, the mixed-fault precedence case, the Coqui-stays-out-of-diagnostics control, and the full repeat for `qwen_tts` including the post-import weights-starvation drill.
- **Decision owed:** n/a
- **Hardware still required:** sidecar venv, no GPU
- **Est. box time:** 30

### A28 · Stranded VRAM pool reclaimed on the admission-failure path ([#1976](https://github.com/dudarenok-maker/Castwright/issues/1976), PR [#1993](https://github.com/dudarenok-maker/Castwright/pull/1993)) · **single 8 GB card**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1976` → `{"closedAt":null,"state":"OPEN"}` — matches the row's own note that PR #1993's `Closes #1976` was narrowed to `Refs #1976` in review, and that the render/unload-completion reclaim is tracked as a separate, not-yet-built follow-up; #1976 being open today confirms that follow-up still hasn't shipped or closed it. `gh pr view 1993` → `{"mergedAt":"2026-07-31T09:22:51Z","state":"MERGED"}`. `grep -rn "vramReservedMbByDevice|stranded-cache reclaim" server/` finds the field/log line only in `server/tts-sidecar/tests/test_placement.py`, `server/tts-sidecar/main.py`, and `server/src/routes/sidecar-health.ts` — i.e. the only test coverage is `test_placement.py`, which the row itself says injects a fake `probe()`/`reclaim` hook rather than touching a real CUDA allocator.
- **What changed since the row was written:** Nothing found. #1976 remains open exactly as the row describes; no new PR references `vramReservedMbByDevice`, the C1 guards, or a real-hardware reclaim measurement.
- **Remains owed:** Render a chapter to completion and confirm via `nvidia-smi` + `GET /api/sidecar/health` that a ~3.9 GB stranded pool is left behind; issue a refused op afterward and confirm it's admitted and VRAM drops to near-baseline; confirm the two C1 guards (no mid-render reclaim, single reclaim within a 30 s window) don't misfire on real hardware.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A29 · `qa.asr.model` reaches the sidecar AND every server-side reader (PR #2008, closes [#1988](https://github.com/dudarenok-maker/Castwright/issues/1988), [#1989](https://github.com/dudarenok-maker/Castwright/issues/1989)) · **no GPU needed, sidecar venv only**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1988` → `{"closedAt":"2026-07-31T21:27:49Z","state":"CLOSED"}`; `gh issue view 1989` → `{"closedAt":"2026-07-31T21:27:49Z","state":"CLOSED"}`; `gh pr view 2008` → `{"mergedAt":"2026-07-31T21:27:48Z","state":"MERGED"}` — all resolve exactly as cited. The row's own text (register.md:1368-1372) states the defect was "verified as a real defect (not just a review claim) by reverting the fix and watching the paired tests go red" but that "the full failure mode needs the real sidecar + a real Hugging Face download to observe end to end, which no unit test can substitute for." No run sheet is named for this row; no later register annotation or issue comment records the Advanced-Configuration → sidecar-restart → Model Manager → Remove → installer walkthrough having been run.
- **What changed since the row was written:** Nothing found. Both closing issues and the merging PR predate the row's own text (the row already narrates the fix); no later activity references this seam.
- **Remains owed:** Set a non-default Whisper model in Advanced Configuration, confirm the sidecar actually loads it (not `base`); confirm Model Manager reports the configured model's size/path; confirm Remove deletes only the configured model's snapshot; confirm the in-app installer fetches the configured model with an explicit `--model` flag and correct copy; confirm the bare CLI script (no flags) still fetches `base` as expected (not a defect).
- **Decision owed:** n/a
- **Hardware still required:** sidecar venv, no GPU
- **Est. box time:** 20

### A30 · Golden-audio bless guards don't rubber-stamp an honest bless, and `_make_kokoro` exercises a real engine (PR [#2032](https://github.com/dudarenok-maker/Castwright/pull/2032), closes [#1995](https://github.com/dudarenok-maker/Castwright/issues/1995), [#2003](https://github.com/dudarenok-maker/Castwright/issues/2003), [#1987](https://github.com/dudarenok-maker/Castwright/issues/1987)) · **Kokoro weights present; single 8 GB card is enough**

- **Verdict:** STILL OWED
- **Evidence:** `gh pr view 2032` → `{"mergedAt":"2026-07-31T23:19:54Z","state":"MERGED"}`; `gh issue view 1995`, `2003`, `1987` all → `closedAt: 2026-07-31T23:19:56Z, state: CLOSED`. The row text's own amendment chain — #2045 F1/F2, #2060/#2061/#2062/#2069 — also all resolve closed: `gh issue view 2069` → `{"closedAt":"2026-08-05T03:37:30Z","state":"CLOSED"}`, `gh issue view 2062` → `{"closedAt":"2026-08-05T03:37:30Z","state":"CLOSED"}`, both already narrated inside the row's own text (register.md:1447-1477) as amendments applied before this audit. No later issue, PR, or run-sheet entry references `--bless`, `IDENTITY_COSINE_EPSILON`, or `_make_kokoro` after 2026-08-05.
- **What changed since the row was written:** Nothing beyond what the row's own amendment blocks (#2045, #2060/#2061/#2062/#2069) already incorporate — all of those are closed and already narrated in the register text itself. No fresh on-box bless run, per-leaf identity-delta measurement, or forced-Kokoro-failure run is recorded anywhere since.
- **Remains owed:** A clean, uncontended `--bless --sidecar-only` run confirming byte-identical baselines plus the noise-echo console line; recording actual per-leaf identity-cosine deltas (the #2066 open question this run is meant to retire); forcing a refusal via a hand-edited `transcript`/`tolerances` field and a separate WINDOW-sized `identity` refusal; and running `test_golden_regression.py`'s real `_make_kokoro` path once clean and once with the engine deliberately broken (renamed `.onnx` or forced OOM) to confirm it FAILS rather than SKIPs.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 45

### A31 · Cast-time clone-readiness gate — the fixes actually fix ([#1980](https://github.com/dudarenok-maker/Castwright/issues/1980), plan [276](../features/archive/276-cast-time-derivability-warning.md)) · **single 8 GB card + a real cloned voice**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1980` → `{"closedAt":"2026-08-01T04:11:06Z","state":"CLOSED"}` — the underlying feature issue is closed, matching the row. Plan 276's frontmatter reads `status: stable` (`docs/features/archive/276-cast-time-derivability-warning.md:2`). The run sheet `docs/testing/clone-readiness-gate-onbox-acceptance.md` is entirely a blank template: every `Result:` line (`:62`, `:70`, `:80`, `:82`, `:100`, `:113`) reads either blank underscores or was never filled, and the SHA/date/run-by line at `:47` (`SHA: ____________  Clean tree: ☐  Date: __________  Run by: __________`) is unfilled — no on-box run has been recorded. The row's own text (register.md:1532-1537) already states the structural gap: `mockCloneVoice` cannot reach `derive-failed` in mock mode by construction, so no amount of e2e-suite growth substitutes for this row.
- **What changed since the row was written:** Nothing found. The feature issue closing (2026-08-01) predates the row's own text; no later commit, PR, or run-sheet entry touches `e2e/clone-readiness-gate.spec.ts`, `clone-voice-resolver.ts`, or the run sheet.
- **Remains owed:** The entire run sheet — gate-fires-at-cast-time (§3), Add-transcript CTA followed by a real chapter render confirming the clone's own voice resolves and is audible (§4, the load-bearing section), a genuine forced `derive-failed` + Retry-derive check that the predicate re-evaluates to the underlying cause (§5), and the Coqui control confirming the gate doesn't always fire (§6).
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 30

### A32 · Cast/analysis `characterId` drift — Wave 1 resolver ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **single 8 GB card, Qwen resident**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2040` → `{"closedAt":"2026-08-04T17:40:01Z","state":"CLOSED"}` — matches the row. The run sheet `docs/testing/cast-id-drift-onbox-acceptance.md` §§3-6 (chapter 19 re-render, chapter 16 re-render + negative control, Cast-screen banner cross-check) are all blank templates: every `Result:` line (`:107`, `:109`, `:116`, `:127`, `:136`, `:149`) is unfilled, and the §6 Outcome checklist (`:153-157`) has no boxes checked. Section 9 of the same run sheet (`:691-807`) records a real 2026-08-11 run, but that section is explicitly scoped to a *different* register row (A45, now discharged and removed — `:693-695`) and a different chapter/book pair's re-render purpose (audio-currency stamping via `#2128`, not the *Playing with Fire* ch19/ch16 resolver recovery this row asks for).
- **What changed since the row was written:** Nothing found for this specific fixture. The Wave-1 resolver code itself (`buildCastResolver`) has since been exercised on a different book (*Заказ Коалфолла*, via §9's 2026-08-11 run for a different row), but *Playing with Fire* ch19/ch16 — the fixture this row names — has not been re-rendered on-box.
- **Remains owed:** Re-render chapter 19 and chapter 16 of *Playing with Fire*, confirm `characterSnapshots` entries for `the-torment`/`lightning-dave` naming their own tuned voices (not `qwen-narrator`) with `renderedFallbackEngine: "kokoro"` gone, **listen** to confirm Torment's line is audibly distinct from the narrator, confirm `pool-player-2` remains unrecovered (negative control), and cross-check the Cast-screen orphaned-id banner.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A33 · Cast/analysis `characterId` drift — Wave 3 repair pass `--apply` run ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **no GPU needed; real workspace + server stopped**

- **Verdict:** STILL OWED
- **Evidence:** The register text's own PARTIALLY DISCHARGED banner (register.md:1623-1630) states §8.7 (re-render *Заказ Коалфолла* ch2, confirm `characterSnapshots` for `mayrin`/`coalfall`, and listen) and §8.8 (Cast-screen banner cross-check) are still owed, and names #2107/#2108 as fixed-not-blocking defects — both confirmed: `gh issue view 2107` → `{"closedAt":"2026-08-05T05:05:34Z","state":"CLOSED"}`, `gh issue view 2108` → `{"closedAt":"2026-08-05T02:21:07Z","state":"CLOSED"}`. The run sheet `docs/testing/cast-id-drift-onbox-acceptance.md` §8.7 (`:604-618`) reads `Result: **NOT RUN as of 2026-08-05** — needs the 8 GB card with Qwen resident.` and §8.8 (`:620-629`) reads `Result: **NOT RUN as of 2026-08-05.**`, matching the register text exactly. **Close but not a discharge:** the same run sheet's §9 (`:740-773`, dated 2026-08-11, for register row A45 — a different, since-discharged row about `#2128` audio currency) re-rendered the *exact same chapter* — *Заказ Коалфолла* ch2, "Стук/Глава первая" — with `force: true`, and confirms `castHistorySeq: 1` and `audioQa.status: ok` (LUFS −16.1, true peak −1.3 dB). But §9's own text (`:809-835`, "What this run additionally proved") lists only `scannedBookDirs`, the if-absent stamp behaviour, and the dry/apply split as newly proven — it does **not** report `characterSnapshots["mayrin"]`/`characterSnapshots["coalfall"]`, and does not record a by-ear listen for those two characters' voices. §8.7's specific criterion (voice attribution + listen) is therefore still unconfirmed even though the underlying chapter has technically been re-rendered since the row's PARTIALLY DISCHARGED banner was written.
- **What changed since the row was written:** *Заказ Коалфолла* ch2 was re-rendered on 2026-08-11 (§9, for a different row's purpose), which is the same chapter §8.7 needs — but the run's own outcome notes don't cover the `characterSnapshots` voice-attribution check or the listen, so this is evidence worth surfacing, not a discharge. §8.8 (Cast-screen banner) has no new evidence at all beyond the CLI-only partial check already recorded in the register.
- **Remains owed:** Read the fresh `segments.json` from the 2026-08-11 (or a new) *Заказ Коалфолла* ch2 render and confirm `characterSnapshots["mayrin"]`/`characterSnapshots["coalfall"]` name Мэйрин's/Коалфолл's own voices, then listen to confirm audibly distinct from the narrator (§8.7); open the Cast screen for *Заказ Коалфолла* and *Everblaze* and confirm the auto-reconciled/needs-decision sections match expectations, spot-checking *Exile*'s `unknown-male` as the negative control (§8.8).
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 15

### A34 · Supervisor respawn survives a refused spawn attempt ([#2037](https://github.com/dudarenok-maker/Castwright/issues/2037)) · **single 8 GB card, live sidecar**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2037` → `{"closedAt":"2026-08-05T00:37:01Z","state":"CLOSED"}` — the underlying fix landed. `server/src/tts/sidecar-supervisor.test.ts` and `server/src/tts/spawn-sidecar.test.ts` both exist and, per the row's own text (register.md:2016-2028), fully pin the backoff/cap logic against injected refusal signals — no real OS socket, no real teardown timing. No later issue, PR, commit, or run sheet records a real kill-and-observe pass against `scheduleRespawnAttempt`/`onSpawnRefused`.
- **What changed since the row was written:** Nothing found. Issue #2037 closing (2026-08-05) predates the row's own text; no follow-up references a real socket-teardown measurement.
- **Remains owed:** Kill the sidecar OS process directly (not via `/api/sidecar/restart`) mid-render, confirm a fresh `[sidecar] spawned pid=` line appears within the ~52s backoff budget with a different pid, confirm `GET /api/setup/models-status` never reports the TTS engine ready while nothing listens on `:9000`, and confirm the in-flight chapter either rides out the respawn or fails cleanly and resumably.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 10

### A35 · Design-wins VRAM contention timeout is sized against a REAL 0.6B cold load ([#2070](https://github.com/dudarenok-maker/Castwright/issues/2070)) · **single 8 GB card**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2070` → `{"closedAt":"2026-08-05T05:54:35Z","state":"CLOSED"}` — the fix landed. `server/tts-sidecar/tests/test_design_contention.py` exists and, per the row's own text (register.md:2059-2067), pins `unload_design`'s wait/raise logic against a simulated `_design_in_flight` claim — not a real cold 0.6B load. No later issue, PR, or run sheet records an overlapped design/render pass on real hardware.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Start a voice design, trigger an overlapping chapter render on a different voice mid-design, confirm the render waits rather than erroring, confirm the design completes and its audition plays, and — if practical — force a genuinely wedged design and confirm the waiting synth times out into the `design_in_flight` 503 near the 150s bound rather than hanging forever.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15

### A36 · ASR warm-reservation figure vs. a real resident `/transcribe` peak ([#2094](https://github.com/dudarenok-maker/Castwright/issues/2094)) · **`ASR_DEVICE=cuda`, single 8 GB card**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2094` → `{"closedAt":"2026-08-05T05:54:36Z","state":"CLOSED"}` — the fix landed. `server/tts-sidecar/tests/test_footprints.py`, `test_transcribe_embed_admission.py`, and `test_asr_footprint_measurement.py` all exist and, per the row's own text (register.md:2090-2105), pin the reservation-key split and the measurement mechanism against a scripted `_device_free_mb` sequence — no real allocator, no real card. No later issue, PR, or run sheet records the 128 MB seed being revisited against real resident-ASR observations.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** With `ASR_DEVICE=cuda` and content-QA on, render a chapter so ASR goes resident, trigger several back-to-back `/transcribe` calls and confirm none 503 `noCapacity` on a card with genuine room, and watch `FootprintTable`'s learned `asr.warm` p95 settle after ≥5 real observations, recording the converged figure.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15 (rides along with A20)

### A37 · Catastrophic-WER override actually catches a real Coqui language-collapse ([#2055](https://github.com/dudarenok-maker/Castwright/issues/2055)) · **Coqui/XTTS resident, ASR content-QA on**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2055` → `{"closedAt":"2026-08-05T05:54:36Z","state":"CLOSED"}` — the fix landed. `server/src/tts/segment-asr-qa.test.ts` exists and, per the row's own text (register.md:2134-2149), pins `classifyTranscript`'s override logic against injected transcripts/signals — including a Russian near-silence repro — but never against a real, intermittent #2026-style collapse. No later issue, PR, or run sheet records a real re-render reproducing the collapse.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** With ASR content-QA on and a Russian (or French/Spanish) book on the Coqui engine, reproduce #2026's language-collapse per its own recipe and confirm a genuine collapse now gets caught (`asr.verdict: drift`, reason mentioning "catastrophically wrong"); across the same or a longer healthy-content render, confirm the override does not fire on ordinary hard-to-transcribe-but-correct lines.
- **Decision owed:** n/a
- **Hardware still required:** Coqui/XTTS resident, ASR content-QA on
- **Est. box time:** 40

### A38 · Sidecar auto-scaled RAM/VRAM recycle thresholds now actually apply on a fresh install (#2179, PR #2210) · **single 8 GB card is enough**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2179` → `{"closedAt":"2026-08-07T01:52:50Z","state":"CLOSED"}`; `gh pr view 2210` → `{"mergedAt":"2026-08-07T01:52:49Z","state":"MERGED"}` — the fix landed. `server/.env.example` still ships all three vars commented out — `# SIDECAR_RESTART_MB=0` (`:659`), `# SIDECAR_VRAM_RECYCLE_SOFT_MB=0` (`:661`), `# SIDECAR_VRAM_RESTART_MB=0` (`:663`) — matching the row's described post-fix state (absent, so the auto-computed thresholds apply). Per the row's own text (register.md:2181-2183), the three threshold functions in `server/tts-sidecar/main.py` are unit-tested only for env-present/absent MATH, not for whether a real process ever crosses a live threshold and recycles/exits. No later issue, PR, or run sheet records a real fresh-install threshold-crossing run.
- **What changed since the row was written:** Nothing found; `.env.example`'s commented-out state is confirmed still current.
- **Remains owed:** Confirm a fresh install (all three vars absent) computes and uses the auto thresholds at startup; drive committed RAM toward the ~70% ceiling and confirm the sidecar self-exits with code 43 for the supervisor to respawn; drive reserved VRAM toward the 90% soft threshold and confirm a clean chapter-boundary recycle fires, then toward the 98% hard threshold and confirm a hard self-exit; and watch an ordinary render for thrash (no routine firing in the high-80s/90s%).
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 35

### A39 · ORT marker — fresh NVIDIA bootstrap ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2192` → `{"closedAt":"2026-08-08T02:55:52Z","state":"CLOSED"}` — the fix landed. Plan 282's frontmatter reads `status: active` (`docs/features/282-ort-pip-consistency-marker.md:2`). Run sheet `docs/testing/ort-marker-onbox-acceptance.md` §3.3 (`:88-93`) has every `Result:` line unfilled (`Marker present + version`, `pip check exit code`, `Kokoro execution provider`, `Run by`/`Date` all `_(fill in)_`) — no on-box run recorded. `bootstrap-venv-helpers.test.ts`'s ordering assertions, per the row's own text (register.md:2222-2228), only exercise the seam, never a real pip venv.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Wipe or freshly clone the sidecar venv, run a genuine from-scratch bootstrap on the nvidia profile, inspect `site-packages` for the correct `onnxruntime-<version>.dist-info`, run `pip check` (expect exit 0), and load Kokoro to confirm `CUDAExecutionProvider`.
- **Decision owed:** n/a
- **Hardware still required:** none (sidecar venv only)
- **Est. box time:** 15

### A40 · ORT marker — the reported bug: in-app Qwen3 install ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2192` → `{"closedAt":"2026-08-08T02:55:52Z","state":"CLOSED"}` — this is the fix for #2192 itself. Run sheet `docs/testing/ort-marker-onbox-acceptance.md` §4.3 (`:120-125`) has every `Result:` line unfilled (`Qwen3 install outcome`, `WinError 5 present/absent`, `Kokoro execution provider after install`, `Run by`/`Date` all `_(fill in)_`) — no in-app re-confirmation recorded since the fix landed. Per the row's own text (register.md:2246-2247), §5's self-heal proof exercises boot, not an in-app package install, so it does not substitute.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Start the app on the NVIDIA profile with a bootstrapped sidecar venv, install Qwen3 from the app UI (Model Manager → the Qwen engine's Install action), confirm no `WinError 5`/`Accès refusé` on any `.dll` under `site-packages/onnxruntime/capi/`, and load Kokoro afterward to confirm it still reports `CUDAExecutionProvider`.
- **Decision owed:** n/a
- **Hardware still required:** none (sidecar venv only)
- **Est. box time:** 10

### A41 · ORT marker refuses — not repairs — a clobbered venv ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2192` → `{"closedAt":"2026-08-08T02:55:52Z","state":"CLOSED"}` — the fix landed. Plan 282's frontmatter reads `status: active` (`docs/features/282-ort-pip-consistency-marker.md:2`), not `stable`, and its Ship notes section (`:310-312`) reads only "(Filled in when status flips to `stable`.)" — never filled in. Run sheet `docs/testing/ort-marker-onbox-acceptance.md` §8.3 (`:300-307`) has every `Result:` line unfilled (`Log line observed`, `pip check after boot`, `Repair command output`, `pip check after repair`, `Kokoro execution provider after repair`, `Run by`/`Date` all `_(fill in)_`) — no on-box run recorded. `server/src/tts/ort-ensure-marker.test.ts` exists and, per the row's own text (register.md:2263-2270), pins the refuse-and-log branch against synthetic fixtures only, never a real clobbered venv where the GPU dist-info survives while CPU files sit on disk.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Manufacture a real clobbered venv (`pip install --force-reinstall onnxruntime` over an existing `onnxruntime-gpu` install), boot the server and confirm `ensureOrtMarker` returns `'clobbered'` with the exact remedy command logged and no marker written over the real distribution, then run the remedy command and confirm the box is actually repaired (`pip check` clean, Kokoro reports `CUDAExecutionProvider`).
- **Decision owed:** n/a
- **Hardware still required:** sidecar venv, no GPU
- **Est. box time:** 10

### A42 · The in-app upgrade path applies the marker on a real installed release ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only; not one of the design doc's six criteria**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2192` → `{"closedAt":"2026-08-08T02:55:52Z","state":"CLOSED"}` — the fix landed. Plan 282's frontmatter still reads `status: active` and its Ship notes section is unfilled (`docs/features/282-ort-pip-consistency-marker.md:2,310-312`). Run sheet `docs/testing/ort-marker-onbox-acceptance.md` §9.3 (`:340-346`) has every `Result:` line unfilled (`Marker absent during overlay install`, `Marker present + correct version`, `pip check after upgrade`, `Forced-failure marker state`, `Run by`/`Date`/`Release version` all `_(fill in)_`). `server/src/upgrade/apply-ort-marker.test.ts` exists and, per the row's own text (register.md:2298-2306), exercises the new dependency-injection seam only — real `spawn`, a real `venvDir`, and a real packaged release directory have never driven it, and the row explicitly notes A39 (`bootstrap-venv.mjs`) passing proves nothing about this separate consumer of `planOrtSwap`.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Take a real installed (packaged `release/`, not dev-checkout) Castwright release on NVIDIA with a marker already present, trigger the in-app upgrade to a release whose sidecar requirements changed, confirm the marker is deleted before the overlay install and rewritten only after the swap steps succeed, confirm `pip check` is clean afterward, and — if practical — force a swap-step failure and confirm the marker stays deleted.
- **Decision owed:** n/a
- **Hardware still required:** sidecar venv, no GPU
- **Est. box time:** 15

### A43 · Linking an orphaned `characterId` through the Cast screen actually reconnects its segments ([#2238](https://github.com/dudarenok-maker/Castwright/issues/2238), plan [278](../features/278-cast-character-identity.md)) · **no GPU needed; real workspace + server stopped for the script half**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2238` → `{"closedAt":"2026-08-10T22:09:50Z","state":"CLOSED"}` — the fix landed. Plan 278's frontmatter reads `status: active` (`docs/features/278-cast-character-identity.md:2`) and its Ship notes section reads only "Not yet `stable`. Fill in when Wave 3 ships (PR merges) and the three on-box rows above are discharged or explicitly deferred with the repo owner's sign-off." (`:646-649`) — not filled in. The Amendment 2026-08-10 section (`docs/features/278-cast-character-identity.md:20-31`) states plainly "Four constraints, all of which have tests" — unit-level only. `docs/testing/cast-id-drift-onbox-acceptance.md`, the existing run sheet for this same script/workspace, has no section for the link-orphan-match UI action at all (its sections run through §9, dated 2026-08-05/2026-08-11 runs, none touching `POST .../link-orphan-match` or the "Compare against…" picker) — the Amendment shipped 2026-08-10 and was never folded into a run sheet.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** With the server stopped, run `repair-cast-id-drift.mjs` against the real workspace and record the baseline `reported for human decision` count; start the server, link an orphaned id (e.g. *Exile* `silveny` or *Everblaze* `lady-alina`) through the Cast screen; confirm it moves to auto-reconciled and `cast-id-history.json` gains a `supersededBy` entry; stop the server and re-run the dry pass to confirm the count dropped; and confirm the negative case (*Exile* `unknown-male`, a reserved fold bucket) is refused both in the UI and via a direct `POST .../link-orphan-match` (expect 400).
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 20

### A44 · Russian XTTS quality — leading-dash pause by ear, Coqui degeneracy guard live, neuter -ее invariant ([#2026](https://github.com/dudarenok-maker/Castwright/issues/2026), PR #2050) · **Coqui/XTTS resident, Russian text; no clone needed**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2026` → `{"closedAt":null,"state":"OPEN"}` — the parent issue for the remaining defects is still open. `gh pr view 2050` → `{"mergedAt":"2026-08-01T03:16:56Z","state":"MERGED","title":"fix(server,sidecar): pause on a leading dash, add coqui degeneracy guard"}` — only the leading-dash text transform and the degeneracy guard code landed; the row's own text says PR #2050 fixed one of #2026's three defects and deliberately shipped no register row, deferred to #2057. `gh issue view 2057` → `{"closedAt":"2026-08-11T02:48:19Z","state":"CLOSED"}` — that issue only tracked reconciling the register (adding this row and republishing the HTML twin), not running the acceptance itself. The run sheet section `docs/testing/fs38-wave3-onbox-acceptance.md:2657-2667` (`#2026 — additional acceptance criteria: Russian XTTS quality`) has its `Result:` line still at the unchecked `☐ P ☐ F ☐ B ☐ N/A` template with no notes filled in. `server/src/tts/text-normalize.test.ts` and `server/tts-sidecar/tests/test_coqui_degeneracy_guard.py` both exist and, per the row's own text, pin the dash transform as a wire-text change and the degeneracy guard against a scripted fake — neither confirms real audio.
- **What changed since the row was written:** Nothing found; #2026 remains open for the two undischarged defects (degeneracy guard live-check, neuter -ee standing invariant), and the leading-dash-by-ear confirmation from PR #2050 is also still unrun.
- **Remains owed:** On a Coqui-resident sidecar with a Russian book (stock voice `Damien Black`), listen to a leading-em-dash dialogue line and confirm an audible pause versus a same-line-no-punctuation control and an interior-dash control; confirm `tts.coqui.degenGuard` doesn't false-positive on ordinary short Russian lines and, if a live collapse can be captured, whether the retry recovers it; and confirm the neuter `-ее` mispronunciation still reproduces on `main` as a standing baseline.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A45 · Named-entity decode reaches the TTS engine on a real EPUB ([#2310](https://github.com/dudarenok-maker/Castwright/issues/2310), plan [`docs/superpowers/plans/2026-08-13-entity-decode-layer.md`](../superpowers/plans/2026-08-13-entity-decode-layer.md)) · **single 8 GB card**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2310` → `{"closedAt":"2026-08-13T04:25:10Z","state":"CLOSED"}`; `gh pr view 2316` → `{"mergedAt":"2026-08-13T04:43:29Z","state":"MERGED","title":"fix(server): widen named-entity decode to the full HTML5 set (#2310)"}` — the fix landed. The plan's own Task 8 (`docs/superpowers/plans/2026-08-13-entity-decode-layer.md:622-630`) explicitly names the on-box row (this one, A45) as the only proof that "a real EPUB with named entities produces clean audio end-to-end," and states the text change alone is fully proved by CI (Tasks 2-7). `server/src/parsers/html-utils.test.ts` and `server/src/tts/entity-dialogue-e2e.test.ts` both exist, confirming the row's own claim that every layer is proved only by unit/e2e tests fixing the sentence text explicitly, not by a real EPUB import. No run sheet or dated result exists anywhere under `docs/testing/` recording a real EPUB import/listen for this fix.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Import an EPUB whose first chapter heading carries named entities (e.g. `<h1>L&rsquo;&Eacute;t&eacute;</h1>`) and confirm the spoken title beat says "L'Été" cleanly; secondarily, on a real (or hand-modified) es/fr/ru EPUB with named entities in body text, confirm a dash-opened dialogue line pauses rather than being spoken aloud, accented words render correctly, and the manuscript view shows real glyphs — recording whether the body-line symptom reproduced pre-fix at all, which per the plan is itself new information rather than a gate on the fix.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 20

### A46 · Respawn budget deadline and exhaustion under sustained refusal ([#2106](https://github.com/dudarenok-maker/Castwright/issues/2106), PR #2398) · **single 8 GB card, live sidecar**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2106` → `{"closedAt":"2026-08-16T03:05:14Z","state":"CLOSED"}`; `gh pr view 2398` → `{"mergedAt":"2026-08-16T03:05:13Z","state":"MERGED","title":"fix(server): bound the sidecar respawn budget on the refusal path"}` — the fix landed. `server/src/tts/sidecar-supervisor.test.ts` and `server/src/tts/spawn-sidecar.test.ts` both exist and, per the row's own text (register.md:2475), fully verify the refusal→cap accounting logic in unit tests but cannot reach the real race — whether `LISTENER_PID_DEADLINE_MS = 5000` is enough headroom for the real listener-enumeration probe under contention, and whether the deadline timer actually kills a hung probe. No run sheet under `docs/testing/` covers #2106 or PR #2398 at all — no `Result:` lines exist to check.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Scenario 1 — kill the sidecar OS process directly, bind a foreign non-responding listener on `:9000`, confirm the supervisor's attempt counter advances monotonically across refused attempts in the log and that the sidecar surfaces as `'crashed'` once exhausted; confirm recovery via `POST /api/sidecar/restart`. Scenario 2 — with `SIDECAR_NEVER_ADOPT=1`, manually start a fresh sidecar so the server doesn't own its PID, confirm the UNFIT/stale-replace path fires, the PID lookup completes under the 5000ms deadline (or the deadline-timeout log fires and the supervisor proceeds to the next backoff instead of hanging), and the newly-spawned sidecar becomes owned and ready.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 10

### A47 · Reassigning a character's voice no longer scores it against the old speaker's persisted audition centroid ([#1969](https://github.com/dudarenok-maker/Castwright/issues/1969), PR #2402) · **single 8 GB GPU + qwen or coqui resident + a cloneable voice**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1969` → `{"closedAt":"2026-08-16T03:56:07Z","state":"CLOSED"}`; `gh pr view 2402` → `{"mergedAt":"2026-08-16T03:56:05Z","state":"MERGED","title":"fix(server): rebuild the audition centroid when a character's voice is reassigned (#1969)"}` — the fix landed. `server/src/audio/render-integrity/aggregate-audition-voice-reassign.test.ts` exists, confirming the row's own claim that only mock/unit coverage exists for `resolveCharacterReference`'s persisted-`audition`-row handling and `centroids-io.ts`'s `CharacterCentroid` voice-tagging — a real render producing the rebuilt reference (not the failed flag) has never been observed. No run sheet under `docs/testing/` covers #1969 or PR #2402.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Assign a character thin enough on in-book anchors to take the audition-reference path to one voice and render once so `render-integrity.centroids.json` persists an `audition` row; reassign the character to a clearly different cloned voice; re-render and confirm the new voice's lines are not flagged `voice-mismatch`/`severe` — i.e. that the persisted centroid was rebuilt for the new voice rather than reused against the old speaker's.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 25

### B1 · Analysing view honesty for local analyzers (plan 216)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/216-analysing-local-analyzer-honesty.md` frontmatter
  `status: active`, `shipped: null` (`:2-5`). Body (`:17-19`): "All are bug
  fixes with paired automated tests. Live-GPU on-box acceptance is owed (the
  device probe, the live ETA refinement, and the truncation recovery all want
  a real Ollama + a long chapter to confirm end to end)." The "Manual
  acceptance (live GPU, owed)" section (`:124-142`) lists exactly the six
  steps the row's heading summarizes, unmarked. Ship notes (`:144-147`) are
  the unfilled placeholder: "_Pending: shipped date + merge SHA on merge._" —
  no shipped date recorded. Automated coverage is real but seam-level only:
  `server/src/routes/analysis.test.ts` mocks `detectOllamaDevice` to always
  return `'cuda'` (`:66-70`, `detectOllamaDeviceMock: vi.fn(async ()... =>
  'cuda')`) and unit-tests `projectChapterEstMsFromOutput` as a pure function
  (`:786-801`) against synthetic byte counts, not a real Ollama stream. No run
  sheet under `docs/testing/` references plan 216, B1, or this walkthrough by
  name (`grep` for `216-analysing` and `B1 ` across `docs/testing/` returns
  nothing outside the register itself).
- **What changed since the row was written:** Nothing found — no commit to
  the plan file, no run sheet, no ship-notes fill-in since the row's framing.
- **Remains owed:** All six manual steps on a real local Ollama daemon and a
  ~110k-char chapter: Gemini→Qwen fallback label honesty, realistic
  per-chapter ETA that tightens within ~10s of streaming, dense-paragraph
  truncation recovery, the CPU-only slow-ETA seed case, and `LiveChapterTicker`
  at K=4 with a monotonic per-phase bar.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 20

### B2 · Per-model analyzer keep-alive (plan 263)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/263-per-model-keepalive.md` frontmatter
  `status: active`, `shipped: null` (`:2-3`). Header (`:9`): "Status: active —
  server + frontend + tests landed; on-box `ollama ps` acceptance owed." The
  "Manual acceptance walkthrough" (`:242-299`) lists exactly eight numbered
  steps, matching the row's own count and its note that an earlier register
  version undercounted at seven; step 8 (`:296-299`, voice-design persona
  keep-alive unregressed by the per-model resolver) is present and unmarked.
  Ship notes (`:314-317`) are the unfilled placeholder: "(Fill in when status
  flips to `stable`: shipped date, commit SHA, and move this file to
  `docs/features/archive/` in the same PR.)" Automated coverage — confirmed
  real: `server/src/analyzer/ollama.test.ts` (`keepAliveFor` /
  `resolveKeepAliveSeconds`), `server/src/routes/ollama-health.test.ts` (the
  `/load` warm route) — is explicitly called out by the plan's own test plan
  (`:238-240`) as no substitute: "the live-hardware `ollama ps` countdown
  behavior (Acceptance walkthrough below) has no automated equivalent — it is
  an on-box manual check, called out explicitly rather than silently
  omitted." No run sheet under `docs/testing/` references plan 263, B2, or
  this walkthrough by name.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** All eight walkthrough steps against a real local Ollama
  daemon with `ollama ps` open in a second terminal, including the step-4
  regression check (keep-alive `0` stays pinned mid-run but a manual Load
  pill still warms with a 30s floor) and step 8 (custom analyzer model with
  no override leaves persona keep-alive at `300`, CPU-only clamp override
  check per the row's own text).
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 20

### B3 · Cast/analysis `characterId` drift — Wave 2 stops new drift (#2040, implementation plan)

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2040 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-08-04T17:40:01Z","state":"CLOSED",
  "title":"Cast/analysis characterId drift causes silent narrator-voice
  substitution (upstream of #2023)"}` — the parent bug is closed as
  dev-complete, matching the row's framing that Wave 1 (a different register
  row, A32) already discharged the render-time half. `docs/testing/cast-id-drift-onbox-acceptance.md`
  §7 ("Wave 2 — stopping new drift at re-analysis time", `:167-238`) is this
  row's own cited run sheet. Every `Result:` line in §7.4-7.6 is blank
  (`:206`, `:208`, `:210`, `:220`, `:222`, `:228`, `:230` all read
  `Result (...): ______________`), and §7.7's outcome checklist
  (`:234-235`) is unchecked: `- [ ] §§7.4-7.6 run` / `- [ ] Defects filed:
  ____________________________________`. `docs/superpowers/plans/2026-08-01-cast-character-identity.md`
  exists and its Task 15 ("Wave 2 gate", `:970`) confirms the implementation
  plan the row cites is real and covers the early-remap mechanism the row
  describes.
- **What changed since the row was written:** Nothing found — the run sheet
  section is exactly as blank as the row's own text implies.
- **Remains owed:** The full §7.4-7.6 sequence against the real *Заказ
  Коалфолла* fixture: record the pre-re-analysis `cast.json` ids for Мэйрин
  and Коалфолл plus confirm `cast-id-history.json` is absent; trigger a full
  (not subset) re-analysis; confirm the ids are either kept unchanged or, if
  the analyzer minted different strings, that `cast-id-history.json`'s
  `supersededBy` map records the retirement through `retireCharacterId`; and
  spot-check the rest of the 13-character roster for duplicates or silent
  renames.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 10

### B4 · Stage-1 returns cast names in the manuscript's own script (#2313, PR #2317)

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2313 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-08-13T05:48:18Z","state":"CLOSED",
  "title":"srv — stage-1 returns cast names in whatever script the model
  picks; a Russian book got a 59% Latin-transliterated roster"}`; `gh pr view
  2317 --repo dudarenok-maker/Castwright --json state,mergedAt,title` →
  `{"mergedAt":"2026-08-13T05:48:17Z","state":"MERGED","title":"fix(server):
  ask stage-1 for cast names in the manuscript's own script"}` — the fix
  landed, matching the row. The PR's own body (fetched) confirms the row's
  framing verbatim: "The fix is a prompt instruction... Four tests in
  `server/src/routes/analysis.test.ts`, each mutation-verified individually" —
  i.e. the PR author's own words state the tests prove the rule renders, not
  that a real model obeys it, matching the row's "three unit tests prove the
  rule renders — not that the model obeys it" claim (off by one test count in
  the row's text — the PR body cites four — but the substance is identical
  and does not change the verdict). The row's fold-into-B3 plan
  (`**Fold this into B3's run**`) is unexecuted: B3's own run sheet
  (`docs/testing/cast-id-drift-onbox-acceptance.md` §7) has every relevant
  `Result:` line blank (see B3 above), and no section anywhere in that file
  mentions cast-name script/Cyrillic-vs-Latin checks, ASCII-kebab-case id
  verification, or near-duplicate-pair detection — this row's own specific
  criteria appear nowhere in the run sheet it is supposed to piggyback on.
- **What changed since the row was written:** Nothing found — the fix
  remains merged and unexercised on a real re-analysis.
- **Remains owed:** Everything the row specifies, on the same *Заказ
  Коалфолла* re-analysis B3 needs: every character's `name` in the resulting
  `cast.json` is in Cyrillic (zero Latin transliterations); every `id` stays
  ASCII kebab-case; no character gained a second, near-duplicate id; and the
  roster size holds against B3's recorded 13 characters.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 0 (folds into B3; no cost of its own if run together, per the row's own text)

### C1 · Free-tier Gemma cloud pass completes end to end (#1685)

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1685 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":null,"state":"OPEN","title":"Verify
  #1682 cloud request sizing on-box + calibrate stage-2 local input
  fraction"}` — open, matching the row. `docs/testing/night-watch-reanalysis-onbox-acceptance.md`
  §4 "Results" (`:636-638`) lists this row's three cited criteria with their
  `Result:` lines completely blank: "**C1 — cloud pass on `gemma-4-31b-it`
  incl. script-review:** _Result:_", "**C1 — per-minute 429 retried, not
  misclassified:** _Result:_", "**C1 — working `localInputFraction` for zero
  truncation drops:** _Result:_" — no text follows any of the three. The
  row's claim that 429 classification is already covered offline checks out:
  `server/src/analyzer/gemini.test.ts` carries `retries a per-minute 429
  honoring retry-delay from details[]` (`:494`) and `retries a per-minute RPM
  429 (quotaValue":"15") — not DailyQuotaExhaustedError (#1695)` (`:583`),
  matching the row's citation of `:551`/`:583` (line numbers shifted slightly
  but the same two named test cases exist). **New finding, not in the row:**
  the row's "remaining draw" — that this cloud pass "doubles as the cloud arm
  of #2306's control" — is now stale. `gh issue view 2306 --repo
  dudarenok-maker/Castwright --json state,closedAt` → `{"state":"CLOSED",
  "closedAt":"2026-08-14T07:43:15Z"}`, closed "no longer reproduces... cause
  undetermined," on the strength of a fresh 2026-08-14 re-run of the *same*
  local book (not this row's cloud pass) — chapters 1-2 only, narrated-speech
  1.1%/0.9% against a 60% bar, well under the collapsed run's 93%+. That
  closure removes the "sharpest test available" justification the row's own
  text leans on, without touching the row's three primary criteria (which are
  independent of #2306).
- **What changed since the row was written:** #2306 — the issue this row's
  "remaining draw" paragraph is built around — closed 2026-08-14 as
  non-reproducing/cause-undetermined, on evidence from a different
  (local-only, 2-chapter, GitHub-issue-comment-only, not run-sheet-recorded)
  session than this row calls for. This weakens the row's secondary framing
  but does not discharge or shrink its primary, independently-stated
  criteria.
- **Remains owed:** The full cloud-arm walkthrough exactly as specified: a
  throwaway re-import analyzed end to end on `gemma-4-31b-it` including the
  script-review pass, confirming the book completes with no dropped chapters
  or hang under real throttling, the per-minute 429 retry path fires live,
  and the `localInputFraction` local-calibration half converges on zero
  truncation drops.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 30

### C2 · Dialogue-convention invariant end to end (#2253)

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2253 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-08-11T11:21:35Z","state":"CLOSED",
  "title":"srv — plan 247 target 1 (flagged <= ~500/chapter) is unsound..."}`
  — closed as dev-complete, matching the row's framing that the fix itself is
  proven but the end-to-end run is separate. `docs/testing/night-watch-reanalysis-onbox-acceptance.md`
  §4 confirms exactly what the row already states as passed/failed for the
  2026-08-12/13 run (labelled "C3" in the run sheet per the register's own
  renumbering note): "**C3 — `unresolved` populated, `flagged` at conflict
  scale:** _Result:_ **PASS**" (`:602-608`) and "**C3 — ch5's dash-opening
  sentences no longer rewritten to `narrator`:** _Result:_ **FAIL.** ch5 went
  69.7% → 87.2% narrator... book-wide 87.4%... Filed as #2306" (`:610-623`).
  **New finding:** `gh issue view 2306 --json state,closedAt` →
  `{"state":"CLOSED","closedAt":"2026-08-14T07:43:15Z"}` — closed "no longer
  reproduces on this book under this configuration. Cause undetermined,"
  citing a fresh 2026-08-14 re-run (chapters 1-2 only) with the server's own
  per-chapter narrated-speech check reading 1.1%/0.9%, both well under the
  60% bar and cleaner than the known-good 2026-08-06 baseline. That run is
  **not** recorded in `night-watch-reanalysis-onbox-acceptance.md` or any
  other file under `docs/testing/` — it exists only as a GitHub issue
  comment, is a 2-of-9-chapter partial, and the register's own hold note
  above this row ("Hold the full 12-hour re-run... Wait for [#2288 and
  #2279], then take C2 and C3 in one session") is only half-satisfied: `gh
  issue view 2279 --json state,closedAt` → `CLOSED` `2026-08-14T00:25:18Z`,
  but `gh issue view 2288 --json state,closedAt` → `{"closedAt":null,
  "state":"OPEN"}` — the in-flight speaker-separation work (M2, gap-tiered
  quote-run fix) the hold explicitly names is still open, per its own last
  comment (2026-08-13) describing M2 as dispatched but not confirmed merged
  into a closing state. A run taken while #2288 is still open is exactly the
  "moving target... has to be repeated" scenario the register's hold warns
  against.
- **What changed since the row was written:** #2306 closed 2026-08-14 on the
  strength of a small, out-of-band, unrecorded re-run showing the collapse
  does not reproduce on the two chapters checked — encouraging, but it covers
  neither the full 9-chapter book this row's own criteria require, nor is it
  captured in the run sheet the row cites as its criteria's source, nor did
  it wait for #2288 to close as the register's own hold instructs.
- **Remains owed:** A full 9-chapter re-analysis, taken after #2288 lands (per
  the register's own hold), recorded in the run sheet, confirming: `unresolved`
  populated and `flagged` at conflict scale (already PASS on the prior run,
  worth reconfirming since the engine changed); ch5's (and book-wide)
  dash-opening dialogue is not collapsed to `narrator`; `state.json`'s
  `analysisProvenance.report` carries a populated `unresolved` key; and the
  wall-clock target, separately missed by 2.5-6x in the prior run for reasons
  (VRAM spillover) that need different hardware or a smaller quantisation to
  re-test.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 300 (12+ hours, per the prior run's own recorded wall-clock; unchanged until re-tested on different hardware)

### C3 · A deterministic stage-2 failure actually clears when the span is halved (#2304)

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2304 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-08-13T01:35:13Z","state":"CLOSED",
  "title":"analyzer: the stage-2 coverage retry burns its whole budget
  re-running a deterministic failure, then reports it as transient"}` — the
  wiring fix landed, matching the row's own framing that unit tests already
  prove the wiring. `docs/testing/night-watch-reanalysis-onbox-acceptance.md`
  §4 records the ch8 event only generically, under a bucket explicitly
  labelled as non-criterion: "**C2/C3 — model-quality events observed
  (recorded, not a criterion):** four stage-2 attribution coverage-check
  failures, all on ch8, all the same `repeat-loop` at offset 19, across two
  server lifetimes — deterministic, not sampling variance — plus one Ollama
  output truncation. ch8 did eventually clear after ~2.5 h. Fixed under
  #2304." (`:630-635`). This confirms the reproducer fired exactly as the row
  describes, but none of the row's three specific named observations — the
  retry halting on the repeated signature before budget exhaustion at the
  correct attempt N, the `re-attributing a <N>-char section...` log line
  appearing, and ch8's sentence count coming back whole — are recorded as
  distinct checked results anywhere in this run sheet or any other file under
  `docs/testing/`.
- **What changed since the row was written:** Nothing found beyond the
  generic "ch8 did eventually clear" note already reflected in the run
  sheet's non-criterion bucket — no dedicated recording of this row's three
  named observations exists.
- **Remains owed:** On a local re-analysis that reaches Ночной дозор ch8 (this
  row is explicitly not blocked on #2288/#2279, unlike C2): confirm the
  analyzer log shows the retry halting on the repeated failure signature
  before the `coverageRetries` budget is spent, at whatever attempt N it
  actually lands on; confirm (or note the absence of, which is not itself a
  failure) the `re-attributing a <N>-char section as <M> smaller ones (split
  depth D)` log line; and confirm ch8's final sentence count is whole, not a
  partial take.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 15 (batches with any local re-analysis reaching ch8; no dedicated session required per the row's own text)

### C4 · The dialogue-collapse guard fires on a real collapse and stays quiet on a healthy book (#2325, #2342)

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2325 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-08-13T08:03:43Z","state":"CLOSED",
  "title":"srv: no guard on attribution quality — an all-narrator book passes
  the coverage check silently"}`; `gh issue view 2342 --repo dudarenok-maker/Castwright
  --json state,title,closedAt` → `{"closedAt":"2026-08-13T22:22:17Z",
  "state":"CLOSED","title":"The #2325 dialogue-collapse guard: six defects and
  a design question from PR #2333's review gate"}` — both fixes landed,
  matching the row. The row's own text states its criteria's home is the row
  itself ("no source file duplicates them at that granularity, so this row is
  their canonical home") and explicitly requires **a second dash-language
  book** to import, since only one Cyrillic book in the workspace has an
  evaluable speech population (>=20 halves) and the other two hold 19 and 15.
  No such second book, and no run sheet entry anywhere under `docs/testing/`,
  records any of the row's four bulleted observations (healthy-book
  under-60%-per-chapter distribution on a *different* book, retry-keeps-the-
  less-collapsed-take, `attribution-collapse` vs `attribution-incomplete`
  copy, or the marker-loss ratio-near-0.5-escalation check). The 2026-08-14
  re-run that closed #2306 (see C2 above) reused the *same* Ночной дозор book,
  measured only 2 of 9 chapters, is recorded only as a GitHub issue comment
  rather than a run sheet, and — per the #2306 closing comment itself —
  "Zero retries fired. The #2342 guard never repaired anything: the collapse
  did not occur, rather than occurring and being caught" — meaning even that
  partial, off-criteria data point does not exercise this row's retry-fires
  or wrong-copy-vs-right-copy checks at all.
- **What changed since the row was written:** Nothing found that touches this
  row's own criteria directly. The 2026-08-14 #2306-closing re-run is a
  same-book, partial-chapter, non-run-sheet data point that happens to show
  two chapters clearing the 60% bar without a collapse — informative context,
  but it does not satisfy the row's explicit requirement for a *second*
  dash-language book, nor any of its guard-behavior checks (retry, message
  copy, marker-loss control).
- **Remains owed:** Import a second real dash-convention (Russian, Spanish or
  French) book with an evaluable dialogue population; on a real local
  re-analysis, record the per-chapter narrated-speech-share distribution on a
  healthy run; confirm a genuinely breaching section's retry keeps the less-
  collapsed take; confirm the `attribution-collapse` copy (not
  `attribution-incomplete`) fires on a chapter that still breaches; and
  confirm the marker-loss ratio stays well above 0.5 on at least one chapter.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU
- **Est. box time:** 15 (batches with C2/C3's session; no dedicated session required per the row's own text)

### D1 · Non-English ASR content-QA calibration ([#1527](https://github.com/dudarenok-maker/Castwright/issues/1527), [#1084](https://github.com/dudarenok-maker/Castwright/issues/1084))

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1527 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":null,"state":"OPEN","title":"srv: on-box
  maxWer calibration for es/fr/de/ru (#1084 follow-up)"}`; `gh issue view 1084
  --repo dudarenok-maker/Castwright --json state,title,closedAt` →
  `{"closedAt":null,"state":"OPEN","title":"srv: ASR content-QA never
  tuned/validated for non-English (gate went live on non-EN at 3a56bf74)"}` —
  both open. `server/src/config/registry.ts:300-338` defines the four
  per-language override knobs the row calls for (`qa.asr.maxWer.{es,ru,fr,de}`),
  and every one still `default: 0.4` — identical to the global default, i.e.
  no observed-data calibration has been entered for any language. The knobs'
  own `help` text says as much: "defaults to the global ASR max WER until
  tuned on-box (#1084)". `server/src/tts/segment-asr-qa.test.ts:688-711`
  exercises only the resolver mechanism (`resolveAsrThresholds`) against
  synthetic override values (`0.55`, `0.5`) fed in by the test itself — it
  proves the plumbing reads a set knob, not that any knob has been set from a
  real es/ru/fr/de render-and-inspect pass.
- **What changed since the row was written:** The per-language override
  scaffold has landed since the row's prerequisite paragraph was written —
  `qa.asr.maxWer.{es,ru,fr,de}` config knobs, env vars, and the
  `resolveAsrThresholds(_, language)` resolver now exist to receive values.
  This is infrastructure only; it does not itself discharge the row.
- **Remains owed:** Render real audio in es/ru (then fr/de), run the ASR
  content-QA gate against it, inspect the WER distribution per language, and
  set the four `qa.asr.maxWer.*` knobs from what's observed — plus the two
  named residual-risk checks (gendered-number mismatch rate, Russian
  oblique-case declension mismatches) and confirming Whisper's German output
  matches the single-fused-token assumption for compound numbers.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 90 (four languages, largely unattended batch render + inspect per the row's own text)

### D2 · fs-61 zh/ja placeholder voices ([#1600](https://github.com/dudarenok-maker/Castwright/issues/1600))

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 1600 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":null,"state":"OPEN","title":"fs-61 —
  backfill designed voices + covers onto the zh/ja Coalfall placeholder
  samples"}`. Comparing the sample trees directly: `samples/the-coalfall-
  commission-es/` (one of D1's five *done* languages) has both
  `manuscript.epub` and a `voices/` directory of designed voice artifacts;
  `samples/the-coalfall-commission-zh/` and `samples/the-coalfall-commission-
  ja/` have neither — each holds only `.audiobook/`, `README.md`, and
  `manuscript.md` (not even the `.epub` the pipeline expects). The voice-
  design pipeline has visibly never been run against either.
- **What changed since the row was written:** Nothing found — the zh/ja
  sample trees are still pre-pipeline placeholders.
- **Remains owed:** Run the shipped Qwen VoiceDesign pipeline against the
  zh/ja Coalfall placeholder samples, same as was already done for the five
  languages D1 covers.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 25 (two languages, unattended pipeline run per the row's own framing)

### D3 · The re-open bound's recovered turn actually sounds right when voiced ([#2315](https://github.com/dudarenok-maker/Castwright/issues/2315), plan [`docs/superpowers/plans/2026-08-13-primary-pair-straddle.md`](../superpowers/plans/2026-08-13-primary-pair-straddle.md))

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 2315 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":"2026-08-13T21:32:45Z","state":"CLOSED",
  "title":"srv — findQuoteRuns destroys 579 of 2,456 well-formed turns on
  main, using a language's own primary quotePairs"}` — merged and closed. The
  plan's own Ship notes (`docs/superpowers/plans/2026-08-13-primary-pair-
  straddle.md:608-634`) record Tasks 1-11 as implemented and every measured
  figure (Arm A, Arm B, attribution family, M2 pairwise, tag-cut proxy)
  reproduced against the shipped code — but every one of those figures is a
  corpus-instrument or unit-test measurement (text preservation, mid-word
  checks, attribution-family loss counts), never a real render that a human
  listened to. No file under `docs/testing/` mentions issue #2315 or
  "primary-pair-straddle" at all (a search for both terms across
  `docs/testing/` returns only the register and this audit file itself), so
  no run sheet records the design doc's worked zh/ja continuation-paragraph
  example being rendered and confirmed by ear.
- **What changed since the row was written:** The PR merged and shipped
  (Ship notes filled in), but the listening check the row asks for is a
  separate, still-unexercised step — the plan's own on-box-acceptance
  checklist item (`:591-598`) explicitly defers it to this register row.
- **Remains owed:** Generate a `zh` or `ja` chapter containing a continuation
  paragraph (the design doc quotes two worked examples), confirm the
  previously-swallowed inner turn now renders as its own speech turn in the
  character's own cast voice, and that the boundary doesn't land mid-word or
  drop a syllable. The `ru`/`de` secondary check remains lower priority per
  the row's own text.
- **Decision owed:** n/a
- **Hardware still required:** real CJK manuscript
- **Est. box time:** 20 (single chapter render + listen, any TTS engine per the row's own text)

### E1 · ops-16 Pinokio installer ([#822](https://github.com/dudarenok-maker/Castwright/issues/822)) · **macOS is the gap**

- **Verdict:** STILL OWED
- **Evidence:** `gh issue view 822 --repo dudarenok-maker/Castwright --json
  state,title,closedAt` → `{"closedAt":null,"state":"OPEN","title":"ops-16 —
  Pinokio installer on-box acceptance (Windows + macOS)"}`. `gh issue view
  1859 --repo dudarenok-maker/Castwright --json state,closedAt` →
  `{"closedAt":"2026-07-27T03:11:35Z","state":"CLOSED"}` — matches the row's
  own account of the Node-pin escalation landing in a follow-up chore.
  Nothing in `docs/testing/` mentions macOS testing having occurred (a
  case-insensitive search for "macos" across `docs/testing/` matches only
  `flake-evidence.md` — a CI-runner-OS-matrix document unrelated to this row
  — plus the register and this audit file).
- **What changed since the row was written:** Nothing found beyond what the
  row itself already documents (the #1859 escalation and its follow-up
  chore).
- **Remains owed:** All of it — macOS has had zero on-box exercise on any
  axis (install, venv-from-conda, API spelling); Windows native-Stop actually
  reaping the sidecar is unconfirmed; the pinned-Node checks the row
  describes in detail (fresh install reports `24.x`, a pre-pin-release
  Update-once still shows the bundled version as expected behaviour, a
  second Update converges to `24.x`, `node_modules` survives the Node-major
  swap) are all unproven on-box.
- **Decision owed:** n/a
- **Hardware still required:** phone / Mac / browser
- **Est. box time:** 30 (20-40 min macOS install alone plus a short Windows follow-up, per the row's own estimate)

### E2 · LAN HTTPS on by default (plan 250)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/250-lan-https-default.md:2` → `status: active`
  (not `stable`); its `## On-box acceptance (owed)` section at `:43-48` is
  unchanged and lists the same four items the row cites verbatim. Searching
  `docs/testing/` for `LAN_HTTPS`/`mkcert`/`castwright.local` turns up three
  incidental mentions — `cast-id-drift-onbox-acceptance.md:405` ("Result:
  2026-08-05 ... `LAN HTTPS 8443 only`"), `fs38-wave3-onbox-acceptance.md:123`,
  and `night-watch-reanalysis-onbox-acceptance.md:504` — but all three are
  the *same developer's* dev-box sessions running with `LAN_HTTPS=1` already
  set as an environment side-effect of other acceptance work, not a run of
  this row's own checklist: none installs the mkcert root CA on a real phone,
  none browses `castwright.local` from that phone, and none exercises the
  `LAN_HTTPS=0`/cert-deletion fallback.
- **What changed since the row was written:** Nothing that discharges the
  row — incidental same-dev-box HTTPS boots are not a substitute for the
  real-phone pairing and fallback checks the row specifically asks for.
- **Remains owed:** Fresh install boots HTTPS on :8443 with the cert-
  provisioned log line; the Open-Web-UI tab loads with no cert warning; a
  real phone installs the mkcert root CA and completes pairing over
  `castwright.local`; forcing `LAN_HTTPS=0` or deleting the certs degrades to
  loopback HTTP without a crash.
- **Decision owed:** n/a
- **Hardware still required:** phone / Mac / browser
- **Est. box time:** 20 (shares the phone + host session with E3, per the row's own text)

### E3 · Pair from `castwright.local` (plan 256)

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/256-lan-pair-from-friendly-hostname.md:2` →
  `status: active`. Same search as E2 above — no run sheet under
  `docs/testing/` records a real phone authorizing a device from
  `https://castwright.local/#/admin`, name-first pairing showing the chosen
  name in the admin list, or a bare-LAN-IP request receiving the
  loopback-only 403.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Authorize a device from the friendly hostname with no
  403; name-first pairing from the Listen tab shows the chosen name in the
  admin list; a bare-LAN-IP request still gets the loopback-only 403
  guidance.
- **Decision owed:** n/a
- **Hardware still required:** phone / Mac / browser
- **Est. box time:** 15 (same session as E2, per the row's own text)

### E4 · fe-51 engine-recommendation CPU caveat (plan 259)

- **Verdict:** STILL OWED
- **Evidence:** `server/src/tts/engine-recommendation.ts:34` still defines
  `CAVEAT_VRAM` at the exact line the row cites, and its use at `:67`
  (`caveat: fits ? null : CAVEAT_VRAM`) is unchanged. `docs/features/259-
  fe51-engine-recommendation.md:183` still reads "On-box acceptance item
  (real hardware, not mock mode) — owed." verbatim.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** Force Qwen onto CPU via the voice-engine device setting
  on real hardware and confirm it still renders — slow, not crashing. If
  false, the plan's own named fallback is to soften `CAVEAT_VRAM` at the
  cited line.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card
- **Est. box time:** 15 (pairs with Group B's CPU-only sub-cases per the row's own text)

### E5 · fe-39 touch press-feedback — DevTools smoke-check ([#1795](https://github.com/dudarenok-maker/Castwright/pull/1795))

- **Verdict:** STILL OWED
- **Evidence:** `gh pr view 1795 --repo dudarenok-maker/Castwright --json
  state,mergedAt,title` → `{"mergedAt":"2026-07-24T04:43:32Z","state":
  "MERGED","title":"fix(frontend): touch press-feedback parity via
  group-active mirrors (fe-39)"}`. No file under `docs/testing/` mentions
  "press-feedback" or "group-active" (only the register and this audit file
  match). Grepping `e2e/` for the same terms returns no Playwright coverage
  either — consistent with the row's own claim that jsdom cannot compile the
  variant and an automated test cannot stand in for the DevTools check.
- **What changed since the row was written:** Nothing found — the PR
  remains merged with no recorded manual DevTools pass.
- **Remains owed:** A one-time DevTools touch-emulation check of the four
  named controls (continue-listening play badge, "Add book" tile, wizard
  "Review ›" chip, voice-library drag icon).
- **Decision owed:** n/a
- **Hardware still required:** phone / Mac / browser
- **Est. box time:** 5 (any machine, per the row's own text)

---

### E6 · ops-35 ffmpeg floor — below-floor + Re-check walkthrough (#1877, plan 269)

- **Verdict:** STILL OWED
- **Evidence:** `server/src/diagnostics/ffmpeg.test.ts:14-16` still mocks
  `node:child_process`'s `spawnSync` via `vi.mock`, and
  `scripts/tests/ffmpeg-version.test.mjs` still feeds the parser canned
  banner strings rather than a real binary. `docs/features/269-ffmpeg-
  version-floor.md:214-215` reads "its on-box acceptance (register row E6)
  is still owed" verbatim. `gh issue view 1877 --repo dudarenok-maker/
  Castwright --json state,closedAt` → `{"state":"CLOSED","closedAt":
  "2026-07-27T08:50:16Z"}` — the bug is fixed and shipped, which is exactly
  what makes the *on-box* walkthrough (never exercised against a real old or
  real upgraded ffmpeg build) the remaining debt. No file under
  `docs/testing/` records an ffmpeg-floor run sheet.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** The full six-step walkthrough on a box where ffmpeg can
  be swapped between a real <4.4 build and a real ≥6.0 build — preflight
  exit 1, the amber wizard card, the admin health dot, Re-check without a
  restart, the `minimum: null` rollback, and confirming the upgrade advice
  itself actually clears the card. Also owed: the Pinokio `"ffmpeg>=6"`
  constraint on a real conda env (group with E1).
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card (any machine, no GPU
  strictly required, but grouped with E1's Pinokio box)
- **Est. box time:** 30 (six-step walkthrough plus the Pinokio constraint
  check, shared setup with E1)

### E7 · fe-57 venv-bootstrap progress card — the fix nothing automated can prove (#1883, plan 270)

- **Verdict:** STILL OWED
- **Evidence:** `src/components/venv-bootstrap.test.tsx:8,18-19` still stubs
  `fetch` globally (`vi.stubGlobal('fetch', fetchMock)`) rather than driving
  a real bootstrap job. `docs/features/270-openapi-setup-surface.md:166`
  reads "On-box acceptance owed — register row E7" verbatim. `gh issue view
  1883 --repo dudarenok-maker/Castwright --json state,closedAt` →
  `{"state":"CLOSED","closedAt":"2026-07-27T23:03:10Z"}` — the type-drift
  bug itself is fixed and pinned by an `it.each` regression, but that
  regression also mocks `fetch`, so it cannot prove the fix against a real
  multi-minute bootstrap.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** On a box with no `server/tts-sidecar/.venv`, click
  "Set up the voice engine runtime" and observe the progress card appear
  within ~1.5s, the step text change as the real job advances, the
  terminal green "ready" card with `onBootstrapped` refetching, and — if
  cheap to induce — the red failure card with a working "Try again".
- **Decision owed:** n/a
- **Hardware still required:** none (any machine, no GPU)
- **Est. box time:** 15 (dominated by the real ~2GB download/install)

### E8 · ops-36 golden-assembly on a second ffmpeg build (#1880, plan 272)

- **Verdict:** STILL OWED
- **Evidence:** `package.json:71` defines `"test:golden-audio:assembly":
  "npm --prefix server run test:golden"`, and grepping
  `.github/workflows/*.yml` for `golden-audio`/`golden-assembly` returns no
  matches — the tier is confirmed absent from CI, so it never runs against
  more than the one ffmpeg build available in any single CI/dev
  environment. `docs/features/272-golden-assembly-comparison.md:140,208,222`
  all reference "the owed on-box acceptance row" for the cross-build half.
  `gh issue view 1880 --repo dudarenok-maker/Castwright --json
  state,closedAt` → `{"state":"CLOSED","closedAt":
  "2026-07-28T10:38:55Z"}`.
- **What changed since the row was written:** Nothing found. The LOOSE
  branch itself remains demonstrated (synthetic banner mismatch, 24.79%
  RMS-error against a 16% tolerance) — only the genuinely-different-build
  case is unproven.
- **Remains owed:** Run `npm run test:golden-audio:assembly` on a box whose
  real `ffmpeg -version` banner differs from the baseline's; record which of
  L1/L2/L3 fire and their deltas, whether L4 takes the LOOSE path, and
  L4-loose's actual RMS-error.
- **Decision owed:** n/a
- **Hardware still required:** none (any machine with a different ffmpeg
  build, no GPU)
- **Est. box time:** 10

### E9 · ORT marker — the Pinokio update path (#2192, plan 282) · group with E1

- **Verdict:** STILL OWED
- **Evidence:** `docs/testing/ort-marker-onbox-acceptance.md:236-245`
  (§6.3 "Criterion 4 — Pinokio update path (E9)" Result section) has every
  field still reading `_(fill in)_` — `reqHash` branch taken, `pip check`
  immediately post-Update, the self-heal-at-boot observation, the Qwen3
  install result, the `install.js` pass outcome, and the run metadata are
  all blank. `gh issue view 2192 --repo dudarenok-maker/Castwright --json
  state,closedAt` → `{"state":"CLOSED","closedAt":
  "2026-08-08T02:55:52Z"}` — the bug is fixed; this row is the unexercised
  out-of-process (Update/Install entry point) acceptance criterion.
- **What changed since the row was written:** Nothing found — the run
  sheet's own criterion-4 section is unchanged and unfilled.
- **Remains owed:** On a machine with Pinokio and an existing pre-fix
  install, run Update on the nvidia profile, confirm the `noop`/
  `pip-in-place` branch behaves as documented (including the self-heal at
  next server boot if `noop`), confirm Qwen3 installs with no `WinError 5`,
  and in the same session run a fresh `install.js` pass confirming the
  same outcome.
- **Decision owed:** n/a
- **Hardware still required:** single 8 GB card (nvidia profile; shares
  setup with E1's Pinokio box)
- **Est. box time:** 30 (per the row's own estimate, shared with E1)

### E10 · revoke is loopback-only — the forwarder boundary and the copy that replaces the button (#2269, PR #2280, plan 225) · group with E2/E3

- **Verdict:** STILL OWED
- **Evidence:** `server/src/routes/devices.test.ts:370-371` still
  fabricates a request object with `ip: '127.0.0.2'` / `socket.
  remoteAddress: '127.0.0.2'` rather than going through the real `:443`
  forwarder (`lan-port-forwarder.ts`), and no file under `docs/testing/`
  (searched for "revoke"/"loopback") records a real-forwarder,
  real-phone-paired revoke run. `gh issue view 2269 --repo dudarenok-maker/
  Castwright --json state,closedAt` → `{"state":"CLOSED","closedAt":
  "2026-08-12T00:57:15Z"}`; `gh pr view 2280 --repo dudarenok-maker/
  Castwright --json state,mergedAt` → `{"state":"MERGED","mergedAt":
  "2026-08-12T00:57:14Z"}`.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** With `LAN_HTTPS_PORT` set to a **non-default** value and
  the `:443` forwarder actually bound: revoke succeeds from
  `https://localhost:<port>`; from `https://localhost/` (through the
  forwarder) the button renders but returns 403 with the actionable
  direct-port sentence, not a raw `revoke failed (403)`; from a paired
  phone on `castwright.local` no Revoke control renders anywhere and the
  explanation appears once below the list (check with ≥3 paired devices);
  and a direct `DELETE /api/devices/<host id>` from a paired LAN device
  returns 403 with the host's own record left live afterward.
- **Decision owed:** n/a
- **Hardware still required:** phone / Mac / browser
- **Est. box time:** 20 (shares its whole setup with E2 and E3, per the
  row's own text)

### E11 · `measure-attribution.mjs` against the real workspace (#1984 Wave 1)

- **Verdict:** SHRUNK
- **Evidence:** `docs/testing/attribution-collapse-visibility-onbox-
  acceptance.md:170-178` (§5, D13 verdict) is marked "COMPLETE, 2026-08-14,
  primary checkout at `df49a261`" — this discharges item (1), the full
  read-only run proving real book state, matching the register's own
  "Item (1) DISCHARGED 2026-08-14" note. But §4 "Dash-stripped invariance
  (criterion 3, on-box)" (`:157-168`) still reads "**Result: NOT YET RUN**",
  and lines `:116-144` (`demotedNarrator`/`modelNarrator` re-analysis
  investigation) are still unchecked `- [ ]` boxes. `gh issue view 1984
  --repo dudarenok-maker/Castwright --json state,closedAt` →
  `{"state":"CLOSED","closedAt":"2026-08-13T08:42:45Z"}`.
- **What changed since the row was written:** Nothing beyond what the
  register itself already records (item 1 discharged 2026-08-14, D13
  re-gate closed as #2357). The two GPU-dependent items the register
  already flagged as still owed remain owed, unchanged.
- **Remains owed:** (2) the dash-stripped re-run invariance check — run the
  script twice, second time over scratch-path copies of each cache with
  every leading dash stripped, diff every field of every row; (3)
  re-analysing one book post-D18 to confirm `demotedNarrator`/
  `modelNarrator` actually populate outside a unit fixture. Both need
  GPU/analysis time.
- **Decision owed:** n/a
- **Hardware still required:** real workspace, no GPU needed for (1)
  (already discharged); (2) and (3) need GPU/analysis time
- **Est. box time:** under 5 (item 1, discharged); (2) and (3) not
  estimated in the row — need GPU time to scope

### F1 · Android companion app — v1 live-device acceptance (plan 188) · an entire untested axis

- **Verdict:** STILL OWED
- **Evidence:** `docs/features/188-android-companion-app.md:24` still reads
  "all built, tested, and merged. The only thing left is the batched
  live-device acceptance pass" verbatim, and every named module row
  (`app-3` through `app-14`) plus the Ship-notes table (`:790-845`) still
  carries "**Live device acceptance owed**" / "**Live device/head-unit
  acceptance owed**" against every entry. No file under `docs/testing/`
  records a live-device run.
- **What changed since the row was written:** Nothing found.
- **Remains owed:** The full plan 188 live-device pass — v1 core end-to-end
  (QR pairing, library browse, offline download/playback with lock-screen
  and Bluetooth controls, dual-book resume, targeted re-sync of a
  regenerated chapter, in-car listening-position push-back), app-9
  (Android Auto / CarPlay media-browse and playback on a real head unit),
  and app-10 (stream-over-LAN: instant start, mid-chapter seek, lock-screen
  transport, backgrounding survival, no cert-install prompt, and the
  download-to-play fallback when streaming is off or off-Wi-Fi).
- **Decision owed:** n/a
- **Hardware still required:** Android device (a real phone, plan names a
  Pixel 10 Pro; app-9 additionally needs a real Android Auto/CarPlay head
  unit)
- **Est. box time:** not estimated in the plan — an entire untested axis,
  not batchable with any other group
