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
   `{ errorReason, fatal }` shape so existing callers keep working. */

import { FAILURE_REMEDIATIONS } from './failure-remediations.js';
export { FAILURE_REMEDIATIONS, type FailureRemediationCopy } from './failure-remediations.js';

export type FailureCode =
  | 'vram-spill'
  | 'recycle-storm'
  | 'sidecar-unreachable'
  | 'analyzer-rate-limit'
  | 'oom'
  | 'disk-full'
  | 'model-not-loaded'
  | 'synth-timeout'
  | 'xtts-speaker-desync'
  | 'cuda-poisoned'
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
