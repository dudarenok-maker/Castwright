---
status: draft
---

# Cast design job — GPU-contention hardening and honest progress display

## 1. Summary

Observed live (screenshot, book "La Commande de Coalfall", a French manuscript): the "Design full
cast" bulk job's status pill read **"Designing · 0/16 · 94%"** — zero characters actually designed,
yet the progress bar read as nearly complete. Root-caused via static code investigation to two
separate defects that compound:

1. **Display defect.** `DesignPill`'s `percent` (`src/components/layout.tsx:1449-1450`) is computed
   from `(done + skipped + failures.length) / total`, but the `X/Y` text next to it shows `done/total`
   only. When a run is failing almost every character, `done` stays near 0 while `percent` still climbs
   toward 100 — the two numbers in one label tell contradictory stories.
2. **Hardening defect (the actual bug worth fixing).** `/qwen/design-voice`
   (`server/tts-sidecar/main.py:5514-5589`) catches *any* exception from `design_voice`, including a
   `torch.cuda.OutOfMemoryError` caused by VRAM contention (e.g. another session's generation/analysis
   run holding the GPU) — and unlike four sibling sidecar routes, never checks whether that error should
   trigger the sidecar's own CUDA-poison-recovery restart. It collapses straight to
   `{"detail": "Internal error."}` / 500. The real cause is logged server-side (`log.exception`) but
   never reaches the client, and the restart that would let the *next* attempt succeed never fires. On
   the Node side,
   `cast-design.ts`'s bulk-job loop only recognizes *connection-level* failures
   (`SIDECAR_DOWN_RE = /unreachable|did not complete within|stopped responding/i`) as "systemic — worth
   riding out"; a GPU-OOM/contention failure doesn't match, so it's recorded as an ordinary per-character
   failure and the loop moves on to the next character — which fails identically, all the way through
   the queue, silently, with no clear signal to the user about why.

This spec fixes both, reusing existing plumbing rather than inventing new mechanisms. **Revised after an
adversarial `assumption-checker` pass** (see §6) that found the original draft invented a "plain,
non-poisoning OOM" category that contradicts this codebase's own established policy: `_CUDA_POISON_RE`
(`main.py:498-503`) already classifies *any* `"CUDA out of memory"`-shaped message as poison, requiring
the existing supervised-restart mechanism (`_mark_cuda_poisoned`, exit code 42) — the same four other
call sites (`/transcribe`, `/embed`, and two more) already do this. The revised design brings
`/qwen/design-voice` **and** `/qwen/mint-variant` (both currently missing this check entirely — a wider
pre-existing gap than first thought) up to that same standard, with one deliberate, small deviation: a
clearer, more actionable `detail` message than those routes' generic `"Internal error."`, since a
16-character bulk job silently grinding on this is much higher-stakes than a single transcribe/embed
call. Separately, the Node-side `GpuBusyError` class (no sidecar restart involved — just a same-process
eviction refusal) gets its own short, explicit, bounded wait, because reusing the sidecar's
health-poll ride-out for it would either not wait at all (health is already "ready") or, worse, risk
silently dropping the character's accounting if a second `GpuBusyError` fires during that wait (a
latent bug the review surfaced in the existing ride-out's abort-handling, fixed here as it's directly in
the code path being extended).

## 2. Goals

- A GPU-contention failure during "Design full cast" produces a **clear, actionable, user-facing
  message** ("GPU is out of memory — likely another job is using it. Free up GPU memory and try
  again.") instead of a silent string of per-character failures or an opaque "Internal error."
- The job **rides out a brief, bounded contention** before giving up — a few seconds/tens-of-seconds of
  contention from another job finishing up (or a poison-triggered sidecar respawn) shouldn't abort a
  whole 16-character run. Bounded by the existing `MAX_RECYCLE_RIDEOUTS = 2` retry-the-current-character
  loop either way; the two systemic-error classes (§4.2) each get a wait mechanism that actually fits
  what they're waiting for — polling `/health` for a sidecar restart, an explicit short sleep for a
  same-process GPU-busy refusal.
- If contention persists past the ride-out, the job **halts the whole run** rather than grinding through
  every remaining character with the same doomed attempt — mirroring the existing `sidecar_unavailable`
  halt path exactly, just with a second, distinct cause/code for the GPU-busy class.
- Genuinely per-character failures (bad persona text, an encode failure, a validation error) are
  **unaffected** — still recorded, job keeps going, exactly like today. The breaker only trips on the
  classified systemic-error family.
- The status pill's percentage **never implies progress a failed attempt didn't make** — a failure no
  longer inflates `percent`, and the running-state label surfaces the failure count inline instead of
  hiding it until the terminal toast.

## 3. Non-goals

- **No pre-flight capacity/health check before the job starts.** Considered and rejected (see design
  discussion) — it can't help with contention that begins *mid-run* (the actual scenario here: another
  session starts a GPU job after "Design full cast" is already under way), so it adds a new check
  surface for narrow extra coverage. The ride-out-then-halt loop already covers both the "busy at start"
  and "busy partway through" cases uniformly.
