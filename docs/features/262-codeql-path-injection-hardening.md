---
status: stable
shipped: null
owner: null
---

# CodeQL path-injection + proto-pollution hardening (export pipeline)

> Status: stable
> Key files: `server/src/util/safe-path.ts`, `server/src/workspace/chapter-audio-file.ts`, `server/src/routes/export.ts`, `server/src/export/{build-mp3-zip,build-mp3-folder,build-captions,sync-folder}.ts`, `server/src/workspace/script-review-ledger.ts`
> URL surface: `POST /api/books/{id}/exports`, `GET …/exports/{jobId}/download`
> OpenAPI ops: export job create / poll / download (unchanged shapes)
> Issue: #1690

## Benefit / Rationale

- **User:** none visible — this is pure hardening. Every change is a **no-op on
  legitimate input** (real chapter slugs and slugified titles contain no path
  separators and no `..` runs), so exports of real books produce byte-identical
  paths and files.
- **Technical:** closes the one genuinely under-guarded seam — `chapter.slug`
  flowing unsanitised into `findChapterAudio()` / `*.segments.json` joins — and
  clears the CodeQL code-scanning dashboard (35 open alerts → 0 open, 1
  dismissed) by routing every tainted path segment through the repo's own
  CodeQL-recognised sanitisers in `server/src/util/safe-path.ts`.
- **Architectural:** establishes "sanitise book/chapter metadata at the path
  sink with `sanitizeIdSegment` / `assertContained`" as the standing pattern for
  the export pipeline, so future builders inherit it.

## Threat model

The server is local + single-user, so the realistic attacker is not a remote
client but a **maliciously-crafted imported manuscript**: an EPUB whose title /
author / chapter-title / chapter-slug metadata carries traversal sequences
(`../`, `..\`). Those values flow — via `state.json` — into filesystem joins in
the export builders. The load-bearing gap was `chapter.slug`, which reached
`join(audioRoot, \`${slug}.${ext}\`)` and `join(root, \`${slug}.segments.json\`)`
with no sanitiser between source and sink; a crafted slug could resolve a read
outside the book's audio directory.

`exportSyncFolder` (the user's chosen mirror directory) is deliberately left as
an arbitrary root — the user picked it — but the author/title *sub-folders*
composed under it are now asserted to stay contained.

## What changed

All fixes reuse the existing helpers in `server/src/util/safe-path.ts`.
`sanitizeIdSegment` is a **transforming** sanitiser (separators / `..` runs →
`_`) that CodeQL propagates across function boundaries; `assertContained` is the
recognised containment barrier.

| Sink | Taint source | Fix |
|---|---|---|
| `chapter-audio-file.ts` `findChapterAudio` join | `chapter.slug` | `sanitizeIdSegment(slug)` — clears the slug taint at **every** export consumer via propagation |
| `build-captions.ts` `*.segments.json` join | `chapter.slug` | `sanitizeIdSegment(chapter.slug)` |
| `export.ts` `resolveArtifactPath` / `outPath` / `buildPath` | `job.filename` (slug(title) + validated suffix; also manifest-rehydrated) | `sanitizeIdSegment(filename)` at each join — clears the `unlink`/`rm`/`sendFile` sinks + the `outPath`-derived sinks inside `build-m4b` / `build-codec-zip` (no edits needed there) |
| `build-mp3-zip.ts` / `build-mp3-folder.ts` staging filename join | `sanitiseForZip(chapter.title)` | `sanitizeIdSegment(entryName)` on the **filesystem** join; the pretty name stays the zip label |
| `sync-folder.ts` file + folder writes | `filename`, `bookSubfolder` under the user sync root | `sanitizeIdSegment(segment)` + `assertContained(destDir, …)` |
| `export.ts` `console.error` on `sendFile` failure | `path`, `err.message` | static `%s` format string (`js/tainted-format-string`) |
| `script-review-ledger.ts` `patchSelection` merge | request-body `selected` keys | `safeSelection()` drops `__proto__`/`constructor`/`prototype`; `ownEntry()` guards the dynamic-key lookup in `resolveOps` + `patchSelection` (`js/prototype-polluting-assignment`) |

**Dismissed (false positive, not a code change):** `script-review.ts` reflected
XSS on the SSE `no_such_chapter` error. The reflected value is `chapterId`,
guarded `typeof === 'number'` at the route, JSON-stringified, and served as
`text/event-stream` (not `text/html`). Dismissed via the code-scanning API with
this justification.

## Architectural impact

- **No new seams.** Reuses `safe-path.ts` exactly as the workspace path builders
  (`bookDirByDisplay`, `qwenVoiceSidecarPath`) already do.
- **Invariants preserved.** No wire-protocol / `state.json` / `cast.json` /
  `openapi.yaml` change. `findChapterAudio` keeps its graceful contract —
  a malicious slug now sanitises to an in-root name that doesn't exist and
  returns `null`, exactly as an unknown chapter already did (it does not throw).
- **Migration:** none. Ledger entries with a previously-persisted `__proto__`
  key (only reachable by a prior hand-crafted PATCH) are simply never re-merged.

## Test plan

Paired automated regression tests (all fail before the fix, pass after — the two
subtle ones verified empirically for the JS semantics they rely on):

- `chapter-audio-file.test.ts` — a `../evil` / `..\evil` slug does **not** reach
  a file planted one level above the audio root (returns `null`); legit slugs
  unchanged.
- `sync-folder.test.ts` — a `../escape` filename / book sub-folder stays under
  `destDir`; nothing is written to the parent.
- `script-review-ledger.test.ts` — `patchSelection` with an own-enumerable
  `__proto__` key persists only the legitimate keys; `Object.prototype`
  untouched.

Existing export route + builder suites stay green (`export.test.ts`,
`exports-portable.test.ts`, `build-*.test.ts`). Server typecheck clean.

**Acceptance:** CodeQL re-scan on the PR reports 0 open alerts for the export
pipeline (1 reflected-XSS dismissed with justification).

## Ship notes

- Shipped: 2026-07-17 (PR #1692, merge commit `1f62dd3a`, closed #1690).
- **Follow-up (same plan):** the post-merge CodeQL re-scan cleared 33 of 35
  alerts but left the two `js/prototype-polluting-assignment` findings open —
  the `hasOwnProperty`-in-`ownEntry` indirection wasn't recognised as a barrier
  because the query wants the property-name checked **inline, in the same
  function as the assignment**. Fixed by replacing `ownEntry` with an explicit
  `isDangerousKey(key)` guard (`key === '__proto__' || …`, not a `Set.has`)
  placed directly before each `entry.<prop> = …` in `resolveOps` /
  `patchSelection`. Shipped in the follow-up PR; re-scan confirmed 0 open.
