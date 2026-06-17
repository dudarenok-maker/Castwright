# CodeQL alert remediation — design spec

**Date:** 2026-06-17
**Branch:** `fix/security-codeql-remediation`
**Status:** draft
**Disposition chosen:** Maximal / defense-in-depth (zero open alerts + real hardening
against future LAN exposure)

## Problem

GitHub code-scanning (CodeQL, `.github/workflows/codeql.yml`, weekly cron) reports
**146 open alerts** on `main`. CodeQL has no knowledge of the app's threat model
— a single-user, local-first tool with **no auth by design** that **binds loopback
(`127.0.0.1`) by default** and only binds all interfaces in the opt-in LAN HTTPS
flow (`server/src/bind-host.ts`; see `docs/security/2026-05-31-security-review.md`).
So it flags every route as un-rate-limited and every `join(workspaceRoot, id)` as
path-injection.

The user chose the **maximal** disposition: add real defensive code everywhere
(so the mitigations harden the genuine LAN-exposed surface, not just silence the
scanner), drive the dashboard to ~0 open alerts, and fall back to
dismiss-with-justification only where a *correct* mitigation exists that CodeQL
cannot recognize.

## Alert inventory (146 open)

| Rule | Count | Disposition |
|---|---|---|
| `js/path-injection` | 68 | Code fix — central path-containment helper + harden `paths.ts` builders |
| `js/missing-rate-limiting` | 42 | Code fix — `express-rate-limit` middleware mounted on the API |
| `py/stack-trace-exposure` | 14 | Code fix — generic client error, log traceback server-side |
| `js/xss-through-dom` | 4 | Code fix — `safeImageSrc` scheme guard (backstop-dismiss if still flagged) |
| `js/polynomial-redos` | 4 | Code fix — bound/rewrite the regexes |
| `js/loop-bound-injection` | 3 | Code fix — clamp loop bounds |
| `js/tainted-format-string` | 2 | Code fix — `%s` placeholders |
| `js/incomplete-url-substring-sanitization` | 2 | Code fix — exact-host check (test file) |
| `js/incomplete-multi-character-sanitization` | 2 | Code fix — global-flag/repeat regex fix |
| `js/insecure-randomness` | 1 | Code fix — `crypto.getRandomValues` fallback |
| `js/incomplete-sanitization` | 1 | Code fix — global-flag regex fix |
| `js/double-escaping` | 1 | Code fix — escape order |
| `js/resource-exhaustion` | 1 | Code fix — cap |
| `js/disabling-certificate-validation` | 1 | Code fix — scoped undici Agent, no global TLS flip |

## Threat-model note (carried into every justification)

Default bind is loopback-only; LAN mode is opt-in and documented. These
mitigations are defense-in-depth that become load-bearing the moment a user runs
`npm run start:lan` on an untrusted network, and matter more now the repo is
public. No mitigation changes the single-user no-auth design — they only contain
inputs and bound resource use.

## Architecture

Three **non-overlapping scopes** so the work parallelizes via worktree subagents
(per `CONTRIBUTING.md` scope discipline) and reconciles on one `integration/<date>`
branch verified once.

### Scope A — Server (Node/TS), ~120 alerts

**A1. Path containment (`js/path-injection`, 68).**
- New `server/src/util/safe-path.ts`:
  - `safeSegment(seg: string): string` — rejects a path segment containing path
    separators, `..`, NUL, or absolute-path markers; throws `PathContainmentError`.
  - `safeJoin(root: string, ...segments: string[]): string` — `path.resolve`s and
    asserts the result is contained under `path.resolve(root)` using
    `path.relative` (the CodeQL-recognized containment check); throws otherwise.
- Harden the central builders in `server/src/workspace/paths.ts` (and the cover /
  voice-sample / qwen-voice path helpers) to run id segments through `safeSegment`
  and compose via `safeJoin`. Because most flagged sinks
  (`qwenVoicePtPath`, `voiceSampleFilePath`, `castJsonPath`, state-io read/write,
  auto-backup, samples, import, handoff/protocol, analyzer cache) compose paths
  through these helpers, hardening the helpers clears the majority centrally.
- Apply `safeJoin`/`safeSegment` directly at any sink that builds a path inline
  rather than via a helper (audit each of the 17 flagged files).

**A2. Rate limiting (`js/missing-rate-limiting`, 42).**
- Add `express-rate-limit` (Express 5 compatible) as a server dependency.
- New `server/src/middleware/rate-limit.ts` exporting a configured limiter
  (generous window/cap suitable for a single user; standard headers on).
- Mount via `app.use(apiLimiter)` ahead of the route handlers in
  `server/src/index.ts`.
- **Streaming/long-poll exemption:** SSE and any long-lived endpoints
  (generation progress, analysis stream) are skipped via the limiter's `skip`
  predicate so a single long request isn't throttled and concurrent-session
  streaming isn't broken.

**A3. Per-site server fixes.**
- `js/tainted-format-string` (`routes/queue.ts:125`, `routes/voice-style.ts:119`)
  → pass the tainted value as a `%s` arg, not interpolated into the format string.
