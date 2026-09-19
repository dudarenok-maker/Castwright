/* Gemini analyzer — sends the same prompts the human would have run by hand
   through google.generativeai's free tier. Writes the prompt to inbox and the
   raw response to outbox for traceability (both gitignored), validates with
   the shared Zod schemas, and retries ONCE with the validation errors fed
   back as a follow-up turn before giving up. Drives the SSE progress bar
   via a setInterval ticking onWaiting while the API call is in flight. */

import { writeFile } from 'node:fs/promises';
import { configValue } from '../config/resolver.js';
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { writeInbox, errorPath, stage2HandoffKey, type HandoffKey } from '../handoff/protocol.js';
import {
  stage1Schema,
  stage1ChapterSchema,
  stage2ChapterSchema,
  emotionAnnotationSchema,
  scriptReviewSchema,
  stage3ChapterSchema,
  stage1GrammarSchema,
  stage1ChapterGrammarSchema,
  escalationSchema,
  nonStoryClassificationSchema,
  type Stage1Output,
  type Stage1ChapterOutput,
  type Stage2ChapterOutput,
  type EmotionAnnotationOutput,
  type ScriptReviewOutput,
  type Stage3ChapterOutput,
  type EscalationOutput,
  type NonStoryClassificationOutput,
} from '../handoff/schemas.js';
import type { Analyzer, StageCall, StageChunkInfo } from './types.js';
import { buildSystemInstruction, loadSkill, type SkillName } from './runner/prompt.js';
import { parseAndValidate, buildRetryMessage, summariseDetail, persistResponse } from './runner/parse.js';
import { AnalysisAbortedError, AnalyzerTruncatedError, GeminiContentBlockedError } from './errors.js';
import { geminiRateLimiter, DailyQuotaExhaustedError } from './rate-limit.js';
import { countCjkChars } from '../util/cjk.js';
import {
  LATIN_CHARS_PER_TOKEN,
  CYRILLIC_CHARS_PER_TOKEN,
  HAN_KANA_CHARS_PER_TOKEN,
  countCyrillic,
} from './token-budget.js';

export { loadSkill, buildSystemInstruction, languagePreamble } from './runner/prompt.js';
export type { SkillName } from './runner/prompt.js';
export { parseAndValidate, stripCodeFences, repairUnescapedQuotes, trimTrailingProse,
  repairStructuralPunctuation, buildRetryMessage, summariseDetail, persistResponse,
  type ParseResult,
} from './runner/parse.js';

/* Idle-chunk watchdog: if the SDK stream goes more than this long between
   chunks (or before the first chunk), assume the upstream is wedged and
   throw a retryable error so generateWithLimiter's retry loop kicks in.
   Calibrated against the observed worst case for healthy free-tier Flash
   Lite (~3–10 s per chunk under load) with comfortable headroom; raise if
   a slower model is added that legitimately blocks longer between tokens.

   Resolved at use-time from `GEMINI_STREAM_IDLE_MS` so tests can shrink
   the window (driving the 3-attempt retry exhaustion in ~1 s instead of
   ~2 min) and prod can tune without a rebuild. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/* Hard cap on the streamed-response accumulator. Bounds attacker/model-influenced
   memory growth in the same function as the `buf += text` sink (an in-CFG guard).
   The runtime `resolveMaxOutputTokens` cap is NOT visible to static analysis. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function appendBounded(buf: string, text: string, max = MAX_RESPONSE_BYTES): string {
  if (buf.length + text.length > max) {
    throw new Error('Analyzer response exceeded the maximum size.');
  }
  return buf + text;
}

export function resolveStreamIdleTimeoutMs(): number {
  const raw = process.env.GEMINI_STREAM_IDLE_MS;
  if (!raw) return STREAM_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : STREAM_IDLE_TIMEOUT_MS;
}

/* Explicit per-request output-token cap (#528). Gemini defaults to the model
   maximum when unset, which on a 507-sentence stage-2 chapter silently
   truncates the JSON mid-stream (finishReason MAX_TOKENS). We set it
   explicitly so the cap is visible + tunable, and — paired with the
   finishReason check in `generate()` — a hit surfaces as an
   `AnalyzerTruncatedError` instead of a corrupt buffer. Default 8192 matches
   the common free-tier ceiling; the stage-2 chunker keeps each call's expected
   output well under it. Shared env name with Ollama's num_predict knob. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export function resolveMaxOutputTokens(): number {
  return configValue<number>('analyzer.gemini.maxOutputTokens');
}

/** Live-read the cloud analyzer sampling temperature (registry wins). */
export function resolveGeminiTemperature(): number {
  return configValue<number>('analyzer.gemini.temperature');
}

