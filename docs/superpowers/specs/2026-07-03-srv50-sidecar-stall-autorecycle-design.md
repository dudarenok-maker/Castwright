# srv-50 — Auto-recycle the TTS sidecar on a stall/readiness-timeout instead of waiting for a human

_Design spec — 2026-07-03._

## Problem

On 2026-07-03 the RTX 5070 Ti eGPU dropped off the CUDA bus mid-request (a known
hardware/driver issue — Windows `nvlddmkm` Event 153, correlated with Modern
Standby; see the `reference_egpu_5070ti_gpu_lost_cuda_poison` memory note). This
time the sidecar process **hung instead of crashing**: it stopped logging
mid-Whisper-ASR-call and never exited. Because it never exited, the exit-driven
crash-loop supervisor (`sidecar-supervisor.ts`) never fired. The chapter-level
stall watchdog (`ChapterStallError`, 720s no-progress) *did* eventually fire and
correctly failed the stuck chapter — but its remediation is to tell a human to
restart the sidecar; it never touches the process itself. Net effect: the
wedged process squatted on `:9000` (and ~4GB of VRAM) for **~25 minutes** of
silent `ECONNREFUSED`, and every fresh spawn attempt from a restarted server
failed immediately because the zombie still held the port — until it was found
and `taskkill`'d by hand.