- **No automatic retry of a halted job.** Once halted, the user re-triggers "Design full cast" manually
  (already-designed characters are freshness-skipped on the retry — no wasted work, per the existing
  `job.skipped` mechanism).
- **No change to single-character design** (`beginSingle`/the cast-drawer flow). Its failure mode is
  different — a single attempt either succeeds or the user sees one error immediately; there's no
  "silently grind through 16 more" scenario to harden against. Out of scope.
- **No change to `_ensure_base17_for_mint`'s own OOM re-raise** (`main.py:2149-2166`) — it already does
  the right thing (re-raises OOM unchanged instead of masking it as a fallback-eligible
  `Base17UnavailableError`). This spec adds a poison check to the route handler the re-raise lands in
  (`/qwen/mint-variant`'s outer `except Exception`, §4.1) — it doesn't touch the re-raise itself.
- **No new mechanism for `base17-unavailable` (not-installed/corrupt 1.7B-Base).** That's a permanent
  condition, not transient contention — retrying it can never succeed, so it must stay classified as an
  ordinary per-character failure. §4.2's classifier is deliberately precise (`code === 'gpu_poisoned'` /
  `'GPU_BUSY'`, not a blanket "any 503") specifically so it never misclassifies this.
- **No e2e/on-box live-GPU-contention regression test.** Reliably forcing real VRAM contention in CI is
  flaky and slow to reproduce on demand; coverage is via mocked/injected error responses at the sidecar
  HTTP layer and the Node job-loop layer (see §5).

## 4. Architecture

### 4.1 Sidecar — bring OOM/poison handling to parity across all four `qwen.py` route handlers (`server/tts-sidecar/main.py`)

`/qwen/design-voice` (~line 5573-5589) and `/qwen/mint-variant` (~line 5679-5681) are, today, the *only*
two of the sidecar's six exception-prone routes with **no `_CUDA_POISON_RE` check at all** —
`/transcribe`, `/embed`, and two others already classify a poisoning CUDA error (which includes any
`"CUDA out of memory"`-shaped message — see `_CUDA_POISON_RE`, `main.py:498-503`) and call
`_mark_cuda_poisoned` to schedule the supervised exit-42 restart. Both design routes instead swallow
*any* exception, poison included, into a bare `{"detail": "Internal error."}` 500 — so today a GPU-OOM
during "Design full cast" doesn't even trigger the restart that would let the *next* attempt succeed
once the contending job frees memory; the sidecar just sits there with a doomed embedding half-done, and
every remaining character in the queue repeats the identical failure.

Fix: add the same check, verbatim pattern, to both routes' `except Exception` blocks — with one
deliberate deviation from the other four sites' `detail` text (`"Internal error."`), since a silent
16-character bulk job is much higher-stakes than a single transcribe/embed call:

```python
# server/tts-sidecar/main.py — qwen_design_voice's except block (~5587) and
# qwen_mint_variant's except block (~5679), same snippet in both:
except Exception as e:
    err_str = f"{e}"
    if _CUDA_POISON_RE.search(err_str):
        log.warning("/qwen/design-voice CUDA poison (voiceId=%s): %s", voice_id, e)
        _mark_cuda_poisoned(err_str)
        return JSONResponse(
            {
                "detail": (
                    "GPU is out of memory — likely another job (generation/analysis/design) "
                    "is using it. Free up GPU memory and try again."
                ),
                "poisoned": True,
                "code": "gpu_poisoned",
            },
            status_code=503,
        )
    log.exception("/qwen/design-voice failed (voiceId=%s)", voice_id)
    return JSONResponse({"detail": "Internal error."}, status_code=500)
```

(`/qwen/mint-variant`'s copy logs with `baseVoiceId=%s` instead, matching its existing log line.)

`code: "gpu_poisoned"` is new — added purely so the Node classifier in §4.2 can key on it precisely,
same idiom `base17-unavailable` already uses for its own `code`. `poisoned: true` is kept alongside it
only for consistency with the other four sites' existing shape (harmless, not required by any Node
logic).

