/* fs-19 — structured failure taxonomy. Formalises the ad-hoc classifier that
   used to live inline in `describeSynthesisError` (generation-error.ts) into an
   ORDERED, first-match-wins table that maps a raw synthesis/analysis error to:

     - a stable machine code (`FailureCode`) the frontend can switch on,
     - a jargon-free `userMessage` (what went wrong, in plain English),
     - a concrete `remediation` (what to DO about it),
     - the legacy `fatal` flag (stop the run vs. skip-and-advance).

   The incident-tuned regexes are PORTED VERBATIM from generation-error.ts —
   they encode hard-won knowledge from real failures (the XTTS "index out of
   range in self" cascade of 2026-05-13, the "degenerate"→/rate/ misclassify of
   2026-05-31 the Hollow Tide CH24, the CUDA poison-fence). Do not loosen them.

   `describeSynthesisError` now delegates here and maps back to its legacy
   `{ errorReason, fatal }` shape so existing callers keep working.

   The run-level analysis half (classifyAnalysisFailure + tryParseApiError,
   statusToFailureCode, formatErrorDetail, trimQuotaMessage) is ported
   VERBATIM from analysis.ts's describeError family — same envelope parsing,
   same precedence, now unified into this module with FailureCode vocabulary. */

import { FAILURE_REMEDIATIONS } from './failure-remediations.js';
export { FAILURE_REMEDIATIONS, type FailureRemediationCopy } from './failure-remediations.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import { AnalyzerTruncatedError } from '../analyzer/errors.js';

export type FailureCode =
  | 'vram-spill'
  | 'recycle-storm'
  | 'sidecar-unreachable'
  | 'analyzer-rate-limit'
  | 'analyzer-daily-quota'
  | 'analyzer-truncated'
  | 'analyzer-unreachable'
  | 'analyzer-content-blocked'
  | 'attribution-incomplete'
  | 'oom'
  | 'disk-full'
  | 'model-not-loaded'
  | 'synth-timeout'
  | 'xtts-speaker-desync'
  | 'cuda-poisoned'
  | 'gpu-acceleration-unavailable'
  | 'auth'
  | 'unknown';

/* Compile-time pin: every FailureCode has copy. (The reverse — no extra keys —
   is asserted by the key-parity test in failure-taxonomy.test.ts.) */
const _copyComplete: Record<FailureCode, { userMessage: string; remediation: string }> =
  FAILURE_REMEDIATIONS;
void _copyComplete;

export interface FailureContext {
  status?: number;
  name?: string;
  engine?: string;
}

export type FailureSource = 'generation' | 'analysis' | 'both';

export interface FailureSignature {
  code: FailureCode;
  fatal: boolean;
  /** Which classification path may match this signature. Generation keeps its
      exact historical order/sequence (plan 154); analysis-only entries are
      invisible to classifyFailure and vice versa. */
  source: FailureSource;
  /** Optional typed-error matcher, tested against err.name BEFORE the regex —
      survives message rewording. */
  matchName?: string;
  match: (raw: string, ctx: FailureContext) => boolean;
}

export interface ClassifiedFailure {
  code: FailureCode;
  userMessage: string;
  remediation: string;
  fatal: boolean;
  /** The raw error string we classified — handy for logs / the unknown path. */
  raw?: string;
}

/* ORDERED signature table — first match wins. Ordering mirrors the original
   describeSynthesisError cascade so behaviour is byte-identical for the cases
   it already handled, with the new disk/oom/vram/model classes interleaved
   where they don't shadow an existing, more-specific pattern.

   The per-call timeout (ChapterSynthTimeoutError) MUST come first: its message
   contains "dege·nerate", whose "rate" substring used to match the quota regex
   and stop the whole run (2026-05-31). Pinning it first keeps that locked. */
