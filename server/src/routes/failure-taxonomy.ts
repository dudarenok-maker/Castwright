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
import { ApiError } from '@google/genai';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import {
  AnalyzerTruncatedError,
  AnalyzerHttpError,
  AnalyzerKeyOriginError,
  AnalyzerReasoningOverflowError,
  AnalyzerTimeoutError,
  AnalyzerEndpointMissingError,
  AnalyzerInvalidOutputError,
  AnalyzerStreamIncompleteError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
  causeCodeSuffix,
  type TransportKind,
} from '../analyzer/errors.js';
import { redactKnownSecrets } from '../analyzer/redact.js';
import { namesContextOrTokenLimit } from '../analyzer/limit-400-patterns.js';
/* #3084 A9 — through the leaf gate, never an import of workspace/user-settings.ts. */
import { knownAnalyzerSecrets } from '../analyzer/known-secrets-gate.js';
/* #3084 P23/A9 — the saved endpoints, through the leaf gate too: the openai fix
   names its endpoint by saved name without an import of workspace/user-settings.ts. */
import { listAnalyzerEndpoints } from '../analyzer/analyzer-endpoints-gate.js';
import { getCachedGeminiModelInfo } from '../analyzer/catalog/gemini-catalog.js';
import { configValue } from '../config/resolver.js';
import { isLockAcquisitionTimeout, LOCK_CONTENTION_REQUEST_ERROR } from '../workspace/file-lock.js';

