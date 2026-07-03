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
  `reference_egpu_5070ti_gpu_lost_cuda_poison` memory documents the FAST
  crash-loop shape (CUDA poisoned instantly, `code 43` storm) — every
  freshly-respawned worker is immediately "ready" per `/health` but poisoned,
  so `ensureSidecarEngineReady` returns `ready:true` quickly each time and
  never hits its own timeout-exhaustion branch; the existing code comment
  ("Auto-recycle can't help — every fresh worker is born poisoned … the cap is
  by design") is correct for THAT shape. **But the sidecar offloads
  synth/ASR work via `asyncio.to_thread`** (pinned by
  `test_concurrent_synthesis.py`'s thread-pool-saturation contract), so
  `GET /health` — a separate fast async handler — keeps answering `ready:true`
  even while a specific worker thread is wedged (the exact 2026-07-03 shape:
  the process was alive and had been serving fine, only one in-flight call
  hung). For THAT shape, `ensureSidecarEngineReady` never exhausts (it's
  always "ready" fast), so a `RecycleStormError` can fire from repeated
  `ChapterSynthTimeoutError`s (each ~`SYNTH_CALL_TIMEOUT_MS`) with **no
  force-recycle ever having triggered** — see Decision 1.

## Decisions

1. **Three hook points, all needed — revised after adversarial review.**
   Force-recycle triggers at (a) `ensureSidecarEngineReady`'s readiness-timeout
   exhaustion, (b) `ChapterStallError` when `stallPhase === 'synthesis'`, and
   (c) `RecycleStormError`. The original draft of this spec argued hook (a)
   alone made (c) redundant, reasoning that "hook (a) has already had every
   opportunity to force-recycle" before `RecycleStormError` fires. **That
   reasoning is wrong**: per the Current-state note above, `/health` stays
   responsive while a single worker thread is wedged (the `asyncio.to_thread`
   offload model), so `ensureSidecarEngineReady` can report `ready:true` fast
   on every poll and never reach its exhaustion branch — meaning hook (a)
   never fires for exactly the wedged-single-call shape this spec exists to
   fix, and `RecycleStormError` can be reached with zero prior force-recycles.
   Hook (c) is the correct, direct fix for that gap — it fires once
   `maxRecycleRecoveries` (2) recovery attempts have already failed, which is
   itself sufficient evidence of a wedge regardless of which of the two known
   shapes (poisoned-fast-crash-loop vs. wedged-single-thread) is in play. For
   the poisoned-fast-crash-loop shape, an extra kill at this point is harmless
   (the process is already crash-looping every few seconds; one more kill
   changes nothing about the existing crash-loop cap taking over). For the
   wedged-single-thread shape, it's the fix. In the actual 2026-07-03
   incident, the whole-chapter 720s stall watchdog (hook (b)) happened to fire
   before two 600s `SYNTH_CALL_TIMEOUT_MS`-bounded recovery rounds could
   accumulate into a `RecycleStormError` — but that was a timing coincidence
   of the specific constants involved, not a structural guarantee; hook (c)
   removes the dependency on that coincidence.
2. **`ChapterStallError` only force-recycles on `stallPhase === 'synthesis'`.**
   An `'assembly'`-phase stall (e.g. a wedged ffmpeg) is not a sidecar
   problem; killing the sidecar wouldn't fix it and would be a pointless,
   confusing side effect.
3. **A single shared, guarded helper**, not per-call-site duplication:
   `forceSidecarRecycle(reason: string): Promise<boolean>` in
   `sidecar-supervisor.ts`. Guards: no-op (`false`) if there's no active
   supervisor. Concurrency guard — **revised after adversarial review**: the
   original draft guarded only on `supervisor.recycling()`, but that flag
   flips to `true` inside `onChildExit`, which fires asynchronously on the
   killed child's real OS exit — not synchronously when `kill()` is called.
   Two callers racing between "check `recycling()`" and "the exit event
   landing" could both pass the check and both call `kill()`. The actual harm
   of that race is low (a second `taskkill` on an already-dying/dead PID is a
   no-op; only one real process exit occurs, so `onChildExit` — and the
   crash-loop counter — still fires exactly once), but the guard is fixed
   properly rather than left as a documented gap: `forceSidecarRecycle` adds
   its own **synchronous** module-level in-flight flag, set before the first
   `await` and cleared in a `finally`, which — because JS has no preemption
   between awaits — closes the race completely rather than merely
   narrowing it. Otherwise kills the current handle and returns `true`. It
   does **not** wait for the respawn to become healthy — callers already have
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
/* Synchronous in-flight guard (module-level). Set before the first `await`
   below and cleared in `finally` — because JS has no preemption between
   awaits, this closes the race a `supervisor.recycling()`-only check would
   leave open (that flag flips inside the async onChildExit handler, AFTER
   kill() is called, not synchronously with it). */
let recycleInFlight = false;

/** Force-kill the current supervised sidecar child so the existing
    onChildExit → backoff → respawn path brings up a fresh process. Used when
    the caller has strong evidence the sidecar is wedged (not merely slow) —
    a readiness-poll exhausted its full budget, a chapter made zero progress
    for the full stall window, or in-loop recovery attempts were exhausted
    (RecycleStormError). Reuses the exact primitive `POST /api/sidecar/restart`
    already uses (`handle.kill()`), so the existing crash-loop cap applies
    automatically — this function adds no new cap logic. Returns false
    (no-op) when there's no active supervisor, a recycle is already in
    flight, or one is already known to be recovering — so concurrent callers
    don't pile up redundant kills on the same dying process. */
export async function forceSidecarRecycle(
  reason: string,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<boolean> {
  if (recycleInFlight) return false;
  const supervisor = getActiveSupervisor();
  if (!supervisor || supervisor.recycling()) return false;
  const handle = supervisor.current();
  if (!handle) return false;
  recycleInFlight = true;
  try {
    warn(`[sidecar] forced recycle: ${reason}`);
    await handle.kill();
    return true;
  } finally {
    recycleInFlight = false;
  }
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

### 4. `RecycleStormError` force-recycles too (`generation.ts`, inside the existing `isRecycleStorm` branch, ~line 1752)

```ts
} else if (isRecycleStorm) {
  const recoveries = (e as { recoveries?: number })?.recoveries ?? MAX_RECYCLE_RECOVERIES;
  console.error(
    `[generation] chapter ${chapter.id} (${chapter.slug}) RECYCLE STORM: sidecar recycled ` +
      `${recoveries}× on one chapter — recorded non-fatal. On the queue path the run is ` +
      `stopped by pausing the queue (below); the back-compat \`*\` job relies on the cascade.`,
  );
  await forceSidecarRecycle(`chapter ${chapter.id} hit a recycle storm (${recoveries} in-loop recoveries exhausted)`);
}
```

Per Decision 1, this is the fix for the wedged-single-thread shape that hook
(2) (`ensureSidecarEngineReady` exhaustion) cannot reach — `/health` staying
responsive means that hook never fires for this shape, so this is not a
redundant safety net but the primary fix for it. For the other, already-
fail-fast poisoned-worker shape, the extra kill is a harmless no-op alongside
the existing crash-loop cap.

### 5. ASR `verify()` gets a timeout + recovery wrap — both call sites, via the closure (`synthesise-chapter.ts:1587`, call sites at `:1619` and `:1646`)

The local `verify` closure (defined once at line 1587) is called from **two**
places: the initial per-sampled-group pass (line 1619) and the re-record
re-verify pass (line 1646, inside the `maxAsrRerecords` loop). Wrapping only
the first call site — as an earlier draft of this spec did — leaves the
second one exposed to the identical hang. Wrapping the closure itself instead
of either call site fixes both automatically with no call-site changes:

Before:

```ts
const verify = (pcm: Buffer, rate: number, group: SentenceGroup): Promise<AsrClassification> =>
  verifySegmentTranscript(pcm, rate, normaliseForTts(group.text, langCode), {
    language: asr.language,
    nameAllowlist: asr.nameAllowlist,
    thresholds: asr.thresholds,
    transcribeFn: asr.transcribeFn,
    sidecarUrl: asr.sidecarUrl,
    signal,
    ...(group.vocalization ? { vocalizationAllowlist: leadingVocalizationTokens(group.text) } : {}),
  });
```

After — reuse the existing `withCallTimeout` + `withRecycleRecovery` helpers
already in scope in this function, same pattern every synth call site uses.
The engine passed to `withRecycleRecovery` comes from `resolveGroup(group)`,
the same resolver every synth call site already uses to get a group's routed
engine:

```ts
const verify = (pcm: Buffer, rate: number, group: SentenceGroup): Promise<AsrClassification> =>
  withRecycleRecovery(resolveGroup(group).route.engine, () =>
    withCallTimeout('asr-verify', (sig) =>
      verifySegmentTranscript(pcm, rate, normaliseForTts(group.text, langCode), {
        language: asr.language,
        nameAllowlist: asr.nameAllowlist,
        thresholds: asr.thresholds,
        transcribeFn: asr.transcribeFn,
        sidecarUrl: asr.sidecarUrl,
        signal: sig,
        ...(group.vocalization ? { vocalizationAllowlist: leadingVocalizationTokens(group.text) } : {}),
      }),
    ),
  );
```

Both call sites (`timed(() => verify(...))` at line 1619 and line 1646) are
unchanged — they call `verify(...)` exactly as before and inherit the wrap
automatically. A timeout throws `ChapterSynthTimeoutError`, which
`withRecycleRecovery` already treats as recoverable (Section: Current state,
`withRecycleRecovery`), so it flows into the exact same recovery/
`RecycleStormError` machinery synth calls already have — including,
transitively, both hook (2)'s force-recycle (when a recovery's
`ensureSidecarEngineReady` wait itself exhausts) and hook (4)'s (when
recovery attempts are exhausted into a `RecycleStormError`).

### 6. Repeated-recycle guard

None needed beyond what already exists (Decision 3 / current-state note on
the crash-loop cap) — every force-recycle is a real process exit through the
same `onChildExit` path the existing exit-driven supervisor already caps at 5
consecutive fast deaths. A genuinely unrecoverable case (e.g. the eGPU still
lost) still correctly surfaces "TTS is DOWN" rather than looping forever.

## Edge cases

- **Multiple chapters/workers hit the readiness timeout (or a stall/storm)
  around the same moment on the same wedged sidecar**: the synchronous
  `recycleInFlight` guard in `forceSidecarRecycle` (Decision 3) means only
  the first caller actually kills; the rest no-op and their own subsequent
  polls see the fresh process once it's up.
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
  true; returns `false` (no kill, no second `taskkill`) for a second
  concurrent call while the first is still in flight (the `recycleInFlight`
  guard from Decision 3) — this is the one genuinely new race-condition test
  this spec needs, since it's the one guard that didn't already exist in some
  form.
- `ensure-sidecar-loaded.test.ts`: module-mock `forceSidecarRecycle` via
  `vi.mock('./sidecar-supervisor.js', ...)` — the same pattern already used
  by `ensure-sidecar-vram.test.ts` and `sidecar-health.test.ts` for
  `getActiveSupervisor`. Simulate a health check that never resolves
  `ready:true` within the (test-shortened) timeout budget; assert the mocked
  `forceSidecarRecycle` is called on exhaustion, and is **not** called when
  readiness resolves before the deadline.
- `generation.ts`'s stall-watchdog test coverage: assert a `'synthesis'`-phase
  `ChapterStallError` triggers a recycle call and an `'assembly'`-phase one
  does not; assert a `RecycleStormError` also triggers a recycle call
  (hook 4) — this is the case that matters most, since it's the one this
  spec's adversarial review found the original draft would have missed
  entirely for the wedged-single-thread shape.
- `synthesise-chapter.test.ts`: a `verify()` call that hangs past
  `callTimeoutMs` throws `ChapterSynthTimeoutError` and is retried via
  `onRecoverRecycle` exactly like a hung synth call — covering **both** call
  sites (the initial pass at line 1619 and the re-record re-verify pass at
  line 1646), since both now share the wrapped closure; a normal in-budget
  ASR call is unaffected (same verdict/WER as before the wrap) at both sites.
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
  discussion — no evidence of a gap between chapters that this spec's three
  hook points don't already cover).
- A tighter, ASR-specific call timeout shorter than the existing
  `SYNTH_CALL_TIMEOUT_MS` (Decision 5).

## Adversarial review outcomes

An Opus-tier `assumption-checker` pass against this spec and the actual
source files found:

1. **(Critical, fixed)** Decision 1's original rationale — that
   `ensureSidecarEngineReady`'s exhaustion (hook a) makes a `RecycleStormError`
   hook redundant — was factually wrong: the sidecar's `asyncio.to_thread`
   offload model means `/health` keeps responding while a single worker
   thread is wedged, so hook (a) never exhausts for exactly the
   wedged-single-call shape this spec targets, and a `RecycleStormError` could
   fire with zero prior force-recycles. Fixed by adding hook (4)
   (`RecycleStormError`) as a genuine third trigger, not a redundant one, and
   rewriting Decision 1 and the `RecycleStormError` current-state note to
   describe the mechanism correctly.
2. **(Significant, fixed)** The ASR wrap (original Design §4) covered only the
   call site at line 1619; a second, identical unwrapped `verify()` call at
   line 1646 (the re-record re-verify pass) was missed entirely and would
   have hung the same way. Fixed by wrapping the `verify` closure itself
   (Design §5) instead of either call site, so both inherit the fix with no
   call-site changes.
3. **(Significant, fixed)** `forceSidecarRecycle`'s only concurrency guard
   (`supervisor.recycling()`) flips asynchronously inside `onChildExit`,
   after `kill()` is already called — leaving a real race window where two
   near-simultaneous callers could both pass the check. Actual runtime harm
   was low (a redundant `taskkill` on an already-dying PID), but the stated
   guarantee was false. Fixed with a synchronous module-level
   `recycleInFlight` flag (Decision 3, Design §1) that closes the window
   completely rather than merely documenting it as low-risk.
4. **(Minor, fixed)** The original Testing section asserted
   `forceSidecarRecycle` would be "injected/mocked" without specifying a real
   seam, while the Design imported it directly with no injection parameter —
   an untestable claim. Fixed by specifying the actual mechanism
   (`vi.mock('./sidecar-supervisor.js', ...)`, the same pattern already used
   elsewhere in this codebase for `getActiveSupervisor`).
5. **(Confirmed, no change)** All cited line numbers, function names, and
   signatures were verified accurate against the current source.