/* Inter-attempt backoffs for the retry loop in generateWithLimiter.
   Exported so tests can shrink them via `GEMINI_RETRY_BACKOFFS_MS` — the
   1.5 s / 6 s production values plus 25% jitter would push a 3-attempt
   retry-exhaustion spec past the default 5 s test budget. */
export const BACKOFFS_MS: readonly number[] = parseBackoffsEnv() ?? [1500, 6000];
function parseBackoffsEnv(): number[] | null {
  const raw = process.env.GEMINI_RETRY_BACKOFFS_MS;
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parts.length > 0 ? parts : null;
}

/** Stream went silent for the watchdog window with no chunk. The
    `generateWithLimiter` retry loop catches this and treats it like a
    retryable 5xx so a wedged Gemini stream doesn't stall the entire
    per-chapter pipeline indefinitely (which is what happened pre-fix —
    the SDK iterator just sat in `for await` forever). */
export class GeminiStreamIdleError extends Error {
  readonly code = 'GEMINI_STREAM_IDLE';
  constructor(
    public readonly model: string,
    public readonly idleMs: number,
  ) {
    super(`Gemini ${model} stream went idle for ${idleMs}ms with no chunk.`);
    this.name = 'GeminiStreamIdleError';
  }
}

interface GeminiOptions {
  apiKey: string;
  model: string;
}

export class GeminiAnalyzer implements Analyzer {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(opts: GeminiOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    return this.runStage(
      manuscriptId,
      '1',
      'whole_book_stage1',
      promptMd,
      stage1GrammarSchema,
      stage1Schema,
      call,
    );
  }

  async runStage1Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage1ChapterOutput> {
    const key = `1-ch${chapterId}` as const;
    return this.runStage(
      manuscriptId,
      key,
      'per_chapter_stage1',
      promptMd,
      stage1ChapterGrammarSchema,
      stage1ChapterSchema,
      call,
    );
  }

  async runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput> {
    const key = stage2HandoffKey(chapterId, call.stage2CallSeq);
    return this.runStage(
      manuscriptId,
      key,
      'per_chapter_stage2',
      promptMd,
      stage2ChapterSchema,
      stage2ChapterSchema,
      call,
    );
  }

  async runEmotionChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<EmotionAnnotationOutput> {
    const key = `emotion-ch${chapterId}` as const;
    return this.runStage(
      manuscriptId,
      key,
      'emotion_annotation',
      promptMd,
      emotionAnnotationSchema,
      emotionAnnotationSchema,
      call,
    );
  }

  async runNonStoryClassification(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput> {
    const key = `nonstory-ch${chapterId}` as const;
    return this.runStage(
      manuscriptId,
      key,
      'non_story_classification',
      promptMd,
      nonStoryClassificationSchema,
      nonStoryClassificationSchema,
      call,
    );
  }

  async runScriptReviewChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<ScriptReviewOutput> {
    const key = `review-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 'script_review', promptMd, scriptReviewSchema, scriptReviewSchema, call);
  }

  async runStage3Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage3ChapterOutput> {
    const key = `instruct-ch${chapterId}` as const;
    return this.runStage(
      manuscriptId,
      key,
      'instruct_annotation',
      promptMd,
      stage3ChapterSchema,
      stage3ChapterSchema,
      call,
    );
  }

  /* srv-59 Task 9 — flagged-window attribution escalation. Deliberately NOT
     built on runStage: that helper validates-then-retries-then-throws,
     which is wrong here — an empty/RECITATION-blocked reply must resolve to
     `null` (never a throw) so the caller just skips the window, with no
     retry (a second identical call burns latency on a best-effort pass).
     The prompt is fully self-contained (built by escalateFlaggedWindows,
     Task 9b), so it goes as the sole user turn with no system instruction /
     skill file. Still routed through `generateWithLimiter` — so every call
     (there are no retries here, so "every call" is just the one) still
     acquires the per-model rate limiter exactly like every other Gemini
     call; nothing about this path bypasses it. */
  async runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null> {
    const key = `escalation-ch${chapterId}-w${windowIndex}` as const;
    await writeInbox(manuscriptId, key, prompt);

    let text: string;
    try {
      text = await this.generateWithLimiter(
        [{ role: 'user', parts: [{ text: prompt }] }],
        '',
        call,
      );
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      /* Everything else (empty/blocked response, truncation, retry-budget
         exhaustion) — this pass is best-effort, so surface "no usable
         answer" rather than hard-failing the whole chapter over one
         escalation window. */
      console.warn(
        `[gemini] ${this.model} ${key} produced no usable response: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }

    const attempt = parseAndValidate(text, escalationSchema);
    if (!attempt.ok) {
      console.warn(`[gemini] ${this.model} ${key} failed to parse: ${attempt.kind}`);
      return null;
    }
    await persistResponse(manuscriptId, key, text);
    return attempt.value;
  }