- `js/loop-bound-injection` (`parsers/audio-tags.ts:58`, `tts/voice-mapping.ts:459`,
  `tts/voice-sample-cache.ts:84`) → clamp the loop bound to a sane constant max.
- `js/polynomial-redos` (`parsers/text.ts:169,196`, `tts/voice-sample-cache.ts:57`,
  `util/text-match.ts:7`) → rewrite the ambiguous quantifiers (bound the inner
  `.+?`, anchor, or length-cap the input before matching).
- `js/incomplete-multi-character-sanitization` (`parsers/epub.ts:356`,
  `parsers/html-utils.ts:37`) + `js/incomplete-sanitization`
  (`scripts/bump-version.mjs:204`) + `js/double-escaping` (`parsers/epub.ts:487`)
  → fix the regex (global flag / replace-until-stable / correct escape order).
- `js/resource-exhaustion` (`analyzer/gemini.ts:678`) → cap the
  attacker-influenced size before allocation/processing.
- `js/incomplete-url-substring-sanitization` (`routes/cover.test.ts:103,106`)
  → replace substring host checks with exact `new URL(...).host` comparison.
- `js/disabling-certificate-validation` (`scripts/start-app-prod.mjs:118`)
  → replace the process-global `NODE_TLS_REJECT_UNAUTHORIZED='0'` flip with a
  request-scoped undici `Agent({ connect: { rejectUnauthorized: false } })`
  passed only to that one localhost self-signed health probe.

### Scope B — Sidecar (Python), `py/stack-trace-exposure` (14)

- `server/tts-sidecar/main.py` returns `str(e)` / traceback text to the client at
  14 sites (e.g. `:3047`). Introduce a small helper (e.g. `error_response(e, log)`)
  that logs the full traceback server-side (`log.exception`, already present at
  most sites) and returns a generic `{"status":"error","error":"<generic>"}` to
  the client. Apply at all 14 sites. The sidecar binds loopback, so this is
  defense-in-depth, but it is cheap and removes the whole bucket.

### Scope C — Frontend (`src/`), `xss-through-dom` (4) + `insecure-randomness` (1)

- New `src/lib/safe-url.ts`: `safeImageSrc(url: string | null | undefined): string`
  — scheme allowlist (`http:`, `https:`, `data:`, `blob:`), returns `''` for
  anything else (notably `javascript:`). Wrap the 4 cover `<img src>` sites:
  `modals/cover-picker.tsx:603`, `components/listen/listen-header.tsx:90`,
  `components/library/library-table.tsx:303`, `components/library/library-grid.tsx:207`.
  (`img src` is not a script-execution sink, but maximal = add the guard.)
- `js/insecure-randomness` (`components/mini-player.tsx:99`) — the `Math.random`
  fallback session id → derive from `crypto.getRandomValues` (with a final
  deterministic fallback only if `crypto` is entirely absent).

## Testing (required per project discipline)

- **A1:** `server/src/util/safe-path.test.ts` — `safeSegment` rejects `..`, `/`,
  `\`, NUL, absolute; `safeJoin` rejects escaping paths and accepts contained
  ones. Plus a regression test on at least one hardened builder (e.g. a
  `qwenVoicePtPath('..\\..\\evil')` rejection).
- **A2:** `server/src/middleware/rate-limit.test.ts` — limiter returns 429 past
  the cap; the `skip` predicate exempts a streaming path.
- **A3:** targeted unit tests for each fixed parser/util (redos input no longer
  catastrophic; sanitizer idempotent; exact-host check). Reuse existing parser
  test files where present.
- **B:** `server/tts-sidecar/tests/` — a pytest asserting an error response body
  carries the generic message and **no** traceback/`str(e)` substring.
- **C:** `src/lib/safe-url.test.ts` — `safeImageSrc` passes http/https/data/blob,
  strips `javascript:`; mini-player session-id uses crypto when available.
- `npm run verify` (typecheck + all tests + e2e + build) green before merge.

## Backstop dismissals

Only for alerts where a correct mitigation is in place but CodeQL still can't
recognize it (most likely the 4 `xss-through-dom` img-src cases). Dismissed via
`gh api .../code-scanning/alerts/<n> -X PATCH -f state=dismissed
-f dismissed_reason="won't fix" -f dismissed_comment="<precise justification +
threat-model doc ref>"`. Every dismissal names the file/line and the reason it is
not a real sink. No blanket dismissals.

## Verification

1. `npm run verify` green on the integration branch.
2. Merge to `main`.
3. `gh workflow run codeql.yml --ref main`, then confirm Security → Code scanning
   drops to ~0 open (remaining = only the explicitly-justified backstop
   dismissals, if any).
4. Update `docs/security/2026-05-31-security-review.md` (or a short follow-up note)
   recording the remediation pass.

## Out of scope

- Adding authentication (parked: `fe-11`, `srv-10`, `srv-9` — single-user by
  design).
- The non-CodeQL security-review backlog items (`srv-20/21/22`, `side-12/13`,
  `ops-7`) — tracked separately; not part of this alert-clearing pass.