This spec closes that gap: when the system has strong evidence the sidecar is
unresponsive (not just slow), it force-kills and lets the existing supervisor
respawn it automatically, instead of leaving a zombie for a human to find.
Tracked as GitHub issue [#1243](https://github.com/dudarenok-maker/Castwright/issues/1243),
`docs/BACKLOG.md` `srv-50`.

## Current state (verified against the codebase)

- **The kill+respawn primitive already exists and is reused, not built.**
  `POST /api/sidecar/restart` (`server/src/routes/sidecar-health.ts:425`) does
  exactly this today, manually: `supervisor.current()?.kill()`, which runs
  `taskkill /PID <pid> /T /F` (`spawn-sidecar.ts` — force + tree, so it works
  even on a fully wedged process, since it doesn't depend on the target
  cooperating). The kill triggers the child's real OS exit, which the
  supervisor's already-registered `onChildExit` handler
  (`sidecar-supervisor.ts:292`) picks up and respawns with the existing
  backoff (`[2s, 5s, 15s]`) and crash-loop cap (5 consecutive fast deaths →
  "TTS is DOWN", independent of a separate code-43-specific streak cap). No
  new cap logic is needed anywhere in this spec — every path below funnels
  through this one real process exit, so the existing cap already protects
  against a kill-loop.
- **`getActiveSupervisor()` is already called directly from route/business
  logic outside `sidecar-health.ts`** — `server/src/routes/queue.ts:59`
  does `const supervisor = getActiveSupervisor(); supervisor?.recycling()`.
  Same idiom this spec reuses.
- **The readiness gate already polls and already gives up silently.**
  `ensureSidecarEngineReady` (`server/src/tts/ensure-sidecar-loaded.ts:118`)
  polls `GET /health` every 1.5s for up to `READINESS_TIMEOUT_MS` = 210s
  (sized generously — the comment at line 50 notes it's meant to "comfortably
  cover a full recycle": drain + respawn backoff + fresh model load). On
  exhaustion it just logs `readiness ${engine}: sidecar not ready after
  ${timeoutMs}ms (last: ${lastReason}) — proceeding to lazy load.` and returns
  — the exact "readiness … sidecar not ready" lines seen in the 2026-07-03
  incident log. This function is called from **two** places in
  `generation.ts`: the pre-chapter preload gate (~line 1202) and the in-chapter
  recovery hook `onRecoverRecycle` (~line 1456, wired from
  `synthesise-chapter.ts`'s `withRecycleRecovery`). Fixing this one function
  covers both call sites.
- **`withRecycleRecovery`** (`synthesise-chapter.ts:929`) wraps every synth
  call site (title, anchor, pool items) in a retry loop: on a transient error
  or `ChapterSynthTimeoutError`, it calls `onRecoverRecycle` (→
  `ensureSidecarEngineReady`) up to `maxRecycleRecoveries` (default 2) times,
  then throws `RecycleStormError`.
- **The ASR content-QA `verify()` call is the one call site with no
  protection at all.** `synthesise-chapter.ts:1619` calls `verify(r.pcm,
  r.sampleRate, group)` directly — not wrapped in `withCallTimeout` (the
  existing per-call-ceiling helper at line 1119, already used by every synth
  call site to bound a call and reject with `ChapterSynthTimeoutError` on
  timeout) and not wrapped in `withRecycleRecovery`. This is exactly the call
  that hung in the 2026-07-03 incident: because it never throws, nothing
  downstream (recovery loop, recycle counter) ever gets a chance to run —
  only the coarse 720s whole-chapter `ChapterStallError` eventually caught it.
  `verifySegmentTranscript` (`segment-asr-qa.ts:653`) already accepts a
  `signal` option and forwards it to the actual transcribe call, so wiring a
  derived per-call abort signal through is a plumbing change, not new
  infrastructure.
- **`ChapterStallError`** (`synthesise-chapter.ts:141`, thrown from
  `generation.ts:1681`) is the whole-chapter 720s-no-progress catch-all. It
  covers both `stallPhase: 'synthesis'` and `stallPhase: 'assembly'`
  (post-synth ffmpeg/encode work, which never touches the sidecar).
- **`RecycleStormError`** (`synthesise-chapter.ts:159`) already fires after
  `maxRecycleRecoveries` in-loop recoveries are exhausted. The existing
  `reference_egpu_5070ti_gpu_lost_cuda_poison` memory documents that this is
  the FAST crash-loop shape (CUDA poisoned instantly, `code 43` storm) — every
  freshly-respawned worker is immediately "ready" per `/health` but poisoned,
  so `ensureSidecarEngineReady` returns `ready:true` quickly each time and
  never hits its own timeout-exhaustion branch. The existing code comment
  ("Auto-recycle can't help — every fresh worker is born poisoned … the cap is
  by design") confirms this is already a deliberate fail-fast, not a gap.

## Decisions

1. **Two hook points, not three.** Force-recycle triggers at (a)
   `ensureSidecarEngineReady`'s readiness-timeout exhaustion, and (b)
   `ChapterStallError` when `stallPhase === 'synthesis'`. **Not** at
   `RecycleStormError` — by the time it fires, hook (a) has already had every
   opportunity to force-recycle (each `onRecoverRecycle` call routes through
   `ensureSidecarEngineReady`), and the fast-poisoned-worker shape it's built
   for is explicitly a case where recycling doesn't help (see above) — adding
   a redundant kill there would just extend a run that's already correctly
   failing fast.
2. **`ChapterStallError` only force-recycles on `stallPhase === 'synthesis'`.**
   An `'assembly'`-phase stall (e.g. a wedged ffmpeg) is not a sidecar
   problem; killing the sidecar wouldn't fix it and would be a pointless,
   confusing side effect.
3. **A single shared, guarded helper**, not per-call-site duplication:
   `forceSidecarRecycle(reason: string): Promise<boolean>` in
   `sidecar-supervisor.ts`. Guards: no-op (`false`) if there's no active
   supervisor, and no-op if `supervisor.recycling()` is already true (a
   recycle is already in flight — avoids redundant concurrent kills when
   multiple chapters/workers hit the same wedged process around the same
   time). Otherwise kills the current handle and returns `true`. It does
   **not** wait for the respawn to become healthy — callers already have
   their own post-recycle polling (the readiness gate re-polls on its next
   loop iteration; `withRecycleRecovery`'s caller retries the work item).
4. **The 210s readiness budget is unchanged.** It was already sized to
   "comfortably cover a full recycle," so exhausting it is already a strong
   wedge signal, not just a slow cold load. No new timing constant is
   introduced for this trigger.
5. **ASR call timeout mirrors the existing synth-call pattern exactly**:
   reuse `withCallTimeout` (no new timeout mechanism) with the same
   `callTimeoutMs` (default `SYNTH_CALL_TIMEOUT_MS`, 600s) applied to synth
   calls, and route the resulting `ChapterSynthTimeoutError` through
   `withRecycleRecovery` the same way every synth call site already does —
   not a shorter, ASR-specific timeout. Simplest change that closes the gap;
   a tighter ASR-specific ceiling is not justified by any evidence in this
   incident (the ASR call in question had no natural time budget to compare
   against — the point is that it must fail *eventually*, not fail fast).

## Design

### 1. `forceSidecarRecycle` helper (`server/src/tts/sidecar-supervisor.ts`)

```ts
/** Force-kill the current supervised sidecar child so the existing
    onChildExit → backoff → respawn path brings up a fresh process. Used when
    the caller has strong evidence the sidecar is wedged (not merely slow) —
    a readiness-poll exhausted its full budget, or a chapter made zero
    progress for the full stall window. Reuses the exact primitive
    `POST /api/sidecar/restart` already uses (`handle.kill()`), so the
    existing crash-loop cap applies automatically — this function adds no new
    cap logic. Returns false (no-op) when there's no active supervisor or a
    recycle is already in flight, so concurrent callers don't pile up
    redundant kills on the same dying process. */
export async function forceSidecarRecycle(
  reason: string,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<boolean> {
  const supervisor = getActiveSupervisor();
  if (!supervisor || supervisor.recycling()) return false;
  const handle = supervisor.current();
  if (!handle) return false;
  warn(`[sidecar] forced recycle: ${reason}`);
  await handle.kill();
  return true;
}
```

### 2. `ensureSidecarEngineReady` escalates on exhaustion (`ensure-sidecar-loaded.ts:143-148`)

```ts
if (Date.now() >= deadline) {
  console.warn(
    `[generation] readiness ${engine}: sidecar not ready after ${timeoutMs}ms (last: ${lastReason}) — proceeding to lazy load.`,
  );
  await forceSidecarRecycle(`readiness poll for ${engine} exhausted ${timeoutMs}ms (last: ${lastReason})`);
  return;
}
```

Covers both call sites in `generation.ts` (pre-chapter preload gate,
in-chapter `onRecoverRecycle`) with one change, per Decision-supporting
current-state note above.

### 3. `ChapterStallError` force-recycles on a synthesis-phase stall (`generation.ts`, inside the existing `isStall` branch, ~line 1747)

```ts
if (isStall) {
  console.error(
    `[generation] chapter ${chapter.id} (${chapter.slug}) STALLED during ${stallPhase}: ` +
      `no progress for ${Math.round(noProgressMs / 1000)}s — recorded as failed so the queue advances.`,
  );
  if (stallPhase === 'synthesis') {
    await forceSidecarRecycle(`chapter ${chapter.id} stalled ${Math.round(noProgressMs / 1000)}s during synthesis`);
  }
}
```

### 4. ASR `verify()` call gets a timeout + recovery wrap (`synthesise-chapter.ts:1619`)

Before:

```ts
const { value: verdict, ms: tMs } = await timed(() => verify(r.pcm, r.sampleRate, group));
```

After — reuse the existing `withCallTimeout` + `withRecycleRecovery` helpers
already in scope in this function, same pattern every synth call site uses:

```ts
const { value: verdict, ms: tMs } = await timed(() =>
  withRecycleRecovery(resolveGroup(group).route.engine, () =>
    withCallTimeout('asr-verify', (sig) => verify(r.pcm, r.sampleRate, group, sig)),
  ),
);
```

`verify`'s signature (the local closure at line 1587) widens to accept and
forward an optional per-call signal to `verifySegmentTranscript`'s existing
`signal` option, in place of the outer chapter `signal` it uses today —
mirroring exactly how every synth call site already threads
`withCallTimeout`'s derived signal through to its provider call. A timeout
here throws `ChapterSynthTimeoutError`, which `withRecycleRecovery` already
treats as recoverable (Section: Current state, `withRecycleRecovery`), so it
flows into the exact same recovery/`RecycleStormError` machinery synth calls
already have — including, transitively, hook (2)'s force-recycle when that
recovery's `ensureSidecarEngineReady` wait itself exhausts.

### 5. Repeated-recycle guard

None needed beyond what already exists (Decision 3 / current-state note on
the crash-loop cap) — every force-recycle is a real process exit through the
same `onChildExit` path the existing exit-driven supervisor already caps at 5
consecutive fast deaths. A genuinely unrecoverable case (e.g. the eGPU still
lost) still correctly surfaces "TTS is DOWN" rather than looping forever.

## Edge cases

- **Multiple chapters/workers hit the readiness timeout around the same
  moment on the same wedged sidecar**: the `supervisor.recycling()` guard in
  `forceSidecarRecycle` means only the first caller actually kills; the rest
  no-op and their own subsequent polls see the fresh process once it's up.
- **A legitimately slow first-time cold load** (e.g. Coqui's ~90s pull) still
  completes well inside the 210s budget — unaffected.
- **The eGPU is still lost when the fresh respawned process comes up**: the
  new process re-poisons immediately (per the existing
  `reference_egpu_5070ti_gpu_lost_cuda_poison` mechanism) and the existing
  crash-loop cap (not this spec) takes over, same as today.
- **`stallPhase === 'assembly'`**: no force-recycle (Decision 2) — the
  chapter still fails and the queue still advances, unchanged from today.
- **No active supervisor** (autoStart off, or an adopted-not-owned sidecar):
  `forceSidecarRecycle` no-ops (`false`) at every call site — behavior is
  identical to today (log-and-continue) in that configuration.

## Testing

- `sidecar-supervisor.test.ts`: new coverage for `forceSidecarRecycle` — kills
  the current handle and returns `true`; returns `false` (no kill) when no
  active supervisor; returns `false` (no kill) when `recycling()` is already
  true.
- `ensure-sidecar-loaded.test.ts`: simulate a health check that never resolves
  `ready:true` within the (test-shortened) timeout budget; assert
  `forceSidecarRecycle` (injected/mocked) is called on exhaustion, and is
  **not** called when readiness resolves before the deadline.
- `generation.ts`'s stall-watchdog test coverage: assert a `'synthesis'`-phase
  `ChapterStallError` triggers a recycle call and an `'assembly'`-phase one
  does not.
- `synthesise-chapter.test.ts`: a `verify()` call that hangs past
  `callTimeoutMs` throws `ChapterSynthTimeoutError` and is retried via
  `onRecoverRecycle` exactly like a hung synth call; a normal in-budget ASR
  call is unaffected (same verdict/WER as before the wrap).
- Manual/on-box verification (noted in the plan, not automatable): confirm
  `curl :9000/health` recovers automatically after simulating a hang (e.g. a
  `SIGSTOP`-equivalent pause on the sidecar process on a platform that
  supports it, or a mocked never-resolving `/health` in a controlled local
  run), without a manual process kill or full server restart.

## Out of scope

- Any change to the 210s readiness budget or the 600s synth-call timeout
  constants.
- A standalone/independent liveness watchdog polling outside of an active
  chapter or readiness-gate call (Approach 1, rejected in the design
  discussion — no evidence of a gap between chapters that this spec's two
  hook points don't already cover).
- Force-recycling on `RecycleStormError` (Decision 1) — already correctly
  fail-fast for its target scenario.
- A tighter, ASR-specific call timeout shorter than the existing
  `SYNTH_CALL_TIMEOUT_MS` (Decision 5).