  private async runStage<T>(
    manuscriptId: string,
    key: HandoffKey,
    skillName: SkillName,
    promptMd: string,
    _grammarSchema: z.ZodType<unknown>,
    validationSchema: z.ZodType<T>,
    call: StageCall,
  ): Promise<T> {
    await writeInbox(manuscriptId, key, promptMd);

    const skill = await loadSkill(skillName);
    const systemInstruction = buildSystemInstruction(skill, call.language, skillName);

    const start = Date.now();
    const tick = call.onWaiting
      ? setInterval(() => call.onWaiting!(Date.now() - start), 500)
      : null;

    try {
      const firstText = await this.generateWithLimiter(
        [{ role: 'user', parts: [{ text: promptMd }] }],
        systemInstruction,
        call,
      );

      const firstAttempt = parseAndValidate(firstText, validationSchema);
      if (firstAttempt.ok) {
        await persistResponse(manuscriptId, key, firstText);
        return firstAttempt.value;
      }

      // Retry once with the validation errors fed back.
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify(
          { kind: firstAttempt.kind, detail: firstAttempt.detail, attempt: 1 },
          null,
          2,
        ),
        'utf8',
      );

      const followup = buildRetryMessage(firstAttempt);
      const secondText = await this.generateWithLimiter(
        [
          { role: 'user', parts: [{ text: promptMd }] },
          { role: 'model', parts: [{ text: firstText }] },
          { role: 'user', parts: [{ text: followup }] },
        ],
        systemInstruction,
        call,
      );

      const secondAttempt = parseAndValidate(secondText, validationSchema);
      if (secondAttempt.ok) {
        await persistResponse(manuscriptId, key, secondText);
        return secondAttempt.value;
      }

      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify(
          {
            kind: secondAttempt.kind,
            detail: secondAttempt.detail,
            attempt: 2,
            firstError: { kind: firstAttempt.kind, detail: firstAttempt.detail },
          },
          null,
          2,
        ),
        'utf8',
      );
      throw new Error(
        `Gemini ${key} failed validation after retry: ${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
      );
    } finally {
      if (tick) clearInterval(tick);
    }
  }

  /* Retry policy: every attempt (primary + retries) goes through the
     per-model rate limiter so retries can't push us over the RPM/TPM cap
     and cause the very 429s we're retrying.

     • 5xx (500/503/504) — bounded retries with exponential backoff +
       jitter, limiter re-acquired before each.
     • 429 per-minute throttle — parse Google's `retry-delay` from
       `details[]`, feed it into the limiter via `recordRejection`, then
       retry up to MAX_ATTEMPTS-1 times.
     • 429 daily-quota — re-thrown as `DailyQuotaExhaustedError` (no
       retry); also long-blocks the model in the limiter so other
       in-flight workers stop hitting it.
     • Anything else — re-thrown immediately. */
  private async generateWithLimiter(
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    systemInstruction: string,
    call: StageCall,
  ): Promise<string> {
    const MAX_ATTEMPTS = 3;
    const MAX_TOTAL_MS = 90_000;
    const BACKOFFS = BACKOFFS_MS;
    const estTokens = estimateInputTokens(systemInstruction, contents);
    const start = Date.now();
    let lastErr: unknown = null;

    const onWaitForLimiter = (waitMs: number, reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after') => {
      if (waitMs > 1000) call.onThrottle?.(waitMs, reason);
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (Date.now() - start >= MAX_TOTAL_MS) break;

      await geminiRateLimiter.acquire(this.model, estTokens, {
        signal: call.signal,
        onWait: onWaitForLimiter,
      });

      try {
        const out = await this.generate(contents, systemInstruction, call.signal, call.onChunk);
        if (out.promptTokenCount && Number.isFinite(out.promptTokenCount)) {
          geminiRateLimiter.recordActualTokens(this.model, out.promptTokenCount);
        }
        return out.text;
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number })?.status;
        const message = (err as Error)?.message ?? String(err);

        /* Caller pause: tear down immediately, do NOT retry. Matches the
           Ollama analyzer's contract so the route layer's
           `err instanceof AnalysisAbortedError` branch fires for both
           engines. */
        if (err instanceof AnalysisAbortedError) throw err;

        /* Output truncation (#528): replaying the same oversized prompt just
           truncates again, so don't burn the retry budget — re-throw and let
           the stage-2 chunker split the chapter into smaller calls. */
        if (err instanceof AnalyzerTruncatedError) throw err;

        /* Idle-stream watchdog tripped — the SDK stream never emitted a
           chunk for the watchdog window. Retry with the same backoff shape
           as a 5xx; if we exhaust attempts, the error propagates and the
           route classifies it as a chapter failure. */
        if (err instanceof GeminiStreamIdleError) {
          if (attempt >= MAX_ATTEMPTS - 1) break;
          const backoff = jitterMs(BACKOFFS[attempt] ?? 6000);
          console.warn(
            `[gemini] stream idle ${err.idleMs}ms — retrying in ${backoff}ms (attempt ${attempt + 2}/${MAX_ATTEMPTS})`,
          );
          if (backoff > 1000) call.onThrottle?.(backoff, 'retry-after');
          await sleep(backoff, call.signal);
          continue;
        }

        if (status === 429) {
          /* Daily-quota markers: same regex as routes/analysis.ts so
             classification stays in lockstep. No retry. Also block the
             limiter for the rest of the day so concurrent workers
             short-circuit instead of round-tripping.
             NOTE: `free[_-]?tier` alone is NOT a valid marker here — the
             per-minute input-token quota's message also contains
             "free_tier" (via the metric name
             generate_content_free_tier_input_token_count), so that
             alternative used to false-positive-match a retryable
             per-minute 429 as fatal daily exhaustion (#1682). Require a
             genuine `per_day` marker (matches `per_day` and the `PerDay`
             quotaId under /i). The old small-value `quotaValue":"\d{1,3}"`
             companion clause was DROPPED (#1695): the free-tier per-MINUTE
             request cap is 15 (a 2-digit quotaValue), so an RPM 429 collided
             with the digit heuristic and was mis-read as daily exhaustion. */
          if (/per[_-]?day/i.test(message)) {
            const resetAt = nextUtcMidnight();
            geminiRateLimiter.recordRejection(this.model, resetAt.getTime() - Date.now());
            throw new DailyQuotaExhaustedError(this.model, resetAt);
          }
          /* Per-minute throttle. Feed Google's retry-delay back into the
             limiter, then back off (max of Google's hint and our local
             exponential backoff) and retry if attempts remain. */
          const retryAfterMs = parseRetryDelayMs(err);
          geminiRateLimiter.recordRejection(this.model, retryAfterMs);
          if (attempt >= MAX_ATTEMPTS - 1) break;
          const backoff = jitterMs(Math.max(retryAfterMs ?? 0, BACKOFFS[attempt] ?? 6000));
          console.warn(
            `[gemini] 429 — retrying in ${backoff}ms (attempt ${attempt + 2}/${MAX_ATTEMPTS})`,
          );
          if (backoff > 1000) call.onThrottle?.(backoff, 'retry-after');
          await sleep(backoff, call.signal);
          continue;
        }

        if (isRetryable5xx(err)) {
          if (attempt >= MAX_ATTEMPTS - 1) break;
          const backoff = jitterMs(BACKOFFS[attempt] ?? 6000);
          console.warn(
            `[gemini] transient ${describeStatus(err)} — retrying in ${backoff}ms (attempt ${attempt + 2}/${MAX_ATTEMPTS})`,
          );
          if (backoff > 1000) call.onThrottle?.(backoff, 'retry-after');
          await sleep(backoff, call.signal);
          continue;
        }

        throw err;
      }
    }

    /* Retry budget exhausted — re-throw the last upstream error so the
       route layer can classify it correctly (rate_limit / unavailable /
       internal). */
    throw lastErr ?? new Error('Gemini retry budget exhausted with no recorded error.');
  }

  /* Streamed generation. Iterating the stream gives us a per-chunk
     heartbeat — first chunk usually arrives within 1–3s, every subsequent
     chunk is hard proof the model is alive. The route layer surfaces this
     as a live "Receiving response · N KB · last chunk Ms ago" indicator and
     a watchdog that warns when chunks stop arriving.

     Two abort surfaces feed in:
     - `callerSignal` (`call.signal`) — the per-job AbortController fired
       by `/analysis/pause` or an SSE-client disconnect.
     - An internal `watchdog` AbortController fired by the idle-chunk timer
       below if the stream goes the watchdog window without a chunk.
       Pre-fix, the SDK's async-iterator could sit in `for await`
       indefinitely when Google's stream stalled mid-response; the watchdog
       converts that into a retryable `GeminiStreamIdleError`.

     The two are composed with `AbortSignal.any` (Node ≥ 20.3) and passed
     as `config.abortSignal` so the SDK tears the underlying HTTP request
     down at the network layer. Belt-and-braces: the iterator pull also
     races against an `abort`-listener promise, so we tear down even if
     the SDK ignores its signal.

     Returns the assembled text plus the prompt token count if the SDK
     exposed it on any chunk's usageMetadata — the limiter reconciles its
     TPM estimate against this. */
  private async generate(
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    systemInstruction: string,
    callerSignal: AbortSignal | undefined,
    onChunk?: (info: StageChunkInfo) => void,
  ): Promise<{ text: string; promptTokenCount?: number }> {
    const watchdog = new AbortController();
    let idleFired = false;

    const signals: AbortSignal[] = [watchdog.signal];
    if (callerSignal) signals.push(callerSignal);
    const combined = AbortSignal.any(signals);

    const idleTimeoutMs = resolveStreamIdleTimeoutMs();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        watchdog.abort();
      }, idleTimeoutMs);
    };
    const disarmIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    /* Promise that rejects when the combined signal fires. The
       Promise.race below uses this to break out of an iterator pull
       *independently* of whether the SDK honors `config.abortSignal` at
       the network layer — so the watchdog reliably tears down a wedged
       stream even against a non-cooperative iterator (the historical
       failure mode this whole patch exists to fix). */
    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('__gemini_abort_race__'));
      if (combined.aborted) onAbort();
      else combined.addEventListener('abort', onAbort, { once: true });
    });
    const releaseAbortListener = () => {
      if (onAbort) combined.removeEventListener('abort', onAbort);
    };

    try {
      armIdleTimer();
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          responseMimeType: 'application/json',
          systemInstruction,
          abortSignal: combined,
          maxOutputTokens: resolveMaxOutputTokens(),
          temperature: resolveGeminiTemperature(),
        },
      });
      const start = Date.now();
      let lastChunkAt = start;
      let buf = '';
      let promptTokenCount: number | undefined;
      let candidatesTokenCount: number | undefined;
      /* Track the model's own stop reason. `STOP` = clean finish; `MAX_TOKENS`
         (or SAFETY/RECITATION) means the response was cut off — see the
         post-loop truncation check (#528). */
      let finishReason: string | undefined;
      /* Prompt-level block reason (e.g. SAFETY) — distinct from the
         candidate's finishReason. Set when the model rejects the *prompt*
         outright and returns no candidate at all. */
      let blockReason: string | undefined;
      const iterator = (stream as AsyncIterable<{ text?: string }>)[Symbol.asyncIterator]();
      while (true) {
        const next = (await Promise.race([iterator.next(), abortPromise])) as IteratorResult<{
          text?: string;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          candidates?: Array<{ finishReason?: string }>;
          promptFeedback?: { blockReason?: string };
        }>;
        if (next.done) break;
        armIdleTimer();
        const chunk = next.value;
        const text = chunk.text;
        const usage = chunk.usageMetadata;
        if (usage?.promptTokenCount && Number.isFinite(usage.promptTokenCount)) {
          promptTokenCount = usage.promptTokenCount;
        }
        if (usage?.candidatesTokenCount && Number.isFinite(usage.candidatesTokenCount)) {
          candidatesTokenCount = usage.candidatesTokenCount;
        }
        const chunkFinish = chunk.candidates?.[0]?.finishReason;
        if (chunkFinish) finishReason = chunkFinish;
        const chunkBlock = chunk.promptFeedback?.blockReason;
        if (chunkBlock) blockReason = chunkBlock;
        if (!text) continue;
        buf = appendBounded(buf, text);
        const now = Date.now();
        onChunk?.({
          receivedBytes: buf.length,
          receivedText: buf,
          sinceLastChunkMs: now - lastChunkAt,
          elapsedMs: now - start,
        });
        lastChunkAt = now;
      }
      if (!buf) {
        /* The stream finished with zero text. Two OPPOSITE causes hide here and
           must be told apart by the stop reason — misclassifying one as the
           other either fails a recoverable run or grinds a doomed one:

           1. MAX_TOKENS — the model hit its OUTPUT cap before emitting any
              decodable text (a dense / over-budget chunk on a small-cap model
              like gemma-4-31b-it). This is a SIZE problem, not a content block:
              splitting the input shrinks the required output until it fits.
              Route it to AnalyzerTruncatedError — the SAME classified error the
              non-empty-buffer truncation gate below throws — so the stage-2
              chunker adaptively re-splits the span and recovers. Keyed on the
              reason, not the model id, so it holds for every Gemini/Gemma model.
           2. RECITATION / SAFETY / a promptFeedback.blockReason — a genuine
              content-filter block. The same filter blocks every chapter
              identically, so retry/split is futile: fail fast with a *plain*,
              whole-book-fatal typed sentinel that NAMES the reason (run-level
              consumers key off the type + the taxonomy matches by name). */
        if (finishReason === 'MAX_TOKENS') {
          throw new AnalyzerTruncatedError('gemini', finishReason, 0, candidatesTokenCount);
        }
        const stopReason = finishReason ?? blockReason;
        throw new GeminiContentBlockedError(this.model, stopReason);
      }
      /* Truncation gate (#528): the stream completed but the model stopped
         because it hit the output cap (or a safety/recitation block), not
         because it finished. Returning `buf` here would hand a corrupt
         (mid-JSON) payload to parseAndValidate, which fails, retries at the
         same size, and ultimately surfaces as a silent reset. Throw a
         classified error so the retry loop short-circuits and the stage-2
         chunker can split the chapter. `FINISH_REASON_UNSPECIFIED` and a
         missing reason are treated as clean (some SDK paths omit it on the
         text-bearing chunks). */
      if (finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
        throw new AnalyzerTruncatedError('gemini', finishReason, buf.length, candidatesTokenCount);
      }
      return { text: buf, promptTokenCount };
    } catch (err) {
      /* Classify aborts before logging so a clean pause / idle-timeout
         doesn't get smeared into the 5xx-style "[gemini] generate failed"
         line that the route layer surfaces to the UI. */
      if (idleFired) {
        throw new GeminiStreamIdleError(this.model, idleTimeoutMs);
      }
      if (callerSignal?.aborted) {
        throw new AnalysisAbortedError(
          `Gemini ${this.model} stream aborted (paused or client disconnected).`,
        );
      }

      /* Output truncation (#528) — already classified; log cleanly and
         re-throw so the chunker can react. Not the generic 5xx "failed" line. */
      if (err instanceof AnalyzerTruncatedError) {
        console.warn(
          `[gemini] output truncated reason=${err.reason} bytes=${err.receivedBytes}` +
            (err.outputTokens ? ` tokens=${err.outputTokens}` : '') +
            ` model=${this.model}`,
        );
        throw err;
      }

      /* The SDK's ApiError keeps the upstream body inside `.message` as a
         JSON envelope, so a bare console.error(err) only shows the stack +
         the start of the message. Force a structured dump so the server log
         carries the upstream `status` ('INTERNAL', 'INVALID_ARGUMENT', …)
         and any `details[]` payload — the only useful diagnostic for 5xx
         flakes. The route layer surfaces the same info to the UI. */
      const status = (err as { status?: number })?.status;
      const message = (err as Error)?.message ?? String(err);
      const userTurn = contents[contents.length - 1]?.parts[0]?.text ?? '';
      console.error('[gemini] generate failed', {
        model: this.model,
        status,
        name: (err as Error)?.name,
        message,
        userTurnLength: userTurn.length,
        userTurnHead: userTurn.slice(0, 200),
      });
      throw err;
    } finally {
      disarmIdleTimer();
      releaseAbortListener();
    }
  }
}

