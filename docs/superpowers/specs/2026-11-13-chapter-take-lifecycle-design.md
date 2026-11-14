---
status: draft
revision: 2 (manual adversarial check folded, 2026-11-13: F1-F24, V2-V4, D; the real assumption-checker pass is still owed, on the owner's box)
issue: 3456
refs: [3400, 3397, 3457, 3704, 3711, 3717, 3774, 4166, 4167]
verified-at: 3792b84b
decisions: accepted by the owner 2026-11-14 (OD1 Option A, OD2 render wins, OD3 roll forward, OD4 carry forward, OD5-OD8 as recommended)
---

# Chapter take lifecycle: who owns a chapter's live and `.previous` audio (#3456)

## Owner decisions

> **Accepted 2026-11-14:** the owner chose Option A (OD1) and accepted every other recommendation in this section as written. The `assumption-checker` gate is still owed before any implementation chain is filed. The on-box Windows rename matrix (row Q) must also run before Phase 2: it decides whether N4 is real and whether OD7 must also fence render commits.

**OD1 — Which component owns a chapter's take files, and how is everything else fenced?**
Three options are costed in §5. **Recommended: Option A.**
- One module, `workspace/chapter-take.ts`, is the only code that writes, renames or deletes a take
  part.
- Every mutation runs inside a short `withBookOp` span.
- Long jobs prepare their new take outside the lock and **commit** it inside one span.
- The commit is guarded by a compare-and-swap (CAS) on a filename-safe take id plus a monotonic
  per-chapter sequence number, and by the job's abort signal. The sequence number is borrowed from
  Option B.

No finding in the manual check breaks Option A. F5, F7 and F3 needed decisions rather than fixes,
and they are OD2–OD4.

**OD2 (F5) — A multi-chapter render running alongside a splice of one of its chapters.**
- **Recommended:** a multi-chapter (`*`) render aborts any in-flight splice or QA repair of a
  chapter **when it starts that chapter** (`abortInFlightSplice(bookId, chapter.id)` per chapter,
  not once per job). Full renders carry **no** base token.
- **Why no token:** a full render replaces every part and depends on nothing in the live take, so
  "the live take changed since I started" has no meaning for it. Its commit is last-writer-wins,
  and whatever was live becomes the previous take.
- A splice that starts *after* the render reached its chapter still aborts the whole `*` job
  (`abortInFlightChapterJob`, `generation.ts:521-524`). That is today's behaviour, unchanged.
- **Alternative:** give renders a base token. A mismatch could then only mean "discard a full
  render because someone spliced the take it is about to replace". That throws away minutes of
  synthesis to protect a take the user asked to replace, so it is not recommended.

**OD3 (F7) — What happens when a commit has installed the new take, and a later step fails?**
- **Recommended: roll forward.** Once the install phase has finished, the new take **is** the
  chapter.
  - If the `state.json` stamp fails, it is retried by the journal replay, through
    `stampStateFromLiveTake` (§4.3), the same function that migration uses.
  - If recording the review fails, that step stays best-effort, as plan 285 already decided. It
    surfaces as `reviewOutcome: 'failed'`, and `restore-unrecorded` stays the way back.
- **Alternative: roll back.** Move the new take back to `.next-*`, restore the previous take's
  parts **and** its five state fields from `.previous.take.json`, and fail the job. Rolling back
  after a successful install throws away a finished render because of a JSON write. It also needs a
  second rollback path for a failure *during* the rollback.

**OD4 (F3) — Scoring verdicts and embeddings after a partial re-record (splice, QA repair).**
- **Recommended: carry them forward in the staged take.** For each segment the write did **not**
  re-synthesise, its rows are copied from the base take (which the CAS guarantees is the take the
  job read). Rows for re-synthesised segments are dropped, then replaced by fresh rows where the job
  has them: `reembeddedRows`, and QA repair's accepted acoustic verdicts (today's Edit 6b).
- This keeps:
  - `deriveBookOutline` (`verdicts-io.ts:105`), which reads the verdict files;
  - the `qa.speaker.autoRepair` loop;
  - Edit 6b's post-repair verdicts.

  All three behave as they do on `main`.
- A full render starts with no verdicts. Scoring is triggered as today, by
  `afterChapterFinalized`.
- **Alternative:** trigger scoring after every splice and QA repair. That costs a speaker-embed
  pass per Fix-audio, and the chapter reads "unscored" until it finishes.

Smaller decisions, with recommendations:

| | Decision | Recommendation |
|---|---|---|
| OD5 | Which files and fields belong to a take | §4: seven sibling files, plus the take fields in `state.json` |
| OD6 | What excluding a chapter does to its takes | Drop the previous take, every live sibling, and the pending entry. When the previous take is the **only** copy (no live take), quarantine it instead of deleting it (F16). |
| OD7 (F20) | How export is fenced | **Reject** (and `restore-unrecorded`) refuse `book_busy` while an export runs. **Accept is not refused.** Accept discards only the previous take, which no export reads (the portable bundle skips `.previous.`, `build-portable-book.ts:149`). A render's commit during an export proceeds (§5.A, Windows). |
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
  - the fsck's per-book step.

  Long jobs (render, scoring, export, …) register through `runBookJob` instead. **So the quick
  operations are already mutually exclusive per book.**
- **#3774.** Restructure and exclude are refused while any long job is registered.
- **#3717.** Reparse and replace are refused the same way.
- **#3704 / #3400.** `rewriteChapterSlugs` moves and deletes `.previous.*` with the live take.
- **#3457.** The fsck no longer promotes `.previous.mp3` over a live `.m4a`/`.ogg`.
- **#3700 / #3625.** Every `state.json` read-modify-write named in the issue now runs under the
  `state-json` leaf lock.

