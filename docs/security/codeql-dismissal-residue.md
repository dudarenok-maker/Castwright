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

## `js/incomplete-multi-character-sanitization` — `htmlCellText` (for dismissal)

Dismissed on **2026-08-21** as a provably inert fixpoint loop.

The `htmlCellText` function in `scripts/check-onbox-register.mjs` runs a regex
loop to remove HTML tags via the pattern `/<[^>]*>/g`. CodeQL flags this as
potentially vulnerable to incomplete multi-character sanitization, implying a
second pass could reveal new matches. However, the regex `/<[^>]*>/` is **already
complete in a single global pass**: any surviving `<` in the input has no following
`>`, and removing tags cannot manufacture a new `>` adjacent to a surviving `<`.
Therefore, a second pass will never find a new match, and the fixpoint loop is
provably redundant — though harmless.

In contrast, `stripHtmlComments` (alert #218) has a genuine second-pass case: the
pattern `<!--[\s\S]*?-->` (lazy match) can leave residue when removing a comment
manufactures a new complete comment from the survivors (e.g., `<<!--x-->!--y-->`).
The fixpoint loop for `stripHtmlComments` is load-bearing; the one for `htmlCellText`
is not.

| file:line | rule | justification |
|---|---|---|
| Alert #219, `scripts/check-onbox-register.mjs:366` (`htmlCellText`) | js/incomplete-multi-character-sanitization | regex `/<[^>]*>/g` is already complete in one pass; any surviving `<` has no matching `>`, and removing tags cannot create a new tag; the fixpoint loop is provably inert, kept for consistency with `stripHtmlComments` (#218) which DOES need fixpoint behaviour |

## `py/stack-trace-exposure` — sidecar curated exception echoes (for dismissal)

Dismissed on **2026-08-18** (#220, #223) and **2026-08-21** (#212, #221, #222) as `false positive`. The GitHub dismissal comments
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

## Alerts #227–#236 — the #3721 security sweep (for dismissal)

Dismissed on **2026-10-23** (#227–#232, #234, #235); #233 and #236 are to be
dismissed after this change merges, together with the eleven `fixed`
`js/tainted-format-string` alerts this change re-raises (see below). The GitHub
dismissal comments for #227–#231 cite #3721 ("Audited in #3721."); those for
#232, #234 and #235 cite nothing. This file is the record.

- **`py/stack-trace-exposure` (#227–#231, `false positive`)** — five more
  `{"detail": str(exc)}` echoes in `server/tts-sidecar/main.py` (`:12201`,
  `:12652`, `:12679`, `:13015`, `:11973`), the same shape as the four recorded
  above. Each exception class (`DesignContentionTimeoutError`,
  `Base17ContentionTimeoutError` (#231, `:11973`), `VoiceLanguageUnsupportedError`)
  builds its message from curated values — never a traceback, path, or
  third-party text — and the sites carry the audited `# exc-text-safe:` marker.
  The contention errors are a fixed template plus a number; #228's
  `VoiceLanguageUnsupportedError` message is a template echoing the requested
  voice and language and the model's supported-language list (the dismissal
  comment's "fixed template + number" does not describe it).
- **`js/incomplete-multi-character-sanitization` (#232, `used in tests`)** —
  `scripts/tests/stamp-publish-token.test.mjs:36`: a test asserting that
  stripping HTML comments hides a token; not sanitization of untrusted HTML.
- **`js/incomplete-sanitization` (#234, `used in tests`)** —
  `scripts/tests/npm-check-onbox-register-routing.test.mjs:53`: a test-only
  `quoteArg` helper building a spawn command from hardcoded arguments.
- **`js/insufficient-password-hash` (#235, `false positive`)** —
  `server/src/analyzer/catalog/gemini-catalog.ts:100`: SHA-256 of the Gemini API
  key is an in-memory cache key (`keyHash`) scoping the model catalog to the
  active key. It is not password storage.
- **`js/tainted-format-string` (#233 `routes/book-state.ts:606`, #236
  `routes/revisions.ts:271`)** — request-derived ids sit in a template-literal
  first argument of a `console` call. In the running server this is neutralised:
  `installTimestamps()` (`server/src/logger.ts`, installed at boot in
  `server/src/index.ts`) always passes the timestamp as Node's format argument,
  so a caller's own first argument is never interpreted as a format string.
  `server/src/logger.test.ts` ("renders a template-literal first argument…")
  pins this against the real patch. A consequence recorded in the same change:
  `%s` placeholders do not work in server code, and the sites that used them were
  rewritten as template literals. `server/src/console-format-placeholder.guard.test.ts`
  fails the build on any `console` call whose first argument has a placeholder.
- **Re-raised `js/tainted-format-string` alerts (dismiss after merge)** — commit
  `ebac5b35` (Aug 18) had fixed these by turning template literals into `%s`
  placeholders; #3721 reverts that at 10 sites, so the first weekly scan on
  `main` re-opens them: #76 (`routes/queue.ts`), #77 (`routes/voice-style.ts`),
  #172 (`routes/export.ts`), #210, #213, #224 (`routes/voice-library.ts`, revoke
  and delete) and #211, #214, #215, #216, #217
  (`workspace/purge-clone-artifacts.ts`). Same reason as #233/#236: the boot-time
  timestamp patch makes the timestamp Node's format argument, so the template
  literal is never format-interpreted, while a `%s` there printed literally
  (pinned by `logger.test.ts` and the new guard).

| alert | rule | justification |
|---|---|---|
| #227–#231, `server/tts-sidecar/main.py` | py/stack-trace-exposure | `str(exc)` of a curated sidecar exception; fixed template plus curated values; `exc-text-safe` marker |
| #232, `scripts/tests/stamp-publish-token.test.mjs:36` | js/incomplete-multi-character-sanitization | test asserting HTML-comment stripping hides a token; used in tests |
| #234, `scripts/tests/npm-check-onbox-register-routing.test.mjs:53` | js/incomplete-sanitization | test-only `quoteArg` over hardcoded arguments; used in tests |
| #235, `server/src/analyzer/catalog/gemini-catalog.ts:100` | js/insufficient-password-hash | SHA-256 of an API key as an in-memory cache key, not password storage; false positive |
| #233 `routes/book-state.ts:606`, #236 `routes/revisions.ts:271` | js/tainted-format-string | boot-time timestamp patch makes the timestamp the format argument, so the template-literal first argument is never format-interpreted; pinned by `logger.test.ts`; dismiss after merge |
| #76, #77, #172, #210, #211, #213, #214, #215, #216, #217, #224 (re-raised after merge: `queue.ts`, `voice-style.ts`, `export.ts`, `voice-library.ts`, `purge-clone-artifacts.ts`) | js/tainted-format-string | same patch argument as #233/#236; `%s` there printed literally; pinned by `logger.test.ts` and `console-format-placeholder.guard.test.ts`; dismiss after merge |

## Alerts #237–#253 — the 2026-11-24 dismissals (for dismissal)

Dismissed on **2026-11-24** (#237–#240, #243–#253; the GitHub API returns
their `dismissed_at` as 2026-11-23T19:32:40–19:33:27Z UTC). Alerts #241 and
#242 were not dismissed and are not part of this record. Every dismissal
comment ends by pointing back to this file; this section is that record.
Every file:line below was re-verified against this branch's head.

- **`js/path-injection` (#250–#253, `won't fix`)** — the four flagged sinks
  are the whole point of the `POST /sync-folder/test` handler
  (`server/src/routes/user-settings.ts:277`), the settings screen's
  writability probe for **the user's own chosen sync folder** (Zod-parsed
  `path` payload, `:280`): `lstat(parsed.path)` at `:295`,
  `writeFile(probePath, 'ok')` at `:304`, and the `unlink(probePath)`
  cleanups at `:305` (success path) and `:310` (failure path). LAN callers
  are fronted by `requireLanToken` (`app.use(['/api', '/workspace'],
  requireLanToken)`, `server/src/app.ts:151`), which 401s a non-loopback
  caller without the LAN token (`server/src/lan-auth.ts:216-234`); a token
  is auto-minted whenever LAN exposure is on (`server/src/index.ts:303-311`),
  so the gate is live in every exposed configuration. The probe is
  deliberately constrained: it requires an **existing directory** (`lstat`,
  never `mkdir` — the comment at `:289-292` records that a recursive `mkdir`
  here was an unauthenticated arbitrary-directory-creation primitive) and
  writes/unlinks only the fixed probe file
  `parsed.path/.audiobook-write-probe` (`:302`).
- **`js/weak-cryptographic-algorithm` (#246, `false positive`)** —
  `previewTag` (`server/src/routes/qwen-voice.ts:1530-1532`) sha1-hashes
  `${bookId}|${characterId}` into a 10-hex-character tag. The tag is an
  identity fragment of preview voice ids (`<realVoiceId>-preview-<tag>`,
  `:1533-1535`) so a staged A/B preview belongs to exactly one cast row and
  a decline can drop exactly the moved rows' previews (#3992/#4028, comment
  at `:1525-1529`); no confidentiality or integrity property depends on it,
  and changing the hash now would orphan every staged preview — the tag is
  baked into staged ids and matched back by `isOwnStalePreview`
  (`:1536-1546`).
- **`js/incomplete-sanitization` (#247, `false positive`)** — the
  `VARIANT_FILE` pattern (`server/src/routes/qwen-voice.ts:1807-1809`)
  interpolates two compile-time constant lists into its RegExp source —
  `VARIANT_EMOTIONS` (`:131`, the fixed emotion set minus `neutral`) and
  `VARIANT_MEMBERS` (`:546`, `['.pt', '.json', '__master.wav', '__1.7b.pt']`)
  — and escapes the latter's dots before use
  (`s.replace(/\./g, '\\.')`, `:1808`); neither a backslash nor untrusted
  input can reach the regex source.
- **`js/loop-bound-injection` (#243, #244, `false positive`)** — the two
  `deterministicGradient` copies (`server/src/routes/import.ts:61-75`,
  `server/src/workspace/scan.ts:684-698`) hash a string: the flagged loop
  (`import.ts:63` / `scan.ts:686`) runs over the seed string's **own
  length** (`for (let i = 0; i < seed.length; i++) h = ((h << 5) - h +
  seed.charCodeAt(i)) | 0`), so there is no array-like whose bound a taint
  could stretch; and the seed is server-minted, never request-controlled —
  in `import.ts` the gradient is `deterministicGradient(bookId)` (`:462`)
  with `bookId` from `mintBookId(author, series, title)` (`:434`), and in
  `scan.ts` (`:753`) it is the scanned book's `bookId`
  (`state?.bookId ?? makeBookId(...)`, `:752`).
- **`js/tainted-format-string` (#237–#240, #245, #248, #249, `false
  positive`)** — seven `console` calls whose **first argument is a template
  literal** over request-derived ids, all under `server/src/routes/`:
  `export.ts:696` (sendFile failed), `export.ts:844` (could not restore
  the previous export), `export.ts:877` (could not remove the superseded
  export), `voice-style.ts:211` (per-character persona failure),
  `voice-library.ts:2228` (revoke artifacts un-erased),
  `voice-library.ts:2339` (delete artifacts un-erased), `queue.ts:149`
  (engine-stamp failed). Same patch argument as #233/#236:
  `installTimestamps()` (`server/src/logger.ts:38`, installed at boot in
  `server/src/index.ts:21`) always passes the timestamp as Node's format
  argument, so a caller's own first argument is never interpreted as a
  format string (the comment at `export.ts:691-694` states this argument at
  the first site), while a `%s` there would print literally; pinned by
  `server/src/logger.test.ts` and
  `server/src/console-format-placeholder.guard.test.ts`.

| alert | rule | justification |
|---|---|---|
| #250 `user-settings.ts:295` (`lstat`), #251 `:304` (`writeFile`), #252 `:305`, #253 `:310` (`unlink`, the two cleanup paths) — `server/src/routes/`, `POST /sync-folder/test` | js/path-injection | probes the user's own chosen sync folder, by design; LAN callers gated by `requireLanToken` (`server/src/app.ts:151`); needs an existing directory (`lstat`, no `mkdir`); writes/unlinks only the fixed `.audiobook-write-probe` probe file; won't fix |
| #246, `server/src/routes/qwen-voice.ts:1531` (`previewTag`) | js/weak-cryptographic-algorithm | 10-char sha1 tag of `bookId`\|`characterId`, a non-security identity fragment of preview voice ids; no confidentiality/integrity property depends on it; changing it would orphan staged previews |
| #247, `server/src/routes/qwen-voice.ts:1808` (`VARIANT_FILE`) | js/incomplete-sanitization | escapes constant literals only (`VARIANT_EMOTIONS` `:131`, `VARIANT_MEMBERS` `:546`); no backslash or untrusted input reaches the regex source |
| #243 `server/src/routes/import.ts:63`, #244 `server/src/workspace/scan.ts:686` (`deterministicGradient`) | js/loop-bound-injection | loop runs over the seed string's own length; the seed is the server-minted `bookId` (`mintBookId`, `import.ts:434`) / the scanned book's `bookId` (`scan.ts:752`), not a user-controlled array-like |
| #237 `export.ts:696`, #248 `export.ts:844`, #249 `export.ts:877`, #238 `voice-style.ts:211`, #239 `voice-library.ts:2228`, #240 `voice-library.ts:2339`, #245 `queue.ts:149` (all `server/src/routes/`) | js/tainted-format-string | same patch argument as #233/#236; the boot-time timestamp patch makes the timestamp the format argument, so the template-literal first argument is never format-interpreted and a `%s` there printed literally; pinned by `logger.test.ts` and `console-format-placeholder.guard.test.ts` |