function isRetryable5xx(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 500 || status === 503 || status === 504;
}

function describeStatus(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) return '429 rate-limit';
  if (status === 503) return '503 unavailable';
  if (status === 500) return '500 internal';
  if (status === 504) return '504 timeout';
  return String(status ?? 'unknown');
}

/* Sleep `ms`, rejecting promptly if `signal` fires. Used between retry
   attempts in `generateWithLimiter` so an aborted analysis tears down
   the backoff immediately instead of waiting out the full delay. Throws
   `AnalysisAbortedError` (not a plain Error) so the route layer's
   `err instanceof AnalysisAbortedError` branch fires and emits the
   structured `error: aborted` event the UI uses to distinguish pause
   from a real failure. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  /* Bind the clamp to a const that feeds setTimeout directly so the bound is
     provable at the sink (js/resource-exhaustion barrier). */
  const delay = Math.min(ms, 60_000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AnalysisAbortedError('Aborted during gemini retry backoff.'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* Estimate input tokens for an acquire. Sums the system instruction and
   every text part across all turns of `contents`, then divides by a
   script-aware chars-per-token approximation, plus a flat +1,000
   ceiling-margin for schema overhead and tokenisation surprises.

   fs-2 — Latin text tokenises at ~4 chars/token; Cyrillic is far denser
   (~2.5 chars/token), so the old flat /4 under-counted a Russian chapter by
   ~40% and risked the rate limiter under-reserving into 429 storms. We measure
   the Cyrillic fraction of the actual text and interpolate the divisor between
   4 (all-Latin) and 2.5 (all-Cyrillic). Reconciled against
   `usageMetadata.promptTokenCount` once the call returns, so the blend only has
   to be close, not exact.

   fs-59 — CJK (Han ideographs + Kana) is denser still (~1.2 chars/token), so
   a CJK-dense prompt under-counted even worse than Cyrillic did. We measure
   the Han/Kana fraction the same way as `countCyrillic` and fold it into the
   same additive interpolation — Cyrillic and CJK never overlap in the same
   codepoint, so each fraction pulls the divisor down from the Latin baseline
   independently. */

export function estimateInputTokens(
  systemInstruction: string,
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
): number {
  let chars = systemInstruction.length;
  let cyrillic = 0;
  let hanKana = 0;
  cyrillic += countCyrillic(systemInstruction);
  hanKana += countCjkChars(systemInstruction);
  for (const turn of contents) {
    for (const part of turn.parts) {
      chars += part.text.length;
      cyrillic += countCyrillic(part.text);
      hanKana += countCjkChars(part.text);
    }
  }
  const cyrillicFraction = chars > 0 ? cyrillic / chars : 0;
  const hanKanaFraction = chars > 0 ? hanKana / chars : 0;
  const divisor =
    LATIN_CHARS_PER_TOKEN -
    cyrillicFraction * (LATIN_CHARS_PER_TOKEN - CYRILLIC_CHARS_PER_TOKEN) -
    hanKanaFraction * (LATIN_CHARS_PER_TOKEN - HAN_KANA_CHARS_PER_TOKEN);
  return Math.ceil(chars / divisor) + 1_000;
}

/* Apply ±25% jitter to a backoff base. Keeps parallel workers from
   re-entering the same RPM window in lockstep. */
function jitterMs(baseMs: number): number {
  const j = baseMs * 0.5 * (Math.random() - 0.5); // ±25% range
  return Math.max(0, Math.round(baseMs + j));
}

/* Parse `retry-delay` from a Gemini SDK error's `details[]` array. The
   error message wraps a JSON envelope with shape:
     { error: { code, message, status, details: [{
         "@type": "type.googleapis.com/google.rpc.RetryInfo",
         "retryDelay": "15s"
       }, ...] } }
   Returns ms or null when the field isn't present. */
export function parseRetryDelayMs(err: unknown): number | null {
  const raw = (err as Error)?.message ?? String(err);
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start)) as {
      error?: { details?: Array<{ '@type'?: string; retryDelay?: string }> };
    };
    const details = obj?.error?.details ?? [];
    for (const d of details) {
      const type = d['@type'] ?? '';
      const delay = d.retryDelay;
      if (typeof delay === 'string' && type.includes('RetryInfo')) {
        /* Common shapes: "15s", "1.5s", "500ms", "0.5s". */
        const m = delay.match(/^([\d.]+)(ms|s)?$/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n)) return m[2] === 'ms' ? n : Math.round(n * 1000);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/* Next UTC midnight from `now`. Used to report when a daily quota
   resets; aligns with Google's free-tier reset boundary. */
export function nextUtcMidnight(now: number = Date.now()): Date {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}
