/* Reusable no-capacity retry loop (Task 5, #1720). Extracted from
   SidecarTtsProvider.postWithCapacityRetry so both the /synthesize path and
   the sidecar-load admission path (Task 6) share ONE evict-once-then-bounded-
   poll policy.

   CONTRACT (deliberately different from the old private method): given a
   `doPost` that returns a Response, `withCapacityRetry` retries only a genuine
   `noCapacity` 503 (`{ noCapacity: true, neededMb, deviceKey }`). On an ok
   response OR any non-`noCapacity` failure (poisoned CUDA, other 5xx, 4xx), it
   RETURNS that Response unchanged — the CALLER applies its own error handling
   (e.g. the TTS wrapper runs throwForResponse; the load route reads the body).
   It throws only NoCapacityError after `maxAttempts`, or the abort reason if
   the signal fires during a poll wait. */

import { capacityProbe as defaultCapacityProbe, type CapacityProbe } from './capacity-probe.js';
import {
  evictOllama as defaultEvictOllama,
  analyzerEvictWouldHelp as defaultAnalyzerEvictWouldHelp,
} from '../analyzer/ollama-residency.js';
import { getAnalyzerConcurrencyStats } from '../analyzer/analyzer-concurrency.js';
import { NoCapacityError } from '../tts/tts-errors.js';
import type { TtsEngine } from '../tts/model-keys.js';
import { describeVramBlockers, type VramBlocker } from './describe-vram-blockers.js';
import {
  probeSidecarHealthIfRegistered,
  type SidecarHealthSnapshot,
} from './sidecar-health-gate.js';

/* Bounded poll for the no-capacity retry loop. GPU_CAPACITY_POLL_MS is the
   wait between admission checks; GPU_CAPACITY_MAX_ATTEMPTS bounds the total
   wait (default 30 * 2s = ~60s) before giving up and surfacing NoCapacityError. */
