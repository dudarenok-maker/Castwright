# CodeQL alert remediation — design spec

**Date:** 2026-06-17
**Branch:** `fix/security-codeql-remediation`
**Status:** draft
**Disposition chosen:** Maximal / defense-in-depth (drive open alerts to ~0 + real
hardening of the genuine LAN-exposed surface)

> **Revised 2026-06-17 after three adversarial reviews** (CodeQL-efficacy,
> correctness/regression, threat-model). The v1 "harden the central `paths.ts`
> builders and the barrier propagates" strategy was **wrong** about how CodeQL
> recognizes a sanitizer — see §A1. This revision reflects the corrected approach,
> the escalated sinks, the regression traps, and an explicit dismissal budget.

## Problem

GitHub code-scanning (CodeQL, `.github/workflows/codeql.yml`, weekly cron) reports
**146 open alerts** on `main`. CodeQL has no model of the app's design — a
single-user, local-first tool with **no auth by design** that **binds loopback
(`127.0.0.1`) by default** since `srv-19` shipped (`server/src/bind-host.ts`), and
only binds all interfaces in the opt-in LAN HTTPS flow (`npm run start:lan`). So it
flags every route as un-rate-limited and every `join(root, userValue)` as
path-injection.

The user chose the **maximal** disposition: write real defensive code (so the
mitigations harden the LAN-exposed surface, not merely silence the scanner), drive
the dashboard to ~0 open, and use dismiss-with-justification only where a *correct*
mitigation exists that CodeQL structurally cannot recognize.

### Threat-model correction (carry into every justification)

The standing review doc `docs/security/2026-05-31-security-review.md` finding **#1
is now stale**: it says the default HTTP dev mode "also binds every interface."
Since `srv-19` (`bind-host.ts`) the default is **loopback-only**; all-interface
bind requires `start:lan` or an explicit `BIND_HOST=0.0.0.0`. **This spec updates
that doc** as part of the work.

Consequence for framing: a **rate limiter is anti-DoS + scanner-clearing only — it
is NOT a control for the unauthenticated destructive endpoints on a hostile LAN.**
A LAN peer can, within any limit, trigger one Gemini analysis (burns quota/$),
mutate cast/settings, or hit a write sink. The only real LAN control is auth
(`srv-20`, explicitly out of scope). The spec must not imply rate-limiting
"handles" LAN exposure. Path-containment **does** genuinely close the write/read
traversal primitives below, on loopback and LAN alike.

## How CodeQL recognizes a fix (the load-bearing constraint)

CodeQL JS/TS barriers are **in-CFG branching guards that dominate the sink in the
same function** — not value transforms returned across a function boundary. A
helper that throws on bad input and **returns the resolved/derived string** does
**not** sanitize that string at a caller's sink: the taint label rides through
`path.resolve`/`join` into the caller's `fs.*` call, still tainted. Therefore:

- **Path containment must appear at (or dominating) each sink, in the sink's own
  function.** The recognized pattern is:
  ```ts
  const resolved = path.resolve(ROOT, seg);
  if (path.relative(ROOT, resolved).startsWith('..')) { /* throw 400 */ }
  // ... fs call on `resolved` here, same function, dominated by the guard
  ```
- A shared **`safeJoin` is still worth having** (DRY, one tested implementation),
  but it must be written as an *assert-and-return* used **immediately before the
  sink in the same function** so the guard co-locates with the sink — not buried
  inside a deep builder several calls away. Where a builder returns a path that a
  *different* function then sinks, the guard belongs in that other function.

This single correction reshapes the path-injection plan (§A1) and means the 4
`xss-through-dom` img wrappers and the cert-validation undici approach **will not
auto-clear** (§C, §A3.8) — those are dismissals or a different fix from the start.

## Alert inventory (146 open) + disposition

