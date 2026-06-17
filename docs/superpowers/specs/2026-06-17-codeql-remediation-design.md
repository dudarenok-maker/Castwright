# CodeQL alert remediation — design spec

**Date:** 2026-06-17
**Branch:** `fix/security-codeql-remediation`
**Status:** draft
**Disposition chosen:** Maximal / defense-in-depth (drive open alerts to ~0 + real
hardening of the genuine LAN-exposed surface)

> **Revised twice after two adversarial-review passes** (six reviews total:
> CodeQL-efficacy ×2, correctness/regression ×2, threat-model, spec-consistency).
> Pass 1 overturned the v1 "harden central `paths.ts` builders" strategy. Pass 2
> corrected the cross-function-boundary repeat in the handoff sinks, the
> Unicode-id regression, the `bookDirByDisplay` chokepoint, the rate-limit "route
> marker" fiction, the non-retroactive `paths-ignore`, and the cert leaf-vs-CA bug,
> and pinned the previously-prose-only decisions (cap number, `safeSegment`
> predicate, dismissal sequencing). This is the consolidated result.

## Problem

GitHub code-scanning (CodeQL, `.github/workflows/codeql.yml`, weekly cron) reports
**146 open alerts** on `main`. CodeQL has no model of the app's design — a
single-user, local-first tool with **no auth by design** that **binds loopback
(`127.0.0.1`) by default** since `srv-19` shipped (`server/src/bind-host.ts`), and
only binds all interfaces in the opt-in LAN HTTPS flow (`npm run start:lan`). So it
flags every route as un-rate-limited and every `join(root, userValue)` as
path-injection.

The **maximal** disposition: write real defensive code (so the mitigations harden
the LAN-exposed surface, not merely silence the scanner), drive the dashboard to ~0
open, and use dismiss-with-justification only where a *correct* mitigation exists
that CodeQL structurally cannot recognize.

### Threat-model correction (carry into every justification)

`docs/security/2026-05-31-security-review.md` finding **#1 is now stale**: it says
the default HTTP dev mode "also binds every interface." Since `srv-19`
(`bind-host.ts`) the default is **loopback-only**; all-interface bind requires
`start:lan` or an explicit `BIND_HOST=0.0.0.0`. **This spec updates that doc** (in
Scope D).

A **rate limiter is anti-DoS + scanner-clearing only — NOT a control for the
unauthenticated destructive endpoints on a hostile LAN.** A LAN peer can, within
any limit, trigger one Gemini analysis (burns quota/$) or hit a write sink. The only
real LAN control is auth (`srv-20`, out of scope). Path-containment **does** close
the write/read traversal primitives below, on loopback and LAN alike.

## How CodeQL recognizes a fix (the load-bearing constraint)

CodeQL JS/TS barriers are **in-CFG branching guards that dominate the sink in the
same function** — not value transforms returned across a function boundary. A helper
that throws on bad input and **returns the resolved/derived string** does **not**
sanitize that string at a caller's sink: the taint rides through `path.resolve`/`join`
into the caller's `fs.*` call, still tainted. Therefore:

- **The containment assertion must appear at (or dominating) each sink, in the
  sink's own function.** The recognized pattern (verified against CodeQL's
  `RelativePathStartsWithSanitizer` in `TaintedPathCustomizations.qll`):
  ```ts
  const resolved = path.resolve(ROOT, seg);
  const rel = path.relative(ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { /* throw 400 */ }
  // fs call on `resolved` here, same function, dominated by the guard
  ```
  Use the **raw** `path.relative(...)` return in the `startsWith('..')` test — do
  not pre-normalize/coerce it or you fall off the modeled sanitizer shape. Do not
  refactor the guard into a helper that returns a boolean across a function boundary
  (breaks the in-CFG-dominator requirement).
- `safeJoin`/`assertContained` (below) is the **single tested implementation** of
  that guard, **invoked at the sink site**, never buried in a deep builder. Where a
  builder returns a path that a *different* function sinks, the guard belongs in
  that other function.

This constraint also means the 4 `xss-through-dom` img wrappers, the 2
`cover.test.ts` alerts, and (if mkcert is absent) the cert probe **will not
auto-clear** — those are explicit dismissals (Scope D).

## Alert inventory (146 open) + disposition