This is genuinely a **poison** classification, not a "stays up, just wait" one: `_CUDA_POISON_RE`
already treats `"CUDA out of memory"` as corrupting the shared process-wide CUDA context (the file's own
comment, `main.py:495-497`, is explicit that over-classifying here is deliberate and harmless — "we
never want to MISS a poison"). `_mark_cuda_poisoned` is documented as "safe to call from any engine /
any concurrent in-flight request" (`main.py:582-583`), so calling it from these two routes is exactly
the pattern it was built for, not a new one. `/health`'s existing `poisoned` field
(already polled by `ensureSidecarEngineReady`, see §4.2) means the restart-and-recover cycle Just
Works once these two routes start participating in it.

`_ensure_base17_for_mint`'s existing OOM re-raise (`main.py:2158-2166`, unchanged by this spec) lands in
`/qwen/mint-variant`'s outer `except Exception` — so hardening that one handler covers both the
base-design and the mint-variant path with the same fix.

Everything that isn't a poison match keeps falling through to the existing generic 500 (still fully
logged server-side via `log.exception`) — an unexpected, unclassified bug should NOT trip the new
systemic-halt breaker in §4.2; it stays a per-character failure like today.

### 4.2 Node — two ride-out paths for two genuinely different systemic-error shapes (`server/src/routes/cast-design.ts`)

The bulk job loop already has the right shape for this (comment at `cast-design.ts:86-92` documents
the exact rationale this spec extends): a per-character `catch` classifies the error, and either rides
it out (retry same character, bounded by `MAX_RECYCLE_RIDEOUTS = 2`) or records-and-continues. Today
only `SIDECAR_DOWN_RE`-matching messages trigger the ride-out path. This spec recognizes two more,
**each needing a different wait mechanism** because they mean different things:

1. **Sidecar restarting** — `SIDECAR_DOWN_RE` match (widened below) OR the new `code === 'gpu_poisoned'`
   (§4.1). The sidecar process is down or about to be; the right wait is the *existing*
   `ensureSidecarEngineReady` health-poll, which already treats a `poisoned: true` `/health` response as
   "keep waiting" — no new wait mechanism needed here, the existing one already does the right thing
   once §4.1 makes the sidecar actually report this class correctly.
2. **GPU busy, no restart involved** — `code === 'GPU_BUSY'`, the Node-side `GpuBusyError` thrown by
   `withGpuLoad` (`server/src/gpu/gpu-load.ts:10-16`) when the design call can't even get GPU room
   because the local Ollama analyzer is resident and busy. The sidecar was never contacted and isn't
   restarting, so polling its `/health` would resolve "ready" near-instantly — not a real wait, and not
   what Goal 2 means by "ride out a brief contention." This class gets an explicit, bounded sleep instead
   (new, small, matches the existing abort-aware `sleep(ms, signal)` idiom already duplicated in
   `ensure-sidecar-loaded.ts:217`, `retry.ts:103`, `analyzer/gemini.ts:821` — one more local copy,
   following the same established per-file convention rather than introducing a shared export).

```ts
// SIDECAR_DOWN_RE (cast-design.ts:97) widens to also recognize the existing
// drain-fence "recycling" 503 (main.py:5567-5571 / 5644-5648) — its message
// ("Voice engine is recycling to free memory; retry shortly.") doesn't match
// today's pattern, so that transient case is ALSO currently mis-treated as an
// ordinary per-character failure; a one-token fix, verified while auditing
// every 503 shape this route can return (per the assumption-checker pass).
const SIDECAR_DOWN_RE = /unreachable|did not complete within|stopped responding|recycling/i;

const GPU_BUSY_RIDEOUT_MS = 5_000; // one short wait between the two bounded retries

function isSidecarRestartClass(e: unknown, message: string): boolean {
  return SIDECAR_DOWN_RE.test(message) || (e as { code?: string })?.code === 'gpu_poisoned';
}
function isGpuBusyClass(e: unknown): boolean {
  return (e as { code?: string })?.code === 'GPU_BUSY';
}
```

Deliberately **not** a blanket `status === 503` check — `/qwen/mint-variant`'s existing
`base17-unavailable` response (`main.py:5669-5678`) is *also* a 503, but it means "the 1.7B-Base model
isn't installed or is corrupt," a permanent condition retrying can never fix. Keying on the specific
`code` values instead of the HTTP status keeps that case correctly falling through to the ordinary
per-character failure path, unaffected by this spec (see Non-goals).

The existing per-character retry loop (`cast-design.ts:404` onward) restructures from one branch to
two:

