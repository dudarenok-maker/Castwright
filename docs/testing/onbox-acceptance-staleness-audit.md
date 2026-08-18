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

## A1 · fs-38 Wave 3 — voice cloning (now incl. 3c) · 20 of 60 run (2026-07-29, 2026-07-31) · ~40 still owed · 3 run-2 results retracted

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
  internal "done" marker either way. The header explicitly calls out this
  exact contradiction is NOT present in the header text itself — re-reading
  closely, the header never actually names "S6" (that framing is the
  register's own paraphrase, not the plan's wording) — the plan file itself
  does not contain a token "S6" (`grep -n "S6" docs/features/264-vram-aware-gpu-placement.md`
  → no matches), so the specific self-contradiction the register describes
  ("lists S6 as both exercised and item-6-not-force-driven") could not be
  independently located in the plan text as worded. Separately, PR #1732
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
  on-box (per the walkthrough section's declarative step wording) or as
  still-owed-and-deferred-by-choice (per the header's closing sentence) is a
  single-sentence-resolvable disagreement inside the plan text itself that
  this audit is not authorised to settle; note for routing per #2435 that the
  literal "S6" self-contradiction the original row asserted was not
  reproducible verbatim in the current plan text (no `S6` token exists in the
  file) — worth a human recheck of whether the row was describing an earlier
  plan revision.
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
- **Evidence:** `docs/features/165-fe-15-16-language-and-revision-e2e.md`
  frontmatter `status: active` (`:2`) directly contradicts its own body
  `> Status: stable (shipped together; manual acceptance owed only for the
  live Qwen auto-load)` (`:9`) — confirmed by direct read, not just the
  register's paraphrase. Ship notes (`:103-108`): "Shipped 2026-06-01 on
  branch `feat/frontend-fe-15-16` (PR pending)... fe-16 Qwen auto-load is
  wired and unit-covered; live GPU acceptance is the only owed item." No PR
  number is filled in anywhere in the file — "(PR pending)" is still literal
  text, not a placeholder later replaced. `git log --oneline --
  docs/features/165-fe-15-16-language-and-revision-e2e.md` shows the plan
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