export type FailureCode =
  | 'vram-spill'
  | 'recycle-storm'
  | 'sidecar-unreachable'
  | 'analyzer-rate-limit'
  | 'analyzer-daily-quota'
  | 'analyzer-truncated'
  | 'analyzer-reasoning-overflow'
  | 'analyzer-timeout'
  | 'analyzer-unreachable'
  | 'analyzer-content-blocked'
  | 'analyzer-request-rejected'
  | 'analyzer-invalid-output'
  | 'analyzer-endpoint-missing'
  | 'attribution-incomplete'
  | 'attribution-collapse'
  | 'oom'
  | 'disk-full'
  | 'model-not-loaded'
  | 'synth-timeout'
  | 'xtts-speaker-desync'
  | 'cuda-poisoned'
  | 'gpu-acceleration-unavailable'
  | 'voice-not-designed'
  | 'cloned-voice-broken'
  | 'lock-contention'
  | 'language-unset'
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
    code: 'analyzer-reasoning-overflow',
    fatal: true,
    source: 'analysis',
    matchName: 'AnalyzerReasoningOverflowError',
    match: () => false,
  },
  {
    code: 'analyzer-timeout',
    fatal: true,
    source: 'analysis',
    matchName: 'AnalyzerTimeoutError',
    match: () => false,
  },
  {
    code: 'analyzer-daily-quota',
    fatal: true,
    source: 'analysis',
    matchName: 'DailyQuotaExhaustedError',
    /* Same per_day marker as statusToFailureCode, but applied to the RAW string —
       the two paths see different inputs; do not unify. Keys on the daily
       quotaId marker (`per_day` / `PerDay` — the latter matched by `[_-]?`
       allowing zero separators under /i). The old `quotaValue":"\d{1,3}"`
       companion clause was DROPPED (#1695): the free-tier per-MINUTE request
       cap is 15 (a 2-digit quotaValue), so a retryable RPM 429 collided with
       the digit heuristic and mis-classified as fatal daily exhaustion. */
    match: (raw, ctx) => ctx.status === 429 && /per[_-]?day/i.test(raw),
  },
  {
    code: 'analyzer-rate-limit',
    fatal: false,
    source: 'analysis',
    matchName: 'RequestExceedsTpmError',
    match: () => false,
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
    /* Typed-error match first (survives message rewording), regex as fallback
       for any bare Error carrying the same wording. */
    matchName: 'GeminiContentBlockedError',
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
  /* T7 (Wave 3b2) — the cloned-voice resolver pre-pass in synthesiseChapter
     (clone-voice-resolver.ts) raises UnresolvableClonedVoiceError when one or
     more assigned cloned voices can't render as themselves this run (revoked
     consent, missing master, Qwen unavailable, wrong-engine routing, a failed
     re-derive, or a misconfigured library entry) — a real person's voice must
     never be silently substituted with another. Matched on `err.name`
     (duck-typed, not `instanceof`: the error crosses the tts/ → routes/ module
     boundary, and a prior regression — #1801 — came from an `instanceof`
     check across exactly this kind of boundary), with a raw-message regex
     fallback on the error's own distinctive wording (mirrors the
     analyzer-content-blocked pattern above) so a bare Error carrying the same
     text still classifies correctly. MUST come before the broader
     analyzer-rate-limit/auth/gpu-acceleration-unavailable signatures below:
     none of them currently match this error's wording, but the named match
     keeps it pinned regardless of future message edits.

     fatal: false — this is a per-chapter, per-character failure (mirrors
     voice-not-designed's chapter-scoped model): a chapter that doesn't use
     the broken voice should still render. There is NO cross-chapter backstop
     on the common queue path: the dispatcher fires one POST per chapter, so
     the cascade counter in generation.ts (recordNonFatal, a fresh job-local
     state per POST) never sees a second chapter's failure and can't
     escalate this to a run-stop (mirrors the corrected recycle-storm
     framing at generation.ts, not the stale isStall comment above it). Each
     affected chapter therefore fails independently with its own accurate,
     per-voice message — accepted deliberately, because a broken cloned
     voice is character-scoped: other chapters (that don't cast it) and
     other books sharing the queue should keep rendering. A blanket
     queue-pause like recycle-storm's would be an overcorrection here — that
     case is a systemic sidecar failure, this one is scoped to whichever
     voices are broken. */
  {
    code: 'cloned-voice-broken',
    fatal: false,
    source: 'generation',
    matchName: 'UnresolvableClonedVoiceError',
    match: (raw) => /cloned voice.*must never be substituted/i.test(raw),
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
  /* #3084 F7 — structured "how to fix" entries, present only where the
     classifier can name something actionable (today: analyzer-reasoning-
     overflow). Optional, so every existing producer/consumer is unaffected. */
  fixes?: AnalysisFailureFix[];
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
function statusToFailureCode(status: number | undefined, message?: string, keyText: string | undefined = message): FailureCode {
  if (!status) return 'unknown';
  if (status === 429) {
    /* Same per_day marker as the analyzer-daily-quota signature, but applied to the parsed envelope MESSAGE
       only (raw would false-positive on per-minute quotaValue details). Do not unify. The
       `quotaValue":"\d{1,3}"` clause was DROPPED (#1695) — a per-minute RPM 429 carries the
       2-digit free-tier cap (quotaValue":"15") and would mis-classify as daily. */
    if (message && /per[_-]?day/i.test(message)) return 'analyzer-daily-quota';
    return 'analyzer-rate-limit';
  }
  if (status === 503 || status === 500) return 'analyzer-unreachable';
  if (status === 401 || status === 403) return 'auth';
  /* #3084 PR 3b review — Gemini answers a bad or expired key with a 400 whose envelope
     reason is API_KEY_INVALID / API_KEY_EXPIRED. That is a credentials problem (main's
     signature scan read it as `auth`), not a request-shape one. */
  if (status === 400) return keyText && /API[_ ]?KEY/i.test(keyText) ? 'auth' : 'analyzer-request-rejected';
  return 'unknown';
}

function withCopy(code: FailureCode, userMessage: string, detail?: string, remediation?: string): AnalysisFailure {
  return { code, userMessage, remediation: remediation ?? FAILURE_REMEDIATIONS[code].remediation, detail };
}

/* ── #3084 F7 — structured "how to fix" entries (wave 2b) ───────────────────

   A per-instance, machine-readable companion to the static per-code
   `remediation` prose: the prose says WHAT to do in a sentence, a fix is one
   row the UI can turn into a real affordance (a deep link into the settings
   row that changes the outcome, a wiki link, or a plain-text instruction).

   Exactly one of `settingKey` / `wikiPage` / neither is set on a given entry:
   a `wikiPage` names a whole PAGE (`wiki-links.ts`'s "no anchors" rule), so it
   cannot point at the section a specific fix is about — the wiki link is
   therefore its OWN entry, never a field tacked onto a setting-changing one.
   `endpointField` (wave 3) and `reasoningSetting` (wave 5) are declared now so
   those waves write into this same shape; nothing in 2b sets them. */
export interface AnalysisFailureFix {
  label: string;
  settingKey?: string;
  endpointField?: { endpointId: string; field: string }; // 3b+
  /** A page NAME, e.g. 'Analysis-and-the-Analyzer' — never an #anchor. */
  wikiPage?: string;
  reasoningSetting?: { engine: 'gemini' | 'ollama'; model: string }; // 5a
}

/** #3084 F7 — the fixes for a reasoning overflow, per transport. The ctx is the
    SAME shape `AnalyzerReasoningOverflowError.transport`/`.model` already carry,
    so the classify branch below passes them without a cast. `endpointId` is
    declared now and unused in 2b (3b starts passing it); `reasoningLevel` is
    5a's addition to this same ctx type, not this task's.

    Two local arrays, concatenated on return: `fixes` (actionable) and `reads`
    (`Read: …` wiki-link entries). That split — rather than ordering each
    branch's own pushes — is what keeps every wiki entry after every actionable
    one as 3b/5a/5b append their own entries, with no re-sort anywhere. */
export function reasoningOverflowFixes(ctx: {
  /** 'openai' with no endpointId returns []: there is no endpoint to name. */
  transport: TransportKind;
  model: string;
  /** The endpoint whose request overflowed (set by OpenAIAnalyzer; 3b). */
  endpointId?: string;
}): AnalysisFailureFix[] {
  const fixes: AnalysisFailureFix[] = []; // actionable — settingKey or label-only
  const reads: AnalysisFailureFix[] = []; // wiki-link entries only ("Read: …")

  if (ctx.transport === 'gemini') {
    /* Output-only: Gemini's input and output limits are separate, so lowering
       the request body (maxInputTokensPerRequest / outputHeavyChunkChars) never
       buys output room — the user copy says "splitting never helps", and these
       fixes must not contradict it.

       Conditional: only a NON-ZERO configured output cap that sits BELOW the
       model's known limit can be raised — at Auto (0) there is nothing to
       raise, and with an unknown limit (no cached catalog entry) there is no
       evidence the cap is the binding constraint. Either way the entry is
       omitted entirely rather than offered as a guess. */
    const configuredOutputCap = configValue<number>('analyzer.gemini.maxOutputTokens');
    const knownOutputLimit = getCachedGeminiModelInfo(ctx.model)?.outputTokenLimit;
    if (configuredOutputCap !== 0 && knownOutputLimit !== undefined && configuredOutputCap < knownOutputLimit) {
      fixes.push({
        label: 'Raise Gemini max output tokens (or set it back to Auto)',
        settingKey: 'analyzer.gemini.maxOutputTokens',
      });
    }
    /* F13 — label-only: no settingKey (and no wikiPage), so the renderer shows
       plain text rather than a link to a setting that cannot fix this. */
    fixes.push({ label: 'Switch to a different analyzer model' });
    reads.push({
      label: 'Read: When a model thinks past its output limit',
      wikiPage: 'Analysis-and-the-Analyzer',
    });
  } else if (ctx.transport === 'ollama') {
    /* num_ctx is the binding limit only while num_predict is unlimited (-1, the
       default). A positive num_predict bounds the reply first — raising num_ctx
       would change nothing — so name it first and drop the "binding" claim. */
    const numPredictPinned = configValue<number>('analyzer.ollama.numPredict') > 0;
    if (numPredictPinned) {
      fixes.push({
        label: 'Raise Ollama num_predict (or set it back to -1, unlimited)',
        settingKey: 'analyzer.ollama.numPredict',
      });
    }
    fixes.push(
      {
        label: numPredictPinned ? 'Raise Ollama num_ctx' : 'Raise Ollama num_ctx (the binding limit)',
        settingKey: 'analyzer.ollama.numCtx',
      },
      { label: 'Lower the stage-1 local input fraction', settingKey: 'analyzer.stage1.localInputFraction' },
      { label: 'Lower the stage-2 local input fraction', settingKey: 'analyzer.stage2.localInputFraction' },
      { label: 'Switch to a different analyzer model' },
    );
    reads.push({
      label: 'Read: When a model thinks past its output limit',
      wikiPage: 'Analysis-and-the-Analyzer',
    });
  } else if (ctx.transport === 'openai' && ctx.endpointId) {
    /* #3084 F7 (Task 3b.1b) — the endpoint's own output and context caps, plus the
       stage input fractions. Named by saved name, falling back to the id when the
       endpoint was deleted after the failure. No wikiPage yet: the endpoints page
       (F3) lands in PR 3d, which adds it with the page file. No reasoning or payload
       rows: those are 5a and 5b. */
    const name = listAnalyzerEndpoints().find((e) => e.id === ctx.endpointId)?.name ?? ctx.endpointId;
    fixes.push(
      { label: `Lower ${name}'s max output tokens`, endpointField: { endpointId: ctx.endpointId, field: 'maxOutputTokens' } },
      { label: `Lower ${name}'s context size`, endpointField: { endpointId: ctx.endpointId, field: 'contextTokens' } },
      { label: 'Shrink Stage 1 chunks', settingKey: 'analyzer.stage1.localInputFraction' },
      { label: 'Shrink Stage 2 chunks', settingKey: 'analyzer.stage2.localInputFraction' },
    );
  }

  /* The thinking window (analyzer.gemini.thinkingIdleTimeoutMs) never appears
     in either branch: it bounds silence, not output room, so it cannot fix an
     overflow (F7). */
  return [...fixes, ...reads];
}

/** #3084 pass-3 — the actionable half of `reasoningOverflowFixes` as one
    sentence of advice, for copy that cannot render structured fixes (the
    non-story warning is a plain string). Built FROM the fixes list — never a
    second hand-written copy — so it cannot name an entry the list omits (the
    Gemini output cap at Auto, num_predict at its default). "Read:" wiki-link
    entries are dropped; returns '' when there is nothing actionable. */
export function reasoningOverflowAdvice(ctx: Parameters<typeof reasoningOverflowFixes>[0]): string {
  return reasoningOverflowFixes(ctx)
    .filter((f) => !f.wikiPage)
    .map((f) => f.label)
    .join('; ');
}

/* #3084 PR 3b — the settings that shape a request, per transport, named in an
   analyzer-request-rejected remediation. Wave 5 adds the reasoning and
   custom-payload settings when they exist. */
const REQUEST_SHAPING_SETTINGS: Record<TransportKind, string[]> = {
  ollama: [
    'Ollama structured output (analyzer.ollama.structuredOutput)',
    'Ollama num_ctx (analyzer.ollama.numCtx)',
    'Ollama num_predict (analyzer.ollama.numPredict)',
  ],
  gemini: [
    'Gemini structured output (analyzer.gemini.structuredOutput)',
    'Gemini max output tokens (analyzer.gemini.maxOutputTokens)',
  ],
  openai: [
    "the endpoint's Structured output field",
    "the endpoint's Context size field",
  ],
};

const KEY_SETTING: Record<TransportKind, string> = {
  ollama: "the Ollama server's access settings",
  gemini: 'the Gemini API key (Settings, or GEMINI_API_KEY in server/.env)',
  openai: "the endpoint's API key",
};

/* #3084 P24 — an endpoint 400 whose message names a context, token or length
   limit is about the request's size. Auto output leaves a margin, but the
   input size is an estimate. */
const ENDPOINT_TOKEN_LIMIT_HINT =
  " The message names a token or context limit: lower the endpoint's Max output tokens field " +
  '(0 = Auto), or set its Context size field to the context the server actually serves.';

/* #3084 PR 3b — copy for an endpoint's final errors that no FailureCode fits
   exactly. `analyzer-unreachable` tells the user to start Ollama, `analyzer-request-rejected`
   is 400-only by contract, and `model-not-loaded` is TTS copy, so these classify
   as `unknown` with a curated message instead of the raw one. */
const ENDPOINT_FAILURE_REMEDIATION =
  "Check the endpoint's server log and that the model name exists on that server, then retry the " +
  'chapter. If it keeps failing, pick a different model or endpoint for this run.';
const ENDPOINT_UNREACHABLE_REMEDIATION =
  "Check that the endpoint's server is running and that its base URL in Settings is right, then " +
  'retry. Castwright switches to Gemini only when a Gemini key is saved and cloud fallback is on.';

function requestRejected(
  modelLabel: string,
  transport: TransportKind | undefined,
  providerMessage: string,
  envelopeDetail?: string,
): AnalysisFailure {
  const secrets = knownAnalyzerSecrets();
  const redacted = redactKnownSecrets(providerMessage, secrets).slice(0, 500);
  const settings = transport
    ? REQUEST_SHAPING_SETTINGS[transport]
    : Object.values(REQUEST_SHAPING_SETTINGS).flat();
  const limitHint = transport === 'openai' && namesContextOrTokenLimit(providerMessage) ? ENDPOINT_TOKEN_LIMIT_HINT : '';
  return {
    code: 'analyzer-request-rejected',
    userMessage: `${modelLabel} rejected the request (400): ${redacted}`,
    remediation: `${FAILURE_REMEDIATIONS['analyzer-request-rejected'].remediation} Settings that shape this request: ${settings.join('; ')}.${limitHint}`,
    /* A Google envelope keeps main's status/details block (failure-taxonomy.ts:556-560). */
    detail: (envelopeDetail !== undefined ? redactKnownSecrets(envelopeDetail, secrets) : redacted) || undefined,
  };
}

const INVALID_OUTPUT_HINT: Record<AnalyzerInvalidOutputError['structuredOutputMode'], string> = {
  schema: 'structured output was "schema"; this model or server may not enforce it',
  json: 'structured output was "json" — "schema" constrains the structure as well as the syntax',
  off: 'structured output was off — "json" or "schema" usually prevents this',
};

/* The advice follows the run's own mode. Gemini is never steered to "schema": whether it
   accepts that mode is still owed on-box acceptance (E112). */
function invalidOutputRemediation(
  transport: TransportKind,
  mode: AnalyzerInvalidOutputError['structuredOutputMode'],
): string {
  const lead = 'Retry the chapter. If it keeps failing, ';
  if (mode === 'schema') {
    return `${lead}Structured output is already "schema" for this run, so pick a stronger model or one this server enforces it for.`;
  }
  if (transport === 'gemini') {
    return mode === 'off'
      ? `${lead}set Gemini structured output to "json", or pick a stronger model.`
      : `${lead}pick a stronger model.`;
  }
  return mode === 'off'
    ? `${lead}set Structured output to "json" or "schema" for this engine or endpoint, or pick a stronger model.`
    : `${lead}set Structured output to "schema" for this engine or endpoint, or pick a stronger model.`;
}

/** Run-level analysis classifier — the unified replacement for analysis.ts's
    describeError(). Typed-error checks and the Google-envelope/status parsing
    are PORTED VERBATIM (same precedence, same message construction: model
    label, status suffix, quota trimming, detail blob); only the code
    vocabulary changes to FailureCode and a remediation is attached. Plain
    unmatched errors additionally fall through to the analysis signature scan
    (so ECONNREFUSED etc. classify here too). */
export function classifyAnalysisFailure(
  err: unknown,
  modelLabel: string,
  ctx?: { chapter?: { id: number; title?: string } },
): AnalysisFailure {
  /* #2260 FINAL ROUND (B2) — FIRST, ahead of every other branch, because a
     lock-acquisition timeout is the one class here whose own message must never
     reach a client: it embeds the lock key, which for every key space this can
     carry is an absolute path inside the user's workspace
     (`…\books\<Author>\<Series>\<Title>\.audiobook\cast.json`). Both analysis
     jobs hand this function's `userMessage` straight to `endJob(job, {kind:
     'error', message})`, which fans out over SSE to every subscriber including
     a paired phone on the LAN — so without this branch the six identity/
     authoritative fail-loud sites in `analysis.ts` broadcast the workspace
     layout, plus `withKeyLock:` and both cast-lock rule numbers, on ordinary
     contention. Below, `withCopy('unknown', raw)` is exactly what did that.

     Curated copy is the shared `LOCK_CONTENTION_REQUEST_ERROR` rather than a
     seventh phrasing of the same fact — the same constant the two merge routes
     return and a sibling of the five per-item routes'
     `LOCK_CONTENTION_ITEM_REASON`, so a reword moves one string. It is passed
     explicitly instead of being taken from `FAILURE_REMEDIATIONS`, which may
     not import anything (it crosses into the frontend bundle) and therefore
     cannot share the constant; its `lock-contention` entry carries the offline
     Help-view prose and the remediation this call pulls.

     NO `detail` deliberately: that blob renders in the UI's collapsible, so
     putting the raw message there would reinstate the leak one fold down. The
     raw error still reaches the server log at both call sites (`[analysis]
     failed` logs `message`, `[analysis-subset] failed` logs `stack`).

     Scoped to the ANALYSIS classifier, not added to `FAILURE_SIGNATURES` as a
     `source: 'both'` row: the constant cannot live in the signature table's
     copy map (above), and no generation path takes one of these locks, so a
     table row would be an untested claim of coverage. */
  if (isLockAcquisitionTimeout(err)) {
    return withCopy('lock-contention', LOCK_CONTENTION_REQUEST_ERROR);
  }
  if (err instanceof AnalyzerTruncatedError) {
    return withCopy(
      'analyzer-truncated',
      `${modelLabel} truncated the response (${err.reason}) — a chapter section is too large for one attribution call. Lower STAGE2_CHUNK_CHAR_BUDGET and retry.`,
      `engine=${err.engine} reason=${err.reason} bytes=${err.receivedBytes}${
        err.outputTokens ? ` tokens=${err.outputTokens}` : ''
      }`,
    );
  }
  if (err instanceof AnalyzerReasoningOverflowError) {
    const chapter = ctx?.chapter;
    const chapterLabel = chapter ? (chapter.title ? `chapter "${chapter.title}"` : `chapter ${chapter.id}`) : 'a chapter';
    /* #3084 F7 — userMessage is the what-happened headline only: naming the
       chapter, model and engine. It carries no "raise X" advice and no
       "then retry" — that imperative lives in remediation instead (below),
       which is per-code, not per-instance, so it cannot itself name the
       chapter; naming happens here. */
    return {
      ...withCopy(
        'analyzer-reasoning-overflow',
        `${modelLabel} spent its whole output budget reasoning on ${chapterLabel} and returned no answer, so the analysis stopped.`,
        `transport=${err.transport} model=${err.model}${chapter ? ` chapterId=${chapter.id}` : ''}${err.reasoningTokens ? ` reasoningTokens=${err.reasoningTokens}` : ''}`,
      ),
      /* #3084 F7 — the structured fixes for this exact instance. `err` already
         carries both ctx fields with the ctx's own types, so this is called
         with no cast. */
      fixes: reasoningOverflowFixes({ transport: err.transport, model: err.model, endpointId: err.endpointId }),
    };
  }
  if (err instanceof AnalyzerTimeoutError) {
    const detail = `transport=${err.transport} model=${err.model} reason=${err.reason} elapsedMs=${err.elapsedMs}`;
    if (err.reason === 'thinking-idle') {
      /* #3084 P5 — silence before any answer text, past the thinking window. */
      return withCopy(
        'analyzer-timeout',
        `${modelLabel} sent no answer text and stayed silent longer than its thinking window, so the request was stopped after ${Math.round(err.elapsedMs / 1000)} s. Raise 'Gemini thinking idle timeout' (analyzer.gemini.thinkingIdleTimeoutMs, GEMINI_THINKING_IDLE_MS; at most 290000 ms), or pick a faster model, then retry.`,
        detail,
      );
    }
    const setting =
      err.transport === 'gemini'
        ? "'Gemini request ceiling' (ANALYZER_GEMINI_REQUEST_CEILING_MS)"
        : "this endpoint's request ceiling";
    return withCopy(
      'analyzer-timeout',
      `${modelLabel} did not finish within ${Math.round(err.elapsedMs / 1000)} s (the request ceiling). Raise ${setting}, or pick a faster model, then retry.`,
      detail,
    );
  }
  if (err instanceof DailyQuotaExhaustedError) {
    return withCopy(
      'analyzer-daily-quota',
      `${modelLabel} daily quota exhausted — resets at ${err.resetAt.toISOString()}.`,
      `resetAt: ${err.resetAt.toISOString()}`,
    );
  }
  if (err instanceof AnalyzerKeyOriginError) {
    return withCopy(
      'auth',
      `The API key saved for ${err.endpointName} was entered for a different host, so it was not sent — re-enter the key for ${err.endpointName}.`,
      undefined,
      `Re-enter the API key for ${err.endpointName} — a saved key is only ever sent to the host it was entered for — then retry.`,
    );
  }
  if (err instanceof AnalyzerUnreachableError && err.transport === 'openai') {
    /* #3084 PR 3b, P28 — ENDPOINT errors only. Ollama's LocalUnreachableError
       (transport 'ollama') does not enter this branch: it falls through to main's
       path below (the signature scan over its message), so its code, copy and
       detail stay exactly main's (unreachable-failure-taxonomy.test.ts, captured
       on main). */
    return {
      code: 'analyzer-unreachable',
      userMessage: `${modelLabel} could not be reached: ${redactKnownSecrets(err.message, knownAnalyzerSecrets())}`,
      remediation: ENDPOINT_UNREACHABLE_REMEDIATION,
    };
  }
  if (err instanceof AnalyzerHttpError) {
    if (err.httpStatus === 401 || err.httpStatus === 403) {
      return withCopy(
        'auth',
        `${modelLabel} refused the credentials (${err.httpStatus}) — check ${KEY_SETTING[err.transport]}.`,
        redactKnownSecrets(err.bodyExcerpt, knownAnalyzerSecrets()) || undefined,
        `Check ${KEY_SETTING[err.transport]}, then retry the chapter.`,
      );
    }
    if (err.httpStatus === 400) return requestRejected(modelLabel, err.transport, err.bodyExcerpt);
    if (err.transport === 'openai') {
      /* #3084 PR 3b — an endpoint that answered with any other status (5xx, 404,
         422, or 0 for an error event inside the stream) is never "unreachable"
         (P21). No FailureCode fits it exactly (see ENDPOINT_FAILURE_REMEDIATION),
         so: `unknown`, a curated message and the redacted excerpt. An Ollama
         AnalyzerHttpError falls through to main's handling below, unchanged. */
      const excerpt = redactKnownSecrets(err.bodyExcerpt, knownAnalyzerSecrets()).slice(0, 500);
      const what = err.httpStatus === 0 ? 'sent an error inside its response stream' : `returned HTTP ${err.httpStatus}`;
      return {
        code: 'unknown',
        userMessage: `${modelLabel} ${what}: ${excerpt}`,
        remediation: ENDPOINT_FAILURE_REMEDIATION,
        detail: `transport=openai status=${err.httpStatus}`,
      };
    }
  }
  if (err instanceof AnalyzerStreamIncompleteError) {
    /* #3084 P22 — the pre-header case (a reset or DNS failure before any response)
       appends its sanitized cause code, so a persistent DNS failure never reads as
       a mid-answer drop. */
    return {
      code: 'unknown',
      userMessage:
        err.phase === 'before-response'
          ? `${modelLabel} dropped the connection before a response${causeCodeSuffix(err.causeCode)}, and retrying did not help.`
          : `${modelLabel} dropped the connection or stopped streaming before it finished its answer, and retrying did not help.`,
      remediation: ENDPOINT_FAILURE_REMEDIATION,
      detail: `transport=${err.transport} model=${err.model}${err.causeCode ? ` causeCode=${err.causeCode}` : ''}`,
    };
  }
  if (err instanceof AnalyzerTransportError && err.transport === 'openai') {
    /* #3084 P22 — a rebuilt transport error (rule 7). Its message holds only class
       names and the sanitized code. The curated copy names the endpoint and appends
       the code (ERR_SSL_WRONG_VERSION_NUMBER: https:// against a plain-HTTP server;
       UNABLE_TO_VERIFY_LEAF_SIGNATURE: an untrusted certificate;
       ERR_TLS_CERT_ALTNAME_INVALID: a hostname mismatch); the class chain goes to
       detail. Without this branch the fall-through signature scan could read a
       code-bearing message as Ollama copy. */
    return {
      code: 'unknown',
      userMessage: `${modelLabel} request failed${causeCodeSuffix(err.causeCode)}.`,
      remediation: ENDPOINT_FAILURE_REMEDIATION,
      detail: redactKnownSecrets(err.message, knownAnalyzerSecrets()),
    };
  }
  if (err instanceof AnalyzerEndpointMissingError) {
    return withCopy(
      'analyzer-endpoint-missing',
      `${err.message} Add it in Settings or pick another model.`,
    );
  }
  if (err instanceof AnalyzerInvalidOutputError) {
    return withCopy(
      'analyzer-invalid-output',
      `${modelLabel} returned output that failed validation twice (${INVALID_OUTPUT_HINT[err.structuredOutputMode]}).`,
      redactKnownSecrets(err.detail, knownAnalyzerSecrets()),
      invalidOutputRemediation(err.transport, err.structuredOutputMode),
    );
  }
  /* #3084 P22 — every branch below that shows raw provider text (the envelope,
     the bare status, the unknown fall-through) shows it with known secrets
     removed. With no secret present the text is unchanged. */
  const raw = redactKnownSecrets((err as Error)?.message ?? String(err), knownAnalyzerSecrets());
  const status = (err as { status?: number })?.status;

  const parsed = tryParseApiError(raw);
  if (parsed) {
    const code = statusToFailureCode(parsed.code ?? status, parsed.message, raw);
    if (code === 'analyzer-request-rejected') {
      return requestRejected(
        modelLabel,
        err instanceof ApiError ? 'gemini' : undefined,
        parsed.message,
        formatErrorDetail(parsed, raw),
      );
    }
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
    const code = statusToFailureCode(status, raw);
    if (code === 'analyzer-request-rejected') {
      return requestRejected(modelLabel, err instanceof ApiError ? 'gemini' : undefined, raw);
    }
    return withCopy(code, `${modelLabel} returned ${status}: ${raw}`);
  }
  /* Not an API envelope — give the signature table a chance (catches the
     connection-refused / fetch-failed family) before the unknown fallback. */
  const scanned = classifyAnalysisError(err);
  if (scanned.code !== 'unknown') {
    return { code: scanned.code, userMessage: scanned.userMessage, remediation: scanned.remediation };
  }
  return withCopy('unknown', raw || 'Analysis failed.');
}

/** #3084 P23 — the SSE error event for ANY error selection throws, coded through
    classifyAnalysisFailure: AnalyzerEndpointMissingError → analyzer-endpoint-missing,
    AnalyzerKeyOriginError → auth, anything else → its classified code. Never null, so
    no selection call site ends a stream uncoded or rethrows after the SSE headers.
    Per class of error, not per site: a class a later PR adds is coded here without
    touching the six call sites. */
export function analyzerSelectionErrorEvent(
  err: unknown,
): { kind: 'error'; code: FailureCode; message: string; remediation: string; detail?: string } {
  const failure = classifyAnalysisFailure(err, 'Analyzer');
  /* Selection's own missing-key Error (analyzer/index.ts) matches the `auth` signature, whose
     copy does not name what is missing; keep that as the detail the UI's collapsible shows.
     Every other detail comes from the classification itself. */
  const raw = err instanceof Error ? err.message : String(err);
  const missingKey = failure.code === 'auth' && GEMINI_KEY_REQUIRED.test(raw);
  const detail = failure.detail ?? (missingKey ? 'Gemini API key required' : undefined);
  return {
    kind: 'error',
    code: failure.code,
    /* The signature's `auth` copy ("Gemini TTS authentication failed") is wrong here: no request was
       sent, and it drops where the setting lives. Main's own sentence says both. */
    message: missingKey ? raw : failure.userMessage,
    remediation: failure.remediation,
    ...(detail ? { detail } : {}),
  };
}

const GEMINI_KEY_REQUIRED = /GEMINI_API_KEY is required/;