| Rule | Count | Disposition (revised) |
|---|---|---|
| `js/path-injection` | 68 | **Per-sink inline containment** (not central-helper). Display builders sanitized, not rejected. Escalate import-write + samples sinks. Some composed-path sinks dismissed. |
| `js/missing-rate-limiting` | 42 | Global `express-rate-limit` dominating **all** routers; runtime `skip` for SSE+pollers; pinned generous cap. |
| `py/stack-trace-exposure` | 14 | Helper returning a payload with **zero** references to the exception. |
| `js/xss-through-dom` | 4 | **Dismiss all 4** (provenance-safe + wrapper won't auto-clear). Also wrap the unflagged remote `:453` for real. |
| `js/polynomial-redos` | 4 | **Linearize the regex** (input-capping does NOT clear). |
| `js/loop-bound-injection` | 3 | Clamp the 2 short-hash loops; **dismiss** the manuscript-scan loop (clamping truncates content). |
| `js/tainted-format-string` | 2 | `%s` placeholders. |
| `js/incomplete-url-substring-sanitization` | 2 | Exact-host check; also durably excluded by CodeQL test-file config. |
| `js/incomplete-multi-character-sanitization` | 2 | **Replace-until-stable** (not just `/g`). |
| `js/insecure-randomness` | 1 | `crypto.getRandomValues`; fallback must not use `Math.random`. |
| `js/incomplete-sanitization` | 1 | Replace-until-stable. |
| `js/double-escaping` | 1 | Decode `&` **last**; regression test. |
| `js/resource-exhaustion` | 1 | Cap the streaming accumulator. |
| `js/disabling-certificate-validation` | 1 | Trust the self-signed CA (real validation); **dismiss** if impractical. NOT an undici `rejectUnauthorized:false` swap (relocates the alert + new dep). |

## Architecture

Three **non-overlapping scopes** (server / sidecar / frontend) for parallel
worktree subagents, reconciled on one `integration/<date>` branch verified once.

### Scope A — Server (Node/TS), ~120 alerts

**A1. Path containment (`js/path-injection`, 68) — per-sink, not central.**

New `server/src/util/safe-path.ts`:
- `safeSegment(seg: string): string` — returns `seg` if it is a single safe path
  component; throws `PathContainmentError` if it contains a path separator
  (`/` or `\`), is exactly `.`/`..` or contains a `..` component, contains NUL, or
  is absolute / has a Windows drive prefix. **Must allow** `-`, `_`/`__`, `.` mid-name
  (designed-voice paths use `qwen-<id>__<emotion>-preview`; bookIds are `a__b__c`).
- `assertContained(root: string, resolved: string): void` — throws if
  `path.relative(path.resolve(root), resolved)` starts with `..` or is absolute.
- `safeJoin(root, ...segments)` — `path.resolve(root, ...segments.map(safeSegment))`
  then `assertContained`; returns the resolved path. **Used at the sink site**, in
  the sink's function (see the CodeQL constraint above).

Apply, per category:
- **Id-based builders / inline id joins → `safeSegment` the id at the sink.** The
  flagged sites whose path derives from a request-supplied id must guard in the
  function that holds the `fs` call. Notable per-site (NOT cleared by hardening
  `paths.ts` alone — verified by review):
  - `server/src/routes/samples.ts:51` — `join(SAMPLES_ROOT, slug)`, `slug` raw from
    URL with **no findBook gate**. Guard `slug` AND the bundle-supplied
    `manuscriptFile` before `copyFile`. **Escalated: real un-gated traversal.**
  - `server/src/store/analysis-cache.ts` — `join(CACHE_DIR, '${manuscriptId}.json')`
    inline (`manuscriptId` ← `req.params.id`).
  - `server/src/handoff/protocol.ts` — `inboxPath/outboxPath/errorPath/rawAttemptPath`
    each `join(INBOX|OUTBOX, '${manuscriptId}-stage…')` inline; these are the sinks
    behind writes in `analyzer/ollama.ts` and `analyzer/gemini.ts`.
  - `server/src/routes/qwen-voice.ts` (`qwenVoicePtPath`/`qwenVoiceSidecarPath` in
    `paths.ts`) — `name` = `qwen-${character.voiceId ?? characterId}`; source is
    `cast.json`, not a direct param, so the sidecar's own `..`-block doesn't protect
    the **Node** builder. Guard with `safeSegment`.
- **Display-string builder → SANITIZE, do NOT segment-reject.**
  `server/src/workspace/paths.ts` `bookDirByDisplay(author, series, title)` joins
  the **raw display strings verbatim** — and `import.ts` (`POST /api/books`) feeds
  it body strings with only `.trim()`, then `mkdir` + `writeFile(originalBuffer)`.
  **This is the sharpest sink in the codebase: an unauthenticated arbitrary-file
  WRITE primitive** (`author = "..\\..\\..\\Users\\…\\evil"`). But `safeSegment`
  here would 400 a *legitimate* title containing `/` ("Either/Or", "AC/DC"). Fix by
  **sanitizing** display names at the `import.ts` confirm site: replace
  `[/\\:*?"<>|]` and control chars, collapse `..`, trim to a max length — producing
  a safe single component — then assert containment under the books root. Ship a
  `bookDirByDisplay('..\\evil', …)` rejection/sanitization test. *(This also fixes a
  latent nested-folder bug, since `scan.ts` walks exactly 3 fixed levels.)*
- **Composed-path sinks that receive an already-built absolute path** —
  `server/src/workspace/state-io.ts` (appends `.tmp-…`/`.bak.N` to a passed `path`),
  `server/src/workspace/atomic-rename.ts` (`rename(src, dest)` on pre-built paths),
  `server/src/cover/store.ts` (`downloadCover(url, destPath)` on a pre-built
  `destPath`). There is **no segment to check** at these sinks. Options, in order:
  (1) add an `assertContained(WORKSPACE_ROOT, path)` at the **call boundary** that
  composes the path (the route), so the guard dominates the eventual sink in *that*
  function; (2) for sinks where (1) isn't reachable in one function, **dismiss** with
  a justification that the path is composed from already-contained/slugged inputs
  (e.g. `voiceSampleFilePath` flattens `/`,`\` to `_` via `asciiFileScope` — already
  traversal-safe; `auto-backup` gates on `findBookByBookId` + `STAMP_RE`).
- **Over-credit correction:** `voiceSampleFilePath` and the `auto-backup` helpers are
  **already effectively traversal-safe**; hardening them is harmless belt-and-suspenders
  but they were never exploitable — do not claim them as closed vulnerabilities.

Net: budget for **per-site guards at ~8 sink locations** plus the `bookDirByDisplay`
sanitizer, with a residual **dismissal set** for the composed-path sinks that cannot
host an in-function guard. The v1 "cleared centrally" framing is dropped.

**A2. Rate limiting (`js/missing-rate-limiting`, 42).**
- Add `express-rate-limit` (Express 5 compatible) as a server dependency.
- New `server/src/middleware/rate-limit.ts`: a limiter with a **pinned generous
  cap sized to the app's real poll cadence** — the frontend polls install status at
  1.5 s, stats at 4 s, plus gpu/queue/health/model-pull pills and `revisions`
  fan-out; a default 100/15-min would 429 the legitimate single user within
  seconds. Target on the order of **hundreds of requests/min** (document the cap
  math against the measured cadence in the module).
- Mount `app.use(apiLimiter)` in `server/src/index.ts` **before every router
  registration / sub-router mount**, so the limiter's routing node dominates all
  routes (CodeQL credits a route only when its install site is dominated by the
  limiter node). Any router populated before this line stays flagged — verify
  ordering.
- **Exempt via the runtime `skip` callback, never by mount-path** (excluding a route
  from the mount path removes the guarding node → alert stays open). `skip` must
  cover, enumerated:
  - the **7 SSE / long-poll route surfaces**: `routes/analysis.ts`,
    `routes/generation.ts`, `routes/cast-design.ts`, `routes/single-design.ts`,
    `routes/chapter-splice.ts`, `routes/chapter-qa-repair.ts`,
    `routes/annotate-emotion.ts` (several are POST-initiated subscribe paths under
    `/api/books/:bookId/…` — not identifiable by URL prefix; key `skip` off a route
    marker, not a path glob);
  - the **high-frequency pollers** the frontend hammers (or set the cap high enough
    that they never trip — document which).
- Test (`rate-limit.test.ts`): 429 past the cap; **each** of the 7 SSE routes is
  exempt; a representative poller is not throttled at steady cadence.

**A3. Per-site server fixes.**
1. `js/tainted-format-string` (`routes/queue.ts:125`, `routes/voice-style.ts:119`)
   → pass the tainted value as a `%s` arg.
2. `js/loop-bound-injection` — clamp **only** `tts/voice-mapping.ts:459` and
   `tts/voice-sample-cache.ts:84` (djb2 hashes over short ids; ensure the clamp
   reaches the loop condition, not a copy). **Do NOT clamp**
   `parsers/audio-tags.ts:58` — that `while (i < text.length)` scans the whole
   chapter; clamping silently **truncates the manuscript**. **Dismiss** it
   (legitimate O(n) over document length) or length-cap at the upload boundary where
   truncation is explicit — never inside the span scanner.
3. `js/polynomial-redos` (`parsers/text.ts:169,196`, `tts/voice-sample-cache.ts:57`,
   `util/text-match.ts:7`) → **linearize the regex automaton** (remove nested/overlapping
   quantifiers; anchor). Input length-capping does **not** clear these (the query
   flags regex *shape*). `text.ts` `FILENAME_RE`/`SERIES_FROM_TITLE_RE` drive
   author/series/title extraction — **pair with regression tests** on the existing
   parser fixtures so a rewrite can't change which names parse. For `text-match.ts`,
   cap the **candidate quote**, never the source (`matchQuoteInSource` correctness
   depends on full-source `includes`).
4. `js/incomplete-multi-character-sanitization` (`parsers/epub.ts:356`,
   `parsers/html-utils.ts:37`) + `js/incomplete-sanitization` (`scripts/bump-version.mjs:204`)
   → **replace-until-stable** (loop until no change), not a single `/g` pass —
   removing `..` from `....` leaves `..`.
5. `js/double-escaping` (`parsers/epub.ts:487`) → in `decodeEntities`, decode
   `&amp;` **last** (after `&lt;`/`&gt;`/…). Output-sensitive (feeds TTS prose) →
   **regression test** on `&amp;amp;lt;`-style sequences.
6. `js/resource-exhaustion` (`analyzer/gemini.ts`) → cap the **streaming
   accumulator** (`buf += chunk`) before the repair walkers, not the post-hoc repair.
   Low real exposure (response already token-capped via `resolveMaxOutputTokens`) —
   cheap correct bound.
7. `js/incomplete-url-substring-sanitization` (`routes/cover.test.ts:103,106`) →
   exact `new URL(x).host === expected` in the test mock (confirm the mock URLs don't
   carry the host only in a path/query). Also covered durably by §D.
8. `js/disabling-certificate-validation` (`scripts/start-app-prod.mjs:118`) → the
   process-global `NODE_TLS_REJECT_UNAUTHORIZED='0'` flip probes the script's **own**
   localhost self-signed health endpoint. **Trust the cert properly:** load the
   known self-signed cert and probe via `node:https` with an Agent configured with
   `ca: <cert>` (+ matching `servername`), so validation actually passes and the
   flagged sink disappears with **no** `rejectUnauthorized:false` anywhere. (An
   undici `Agent({connect:{rejectUnauthorized:false}})` is rejected as the fix:
   `rejectUnauthorized:false` is **itself** a CodeQL cert-validation sink — it
   relocates the alert — and `undici` is not a direct dependency.) If trusting the
   CA is impractical in the prod-start flow, **dismiss** with the localhost-own-cert
   justification.

### Scope B — Sidecar (Python), `py/stack-trace-exposure` (14)

`server/tts-sidecar/main.py` returns `str(e)` / traceback text to the client at 14
sites. Add a helper `error_response(e, log, status=500)` that calls
`log.exception(...)` server-side (keeps full diagnostics) and returns a **generic
constant** body — **hard rule: the returned payload references the exception object
zero times** (no `str(e)`, no `type(e).__name__`, no `e.args`); any reference keeps
the taint flow to the response and the alert stays open. Route all 14 sites through
it; grep to confirm no inline `str(e)` remains in a response. (Logging `e` does NOT
keep the alert alive — the logging sink ≠ the HTTP-response sink.) Sidecar binds
loopback, so this is defense-in-depth, but cheap and clears the whole bucket.

### Scope C — Frontend (`src/`), `xss-through-dom` (4) + `insecure-randomness` (1)

- **The 4 flagged `<img>` sites are safe by server-controlled provenance**, not by
  sink-type: `listen-header.tsx:90`, `library-table.tsx:303`, `library-grid.tsx:207`
  bind `book.coverImageUrl` which `scan.ts` hardcodes to `/api/books/:id/cover`;
  `cover-picker.tsx:603` binds `liveCoverUrl` (a server path or `currentCoverUrl`).
  None can hold `javascript:`/`data:`. The value-return `safeImageSrc` wrapper is
  **not CodeQL-recognized** (cross-boundary, same as path-injection), so these
  **will not auto-clear** → **dismiss all 4 from the start** (justification:
  server-controlled provenance + `<img src>` is not a script-execution sink).
- New `src/lib/safe-url.ts`: `safeImageSrc(url)` allowlist = `http:`, `https:`, and
  same-origin **relative** paths; **exclude `data:` and `blob:`** (verified: no cover
  path produces them — local upload round-trips through the server; covers are
  always server paths or remote http(s)). Returns `''` otherwise.
- **Wrap `cover-picker.tsx:453`** (`src={c.coverUrl}`, the search-candidate grid) —
  this is the genuinely remote-URL-bound `<img>` (e.g. `apple.ts:41` echoes the
  iTunes `artworkUrl` with no scheme normalization). CodeQL did **not** flag it, but
  under the maximal posture it is the one site where the guard does real work. Wrap
  the 4 flagged sites too (defense-in-depth; doesn't clear the alert but is correct).
- `js/insecure-randomness` (`components/mini-player.tsx:99`) — the `Math.random`
  fallback session id → derive from `crypto.getRandomValues`; the final fallback
  (only if `crypto` is entirely absent) must **not** call `Math.random` (or CodeQL
  re-flags that line). *(Confirmed non-security regardless: the server trusts the
  client-supplied `sessionId` verbatim and stats are per-`(date,sessionId)`,
  monotonic, capped — RNG quality buys an attacker nothing. Cosmetic hardening;
  document that rationale.)*

### Scope D — CodeQL config durability

`.github/workflows/codeql.yml` currently has no `paths-ignore` and scans the whole
tree, so the next weekly run resurfaces test-fixture alerts even after we fix
today's (test files routinely trip redos / sanitization / hardcoded-credentials).
Add a CodeQL config (`.github/codeql/codeql-config.yml`, referenced from the
workflow) with `paths-ignore: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**']`. This
**durably clears the 2 `cover.test.ts` alerts** and prevents future test-only noise.
Keep `scripts/**` in scope (real-ish) — fix `bump-version.mjs` and
`start-app-prod.mjs` in code.

## Testing (required per project discipline)

- **A1:** `server/src/util/safe-path.test.ts` — `safeSegment` rejects `..`, `/`,
  `\`, NUL, absolute, drive-prefix; **accepts** `-`, `__`, `.` mid-name; `safeJoin`/
  `assertContained` reject escaping, accept contained. Plus escalated-sink
  regressions: `bookDirByDisplay('..\\evil', …)` sanitized/rejected; `POST
  /api/samples/..%2f../load` → 400; a `qwenVoicePtPath`-via-poisoned-`voiceId`
  rejection.
- **A2:** `server/src/middleware/rate-limit.test.ts` — 429 past cap; each of the 7
  SSE routes exempt via `skip`; a poller not throttled at steady cadence.
- **A3:** targeted unit/regression tests per fixed site — redos inputs no longer
  catastrophic **and** parser output unchanged on fixtures (`text.ts`, `epub.ts`
  entity sequences, `text-match.ts`); sanitizer idempotent (replace-until-stable);
  exact-host check; loop clamps reach the loop condition; `audio-tags` untouched
  (no truncation).
- **B:** `server/tts-sidecar/tests/` — a pytest asserting an error response body
  carries the generic message and contains **no** traceback / `str(e)` substring,
  across a representative sample of the 14 sites.
- **C:** `src/lib/safe-url.test.ts` — `safeImageSrc` passes http/https/relative,
  strips `javascript:`/`data:`/`blob:`; mini-player session id uses crypto when
  available and never `Math.random`.
- `npm run verify` (typecheck + all tests + e2e + build) green before merge.

## Dismissal budget (explicit, up front)

Dismissed via `gh api .../code-scanning/alerts/<n> -X PATCH -f state=dismissed
-f dismissed_reason="won't fix" -f dismissed_comment="<file:line + precise reason +
threat-model ref>"`. No blanket dismissals. Expected set:
- **4 × `xss-through-dom`** img sites — server-controlled provenance; `<img src>`
  not a script sink; wrapper not CodeQL-recognized.
- **1 × `loop-bound-injection`** `audio-tags.ts:58` — legitimate O(n) manuscript
  scan; clamping would truncate content.
- **`js/path-injection` composed-path residue** — any `state-io` / `atomic-rename` /
  `cover/store` sink that cannot host an in-function guard; justification = path
  composed from already-contained/slugged inputs.
- **Possibly 1 × `disabling-certificate-validation`** — if trusting the CA in the
  prod-start probe proves impractical (localhost-own-cert justification).

Everything else is a code fix expected to auto-clear on re-scan.

## Verification

1. `npm run verify` green on the integration branch.
2. Merge to `main`.
3. `gh workflow run codeql.yml --ref main`; confirm Security → Code scanning drops
   to **only the documented dismissal set** (no un-triaged open alerts).
4. Update `docs/security/2026-05-31-security-review.md`: correct the stale #1
   framing and record this remediation pass (what was fixed, what was dismissed and
   why).

## Out of scope (with a noted adjacency)

- **Authentication** (`fe-11`, `srv-10`, `srv-9`) — single-user by design; the only
  real LAN control, deliberately parked.
- **`srv-21` (SSRF via `sidecarUrl`)** and **`srv-22` (`sync-folder/test`
  arbitrary mkdir/clobber)** — *not* CodeQL-flagged, tracked separately. **Noted
  adjacency:** the `sync-folder/test` write (`user-settings.ts:138-142`) is the
  **same arbitrary-write class** as the `import` sink this spec hardens; fixing one
  and not the other is inconsistent. **Recommend folding `srv-22`'s path-containment
  into Scope A** (same `safeJoin` pattern) — flagged for the user's call. `srv-21`
  (host allowlist) is a separate shape; leave as a follow-up.
- `side-12/13`, `ops-7` (sidecar pickle / download checksums) — separate backlog.
