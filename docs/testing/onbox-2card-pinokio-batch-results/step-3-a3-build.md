# Step 3 — A3 build: Task 16/16.5 auto-revert + toast (#2974)

Parent #2950, campaign #2435. Builds register row A3's task 16/16.5 —
"auto-revert on a repeated bad GPU pin + its operator toast" — per the scope
already designed in #1230 item 2. Test-first, with a real mutation run.

## Precondition check (read before building)

Step 2's evidence (`step-2-a3-checklist.md`, items 5-6) found that
`sidecar-supervisor.ts`'s `tripEvent()` — the exact trigger this task
consumes — is currently unreachable in production on Windows (`start.ps1`'s
own restart loop for codes 42/43 never lets the wrapping `powershell.exe`
exit, so `onChildExit` never sees an individual code-43 exit). Flagged as
`AGENT FOLLOW-UP` on this issue before starting.

This does **not** block this task's actual scope: item 2 explicitly asks for
unit tests wired directly to `tripEvent()`'s output (bypassing the real
process spawn), and running the real hardware trigger to confirm it fires
end-to-end is step 4, explicitly **out of scope** here ("Not in scope"
section of the issue). Built and unit-tested as designed; the reachability
gap remains a real blocker for step 4 and is already on record.

## What was built

### Server

