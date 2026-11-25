---
status: active
shipped: null
owner: null
---

# Chapter take lifecycle: one module owns a chapter's live and `.previous` audio

> Status: KNOWN: backend-pending (Phase 1 of 4 shipped here; Phases 2-4 still owe the commit protocol, the revisions cutover and the live view)
> Key files: `server/src/workspace/chapter-take.ts`, `server/src/workspace/take-fields.ts`, `server/src/workspace/book-op-lock.ts`, `server/src/workspace/scan.ts`
> URL surface: none directly; the A/B player (`#/books/<id>/listen`) reads the previous take through `GET /api/books/{bookId}/chapters/{chapterId}/audio/previous.<ext>`
> OpenAPI ops: the previous-take audio route and the chapter-audio meta URL (`urlSuffix`); `PUT /api/books/{bookId}/state` gains `slug_bound` refusals

- Spec: [`docs/superpowers/specs/2026-11-13-chapter-take-lifecycle-design.md`](../superpowers/specs/2026-11-13-chapter-take-lifecycle-design.md) (revision 11, owner-approved, PR #4189). It is the design of record, and every owner decision in it is binding.
- Issue: #3456. Phase parents: #4319 (Phase 1, this plan's subject), #4320 (Phase 2), #4321 (Phase 3), #4324 (Phase 4).

This is the durable regression plan for the whole #3456 lifecycle. It is filled in for Phase 1 now, and each later phase extends it in its own PR.

## Benefit / Rationale

- **User:** Reject restores the original take correctly on M4A and Opus books. Before Phase 1 the preserved take was always named `.previous.mp3` whatever its real format, so a Reject on a non-mp3 book could bring back a misnamed file.
- **Technical:** every take path, every take mutation and every take field in `state.json` has one owner. Duplicate or misnamed audio resolves to one live take, and the rest is quarantined, never deleted.
- **Architectural:** the take's identity (`takeId`), naming (real `.previous.<ext>`), liveness (`chapterAudioExists`) and lazy migration are settled before Phases 2-4 add the commit protocol on top. A guard test stops new take paths growing outside the module.

## Architectural impact

- **New seams:** `server/src/workspace/chapter-take.ts` (the module) and its leaf `server/src/workspace/take-fields.ts` (R10-2), which holds what `scan.ts` needs. `withBookOpAtDir` hands its callback a book-op handle, and an unaddressed-directory set lands with it.
- **Invariants preserved:** `check:cycles` passes against the unchanged `server/madge-cycles-allowlist.json`. `scan.ts` and every module it reaches take take-names only from `take-fields.ts`, never from `chapter-take.ts`.
- **Migration story:** lazy, per chapter, and idempotent. The boot fsck and Accept/Reject/restore-unrecorded run the same per-chapter reconcile. The boot fsck walks every chapter of every book, so the first boot gives every rendered take an id (segments, embeddings, `state.json` `audioTakeId`), renames a wrong-named audio file, quarantines a duplicate live file under `audio/.orphaned/`, and fills any absent take member of `state.json`. It rewrites no existing `state.json` take value on a healthy chapter, and a clean mp3 book behaves as before.
- **Reversibility:** reverting the PR leaves `takeId` fields that older code ignores. It does not undo the files Phase 1 moved: a renamed live file keeps its real extension, a quarantined duplicate stays under `audio/.orphaned/`, and a `.previous.m4a` or `.previous.ogg` written since is not read by older code, which probes `.previous.mp3` only. A legacy `<slug>.previous.mp3` is still read.

## Invariants to preserve (Phase 1)

1. **One take module.** `chapter-take.ts` plus its leaf `take-fields.ts` own every take path, take mutation and take field. Enforced by the guard allowlist.
2. **A `takeId` is minted lazily** (16 base32 characters, `a-z2-7`) at the boot check and at Accept/Reject, by `ensureTakeIdentity`. It is idempotent, and it is written to the segments and the embeddings, then mirrored into `state.json`.
3. **Real `.previous.<ext>` naming end to end:** preserve, restore, accept, the fsck, restructure's moves and the A-side routes all use the take's real extension.
4. **Multi-live and wrong-name files are resolved, or quarantined to `audio/.orphaned/`, never deleted.** A reparse keeps `.orphaned/`.
5. **The legacy-reject re-stamp.** A take restored by an old Reject, which left stale take fields, is re-stamped from its segments.
6. **`TAKE_STATE_FIELDS` is the single list** (`duration`, `audioModelKey`, `audioEngines`, `audioRenderedAt`, `audioQa`, `audioTakeId`). The PUT strips a client `audioTakeId`; restructure's carry and the analysis persist's carry use the same list.
7. **The PUT's `slug_bound` refusals.** A state save that would separate a chapter from its audio is refused with 409.
8. **The guard.** No take path is built outside the module except the allowlisted, counted sites.
9. **A mp3 book without any of the above problems behaves exactly as before** (no behaviour change for a clean mp3 book).

## Test plan

### Automated coverage

All paths are under `server/src/` unless they say otherwise, and each exists in the tree at this commit.

| # | Invariant | Test file |
|---|-----------|-----------|
| 1 | one module, the suffix table, the probes | `workspace/take-fields.test.ts`, `workspace/take-fields.finder.test.ts`, `workspace/chapter-take.test.ts` |
| 1 | the guard allowlist, with exact counts | `workspace/chapter-take.guard.test.ts`, `test-utils/guard-scan.test.ts` |
| 2 | lazy `takeId` at boot check and at Accept/Reject | `workspace/chapter-take.migration.test.ts`, `routes/revision-ops.test.ts` |
| 3 | preserve, restore, accept with the real extension | `workspace/chapter-take-previous.test.ts`, `routes/chapter-audio.test.ts` |
| 3 | finalize, rewrite and fsck use the real name | `audio/finalize-chapter-write.test.ts`, `audio/rewrite-chapter-slugs.test.ts`, `workspace/fsck-orphan-audio.test.ts`, `workspace/restructure.test.ts` |
| 3 | the A-side routes and mime types | `routes/chapter-audio.test.ts`, `workspace/revisions-store.test.ts` |
| 4 | multi-live and wrong-name resolution, `.orphaned/` | `workspace/chapter-take.reconcile.test.ts`, `routes/book-state.reparse.test.ts` |
| 5 | the legacy-reject re-stamp | `workspace/chapter-take.migration.test.ts` |
| 6 | `TAKE_STATE_FIELDS` as the one list | `routes/book-state.server-owned-chapter-fields.test.ts`, `workspace/chapter-uuid.test.ts`, `workspace/scan.heal-take-fields.test.ts`, `routes/analysis.title-flags.test.ts` |
| 7 | `slug_bound` refusals | `routes/book-state.slug-bound.test.ts` |
| 9 | completed slugs and chapters use the live-take predicate | `routes/book-state.completed-slugs.test.ts`, `workspace/scan.test.ts` |
| - | readers: exports, portable book, QA aggregation | `export/build-portable-book.test.ts`, `audio/render-integrity/aggregate.test.ts`, `audio/render-integrity/verdicts-io.test.ts` |
| - | the M4A A/B player in a real browser | `e2e/revision-diff-m4a.spec.ts` |
| - | the client mock serves the previous take | `src/lib/api.mock-revisions.test.ts` |

### Manual walkthrough (m4a book)

Use `server/src/__fixtures__/the-coalfall-commission.md`, the canonical manuscript, in a book set to the AAC/M4A format.

1. Render chapter 1. List `audio/`. Expected: `01-<slug>.m4a` plus its sidecars, and no `.previous.*` file.
2. Re-render chapter 1 with review on. List `audio/` again. Expected: the new `01-<slug>.m4a`, and `01-<slug>.previous.m4a` with its `.previous.*` sidecars. No `.previous.mp3`.
3. Open the A/B player. Expected: both takes play.
4. Reject the new take. List `audio/` once more. Expected: `01-<slug>.m4a` is the original take, with no stray `.previous.mp3`, and nothing under `audio/.orphaned/`.

Phase 1 still deletes before it restores on Reject, and still leaves sidecars and loudness on the rejected take. Phases 2 and 3 fix both.

## Still owed by later phases

- **Phase 2 ([#4320](https://github.com/dudarenok-maker/Castwright/issues/4320)):** the commit protocol and its journals, `prepareTake`/`commitTake`, `journalNamedSlugs`, the waiter retries, and `reconcileBook` and the sweep.
- **Phase 3 ([#4321](https://github.com/dudarenok-maker/Castwright/issues/4321)):** `restoreTake` and `acceptTake`; `commitScoring`; the fsck's journalled promotion that replaces case 1; and the Reject ordering fix (H1) and the sidecar and loudness cleanup (H3).
- **Phase 4 ([#4324](https://github.com/dudarenok-maker/Castwright/issues/4324)):** `dropAllTakes` and `relabelTakes`, the live view, and the on-box register rows.

**On-box acceptance is not owed by Phase 1,** so it adds no register row. Spec §7 Phase 4 step 3 places the register rows (row Q, and an m4a book on real hardware) in Phase 4, and §8.4 makes row Q's OneDrive cells a gate for Phase 2.

## Out of scope

The on-box register, the live view, and everything Phases 2-4 own above. `docs/BACKLOG.md` is untouched, since these are `bug` issues rather than `type:feature`.

## Ship notes

(Filled in when status flips to `stable`.)