| Rule | Count | Disposition |
|---|---|---|
| `js/path-injection` | 68 | **Per-sink inline containment** at each `fs` sink's own function. Display builder sanitized *inside the builder*. Escalate import-write + samples + analyzer-write sinks. Bounded composed-path dismissal set. |
| `js/missing-rate-limiting` | 42 | Global `express-rate-limit` dominating **all** routers; **high cap, no `skip`** (an open SSE stream is 1 hit). |
| `py/stack-trace-exposure` | 14 | Helper returning a payload with **zero** references to the exception. |
| `js/xss-through-dom` | 4 | **Dismiss all 4** (provenance-safe + wrapper not CodeQL-recognized). Wrap the unflagged remote `:453` for real. |
| `js/polynomial-redos` | 4 | **Linearize the regex**; dismiss-fallback for `FILENAME_RE` if no parse-preserving rewrite. |
| `js/loop-bound-injection` | 3 | Clamp the 2 short-hash loops; **dismiss** the manuscript-scan loop (clamping truncates content). |
| `js/tainted-format-string` | 2 | `%s` placeholders. |
| `js/incomplete-url-substring-sanitization` | 2 | **Dismiss** (test file; `paths-ignore` is not retroactive — see Scope D). |
| `js/incomplete-multi-character-sanitization` | 2 | **Replace-until-stable** (not just `/g`). |
| `js/insecure-randomness` | 1 | `crypto.getRandomValues`; fallback must not use `Math.random`. |
| `js/incomplete-sanitization` | 1 | Replace-until-stable. |
| `js/double-escaping` | 1 | Decode `&` **last**; regression test. |
| `js/resource-exhaustion` | 1 | Cap the streaming accumulator (`buf.length`) in-loop. |
| `js/disabling-certificate-validation` | 1 | Probe with the mkcert **rootCA** (real validation); plain-HTTP loopback fallback; dismiss only if mkcert absent. |

`srv-22` (below, §A4) is folded in as **scope expansion** — it is **not** one of the
146 CodeQL alerts; its closure is verified by its paired test, not the dashboard.

## Architecture

**Three parallel code scopes** (A server / B sidecar / C frontend) for worktree
subagents, **plus a sequential Scope D** (CodeQL config + manual dismissals +
threat-model-doc update + verification ordering) owned by the integrator, run
**last** on the reconciled `integration/<date>` branch.

### Scope A — Server (Node/TS)

**A1. Path containment (`js/path-injection`, 68) — per-sink.**

New `server/src/util/safe-path.ts`:
- `safeSegment(seg: string): string` — **deny-list**, returns `seg` unless it is
  `''`, `.`, or `..`; contains a path separator (`/`, `\`) or NUL; or is absolute /
  drive-prefixed (`/^[A-Za-z]:/` or a leading `/`\\`). **Allows any Unicode
  letter/number** (`\p{L}\p{N}`), `-`, single `_` and `__`, and `.` mid-name — so
  plan-219 Cyrillic ids (`война__standalones__война`, `qwen-война__angry-preview`),
  nanoid manuscriptIds (`mns_aB3_xY`), and emotion-suffixed voice names survive.
  **Do NOT use an ASCII allowlist** (`^[A-Za-z0-9._-]+$`) — it 400s every
  non-Latin-script book/voice (a plan-219 regression the ASCII-only test set would
  miss). `safeSegment` is a cheap pre-filter; the load-bearing guard is:
- `assertContained(root, resolved)` — throws if `path.relative(resolve(root),
  resolved)` starts with `..` or is absolute.
- `safeJoin(root, ...segments)` — `resolve(root, ...segments.map(safeSegment))` then
  `assertContained`; returns the resolved path. **Used at the sink, in the sink's
  function.**

Per-site application (each guard lives in the function holding the `fs` call):
- `routes/samples.ts:51` — `join(SAMPLES_ROOT, slug)`, `slug` raw from URL with **no
  findBook gate**; guard `slug` AND the bundle-supplied `manuscriptFile` before
  `copyFile`. **Escalated: un-gated traversal.**
- `analyzer/ollama.ts:353,406` and `analyzer/gemini.ts` (`rawAttemptPath(...)`) — the
  **actual `writeFile` sinks** for the handoff paths. `manuscriptId` ← `req.params.id`
  (`analysis.ts:1908,4120,4159`). Guard with `safeSegment(manuscriptId)` /
  `assertContained` **in these functions** — *not* only in `handoff/protocol.ts`'s
  pure builders (that would repeat the cross-boundary mistake). Also guard inside
  `protocol.ts`'s own `writeInbox` before its `writeFile` (`protocol.ts:68`).
