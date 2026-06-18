# Security review — 2026-05-31

A point-in-time security review of the audiobook-generator. Read-only audit; no
code was changed in the review pass. Findings that become work are filed in
[`../BACKLOG.md`](../BACKLOG.md) under their area prefix (cross-referenced per
finding below).

## Scope & method

Reviewed: the Node/Express server (`server/src/`), the Python FastAPI TTS
sidecar (`server/tts-sidecar/`), the PowerShell/Node install scripts
(`scripts/`, `server/tts-sidecar/scripts/`), and the Vite/React frontend
(`src/`) plus root config and the secret/dependency surface.

Three parallel exploration sweeps produced candidate findings; every
high-impact or uncertain claim was then **re-verified against the source** —
several initially-flagged "Critical" items did not survive verification and are
recorded as downgraded below, with the verification note, so the next reviewer
doesn't re-raise them.

## Threat model

The app has **no authentication anywhere** — by design, for a single-user,
local-first tool (the backlog explicitly parks multi-user collaboration:
`fe-11`, `srv-10`, `srv-9`). Severity is therefore almost entirely a function
of **who can reach the listener**, so every finding is rated for two scopes:

- **Loopback** — the default `npm start` on a trusted personal machine. An
  attacker already on `localhost` has bigger levers than the app.
