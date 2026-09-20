/* Gemini analyzer — sends the same prompts the human would have run by hand
   through google.generativeai's free tier. Writes the prompt to inbox and the
   raw response to outbox for traceability (both gitignored), validates with
   the shared Zod schemas, and retries ONCE with the validation errors fed
   back as a follow-up turn before giving up. Drives the SSE progress bar
   via a setInterval ticking onWaiting while the API call is in flight. */

import { writeFile } from 'node:fs/promises';
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
import type { Analyzer, StageCall } from './types.js';
import { buildSystemInstruction, loadSkill, estimateInputTokens, type SkillName } from './runner/prompt.js';
import { parseAndValidate, buildRetryMessage, summariseDetail, persistResponse } from './runner/parse.js';
import { AnalysisAbortedError, AnalyzerTruncatedError, GeminiContentBlockedError } from './errors.js';
import { geminiRateLimiter } from './rate-limit.js';
import { withTransportRetry } from './runner/transport-retry.js';
import type { TransportRequest, ChatMessage } from './runner/transport.js';
import {
  GeminiTransport,
  resolveGeminiTemperature,
  GEMINI_RETRY_CLASSIFIER,
} from './transports/gemini-transport.js';

/* Re-exports for backward compatibility — callers and tests that imported
   these from gemini.ts still resolve after the wave-1 extraction. */
export { loadSkill, buildSystemInstruction, languagePreamble, estimateInputTokens } from './runner/prompt.js';
export type { SkillName } from './runner/prompt.js';
export { parseAndValidate, stripCodeFences, repairUnescapedQuotes, trimTrailingProse,
  repairStructuralPunctuation, buildRetryMessage, summariseDetail, persistResponse,
  type ParseResult,
} from './runner/parse.js';
export { GeminiStreamIdleError, resolveMaxOutputTokens, resolveGeminiTemperature,
  STREAM_IDLE_TIMEOUT_MS, MAX_RESPONSE_BYTES, appendBounded, resolveStreamIdleTimeoutMs,
} from './transports/gemini-transport.js';
export { BACKOFFS_MS, parseRetryDelayMs } from './runner/transport-retry.js';
export { nextUtcMidnight } from './rate-limit.js';

interface GeminiOptions {
  apiKey: string;
  model: string;
}

export class GeminiAnalyzer implements Analyzer {
  private readonly transport: GeminiTransport;
  private readonly model: string;

  constructor(opts: GeminiOptions) {
    this.transport = new GeminiTransport(opts);
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
     and cause the very 429s we're retrying. The retry loop, error
     classification, backoff with jitter, and daily-quota detection now
     live in `withTransportRetry` (runner/transport-retry.ts) — shared
     across all transports. The Gemini-specific error→disposition mapping
     lives in `GEMINI_RETRY_CLASSIFIER` (transports/gemini-transport.ts).

     The transport (`GeminiTransport.send`) NEVER throws for a completed
     response: MAX_TOKENS / SAFETY / RECITATION are reported through the
     `finish` field on `TransportResult`. Only abort / idle / HTTP / quota
     errors throw and enter the retry loop. This method maps the completed
     result back to the typed errors (`AnalyzerTruncatedError`,
     `GeminiContentBlockedError`) the route layer expects. */
  private async generateWithLimiter(
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    systemInstruction: string,
    call: StageCall,
  ): Promise<string> {
    const messages: ChatMessage[] = contents.map((t) => ({
      role: t.role === 'model' ? ('assistant' as const) : ('user' as const),
      content: t.parts.map((p) => p.text).join(''),
    }));

    const estTokens = estimateInputTokens(systemInstruction, contents);

    const req: TransportRequest = {
      system: systemInstruction,
      messages,
      structuredOutput: { mode: 'json' },
      temperature: resolveGeminiTemperature(),
      estimatedInputTokens: estTokens,
      signal: call.signal,
      call: {
        onChunk: call.onChunk,
        onWaiting: call.onWaiting,
        onThrottle: call.onThrottle,
        onEvalTiming: call.onEvalTiming,
      },
    };

    const result = await withTransportRetry(() => this.transport.send(req), {
      model: this.model,
      limiter: geminiRateLimiter,
      estimatedInputTokens: estTokens,
      classifier: GEMINI_RETRY_CLASSIFIER,
      logTag: 'gemini',
      displayName: 'Gemini',
      signal: call.signal,
      onThrottle: (waitMs, reason) => {
        if (waitMs > 1000) call.onThrottle?.(waitMs, reason);
      },
      /* The transport already reconciles prompt tokens internally on
         finish === 'stop' via geminiRateLimiter.recordActualTokens, so we
         do NOT pass recordActualTokens here — that would double-count. */
    });

    /* Map transport finish to the typed errors the route layer expects.
       The transport never throws for completed responses — MAX_TOKENS /
       SAFETY / RECITATION are reported through `finish`. */
    if (result.finish === 'length') {
      throw new AnalyzerTruncatedError(
        'gemini',
        result.finishReason ?? 'MAX_TOKENS',
        result.receivedBytes,
        result.usage?.outputTokens,
      );
    }
    if (result.finish === 'blocked') {
      throw new GeminiContentBlockedError(this.model, result.blockReason ?? result.finishReason);
    }
    return result.text;
  }
}