- `store/analysis-cache.ts` — `join(CACHE_DIR, '${manuscriptId}.json')` + `rm`/
  `writeJsonAtomic`; guard `manuscriptId` here.
- `routes/qwen-voice.ts` / `paths.ts` `qwenVoicePtPath`/`qwenVoiceSidecarPath` —
  `name = qwen-${character.voiceId ?? characterId}` (source `cast.json`, so the
  sidecar's `..`-block doesn't protect the Node builder); guard the name segment.
- `routes/book-state.ts:1001` — `unlink(join(bookDir, oldFile))`, `oldFile =
  state.manuscriptFile` (server-derived but persisted/attacker-influenceable via a
  sample bundle); guard `oldFile` or dismiss with the server-derived justification.
- `parsers/epub.ts:61` — `join(tmp, opts.fileName ?? 'book.epub')`, `opts.fileName ←
  req.file.originalname` (upload filename). **Basename + `safeSegment`** before the
  `writeFile` (an upload filename must never contribute separators).

**Display-string builder → SANITIZE _inside the builder_ (chokepoint).**
`paths.ts` `bookDirByDisplay(author, series, title)` joins raw display strings
verbatim — and `import.ts` (`POST /api/books`) feeds it body strings with only
`.trim()`, then `mkdir` + `writeFile(originalBuffer)`: **the sharpest sink, an
unauthenticated arbitrary-file WRITE primitive.** `safeSegment` is wrong here (a
legit title contains `/`: "Either/Or", "AC/DC"). Sanitize each field:
replace `[/\\:*?"<>|]` + control chars, collapse any `..` run, trim trailing dots/
spaces (Windows), cap length; an empty result → a stable placeholder (`_`), never a
dropped path level; then `assertContained(BOOKS_ROOT, resolved)`. **The sanitizer
must live inside `bookDirByDisplay`** — `scan.ts:403`, `samples.ts:59`, and
`findBookBy…` also call it; sanitizing only at the import site would make those
recompute the *raw* name and silently un-find books. Accept (and document) that two
display strings can now collide to one folder (handled by import's existing
`existsSync` 409). Confirm `findBookByBookId` still keys on the persisted
`state.bookId` so analysed books round-trip; note orphan (no-`state.json`) books
derive their bookId from the sanitized folder name. Ship a `bookDirByDisplay('..\\
evil', …)` test.

**Composed-path sinks (no segment to check)** — `workspace/state-io.ts` (appends
`.tmp-…`/`.bak.N`), `workspace/atomic-rename.ts` (`rename` on pre-built paths),
`cover/store.ts` (`downloadCover(url, destPath)`): add `assertContained(WORKSPACE_
ROOT, path)` at the **route call-boundary** that composes the path where reachable
in one function; otherwise **dismiss** (bounded set, justification = composed from
already-contained/slugged inputs). Correct the over-credit: `voiceSampleFilePath` is
traversal-safe **because the filename always carries a `-<modelKey>-<hash>.mp3`
suffix** (so it can never equal `.`/`..`), *not* solely because `asciiFileScope`
flattens separators (that allowlist passes `.` through); `auto-backup` is gated by
`findBookByBookId` + `STAMP_RE`. These were never exploitable — don't claim them as
closed vulns.

