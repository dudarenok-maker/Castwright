---
status: draft
revision: 3 (both assumption-checker passes on PR #4189 folded, 2026-11-15, around the owner's binding decisions D1-D4; revision 2 folded the manual check F1-F24, V2-V4, D)
issue: 3456
refs: [3400, 3397, 3457, 3704, 3711, 3717, 3774, 4166, 4167]
verified-at: a9918640 (no server file this spec cites changed since 3792b84b, where revision 2 was verified)
decisions: OD1-OD8 accepted by the owner 2026-11-14; D1-D4 binding 2026-11-15; the items under "Decisions made in revision 3" are owed owner confirmation
---

# Chapter take lifecycle: who owns a chapter's live and `.previous` audio (#3456)

## Revision 3 changelog

Two `assumption-checker` passes ran on revision 2 (PR #4189 comments): pass A at head `f774b442`
and pass 1 at head `4653989f`. Together they returned 1 Critical and 8 Significant findings, plus
Minors and three owed questions. The owner settled the four that needed a decision on 2026-11-15
(D1–D4, binding, quoted under "Owner decisions"). Every finding was re-checked against
`origin/main` (`a9918640`). The cited server files are byte-identical to `3792b84b`, so revision 2's
anchors still hold, except where a row below corrects one.

| Finding (pass) | Resolution in revision 3 |
|---|---|
| **Critical: `takeSeq` has two meanings, so the CAS can't both close ABA and let partial jobs commit** (A, 1) | **D1.** `takeSeq`/`audioTakeSeq` are removed throughout. The CAS compares the live `takeId` only (§4.1). ABA is benign, and the reasoning is stated in §4.1. The Accept bump, the journal target seq and migration's seq steps are gone. There is a new positive-control race test, "a splice after Accept commits" (§5.A Tests). |
| Accept is not refused during jobs, and the journal stores no target seq, so replay double-bumps (A) | Nothing is bumped any more (D1). Replay is a pure function of what is on disk (§5.A Journal rules). |
| **S: OD3's roll-forward contradicts CLAUDE.md's fail-loud stamp; the failure-stamp guard keys on the field a failed stamp didn't write; replay may not run soon** (A1) | **D2.** A stamp failure after `installed` rethrows. "This take committed" is decided by the journal plus the live `segments.json` `takeId`, never by `state.json` (§5.A Commit, Failure handling). The failure-stamp guard reads the module's `takeCommitted`. Replay runs at every entry point and in the failing job's own catch path, not only at boot. OD3 is restated. |
| **S: W1–W12 misses bundle-import overwrite, backup restore and the PUT `/state` passthrough** (A2, 1) | **D3.** They become W13–W15 (§2.2). Each one goes through a module entry point: `replaceTakesFromBundle`, `reconcileBookTakes` and the shared `TAKE_STATE_FIELDS` list (§5.A Ownership). `chapter-uuid.ts`, `scan-import-folder.ts`, `backup.ts` and `auto-backup.ts` join the blast radius. |
| **S: take ids are minted only at boot** (A3, 1) | **D3.** `ensureTakeIdentity` mints lazily at every module entry point, for a book of any age (§4.1). The boot fsck is now just one more caller. |
| **S: scoring isn't protected** (embeddings are read before segments; a splice's prepare-time carry-forward overwrites verdicts scoring committed in between) (A4) | Embeddings and verdict files carry their take's `takeId` (§4.3). Scoring's CAS reads it from the embeddings file it scores. The OD4 carry-forward moves **into the commit span**, so it copies the verdicts that are live at commit, not the ones live at prepare (§5.A Commit step 4). |
| **S: `scoreBook` writes incrementally by design; the attempted marker stamps at pass start; `triggerScoring` drops triggers, so "picked up by the next pass" is false; the resume route is missing** (1) | `commitScoring` is **one short span per character write**, which keeps srv-36's incremental writes (§5.A Scoring). The attempted marker goes through the same CAS. `triggerScoring` gains a coalesced re-run flag in place of the silent drop (decision R3-3). `qa-report.ts` joins the blast radius. |
| **S: preparing outside the lock isn't safe** (an orphaned body writes after the watchdog releases the token; `writeJsonAtomic` recreates parent directories; nothing cleans `.next-*`) (A5, 1) | **D4.** Staging writes never create directories, and they check the signal before each part (§5.A Prepare). Every non-commit exit sweeps the staged and discard sets: abort, CAS mismatch, crash, watchdog abandonment. `reconcileSlug` and the fsck sweep anything left (§5.A Sweep). `completedSlugs` counts exact live names only (§2.3 R-d). |
| **S: "a live take exists" is never defined; the H6/N8 shape either faults or discards the only copy** (A6) | **D3.** §4.2 defines it on the live **audio** file. The H6/N8 shape (live segments, no live audio, previous present) has **no** live take. Its orphan segments are quarantined, and its previous take is the only copy and is never discarded. |
| **S: migration step 6 relies on a missing UI path** (A7) | Automatic promotion is kept for the unambiguous no-live-take shape: not excluded and no journal. It now runs as a journalled `restoreTake` at any entry point, not as fsck case 1's unjournalled renames (§6.1 step 6, decision R3-5). |
| **S: Windows holders.** An ffmpeg reader deterministically blocks the commit's renames (probe); only lock timeouts were retried; the 1 s cap undercuts OneDrive's 3.6 s budget; R-f mislabels the codec zip (1) | **D4.** EBUSY/EPERM keeps the staged take, rolls back what moved, and retries with a bound the assembly watchdog sees (`stallPhase = 'commit'`, §5.A Retries). The 1 s cap is removed in favour of a span deadline (decision R3-2). The live audio is moved first, so a held file fails before anything else moves. The protocol never renames **onto** a held name (§5.A Windows). R-f is corrected: the codec zip is a Node stream. Row Q's NTFS cells are recorded from the probe; OneDrive is still owed. |
| **S: commit-span contention.** Job registration and autosaves wait on book-op with no retry; an unbounded retry removes the watchdog ceiling; the span is more than ~15 parts; `renameWithRetry` retries ENOENT (A minor, 1) | A hard **span deadline** below the 10 s acquisition budget, so one commit can never time out a waiter (R3-2). Retries happen **between** spans, under the watchdog. The count is corrected to 21 renames. Absent parts are skipped, not retried (§5.A Span length). |
| **S: N9 is not closed** (`::*` and `::X` don't displace each other; the second commit discards the user's pre-render take) (A minor, 1) | A render records `startTakeId`. When another commit landed in between, the commit **keeps the original previous take** and discards the intervening one (§5.A Commit step 4, decision R3-1). Displacement keying is unchanged. |
| **S: OD4 parity claim is false** (on `main`, splice never touches verdicts) (1) | The claim is withdrawn. OD4 is restated as a visible change: after Fix-audio, the re-synthesised sentences read unscored until the next pass. The coalesced re-run (R3-3) and a splice/QA-repair scoring trigger bound that window (decision R3-4). |
| **S: relabel journalling is never designed** (restructure writes `state.json` before the renames; a permutation can't replay per slug) (1) | A **book-level** relabel journal holds the whole rename map. Its replay direction is decided from `state.json`'s slugs (§5.A Restructure). `reconcileBook` runs book journals before slug journals. |
| **S: Phase 1 scope understated** (~47 non-test files) (A minor, 1) | The blast radius is restated with the reader count and the unlisted readers named. "Smallest blast radius" is withdrawn as a reason. The B and C estimates are corrected, since they touch the same readers (§5.A Blast radius, §5 Comparison, §6). |
| **S: the guard is blind to variable-suffix and zip-named writers** (1) | The guard gains a second rule, on fs mutations under `audio/` (§5.A Guard). The three known variable-suffix sites are named and fold into the module. Bundle import routes `audio/` through the module, and a test pins that. The remaining blind spots are listed in the guard's header, as `cast-lock.guard` does. |
| m: `deriveSegmentsHeal` backfills raw `meta.modelKey`, contradicting the effective-key derivation and the "no-op otherwise" re-stamp (1) | One derivation, `deriveTakeFields`, used by the heal **and** the stamp (§4.4). Migration re-stamps every field only on the legacy-reject shape. Otherwise it fills absent fields, so "no-op otherwise" holds (§6.1 step 5). |
| m: lock placement is ambiguous (1) | Entry points take a live `BookHandle` and never lock. Callers lock at the one sanctioned level. `scoreBook` receives a `commit` callback from its caller, so it never calls `withBookOp` itself (§5.A Fence). |
| m: commit retry can't tell timeouts apart; steps 0 and 2 take `state-json` (A) | The retry treats only a **pre-entry** timeout as book-op contention (an `entered` flag). Inner timeouts follow the journal. Replay is idempotent, so a re-run is safe (§5.A Retries). |
| m: discard names can collide (A) | Discards carry a role tag: `.discard-<jid>.prev.*`, `.live.*`, `.stale.*` (§5.A Commit). |
| m: `audio/.orphaned/` has no bound, retention or surfacing (A) | Per-event subfolders, never auto-deleted (OD8). Quarantine happens only in the enumerated shapes. Boot logs a per-book count and byte total. Export and backup skip it. UI surfacing is decision R3-6. |
| m: `.previous.take.json` duplicates the stamp derivation (A) | Removed. The previous take's own `segments.json` is the source (§4.3). |
| m: retiring `revision-op` touches unlisted tests and comments (A) | Listed in the blast radius and in Phase 3. |
| m: exclude leaves take fields in `state.json` (1) | `dropAllTakes` clears `TAKE_STATE_FIELDS` in the same state write (§5.A Exclude). |
| m: §2.1's `duration` claim is wrong (`restructure.ts:394`) (1) | Corrected: `duration` is carried unconditionally, and the other take fields only when the content is unchanged. |
| m: book-level centroids and pending-attempts are written unfenced (1) | Declared out of the take: they are book-level, single-flight per book, and re-derived each pass (§4.3). |
| m: ffprobe at ±0.5 s is unreliable on legacy MP3s with no Xing header; it falls through to mtime (A, 1) | Duration matching uses a full decode, which runs only for the rare multi-live shape (§6.1 step 2). |
| §8 questions answered from code (1) | Folded into §8: the attempted marker is existence-only; verdict keys survive carry-forward. |
| Pass A owed questions 1–3; pass 1 owed questions 1–3 | Answered in §8.1, one line each, by D1–D4. |

## Decisions made in revision 3 (owner to confirm)

D1–D4 left these open. Each takes the option most consistent with them.

- **R3-1 (N9).** A render records `startTakeId`. If the live take changed before its commit, the
  commit discards the **intervening** live take and keeps the existing previous take (the user's
  pre-render audio), instead of the plain "live becomes previous". This refines OD2's
  last-writer-wins: it changes which take becomes the previous one, and it never refuses a commit.
- **R3-2 (contention).** No `renameWithRetry` cap. Instead a **commit span deadline of 6 s**, below
  the 10 s acquisition budget. A span that would pass it rolls back and retries **between** spans.
  So no waiter (an autosave, a job registration) can time out behind a single commit.
- **R3-3 (scoring triggers).** `triggerScoring` replaces "drop while in flight" with one coalesced
  re-run per book. A pass that drops a chapter on a CAS mismatch also requests the re-run.
- **R3-4 (OD4 visibility).** Splice and QA repair call `triggerScoring` after a commit, as a full
  render's `afterChapterFinalized` does. That bounds how long re-synthesised sentences read
  unscored. It is a behaviour change from `main`, where splice never re-scores.
- **R3-5 (no-live-take shape).** The previous take is promoted automatically, through a journalled
  `restoreTake`, when there is no live audio, the chapter is not excluded, and no journal exists
  for the slug. This keeps today's fsck-case-1 outcome without its unjournalled renames, instead
  of relying on a UI path that does not exist.
- **R3-6 (`.orphaned/`).** No UI surface in v1 (the surface area is final). A per-book boot log
  line, no auto-delete. Surfacing it is a separate feature, if wanted.
- **R3-7 (stamp failure after install).** The job ends `chapter_failed` with a fixed sentence
  ("the new take was saved, but its details could not be recorded; they will be repaired"). It
  does **not** stamp `generationState: 'failed'`, because the take committed. The chapter's audio is
  the new take.
- **R3-8 (bundle overwrite).** For every chapter slug the bundle carries, the local take, previous
  take included, is replaced whole. A local chapter the bundle does not carry is left whole. That
  is take-granular "left in place", not file-granular.
- **R3-9 (backup restore).** After the old `state.json` is restored, the take fields are re-derived
  from the live `segments.json`. A backup restore no longer rewinds them to describe audio that is
  not on disk.

## Owner decisions

> **Accepted 2026-11-14:** the owner chose Option A (OD1) and accepted every other recommendation
> in this section as written.
>
> **Binding 2026-11-15 (D1–D4), after both assumption-checker passes:**
> - **D1.** Drop `takeSeq`. The CAS compares the per-commit random `takeId` only; a restore that
>   brings take A back brings A's `takeId` back, and a splice prepared against A then commits onto
>   A, which is correct because the content matches (ABA is benign). Positive-control race test: a
>   splice after Accept commits.
> - **D2.** A state stamp that fails after `installed` **rethrows** (the CLAUDE.md fail-loud site at
>   finalize's stamp is kept). The journal is the source of truth for "this take committed"; replay
>   is idempotent and runs at the module's entry points, not only at boot.
> - **D3.** The module owns **every** writer, including bundle-import overwrite, backup restore
>   and the PUT `/state` chapter passthrough. `takeId` is minted lazily at the module's own entry
>   points for any book of any age; the "a live take exists" definition is enforced there too,
>   including the H6/N8 shape.
> - **D4.** EBUSY/EPERM from an ffmpeg reader (m4b build, clips) keeps the staged take with a
>   bounded retry the assembly watchdog can see, never silently rolled back. The fsck and every
>   non-commit exit (abort, CAS mismatch, crash, watchdog abandonment) sweep `.next-*` /
>   `.discard-*`. `completedSlugs` must not count `.next-*`.
>
> The `assumption-checker` gate is owed again on this revision before any implementation chain is
> filed. Row Q's OneDrive cells must run on the box before Phase 2 (the NTFS cells are recorded,
> §5.A Windows).

**OD1 — Which component owns a chapter's take files, and how is everything else fenced?**
Three options are costed in §5. **Accepted: Option A.**
- One module, `workspace/chapter-take.ts`, is the only code that writes, renames or deletes a take
  part, or writes a take field in `state.json`.
- Every mutation runs inside a short `withBookOp` span that the caller holds.
- Long jobs prepare their new take outside the lock and **commit** it inside one span.
- The commit is guarded by a compare-and-swap (CAS) on the live take's filename-safe random
  `takeId` (D1), and by the job's abort signal.

**OD2 (F5) — A multi-chapter render running alongside a splice of one of its chapters.**
- **Accepted:** a multi-chapter (`*`) render aborts any in-flight splice or QA repair of a chapter
  **when it starts that chapter** (`abortInFlightSplice(bookId, chapter.id)` per chapter, not once
  per job). Full renders carry **no** base token.
- **Why no token:** a full render replaces every part and depends on nothing in the live take, so
  "the live take changed since I started" has no meaning for its *content*. Its commit is
  last-writer-wins. R3-1 decides which take becomes the previous one.
- A splice that starts *after* the render reached its chapter still aborts the whole `*` job
  (`abortInFlightChapterJob`, `generation.ts:521-524`). That is today's behaviour, unchanged.

**OD3 (F7), restated by D2 — What happens when a commit has installed the new take, and a later
step fails?**
- **The take stays committed.** Once the `installed` phase is journalled, the new take **is** the
  chapter. No rollback, ever.
- **The failure is loud.** A failed `state.json` stamp rethrows into the job's terminal outcome
  (R3-7). The journal stays at `installed`, and the next `reconcileSlug` re-runs the stamp. The
  first such run is the failing job's own catch path. That run is idempotent, because the stamp is
  a pure function of the live `segments.json`.
- **The review record stays best-effort**, as plan 285 decided. It surfaces as
  `reviewOutcome: 'failed'`, and `restore-unrecorded` stays the way back.

**OD4 (F3) — Scoring verdicts and embeddings after a partial re-record (splice, QA repair).**
- **Accepted: carry them forward.** For each segment the write did **not** re-synthesise, its rows
  are copied from the live take **at commit, inside the span**. The CAS guarantees that take is the
  job's base, and copying at commit keeps any verdict scoring committed meanwhile. Rows for
  re-synthesised segments are dropped, then replaced by fresh rows where the job has them:
  `reembeddedRows`, and QA repair's accepted acoustic verdicts (today's Edit 6b).
- **Not parity (corrected).** On `main`, a splice never touches the verdict file, so stale rows for
  re-synthesised segments keep applying. After this change those sentences read unscored until a
  scoring pass, which R3-4 triggers. `deriveBookOutline`, the `qa.speaker.autoRepair` loop and Edit
  6b keep their inputs.
- A full render starts with no verdicts. Scoring is triggered as today, by
  `afterChapterFinalized`.

Smaller decisions:

| | Decision | Accepted |
|---|---|---|
| OD5 | Which files and fields belong to a take | §4.3: seven sibling files, plus `TAKE_STATE_FIELDS` in `state.json` |
| OD6 | What excluding a chapter does to its takes | Drop the previous take, every live sibling, the take fields, and the pending entry. When the previous take is the **only** copy (§4.2), quarantine it instead of deleting it (F16). |
| OD7 (F20) | How export is fenced | **Reject** (and `restore-unrecorded`) refuse `book_busy` while an export runs. **Accept is not refused**: it renames only the previous take away, which no ffmpeg export reads (the portable bundle skips `.previous.`, `build-portable-book.ts:149`), and a Node stream does not block a rename-away (probe, §5.A Windows). A render's commit during an export **waits** under D4 while ffmpeg holds the live file. |
| OD8 | What migration does with a file it cannot place | Quarantine to `audio/.orphaned/`; never delete, never overwrite (F6) |

## 1. Why now, and what changed since the issue was filed

#3400 (plan 285/286) made `revisions.json` server-owned and moved the audio step into
`server/src/audio/previous-audio.ts` **unchanged**. It filed this issue for everything about the
audio files themselves.

Between the issue (2026-10-02) and `3792b84b`, other changes closed part of the space:

- **#3711 (plan 288).** Every quick per-book operation holds `book-op:<bookId>` for its whole span:
  - accept, reject and `restore-unrecorded`;
  - exclude;
  - every restructure;
  - reparse and replace;
  - the fsck's per-book step;
  - the bundle overwrite and backup restore.

  Long jobs (render, scoring, export, …) register through `runBookJob` instead. **So the quick
  operations are already mutually exclusive per book.**
- **#3774.** Restructure and exclude are refused while any long job is registered.
- **#3717.** Reparse and replace are refused the same way. So are the bundle overwrite and backup
  restore (`backup.ts:44-49`).
- **#3704 / #3400.** `rewriteChapterSlugs` moves and deletes `.previous.*` with the live take.
- **#3457.** The fsck no longer promotes `.previous.mp3` over a live `.m4a`/`.ogg`.
- **#3700 / #3625.** Every `state.json` read-modify-write named in the issue now runs under the
  `state-json` leaf lock.

The remaining question is therefore narrower. **The things left to fence are:**
1. the long-job **commit** of a take (finalize, called from generation, splice and QA repair);
2. **QA repair's post-finalize writes**;
3. **scoring's** verdict and attempted-marker writes;
4. the **whole-book writers** that bypass take semantics: bundle overwrite, backup restore and the
   state PUT (D3);
5. the **lock-free readers**.

The take files also need **one naming scheme**, a **defined fidelity**, a **defined "live take"**,
and a **recovery rule that does not guess**.

## 2. Inventory at `3792b84b` (unchanged at `a9918640`)

### 2.1 The files

| File | Written by | Moved by preserve? | Restructure |
|---|---|---|---|
| `<slug>.{mp3,m4a,ogg}` (live) | finalize `:753`; bundle overwrite | yes, always **to `.previous.mp3`** (`preserve-previous-audio.ts:38`) | moved/deleted |
| `<slug>.segments.json` | finalize `:752`; restructure metadata rewrite; bundle overwrite | yes | moved/deleted |
| `<slug>.peaks.json` | finalize `:755`; bundle overwrite | **no** | moved/deleted |
| `<slug>.lufs.json` | finalize `:274` (**before** preserve) | **no** | moved/deleted |
| `<slug>.embeddings.json` | finalize `:675`/`:744` (**before** preserve); QA repair Edit 6b (`chapter-qa-repair.ts:864`) | **no** | moved/deleted |
| `<slug>.render-integrity.json` | scoring (`aggregate.ts:1022`, per character via `mergeVerdictRows`, `verdicts-io.ts:42-58`); QA repair Edit 6b `writeVerdicts` (`chapter-qa-repair.ts:~870-899`) | **no** | moved/deleted |
| `<slug>.render-integrity-attempted.json` | `writeAttempted` in generation (`generation.ts:295`) and scoring (`aggregate.ts:638`); existence-only | **no** | moved/deleted |
| `<slug>.previous.mp3`, `.previous.segments.json` | preserve | — | moved/deleted |
| `<slug>.previous.peaks.json` / `.previous.lufs.json` | **nothing** (always absent) | — | listed, never present |
| `<slug>.<ext>.tmp-<pid>-<ts>` | finalize `:221-222` | — | **leaked on a throw** (#4167) |
| `state.json` chapter: `duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa` | finalize `:766-792`; backup restore (whole file); PUT `/state` (carried, `chapter-uuid.ts:121-170`) | **no** | `duration` carried **unconditionally** (`restructure.ts:394`); the other four only when the content is unchanged (`restructure.ts:410-420`) |

Scoring does **not** write embeddings (V3). Embeddings are written only by finalize and QA repair.
Book-level scoring files (centroids, pending-attempts) are not take parts (§4.3).

### 2.2 Writers

| # | Writer | Where | Locks today | Races |
|---|---|---|---|---|
| W1 | **Finalize** | `audio/finalize-chapter-write.ts:188-807` | None for the files. `state-json` for the stamp (`:766`). `revisions` in `applyReview` (`:798`). Its caller is a `render` job (no book-op). | Lufs and embeddings are written before preserve (H4). If `:753` fails, the **new** segments (`:752`) sit next to the old audio or none (H6). It interleaves with reject (H9), with a second finalize (N9), and with the fsck (N8). |
| W2 | **Generation** | `routes/generation.ts:858` (`runBookJob`); calls W1 at `:1996` | No book-op; abort-based displacement keyed `${bookId}::X` / `::*` (`:513-515`) | Finalize gets no signal. Bails at `:1957` (before assembly) and `:2044` (after finalize) only (H8). The watchdog releases the token while an abort-ignoring body can still run (`:2225-2243`) (N15). A `*` job's `abortInFlightSplice(bookId, null)` (`:1383`) is a no-op (`chapter-job-coordination.ts:54`) (H16 → OD2). `::*` and `::X` jobs don't displace each other (`:1318-1319`, `:1379-1383`) (N9). |
| W3 | **Splice** | `routes/chapter-splice.ts:174`; calls W1 at `:555` | No book-op; `registerSplice` at `:336` | Reads segments (`:185`) before it registers; the last abort check is `:526` (H7). Never triggers scoring (`:589-600`). |
| W4 | **QA repair** | `routes/chapter-qa-repair.ts:143`; calls W1 at `:804` | No book-op; registers at `:333` | Reads **and decodes** the audio (`:150-163`) before it registers (H7). **Edit 6b** writes embeddings (`:864`) and verdicts (`:~870-899`) **after** finalize returns, outside any fence (F4). Never triggers scoring (`:906-919`). |
| W5 | **Accept** | `routes/revision-ops.ts:65-121` → `acceptPreviousAudio` (`previous-audio.ts:27-34`) | `book-op` → `revision-op` → `revisions` | No busy check. `.previous.mp3` only (`previous-audio.ts:19-23`). |
| W6 | **Reject** | `revision-ops.ts:123-182` → `restorePreviousAudio` (`previous-audio.ts:39-61`) | as W5 | Unlinks the live take first (`:45-48`) (H1). Restores to `<slug>.mp3` (`:22`, `:51`) (H13). Swallows a failed segments rename (`:58`) (H2). Busy check is generation only (`generation.ts:661`) (H9). Restores audio and segments only, and **leaves `state.audioRenderedAt` naming the rejected take** (H3, F2). |
| W7 | **restore-unrecorded** | `routes/chapter-audio.ts:404-452` | `isGenerationActive`, then `book-op`; `revision-op` around the restore only | `has_revision` (`:420`) versus finalize's lock-free `recordPending` (H20). |
| W8 | **Restructure** | `chapters-restructure.ts:291-334` → `rewriteChapterSlugs` (deletes at `rewrite-chapter-slugs.ts:128-146`; renames `:155-238`) | `book-op` → gate → `book`; refused while jobs run | Writes `state.json` (`:610`) **before** the audio ops (`:650-654`), best-effort; no journal (N16). `buildAudioOps` skips a chapter with no `audioRenderedAt` (`restructure.ts:443`). |
| W9 | **Exclude** | `book-state.ts:2320-2440`; deletes at `:2409-2421` | `book-op` → `book` → `state-json`; refused while jobs run | Leaves `.previous.*`, every sidecar (H22) and the take fields in `state.json` (`:2355-2380`). Leaves the entry (N2). The fsck later promotes the previous take (N1). |
| W10 | **Boot fsck** | `workspace/fsck-orphan-audio.ts:57-132`; per-book step under book-op (`:165`); fire-and-forget at `index.ts:549`, its only caller | `book-op` per book | Skips books it cannot resolve (`:164-172`, `book-op-lock.ts:489`). Case 1 (`:85-108`) promotes `.previous.mp3` to `<slug>.mp3` (`:86,91`) **and `.previous.segments.json` over `<slug>.segments.json`** (`:93-96`) when no live audio exists (`:89`) (N1, N8, H18). |
| W11 | **Scoring** | `aggregate.ts:1022` (verdicts, per character), `:638` (attempted, at pass start); a `scoring` job via `triggerScoring` (`generation.ts:143`) and `resume-scoring` (`qa-report.ts:59-76`) | none | Reads embeddings (`:602`) before segments (`:643`). Files verdicts under whichever take is live when it writes (N7). `triggerScoring` **drops** a trigger while a pass is in flight (`:143`). |
| W12 | **Reparse / replace** | `book-state.ts:2131,2213` | `book-op`; refused while jobs run | Wipes `audio/` wholesale (fixed: H16, first half). |
| W13 | **Bundle-import overwrite** | `import/scan-import-folder.ts:518-535` | `book-op`; `state-json` around the rename loop; refused while jobs run | Renames the bundle's zip-named audio, segments and peaks over live files and **leaves every other local part** (`:15-19`): a mixed take (N11). The ids it brings are not checked. |
| W14 | **Backup restore** | `routes/backup.ts:37-55` → `workspace/auto-backup.ts:209-270` | `book-op`; refused while jobs run | Swaps an old `state.json` in, take fields included, while the audio on disk stays current (N12). |
| W15 | **PUT `/state` chapter passthrough** | `workspace/chapter-uuid.ts:121-170` (`carryServerOwnedChapterFields`) | `book-op` → `book` → `state-json` | Only the five fields in `SERVER_OWNED_CHAPTER_FIELDS` come from disk. Any new take field (`audioTakeId`) would **pass through from the client** (N13). |

### 2.3 Readers

Pass 1 counted **about 47 non-test server files** that build or read a take name. The rows below
are the ones with a named hazard. The others are listed in the blast radius (§5.A).

| # | Reader | Where | Hazard |
|---|---|---|---|
| R-a | GET live audio meta/file | `chapter-audio.ts:236-276,316-366`, no lock | 404 inside reject's unlink-then-rename window; transient audio/segments skew. A Node read stream: it does not block a rename-away, but it does block a rename-**onto** (EPERM, probe) |
| R-b | GET previous meta/file | `chapter-audio.ts:284-312,367-370` | Served as `audio/mpeg` at `audio/previous.mp3` whatever the bytes (H14) |
| R-c | Revisions read view | `revisions-store.ts:121-145` via `hasPreviousAudio` (`preserve-previous-audio.ts:75-77`) | `.previous.mp3` only; must move with the naming |
| R-d | `completedSlugs` | `book-state.ts:782-791` | N3 (filed as **#4166**). It must also never count `<slug>.next-<id>.mp3` (D4): it uses the module's exact live-name predicate (§4.2) |
| R-e | `chapterLufs` | `book-state.ts:807-820` | Rejected take's loudness after a reject (H3) |
| R-f | Export builders | `routes/export.ts:522` (`export` job); `findChapterAudio` | Takes can be mixed mid-export. **ffmpeg holders:** the m4b builder (`export/build-m4b.ts:101,328-332,355`). The codec zip (`build-codec-zip.ts`) is a **Node stream** (corrected). |
| R-g | Companion sync manifest | `library-sync-manifest.ts:85-112` | Stale `fileSize`/`urlSuffix`; heals on the next sync |
| R-h | Clip | `routes/clip.ts:73,93-104`; **ffmpeg** `-c copy` holder | R-a window; blocks rename-away of the live file (EBUSY, probe) (N4) |
| R-i | Portable export | `build-portable-book.ts:141-157` | Its filter (`startsWith(slug.)` + an audio extension) would ship staged `.next-*`/`.discard-*` files (F15) |
| R-j | QA report, cast-audio-currency | `audio/qa-report.ts`, `store/cast-audio-currency.ts` | After a reject, `state` describes the rejected take (H3/F2) |
| R-k | Variable-suffix builders | `workspace/chapter-audio-file.ts:57`, `rewrite-chapter-slugs.ts:105-107`, `previous-audio.ts:128` | Build `<slug>.<suffix>` from a runtime suffix, which a literal-matching guard cannot see. Fold into the module (§5.A Guard) |

## 3. Hazards, verified at `3792b84b` (unchanged at `a9918640`)

Status key: **P** present, **F** fixed, **Pt** partly fixed, **N** newly found.

| ID | Hazard | Status | Evidence |
|---|---|---|---|
| H1 | Reject unlinks the live take before renaming the previous one in | P (mitigated by the `live_audio_missing` pre-check, `revision-ops.ts:92`) | `previous-audio.ts:45-55` |
| H2 | Reject swallows a failed segments rename | P | `previous-audio.ts:58` |
| H3 | Reject restores audio and segments only; state fields and sidecars stay with the rejected take | P | `previous-audio.ts:39-61` |
| H4 | New lufs and embeddings are written before preserve | P | finalize `:274`, `:675`, `:744` vs `:751` |
| H5 | Unlocked `state.json` writers | **F** (#3700/#3625) | guard `state-json-lock.guard.test.ts` |
| H6 | A failed finalize rename leaves no live audio | P, **worse**: the new segments are already live (`:752`), the tmp file leaks (#4167), there is no stamp | `:751-753` |
| H7 | Splice and QA repair read before they register | P | splice `:185` vs `:336`; QA repair `:150-163` vs `:333` |
| H8 | Stalled or displaced generation still commits | **Pt** (#3711) | `:1957`, `:2044`; finalize takes no signal |
| H9 | No exclusion between accept/reject and running jobs | **Pt** (#3711: no job can *start* during either) | `generation.ts:661` sees generation only; accept checks nothing |
| H10 | Rename leaves `.previous` under the old slug | **F** (#3400/#3704) | `rewrite-chapter-slugs.ts:45-55` |
| H11 | Split/merge keep `.previous` | **F**; residual at `restructure.ts:443` | `rewrite-chapter-slugs.ts:128-146` |
| H12 | `.previous` is always `.mp3` | P | `preserve-previous-audio.ts:38`; `revisions-store.ts:38,143` |
| H13 | Restore and fsck promote to `<slug>.mp3` | P | `previous-audio.ts:22,51`; `fsck-orphan-audio.ts:86,91` |
| H14 | The A-side routes are mp3-only | P | `chapter-audio.ts:304,367-370` |
| H15 | The fsck promotes over a live m4a/ogg | **F** (#3457) | `fsck-orphan-audio.ts:89` |
| H16 | Reparse races jobs; `abortInFlightSplice(null)` is a no-op | **F** for reparse (#3717); the no-op is P (→ OD2) | `generation.ts:1383` |
| H17 | Reject's audio succeeds, its JSON fails, the retry gets `no_previous_audio`, and "Keep new take" records `accepted` | P | `revision-ops.ts:149-173` |
| H18 | The fsck promotes before the user retries Reject | P | `fsck-orphan-audio.ts:85-108` |
| H19 | A failed `recordPending` leaves a stale entry | **Pt** (`entryMatchesChapter`, `revisions-store.ts:199-203`; legacy entries uncovered) | — |
| H20 | `restore-unrecorded` check-then-act | **Pt** | `chapter-audio.ts:417-431` |
| H22 | Exclude leaves the previous take, sidecars and take fields | P | `book-state.ts:2355-2380,2409-2421` |
| N1 | **The fsck resurrects an excluded chapter's audio** | N | Exclude leaves `.previous.mp3`; fsck case 1 never reads `state.json` |
| N2 | A pending entry survives exclude; Reject restores audio onto an excluded chapter | N | — |
| N3 | `completedSlugs` misses `.ogg` and counts a lone `.previous.mp3` | N; **filed and queued as #4166** | `book-state.ts:785-788` |
| N4 | **Windows, verified on NTFS by pass 1's probe.** An ffmpeg reader of the live file (m4b build, clip cut) makes rename-away fail EBUSY, rename-onto fail EPERM, and unlink fail EBUSY. A Node `openSync` holder makes rename-onto fail EPERM only. Preserve swallows its failure, so today a commit during an export can leave old audio + new segments, or **two live files** on a format switch. | N, NTFS confirmed; OneDrive owed (row Q) | probe (PR #4189, pass 1); `preserve-previous-audio.ts:42-51`; finalize `:752-753` |
| N5 | Finalize tmp leaked on a throw | N; **filed and queued as #4167** | `:221-222` |
| N6 | `splice_complete`/QA-repair completion always send `hasPreviousAudio: true` | N (minor) | `chapter-splice.ts:596`, `chapter-qa-repair.ts:915` |
| N7 | Scoring files verdicts and attempted markers under whichever take is live; QA repair's Edit 6b writes embeddings and verdicts after finalize, unfenced | N | `aggregate.ts:602,638,643,1022`; `chapter-qa-repair.ts:864,~870-899` |
| N8 | The fsck runs alongside requests. Between finalize's segments write (`:752`) and its audio install (`:753`), live audio is absent, so case 1 promotes `.previous.mp3` **and renames `.previous.segments.json` over the new segments**. | N | `fsck-orphan-audio.ts:89-96` |
| N9 | Two renders of one chapter (`::*` and `::X`, which don't displace each other) interleave, and the second commit discards the user's pre-render take | N | `generation.ts:513-515,1318-1319,1379-1383` |
| N10 | `revision-op` is redundant: its only holders (`revision-ops.ts:58`, `chapter-audio.ts:429`) are inside `withBookOp` | N (observation, confirmed by pass A) | — |
| N11 | Bundle overwrite leaves a mixed take: the bundle's audio/segments/peaks beside the local lufs, embeddings, verdicts and previous take | N | `scan-import-folder.ts:15-19,518-535` |
| N12 | Backup restore brings back take fields that describe audio no longer on disk | N | `backup.ts:37-55`; `auto-backup.ts:209-270` |
| N13 | The state PUT would pass a client-supplied take id straight through | N (latent: it bites the moment `audioTakeId` exists) | `chapter-uuid.ts:121-170` |
| N14 | Staged and discard files have no owner on abort, CAS mismatch, crash or watchdog abandonment, and `completedSlugs` would count a staged `.next-*.mp3` | N (in revision 2's design) | `book-state.ts:785-787` |
| N15 | A watchdog-abandoned render body keeps running after its token is released; any write that creates parent directories can then recreate a moved folder (the #3711 split-book mechanism) | N | `generation.ts:1954-1966,2225-2243,2499-2505`; `book-op-lock.ts:5-10` |
| N16 | Restructure writes `state.json` before its audio ops, best-effort, so a crash between them leaves state naming slugs whose files sit at the old names | N | `chapters-restructure.ts:605-610,650-654` |
| F2 | **Legacy rejects left `state.audioRenderedAt` (and `duration`/`audioModelKey`/`audioEngines`/`audioQa`) naming the rejected take while the live segments are the restored one.** `deriveSegmentsHeal` fills only *absent* fields (`scan.ts:1242-1287`), so this never heals. | N, data on disk today | `previous-audio.ts:39-61`; `revision-ops.ts:149-173` |

## 4. The take: identity, liveness, fidelity, metadata

### 4.1 Identity (F1, F13, F14; D1, D3)

A take has **one** identifier, its **`takeId`**: 16 lowercase base32 characters from
`crypto.randomBytes`, so it is filename-safe on NTFS.
- It is minted at every commit.
- It is stored in the take's own `segments.json` (`takeId`), in its `embeddings.json` and
  verdict file (§4.3), and mirrored in `state.json`'s `audioTakeId`.
- **The live `segments.json` is the truth.** `audioTakeId` is a derived mirror that
  `stampStateFromLiveTake` writes, like the other take fields.

**There is no sequence number (D1).** The CAS compares the base `takeId` a partial job read with
the live `segments.json`'s `takeId` at commit. Nothing else.

**Why ABA is benign.** A take's parts move together and keep their `takeId` (§4.3), so
"`takeId` = A" means "the parts on disk are take A's parts".
- **Prepared against A, live is A again at commit** (Reject restored A after a render made B
  live). The splice commits onto A. That is correct: its base content *is* the live content.
- **Prepared against B, live is A at commit.** Mismatch: the staged files are swept and the SSE
  event says "the chapter changed while this ran; retry".
- **Prepared against B, Accept in between.** Accept leaves B live (it only discards the previous
  take), so the splice commits. That is the positive control (§5.A Tests).
- **Two commits in one millisecond** get distinct random ids (F13).

**Lazy minting (D3).** `ensureTakeIdentity(handle, slug)` runs at the start of **every** module
entry point, under the caller's book-op, for a book of any age:
- live take present (§4.2) and its `segments.json` lacks `takeId` → mint one, write it into the
  live `segments.json`, `embeddings.json` and verdict file, then `stampStateFromLiveTake`;
- previous take present and lacking a `takeId` → mint one into `.previous.segments.json` (and its
  previous sidecars);
- the boot fsck is just one more caller. A book that is skipped at boot, has no `bookId`, or was
  imported after boot gets its ids on its first touch.

**Where a partial job reads its base (F2, H7).** Splice and QA repair register first. Then, in one
short span of their own, they call `ensureTakeIdentity` and read the live `segments.json` (and QA
repair's decode input) and its `takeId`. So no partial job ever runs against an id-less base, and
the read sits after registration.

Restructure carries `audioTakeId` across a rename with the other take fields. Staging, discard and
journal **file names use `takeId` or a fresh journal id, never a timestamp.**

### 4.2 "A live take exists" (D3)

The module exports one predicate, used by every entry point, the fsck, and `completedSlugs`:

- **Live audio** of a slug means a file whose whole name matches `^<slug>\.(mp3|m4a|ogg)$`.
  `<slug>.next-<id>.mp3`, `.discard-*`, `.previous.*` and `*.tmp-*` never match.
- **A live take exists ⇔ exactly one live audio file exists.** Segments and sidecars do not make a
  take live.

| Shape on disk | Live take? | What the module does |
|---|---|---|
| live audio + live segments | yes | normal |
| live audio, no live segments (legacy) | yes, **unindexed** | a commit preserves it whole; a partial job refuses with "re-render needed" (no segments to splice) |
| **H6/N8: live segments, no live audio, previous present** | **no** | the live segments (and any live sidecars) are **orphan parts**: they are quarantined to `.orphaned/` first, never renamed onto. The previous take is the **only copy** and is never discarded. Then R3-5 promotes it, unless the chapter is excluded or a journal exists |
| live segments, no live audio, no previous | no | orphan parts quarantined; the chapter reads unrendered |
| no live audio, previous present | no | R3-5 (only-copy rule) |
| two or more live audio files | yes, **ambiguous** | §6.1 step 2 resolves it at the entry point before any other step |

### 4.3 Fidelity (OD5)

A take is preserved, restored, accepted, relabelled and deleted as one unit:

| Part | Member? | Carries `takeId`? |
|---|---|---|
| audio `<slug>.<ext>` | yes | no (the name and the segments identify it) |
| `segments.json` | yes | **yes, the truth** |
| `peaks.json`, `lufs.json` | yes | no |
| `embeddings.json` | yes | **yes**: scoring's CAS reads it from the file it scores |
| `render-integrity.json`, `render-integrity-attempted.json` | yes (OD4 for partial writes) | verdicts **yes**; the attempted marker is existence-only, and its CAS is the scorer's embeddings id |
| `state.json` `TAKE_STATE_FIELDS`: `duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa`, `audioTakeId` | yes: **derived** from the live `segments.json` (§4.4); a previous take's fields are derived from its own `.previous.segments.json` on restore | — |
| `generationState*`, `excluded`, `title`, `slug`, `uuid` | no | — |
| book-level centroids, pending-attempts | **no**: book-level, single-flight per book (`scoringInFlight`), re-derived each pass | — |

`.previous.take.json` (revision 2) is **removed**. It duplicated what the previous take's own
segments already give the stamp.

`TAKE_STATE_FIELDS` is exported from the module and is the **single list** behind:
- `stampStateFromLiveTake`;
- `chapter-uuid.ts`'s `SERVER_OWNED_CHAPTER_FIELDS`, so the PUT can never pass a client take field
  through (N13);
- restructure's carry list;
- exclude's clear.

### 4.4 `deriveTakeFields` and `stampStateFromLiveTake` (F2, F21)

`deriveTakeFields(segments)` is one pure function. It is used by the stamp **and** by `scan.ts`'s
`deriveSegmentsHeal`, which today backfills the raw `meta.modelKey` (`scan.ts:1279`):

| `state.json` field | Derived from |
|---|---|
| `duration` | `formatDuration(durationSec)` |
| `audioModelKey` | `effectiveAudioModelKey(engineBreakdownFromSnapshots(characterSnapshots), modelKey)`, exactly as finalize does (`:652-653`), **never the raw `modelKey`** |
| `audioEngines` | the same breakdown |
| `audioRenderedAt` | `synthesizedAt` |
| `audioQa` | `qa` |
| `audioTakeId` | `takeId` |

`stampStateFromLiveTake(handle, slug)` runs inside `book` → `state-json` and sets every field it
derives. A field the segments file lacks is left as it is. The heal keeps its fill-absent-only
semantics, through the same derivation.

The stamp is a pure function of the live `segments.json`, so running it twice is the same as
running it once. It is used by:
- the commit;
- restore;
- journal replay;
- `ensureTakeIdentity`;
- `reconcileBookTakes` (backup restore, W14);
- migration's legacy-reject re-stamp (§6.1 step 5).

## 5. Options

### Option A: one take module, commits inside a book-op span (accepted)

**Ownership (F4, F19; D3).**

`chapter-take.ts` holds:
- the **only** take-path builders, plus read-only accessors for readers;
- the live-take predicate (§4.2) and `TAKE_STATE_FIELDS` (§4.3);
- every take mutation.

Each entry point takes a live `BookHandle`, and each starts with `reconcileBook` (book journals),
then `reconcileSlug` and `ensureTakeIdentity` for each slug it touches.

| Entry point | Replaces or serves |
|---|---|
| `commitTake` | finalize's preserve and install |
| `acceptTake` | accept's audio step |
| `restoreTake` | reject's audio step; R3-5's promotion |
| `dropAllTakes` | exclude's deletes, and a restructure delete op |
| `relabelTakes` | restructure renames: `rewriteChapterSlugs` moves into the module |
| `commitScoring` | the scoring and attempted-marker writes (F23) |
| `replaceTakesFromBundle` | the bundle overwrite's `audio/` subtree (W13, R3-8) |
| `reconcileBookTakes` | after a backup restore (W14, R3-9), and the fsck's per-book step |
| `stampStateFromLiveTake` | the state stamp (§4.4) |
| `reconcileSlug` / `reconcileBook` | journal replay and the sweep |
| `ensureTakeIdentity` | lazy minting (§4.1) |

- QA repair's Edit 6b embeddings and verdicts become **staged inputs** to `commitTake`. They are
  no longer post-finalize writes.
- The reparse/replace wipe of `audio/` stays where it is, on an **allowlist**. It is a
  whole-directory removal under book-op with no job registered, and it touches no single take.
- The bundle overwrite's generic rename loop **excludes `audio/`**, and a test pins that. The
  module installs each bundle chapter as a whole live take: it mints a `takeId` when the bundle's
  segments lack one, stamps state, and replaces that slug's local live and previous takes whole.
- The PUT `/state` (W15) owns no take files. It is covered by `TAKE_STATE_FIELDS`.

**The guard** is `workspace/chapter-take.guard.test.ts`, in the shape of
`state-json-lock.guard.test.ts`. It is syntactic over `server/src` non-test files. It fails on:
1. any template literal or `join` that forms `<slug>.<takeSuffix>` (the module's suffix table,
   `.previous.*`, `.next-*` and `.discard-*` included) outside the module and its allowlist;
2. any call to `rename`, `renameWithRetry`, `rm`, `unlink`, `writeFile`, `writeJsonAtomic`,
   `writeEmbeddings`, `writeVerdicts`, `mergeVerdictRows`, `writeAttempted`,
   `writeChapterPeaksFile` or `writeChapterLufsFile` whose path argument comes from such an
   expression;
3. **(new)** any such mutation call whose path argument derives from `audioDir(…)`, or from an
   `audio/` literal, outside the module. This catches a runtime suffix (R-k) and a zip-relative
   path that rule 1 cannot see. The three known variable-suffix sites
   (`chapter-audio-file.ts:57`, `rewrite-chapter-slugs.ts:105-107`, `previous-audio.ts:128`) fold
   into the module.

The guard's header lists what it still cannot see, as `cast-lock.guard.test.ts` does: a path
passed through a variable from another module, and a new caller of a module entry point that
holds no book-op (the `BookHandle` capability check catches that at runtime instead).

**Allowlist:**
- read-only builders in R-a…R-k, which migrate to the module's accessors in Phase 1, after which
  the allowlist shrinks to zero;
- the reparse wipe.

**Fence and lock placement.**
- **Entry points never lock.** Each one takes a live `BookHandle` (book-op's capability token),
  and the module refuses a stale or hand-built one, as `moveBookFolder` does. That keeps book-op's
  "one level only, never inside a shared helper" and "never nest" rules.
- **Quick operations** (accept, reject, exclude, restructure, the bundle overwrite, backup restore,
  the fsck step) already hold book-op at their route or walker level. They pass their handle in.
- **A long job** opens `withBookOp` only at its own commit site, around `commitTake`. It holds no
  book-op of its own, so this is not nesting.
- **Scoring:** `scoreBook` is a shared function, so it never calls `withBookOp`. Its caller
  (`triggerScoring`'s `runBookJob` body, or the resume route) passes a
  `commit: (fn) => withBookOp(bookId, fn)` callback, and `scoreBook` calls `commitScoring` through
  it.
- Finalize splits into `prepareTake` (no lock) and the caller-invoked `commitTake`.

**Prepare** (`prepareTake`, no lock; N14, N15). Every new part is written to
`<slug>.next-<takeId>.<suffix>`: audio; segments (with `takeId`); peaks; lufs; embeddings (fresh
rows only, with `takeId`); fresh verdicts, if any.
- **Nothing live is touched.**
- **No directory is ever created.** The staging writer opens each file with `wx` in the existing
  `audio/` directory. If the directory is gone (the book moved after a watchdog released the
  token), it gets ENOENT and stops. It never recreates the folder (N15).
- **The signal is checked before each part.** Generation's watchdog aborts `chapterCtrl`, so an
  abandoned body stops at its next part.
- The module records each in-process staged `takeId` in a process-local `liveStaging` set until the
  job's commit or exit. The sweep (below) uses that set to tell a live staging from an orphan.

**Commit** (`commitTake(handle, staged, {base, startTakeId, signal})`), inside the caller's span:

0. `reconcileBook`, `reconcileSlug(slug)`, `ensureTakeIdentity(slug)`: replay any leftover
   journal (F8) and sweep orphans.
1. Refuse if `signal.aborted` (H8).
2. CAS, partial writers only (OD2): the live `segments.json`'s `takeId` must equal `base`. A
   mismatch sweeps the staged set and returns `changed`.
3. Write the journal `<slug>.take-journal.<journalId>.json`:
   `{op:'commit', phase:'discard', newTakeId, liveTakeId, prevTakeId, keepPrevious, parts}`.
   It lists only the parts **present** on disk at this moment, so no rename ever targets an absent
   optional part.
4. **Choose what becomes previous.** The previous take stays, and the live take is discarded
   instead, when either:
   - **No live take exists** (§4.2). The existing previous take is the only copy (F16).
   - **R3-1, for a full render:** the live `takeId` ≠ `startTakeId`, and the existing previous
     take's `takeId` = `startTakeId`. Another render committed meanwhile, and the previous take is
     the user's pre-render audio.

   Otherwise, the old previous take (all parts) moves to `.discard-<jid>.prev.*`. Parts are
   **renamed, never unlinked** (F9). For a partial writer, compute the OD4 carry-forward **now**,
   from the live verdicts and embeddings, and write it over the staged files.
5. `phase:'preserve'` (or, under `keepPrevious`, `phase:'discard-live'`):
   - **the live audio moves first.** It is the only file ffmpeg can hold, so a held file fails
     before anything else has moved (D4);
   - then each other live part moves to `.previous.<suffix>` with the **real extension**
     (`.previous.m4a`), or to `.discard-<jid>.live.*` under `keepPrevious`.

   Every rename refuses an existing target, by an `existsSync` check under the lock. A target that
   is present is a fault, not something to overwrite.
6. `phase:'install'`: rename each staged part onto its live name. Every live name is now free,
   because step 5 moved what was there. A different-extension live audio left over (N4) moves to
   `.discard-<jid>.stale.*`. **The protocol never renames onto a held name.**
7. `phase:'installed'`, journalled. **From here the take is committed (D2).** Then:
   - `stampStateFromLiveTake`, plus the `generationState*` clear. A failure **rethrows** (D2).
   - Record or drop the review entry, best-effort (OD3). Idempotent by `takeId`.
8. `phase:'cleanup'`: unlink the `.discard-<jid>.*` set, then the journal.

**Failure handling.**
- **Before `installed`:** roll back from the journal, in reverse order, inside the same span:
  installed parts back to `.next-*`, `.previous.*` back to live, discards back to previous. The
  staged set is **kept** when the cause is a held file (D4, below). Otherwise it is swept. A
  rollback step that itself fails leaves the journal for the next `reconcileSlug`.
- **At or after `installed` (D2):** the take is committed, and the error rethrows.
  - **Generation's outer catch** asks `takeCommitted(handle, slug, newTakeId)`: the live
    `segments.json` `takeId` = `newTakeId`, or a journal for `newTakeId` at `installed` or later.
    When it is true, the catch skips the `generationState: 'failed'` stamp
    (`generation.ts:2369`), runs one `reconcileSlug` in a fresh span, and ends the job
    `chapter_failed` with R3-7's sentence.
  - **Splice and QA repair** do the same with their own terminal frames.
  - **The fail-loud count is unchanged:** the CLAUDE.md site moves from finalize's stamp to
    `commitTake`'s stamp. The CLAUDE.md sentence is updated in Phase 2.

**Retries and the watchdog (F18; D4).**
- **The two retryable causes**, both of which keep the staged set:
  1. **A book-op acquisition timeout.** Recognised by an `entered` flag set as the first statement
     inside the `withBookOp` callback. A timeout with `entered = false` is contention for book-op
     itself. An inner timeout (`state-json` in steps 0 and 7) has `entered = true` and follows the
     journal rules above. Replay is idempotent, so re-running step 0 is safe.
  2. **A held file**: EBUSY or EPERM from step 5 or 6, after the in-span rollback.
- **Each retry runs between spans**, never inside one, with backoff (1 s, 2 s, 4 s, then every 5 s).
- **The bound is the assembly watchdog.** Generation sets `stallPhase = 'commit'` once when it
  enters the commit phase, and does **not** call `bumpProgress()` on retries. The existing
  no-progress ceiling therefore still bounds the wait.
  - If the watchdog fires between spans, the job fails as a stall named "commit". The message is
    the fixed sentence "the chapter's audio file is in use (an export or clip may be running); the
    render was not saved". The exit path sweeps the staged set. So it is reported, never silent
    (D4).
  - While a span is open, `committing = true` makes the watchdog defer its abort until the span
    exits. The span's deadline (below) bounds that wait.
- **`afterChapterFinalized`** (the attempted marker and the scoring trigger) runs **after** the span
  is released, and writes through `commitScoring`.

**Sweep (D4).** `reconcileSlug` and the fsck sweep the orphans, under book-op:
- `.next-<id>.*` with no journal naming `<id>` and `<id>` not in `liveStaging`: unlinked. These are
  never the user's audio: a staged take is not a take until `installed`.
- `.discard-<jid>.*` whose journal exists: handled by replay.
- `.discard-<jid>.*` with no journal: quarantined, not unlinked. The protocol unlinks the journal
  **last**, so this shape means something outside the protocol removed it.
- `*.tmp-<pid>-<ts>` (#4167): unlinked.
- **Every non-commit exit** sweeps its own staged set in a short span: abort, CAS mismatch,
  watchdog abandonment, and a job's `finally`. A crash leaves it for the next `reconcileSlug` or
  the boot fsck, where `liveStaging` is empty.

**Journal rules (F8; D2).**
- **Every entry point replays first** (`reconcileBook`, then `reconcileSlug`).
- **Replay** looks at a journal's `op` and `phase`, and at what is on disk:
  - **a commit**, before `installed`: roll back. From `installed` on: roll forward (stamp, review,
    cleanup).
  - **a restore**: as in the reject table below.
- **Idempotence.** Every step is "if the source is present and the target absent, rename; if the
  source is absent and the target present, it is done". The stamp is a pure function of the live
  segments. Nothing counts.
- **More than one journal for a slug** should be impossible under book-op. If it happens, the entry
  point refuses with a fixed 500, and the fsck quarantines the extra journals to `audio/.orphaned/`
  and logs them.
- **Unique names.** The journal id is fresh per operation, so names never collide.
- **Not boot-only.** Recovery runs at every entry point, in the failing job's catch path, and at
  boot.

**Accept** (`acceptTake`). Accept keeps the `live_audio_missing` pre-check: no live take plus a
previous take gives a 409 and touches nothing. Accept **changes no take field** and bumps nothing
(D1). What it does depends on the live `takeId` (F17):

| Live `takeId` is… | Accept does |
|---|---|
| the entry's `takeId` (B) | moves the previous take to `.discard-<jid>.prev.*`, then cleanup; commits `accepted` |
| the entry's `previousTakeId` (A) | **a reject's audio step already ran**. Accept and reject converge: the entry is removed, `rejected` (the truth) is appended, and the answer is 409 `revision_gone` with the state |
| anything else | `revision_gone`, entry kept as today |

**Reject** (`restoreTake`). Journal `op:'restore'`. The phases, with what a replay does at each:

| Phase | Action | Replay before the next phase |
|---|---|---|
| `discard-live` | move live parts to `.discard-<jid>.live.*`, the live audio first | move them back (roll back) |
| `promote` | rename each `.previous.*` part onto its live name (target checked absent) | roll forward: finish the renames |
| `stamp` | `stampStateFromLiveTake`, now from A's own segments | roll forward |
| `cleanup` | unlink the discard set, then the journal | roll forward |

At every point, each take exists whole on disk (H1, H2). R3-5's promotion is the same op with no
`discard-live` phase.

**Retry recognition (H17, H18).** Recorded entries gain `takeId` (B) and `previousTakeId` (A), plus
the existing `renderedAt`. Reject compares the live `takeId`:

| Live `takeId` is… | Reject does |
|---|---|
| B | runs the restore |
| A | the audio step is already done: commits `rejected` |
| anything else | `revision_gone` |

`entryMatchesChapter` matches on `takeId ∈ {B, A}` when the entry carries one, and on
`renderedAt` otherwise. Legacy entries with no stamps are unchanged. **`revision-op` is retired**
(N10).

**Exclude** (`dropAllTakes`, OD6, F16):
- journal `op:'drop'`; it moves the live take, the previous take and every sidecar to the discard
  set;
- in the same `state.json` write that sets `excluded`, it clears `TAKE_STATE_FIELDS`;
- it unlinks the discard set and drops the pending entry;
- **if there is no live take**, the previous take (the only copy) moves to `audio/.orphaned/`
  instead of being deleted.

**Restructure** (`relabelTakes`; N16).
- **A book-level journal**, `audio/.take-journal.relabel.<jid>.json`, holds the **whole** ordered
  rename map, through temporary names (the two-pass rename), plus the drop list and the planned
  new slugs. It is written **before** `state.json`.
- **Replay direction is decided from `state.json`:**
  - if the chapters' slugs are the plan's new slugs, the state write landed, so roll forward
    (finish every rename, then the drops);
  - otherwise roll back (undo the renames that landed) and delete the journal.

  A permutation is safe because the map is replayed whole, never per slug.
- The rename covers every take suffix, with previous for all three extensions. Delete ops go
  through `dropAllTakes`, with the same only-copy rule.
- `buildAudioOps` also tests `chapterAudioExists` and the presence of a previous take (H11
  residual).
- The audio ops stop being best-effort: a failure rolls back from the journal, and the
  restructure fails with the fixed sentence.

**Scoring** (`commitScoring`, F23; R3-3).
- **CAS source.** The scorer reads the `takeId` from the **embeddings file it scores**. That is the
  file read at `aggregate.ts:602`, before segments, so the token comes with the data.
- **Incremental writes are kept (srv-36).** Each per-character `mergeVerdictRows` becomes one
  `commitScoring` call: one short span per character, covering that character's affected chapters.
  Inside it, a chapter's rows are written only if its live `takeId` still equals the id it scored.
  Mismatched chapters are dropped and logged, and they set the re-run flag.
- **The attempted marker** (written at pass start, `:638`, #1436) goes through the same call with
  the same check. It stays existence-only.
- **`triggerScoring`** keeps its single flight per book. A trigger that arrives while a pass is in
  flight sets `scoringRerun`, and the pass's `finally` starts exactly one more pass. That makes
  "picked up by the next pass" true. The resume route uses the same path.
- `generation.ts:295`'s per-chapter `writeAttempted` becomes a single-chapter `commitScoring` call.
- Splice and QA repair call `triggerScoring` after a commit (R3-4).

**Readers.**
- They stay lock-free, through the module's accessors. Each part changes by an atomic rename, so
  cross-file skew is limited to one rename window.
- The job readers that care (splice, QA repair, scoring) are protected by the CAS.
- The portable export lists **live parts from the module** (F15). The module excludes
  `.previous.*`, `.next-*`, `.discard-*`, `.take-journal.*` and `.orphaned/`. Backups skip
  `.orphaned/` too.

**Windows (F9, N4; D4).**

Pass 1 probed NTFS on Windows 11 26300 with ffmpeg 8.1.1 and Node `fs`:

| Holder | rename-away | rename-onto | unlink, then rename |
|---|---|---|---|
| none | OK | OK | OK |
| Node `openSync` (R-a playback, the codec zip) | OK | **EPERM** | OK |
| `ffmpeg -re -i` reader (m4b build, clip) | **EBUSY** | **EPERM** | unlink **EBUSY** |

What the protocol does with each:
- **A Node holder never blocks a commit.** Only rename-onto fails under it, and the protocol never
  renames onto a held name: step 5 moves the live file away first, and step 6 installs onto a free
  name.
- **An ffmpeg holder blocks step 5's first rename.** That is the retry path above. Nothing else has
  moved yet, so the in-span rollback is empty.
- Every rename is `renameWithRetry`, with its full budget (OneDrive's ~3.6 s,
  `atomic-rename.ts:142-164`, #915). Revision 2's 1 s cap is removed (R3-2).
- **Row Q's NTFS cells are recorded** above. The OneDrive-backed cells, and real span timings, are
  still owed on the box (§7).

**Lock order.**
- No new class. The module uses existing edges only: `book-op → book → state-json` (the stamp) and
  `book-op → revisions`.
- `revision-op` is removed, and with it the `revision-op → revisions` edge.
- **New rule:** a long job takes book-op only at its commit site, around `commitTake` (or through
  scoring's `commit` callback), never across preparation.

**Span length and contention (F11; R3-2).**
- **Rename count.** A commit renames up to **21** parts: 7 parts × (discard old previous +
  preserve + install). It also writes the journal and the stamp, and unlinks at cleanup.
  `withBookOp`'s resolve adds `backfillAudioModelKeysFromSegments` (`book-op-lock.ts:262`),
  O(chapters).
- **Typical:** tens of ms plus O(chapters) reads.
- **Deadline.** Every take span carries a **6 s deadline** for its forward work. A step that would
  start past it rolls back, and the commit returns `retry`, so a commit never holds book-op longer
  than about 6 s plus its rollback. Every other book-op waiter has a 10 s acquisition budget
  (`file-lock.ts`, #2260), so **no waiter can time out behind one commit.** That covers:
  - the background autosaves `PUT …/listen-progress` (`book-state.ts:2744-2749`) and listen-stats,
    which do not retry;
  - job registration (`book-jobs.ts:258`, `generation.ts:2495-2531`), which does not retry either.
- **What remains.** Contention with **several** queued commits can still exceed one waiter's
  budget. That waiter answers the existing curated `lock_contention` sentence. A dropped autosave is
  repeated by the next tick. Row Q measures this.
- **Absent parts are skipped**, never retried: the journal lists only the present parts (step 3),
  so `renameWithRetry` never spins on ENOENT.

**Hazards closed:** H1–H4, H6, H7, H8 (except a commit wedged inside the filesystem), H9,
H12–H14, H16 (via OD2), H17, H18, H19 (server entries), H20, H22, F2, N1, N2, N4 (it degrades to a
reported wait or a reported failure, never a mixed take), N6–N9, N11–N16.

**Remaining:**
- reader skew within one rename window;
- legacy client entries (H19);
- a commit wedged mid-rename inside the filesystem. The span deadline cannot interrupt a syscall;
  a server restart replays the journal.

**Blast radius (F24; corrected).** About **60–65 non-test server files**, plus tests:

| Area | Files |
|---|---|
| New | `workspace/chapter-take.ts`, `workspace/chapter-take.guard.test.ts` |
| Folded in / removed | `workspace/preserve-previous-audio.ts`, `audio/previous-audio.ts`, `audio/rewrite-chapter-slugs.ts`, the take-name builder in `workspace/chapter-audio-file.ts` |
| Finalize and callers | `audio/finalize-chapter-write.ts`, `routes/generation.ts` (commit site, signal, `committing`, `stallPhase`, failure-stamp check, `writeAttempted`, OD2 per-chapter abort, `startTakeId`, `scoringRerun` in `triggerScoring`), `routes/chapter-splice.ts`, `routes/chapter-qa-repair.ts` (registration-first base read, Edit 6b staged, scoring trigger) |
| Revisions | `routes/revision-ops.ts`, `routes/chapter-audio.ts`, `workspace/revisions-store.ts` (`takeId`/`previousTakeId`, `entryMatchesChapter`, retire `revisionOpLockKey`) |
| Restructure | `routes/chapters-restructure.ts` (relabel journal, ordering), `workspace/restructure.ts` (`buildAudioOps`; carry list from `TAKE_STATE_FIELDS`) |
| Book state, exclude, fsck, scan | `routes/book-state.ts` (exclude, `completedSlugs`, `chapterLufs`), `workspace/fsck-orphan-audio.ts`, `workspace/scan.ts` (types, `deriveSegmentsHeal` via `deriveTakeFields`) |
| Whole-book writers (D3) | `import/scan-import-folder.ts`, `routes/backup.ts`, `workspace/auto-backup.ts`, `workspace/chapter-uuid.ts` |
| Scoring | `audio/render-integrity/aggregate.ts`, `audio/render-integrity/verdicts-io.ts`, `routes/qa-report.ts` (resume) |
| Export | `routes/export.ts` (OD7 reject refusal), `export/build-portable-book.ts` (F15), and the `export/build-*.ts` builders (accessors) |
| Readers to accessors (Phase 1) | the rest of the ~47 files that read a take name, including `audio/segments-io.ts:218`, `routes/revisions.ts:151`, `export/build-captions.ts:135`, `export/build-mp3-folder.ts:62`, `library-sync-manifest.ts:104`, the sync manifest, `audio/qa-report.ts`, `store/cast-audio-currency.ts`, `routes/clip.ts` |
| Types and contract | `audio/segments-io.ts` (types), `openapi.yaml` + `src/lib/api-types.ts`, `src/lib/api.ts` (A-side URL, mocks) |
| Lock-order docs | `workspace/cast-lock.ts:40` and `workspace/book-op-lock.ts:17-18` comments, CLAUDE.md (lock order, the fail-loud stamp site) |
| Tests that cite `revision-op` | `book-op.single-book-routes.test.ts:468`, `revision-ops.test.ts:542,574-578`, `chapter-audio.test.ts:603` |

**Tests (F22).**
- **Fault injection over the module**, parameterised over **every take part, the previous take's
  parts included**, and over every phase of the commit, restore, accept, drop and relabel
  journals. Each injected failure leaves each take whole on disk, and replay converges. Running the
  replay twice equals running it once.
- **Race tests:**
  - **positive control (D1): a splice prepared after Accept commits;**
  - **ABA (D1):** render B → reject (A live) → a splice prepared against A commits onto A; a splice
    prepared against B is refused;
  - reject during a commit;
  - two renders of one chapter (`::*` and `::X`): the original previous take survives (R3-1);
  - splice CAS mismatch;
  - commit after abort;
  - watchdog during a commit, and between retry spans;
  - the failure stamp after a commit, with the stamp itself failing (D2: rethrows, no `failed`
    stamp, journal replay fixes state);
  - scoring CAS against a splice landing mid-pass (the carry-forward keeps scoring's rows);
  - a dropped scoring trigger re-runs (R3-3).
- **Windows-shaped tests:** an injected EBUSY/EPERM at step 5 keeps the staged set and retries; an
  exhausted wait reports the sentence and sweeps; a Node-held live file commits.
- **Sweep:** an orphan `.next-*` is swept; one in `liveStaging` is not; a journal-less discard is
  quarantined; `completedSlugs` ignores `.next-*`.
- **Lazy minting:** an id-less book imported after boot gets ids at its first splice.
- **Whole-book writers:** a bundle overwrite leaves no mixed take; a backup restore re-derives the
  take fields; the PUT drops a client `audioTakeId`.
- **The span deadline** under a slow injected rename.
- **Format coverage:** m4a and ogg books through commit → reject → accept → relabel → drop → fsck.
- **Migration** fixtures for every §6.1 rule.
- **The guard test**, with a mutation check per rule (a deliberately planted variable-suffix write
  must fail rule 3).
- **e2e:** the A/B player on an m4a book in mock mode.

### Option B: per-chapter manifest and generation counter

**Mechanism.**
- `audio/<slug>.take.json` = `{gen, live, previous}`, where `gen` is **monotonic**. Parts are named
  by generation (`<slug>.g<gen>.<suffix>`).
- A commit writes the new generation's parts, then makes **one atomic manifest write** under a
  short book-op span. Reject swaps `live` and `previous` with no file moves at all.
- The manifest is the truth **at every moment**, so recovery is "ignore unreferenced generations".
  It needs no journal and runs on any touch, not only at boot.

**Reader changes.** Every reader resolves through the manifest: the same ~47 files as A's Phase 1.

**Migration.** Synthesise a manifest from the flat files. The portable bundle and import flatten or
learn the layout. The whole-book writers (W13–W15) need the same treatment as in A.

**Closes** all of A plus reader skew. **About 70–75 files** (corrected: the reader count was
undercounted for every option).

### Option C: versioned take directories

**Mechanism.** `audio/<slug>/takes/<takeId>/…` with `live`/`previous` pointers. Pointer flips are
atomic, and restructure renames one directory per chapter.

**Migration.** A one-time move of every book's flat files, with its own recovery path. The portable
format changes.

**Closes** the same as B. **About 75–80 files**; highest risk.

### D. What A borrows from B, and what it no longer needs

Revision 2 borrowed two things from B:
1. **A monotonic generation**, to make the CAS immune to ABA. **Dropped (D1).** A per-commit random
   `takeId` makes ABA benign, because a take that comes back brings back its own content (§4.1).
   Keeping a counter coherent across `segments.json`, `state.json`, backups and the state PUT was
   the Critical finding.
2. **Recovery at any moment**, not only at boot. **Kept:** `reconcileSlug`/`reconcileBook` at every
   entry point, plus lazy minting (D3).

What A still lacks is B's reader atomicity across files. Nothing observed needs it: job readers are
covered by the CAS, and UI readers refetch after every op. Because the module owns every path, B's
manifest could later replace the journal inside the module without touching any caller.

### Comparison

| | A | B | C |
|---|---|---|---|
| New lock class | none (retires `revision-op`) | none | none |
| Writer fence | book-op span + CAS (`takeId`) + signal | same, with `gen` | same |
| Reader consistency | per file | per take | per take |
| Recovery | journals, replayed at every entry point | the manifest is the truth | the pointer is the truth |
| Layout change | names only | generation-suffixed files | directories |
| Portable format | unchanged | changes or flattens | changes |
| Files touched | ~60–65 | ~70–75 | ~75–80 |

## 6. Recommendation and migration

**Option A**, as revised:

1. **The fence already exists.** Book-op serialises every quick operation. A adds short commit
   spans for the long-job writers that remain, routes the whole-book writers through the module,
   and adds a guard that sees every take write.
2. **It answers every reason the #3400 attempts failed:**
   - the exclusion is lexically scoped, so it cannot leak;
   - identity is a filename-safe random id read from the take itself, never inferred from absence
     or from a timestamp, and it moves with the take;
   - sidecars are staged, never captured from the wrong take.
3. **It keeps the layout and the portable format.** The flat files, the bundle and the export
   builders stay as they are. All three options touch the same ~47 readers, so file count is no
   longer a reason to prefer A; layout stability is.

**Book-op versus a per-chapter key (F12).** A per-chapter key is **not** a drop-in fallback.
- Restructure, exclude-prune, reparse and the fsck touch many chapters per operation, so each would
  have to take every affected chapter's key. That means a multi-key acquisition, ordered and
  bounded, with no existing `withKeyLocks` precedent for chapter keys.
- The key would also sit at a new place in the order (`book-op → take → book`).
- The guard would have to follow it.

Revisit only if row Q measures real contention despite the span deadline.

### 6.1 Migration (F2, F6; OD8; D3)

Migration is **not a boot-only pass**. It is what `reconcileSlug` and `ensureTakeIdentity` do the
first time they meet a legacy slug, at any entry point, under the caller's book-op. The boot fsck
is one caller among many. Every step is idempotent and **checks before it renames**: no rename may
replace an existing file. A target that already exists means the source is quarantined to
`audio/.orphaned/<iso-date>-<jid>/<name>` instead.

1. **Inventory first.** List every live audio file of each extension and every
   `.previous.{mp3,m4a,ogg}`. Sniff each one by magic bytes: an `ID3` tag or an MPEG sync word
   means mp3; `ftyp` at offset 4 means m4a; `OggS` means ogg. **Nothing is renamed yet.**
2. **Two or more live files.**
   - **Choosing the live one.** A file "matches" when its duration is within ±0.5 s of the live
     `segments.json`'s `durationSec`. The duration is measured by a **full decode**
     (`ffmpeg -i <f> -f null -`), not by ffprobe's header estimate, which is unreliable on legacy
     MP3s with no Xing header (`tts/mp3.ts:144-182`). This shape is rare, so the decode cost is
     paid rarely. Exactly one match: that file stays live.
   - **The others.** If no previous take exists, one non-match becomes the previous take (with its
     real extension, the target checked absent). The rest are quarantined.
   - **Zero or several matches.** Every candidate except the newest by mtime is quarantined, and the
     case is logged.
3. **Wrong-name files.** Rename a live or previous file whose bytes disagree with its extension to
   the right extension, but only if that target is absent; otherwise quarantine it. This repairs
   earlier rejects on m4a/ogg books that wrote AAC or Opus bytes behind `.mp3`.
4. **Identity.** `ensureTakeIdentity` (§4.1).
5. **Re-stamp (F2).**
   - **The legacy-reject shape** is `state.json`'s `audioRenderedAt` ≠ the live segments'
     `synthesizedAt`. There, run `stampStateFromLiveTake` over every field.
     - A pending entry whose `renderedAt` named the rejected take then stops matching
       (`revision_not_found`). That is correct, because the reject already happened.
   - **Otherwise,** fill only the absent fields, through `deriveTakeFields`, as the heal does.
     Existing values are not rewritten, so the re-stamp is a no-op on a healthy chapter (including
     one whose `audioModelKey` came from the old raw-key heal).
6. **The no-live-take shape (F16, §4.2; R3-5).**
   - Orphan live segments and sidecars are quarantined first.
   - If the chapter is not excluded and no journal exists for the slug, the previous take is
     promoted by a journalled `restoreTake` with no `discard-live` phase.
   - If the chapter is excluded, its previous take is quarantined, as `dropAllTakes` would do.
   - This replaces fsck case 1's unjournalled renames. It no longer depends on a UI path that does
     not exist.

**`.orphaned/` (OD8; R3-6).**
- It is **never** auto-deleted.
- Quarantine happens only in the shapes enumerated above.
- Each event gets its own `<iso-date>-<jid>/` subfolder, so names never collide.
- The fsck logs a per-book line on every boot: the file count and total bytes.
- Export and backup skip it.

## 7. Phased rollout (each phase splits into roughly one-commit children)

**Done outside this design:** #4166 (N3, `completedSlugs`) and #4167 (N5, the leaked tmp audio) are
filed and queued. Whichever lands first, `completedSlugs` ends on the module's live-name predicate
(Phase 1 step 2 re-routes #4166's fix if it landed first).

**Phase 1: identity, naming, liveness and lazy migration.** No behaviour change for a clean mp3
book.
1. `chapter-take.ts` skeleton:
   - suffix table and accessors;
   - the live-take predicate (§4.2) and `TAKE_STATE_FIELDS`;
   - the `takeId` type (segments, embeddings, verdicts, `state.json`, `scan.ts` types);
   - the sniffer, `deriveTakeFields` and `stampStateFromLiveTake` (with `effectiveAudioModelKey`);
   - `ensureTakeIdentity`.

   Unit tests.
2. Readers move to the module's accessors (the ~47 files, R-k folded in). The portable export uses
   the module's live-part list (F15). `completedSlugs` uses the exact live-name predicate.
   `deriveSegmentsHeal` uses `deriveTakeFields`.
3. Preserve, restore and the fsck use real extensions. `revisions-store`'s existence check goes
   through the module.
4. A-side routes for every extension, with the right mime type; the meta URL uses `urlSuffix`.
   OpenAPI, types, client and mocks.
5. Lazy migration (§6.1) at the module's entry points and the fsck. Fixture tests for every rule.
6. `TAKE_STATE_FIELDS` wired into `chapter-uuid.ts` (W15) and restructure's carry list.
7. The guard test (rules 1–3), with its read-only allowlist emptied as the steps above land.
8. e2e: m4a A/B.

**Phase 2: commit protocol.** PR at `high` review depth. Row Q's OneDrive cells must be recorded
first.
1. `prepareTake`: staging every part with the non-creating writer, the signal checks and
   `liveStaging`; QA repair's Edit 6b embeddings and verdicts as staged inputs.
2. `commitTake`: the journal, role-tagged discards (no unlink before cleanup), the only-copy rule,
   R3-1, the commit-time OD4 carry-forward, the live-audio-first ordering and the span deadline;
   `reconcileSlug`, `reconcileBook` and the sweep.
3. Generation:
   - the commit site, signal, `committing` and `stallPhase = 'commit'`;
   - the bounded between-span retry with the `entered` flag;
   - `takeCommitted` in the failure-stamp path, and R3-7's terminal frame;
   - `afterChapterFinalized` after the span;
   - OD2's per-chapter splice abort, and `startTakeId`.
4. Splice and QA repair: registration-first base read, base tokens, the CAS-mismatch sentence, N6
   driven by the commit result, and the post-commit scoring trigger (R3-4).
5. The bundle overwrite through `replaceTakesFromBundle` (R3-8); backup restore through
   `reconcileBookTakes` (R3-9).
6. Lock-order comments, and the CLAUDE.md order sentence and fail-loud site sentence.

**Phase 3: fidelity, retry recognition, scoring.**
1. `restoreTake` with its journal phases, and R3-5's promotion; `acceptTake` with the live-token
   table; entries gain `takeId`/`previousTakeId`; `entryMatchesChapter` widens.
2. Retire `revision-op`: `revisionOpLockKey`, the two holders, the comments in `cast-lock.ts:40`
   and `book-op-lock.ts:17-18`, and the tests that cite it (`book-op.single-book-routes.test.ts:468`,
   `revision-ops.test.ts:542,574-578`, `chapter-audio.test.ts:603`), each replaced by an assertion
   on book-op.
3. `commitScoring`: one span per character write, with a per-chapter CAS on the embeddings
   `takeId`; the `commit` callback from `triggerScoring` and the resume route; `scoringRerun`.
   `generation.ts:295` goes through it.

**Phase 4: remaining fences.**
1. `dropAllTakes` for exclude (OD6, the take-field clear) and for restructure delete ops;
   `relabelTakes` with the book-level journal; `buildAudioOps` checks presence.
2. Reject and `restore-unrecorded` refuse `book_busy` during an export (OD7).
3. On-box register rows on all three surfaces:
   - **Row Q, the Windows matrix.** The NTFS cells are recorded from pass 1's probe (§5.A
     Windows). Still owed:
     - the same three columns on a **OneDrive-mounted** workspace, with each holder (ffmpeg export
       read, ffmpeg clip cut, Node read stream, none);
     - real commit-span timings against the 6 s deadline;
     - waiter outcomes (autosave, job registration) while an export holds a live file.
   - **An m4a book on real hardware:** render → splice → reject → accept, with the files listed
     before and after.

Each PR carries:
- release notes, technical and user-facing. Phase 1's line: "Reject restores the original take
  correctly on M4A and Opus books";
- the regression plan `docs/features/<n>-chapter-take-lifecycle.md`;
- an `INDEX.md` row.

## 8. Questions

### 8.1 Owed questions from both passes, answered

| Question | Answer |
|---|---|
| Where does the canonical `takeSeq` live, and what exact equality does the commit test? Should Accept bump it? (A1, 1-1) | Nowhere: it is dropped (D1). The commit tests `live segments.takeId === base`. Accept bumps nothing. |
| A failed stamp after `installed`: swallow or rethrow? Which source decides "committed"? (A2) | Rethrow (D2). The journal at `installed` or later, or the live segments' `takeId`, decides; never `state.json` (`takeCommitted`). |
| Must the module own every whole-book and whole-state writer, and every book of any age, with minting and liveness enforced at its own entry points? (A3, 1-3) | Yes (D3): W13–W15 go through module entry points; `ensureTakeIdentity` and the §4.2 predicate run at every entry point. The guard's rule 3 sees zip-relative and variable-suffix writers under `audio/`. |
| EBUSY/EPERM under an ffmpeg reader: keep the staged take and retry, bounded and watchdog-visible? What deletes `.next-*`/`.discard-*` on every non-commit exit? (1-2) | Yes (D4): a between-span retry under `stallPhase = 'commit'`, bounded by the no-progress watchdog. The sweep is in every non-commit exit, `reconcileSlug` and the fsck. |

### 8.2 Answered from code (pass 1)

- **Attempted-marker writers** are `generation.ts:295` and `aggregate.ts:638`. The marker is
  existence-only, so a staged or carried marker reads the same as a scored one.
- **Partial carry-forward:** verdict keys survive it. Carried rows for untouched segments keep their
  frozen `resolvedCharacterId` stamps (#3362).
- **ffprobe tolerance:** the header estimate usually falls through to mtime, so it is replaced by a
  full decode (§6.1 step 2).

### 8.3 Still open (on-box)

- **Row Q, OneDrive cells and timings** (§7 Phase 4). If OneDrive also blocks a rename-away under a
  Node holder, a commit would also wait during playback. The retry path covers it, but OD7 would
  then need revisiting.
