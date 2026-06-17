# CodeQL path-injection composed-path residue (for dismissal)

These sinks receive an **already-composed absolute path** from their callers and
have **no single containment root** to assert against (so they cannot host an
in-function `assertContained` guard — unlike `cover/store.downloadCover`, which is
always under `WORKSPACE_ROOT` and was guarded in Task A6). Every path that reaches
them is composed from a source that is already contained or constant:

- workspace state/cast paths → `stateJsonPath`/`castJsonPath(bookDir)` where `bookDir`
  comes from the A5-contained `bookDirByDisplay` (asserts `BOOKS_ROOT` containment) or
  a filesystem-scanned `findBookByBookId().dir` (inherently within `BOOKS_ROOT`);
- the analysis cache path → `cachePath(manuscriptId)` (A2: `safeSegment` guard);
- the analyzer handoff paths → guarded in their write functions (A4);
- `USER_SETTINGS_PATH` → a module constant at `~/.audiobook-generator/`, not request-derived.

Because `state-io` legitimately serves **both** the workspace **and** the external
`~/.audiobook-generator` settings file, no single root can be asserted here — hence
dismissal rather than an in-function guard.

**These are candidates only.** Task D3 dismisses (by alert number, after the
post-merge re-scan) **only the ones still open** — many may auto-clear via the
upstream A2/A4/A5 barriers. Any *other* still-open path-injection alert is re-fixed,
not dismissed (the D3 "re-fix, don't dismiss" gate).

| file:line (approx) | rule | justification |
|---|---|---|
| `server/src/workspace/state-io.ts` (readJson / readJsonWithRecovery / writeJsonAtomic tmp+rename / rotateBackups) | js/path-injection | receives a pre-composed path; sources are A5-contained `bookDir`, scanned dirs, A2/A4-guarded ids, or the constant `USER_SETTINGS_PATH`; multi-root (workspace + `~/.audiobook-generator`) so no single containment root to assert |
| `server/src/workspace/atomic-rename.ts` (`renameWithRetry` src/dest) | js/path-injection | shared low-level rename used by state-io + cover + export writers; both args are pre-composed by the (already-contained) callers; multi-root |

**Not exploitable today** — recorded so the dismissals in D3 are traceable, not to
imply these were live vulnerabilities. `voiceSampleFilePath` is traversal-safe via its
`-<modelKey>-<hash>.mp3` filename suffix (not via `asciiFileScope`, which passes `.`);
`auto-backup` is gated by `findBookByBookId` + `STAMP_RE`.
