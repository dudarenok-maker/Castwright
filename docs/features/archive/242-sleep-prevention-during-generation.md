---
status: stable
shipped: 2026-07-06
owner: null
---

# 242 — Prevent Windows sleep during an active generation (side-11 investigation)

> Status: stable
> Key files: `server/src/system/prevent-sleep.ts`, `scripts/lib/prevent-sleep.psm1`,
> `scripts/lib/prevent-sleep.ps1`, `server/src/routes/generation.ts`
> URL surface: none (server + OS-level behaviour only)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** an overnight/unattended generation no longer risks a multi-hour
  silent stall because Windows put the machine into Modern Standby mid-run.
  The screen still dims/turns off normally — only the system itself is kept
  awake while something is actually rendering.
- **Technical:** the app no longer depends on the user's Windows power plan
  being correctly configured for whatever power source is active at 2 AM.
  Investigating a real 2026-07-06 overnight failure found the machine
  entered Modern Standby on Idle Timeout ~3 minutes after the run started,
  even though the AC power-plan sleep setting read "never" — something
  outside the app's control (a vendor power utility, or being on battery at
  the time) can override that setting. Holding the lock at the app level
  removes that dependency entirely.
- **Architectural:** a single, reusable cross-book "is anything generating"
  signal already existed (`inFlightByChapter`/`activeGenerationBooks()` in
  `generation.ts`) — this hooks the wake lock onto that same signal's
  register/deregister transitions rather than inventing a second tracker.

## Architectural impact

- **New seams / extension points:** `server/src/system/prevent-sleep.ts`
  exports `preventSleep()` / `allowSleep()` / `isSleepPrevented()`, each
  accepting injectable deps (`spawnFn`, `platform`, `enabled`) for testing.
  New env toggle `PREVENT_SLEEP_DURING_GENERATION` (default on, Windows-only;
  documented in `server/.env.example`'s free-text section — not wired into
  the Model Manager config registry, since this is a rarely-touched ops
  escape hatch rather than a user-facing setting).
- **Invariants preserved:** `registerJob`/`deregisterJob` in `generation.ts`
  keep their existing `inFlightByChapter`/`inFlightByBook` bookkeeping
  untouched; the wake-lock calls are additive guards (`if (...size === 0)`)
  around the existing logic, not a replacement for it.
- **Reversibility:** fully reversible — `PREVENT_SLEEP_DURING_GENERATION=false`
  disables it with no other code path affected; the spawned PowerShell helper
  is killed on `allowSleep()` and Windows resets `ES_SYSTEM_REQUIRED`
  automatically on process exit either way.
- **Migration story:** none — no on-disk shape change.

## Invariants to preserve

- `preventSleep()` is a no-op off Windows, when disabled, or while a helper
  is already active (idempotent — `server/src/system/prevent-sleep.ts`).
- Only `ES_SYSTEM_REQUIRED` is asserted, never `ES_DISPLAY_REQUIRED` — the
  display must keep dimming/turning off on its own normal timeout
  (`scripts/lib/prevent-sleep.psm1`'s `Set-SystemAwake`).
- The wake lock engages on the FIRST job to register across the whole
  process (not per-book) and releases only once the LAST job anywhere has
  deregistered (`generation.ts`'s `registerJob`/`deregisterJob`).

## Test plan

### Automated coverage

- Vitest server (`server/src/system/prevent-sleep.test.ts`) — 10 cases: spawns
  the PowerShell helper on win32 when enabled, no-op off-Windows/disabled,
  default-enabled reads `PREVENT_SLEEP_DURING_GENERATION`, doesn't double-spawn
  while active, `allowSleep` kills the active helper and clears state, clears
  state when the helper exits on its own, allows a fresh spawn after a prior
  exit. `spawnFn` always injected — no real `powershell.exe` launched in CI.
- Pester (`scripts/tests/prevent-sleep.Tests.ps1`) — asserts `Set-SystemAwake`
  succeeds against the real Win32 `SetThreadExecutionState` call (caught a
  real bug: `0x80000000` parses as a signed Int32 literal in Windows
  PowerShell 5.1 and fails a direct `[uint32]` cast — fixed with the
  equivalent unsigned decimal literal), is idempotent under repeated calls,
  and `Reset-SystemAwake` releases the hold.
- Vitest server integration (`server/src/routes/generation.test.ts`, first
  describe block in the file) — 2 cases: the wake lock engages on the one
  in-flight chapter and releases once it completes; stays engaged while a
  second concurrent chapter is still in flight, releasing only after both
  drain. **Quarantined** (`quarantinedIt`, `docs/testing/flaky-register.md`)
  — this file is a documented "Hook timed out under Windows tmpdir/fs
  contention" hot file, and a throwaway unrelated single-request test
  reproduced an identical hang under real system load regardless of file
  position, proving this is pre-existing file-level flakiness rather than a
  defect in these two tests or the feature. Both pass reliably in isolation
  under normal load; run with `RUN_QUARANTINE=1` to exercise them locally.

### Manual acceptance walkthrough

1. Start a real multi-chapter generation on Windows. While it's in flight,
   confirm (Task Manager or `powercfg /requests`) that a `powershell.exe`
   child process is running under the server, and that the screen still
   dims/locks on its own normal timeout.
2. Let the generation finish (or pause it). Confirm the `powershell.exe`
   helper process exits within moments of the queue going idle.
3. Set `PREVENT_SLEEP_DURING_GENERATION=false`, restart the server, and
   confirm no helper process spawns during a generation.

## Ship notes

Shipped 2026-07-06. Landed alongside a related but separate fix: the sidecar's
`_load_voice_prompt_17b` (`server/tts-sidecar/main.py`) wasn't reading its
on-disk `<voice>__1.7b.pt` cache after a sidecar restart, forcing a full
re-derivation for every voice touched again — a contributing factor to the
same overnight investigation's chapter-23 recycle-storm failure (side-11,
`#399`, `fix/sidecar-17b-prompt-disk-cache`).