export const FAILURE_SIGNATURES: FailureSignature[] = [
  /* ---- analysis-only entries (source-gated; invisible to classifyFailure).
     Name-driven first: typed analyzer errors survive message rewording.
     analyzer-daily-quota MUST precede the 'both' analyzer-rate-limit entry —
     a daily-quota 429 would otherwise classify as a plain rate-limit. ---- */
  {
    code: 'analyzer-truncated',
    fatal: false,
    source: 'analysis',
    matchName: 'AnalyzerTruncatedError',
    match: () => false,
  },
  {
    code: 'analyzer-daily-quota',
    fatal: true,
    source: 'analysis',
    matchName: 'DailyQuotaExhaustedError',
    /* Same free-tier regex as statusToFailureCode, but applied to the RAW string —
       the two paths see different inputs; do not unify. */
    match: (raw, ctx) =>
      ctx.status === 429 && /free[_-]?tier|quotaValue":"\d{1,3}"/i.test(raw),
  },
  {
    code: 'analyzer-unreachable',
    fatal: true,
    source: 'analysis',
    matchName: 'GeminiStreamIdleError',
    match: (raw, ctx) =>
      ctx.status === 503 ||
      ctx.status === 500 ||
      /ECONNREFUSED|fetch failed|EAI_AGAIN|socket hang up/i.test(raw),
  },
  /* Content-filter block (analysis only). A gemini-* model returns a candidate
     carrying RECITATION/SAFETY but no text — the engine surfaces this as
     "Gemini <model> returned an empty response" (gemini.ts). Scoped to the
     Gemini message so Ollama's same-worded empty-response (a local-model
     problem, not a content filter) falls through to `unknown`. Deterministic on
     the same text, so splitting/retrying the same model never clears it — the
     remediation points at a gemma-* model or the local analyzer. */
  {
    code: 'analyzer-content-blocked',
    fatal: true,
    source: 'analysis',
    match: (raw) => /Gemini\b.*\breturned an empty response\b/i.test(raw),
  },
  {
    code: 'synth-timeout',
    fatal: false,
    source: 'generation',
    match: (_raw, ctx) => ctx.name === 'ChapterSynthTimeoutError',
  },
  {
    code: 'sidecar-unreachable',
    fatal: true,
    source: 'generation',
    match: (raw) => /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(raw),
  },
  /* C3 (Wave 3) — the named recycle-storm signal from synthesise-chapter.ts
     (`RecycleStormError`): the sidecar recycled/respawned more times than the
     in-loop budget allows while rendering ONE chapter. MUST be placed BEFORE
     the vram-spill entry: RecycleStormError's message contains "VRAM/RAM
     headroom", which matches vram-spill's /VRAM/i regex, and the table is
     first-match-wins. Matched TYPE-DRIVEN (ctx.name) first so a future message
     reword can't silently mis-classify it; the raw-message regex is a fallback
     only. `fatal: false` because the chapter itself isn't poison. The RUN is
     stopped a different way per dispatch path: on the queue path (one POST per
     chapter) generation.ts PAUSES the queue on a storm; the cross-chapter
     cascade (recordNonFatal in generation.ts) only escalates to a run-stop on
     the back-compat `*` job, which loops many chapters in one POST. */
  {
    code: 'recycle-storm',
    fatal: false,
    source: 'generation',
    match: (raw, ctx) =>
      ctx.name === 'RecycleStormError' || /recycled \d+× while rendering/.test(raw),
  },
  /* CUDA out-of-memory — the GPU allocator itself refused. Distinct from the
     host-RAM OOM kill below. Comes BEFORE the cuda-poisoned check because an
     OOM message ("CUDA out of memory") would otherwise be swallowed by the
     broad /CUDA error/ pattern there. */
  {
    code: 'vram-spill',
    fatal: true,
    source: 'generation',
    match: (raw) => /CUDA out of memory|VRAM/i.test(raw),
  },
  /* Host-process OOM kill — the OS killed the sidecar (exit 137 / SIGKILL).
     Matched on the kill signal, NOT on the word "memory" (which would collide
     with the VRAM case above). */
  {
    code: 'oom',
    fatal: true,
    source: 'generation',
    match: (raw) => /\bkilled\b|exit code 137|SIGKILL|out of memory: killed/i.test(raw),
  },
  {
    code: 'disk-full',
    fatal: true,
    source: 'both',
    match: (raw) => /ENOSPC|no space left/i.test(raw),
  },
  /* Upstream rate-limit / quota. STRICT match — a real HTTP 429 or an
     unambiguous quota phrase. The bare token "rate" is NOT enough (it matches
     inside "degenerate"/"generated"). Ported verbatim from generation-error.ts.

     Engine-aware fatality: a genuine 429 is always upstream → Gemini-fatal.
     A rate-limit-SHAPED message on a LOCAL engine (no 429) is NOT Gemini —
     the classifier surfaces it as a non-fatal pass-through (the `unknown`
     fall-through handles it, since this signature only matches the Gemini
     case). */
  {
    code: 'analyzer-rate-limit',
    fatal: true,
    source: 'both',
    match: (raw, ctx) => {
      const isHttp429 = ctx.status === 429;
      const looksRateLimited =
        isHttp429 ||
        /\b429\b|\btoo many requests\b|\bquota\b|rate[-\s]?limit|resource (?:has been )?exhausted/i.test(
          raw,
        );
      if (!looksRateLimited) return false;
      /* Only attribute to Gemini when it's a real 429 OR the engine isn't a
         local one. A rate-limit-shaped local-engine message falls through to
         `unknown` (non-fatal raw passthrough) instead of mislabelling Gemini. */
      const localEngine = ctx.engine != null && ctx.engine !== 'gemini';
      return isHttp429 || !localEngine;
    },
  },
  {
    code: 'auth',
    fatal: true,
    source: 'both',
    match: (raw, ctx) =>
      ctx.status === 401 || ctx.status === 403 || /invalid[_ ]?key|API key/i.test(raw),
  },
  {
    code: 'xtts-speaker-desync',
    fatal: true,
    source: 'generation',
    match: (raw) =>
      /index out of range in self|IndexError|out of range \(expected to be in range/i.test(raw),
  },
  {
    code: 'cuda-poisoned',
    fatal: true,
    source: 'generation',
    match: (raw) =>
      /device-side assert|CUDA error|CUDA kernel errors|"poisoned":\s*true/i.test(raw),
  },
  /* AMD phase 2 — GPU acceleration unavailable (no compatible GPU / driver too
     old / unsupported gfx / DirectML op unsupported): the engine runs on CPU.
     Non-fatal — CPU synthesis still works, just slower. A distinctive phrase so
     it can't shadow the specific CUDA/VRAM signatures above. */
  {
    code: 'gpu-acceleration-unavailable',
    fatal: false,
    source: 'both',
    match: (raw) =>
      /GPU acceleration (is )?unavailable|no compatible (GPU|accelerator) (found|detected)/i.test(
        raw,
      ),
  },
  /* Placed LAST among the specific signatures: "model not loaded" / a 503 while
     loading. After the sidecar-unreachable check (a down sidecar is the more
     urgent diagnosis) but it catches the "process up, model not resident" case. */
  {
    code: 'model-not-loaded',
    fatal: true,
    source: 'generation',
    match: (raw) => /model not loaded|503.*loading|loading.*model/i.test(raw),
  },
];

function rawOf(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** Trim an unmapped raw message for user display — caps at 240 chars + ellipsis,
    mirroring the legacy describeSynthesisError truncation. */
function trimRaw(raw: string): string {
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

function scanSignatures(
  err: unknown,
  sources: ReadonlySet<FailureSource>,
  engine?: string,
): ClassifiedFailure | null {
  const raw = rawOf(err);
  const ctx: FailureContext = {
    status: (err as { status?: number })?.status,
    name: (err as { name?: string })?.name,
    engine,
  };
  for (const sig of FAILURE_SIGNATURES) {
    if (!sources.has(sig.source)) continue;
    if ((sig.matchName != null && sig.matchName === ctx.name) || sig.match(raw, ctx)) {
      const copy = FAILURE_REMEDIATIONS[sig.code];
      return {
        code: sig.code,
        userMessage: copy.userMessage,
        remediation: copy.remediation,
        fatal: sig.fatal,
        raw,
      };
    }
  }
  return null;
}

const GENERATION_SOURCES: ReadonlySet<FailureSource> = new Set(['generation', 'both']);
const ANALYSIS_SOURCES: ReadonlySet<FailureSource> = new Set(['analysis', 'both']);

/** Classify a synthesis/analysis error into the structured taxonomy. First
    matching signature wins; an unmapped error returns `code: 'unknown'` with
    the (trimmed) raw message as `userMessage` and a generic remediation,
    `fatal: false`. */
export function classifyFailure(err: unknown, engine?: string): ClassifiedFailure {
  const hit = scanSignatures(err, GENERATION_SOURCES, engine);
  if (hit) return hit;
  const raw = rawOf(err);
  return {
    code: 'unknown',
    userMessage: trimRaw(raw),
    remediation: FAILURE_REMEDIATIONS.unknown.remediation,
    fatal: false,
    raw,
  };
}

/** Bare signature-table scan for the analysis path. Production callers use
    classifyAnalysisFailure (added by a later task) — which layers the ported
    describeError envelope parsing on top and falls back to this scan; exported
    for that fallback and for direct unit tests. */
export function classifyAnalysisError(err: unknown): ClassifiedFailure {
  const hit = scanSignatures(err, ANALYSIS_SOURCES);
  if (hit) return hit;
  const raw = rawOf(err);
  return {
    code: 'unknown',
    userMessage: trimRaw(raw),
    remediation: FAILURE_REMEDIATIONS.unknown.remediation,
    fatal: false,
    raw,
  };
}

/* ── Run-level analysis classifier — ported from analysis.ts describeError ── */

export interface AnalysisFailure {
  code: FailureCode;
  userMessage: string;
  remediation: string;
  detail?: string;
}

/* Build the detail blob shown in the UI's collapsible. Prefer the
   structured details[] from the upstream envelope; fall back to the raw
   error body so debugging never has to round-trip to the server log. */
function formatErrorDetail(
  parsed: { status?: string; details?: unknown[] },
  raw: string,
): string | undefined {
  const lines: string[] = [];
  if (parsed.status) lines.push(`status: ${parsed.status}`);
  if (parsed.details && parsed.details.length > 0) {
    lines.push('details:');
    lines.push(JSON.stringify(parsed.details, null, 2));
  }
  if (lines.length === 0) {
    /* No structured details — fall back to the raw SDK message, trimmed.
       Useful when the error wasn't a Google API envelope (e.g. network). */
    const trimmed = raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;
    return trimmed.trim() || undefined;
  }
  return lines.join('\n');
}

/* Google's 429 body is wall-of-text — strip everything after the first
   sentence so the UI alert stays tractable. The full text still lives in
   the server console (and the `detail` blob) for debugging. */
function trimQuotaMessage(message: string): string {
  const firstStop = message.search(/[.\n]/);
  if (firstStop > 0 && firstStop < 240) return message.slice(0, firstStop + 1).trim();
  return message.slice(0, 240) + (message.length > 240 ? '…' : '');
}

export function tryParseApiError(
  raw: string,
): { code?: number; message: string; status?: string; details?: unknown[] } | null {
  /* SDK messages often look like 'got status: 503 UNAVAILABLE. {"error":{...}}'.
     Find the first '{' and try to parse from there. */
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start)) as {
      error?: { code?: number; message?: string; status?: string; details?: unknown[] };
    };
    if (obj?.error?.message) {
      return {
        code: obj.error.code,
        message: obj.error.message,
        status: obj.error.status,
        details: obj.error.details,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/* classifyStatus, ported from analysis.ts — now emits FailureCode per the
   spec-A2 mapping (rate_limit→analyzer-rate-limit, daily_quota→analyzer-daily-quota,
   unavailable/internal→analyzer-unreachable, invalid_key→auth, bad_request→unknown). */
function statusToFailureCode(status: number | undefined, message?: string): FailureCode {
  if (!status) return 'unknown';
  if (status === 429) {
    /* Same regex as the analyzer-daily-quota signature, but applied to the parsed envelope MESSAGE
       only (raw would false-positive on per-minute quotaValue details). Do not unify. */
    if (message && /free[_-]?tier|quotaValue":"\d{1,3}"/i.test(message)) return 'analyzer-daily-quota';
    return 'analyzer-rate-limit';
  }
  if (status === 503 || status === 500) return 'analyzer-unreachable';
  if (status === 401 || status === 403) return 'auth';
  return 'unknown';
}

function withCopy(code: FailureCode, userMessage: string, detail?: string): AnalysisFailure {
  return { code, userMessage, remediation: FAILURE_REMEDIATIONS[code].remediation, detail };
}

/** Run-level analysis classifier — the unified replacement for analysis.ts's
    describeError(). Typed-error checks and the Google-envelope/status parsing
    are PORTED VERBATIM (same precedence, same message construction: model
    label, status suffix, quota trimming, detail blob); only the code
    vocabulary changes to FailureCode and a remediation is attached. Plain
    unmatched errors additionally fall through to the analysis signature scan
    (so ECONNREFUSED etc. classify here too). */
export function classifyAnalysisFailure(err: unknown, modelLabel: string): AnalysisFailure {
  if (err instanceof AnalyzerTruncatedError) {
    return withCopy(
      'analyzer-truncated',
      `${modelLabel} truncated the response (${err.reason}) — a chapter section is too large for one attribution call. Lower STAGE2_CHUNK_CHAR_BUDGET and retry.`,
      `engine=${err.engine} reason=${err.reason} bytes=${err.receivedBytes}${
        err.outputTokens ? ` tokens=${err.outputTokens}` : ''
      }`,
    );
  }
  if (err instanceof DailyQuotaExhaustedError) {
    return withCopy(
      'analyzer-daily-quota',
      `${modelLabel} daily quota exhausted — resets at ${err.resetAt.toISOString()}.`,
      `resetAt: ${err.resetAt.toISOString()}`,
    );
  }
  const raw = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;

  const parsed = tryParseApiError(raw);
  if (parsed) {
    const code = statusToFailureCode(parsed.code ?? status, parsed.message);
    /* Only trim quota messages — 4xx/5xx bodies are usually short and
       informative (an INVALID_ARGUMENT body names the failed field), so
       trimming them throws away the only useful diagnostic. */
    const trimmed =
      code === 'analyzer-rate-limit' || code === 'analyzer-daily-quota'
        ? trimQuotaMessage(parsed.message)
        : parsed.message;
    const statusSuffix = parsed.status ? ` (${parsed.status})` : '';
    return withCopy(
      code,
      `${modelLabel} returned ${parsed.code ?? status ?? '???'}${statusSuffix}: ${trimmed}`,
      formatErrorDetail(parsed, raw),
    );
  }
  if (status) {
    return withCopy(statusToFailureCode(status, raw), `${modelLabel} returned ${status}: ${raw}`);
  }
  /* Not an API envelope — give the signature table a chance (catches the
     connection-refused / fetch-failed family) before the unknown fallback. */
  const scanned = classifyAnalysisError(err);
  if (scanned.code !== 'unknown') {
    return { code: scanned.code, userMessage: scanned.userMessage, remediation: scanned.remediation };
  }
  return withCopy('unknown', raw || 'Analysis failed.');
}