- **Hostile-LAN** — the documented opt-in phone/tablet flow (`npm run start:lan`)
  deliberately binds the home Wi-Fi, *and* the default HTTP dev mode also binds
  all interfaces (see #1). On a shared/untrusted network, every unauthenticated
  route is reachable by any peer.

This is realistic but not the common case — most users run loopback-only on a
trusted home network. The dual-column ratings let each item be prioritized on
its own merits.

## Severity matrix

| # | Finding | Loopback | Hostile-LAN | Backlog |
|---|---------|----------|-------------|---------|
| 1 | No auth + all-interface bind by default | Low | **High** | `srv-19`, `srv-20` |
| 2 | `/workspace` static mount serves whole workspace (content, not secrets) | Low | **High** | `srv-19`, `srv-20` |
| 3 | SSRF via user-set `sidecarUrl` | Low | **Medium** | `srv-21` |
| 4 | `sync-folder/test` arbitrary-path probe write | Low | **Medium** | `srv-22` |
| 5 | `torch.load(weights_only=False)` on cached voice `.pt` | **Medium** | Medium | `side-12` |
| 6 | No checksum/signature pin on model + wheel downloads | **Medium** | **Medium** | `ops-7` |
| 7 | No `/synthesize` input-length cap | **Low-Med** | Low-Med | `side-13` |
| 8 | BroadcastChannel message shape not validated | Info | Info | — |
| 9 | DEV/E2E `window.__store__` hooks | Info | Info | — |
| 10 | `spawn-sidecar` port string-interpolation | Info | Info | — |
| 12 | `server/.env` key (verified never in git) | Info | Info | — |

(#11 is the "no XSS sinks" verification, recorded under *Verified secure*.)

---

## Findings

### Worth fixing

**#1 — No auth + server binds all interfaces by default.**
> **UPDATE (2026-06-18): the "binds all interfaces by default" framing is now
> STALE.** Since `srv-19` shipped (`server/src/bind-host.ts`), the **default**
> bind is **loopback-only** (`127.0.0.1`); all-interface bind requires the opt-in
> `npm run start:lan` flow or an explicit `BIND_HOST=0.0.0.0`. The text below
> describes the pre-`srv-19` world and is retained for history. The residual
> exposure is therefore the *opt-in* LAN flow, not the default.

`server/src/index.ts:362` — plain `app.listen(PORT)` with no host binds to
`0.0.0.0`, not `127.0.0.1` (the file's own comment at `:231` confirms this).
LAN HTTPS mode (`:360`) is *meant* to be reachable, but the **default HTTP dev
mode also binds every interface**, and there is no auth on any route. A LAN peer
can trigger Gemini analysis (burns quota/$), enumerate/download every book, and
mutate settings/cast.
*Direction:* bind `127.0.0.1` unless LAN mode is explicitly on (`srv-19`);
optionally a shared-secret token for the LAN flow (`srv-20`).

**#2 — `/workspace` static mount serves the entire workspace unauthenticated.**
`server/src/index.ts:149` — `express.static(WORKSPACE_ROOT)` exposes all
manuscripts, audio, `state.json`, `cast.json`, and queue files to anyone who can
reach the port. **Verified the key is *not* here:** `user-settings.json` (which
holds `geminiApiKey`) lives at `~/.audiobook-generator/`
(`server/src/workspace/user-settings.ts:38`), *outside* `WORKSPACE_ROOT`
(`server/src/workspace/paths.ts:31`), and `geminiApiKey` is in `FORBIDDEN_KEYS`
(stripped from PUT/GET). So this leaks *content* (copyrighted manuscripts +
finished audio), not credentials. Mitigated by the same bind/auth fix as #1.

**#3 — SSRF via user-settable `sidecarUrl`.**
`server/src/routes/sidecar-health.ts` (and the `/load`, `/unload` paths) fetch
`${getResolvedSidecarUrl()}/health`, where `sidecarUrl` is validated only as
`z.string().min(1).max(2000)` — no scheme/host check. Normally self-inflicted
(the user sets their own sidecar URL), **but** because the settings PUT is
unauthenticated (#1), a LAN attacker could point it at an internal service and
read the probe responses. *Direction:* validate to `http(s)` + a private-host
allowlist before any fetch (`srv-21`).

**#4 — `sync-folder/test` writes a probe file to an arbitrary path.**
`server/src/routes/user-settings.ts:138-142` — takes `path` from the body
(`z.string().max(2000)` only), does `mkdir(recursive)` + `writeFile` + `unlink`.
Content is a fixed `'ok'` immediately unlinked, so it's an **arbitrary-mkdir /
limited-clobber** primitive, not arbitrary-content write. Reachable unauth over
LAN (#1). *Direction:* confirm the path resolves under an expected root or at
least document the trust boundary (`srv-22`).

**#5 — Sidecar `torch.load(..., weights_only=False)` on cached voice `.pt`.**
`server/tts-sidecar/main.py:1251` loads pickled voice prompts from
`QWEN_VOICES_DIR`. The code correctly notes the file is app-written, and the
**sidecar binds `127.0.0.1`** (verified, `server/tts-sidecar/start.ps1:94`), so
this is *not* network-reachable. Residual risk: anyone who can drop a `.pt` into
the voices dir gets RCE in the sidecar process. *Direction:* `weights_only=True`
or a safetensors/JSON embedding format if the payload allows (`side-12`).

**#6 — Model/wheel downloads have no checksum or signature pin.**
`scripts/install-kokoro.ps1` (GitHub release `.onnx`/`.bin`) and
`server/tts-sidecar/scripts/install-qwen3.mjs` (`pip install -U qwen-tts`, plus
a **third-party community FlashAttention wheel** from `huggingface.co/lldacing/…`).
All over HTTPS (wire-MITM mitigated), but **no SHA256 pin** — a compromised
upstream account or PyPI/HF package serves trojaned binaries that execute at
load/install. The community FA2 wheel is the sharpest (untrusted single-maintainer
repo, opt-in via `--flash-attn`). *Direction:* pin SHA256 for the kokoro release
assets + the FA2 wheel; consider `pip install --require-hashes` (`ops-7`).

**#7 — `/synthesize` has no input-length cap.**
`server/tts-sidecar/main.py` validates non-empty text but no max length →
unbounded VRAM/CPU on a giant payload. Loopback-only, so low real exposure.
*Direction:* a generous `MAX_TEXT_LENGTH` 400-guard (`side-13`).

### Informational / defense-in-depth (not currently worth a fix)

**#8 — BroadcastChannel messages aren't strictly shape-validated.**
`src/store/broadcast-middleware.ts` checks `typeof msg === 'object'` then spreads
`msg.diff` into store state. Same-origin-only by spec, and **no XSS vector
exists** (see #11), so this is only reachable *after* a hypothetical XSS. Noted,
not prioritized.

**#9 — DEV/E2E `window.__store__` / `window.__mockQueue` hooks.**
`src/main.tsx:50-66` — tree-shaken out of production builds. Intentional and
documented.

**#10 — `spawn-sidecar.ts` shell-string port interpolation.**
`server/src/tts/spawn-sidecar.ts:136-146` — initially flagged as Critical command
injection. **Verified false alarm:** `port` is a hardcoded `Number` (9000), never
request-derived, and args go through `spawn(file, args[])`. Keep it numeric;
don't elevate.

### Verified secure

- **#11 — No XSS sinks:** no `dangerouslySetInnerHTML`, `innerHTML`, `eval`,
  `new Function`, or `javascript:` URIs anywhere in `src/`. Manuscript/chapter
  text renders as plain JSX text.
- **No secrets in the client bundle:** only `VITE_USE_MOCKS` / port vars are
  `VITE_`-prefixed; the Gemini key is server-only and stripped from API responses.
- **`.gitignore` covers** `.env`, certs/keys, workspace, venv; no `*.pem`/`*.key`
  tracked.
- **Sidecar binds `127.0.0.1`** by default (`start.ps1:94`), not `0.0.0.0`.
- **Qwen voice-id path sanitization** (`main.py:1010`) correctly blocks `..`.

### Verified — no action

**#12 — `server/.env` contains a live Gemini API key (local hygiene only).**
Verified this review: `git ls-files` shows the file is untracked,
`git log --all -- server/.env` shows no commit ever touched it, and
`git log --all -S 'AIzaSy'` shows the key prefix never appears anywhere in
history. So this is a **correctly-gitignored local dev secret, not a
disclosure** — no forced rotation. Optional hygiene: rotate if the dev machine
is ever shared/imaged. (The key value is deliberately not reproduced here.)

---

## Follow-up tracking

Items #1–#7 are filed in [`../BACKLOG.md`](../BACKLOG.md):
`srv-19` (default-bind loopback, Should), and under a new Could "Security &
hardening" sub-group `srv-20` (LAN auth token), `srv-21` (`sidecarUrl`
validation), `srv-22` (sync-folder path constraint), `side-12`
(`weights_only=True`), `side-13` (`/synthesize` length cap); plus `ops-7`
(download checksum pinning) under Ops. Each fix ships its paired test per the
project's testing discipline (server vitest, sidecar pytest, Pester for the
install-script hashes).

---

## 2026-06 — CodeQL remediation pass

A maximal/defense-in-depth pass clearing the 146 open GitHub code-scanning
(CodeQL) alerts. Spec + plan:
[`docs/superpowers/specs/2026-06-17-codeql-remediation-design.md`](../superpowers/specs/2026-06-17-codeql-remediation-design.md)
and [`docs/superpowers/plans/2026-06-17-codeql-remediation.md`](../superpowers/plans/2026-06-17-codeql-remediation.md).

**Code-fixed (with paired tests):**

- **Path-injection** — new `server/src/util/safe-path.ts` containment helper
  (`safeSegment`/`assertContained`/`safeJoin`), applied at each `fs` sink in its
  own function (samples slug, analysis cache id, qwen-voice + book-state +
  epub-upload, analyzer handoff writes, cover-download). `bookDirByDisplay`
  sanitizes path-hostile chars at the single chokepoint (preserving spaces/
  hyphens) and asserts containment — closing the unauthenticated arbitrary-file
  **write** primitive via `POST /api/books`.
- **Rate limiting** — global `express-rate-limit` (`apiLimiter`), mounted before
  every route so it dominates the API surface (anti-DoS + scanner-clearing; **not**
  an auth control — auth stays parked as `srv-20`).
- **Sidecar stack-trace exposure** — all error responses return a generic body
  and log the traceback server-side (no exception text reaches the client).
- **Misc** — tainted-format-string → `%s`; loop-bound clamps; ReDoS trim splits;
  replace-until-stable HTML/entity sanitizers; `&amp;`-decoded-last; Gemini stream
  accumulator cap; frontend `safeImageSrc` cover-URL guard + crypto session id;
  the LAN health probe now validates the self-signed cert against the mkcert root
  CA instead of disabling TLS.
- **`srv-22`** — `sync-folder/test` now requires an existing directory
  (`lstat`-first, symlink-rejecting) rather than `mkdir`-creating an arbitrary
  tree, removing an unauthenticated arbitrary-directory-creation primitive.

**Dismissed (with justification)** — see
[`docs/security/codeql-dismissal-residue.md`](codeql-dismissal-residue.md): the 4
cover `<img src>` (server-controlled provenance; not a script sink), the 2
`cover.test.ts` test-file alerts, the `audio-tags` manuscript-scan loop, the
`state-io`/`atomic-rename` composed-path sinks (no single containment root), and
the `text.ts` filename/title ReDoS regexes (no parse-preserving rewrite;
server-side input). CodeQL config now excludes `**/*.test.ts(x)` going forward.
