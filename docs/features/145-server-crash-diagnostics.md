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

## Architectural impact

- **New seam:** `crash-logging.ts` (`formatCrash`, `installCrashHandlers` with injectable `onLog`/`onExit`/`target` for tests).
- **Behaviour change:** the server no longer terminates on an unhandled rejection (logs + survives). Uncaught exceptions still terminate (now logged). No request/route behaviour changes.
- **Reversibility:** remove the `installCrashHandlers()` call to restore Node defaults.

## Invariants to preserve

- Handlers installed BEFORE the server's async work (right after `installTimestamps()`).
- `uncaughtException` must still exit (corrupt state); only `unhandledRejection` survives.

## Test plan

Automated (`npm run test:server`, `crash-logging.test.ts`): `formatCrash` carries the Error stack / stringifies a non-Error reason; `uncaughtException` → `onLog` + `onExit(1)`; `unhandledRejection` → `onLog` (incl. "survived") + NO exit. Driven via an injected `EventEmitter` so the real process is untouched.

Manual acceptance (pending): on the next server crash, confirm `server.err.log` now contains a `[server] FATAL …` line naming the cause; confirm a transient sidecar-fetch rejection is logged-and-survived rather than killing the run.

## Ship notes

_Pending._ Branch `fix/server-crash-diagnostics` (off main). Fill shipped date + SHA on merge; flip → `stable` once a captured crash (or a clean long run) confirms the handlers behave. Follow-up `srv-17`: root-cause + fix whatever the handler captures.
