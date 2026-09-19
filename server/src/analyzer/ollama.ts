/* Local Ollama analyzer. Header + chat() moved to transports/ollama-transport.ts (#3084 wave 1b). */

import { writeFile } from 'node:fs/promises';
import { fetch as undiciFetch, Agent } from 'undici';
import { z } from 'zod';
import { acquireAnalyzerSlot, describeAnalyzerConcurrency } from './analyzer-concurrency.js';
import { isAnyAnalyzerRunBusy } from '../tts/design-lock.js';
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import { writeInbox, errorPath, rawAttemptPath, stage2HandoffKey, type HandoffKey } from '../handoff/protocol.js';
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
import type { RawEvalTiming } from './analyzer-eval-stats.js';
import { parseAndValidate, buildRetryMessage, summariseDetail, persistResponse } from './runner/parse.js';
import { loadSkill, buildSystemInstruction, type SkillName } from './runner/prompt.js';
import { OllamaTransport, ANALYZER_DISPATCHER, classifyConnectError } from './transports/ollama-transport.js';
import { resolveOllamaTemperature, resolveOllamaRetryTemperature } from './ollama-settings.js';
import { mapFinish } from './runner/finish.js';
import type { ChatMessage } from './runner/transport.js';
import { AnalysisAbortedError, LocalUnreachableError } from './errors.js';
export { AnalysisAbortedError, LocalUnreachableError } from './errors.js';
export { ANALYZER_DISPATCHER, classifyConnectError } from './transports/ollama-transport.js';
export {
  resolveOllamaTemperature, resolveOllamaRetryTemperature,
  resolveKeepAliveSeconds, hasKeepAliveOverride, keepAliveFor,
  normalizeModelTag, resolveAnalyzerNumCtx, resolveAnalyzerNumGpu, resolveNumPredict,
  DEFAULT_TEMPERATURE, INVALID_JSON_RETRY_TEMPERATURE,
  ANALYZER_NUM_CTX, ANALYZER_NUM_GPU,
} from './ollama-settings.js';

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  console.log(describeAnalyzerConcurrency());
}

interface OllamaOptions {
  /** Base URL of the Ollama daemon (e.g. http://localhost:11434).
      Trailing slash already stripped by getResolvedOllamaUrl. */
  url: string;
  /** Model tag passed to /api/chat (e.g. `qwen3.5:9b`). */
  model: string;
  /** Injected undici dispatcher — for testing only. Defaults to the
      module-level ANALYZER_DISPATCHER singleton. */
  dispatcher?: Agent;
}

/* Absolute ceiling for a one-shot persona generation. Needed because
   ANALYZER_DISPATCHER removes undici's implicit 300s bound and this call site
   has no caller-supplied signal to fall back on; see the note in
   generatePersonaViaOllama. Deliberately generous: the whole point of the
   dispatcher is that a large model on CPU legitimately takes minutes. Mirrors
   DESIGN_ABSOLUTE_MAX_MS in tts/design-voice-core.ts. */
export const PERSONA_ABSOLUTE_MAX_MS = 600_000;

export class OllamaAnalyzer implements Analyzer {
  private readonly model: string;
  private readonly transport: OllamaTransport;