The remaining question is therefore narrower. **The things left to fence are:**
1. the long-job **commit** of a take (finalize, called from generation, splice and QA repair);
2. **QA repair's post-finalize writes**;
3. **scoring's** verdict and attempted-marker writes;
4. the **lock-free readers**.

The take files also need **one naming scheme**, a **defined fidelity**, and a **recovery rule that
does not guess**.

## 2. Inventory at `3792b84b`

### 2.1 The files

| File | Written by | Moved by preserve? | Restructure |
|---|---|---|---|
| `<slug>.{mp3,m4a,ogg}` (live) | finalize `:753` | yes, always **to `.previous.mp3`** (`preserve-previous-audio.ts:38`) | moved/deleted |
| `<slug>.segments.json` | finalize `:752`; restructure metadata rewrite | yes | moved/deleted |
| `<slug>.peaks.json` | finalize `:755` | **no** | moved/deleted |
| `<slug>.lufs.json` | finalize `:274` (**before** preserve) | **no** | moved/deleted |
| `<slug>.embeddings.json` | finalize `:675`/`:744` (**before** preserve); QA repair Edit 6b (`chapter-qa-repair.ts:864`) | **no** | moved/deleted |
| `<slug>.render-integrity.json` | scoring (`aggregate.ts:1022`); QA repair Edit 6b `writeVerdicts` (`chapter-qa-repair.ts:~870-899`) | **no** | moved/deleted |
| `<slug>.render-integrity-attempted.json` | `writeAttempted` in generation (`generation.ts:295`) and scoring (`aggregate.ts:638`) | **no** | moved/deleted |
| `<slug>.previous.mp3`, `.previous.segments.json` | preserve | — | moved/deleted |
| `<slug>.previous.peaks.json` / `.previous.lufs.json` | **nothing** (always absent) | — | listed, never present |
| `<slug>.<ext>.tmp-<pid>-<ts>` | finalize `:221-222` | — | **leaked on a throw** (#4167) |
| `state.json` chapter: `duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa` | finalize `:766-792` | **no** | carried when the content is unchanged (`restructure.ts:410-420`) |

Scoring does **not** write embeddings (V3). Embeddings are written only by finalize and QA repair.

### 2.2 Writers

| # | Writer | Where | Locks today | Races |
|---|---|---|---|---|
| W1 | **Finalize** | `audio/finalize-chapter-write.ts:188-807` | None for the files. `state-json` for the stamp (`:766`). `revisions` in `applyReview` (`:798`). Its caller is a `render` job (no book-op). | Lufs and embeddings are written before preserve (H4). If `:753` fails, the **new** segments (`:752`) sit next to the old audio or none (H6). It interleaves with reject (H9), with a second finalize (N9), and with the fsck (N8). |
| W2 | **Generation** | `routes/generation.ts:858` (`runBookJob`); calls W1 at `:1996` | No book-op; abort-based displacement | Finalize gets no signal. Bails at `:1957` (before assembly) and `:2044` (after finalize) only (H8). A `*` job's `abortInFlightSplice(bookId, null)` (`:1383`) is a no-op (`chapter-job-coordination.ts:54`), so a splice of one of its chapters keeps running (H16 → OD2). |
| W3 | **Splice** | `routes/chapter-splice.ts:174`; calls W1 at `:555` | No book-op; `registerSplice` at `:336` | Reads segments (`:185`) before it registers; the last abort check is `:526` (H7). |
| W4 | **QA repair** | `routes/chapter-qa-repair.ts:143`; calls W1 at `:804` | No book-op; registers at `:333` | Reads **and decodes** the audio (`:150-163`) before it registers (H7). **Edit 6b** writes embeddings (`:864`) and verdicts (`:~870-899`) **after** finalize returns, outside any fence (F4). |
| W5 | **Accept** | `routes/revision-ops.ts:65-121` → `acceptPreviousAudio` (`previous-audio.ts:27-34`) | `book-op` → `revision-op` → `revisions` | No busy check. `.previous.mp3` only (`previous-audio.ts:19-23`). |
| W6 | **Reject** | `revision-ops.ts:123-182` → `restorePreviousAudio` (`previous-audio.ts:39-61`) | as W5 | Unlinks the live take first (`:45-48`) (H1). Restores to `<slug>.mp3`, because `findPreviousChapterAudio` hard-codes `ext: 'mp3'` (`:22`, used at `:51`) (H13). Swallows a failed segments rename (`:58`) (H2). Busy check is generation only (`generation.ts:661`) (H9). Restores audio and segments only, and **leaves `state.audioRenderedAt` naming the rejected take** (H3, F2). |
| W7 | **restore-unrecorded** | `routes/chapter-audio.ts:404-452` | `isGenerationActive`, then `book-op`; `revision-op` around the restore only | `has_revision` (`:420`) versus finalize's lock-free `recordPending` (H20). |
| W8 | **Restructure** | `chapters-restructure.ts:291-334` → `rewriteChapterSlugs` (deletes at `rewrite-chapter-slugs.ts:128-146`; renames `:155-238`) | `book-op` → gate → `book`; refused while jobs run | Fixed for the issue's cases (H10, H11). `buildAudioOps` skips a chapter with no `audioRenderedAt` (`restructure.ts:442`). |
| W9 | **Exclude** | `book-state.ts:2320-2440`; deletes at `:2409-2421` | `book-op` → `book` → `state-json`; refused while jobs run | Leaves `.previous.*` and every sidecar (H22). Leaves the entry (N2). The fsck later promotes the previous take (N1). |
| W10 | **Boot fsck** | `workspace/fsck-orphan-audio.ts:57-132`; per-book step under book-op (`:165`); fire-and-forget at `index.ts:549` | `book-op` per book | `PREV_MP3_RE` (`:39`). Case 1 (`:85-108`) promotes `.previous.mp3` to `<slug>.mp3` (`:86,91`) **and `.previous.segments.json` over `<slug>.segments.json`** (`:93-96`) when no live audio exists (`:89`) (N1, N8, H18). |
| W11 | **Scoring** | `aggregate.ts:1022` (verdicts), `:638` (attempted); a `scoring` job | none | Files verdicts under whichever take is live when it writes (N7). |
| W12 | **Reparse / replace** | `book-state.ts:2131,2213` | `book-op`; refused while jobs run | Wipes `audio/` wholesale (fixed: H16, first half). |

### 2.3 Readers

| # | Reader | Where | Hazard |
|---|---|---|---|
| R-a | GET live audio meta/file | `chapter-audio.ts:236-276,316-366`, no lock | 404 inside reject's unlink-then-rename window; transient audio/segments skew |
| R-b | GET previous meta/file | `chapter-audio.ts:284-312,367-370` | Served as `audio/mpeg` at `audio/previous.mp3` whatever the bytes (H14) |
| R-c | Revisions read view | `revisions-store.ts:121-145` via `hasPreviousAudio` (`preserve-previous-audio.ts:75-77`) | `.previous.mp3` only; must move with the naming |
| R-d | `completedSlugs` | `book-state.ts:782-791` | N3; filed as **#4166** |
| R-e | `chapterLufs` | `book-state.ts:807-820` | Rejected take's loudness after a reject (H3) |
| R-f | Export builders | `routes/export.ts:522` (`export` job); `findChapterAudio` | Takes can be mixed mid-export. **ffmpeg holders:** the m4b and codec-zip builders (`export/build-m4b.ts`, `build-codec-zip.ts`). |
| R-g | Companion sync manifest | `library-sync-manifest.ts:85-112` | Stale `fileSize`/`urlSuffix`; heals on the next sync |
| R-h | Clip | `routes/clip.ts:73`; **ffmpeg** `-c copy` holder | R-a window; a Windows rename-over may fail (N4) |
| R-i | Portable export | `build-portable-book.ts:141-157` | Its filter (`startsWith(slug.)` + an audio extension) would ship staged `.next-*`/`.discard-*` files (F15) |
| R-j | QA report, cast-audio-currency | `audio/qa-report.ts`, `store/cast-audio-currency.ts` | After a reject, `state` describes the rejected take (H3/F2) |

## 3. Hazards, verified at `3792b84b`

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
| H11 | Split/merge keep `.previous` | **F**; residual at `restructure.ts:442` | `rewrite-chapter-slugs.ts:128-146` |
| H12 | `.previous` is always `.mp3` | P | `preserve-previous-audio.ts:38`; `revisions-store.ts:38,143` |
| H13 | Restore and fsck promote to `<slug>.mp3` | P | `previous-audio.ts:22,51`; `fsck-orphan-audio.ts:86,91` |
| H14 | The A-side routes are mp3-only | P | `chapter-audio.ts:304,367-370` |
| H15 | The fsck promotes over a live m4a/ogg | **F** (#3457) | `fsck-orphan-audio.ts:89` |
| H16 | Reparse races jobs; `abortInFlightSplice(null)` is a no-op | **F** for reparse (#3717); the no-op is P (→ OD2) | `generation.ts:1383` |
| H17 | Reject's audio succeeds, its JSON fails, the retry gets `no_previous_audio`, and "Keep new take" records `accepted` | P | `revision-ops.ts:149-173` |
| H18 | The fsck promotes before the user retries Reject | P | `fsck-orphan-audio.ts:85-108` |
| H19 | A failed `recordPending` leaves a stale entry | **Pt** (`entryMatchesChapter`, `revisions-store.ts:199-203`; legacy entries uncovered) | — |
| H20 | `restore-unrecorded` check-then-act | **Pt** | `chapter-audio.ts:417-431` |
| H22 | Exclude leaves the previous take and sidecars | P | `book-state.ts:2409-2421` |
| N1 | **The fsck resurrects an excluded chapter's audio** | N | Exclude leaves `.previous.mp3`; fsck case 1 never reads `state.json` |
| N2 | A pending entry survives exclude; Reject restores audio onto an excluded chapter | N | — |
| N3 | `completedSlugs` misses `.ogg` and counts a lone `.previous.mp3` | N; **filed and queued as #4166** | `book-state.ts:785-788` |
| N4 | **Windows, unverified.** A rename over (or a preserve rename of) a live file held open by **ffmpeg** (the export m4b/codec-zip builders, the clip cut at `clip.ts:73`) may fail. Preserve swallows its failure. Finalize then writes the new segments and renames tmp onto the live name: old audio + new segments, or **two live files** on a format switch, with the mp3-first probe serving the stale one. | N, on-box owed (§7, row Q) | `preserve-previous-audio.ts:42-51`; finalize `:752-753` |
| N5 | Finalize tmp leaked on a throw | N; **filed and queued as #4167** | `:221-222` |
| N6 | `splice_complete`/QA-repair completion always send `hasPreviousAudio: true` | N (minor) | `chapter-splice.ts:596`, `chapter-qa-repair.ts:915` |
| N7 | Scoring files verdicts and attempted markers under whichever take is live; QA repair's Edit 6b writes embeddings and verdicts after finalize, unfenced | N | `aggregate.ts:638,1022`; `chapter-qa-repair.ts:864,~870-899` |
| N8 | The fsck runs alongside requests. Between finalize's segments write (`:752`) and its audio install (`:753`), live audio is absent, so case 1 promotes `.previous.mp3` **and renames `.previous.segments.json` over the new segments**. The install then leaves new audio with **old** segments; with a format change, two live files. | N (narrow, worse than revision 1 said) | `fsck-orphan-audio.ts:89-96` |
| N9 | Two finalizes of one chapter interleave; the original A side is lost | N | via H16 |
| N10 | `revision-op` is redundant: every holder takes book-op first | N (observation) | `revision-ops.ts:73,127`; `chapter-audio.ts:417` |
| F2 | **Legacy rejects left `state.audioRenderedAt` (and `duration`/`audioModelKey`/`audioEngines`/`audioQa`) naming the rejected take while the live segments are the restored one.** `deriveSegmentsHeal` fills only *absent* fields (`scan.ts:1254-1262`), so this never heals. | N, data on disk today | `previous-audio.ts:39-61`; `revision-ops.ts:149-173` |

## 4. The take: identity, fidelity, metadata

### 4.1 Identity (F1, F13, F14)

Every take has two identifiers:

- **`takeId`**: 16 lowercase base32 characters from `crypto.randomBytes`, so it is filename-safe on
  NTFS. It is minted at every commit, and by migration for any take that lacks one. It is stored in
  the take's `segments.json` (`takeId`) and in `state.json`'s `audioTakeId`.
- **`takeSeq`**: a per-chapter **monotonic** counter, `state.json`'s `audioTakeSeq`. It is
  incremented under book-op by every take mutation: commit, restore, accept, exclude and migration
  re-stamp. It is also copied into the take's `segments.json`, so a take records the sequence
  number at which it became live.

The CAS compares the pair (`takeId`, `audioTakeSeq`). Because `takeSeq` only ever increases, an
A→B→A sequence (a reject, then anything else) can never compare equal (F14). Two commits within one
millisecond get distinct random ids and distinct sequence numbers (F13).

Restructure carries `audioTakeId` and `audioTakeSeq` across a rename with the other take fields
(`restructure.ts:410-420`). Staging, discard and journal **file names use `takeId` or a fresh
journal id, never a timestamp.**

**Where `baseToken` is read (F2).** A partial job (splice, QA repair) reads `takeId` and `takeSeq`
from the **same `segments.json` it splices** (splice `:185`, QA repair `:153`).
- At commit, under book-op, the module reads them again from the live `segments.json` **and**
  compares them with `state.json`'s `audioTakeId`/`audioTakeSeq`.
- If all four agree, the commit proceeds.
- Anything else is a mismatch: the staged files are discarded, and the SSE event says "the chapter
  changed while this ran; retry".
- If segments and `state.json` disagree with each other, `stampStateFromLiveTake` is run first.
  Live segments are the truth.
- A base that lacks `takeId` (a pre-migration take) is a mismatch. Migration (§6.1) stamps every
  take at boot, so this only happens when a job raced migration.

### 4.2 Fidelity (OD5)

A take is preserved, restored, accepted, relabelled and deleted as one unit:

| Part | Member? |
|---|---|
| audio `<slug>.<ext>` | yes |
| `segments.json` (now carrying `takeId`/`takeSeq`) | yes |
| `peaks.json`, `lufs.json`, `embeddings.json` | yes |
| `render-integrity.json`, `render-integrity-attempted.json` | yes (OD4 for partial writes) |
| `state.json` `duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa`, `audioTakeId` | yes: derived from the take's `segments.json` (§4.3); a previous take also stores them in `<slug>.previous.take.json` |
| `generationState*`, `excluded`, `title`, `slug`, `uuid` | no |

### 4.3 `stampStateFromLiveTake` (F2, F21)

`stampStateFromLiveTake` is one function, inside `book` → `state-json`. It sets the chapter's take
fields from the live `segments.json`:

| `state.json` field | Derived from |
|---|---|
| `duration` | `formatDuration(durationSec)` |
| `audioModelKey` | `effectiveAudioModelKey(engineBreakdownFromSnapshots(characterSnapshots), modelKey)`, exactly as finalize does (`:652-653`), **never the raw `modelKey`** |
| `audioEngines` | the same breakdown |
| `audioRenderedAt` | `synthesizedAt` |
| `audioQa` | `qa` |
| `audioTakeId` | `takeId` |

A field the segments file lacks is left as it is.

The function is used by:
- the commit;
- restore;
- journal replay;
- migration's re-stamp;
- CAS repair.

## 5. Options

### Option A: one take module, commits inside a book-op span (recommended)

**Ownership and guard (F4, F19).**

`chapter-take.ts` holds:
- the **only** take-path builders (`takePartPath`, read-only accessors for readers);
- every take mutation.

Each entry point and what it replaces:

| Entry point | Replaces or serves |
|---|---|
| `commitTake` | finalize's preserve and install |
| `acceptTake` | accept's audio step |
| `restoreTake` | reject's audio step |
| `dropAllTakes` | exclude's deletes, and a restructure delete op |
| `relabelTakes` | restructure renames: `rewriteChapterSlugs` moves into the module |
| `commitScoring` | the scoring and attempted-marker writes (F23) |
| `stampStateFromLiveTake` | the state stamp (§4.3) |
| `reconcileSlug` | the journal replay |

QA repair's Edit 6b embeddings and verdicts become **staged inputs** to `commitTake`. They are no
longer post-finalize writes.

The reparse/replace wipe of `audio/` stays where it is, on an **allowlist**: it is a
whole-directory removal under book-op with no job registered, and it touches no single take.

**The guard** is `workspace/chapter-take.guard.test.ts`, in the shape of
`state-json-lock.guard.test.ts`. It is syntactic over `server/src` non-test files. It fails on:
- any template literal or `join` that forms `<slug>.<takeSuffix>` (the module's suffix table,
  `.previous.*`, `.next-*` and `.discard-*` included) outside the module and its allowlist;
- any call to `rename`, `renameWithRetry`, `rm`, `unlink`, `writeFile`, `writeJsonAtomic`,
  `writeEmbeddings`, `writeVerdicts`, `writeAttempted`, `writeChapterPeaksFile` or
  `writeChapterLufsFile` whose path argument comes from such an expression.

The write helpers (`writeEmbeddings`, `writeVerdicts`, `writeAttempted`) stay generic. The guard
sees them through the path expression, so a take path can only be built inside the module.

**Allowlist:**
- read-only builders in R-a…R-j, which migrate to the module's accessors in Phase 1, after which
  the allowlist shrinks to zero;
- the reparse wipe;
- the restructure **segments-metadata** rewrite, once it moves into `relabelTakes`.

**Fence.**
- Every entry point runs inside `withBookOp` for its book. Quick operations already hold it.
- A long job calls `withBookOp` only around `commitTake` or `commitScoring`. The job holds no
  book-op of its own, so this is not nesting.
- Book-op's "never inside a shared helper" rule is kept: finalize splits into `prepareTake` (no
  lock) and the caller-invoked `commitTake`.

**Prepare** (`prepareTake`, no lock). Every new part is written to
`<slug>.next-<takeId>.<suffix>`:
- audio;
- segments (with `takeId`; `takeSeq` is filled at commit);
- peaks and lufs;
- embeddings (OD4 carry-forward from the base take, plus fresh rows);
- verdicts and the attempted marker (OD4; empty for a full render).

Nothing live is touched during preparation.

**Commit** (`commitTake(handle, staged, {base, signal})`), inside book-op:

0. **`reconcileSlug(slug)`**: replay or roll back any leftover journal for this slug (F8, below).
1. Refuse if `signal.aborted` (H8).
2. CAS on `base` when one is given (§4.1; partial writers only, OD2).
3. Write the journal `<slug>.take-journal.<journalId>.json`:
   `{op:'commit', phase:'discard-old-previous', newTakeId, liveTakeId, prevTakeId, parts}`.
4. **If a live take exists,** move the old previous take (all parts) to
   `.discard-<journalId>.*`. It is **renamed, never unlinked** (F9).
   **If no live take exists, the existing previous take is the only copy of the user's audio. It
   stays as the previous take and is not discarded** (F16).
5. `phase:'preserve'`:
   - rename each live part to `.previous.<suffix>`, using the **real extension**
     (`.previous.m4a`);
   - write `.previous.take.json` with the take fields from §4.2.

   Every rename refuses an existing target, by an `existsSync` check under the lock; a target
   that is present is a fault, not something to overwrite.
6. `phase:'install'`: rename each staged part onto its live name. A different-extension live audio
   left over (N4) moves to `.discard-<journalId>.*`.
7. `phase:'installed'`. Then:
   - run `stampStateFromLiveTake`, plus `audioTakeSeq += 1` and the `generationState*` clear;
   - record or drop the review entry (best-effort, OD3).
8. `phase:'cleanup'`: unlink the `.discard-<journalId>.*` set, then the journal.

**Failure handling:**
- A failure before `installed` rolls back from the journal, in reverse order, inside the same
  span: staged parts back to `.next-*`, `.previous.*` back to live, discard back to previous. The
  job then fails with a fixed sentence.
- A failure at or after `installed` rolls forward (OD3).

**Retries and the watchdog (F18).**
- **Lock timeout.** A `LockAcquisitionTimeoutError` on the span does not throw away the render.
  The job retries the commit with backoff while the staged files persist, calls `bumpProgress()`
  on every attempt so the no-progress watchdog sees forward motion, and gives up only on abort.
- **Watchdog during a commit.** Generation sets `committing = true` around the span. A watchdog
  that fires while `committing` is set does not abort and does not stamp `failed`.
- **Failure stamp.** The failure-stamp path (`generation.ts:2369`) checks, inside its
  `state-json` lock, that the chapter's `audioTakeId` is not this job's `newTakeId` before it
  stamps `failed`. So a take that committed is never marked failed.
- **After the span.** `afterChapterFinalized` (the attempted marker and the scoring trigger) runs
  **after** the span is released, and writes through `commitScoring`.

**Journal rules (F8).**
- **Every entry point replays first.** `commitTake`, `acceptTake`, `restoreTake`, `dropAllTakes`,
  `relabelTakes` and `commitScoring` all call `reconcileSlug` first, under book-op.
- **What a replay does.** It replays a journal by its `op` and `phase`:
  - for a commit, before `installed` it rolls back and from `installed` on it rolls forward;
  - for a restore, as in the reject table below.
- **More than one journal for a slug** should be impossible under book-op. If it happens, the
  entry point refuses with a fixed 500, and the fsck quarantines the extra journals to
  `audio/.orphaned/` and logs them.
- **Unique names.** The journal id is fresh per operation, so names never collide.
- **Not boot-only.** Recovery runs at every entry point, so a crash is repaired by the next
  touch, not just at the next boot. This is Option B's non-boot recovery, borrowed (§5.D).

**Accept** (`acceptTake`). Accept keeps the `live_audio_missing` pre-check: no live take plus a
previous take gives a 409 and touches nothing. What else it does depends on the live `takeId`
(F17):

| Live `takeId` is… | Accept does |
|---|---|
| the entry's `takeId` (B) | moves the previous take to `.discard-*`, then cleanup; `takeSeq += 1`; commits `accepted` |
| the entry's `previousTakeId` (A) | **a reject's audio step already ran**. Accept and reject converge: the entry is removed, `rejected` (the truth) is appended, and the answer is 409 `revision_gone` with the state |
| anything else | `revision_gone`, entry kept as today |

**Reject** (`restoreTake`). Journal `op:'restore'`. The phases, with what a replay does at each:

| Phase | Action | Replay before the next phase |
|---|---|---|
| `discard-live` | move live parts to `.discard-<journalId>.*` | move them back (roll back) |
| `promote` | rename each `.previous.*` part onto its live name (target checked absent) | roll forward: finish the renames |
| `stamp` | run `stampStateFromLiveTake` (now the A take), `takeSeq += 1` | roll forward |
| `cleanup` | unlink the discard set, `.previous.take.json`, the journal | roll forward |

At every point, each take exists whole on disk (H1, H2).

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
- it moves the live take, the previous take and every sidecar to the discard set, unlinks it, and
  drops the pending entry;
- **if there is no live take**, the previous take (the only copy) moves to `audio/.orphaned/`
  instead of being deleted.

**Restructure** (`relabelTakes`):
- the two-pass rename covers every take suffix, with previous for all three extensions plus
  `.previous.take.json`;
- delete ops go through `dropAllTakes`, with the same only-copy rule;
- `buildAudioOps` also tests `chapterAudioExists` and the presence of a previous take (H11
  residual).

**Scoring** (`commitScoring`, F23):
- one book-op span **per scoring pass**, not per chapter;
- the pass buffers its rows in memory;
- inside the span, it writes each chapter's verdicts and attempted marker only if that chapter's
  live `takeId`/`takeSeq` still equals the pair it scored. Mismatched chapters are dropped (logged)
  and picked up by the next pass.

`generation.ts:295`'s per-chapter `writeAttempted` becomes a single-chapter `commitScoring` call.

**Readers.**
- They stay lock-free, through the module's accessors. Each part changes by an atomic rename;
  cross-file skew is limited to one rename window.
- The job readers that care (splice, QA repair, scoring) are protected by CAS.
- The portable export lists **live parts from the module** (F15). The module excludes
  `.previous.*`, `.next-*`, `.discard-*`, `.take-journal.*` and `.orphaned/`.

**Windows (F9, N4).**
- Every rename is `renameWithRetry`. A persistent failure inside a commit or restore rolls back
  from the journal and fails with the fixed sentence "the chapter's audio file is in use (an export
  or clip may be running); retry when it finishes".
- **Unverified:** whether rename-onto or rename-away of a file that an ffmpeg process holds open
  succeeds, on NTFS and on a OneDrive-backed workspace. That is register row Q (§7).

**Lock order.**
- No new class. The module uses existing edges only: `book-op → book → state-json` (the stamp) and
  `book-op → revisions`.
- `revision-op` is removed.
- **New rule:** a long job takes book-op only around `commitTake` or `commitScoring`, never across
  preparation.

**Span length and contention (F11).** A commit is **not** "milliseconds".
- `withBookOp` resolves the book under the lock, which runs `backfillAudioModelKeysFromSegments`
  (`book-op-lock.ts:262`), O(chapters).
- Each `renameWithRetry` can take up to about 3.6 s on a contended Windows file
  (`atomic-rename.ts:18-24`). A commit renames up to about 15 parts.
- **Typical:** tens of ms plus O(chapters) reads.
- **Worst:** seconds. Every other book-op waiter has a **10 s acquisition budget**
  (`file-lock.ts`, #2260):
  - **Quick operations** that time out behind a commit (accept, reject, exclude, a state PUT)
    answer the existing curated `lock_contention` 500, which the user retries.
  - **Commits** retry (above), so a render is never lost to contention.
- **Mitigation, in Phase 2:** `commitTake` runs its renames with a bounded variant
  (`renameWithRetry` with a 1 s cap). A file still locked after that is treated as "in use" and
  rolls back rather than holding book-op for 3.6 s × N.
- Measurement of real commit spans is owed on the box (row Q).

**Hazards closed:** H1–H4, H6, H7, H8 (except a commit wedged inside the filesystem), H9,
H12–H14, H16 (via OD2), H17, H18, H19 (server entries), H20, H22, F2, N1, N2, N4 (it degrades to a
failed render, never a mixed take), N6, N7, N8, N9.

**Remaining:**
- reader skew within one rename window;
- legacy client entries (H19);
- a commit wedged mid-rename (the watchdog defers while `committing`; a server restart replays the
  journal).

**Blast radius (F24).** About 28 source files, plus tests.

| Area | Files |
|---|---|
| New | `workspace/chapter-take.ts`, `workspace/chapter-take.guard.test.ts` |
| Folded in / removed | `workspace/preserve-previous-audio.ts`, `audio/previous-audio.ts`, `audio/rewrite-chapter-slugs.ts` |
| Finalize and callers | `audio/finalize-chapter-write.ts`, `routes/generation.ts` (commit span, signal, `committing`, failure-stamp check, `writeAttempted`, OD2 per-chapter abort), `routes/chapter-splice.ts`, `routes/chapter-qa-repair.ts` (base token, Edit 6b staged) |
| Revisions | `routes/revision-ops.ts`, `routes/chapter-audio.ts`, `workspace/revisions-store.ts` (`takeId`/`previousTakeId`, `entryMatchesChapter`, retire `revisionOpLockKey`) |
| Restructure | `routes/chapters-restructure.ts`, `workspace/restructure.ts` (`buildAudioOps`; carry `audioTakeId`/`Seq`) |
| Book state, exclude, fsck, scan | `routes/book-state.ts`, `workspace/fsck-orphan-audio.ts`, `workspace/scan.ts` (types, re-stamp) |
| Scoring | `audio/render-integrity/aggregate.ts`, `audio/render-integrity/verdicts-io.ts` |
| Export | `routes/export.ts` (OD7 reject refusal), `export/build-portable-book.ts` (F15) |
| Types and contract | `audio/segments-io.ts` (types), `openapi.yaml` + `src/lib/api-types.ts`, `src/lib/api.ts` (A-side URL, mocks) |
| Lock-order docs | `workspace/cast-lock.ts` and `workspace/book-op-lock.ts` comments, CLAUDE.md |

**Tests (F22).**
- **Fault injection over the module**, parameterised over **every take part, the previous take's
  parts included**, and over every phase of the commit, restore, accept, drop and relabel
  journals. Each injected failure leaves each take whole on disk, and `reconcileSlug` converges.
- **Race tests:**
  - reject during a commit;
  - two commits on one chapter;
  - splice CAS mismatch;
  - commit after abort;
  - watchdog during a commit;
  - the failure stamp after a commit;
  - scoring CAS;
  - ABA (reject, then a stale splice whose `takeId` matches a previous take but whose `takeSeq`
    does not).
- **Format coverage:** m4a and ogg books through commit → reject → accept → relabel → drop → fsck.
- **Migration** fixtures for every §6.1 rule.
- **The guard test.**
- **e2e:** the A/B player on an m4a book in mock mode.

### Option B: per-chapter manifest and generation counter

**Mechanism.**
- `audio/<slug>.take.json` = `{gen, live, previous}`, where `gen` is **monotonic**. Parts are named
  by generation (`<slug>.g<gen>.<suffix>`).
- A commit writes the new generation's parts, then makes **one atomic manifest write** under a
  short book-op span. Reject swaps `live` and `previous` with no file moves at all.
- The manifest is the truth **at every moment**, so recovery is "ignore unreferenced generations".
  It needs no journal and runs on any touch, not only at boot.

**Reader changes.** Every reader resolves through the manifest: about 40 sites (`export/*`,
`clip`, `qa-report`, `render-integrity/*`, `scan`, the sync manifest, `cast-audio-currency`,
`synthesise-chapter`, `segment-asr-qa`).

**Migration.** Synthesise a manifest from the flat files; the portable bundle and import flatten
or learn the layout.

**Closes** all of A plus reader skew. **About 40–45 files.**

### Option C: versioned take directories

**Mechanism.** `audio/<slug>/takes/<takeId>/…` with `live`/`previous` pointers. Pointer flips are
atomic, and restructure renames one directory per chapter.

**Migration.** A one-time move of every book's flat files, with its own recovery path. The
portable format changes.

**Closes** the same as B. **About 45–50 files**; highest risk.

### D. What A borrows from B, and why

B's two real advantages over revision 1's A were:
1. a **monotonic generation**, which makes the CAS immune to ABA;
2. **recovery at any moment**, not only at boot.

Revision 2's A takes both:
- **`takeSeq`** is B's generation, kept in `state.json` (§4.1);
- **`reconcileSlug` at every entry point** gives recovery on the next touch (F8).

What A still lacks is B's reader atomicity across files. Nothing observed needs it: job readers are
covered by CAS, and UI readers refetch after every op. Because the module now owns every path, B's
manifest could later replace the journal inside the module without touching any caller.

### Comparison

| | A | B | C |
|---|---|---|---|
| New lock class | none (retires `revision-op`) | none | none |
| Writer fence | book-op span + CAS (`takeId`, `takeSeq`) + signal | same, with `gen` | same |
| Reader consistency | per file | per take | per take |
| Recovery | per-slug journal, replayed at every entry point | the manifest is the truth | the pointer is the truth |
| Layout change | names only | generation-suffixed files | directories |
| Files touched | ~28 | ~40–45 | ~45–50 |

## 6. Recommendation and migration

**Option A**, as revised:

1. **The fence already exists.** Book-op serialises every quick operation. A adds short commit
   spans for the two long-job writers that remain, and a guard that sees every take write.
2. **It answers every reason the #3400 attempts failed:**
   - the exclusion is lexically scoped, so it cannot leak;
   - identity is a filename-safe id plus a monotonic sequence number, read from the take itself,
     never inferred from absence or from a timestamp;
   - sidecars are staged, never captured from the wrong take.
3. **Smallest blast radius.** It keeps the flat layout, the portable format and the export
   builders.

**Book-op versus a per-chapter key (F12).** A per-chapter key is **not** a drop-in fallback.
- Restructure, exclude-prune, reparse and the fsck touch many chapters per operation, so each
  would have to take every affected chapter's key. That means a multi-key acquisition, ordered and
  bounded, with no existing `withKeyLocks` precedent for chapter keys.
- The key would also sit at a new place in the order (`book-op → take → book`).
- The guard would have to follow it.

Revisit only if row Q measures real contention.

### 6.1 Migration (F2, F6; OD8)

It runs per book in the boot fsck's step, under book-op. It is idempotent, and every step **checks
before it renames**: no rename may replace an existing file. A target that already exists means the
source is quarantined to `audio/.orphaned/<slug>.<name>` instead.

1. **Inventory first.** List every live audio file of each extension and every
   `.previous.{mp3,m4a,ogg}`. Sniff each one by magic bytes: an `ID3` tag or an MPEG sync word
   means mp3; `ftyp` at offset 4 means m4a; `OggS` means ogg. **Nothing is renamed yet.**
2. **Two or more live files.**
   - **Choosing the live one.** A file "matches" when the duration ffprobe decodes is within ±0.5 s
     of the live `segments.json`'s `durationSec`. Exactly one match: that file stays live.
   - **The others.** If no previous take exists, one non-match becomes the previous take (with its
     real extension, the target checked absent). The rest are quarantined.
   - **Zero or several matches.** Every candidate except the newest by mtime is quarantined, and the
     case is logged for the user.
3. **Wrong-name files.** Rename a live or previous file whose bytes disagree with its extension to
   the right extension, but only if that target is absent; otherwise quarantine it. This repairs
   earlier rejects on m4a/ogg books that wrote AAC or Opus bytes behind `.mp3`.
4. **Identity.** Mint a `takeId` into the live `segments.json` and into `.previous.segments.json`
   (and `.previous.take.json`, derived as in §4.3) where it is missing. Set `audioTakeSeq` to 1 if
   it is absent.
5. **Re-stamp (F2).** Where `state.json`'s take fields disagree with the live segments, run
   `stampStateFromLiveTake` and `takeSeq += 1`. This repairs every legacy reject.
   - **Effect on legacy-reject entries:** a pending entry whose `renderedAt` named the rejected
     take stops matching (`revision_not_found`). That is correct, because the reject already
     happened.
   - **No-op otherwise:** an entry whose take is unchanged (state and segments already agree) is
     unaffected.
6. **The no-live-take shape (F16).** A previous take with no live take is **left alone**: no
   promotion, no deletion. The fsck promotes only when a journal says so, or when the chapter is
   not excluded **and** `state.json`'s `audioTakeId` equals the previous take's `takeId` (the "crashed
   before install" shape). Otherwise it logs, and the UI's existing `live_audio_missing` path
   offers Reject.

## 7. Phased rollout (each phase splits into roughly one-commit children)

**Done outside this design:** #4166 (N3, `completedSlugs`) and #4167 (N5, the leaked tmp audio)
are filed and queued.

**Phase 1: identity, naming and migration.** No behaviour change for a clean mp3 book.
1. `chapter-take.ts` skeleton:
   - suffix table and accessors;
   - `takeId`/`takeSeq` types (state + segments, `scan.ts` types);
   - the sniffer, `stampStateFromLiveTake` (with `effectiveAudioModelKey`).

   Unit tests.
2. Readers move to the module's accessors. Portable export uses the module's live-part list (F15).
3. Preserve, restore and the fsck use real extensions. `revisions-store`'s existence check goes
   through the module.
4. A-side routes for every extension, with the right mime type; the meta URL uses `urlSuffix`.
   OpenAPI, types, client and mocks.
5. Fsck migration (§6.1). Fixture tests for every rule.
6. Restructure carries `audioTakeId` and `audioTakeSeq` across renames.
7. The guard test, with its read-only allowlist emptied as the steps above land.
8. e2e: m4a A/B.

**Phase 2: commit protocol.** PR at `high` review depth.
1. `prepareTake` staging every part, with QA repair's Edit 6b embeddings and verdicts as staged
   inputs and the OD4 carry-forward.
2. `commitTake` with the journal, the discard set (no unlink) and the only-copy rule; `reconcileSlug`.
3. Generation:
   - the commit span, signal and `committing` flag;
   - the failure-stamp check;
   - commit retry with `bumpProgress`;
   - `afterChapterFinalized` after the span;
   - OD2's per-chapter splice abort.
4. Splice and QA repair base tokens; the CAS-mismatch sentence; N6 driven by the commit result.
5. The bounded rename cap inside a commit.
6. Lock-order comments and the CLAUDE.md order sentence.

**Phase 3: fidelity, retry recognition, scoring.**
1. `restoreTake` with its journal phases; `acceptTake` with the live-token table; entries gain
   `takeId`/`previousTakeId`; `entryMatchesChapter` widens.
2. Retire `revision-op`.
3. `commitScoring`: one span per pass, buffered, with a per-chapter CAS. `generation.ts:295` goes
   through it.

**Phase 4: remaining fences.**
1. `dropAllTakes` for exclude (OD6) and for restructure delete ops; `relabelTakes`;
   `buildAudioOps` checks presence.
2. Reject and `restore-unrecorded` refuse `book_busy` during an export (OD7).
3. On-box register rows on all three surfaces:
   - **Row Q, the Windows matrix.** Workspace on NTFS, and on a OneDrive-mounted folder, crossed
     with each holder:
     - ffmpeg reading the live file (an export m4b build, a `clip.ts:73` cut);
     - a Node read stream (an R-a playback);
     - none.

     For each cell, record whether:
     - rename-away of the held file succeeds;
     - rename-onto the held file's name succeeds;
     - unlink-then-rename-onto succeeds.

     Also record real commit-span timings. **The result decides whether N4 is real, and whether
     OD7 needs extending to render commits.**
   - **An m4a book on real hardware:** render → splice → reject → accept, with the files listed
     before and after.

Each PR carries:
- release notes, technical and user-facing. Phase 1's line: "Reject restores the original take
  correctly on M4A and Opus books";
- the regression plan `docs/features/<n>-chapter-take-lifecycle.md`;
- an `INDEX.md` row.

## 8. Open questions for the assumption-checker

- **Row Q.** Windows rename semantics against ffmpeg and Node holders, on NTFS and OneDrive. N4's
  severity, OD7's scope, and the bounded-rename cap all depend on it.
- **ffprobe tolerance.** Is ±0.5 s on decoded duration a reliable "matches" test for every encoder
  path, including the splice remix, which re-encodes?
- **Other attempted-marker writers.** Does any reader of `render-integrity-attempted.json` treat a
  marker carried in a staged take (OD4) differently from one written by scoring?
- **Partial carry-forward.** Does `deriveBookOutline` tolerate verdict rows carried forward for
  untouched segments whose `resolvedCharacterId` stamps were frozen by finalize (#3362)? Expected
  yes, since the keys are the same.