**A2. Rate limiting (`js/missing-rate-limiting`, 42).**
- Add `express-rate-limit` (v7 — confirmed Express-5.2.1 compatible).
- New `server/src/middleware/rate-limit.ts`: `windowMs: 60_000`, `max: 1000` per IP,
  `standardHeaders: true`, `legacyHeaders: false`. **No `skip`** — an open SSE
  stream is a single hit against a count window, and 1000/min sits far above the
  app's worst legitimate burst (1.5 s install polls, 4 s stats, gpu/queue/health
  pills, `revisions` fan-out). Verify the revisions bulk fan-out stays under the cap;
  raise the number if a real workflow trips it. *(The earlier "exempt the 7 SSE
  routes via a route marker" plan is dropped: the SSE `Content-Type` header is set
  inside the handler, after the global limiter runs, so no `skip` callback can see
  it, and no marker infra exists — and it's unnecessary.)*
- Mount `app.use(apiLimiter)` in `server/src/index.ts` **before every router
  registration / sub-router mount** (CodeQL credits a route only when its install
  site is dominated by the limiter node). Verify no router is populated before this
  line.
- Test (`rate-limit.test.ts`): 429 past the cap; a steady-cadence poller and a
  representative SSE subscribe are not throttled under the cap.

**A3. Per-site server fixes.**
1. `js/tainted-format-string` (`routes/queue.ts:125`, `routes/voice-style.ts:119`)
   → tainted value as a `%s` arg. **Test:** unit assert the log call receives the
   value as an arg, not interpolated.
2. `js/loop-bound-injection` — clamp **only** `tts/voice-mapping.ts:459` and
   `tts/voice-sample-cache.ts:84` (djb2 over short ids; the clamp must reach the loop
   condition). **Dismiss** `parsers/audio-tags.ts:58` — that `while (i < text.length)`
   scans the whole chapter; clamping truncates the manuscript.
3. `js/polynomial-redos` (`parsers/text.ts:169,196`, `tts/voice-sample-cache.ts:57`,
   `util/text-match.ts:7`) → **linearize the automaton** (input-capping does NOT
   clear — the query flags regex *shape*). `FILENAME_RE`/`SERIES_FROM_TITLE_RE` have
   adjacent lazy `.+?` groups; **pair with parser-fixture regression tests**. For
   `text-match.ts` cap the **candidate quote**, never the source. **Fallback:** if no
   linear rewrite preserves `FILENAME_RE` parse-identity, **dismiss** it
   (filename-stem input, server-side, not attacker-streamed) rather than ship a
   parse-changing regex.
4. `js/incomplete-multi-character-sanitization` (`parsers/epub.ts:356`,
   `parsers/html-utils.ts:37`) + `js/incomplete-sanitization`
   (`scripts/bump-version.mjs:204`) → **replace-until-stable** (loop until no change).
5. `js/double-escaping` (`parsers/epub.ts:487`) → in `decodeEntities`, decode `&amp;`
   **last**. **Regression test** on `&amp;amp;lt;`-style sequences (feeds TTS prose).
6. `js/resource-exhaustion` (`analyzer/gemini.ts:559`, the `buf += text` SSE
   accumulator at `:524`) → cap `buf.length` **inside the loop, before the next
   `+=`** (an in-CFG guard; the `resolveMaxOutputTokens` runtime cap is NOT
   CodeQL-visible). **Test:** accumulator throws/truncates past the ceiling.
7. `js/incomplete-url-substring-sanitization` (`routes/cover.test.ts:103,106`) — **no
   code fix needed**; these are dismissed (Scope D), since `paths-ignore` only
   prevents *future* test-file alerts and doesn't retroactively clear these two.
8. `js/disabling-certificate-validation` (`scripts/start-app-prod.mjs:118`) — replace
   the process-global `NODE_TLS_REJECT_UNAUTHORIZED='0'` flip + `fetch()` with a
   `node:https` probe using `Agent({ ca: readFileSync(resolveRootCaPath().path),
   servername: 'localhost', rejectUnauthorized: true })`. Pass the mkcert **rootCA**
   (via the existing `resolveRootCaPath()` in `routes/cert-root.ts`) — **NOT** the
   leaf `lan-cert.pem` (a leaf as `ca` throws `UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
   `localhost` is in the cert SAN (`setup-lan-certs.mjs:121`) so validation passes.
   If `resolveRootCaPath()` returns null (mkcert absent), fall back to a **plain-HTTP
   loopback** health probe — never re-disable TLS. **Not unit-testable** (prod-start
   script probing localhost); verified by the post-merge re-scan + a manual
   `start:lan` smoke. No `rejectUnauthorized:false` anywhere (itself a flagged sink).

**A4. `srv-22` — `sync-folder/test` arbitrary-path write (scope expansion).** Folded
in: same unauthenticated arbitrary-path FS class as the import write-primitive, so
fixing one and not the other is inconsistent. `POST
/api/user/settings/sync-folder/test` (`routes/user-settings.ts:129-153`) takes `path`
(`z.string().min(1).max(2000)` only) then `mkdir(path,{recursive:true})` +
`writeFile(join(path,'.audiobook-write-probe'),'ok')` + `unlink` — an
**arbitrary-directory-creation + fixed-name limited-clobber** primitive.
- The path is arbitrary **by design** (it probes an *external* sync folder outside
  `WORKSPACE_ROOT`), so §A1 containment is wrong. Fix: **`lstat` the path first**;
  if it is not an existing directory (or is a symlink), return `{ok:false,
  code:'ENOENT'}` and **create nothing** — probe writability only of a real existing
  dir. `lstat` (not `stat`) so a symlink at an existing path can't redirect the probe
  outside. This **preserves plan-79 intent** ("is the path the user typed writable" →
  a bogus/non-existent path is `ok:false`; the old `mkdir(recursive)` was incidental,
  even noted as a test quirk in plan 79).
- Residual (own it honestly): in **any existing directory the server process can
  write** (incl. the user's own sync folder), a LAN peer can create-then-delete a
  fixed-name zero-information `.audiobook-write-probe`. Small; the real control is
  auth (`srv-20`), not the limiter. *(If rejecting symlinks breaks a legitimate
  Windows Drive junction, accept the symlink-redirect residual instead and document
  it — decide at implementation against a real Drive path.)*
- **Test:** non-existent/symlinked path → `{ok:false,code:'ENOENT'}` and **no
  `mkdir`**; existing temp dir → `{ok:true}`, no probe file left behind. Closes
  `srv-22` + its issue on merge; update plan 79's doc for the behavior change.

### Scope B — Sidecar (Python), `py/stack-trace-exposure` (14)

`server/tts-sidecar/main.py` returns `str(e)` / traceback to the client at 14 sites.
Add `error_response(e, log, status=500)` that `log.exception(...)` server-side and
returns a **generic constant** body — **hard rule: the returned payload references
the exception object zero times** (no `str(e)`, `type(e).__name__`, `e.args`); any
reference keeps the taint flow and the alert stays open. Route all 14 through it; grep
to confirm no inline `str(e)` remains in a response. (Logging `e` does NOT keep the
alert alive.) **Test:** a pytest asserting a sample of error responses carry the
generic message and contain no traceback / `str(e)` substring.

### Scope C — Frontend (`src/`), `xss-through-dom` (4) + `insecure-randomness` (1)

- The 4 flagged `<img>` sites are safe by **server-controlled provenance**:
  `listen-header.tsx:90`, `library-table.tsx:303`, `library-grid.tsx:207` bind
  `book.coverImageUrl` = `/api/books/:id/cover` (`scan.ts`); `cover-picker.tsx:603`
  binds `liveCoverUrl` (server path / `currentCoverUrl`). The value-return
  `safeImageSrc` wrapper is **not CodeQL-recognized** → **dismiss all 4** (Scope D).
- New `src/lib/safe-url.ts`: `safeImageSrc(url)` allowlist = `http:`, `https:`, and
  same-origin **relative** paths; **exclude `data:`/`blob:`** (no cover path produces
  them). Returns `''` otherwise.
- **Wrap `cover-picker.tsx:453`** (`src={c.coverUrl}`, search-candidate grid) — the
  genuinely remote-URL-bound `<img>` (`apple.ts:41` echoes the iTunes URL
  unsanitized); CodeQL didn't flag it but it's where the guard does real work. Wrap
  the 4 flagged sites too (correct, though it won't clear their alerts).
- `js/insecure-randomness` (`mini-player.tsx:99`) — `Math.random` fallback session id
  → `crypto.getRandomValues`; the final fallback (only if `crypto` absent) must not
  call `Math.random`. *(Non-security regardless: the server trusts the client
  `sessionId` verbatim; stats are per-`(date,sessionId)`, monotonic, capped — RNG
  quality buys an attacker nothing. Cosmetic; document.)*
- **Test (`src/lib/safe-url.test.ts`):** passes http/https/relative, strips
  `javascript:`/`data:`/`blob:`; session id uses crypto, never `Math.random`.

### Scope D — Integration, CodeQL config & dismissals (sequential, single owner, runs last)

Owned by the integrator on the reconciled branch; not a parallel agent task.
1. **CodeQL config:** add `.github/codeql/codeql-config.yml` with `paths-ignore:
   ['**/*.test.ts', '**/*.test.tsx', 'e2e/**']`, **and add `config-file:
   ./.github/codeql/codeql-config.yml` to the `init` step** in
   `.github/workflows/codeql.yml` (it has no config reference today — without this
   the ignore is inert). This **prevents future test-file noise**; it does **not**
   retroactively clear the 2 existing `cover.test.ts` alerts (paths-ignore is not
   retroactive — `codeql-action#1857`), which are dismissed below.
2. **Threat-model doc:** update `docs/security/2026-05-31-security-review.md` —
   correct the stale #1 framing (default is loopback) and record this remediation
   pass.
3. **Manual dismissals — run AFTER the post-merge re-scan** (alert numbers only exist
   once the scan surfaces them), via `gh api .../code-scanning/alerts/<n> -X PATCH -f
   state=dismissed -f dismissed_reason="won't fix" -f dismissed_comment="<file:line +
   reason + threat-model ref>"`. See the bounded budget below.

## Dismissal budget (explicit)

No blanket dismissals. Expected set (dismissed post-scan, by alert number):
- **4 × `xss-through-dom`** img sites — server-controlled provenance; `<img src>` not
  a script sink; wrapper not CodeQL-recognized.
- **2 × `incomplete-url-substring-sanitization`** (`cover.test.ts`) — test file;
  excluded from future scans by Scope D but not retroactively cleared.
- **1 × `loop-bound-injection`** (`audio-tags.ts:58`) — legitimate O(n) manuscript
  scan; clamping would truncate content.
- **`js/path-injection` composed-path residue — bounded ≤ ~6** (the `state-io` /
  `atomic-rename` / `cover/store` sinks that cannot host an in-function call-boundary
  guard); justification = composed from already-contained/slugged inputs. The
  implementer records the exact list during A1.
- **0–1 × `polynomial-redos`** (`FILENAME_RE`) — only if no parse-preserving linear
  rewrite exists.
- **0–1 × `disabling-certificate-validation`** — only if mkcert is absent and the
  plain-HTTP fallback path itself is unavailable.

Everything else is a code fix expected to auto-clear on re-scan.

## Testing (required per project discipline)

- **A1:** `server/src/util/safe-path.test.ts` — `safeSegment` rejects `..`, `/`, `\`,
  NUL, absolute, drive-prefix; **accepts** `\p{L}\p{N}` (`война__standalones__война`,
  `qwen-война__angry-preview`), single `_` (`mns_aB3_xY`), `__`, `-`, `.` mid-name;
  `assertContained`/`safeJoin` reject escaping, accept contained. Escalated-sink
  regressions: `bookDirByDisplay('..\\evil', …)` sanitized; `POST /api/samples/..%2f
  ../load` → 400; analyzer-write guard rejects a `..` manuscriptId; `epub` upload
  filename `../../x` basenamed.
- **A2:** `rate-limit.test.ts` — 429 past cap; poller + SSE subscribe under cap not
  throttled.
- **A3:** named tests per fixed site — `%s` format (1); redos linear **and** parser
  output unchanged on fixtures (3, with `FILENAME_RE` dismiss-fallback noted);
  sanitizer idempotent / replace-until-stable (4); `decodeEntities` order (5);
  `buf.length` accumulator cap (6); loop clamps reach the condition (2);
  `audio-tags` untouched. Cert (8) is **not unit-testable** — verified by re-scan +
  manual `start:lan` smoke (stated explicitly per the "say so" rule).
- **A4 (`srv-22`):** route test as above.
- **B / C:** as in their scopes.
- `npm run verify` (typecheck + all tests + e2e + build) green before merge.

## Verification (explicit ordering)

"~0 in one cycle" is impossible — dismissals need alert numbers that only exist
post-scan. The order is **merge → scan → dismiss → confirm**:
1. `npm run verify` green on the integration branch (incl. the Scope D config change).
2. Merge to `main`.
3. `gh workflow run codeql.yml --ref main`. Code-fix alerts auto-clear on this scan;
   the dismissal-budget alerts reappear **open** (they have no code fix).
4. PATCH-dismiss each dismissal-budget alert by its new number (Scope D).
5. Confirm Security → Code scanning shows **0 open**, N dismissed (the documented
   set). `srv-22` is not a CodeQL alert — its closure is verified by the §A4 test,
   not the dashboard.

## Out of scope

- **Authentication** (`fe-11`, `srv-10`, `srv-9`) — single-user by design; the only
  real LAN control, deliberately parked.
- **`srv-21` (SSRF via `sidecarUrl`)** — not CodeQL-flagged, a different shape (host
  allowlist on an outbound fetch, not a filesystem sink). Separate follow-up.
  (`srv-22` is **in** scope — §A4.)
- `side-12/13`, `ops-7` (sidecar pickle / download checksums) — separate backlog.