```ts
if (isSidecarRestartClass(e, message)) {
  if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
    rideouts += 1;
    broadcast(job, { type: 'heartbeat', characterId });
    try {
      await ensureSidecarEngineReady('qwen', job.controller.signal);
    } catch (waitErr) {
      // Bug fix (found during review): the original code unconditionally
      // treated ANY throw from the wait as "run was paused/cancelled" and
      // broke out silently — dropping this character from done/skipped/
      // failures entirely. ensureSidecarEngineReady wraps withGpuLoad, which
      // CAN throw GpuBusyError (analysis contention) during the wait itself,
      // not just an AbortError. Only a genuine run-level abort is a clean
      // stop; anything else just retries (rideouts is already bounded above).
      if (job.controller.signal.aborted) break;
    }
    continue; // retry this character
  }
  clearInterval(heartbeat);
  endJob(job, {
    type: 'error',
    code: 'sidecar_unavailable',
    message: `${message} (${job.done} of ${job.total} designed before this happened.)`,
  });
  return;
} else if (isGpuBusyClass(e)) {
  if (!job.controller.signal.aborted && rideouts < MAX_RECYCLE_RIDEOUTS) {
    rideouts += 1;
    broadcast(job, { type: 'heartbeat', characterId });
    try {
      await sleep(GPU_BUSY_RIDEOUT_MS, job.controller.signal);
    } catch {
      break; // aborted during the wait — clean stop, outer loop's abort-check ends the job
    }
    continue; // retry this character
  }
  clearInterval(heartbeat);
  endJob(job, {
    type: 'error',
    code: 'gpu_contention',
    message: `${message} (${job.done} of ${job.total} designed before this happened.)`,
  });
  return;
}
/* Per-character failure — record it and move on. (unchanged) */
job.failures.push({ characterId, name: character.name ?? characterId, error: message });
```

Two distinct `code`s are kept on the final `endJob` — `sidecar_unavailable` (unchanged name; now also
covers the poison-restart case, which conceptually *is* "the sidecar is down/restarting") and
`gpu_contention` (new, GPU-busy-no-restart case) — per explicit decision, useful for logs/tests to tell
the two apart even though client-side handling is identical either way. The completion-count suffix on
both messages is the concrete answer to "should fail nicely and tell the user": the halt message says
both *why* and *how far it got*.

No other client-side change is needed for the halt itself: `onError` in
`cast-design-stream-middleware.ts:131-140` already dispatches `castDesignActions.halt(...)` and a
`pushToast({ kind: 'error', message, ... })` for any `endJob` error event, regardless of `code` — the
existing rose-colored "Halted" pill state and error toast just start firing correctly for both new
cases.

Non-systemic errors (anything not matching either classifier — including `base17-unavailable`, bad
persona text, an encode failure) are completely unaffected: `job.failures.push(...)`,
`character_failed` broadcast, loop continues — identical to today.

### 4.3 Frontend — stop counting failures as progress (`src/components/layout.tsx`, `src/components/top-bar.tsx`)

`layout.tsx:1449-1450`:

```ts
// before
const completed = done + skipped + failures.length;
const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

// after
const completed = done + skipped;
const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
```

A skip is still legitimate completion (the character already had a voice — no work was needed, per the
existing intent documented at `cast-design-slice.ts:64-66`). A failure is not completion and must not
inflate the bar.

`top-bar.tsx:1043-1053`, the running-state summary gains the failure count inline instead of hiding it
until the terminal toast:

```ts
// before
: `${done}/${total}${total > 0 ? ` · ${percent}%` : ''}`;

// after
: `${done}/${total}${failureCount > 0 ? ` · ${failureCount} failed` : ''}${total > 0 ? ` · ${percent}%` : ''}`;
```

`failureCount` is already threaded into `DesignPillData` (`data.failureCount`, used today only in the
terminal `'done'` branch) — this just also renders it in the `'running'` branch.

With §4.1-4.2 landed, a systemic run now halts after at most a few characters instead of grinding to
~94% — so this display fix mainly matters for the legitimate "job keeps going with a handful of
unrelated per-character failures" case. It's cheap and correct to fix regardless of how rare the
misleading-94% case becomes.

## 5. Testing

