---
status: active
shipped: null
owner: null
---

# 145 — Server crash diagnostics + unhandled-rejection resilience

> Status: active — handlers landed; the value is realised on the NEXT crash (it gets logged) and on transient rejections (the run survives).
> Key files: `server/src/crash-logging.ts`, `server/src/index.ts`
> URL surface: none
> OpenAPI ops: none

## Benefit / Rationale

- **User:** an unattended generation run stops dying invisibly — a stray async error now logs and (for rejections) is survived, so the book keeps rendering; and when something genuinely fatal happens, there's a logged cause to fix.
- **Technical:** turns a silent `:8080` death into a diagnosable one and makes the server resilient to transient unhandled rejections.

## Context — the silent deaths (2026-05-30)

The generation server died **twice** with no diagnostics: `:8080` went down (listen socket closed → the `tsx watch` child exited), `server.err.log` had no stack trace, no heap-OOM, and the second time RAM was 61% free (so not the host-leak OOM). The `tsx watch` wrapper survived but doesn't auto-respawn the child, so the run stalled. Root cause un-knowable because **the server had no `uncaughtException`/`unhandledRejection` handlers** — Node's default output wasn't reaching the captured stderr.

The likeliest trigger: an **unhandled promise rejection** on an un-awaited/un-caught async path (e.g. a transient sidecar-fetch error during the startup race — the sidecar isn't HTTP-ready ~20 s after spawn while it eager-loads Qwen, so an early generation/preload call rejects). Node 20 terminates on an unhandled rejection by default — silently here.

## The fix

`server/src/crash-logging.ts` → `installCrashHandlers()`, called in `index.ts` immediately after `installTimestamps()` (so it's armed before any async work and inherits the timestamp-patched `console`):

- **`uncaughtException`** → log the stack (`[server] FATAL uncaughtException — <stack>`), then `exit(1)`. Process state is undefined after an uncaught throw (Node docs), so we die *with a logged cause* and let the operator restart, rather than limp on.
- **`unhandledRejection`** → log the reason + `(survived — server continues)` and **do NOT exit**. A stray rejection shouldn't take down a long unattended run; this overrides Node's terminate-on-rejection default. The log surfaces the source so it can be fixed at the root (tracked: `srv-17`).

If a future crash STILL leaves no log, it's native/external (segfault, OS/AV kill) — itself a diagnostic narrowing.

## srv-17 follow-up — what the handlers captured (2026-05-31)

The handlers worked, and the captured evidence **disproved the mid-run silent-death hypothesis above**. Across a full 2026-05-31 generation run, the server never logged a mid-run FATAL. The only two `[server] FATAL uncaughtException` lines (`logs/server.err.log`, 08:34 and 14:55) were both:

```
[server] FATAL uncaughtException — Error: listen EADDRINUSE: address already in use :::8080
    at app.listen (…/express/lib/application.js:635)
    at <anonymous> (…/server/src/index.ts)
```

i.e. a **startup port collision**, not a process dying mid-run. The timeline shows the server stayed alive throughout: the 14:19–14:21 churn was the recycle-drain cascade (ch17–28 all 503'd while the sidecar recycled — `side-11` / the recycle-drain-cascade), and ch29 hit a *handled* 600 s `ChapterSynthTimeoutError` at 14:37. At 14:55 a **second** server instance tried to bind `:8080` while the first still held it → the bind error bubbled to `uncaughtException` as a cryptic stack. The perceived "silent death" was a *stuck* server (sidecar instability) plus a restart that collided on the port — not a server crash.

**The fix:** `attachListenErrorHandler(server, port)` (in `crash-logging.ts`) is now attached to the listener on both the HTTP and HTTPS paths in `index.ts`. A bind failure is intercepted on the listener's own `'error'` event:

- **`EADDRINUSE`** → `formatListenError` prints an actionable line — *"Port N is already in use — another server instance is likely already running. Stop it first … or set PORT to a free port, then retry."* — then `exit(1)`.
- **Any other bind error** → a generic `[server] FATAL listen error on port N — <stack>` + `exit(1)`.

Because the handler lives on the listener, EADDRINUSE no longer reaches the `uncaughtException` path — cleaner attribution, actionable message. The plan-145 `uncaughtException`/`unhandledRejection` handlers stay in place as the ongoing watch for a genuine mid-run FATAL (none observed to date).

## Architectural impact

- **New seam:** `crash-logging.ts` (`formatCrash`, `installCrashHandlers` with injectable `onLog`/`onExit`/`target` for tests).
- **Behaviour change:** the server no longer terminates on an unhandled rejection (logs + survives). Uncaught exceptions still terminate (now logged). No request/route behaviour changes.
- **Reversibility:** remove the `installCrashHandlers()` call to restore Node defaults.

## Invariants to preserve

- Handlers installed BEFORE the server's async work (right after `installTimestamps()`).
- `uncaughtException` must still exit (corrupt state); only `unhandledRejection` survives.

## Test plan

Automated (`npm run test:server`, `crash-logging.test.ts`): `formatCrash` carries the Error stack / stringifies a non-Error reason; `uncaughtException` → `onLog` + `onExit(1)`; `unhandledRejection` → `onLog` (incl. "survived") + NO exit. **srv-17 cases:** `formatListenError` EADDRINUSE → actionable "already in use" hint naming the port (not a raw FATAL dump); non-EADDRINUSE → generic FATAL line + stack; `attachListenErrorHandler` emits `error` against an injected `EventEmitter` → `onLog` + `onExit(1)` for both EADDRINUSE and a generic bind error. Driven via injected emitters so the real process is untouched.

Manual acceptance: ✅ the next FATAL **was** captured (two EADDRINUSE startup collisions, 2026-05-31). After this fix — with the app already on `:8080`, start a second `cd server && npm run dev` → `server.err.log` shows the actionable `Port 8080 is already in use …` line + clean exit, NOT a `FATAL uncaughtException` stack. The mid-run silent-death watch (plan-145 handlers) remains armed.

## Ship notes

_Pending._ Branch `fix/server-crash-diagnostics` (off main). Fill shipped date + SHA on merge; flip → `stable` once a captured crash (or a clean long run) confirms the handlers behave. Follow-up `srv-17`: root-cause + fix whatever the handler captures.
