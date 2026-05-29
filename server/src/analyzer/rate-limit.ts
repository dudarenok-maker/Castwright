/* Per-model rate limiter for the Gemini API. Gates every outbound call —
   primary AND retry — through a triple-dimension bucket: RPM (sliding
   60-s window of request timestamps), TPM (sliding 60-s window of
   {timestamp, tokens} entries — input tokens per minute, since Google's
   TPM doesn't count output), and RPD (daily counter that resets at UTC
   midnight, Gemini's reset boundary).

   The shape exists because retries that bypass the limiter were the
   actual cause of most observed 500/503/429 storms — a 5xx single-retry
   on a 3-s tick during contention pushed three workers past the per-
   minute cap simultaneously, producing more 429s than primaries. Now
   every retry attempts re-acquires.

   Limits pulled from aistudio.google.com/app/rate-limit (free tier,
   2026-05-16). RPM is the typical binding constraint for all but Gemma
   (Unlimited TPM); RPD is the binding constraint for Gemini 2.5 Flash
   and 3 Flash preview (20/day). TPM rarely bites on Flash Lite under
   normal use but is the safety net against outlier long chapters and
   burst-retry pathology. */

import { AnalysisAbortedError } from './ollama.js';

interface ModelLimits {
  rpm: number;
  /** Total input tokens per minute. `Infinity` for Gemma's "Unlimited". */
  tpm: number;
  rpd: number;
}

const FALLBACK_LIMITS: ModelLimits = { rpm: 5, tpm: 100_000, rpd: 50 };

/* Built-in limits per model id. Values pulled live from AI Studio on
   2026-05-16 — keep in lockstep with the table in
   docs/features/archive/06-analyzer-gemini.md (regression plan) when limits
   change. */
const BUILTIN_LIMITS: Record<string, ModelLimits> = {
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-3-flash-preview': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-2.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemma-4-31b-it': { rpm: 15, tpm: Infinity, rpd: 1500 },
  'gemma-4-26b-a4b-it': { rpm: 15, tpm: Infinity, rpd: 1500 },
};

/* Slug-ify a model id for env-var lookup: lowercase non-alphanum → `_`,
   uppercase. `gemini-3.1-flash-lite` → `GEMINI_3_1_FLASH_LITE`. */