- `server/src/gpu/auto-revert.ts` (new) — `runAutoRevert(trip, deps)`
  consumes one `tripEvent()` firing:
  - **card-specific** (`trip.card` non-null): clears the device-override knob
    (`tts.coqui.device` / `tts.kokoro.device` / `tts.qwen.device`) for each
    resident engine named in the breadcrumb, then calls `resetAndRespawn()`.
    Records `{status:'reverted', card, engines, toast}`.
  - **non-card-specific** (`trip.card` null/undefined — a degraded breadcrumb,
    a host-RAM ceiling, or a recycle-storm trip not tied to one GPU, per
    `RESTART43_STREAK_WINDOW_MS`'s own doc): does **not** revert or respawn.
    Records `{status:'unrevertable', toast}` — the distinct "not tied to a
    specific GPU card... manual investigation" copy #1230 specifies.
  - `getTripStatus()` / `_resetTripStatusForTest()` — module-level memory of
    the last outcome, the same "registry" idiom `sidecar-supervisor.ts` uses
    for `_activeSupervisor`, so a later, unrelated request (the trip-status
    route) can read what a trip already did.
- `server/src/tts/sidecar-supervisor.ts` — added an optional `onTrip` hook to
  `SidecarSupervisorOpts`, fired synchronously exactly once at the point
  `restart43Trip` is first set (existing behaviour unchanged when the hook is
  omitted — every prior test still passes unmodified). Wrapped in try/catch
  so a throwing hook can't break the supervisor's own hold-down path.
- `server/src/index.ts` — wires `onTrip` to `void runAutoRevert(trip, {
  resetAndRespawn: () => sidecarSupervisor!.resetAndRespawn() })` at
  `createSidecarSupervisor(...)` call time (fire-and-forget, per the hook's
  own sync contract).
- `server/src/routes/gpu-trip-status.ts` (new) — `GET /api/gpu/trip-status`,
  mounted in `app.ts` alongside the other `/api/gpu/*` routes. Returns
  `getTripStatus()` verbatim (`null` when nothing has tripped since boot).

### Frontend

- `src/lib/api.ts` — `GpuTripStatus` type + `getGpuTripStatus()` (real +
  mock), registered in both the real and mock `api` objects.
- `src/lib/use-tts-lifecycle.ts` — polls `/api/gpu/trip-status` on the same
  30 s tick as `/api/gpu/queue` (same permissive-error posture: a rejected
  probe leaves whatever notice is already showing, never surfaces as an
  error). New `tripNotice: string | null` field; `dismissNotices()` clears it
  too. A `lastTripToast` ref stops a dismissed notice from reappearing on the
  very next tick for the same still-current trip.
- `src/components/tts-notice-banner.tsx` — new `tripNotice` prop, rendered as
  an amber alert line (distinct from the existing rose `loadErrorNotice` —
  this is the supervisor acting on its own, not a user-initiated Load/Stop
  failure) with the same dismiss-button shape `loadErrorNotice` already uses.
- `src/components/layout.tsx` — passes `ttsLifecycle.tripNotice` through to
  the global banner (the same call site `evictionNotice`/`loadErrorNotice`
  already go through).
- Fixture updates for the now-required `tripNotice` field on `TtsLifecycle`:
  `src/views/generation.tsx` (`INERT_TTS_LIFECYCLE`), `src/routes/index.test.tsx`
  (3 call sites).

## Tests

- `server/src/gpu/auto-revert.test.ts` (new, 4 tests): card-specific streak
  reverts each resident engine + resets/respawns; card-specific streak with
  no revertible engine present (only `asr`/`spk` resident) still resets but
  reverts nothing; non-card-specific streak does NOT revert/respawn and
  returns the distinct unrevertable toast; `card: undefined` (degraded
  breadcrumb) is treated the same as `card: null`.
- `server/src/tts/sidecar-supervisor.test.ts` (+2 tests): `onTrip` fires
  exactly once with the trip payload on the 3rd code-43 exit, and does NOT
  fire again on a 4th post-trip exit; a throwing `onTrip` is caught (warned,
  not propagated) and the supervisor still holds TTS down correctly.
- `server/src/routes/gpu-trip-status.test.ts` (new, 3 tests): `GET
  /api/gpu/trip-status` returns `null` pre-trip, the reverted payload, and
  the unrevertable payload — pinning the route's pass-through of
  `getTripStatus()`.
- `src/lib/use-tts-lifecycle.test.ts` (+2 tests): surfaces the reverted toast
  from the trip-status probe; surfaces the unrevertable toast and confirms
  `dismissNotices()` clears it.

All new/touched suites run green:
- `vitest run src/gpu/auto-revert.test.ts` (server) — 4 passed.
- `vitest run src/routes/gpu-trip-status.test.ts src/gpu/auto-revert.test.ts`
  (server) — 7 passed.
- `vitest run src/tts/sidecar-supervisor.test.ts` (server) — 41 passed
  (39 pre-existing + 2 new, all green).
- `vitest run src/tts/sidecar-supervisor.test.ts src/gpu src/routes/models-status.route.test.ts src/routes/sidecar-health.test.ts src/routes/gpu-trip-status.test.ts src/routes/gpu-queue.test.ts`
  (server, broad regression check for the touched surface) — 291 passed.
- `vitest run src/lib/use-tts-lifecycle.test.ts src/components/tts-notice-banner.test.tsx`
  (frontend) — 40 passed.
- `vitest run src/routes/index.test.tsx` (frontend, exercises the
  `TtsLifecycle` fixture sites) — 10 passed.
- `tsc --noEmit` (frontend root) — clean.
- `tsc --noEmit -p server` — clean.

## Mutation (task item 3)

Actually run, not just asserted. Inverted the card-specific guard in
`auto-revert.ts` from

```ts
if (trip.card === null || trip.card === undefined) {
```

to

```ts
if (!(trip.card === null || trip.card === undefined)) {
```

and re-ran `vitest run src/gpu/auto-revert.test.ts` (server workspace). All 4
tests reddened — each fixture's expected branch flipped:

```
FAIL  card-specific streak: reverts each resident engine device pin and resets+respawns
  AssertionError: expected "vi.fn()" to be called with arguments: [ 'tts.qwen.device' ]
  Number of calls: 0

FAIL  card-specific streak with no revertible engine ... still resets, reverts nothing
  AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
    expect(resetAndRespawn).toHaveBeenCalledTimes(1);

FAIL  non-card-specific streak: does NOT revert or respawn, surfaces the distinct unrevertable toast
  AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
    Received: 1st vi.fn() call: [ "tts.qwen.device" ]

FAIL  non-card-specific streak with an undefined card (degraded breadcrumb) is treated the same as null
  AssertionError: expected 'reverted' to be 'unrevertable'
```

Reverted the mutation immediately after capturing this output; re-ran the
same command and confirmed green again (4 passed) before committing. The
observed-failure block is preserved as a comment in `auto-revert.test.ts`
itself.

## Ambiguity note (per the issue's own instruction to record, not guess)

#1230 names "reverts the offending GPU pin" without specifying which knob(s)
to touch when multiple engines are resident on the same tripped card (e.g.
Kokoro + Qwen both loaded on card 1). Implemented as: revert **every**
resident engine with a device knob (`coqui`/`kokoro`/`qwen`) named in the
breadcrumb's `residentEngines`, not just one — since the streak is card-wide
(any code-43 self-exit on that card counts, regardless of which engine's
forward caused it), reverting only one pinned engine on a multi-engine card
would leave the other's pin in place to re-trip the same streak later.
`asr`/`spk` (also possible `residentEngines` entries) have no device knob and
are silently skipped — there is nothing to revert for them.

## Scope discipline

No register edit (step 9 is the sole writer). No real hardware trigger run
(step 4, next). No PR (per instructions — commit only, on this worktree's own
`docs/docs-2card-pinokio-batch` branch).