const GPU_CAPACITY_POLL_MS = (() => {
  const raw = Number(process.env.GPU_CAPACITY_POLL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2_000;
})();
const GPU_CAPACITY_MAX_ATTEMPTS = (() => {
  const raw = Number(process.env.GPU_CAPACITY_MAX_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
})();

/* Extended attempt budget that applies ONLY once the generic maxAttempts
   bound is reached AND the sidecar reports a resident/in-flight VoiceDesign
   (#2678 Task 3). A real design run legitimately outlasts the normal ~60s
   admission window — the sidecar's own unload_design() waits up to ~150s for
   an in-flight design before evicting it (server/tts-sidecar/main.py, see
   unload_design's header) — so a render blocked behind one should keep
   waiting rather than surface NoCapacityError. This budget is consulted at
   most once per call (see the isDesignResident check in withCapacityRetry);
   it never widens the timeout for a denial that was never design-blocked. */
const GPU_CAPACITY_DESIGN_MAX_ATTEMPTS = (() => {
  const raw = Number(process.env.GPU_CAPACITY_DESIGN_MAX_ATTEMPTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100; // ~200s on top of the generic ~60s budget above (~258s total wait, not ~200s — see withCapacityRetry's attempt accounting)
})();

/* GPU-queue status surface (server/src/routes/gpu-queue.ts) — counts ops
   currently parked in the no-capacity poll-wait below, giving the frontend
   "Queued (N ahead)" pill something to read now that gpuSemaphore is gone.
   Incremented just before an op's first poll wait; decremented once that op
   leaves the wait, however it resolves (succeeds, evicts-then-retries-ok, or
   throws NoCapacityError). */
let _capacityWaiters = 0;

/** Current count of ops parked in the no-capacity poll-wait. Read by
    server/src/routes/gpu-queue.ts (via a re-export from ../tts/sidecar.ts) for
    the /api/gpu/queue payload. */
export function getCapacityWaiterCount(): number {
  return _capacityWaiters;
}

/* Marker distinguishing "the CALLER's own hard-timeout AbortController fired"
   (currently only /api/sidecar/load's 90s ceiling, server/src/routes/
   sidecar-health.ts) from every other reason `opts.signal` can abort for —
   most importantly a user Pause or a regen-displacement abort on the
   synthesis path (server/src/routes/generation.ts's `chapterCtrl`), which
   shares this same `withCapacityRetry` call via server/src/tts/sidecar.ts.
   Both cases produce a `DOMException(..., 'AbortError')`, so `.name` alone
   can't tell them apart — only a caller that OPTS IN by aborting with a
   reason created via `createHardTimeoutAbortReason()` gets converted to
   `NoCapacityError` below; every other abort (the default, safe case) is
   rethrown as a plain AbortError so a route's own pause-detection (e.g.
   generation.ts's `name === 'AbortError'` check) still sees it (#2678
   re-review N3 — a Pause during the extended design-wait was previously
   surfacing as a fatal `vram-spill` instead of a clean pause). */
const HARD_TIMEOUT_ABORT_MARKER = Symbol('capacityRetryHardTimeoutAbort');

/** Creates an abort reason for a caller's own hard-timeout `AbortController`
    (e.g. /api/sidecar/load's 90s ceiling) that should be converted to
    `NoCapacityError` if it fires while `withCapacityRetry` is polling on the
    extended design-wait budget. Keeps `.name === 'AbortError'` so any other
    code inspecting the error shape (e.g. sidecar-health.ts's own `isTimeout`
    check) is unaffected — only `withCapacityRetry`'s catch block below reads
    the marker. Do NOT use this for a signal that can also fire for a user
    Pause or a regen-displacement (e.g. generation.ts's `chapterCtrl`) — those
    must remain unmarked so they pass through as a plain AbortError. */
export function createHardTimeoutAbortReason(message = 'capacity-retry caller timeout'): DOMException {
  const reason = new DOMException(message, 'AbortError');
  Object.defineProperty(reason, HARD_TIMEOUT_ABORT_MARKER, { value: true });
  return reason;
}

function isHardTimeoutAbort(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as Record<symbol, unknown>)[HARD_TIMEOUT_ABORT_MARKER] === true;
}

export interface CapacityRetryOpts {
  engine: string;
  signal?: AbortSignal;
  /** Injected capacity probe — defaults to the shared `capacityProbe`
      singleton (server/src/gpu/capacity-probe.ts). */
  capacityProbe?: CapacityProbe;
  /** Injected Ollama-eviction action — defaults to `evictOllama`
      (server/src/analyzer/ollama-residency.ts). */
  evictOllama?: () => Promise<void>;
  /** Injected "would evicting Ollama free enough VRAM" check — defaults to
      `analyzerEvictWouldHelp`. */
  analyzerEvictWouldHelp?: (neededMb: number, freeOnDeviceMb: number) => Promise<boolean>;
  /** Injected "is the analyzer mid-run" check — defaults to reading
      `getAnalyzerConcurrencyStats().inFlight > 0`. */
  isAnalysisInFlight?: () => boolean;
  /** Injected poll interval (ms) between no-capacity admission retries. */
  pollMs?: number;
  /** Injected cap on no-capacity retry attempts before giving up with
      `NoCapacityError`. */
  maxAttempts?: number;
  /** Injected "free a resident TTS model this op doesn't need" action —
      defaults to `evictIdleQwenBase` bound to this call's model key. Returns
      true when it actually unloaded something. */
  evictIdleTts?: () => Promise<boolean>;
  /** Injected "name what's holding the VRAM" action — defaults to a live
      probe of sidecar health mapped through `describeVramBlockers`
      (./describe-vram-blockers.ts). Folded into `NoCapacityError`'s message
      when admission finally gives up (#1839). */
  describeBlockers?: () => Promise<VramBlocker[]>;
  /** Injected "is a VoiceDesign currently resident/in-flight on the SAME
      device this admission was denied on" check — defaults to
      `defaultIsDesignResident`, which reads
      `probeSidecarHealthIfRegistered()`'s `qwenDesignResident` field
      qualified against `qwenDeviceKey`. Takes the denied request's
      `deviceKey` (from the `noCapacity` body) so residency on an unrelated
      card never extends the wait (#2678 review finding — a resident design
      on `cuda:0` cannot free capacity denied on `cuda:1`). Consulted at most
      once per call, only when the generic `maxAttempts` bound has just been
      reached: `true` extends the wait using `GPU_CAPACITY_DESIGN_MAX_ATTEMPTS`
      instead of giving up immediately (#2678 Task 3). Fail-closed like
      `describeBlockers` — an unregistered gate, a probe failure, or a
      device mismatch all report `false`, never inventing a design
      blocker. */
  isDesignResident?: (deviceKey: string) => Promise<boolean>;
  /** Injected cap on the EXTENDED no-capacity retry attempts used once
      `isDesignResident` reports true at the generic bound — defaults to
      `GPU_CAPACITY_DESIGN_MAX_ATTEMPTS`. */
  designMaxAttempts?: number;
}

/* Default `describeBlockers` — reads the sidecar health snapshot through the
   stateless leaf gate (./sidecar-health-gate.ts) rather than importing
   routes/sidecar-health.ts directly, which would close an import cycle (see
   that gate's file header for the full path). Best-effort: an unregistered
   gate or a probe failure both report no blockers rather than turning a
   probe failure into a worse error than the one already being thrown. */
async function defaultDescribeBlockers(
  fetchHealth: () => Promise<SidecarHealthSnapshot | null> = probeSidecarHealthIfRegistered,
): Promise<VramBlocker[]> {
  try {
    const health = await fetchHealth();
    if (!health) return [];
    return describeVramBlockers({
      coquiLoaded: health.modelLoaded,
      kokoroLoaded: health.kokoroLoaded,
      qwenLoaded: health.qwenLoaded,
      qwenBase17Loaded: health.qwenBase17Loaded,
    });
  } catch {
    return [];
  }
}

/* Default `isDesignResident` — reads the same stateless leaf gate as
   `defaultDescribeBlockers` (see its header for the import-cycle rationale
   for going through `sidecar-health-gate.ts` rather than
   `routes/sidecar-health.ts` directly). Qualified by `deviceKey` (#2678
   review finding): `qwenDesignResident` alone is global — it says a
   VoiceDesign is resident SOMEWHERE, not on the card this admission was
   denied on. A resident design on an unrelated card (a 2-GPU box, VoiceDesign
   on cuda:0, this request denied on cuda:1) can never free the blocked
   device, so extending the wait for it just burns another ~200s on top of the
   ~60s already spent (~258s total) before failing with the same error anyway.
   Fail-closed: an unregistered gate, a probe failure, a missing field, or a
   device mismatch all report `false` — this never invents a design blocker
   that would extend a wait past the normal ~60s budget. */
async function defaultIsDesignResident(
  deviceKey: string,
  fetchHealth: () => Promise<SidecarHealthSnapshot | null> = probeSidecarHealthIfRegistered,
): Promise<boolean> {
  try {
    const health = await fetchHealth();
    return health?.qwenDesignResident === true && health?.qwenDeviceKey === deviceKey;
  } catch {
    return false;
  }
}

/* Capacity-aware admission (vram-aware placement, Task 8b). Calls `doPost` and,
   on a non-ok response, peeks at the body BEFORE returning it (via
   `response.clone()`) to distinguish "no GPU capacity for this op" (503
   `{ noCapacity: true, neededMb, deviceKey }`) from every other response —
   which is returned untouched for the caller to classify.

   On a genuine no-capacity 503: re-probe live capacity for the reported device,
   and — ONLY the first time, and ONLY when the analyzer isn't mid-run — ask
   whether evicting the resident Ollama analyzer would free enough VRAM; if so,
   evict it and retry immediately. Otherwise (already evicted once, analyzer
   busy, or eviction wouldn't help), wait `pollMs` and retry, up to
   `maxAttempts` total attempts, then give up with `NoCapacityError`. */
export async function withCapacityRetry(
  doPost: (signal?: AbortSignal) => Promise<Response>,
  opts: CapacityRetryOpts,
): Promise<Response> {
  const capacityProbe = opts.capacityProbe ?? defaultCapacityProbe;
  const evictOllama = opts.evictOllama ?? defaultEvictOllama;
  const analyzerEvictWouldHelp = opts.analyzerEvictWouldHelp ?? defaultAnalyzerEvictWouldHelp;
  const isAnalysisInFlight =
    opts.isAnalysisInFlight ?? (() => getAnalyzerConcurrencyStats().inFlight > 0);
  const pollMs = opts.pollMs ?? GPU_CAPACITY_POLL_MS;
  const maxAttempts = opts.maxAttempts ?? GPU_CAPACITY_MAX_ATTEMPTS;
  const evictIdleTts = opts.evictIdleTts ?? (async () => false);
  const describeBlockers = opts.describeBlockers ?? defaultDescribeBlockers;
  const designMaxAttempts = opts.designMaxAttempts ?? GPU_CAPACITY_DESIGN_MAX_ATTEMPTS;

  let evicted = false;
  let evictedTts = false;
  let waiting = false;
  /* Set once the generic maxAttempts bound is reached AND isDesignResident()
     reported true at that moment — from then on this call is polling on the
     extended design budget, and isDesignResident is never consulted again
     (a design that clears mid-wait is caught by doPost returning ok, same as
     any other retry). designAttempt counts attempts taken under that
     extended budget, separate from the outer `attempt` which keeps counting
     for readability but no longer gates anything once this is true. */
  let usingDesignBudget = false;
  let designAttempt = 0;
  /* Last noCapacity body seen, kept so a caller-signal abort that fires
     mid-design-budget (see the catch block below) can still report the real
     deviceKey/neededMb instead of inventing one. */
  let lastNoCap: { neededMb: number; deviceKey: string } | null = null;
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await doPost(opts.signal);
      if (response.ok) return response;

      const noCap = await parseNoCapacity(response.clone());
      if (!noCap) {
        // ok OR a non-noCapacity failure (poisoned / other 5xx / 4xx) — the
        // CALLER applies its own error handling. Return it untouched.
        return response;
      }
      lastNoCap = noCap;

      const devices = await capacityProbe.read({ fresh: true });
      const freeMb =
        devices.find((d) => d.kind !== 'cpu' && `${d.kind}:${d.index}` === noCap.deviceKey)
          ?.freeMb ?? 0;

      if (!evicted && !isAnalysisInFlight() && (await analyzerEvictWouldHelp(noCap.neededMb, freeMb))) {
        await evictOllama();
        evicted = true;
        continue; // immediate retry after freeing the analyzer
      }

      /* Second lever: free a resident Qwen base this op doesn't need. Guarded to
         "no render in flight" inside evictIdleQwenBase, so it is inert during
         generation by construction. At most once per call, like the analyzer. */
      if (!evictedTts) {
        evictedTts = true;
        if (await evictIdleTts()) continue; // immediate retry after freeing VRAM
      }

      if (usingDesignBudget) {
        designAttempt++;
        if (designAttempt >= designMaxAttempts) {
          throw new NoCapacityError(
            opts.engine as TtsEngine,
            noCap.neededMb,
            noCap.deviceKey,
            await describeBlockers(),
          );
        }
      } else if (attempt + 1 >= maxAttempts) {
        /* #2678 review finding: isDesignResident and describeBlockers, when
           both left at their defaults, each independently call
           probeSidecarHealthIfRegistered() — two full live /health
           round-trips (each with its own ~2s timeout and disk-touching
           side effects, e.g. setLastKnownCoquiInstallState) to answer one
           give-up decision that only needs one snapshot. Share a single
           probe between them here when both are using their default
           implementation; an injected override of either still gets its
           own call, unaffected, so the injection contract for tests that
           override one or the other independently is unchanged. */
        let sharedHealth: Promise<SidecarHealthSnapshot | null> | undefined;
        const fetchHealthOnce = () => (sharedHealth ??= probeSidecarHealthIfRegistered());
        const designResident = await (
          opts.isDesignResident
            ? opts.isDesignResident(noCap.deviceKey)
            : defaultIsDesignResident(noCap.deviceKey, fetchHealthOnce)
        ).catch(() => false);
        if (designResident) {
          usingDesignBudget = true;
        } else {
          throw new NoCapacityError(
            opts.engine as TtsEngine,
            noCap.neededMb,
            noCap.deviceKey,
            opts.describeBlockers
              ? await opts.describeBlockers()
              : await defaultDescribeBlockers(fetchHealthOnce),
          );
        }
      }
      if (!waiting) {
        waiting = true;
        _capacityWaiters++;
      }
      await abortableDelay(pollMs, opts.signal); // bounded wait; rejects if the caller aborts
    }
  } catch (err) {
    /* A caller's own hard timeout (e.g. /api/sidecar/load's 90s
       AbortController) can fire before the EXTENDED design-wait budget
       completes — that budget runs ~200s past the generic ~60s bound (~258s
       total), well past a 90s ceiling the caller committed to for an unrelated reason
       (guarding against a stuck process). Left alone, that produces a raw
       AbortError, which callers don't recognise as NoCapacityError, so they
       report "model load is unusually slow or the process is stuck" for
       what is actually a known, well-classified capacity-contention case.
       Once this call has committed to the design budget, treat the caller's
       own signal firing as the equivalent of exhausting that budget: report
       the same NoCapacityError the caller would have seen at
       designMaxAttempts, using the last noCapacity body observed.

       Gated on `isHardTimeoutAbort` (#2678 re-review N3): `opts.signal` is
       ALSO the run's own cancellation signal on the synthesis path (server/
       src/tts/sidecar.ts → generation.ts's `chapterCtrl`), which aborts for a
       user Pause or a regen displacement — a case that must surface as a
       plain AbortError, not this NoCapacityError, so generation.ts's own
       pause-detector still recognises it. Only a signal aborted via
       `createHardTimeoutAbortReason()` (currently just /api/sidecar/load's
       90s ceiling) gets converted; every other abort falls through to the
       plain `throw err` below. */
    if (usingDesignBudget && opts.signal?.aborted && isHardTimeoutAbort(opts.signal.reason) && lastNoCap) {
      throw new NoCapacityError(
        opts.engine as TtsEngine,
        lastNoCap.neededMb,
        lastNoCap.deviceKey,
        await describeBlockers(),
      );
    }
    throw err;
  } finally {
    if (waiting) _capacityWaiters--;
  }
}

/* Parse the sidecar's no-capacity admission-refusal body:
   `{ "noCapacity": true, "neededMb": N, "deviceKey": "cuda:0" }` on a 503.
   Never throws — a non-503 status, an unreadable body, or a body that
   doesn't match this shape all return null so the caller falls back to its
   normal error handling. */
export async function parseNoCapacity(
  response: Response,
): Promise<{ neededMb: number; deviceKey: string } | null> {
  if (response.status !== 503) return null;
  const text = await safeReadText(response);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const body = parsed as { noCapacity?: unknown; neededMb?: unknown; deviceKey?: unknown };
  if (
    body?.noCapacity === true &&
    typeof body.neededMb === 'number' &&
    typeof body.deviceKey === 'string'
  ) {
    return { neededMb: body.neededMb, deviceKey: body.deviceKey };
  }
  return null;
}

/* Resolves after `ms`, or rejects with the signal's abort reason (AbortError)
   if `signal` fires first — so a cancelled op stops polling for capacity
   instead of waiting out the full interval. Mirrors retry.ts's `sleep`. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('capacity poll aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('capacity poll aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