function envSlug(model: string): string {
  return model.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function readEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (raw.trim().toLowerCase() === 'unlimited') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function resolveLimits(model: string): ModelLimits {
  const base = BUILTIN_LIMITS[model] ?? FALLBACK_LIMITS;
  const slug = envSlug(model);
  return {
    rpm: readEnvNumber(`GEMINI_RPM_${slug}`) ?? base.rpm,
    tpm: readEnvNumber(`GEMINI_TPM_${slug}`) ?? base.tpm,
    rpd: readEnvNumber(`GEMINI_RPD_${slug}`) ?? base.rpd,
  };
}

/** Daily-quota exhausted for the given model. The route layer catches
    this and surfaces it to the UI as `code: 'daily_quota'` with the
    `resetAt` time in the detail blob. Distinct from a per-minute 429 —
    no retry on this; the user must switch model or wait. */
export class DailyQuotaExhaustedError extends Error {
  readonly code = 'DAILY_QUOTA_EXHAUSTED';
  constructor(
    public readonly model: string,
    public readonly resetAt: Date,
  ) {
    super(`Gemini ${model} daily quota exhausted — resets at ${resetAt.toISOString()}.`);
    this.name = 'DailyQuotaExhaustedError';
  }
}

interface TpmEntry {
  ts: number;
  tokens: number;
  /** True until `recordActualTokens` reconciles the estimate. The most
      recent un-reconciled entry per model is the one a worker just
      acquired; reconciling updates its tokens with the true count. */
  pending: boolean;
}

interface ModelState {
  rpmWindow: number[]; // sliding 60-s window of acquire timestamps
  tpmWindow: TpmEntry[]; // sliding 60-s window of {ts, tokens}
  rpdCount: number; // requests so far this UTC day
  rpdDayKey: string; // 'YYYY-MM-DD' (UTC) — flip resets rpdCount
  /** Hard floor on the next acquire's timestamp, set by recordRejection.
      0 means no override; otherwise acquire waits until Date.now() >=
      this value before checking RPM/TPM. Aligns our view with Google's
      `retry-delay` response when our bookkeeping drifts. */
  blockUntil: number;
}

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function nextUtcMidnight(now = Date.now()): Date {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

type ThrottleReason = 'rpm' | 'tpm' | 'rpd' | 'retry-after';

interface AcquireOpts {
  signal?: AbortSignal;
  onWait?: (waitMs: number, reason: ThrottleReason) => void;
}

export class GeminiRateLimiter {
  private readonly state = new Map<string, ModelState>();

  private getState(model: string): ModelState {
    let s = this.state.get(model);
    if (!s) {
      s = { rpmWindow: [], tpmWindow: [], rpdCount: 0, rpdDayKey: utcDayKey(), blockUntil: 0 };
      this.state.set(model, s);
    } else {
      const today = utcDayKey();
      if (s.rpdDayKey !== today) {
        s.rpdCount = 0;
        s.rpdDayKey = today;
      }
    }
    return s;
  }

  /** Drop entries older than 60 s from both sliding windows. */
  private trim(s: ModelState, now: number): void {
    const cutoff = now - 60_000;
    while (s.rpmWindow.length > 0 && s.rpmWindow[0] <= cutoff) s.rpmWindow.shift();
    while (s.tpmWindow.length > 0 && s.tpmWindow[0].ts <= cutoff) s.tpmWindow.shift();
  }

  /** Sum tokens in the current 60-s TPM window. */
  private tpmSum(s: ModelState): number {
    let n = 0;
    for (const e of s.tpmWindow) n += e.tokens;
    return n;
  }

  /** Acquire one slot for `model`. Blocks (await) until RPM, TPM, RPD
      all have headroom. `estimatedTokens` is the input-token count for
      the call about to be made — added to the TPM window once the slot
      is granted. Re-acquires for each retry; never bypassed.

      Rejects with `DailyQuotaExhaustedError` if today's RPD cap is
      already hit, or with `AnalysisAbortedError` if `opts.signal` fires
      mid-wait. */
  async acquire(model: string, estimatedTokens: number, opts: AcquireOpts = {}): Promise<void> {
    if (opts.signal?.aborted) {
      throw new AnalysisAbortedError(`Aborted before acquiring rate-limit slot for ${model}.`);
    }

    const limits = resolveLimits(model);

    while (true) {
      const s = this.getState(model);
      const now = Date.now();
      this.trim(s, now);

      if (s.rpdCount >= limits.rpd) {
        throw new DailyQuotaExhaustedError(model, nextUtcMidnight(now));
      }

      /* recordRejection-imposed hard floor: a 429 from Google with a
         retry-delay overrides our window math until the deadline
         passes. */
      if (s.blockUntil > now) {
        const waitMs = s.blockUntil - now + Math.floor(Math.random() * 200) + 50;
        opts.onWait?.(waitMs, 'retry-after');
        await this.sleep(waitMs, opts.signal);
        continue;
      }

      const rpmOk = s.rpmWindow.length < limits.rpm;
      const tpmOk = this.tpmSum(s) + estimatedTokens <= limits.tpm;

      if (rpmOk && tpmOk) {
        s.rpmWindow.push(now);
        s.tpmWindow.push({ ts: now, tokens: estimatedTokens, pending: true });
        s.rpdCount += 1;
        return;
      }

      /* Compute how long to wait. Pick the shorter of the RPM and TPM
         wait times — whichever clears first lets us re-try. Jitter
         (50–250 ms) keeps parallel workers from re-acquiring in
         lockstep. */
      let waitMs: number;
      let reason: ThrottleReason;
      const rpmWaitMs = rpmOk ? Infinity : 60_000 - (now - s.rpmWindow[0]);
      const tpmWaitMs = tpmOk ? Infinity : computeTpmWait(s, now, estimatedTokens, limits.tpm);
      if (rpmWaitMs <= tpmWaitMs) {
        waitMs = rpmWaitMs;
        reason = 'rpm';
      } else {
        waitMs = tpmWaitMs;
        reason = 'tpm';
      }
      waitMs = Math.max(50, Math.ceil(waitMs)) + Math.floor(Math.random() * 200) + 50;
      opts.onWait?.(waitMs, reason);

      await this.sleep(waitMs, opts.signal);
    }
  }

  /** Sleep `ms` ms, rejecting promptly if `signal` fires. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AnalysisAbortedError('Aborted while waiting on rate-limit window.'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Reconcile the most-recent pending TPM reservation for `model` with
      the call's actual `usageMetadata.promptTokenCount`. No-op if the
      model has no pending entry (e.g. the call failed before we could
      account for it; the estimate stays in the window and rolls off
      naturally within 60 s). */
  recordActualTokens(model: string, actualTokens: number): void {
    const s = this.state.get(model);
    if (!s) return;
    for (let i = s.tpmWindow.length - 1; i >= 0; i -= 1) {
      const e = s.tpmWindow[i];
      if (e.pending) {
        e.tokens = Math.max(0, Math.floor(actualTokens));
        e.pending = false;
        return;
      }
    }
  }

  /** Called when Google returned 429 despite our bookkeeping. Sets a
      hard floor on the next acquire — no further requests for this
      model fire until `Date.now() >= now + retryAfterMs`. Aligns our
      view with Google's `retry-delay` when our window math drifts. */
  recordRejection(model: string, retryAfterMs: number | null): void {
    if (!retryAfterMs || retryAfterMs <= 0) return;
    const s = this.getState(model);
    s.blockUntil = Math.max(s.blockUntil, Date.now() + retryAfterMs);
  }

  /** For tests only — reset all per-model state. Not exported on the
      barrel. */
  _reset(): void {
    this.state.clear();
  }
}

/* Compute how long until enough tokens roll off the TPM window to fit
   `needed`. Walks entries from oldest to newest summing freed tokens;
   returns the wait until the entry whose expiry frees enough.

   Edge case: if `needed` exceeds the model's TPM cap entirely (e.g. a
   400K-token prompt against a 250K cap), no wait will ever free enough.
   We return 60_000 in that case as a soft cap — the retry loop will hit
   its own ceiling and give up cleanly. */
function computeTpmWait(s: ModelState, now: number, needed: number, cap: number): number {
  const current = s.tpmWindow.reduce((sum, e) => sum + e.tokens, 0);
  const surplus = current + needed - cap;
  if (surplus <= 0) return 0; // shouldn't happen — caller already checked
  let freed = 0;
  for (const e of s.tpmWindow) {
    freed += e.tokens;
    if (freed >= surplus) {
      const expiresAt = e.ts + 60_000;
      return Math.max(0, expiresAt - now);
    }
  }
  return 60_000;
}

/** Module-level singleton. RPM/TPM/RPD are global per process — sharing
    one limiter across all GeminiAnalyzer instances is the whole point.
    Tests reach in via `_reset()`. */
export const geminiRateLimiter = new GeminiRateLimiter();
