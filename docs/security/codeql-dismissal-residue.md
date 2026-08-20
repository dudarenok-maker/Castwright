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

## `js/polynomial-redos` — `text.ts` filename/title parsers (for dismissal)

`FILENAME_RE` (`server/src/parsers/text.ts:140`) and `SERIES_FROM_TITLE_RE` (`:184`)
each carry two adjacent lazy `.+?` groups whose delimiters (`-`, `(`/`)`) legitimately
appear inside author / series / title. No parse-identity-preserving linear rewrite
exists on Node 20 (no atomic groups), and the inputs are the **user's own uploaded
filename / book title** — server-side, not attacker-streamed content — so the ReDoS
is at most a self-inflicted parse stall on a pathological self-named file. Parse
identity is locked by the existing `parseFilenameMetadata` / `parseSeriesFromTitle`
characterization tests, so the regexes are left unchanged and dismissed. (The two
trim ReDoS — `text-match.ts` `normaliseForMatch` and `voice-sample-cache.ts`
`stripQuoteMarks` — WERE fixed in A10 by splitting the `^…|…$` alternation.)

| file:line | rule | justification |
|---|---|---|
| `server/src/parsers/text.ts:140` (`FILENAME_RE`) | js/polynomial-redos | server-side filename-stem input; no parse-preserving linear rewrite (Node 20, no atomic groups); parse identity locked by characterization tests |
| `server/src/parsers/text.ts:184` (`SERIES_FROM_TITLE_RE`) | js/polynomial-redos | server-side book-title input; same rationale |

## `py/stack-trace-exposure` — sidecar curated exception echoes (for dismissal)

Dismissed on **2026-08-18** as `false positive`. The GitHub dismissal comments
for alerts #212, #220, #221, #222 each point back to this file.

Four `{"detail": str(exc)}` sites in `server/tts-sidecar/main.py` echo the text
of a caught exception into a JSON response body. CodeQL flags these as
potential stack-trace exposure, but both exception types involved build their
messages entirely from curated, non-sensitive inputs — never from a traceback,
a filesystem path, or a third-party exception string.

**`DesignContentionTimeoutError`** (raised at `main.py:5873`) builds its message
from a **static template plus one float**: *"Qwen VoiceDesign has been in
flight for over {wait_seconds:.0f}s — refusing to evict it out from under an
active design. Retry the synth shortly."* No traceback, no filesystem path, no
third-party exception string. Alerts #220 (`/qwen/mint-variant`, `:10163`),
#221 (`/synthesize`, `:10606`), #222 (`/synthesize-batch`, `:10934`).

**`VoiceLanguageUnsupportedError`** (raised at `main.py:2377`) builds its
message entirely from the **requested voice and language plus the loaded
model's own config language list**. The audit was already recorded in-code at
`main.py:10569-10573` before this dismissal. Alert #212 (`:10579`).

Both echoes are **deliberate, user-facing guidance**, not incidental leakage:
the contention message tells the caller to retry, and the language message
replaced a `voice_not_designed` response that told users to re-clone the
voice — a remedy that cannot work.

All four sites now carry an audited `# exc-text-safe:` marker, and
`test_no_exception_text_reaches_a_response` was widened in the same PR so the
marker is load-bearing. The guard previously matched the literal text `str(e)`
/ `repr(e)`, so it stepped over all four `str(exc)` sites and had never
actually held — the widening was necessary to bring these sites under the
test's coverage.

| file:line | rule | justification |
|---|---|---|
| Alert #220, `server/tts-sidecar/main.py:10163` (`/qwen/mint-variant`) | py/stack-trace-exposure | `str(exc)` on `DesignContentionTimeoutError`; message is a static template plus a timeout float; `exc-text-safe` marker and widened test guard |
| Alert #221, `server/tts-sidecar/main.py:10606` (`/synthesize`) | py/stack-trace-exposure | `str(exc)` on `DesignContentionTimeoutError`; same curated template; `exc-text-safe` marker |
| Alert #222, `server/tts-sidecar/main.py:10934` (`/synthesize-batch`) | py/stack-trace-exposure | `str(exc)` on `DesignContentionTimeoutError`; same curated template; `exc-text-safe` marker |
| Alert #212, `server/tts-sidecar/main.py:10579` (`/synthesize`) | py/stack-trace-exposure | `str(exc)` on `VoiceLanguageUnsupportedError`; message built from voice/language/model config list only; in-code audit at `:10569-10573`; `exc-text-safe` marker |

## `js/path-injection` — the `/workspace` static guard (for dismissal)

Dismissed on **2026-08-18** as `false positive`. The GitHub dismissal comment
for alert #223 points back to this file.

CodeQL flags `realpathSync` at `server/src/app.ts:182` as a path-injection
sink. The flagged call sits **inside the guard itself**
(`resolveWorkspaceStaticCandidate`), not downstream of it.

The guard, hardened under **#2223**, canonicalises the candidate via
`realpathSync`, **fails closed** by returning `null` when `realpathSync` throws
on a path that exists (catching case/8.3/ADS aliasing), 404s on malformed
percent-encoding, and then requires containment under `books`, `voices`, or
`voice-library` — or an exact match on `voices.json` — via `isContainedIn`
(`app.ts:190-219`), which demands a real path separator (`sep`) immediately
after the root rather than a bare string-prefix match (so a sibling directory
sharing the root as a text prefix, e.g. `voices-secret` against `voices`,
cannot pass).

Dismissed because the containment guard **is not a CodeQL-recognized
sanitizer**, which is the same argument this repo used for alerts #150–#153
and #171.

**Note the tension explicitly:** the composed-path section above (line 23)
carries a "re-fix, don't dismiss" gate for path-injection alerts outside its
two listed sinks. That gate was written when re-fixing meant *adding a missing
`assertContained` guard*. Here the guard already exists and is thorough —
`realpathSync` canonicalisation, fail-closed on error, separator-strict
containment, an explicit allowed-roots allowlist resolved fresh on every
request — so there is nothing to add. That is why this one is dismissed
rather than re-fixed, and the gate does not apply.

| file:line | rule | justification |
|---|---|---|
| `server/src/app.ts:182` (`resolveWorkspaceStaticCandidate`) | js/path-injection | `realpathSync` sits inside the containment guard itself; guard is thorough (realpath canonicalisation, fail-closed, separator-strict `isContainedIn`, per-request allowlist) but not a CodeQL-recognized sanitizer; same argument as alerts #150–#153 and #171 |