- **Sidecar (pytest, `server/tts-sidecar/tests/`):**
  - `design_voice` raises a `torch.cuda.OutOfMemoryError`-shaped exception (mocking the underlying call,
    same style as existing poison-path tests for `/transcribe`/`/embed`) → asserts the HTTP response is
    503 with `code: "gpu_poisoned"`, `poisoned: true`, and the new clear detail — not the generic 500
    "Internal error." — and that `_mark_cuda_poisoned` was actually invoked (process-poisoned state
    flips, matching the existing assertions used for `/transcribe`'s equivalent test).
  - Same case repeated for `mint_variant` (via `/qwen/mint-variant`) — confirms the fix covers both
    routes, not just design-voice (the gap the review surfaced was wider than the original draft).
  - A non-OOM, non-poison exception on both routes still returns the generic 500 unchanged (regression
    guard for the narrow `_CUDA_POISON_RE` classification — an unrelated bug must not trip the restart).
- **Server (Vitest, `server/src/routes/cast-design.test.ts` or sibling):**
  - A design job where every sidecar attempt returns the new 503/`gpu_poisoned` response, with a mocked
    `/health` that reports `poisoned: true` then flips to ready after N polls: assert it rides out
    `MAX_RECYCLE_RIDEOUTS` times via `ensureSidecarEngineReady` (not a raw sleep), then — if still
    failing — halts via `endJob` with `code: 'sidecar_unavailable'`, a message containing the
    `done`/`total` counts, and confirms the remaining characters in the queue were never attempted.
  - A parallel case where `designQwenVoiceForCharacter` throws `GpuBusyError` (`code: 'GPU_BUSY'`):
    asserts the ride-out uses the new bounded `sleep`, not `ensureSidecarEngineReady`, then halts with
    `code: 'gpu_contention'` after exhausting retries.
  - **Regression test for the abort-handling bug found in review:** during a sidecar-restart ride-out's
    wait, `ensureSidecarEngineReady` throws a non-abort error (e.g. `GpuBusyError`, simulating analysis
    contention firing mid-wait) while `job.controller.signal` is NOT aborted — asserts the character is
    retried (not silently dropped: `job.done + job.failures.length` must eventually account for it,
    never vanish from the total).
  - A regression case: `base17-unavailable` (503, from a real `/qwen/mint-variant` response) is NOT
    treated as systemic — records to `job.failures` immediately, no ride-out attempted, loop continues.
  - A regression case: a per-character failure with an unrelated message/status (e.g. a validation-style
    error) still records to `job.failures` and the loop continues to the next character, unaffected.
- **Frontend (Vitest, `layout.tsx`/`top-bar.test.tsx`):** percent-formula test — `done=0, skipped=0,
  failures.length=15, total=16` → `percent` is `0`, not `94`; a mixed case (`done=2, skipped=3,
  failures.length=1, total=6`) confirms skips still count (`percent = 83`) and the running label shows
  `"2/6 · 1 failed · 83%"`.
- No e2e coverage added — see §3 (non-goals) for why.

## 6. Adversarial review findings

An Opus `assumption-checker` pass (per CLAUDE.md's mandatory Premium-tier spec-review gate) verified
every cited file/line/code-shape claim against the real code (all confirmed accurate) and the "0/16 ·
94%" display-bug arithmetic (confirmed exact). It surfaced three issues that reshaped §4, all folded into
the sections above rather than left as open questions:

1. **The reused ride-out wait didn't actually wait, for the case the spec cared about most.**
   `ensureSidecarEngineReady` only polls `/health`; a plain (non-restarting) OOM leaves the sidecar
   reporting "ready" instantly, so the original design's "ride out briefly" was, in practice, two
   near-instant retries. Resolved by finding #2 below rather than by inventing a new wait for this case.
2. **The original "non-poisoning OOM" category contradicted the codebase's own policy.** `_CUDA_POISON_RE`
   already treats any `"CUDA out of memory"` message as poison, process-wide, at four other call sites.
   The spec now brings `/qwen/design-voice` and `/qwen/mint-variant` to that same standard instead of
   diverging (§4.1) — which also resolves #1, since a poison-triggered restart is exactly what
   `ensureSidecarEngineReady`'s health-poll is built to wait through.
3. **A latent accounting bug in the existing ride-out's abort handling**, made meaningfully more
   reachable by this spec widening how often ride-out fires: `catch { break }` around the wait treated
   *any* thrown error as a clean pause, silently dropping the in-progress character's accounting if the
   thrown error was actually a `GpuBusyError` (via `ensureSidecarEngineReady`'s own `withGpuLoad` wrap)
   rather than a genuine run-level abort. Fixed in §4.2 (only a real `job.controller.signal.aborted`
   breaks cleanly now) and covered by a dedicated regression test in §5.

Two more findings were considered and addressed by narrowing the design rather than expanding it:
mint-variant's `base17-unavailable` 503 could have been misclassified as GPU contention under a naive
"any 503 is systemic" rule — the classifier keys on specific `code` values instead (§4.2); and the
mint-variant OOM path (originally a stated non-goal) is now in scope for the same fix as design-voice,
since the review confirmed it shares the identical gap and the real screenshot that motivated this spec
involved a scope mixing both base and variant work.

## 7. Ship notes

_(filled in at merge time)_