  constructor(opts: OllamaOptions) {
    this.model = opts.model;
    this.transport = new OllamaTransport({ url: opts.url, model: opts.model, dispatcher: opts.dispatcher });
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
     built on top of runStage: that helper's contract is "validate-then-retry-
     then-throw", which is exactly wrong here — an empty/RECITATION-blocked
     reply must resolve to `null` (never a throw) so the caller just skips
     the window, and there's no retry (a second identical call burns latency
     for a best-effort pass). The prompt is fully self-contained (built by
     escalateFlaggedWindows, Task 9b) so this sends it as a single user turn
     with no system instruction / skill file, unlike every other runStage*
     call. `escalationSchema` doubles as the Ollama structured-output grammar
     (via `format`) and the post-hoc validator — same pattern as the other
     stages, just without the retry loop. */
  async runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null> {
    const key = `escalation-ch${chapterId}-w${windowIndex}` as const;
    await writeInbox(manuscriptId, key, prompt);

    const responseFormat = z.toJSONSchema(escalationSchema, {
      target: 'draft-07',
      reused: 'inline',
    });

    let text: string;
    try {
      text = await this.chat(
        [{ role: 'user', content: prompt }],
        responseFormat,
        resolveOllamaTemperature(),
        call.onChunk,
        call.signal,
      );
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) throw err;
      /* Everything else (empty body, truncated stream, non-2xx) — this pass
         is best-effort, so surface "no usable answer" rather than hard-
         failing the whole chapter over one escalation window. */
      console.warn(
        `[ollama] ${this.model} ${key} produced no usable response: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }

    const attempt = parseAndValidate(text, escalationSchema);
    if (!attempt.ok) {
      console.warn(`[ollama] ${this.model} ${key} failed to parse: ${attempt.kind}`);
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
    grammarSchema: z.ZodType<unknown>,
    validationSchema: z.ZodType<T>,
    call: StageCall,
  ): Promise<T> {
    await writeInbox(manuscriptId, key, promptMd);

    const skill = await loadSkill(skillName);
    const systemInstruction = buildSystemInstruction(skill, call.language, skillName);
    /* Convert the GRAMMAR schema into a JSON Schema for Ollama 0.5+ structured-
       output (constrained decoding). grammarSchema may differ from
       validationSchema — e.g. stage1ChapterGrammarSchema makes tone REQUIRED so
       the model is nudged to emit it, while stage1ChapterSchema (the validation
       schema) keeps tone optional so a missing tone never fails a chapter.
       reused:'inline' inlines nested schemas (characterSchema inside
       stage1ChapterSchema, etc.) so Ollama doesn't have to resolve $ref — safer
       across engine versions. target:'draft-07' keeps the same dialect
       zod-to-json-schema emitted before the Zod 4 bump. The resulting schema
       preserves .strict() as additionalProperties:false and .min(1) as
       minItems:1, constraining the overall JSON shape. NOTE: llama.cpp's grammar
       conversion does NOT honour additionalProperties:false — the model can still
       stamp an extra key on an object (the real qwen3.5:9b per-chapter cast
       failure stamped a stray top-level `chapterId`). parseAndValidate tolerates
       that by stripping unrecognized-keys-only failures, so a stray key no
       longer discards a whole chapter. */
    const responseFormat = z.toJSONSchema(grammarSchema, { target: 'draft-07', reused: 'inline' });

    const start = Date.now();
    const tick = call.onWaiting
      ? setInterval(() => call.onWaiting!(Date.now() - start), 500)
      : null;

    try {
      const firstText = await this.chat(
        [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: promptMd },
        ],
        responseFormat,
        resolveOllamaTemperature(),
        call.onChunk,
        call.signal,
        call.onEvalTiming,
      );

      const firstAttempt = parseAndValidate(firstText, validationSchema);
      if (firstAttempt.ok) {
        if (firstAttempt.repaired) {
          console.warn(
            `[ollama] ${this.model} ${key} required JSON cleanup before parse (markdown fence and/or unescaped quotes)`,
          );
        }
        await persistResponse(manuscriptId, key, firstText);
        return firstAttempt.value;
      }

      /* First attempt failed. Preserve the raw text alongside the structured
         error so a developer can inspect the exact bytes (e.g. byte 1365 in
         a JSON parse failure) — schema-constrained decoding is supposed to
         make this impossible, so when it happens we want forensics. */
      await writeFile(rawAttemptPath(manuscriptId, key, 1), firstText, 'utf8');
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify(
          { kind: firstAttempt.kind, detail: firstAttempt.detail, attempt: 1 },
          null,
          2,
        ),
        'utf8',
      );

      /* Retry strategy depends on the failure mode:
         - `schema-validation`: replay-and-correct works well. The model sees
           its own structurally-near-miss output and a list of the offending
           fields, and patches them in place at low temperature.
         - `invalid-json`: replay-and-correct is counterproductive. Showing
           the model its own broken bytes at temperature 0.2 nudges it to
           regenerate near-identical bytes (we've observed both attempts
           failing at the *same* byte position). Drop the assistant turn and
           bump temperature so the sampler can escape the failure path. */
      const isInvalidJson = firstAttempt.kind === 'invalid-json';
      const retryMessages = isInvalidJson
        ? [
            { role: 'system' as const, content: systemInstruction },
            { role: 'user' as const, content: promptMd },
          ]
        : [
            { role: 'system' as const, content: systemInstruction },
            { role: 'user' as const, content: promptMd },
            { role: 'assistant' as const, content: firstText },
            { role: 'user' as const, content: buildRetryMessage(firstAttempt) },
          ];
      const retryTemperature = isInvalidJson ? resolveOllamaRetryTemperature() : resolveOllamaTemperature();

      const secondText = await this.chat(
        retryMessages,
        responseFormat,
        retryTemperature,
        call.onChunk,
        call.signal,
        call.onEvalTiming,
      );

      const secondAttempt = parseAndValidate(secondText, validationSchema);
      if (secondAttempt.ok) {
        if (secondAttempt.repaired) {
          console.warn(
            `[ollama] ${this.model} ${key} required JSON cleanup on retry (markdown fence and/or unescaped quotes)`,
          );
        }
        await persistResponse(manuscriptId, key, secondText);
        return secondAttempt.value;
      }

      await writeFile(rawAttemptPath(manuscriptId, key, 2), secondText, 'utf8');
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
        `Ollama ${this.model} ${key} failed validation after retry: ${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
      );
    } finally {
      if (tick) clearInterval(tick);
    }
  }

  /* TEMPORARY adapter: delegates to OllamaTransport.send and maps the
     TransportResult back to a plain string for the existing runStage
     callers. Will be removed when runStage is migrated to call
     OllamaTransport directly (next wave). */
  private async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    responseFormat: unknown,
    temperature: number,
    onChunk?: (info: StageChunkInfo) => void,
    signal?: AbortSignal,
    onEvalTiming?: (t: RawEvalTiming) => void,
  ): Promise<string> {
    const hasSystem = messages[0]?.role === 'system';
    const result = await this.transport.send({
      system: hasSystem ? messages[0].content : '',
      messages: (hasSystem ? messages.slice(1) : messages) as ChatMessage[],
      structuredOutput: { mode: 'schema', name: 'stage', schema: responseFormat as Record<string, unknown> },
      temperature,
      estimatedInputTokens: 0,
      signal,
      call: { onChunk, onEvalTiming },
    });
    return mapFinish(result, { kind: 'ollama', model: this.model });
  }
}

