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