/** One-shot freeform Ollama call for persona generation. Unlike
    OllamaAnalyzer.chat() this sends NO response `format` (freeform text),
    does not stream, and is GPU-plan aware:
      - onCpu  → num_gpu:0 (system RAM only) AND skip the GPU semaphore
                 (a CPU call must not queue behind GPU synthesis).
      - !onCpu → acquire an analyzer GPU slot around the fetch.
      - keepAlive is caller-controlled (resident window for a bulk pre-pass; 0
        for one-shot / CPU). */
export async function generatePersonaViaOllama(
  prompt: string,
  model: string,
  opts: {
    onCpu?: boolean;
    keepAlive?: string | number;
    signal?: AbortSignal;
    /** Override the absolute ceiling — for testing only, so the bound can be
        proven to fire without waiting out PERSONA_ABSOLUTE_MAX_MS. */
    absoluteMaxMs?: number;
  } = {},
): Promise<string> {
  const onCpu = opts.onCpu === true;
  const url = getResolvedOllamaUrl();
  const body = {
    model,
    messages: [{ role: 'user' as const, content: prompt }],
    stream: false,
    think: false,
    /* Pin during an active analysis run (same rationale as keepAliveFor); the
       caller-supplied keepAlive is the post-run idle window otherwise. */
    keep_alive: isAnyAnalyzerRunBusy() ? -1 : (opts.keepAlive ?? 0),
    options: {
      temperature: resolveOllamaTemperature(),
      ...(onCpu ? { num_gpu: 0 } : {}),
    },
  };

  /* ANALYZER_DISPATCHER disables undici's header/body timeouts, so SOMETHING
     else must bound this call — and unlike chat() (whose StageCall carries the
     analysis signal) and warmOllamaModel (which builds its own controller from
     warmTimeoutMs), nothing upstream of here supplies one: voice-style.ts
     passes only { onCpu, keepAlive }. Without this, a daemon wedged in the
     connected-but-never-responding state (mid-/api/pull, hung GPU driver — the
     listener stays up so connectTimeout never fires) would hang FOREVER, and
     because the analyzer slot above is released only in the finally below,
     it would leak a token from a bounded semaphore and silently block every
     later analyzer call. The hidden 300s cap used to be the only stop; removing
     it without replacing it would have traded a wrong diagnosis for a deadlock.
     Ceiling matches design-voice-core.ts's DESIGN_ABSOLUTE_MAX_MS — the same
     "a big local model on CPU is slow but not infinite" judgement. */
  const releaseSlot = await acquireAnalyzerSlot(model, onCpu);
  /* Start the clock AFTER the semaphore, not before: AbortSignal.timeout
     cannot be paused, so building it above the acquire charges FIFO queue
     time to the request. With K=2 held by two slow chapter calls, a persona
     request could exhaust its whole budget waiting and then reject without
     sending a byte — reported as a bare "operation was aborted due to
     timeout" naming neither daemon nor model, about an Ollama that never saw
     it. undici's implicit clock started at socket dispatch too, so this also
     keeps the replacement bound faithful to what it replaced. */
  try {
    /* Built INSIDE the try: AbortSignal.timeout/any can throw (ERR_OUT_OF_RANGE
       on a bad ceiling, TypeError on a non-signal), and the slot is already
       held by this point — anything that throws between the acquire and the
       try would leak it, which is the exact harm the regression test guards. */
    const maxMs =
      opts.absoluteMaxMs && opts.absoluteMaxMs > 0 ? opts.absoluteMaxMs : PERSONA_ABSOLUTE_MAX_MS;
    const budget = AbortSignal.timeout(maxMs);
    const signal = opts.signal ? AbortSignal.any([budget, opts.signal]) : budget;
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      /* Same ANALYZER_DISPATCHER as chat(), and this call needs it MORE:
         `stream: false` above means Ollama withholds response headers until
         the ENTIRE generation is finished, so undici's 300s default would
         cover load + prefill + full decode rather than prefill alone. The
         CPU path (`num_gpu: 0`, set by voice-style.ts for persona
         generation) blows through that on any large local tag — and there is
         no Gemini fallback on this path, so the misclassified
         LocalUnreachableError below surfaces to the user as "Ollama is
         unreachable, start the daemon" about a daemon that is running fine
         and still generating. */
      response = await undiciFetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        dispatcher: ANALYZER_DISPATCHER,
      });
    } catch (err) {
      throw classifyConnectError(err, url);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama ${url} returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    const json = (await response.json().catch(() => ({}))) as { message?: { content?: string } };
    return json.message?.content ?? '';
  } finally {
    releaseSlot(); // non-nullable (unlike the old acquireGpuTokenIfOnGpu release)
  }
}
