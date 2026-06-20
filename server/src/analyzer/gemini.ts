/* Gemini analyzer — sends the same prompts the human would have run by hand
   through google.generativeai's free tier. Writes the prompt to inbox and the
   raw response to outbox for traceability (both gitignored), validates with
   the shared Zod schemas, and retries ONCE with the validation errors fed
   back as a follow-up turn before giving up. Drives the SSE progress bar
   via a setInterval ticking onWaiting while the API call is in flight. */

import { readFile, writeFile } from 'node:fs/promises';
import { configValue } from '../config/resolver.js';
import { readPrompt } from '../config/prompts.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { writeInbox, outboxPath, errorPath, type HandoffKey } from '../handoff/protocol.js';
import {
  stage1Schema,
  stage1ChapterSchema,
  stage2ChapterSchema,
  emotionAnnotationSchema,
  stage1GrammarSchema,
  stage1ChapterGrammarSchema,
  type Stage1Output,
  type Stage1ChapterOutput,
  type Stage2ChapterOutput,
  type EmotionAnnotationOutput,
} from '../handoff/schemas.js';
import type { Analyzer, StageCall, StageChunkInfo } from './index.js';
import { isNonEnglish, normaliseBookLanguage } from '../tts/language.js';
import { AnalysisAbortedError } from './ollama.js';
import { AnalyzerTruncatedError } from './errors.js';
import { geminiRateLimiter, DailyQuotaExhaustedError } from './rate-limit.js';

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, '..', '..', '..', 'skills');
const SKILL_FILES = {
  /* Legacy whole-book stage 1 — kept for any caller still wiring it.
     Not in the prompt registry so it reads directly from disk. */
  whole_book_stage1: 'audiobook-character-analysis.md',
  /* Phase 0a — per-chapter cast detection (the current default).
     Routes through the prompt-fork loader (prompt.castDetection). */
  per_chapter_stage1: 'audiobook-character-detection-per-chapter.md',
  /* Phase 1 — per-chapter sentence attribution.
     Routes through the prompt-fork loader (prompt.sentenceAttribution). */
  per_chapter_stage2: 'audiobook-sentence-attribution.md',
  /* fs-33 — emotion-only backfill pass (does NOT re-attribute).
     Routes through the prompt-fork loader (prompt.emotionAnnotation). */
  emotion_annotation: 'audiobook-emotion-annotation.md',
} as const;
export type SkillName = keyof typeof SKILL_FILES;

/* Mapping from skill name to prompt-registry id, for the three skills that
   support user-forkable prompts. The legacy whole_book_stage1 isn't in the
   registry and still reads directly from disk. */
const SKILL_TO_PROMPT_ID: Partial<Record<SkillName, string>> = {
  per_chapter_stage1: 'prompt.castDetection',
  per_chapter_stage2: 'prompt.sentenceAttribution',
  emotion_annotation: 'prompt.emotionAnnotation',
};

/* Read the skill file fresh on every request so prompt iteration doesn't
   require a server restart. The files are small (~3-5 KB) and read once
   per analysis — negligible cost.

   For the three registry-backed skills, resolves through readPrompt() so a
   user-forked copy in ~/.castwright/prompts/<id>.md takes effect on the next
   analysis run without a restart (apply:'live'). The legacy whole_book_stage1
   still reads from disk directly. */
export async function loadSkill(skill: SkillName): Promise<string> {
  const promptId = SKILL_TO_PROMPT_ID[skill];
  if (promptId) {
    return (await readPrompt(promptId)).text;
  }
  return readFile(resolve(SKILLS_DIR, SKILL_FILES[skill]), 'utf8');
}

/* The skill text is moved to `systemInstruction` rather than re-sent as
   part of `contents` on every call (see callsite). This shaves ~10 KB off
   each per-chapter stage-2 request and makes the user-turn token count
   actually proportional to the task. */
export function buildSystemInstruction(skill: string, language?: string): string {
  return `You are an automated worker, not a human. Follow the schema, rules, and JSON example in the SKILL section EXACTLY. Use the camelCase field names shown there (e.g. \`name\`, not \`character_name\`; \`chapterId\`, not \`chapter_id\`). Do NOT invent extra fields. Do NOT wrap the response in markdown fences. Your only output is a JSON object that conforms to the schema.${languagePreamble(language)}

---

# SKILL

${skill}

---

Return ONLY a single JSON object that matches the schema in the SKILL section. No prose. No code fences.`;
}

/* fs-2 — language preamble for non-English manuscripts. Appended to the system
   instruction so character/dialogue attribution respects the script's
   conventions. Empty for English (and absent language) so English analysis is
   byte-identical to pre-fs-2. Only Russian is wired in v1; other non-English
   languages get a generic preamble. The JSON field names + values stay English
   regardless — only the manuscript text is in another language. */
export function languagePreamble(language?: string): string {
  if (!language || !isNonEnglish(language)) return '';
  const ru = normaliseBookLanguage(language) === 'ru';
  const where = ru ? 'Russian (Cyrillic script)' : `${language} (a non-English language)`;
  const conventions = ru
    ? ' Dialogue is often marked with guillemets «…» or an em-dash —, not English "quotes". Characters may be named by first name, patronymic, surname, or diminutive (e.g. "Соня" for "Софья") — treat these as the same person. IMPORTANT: a dashed line that is a narrative TAG describing who spoke or what they did — e.g. «— сказал юноша.», «— тихо произнесла девушка.», «— Девушка улыбнулась.» (verbs like сказал/произнёс(ла)/воскликнул(а)/спросил(а)/засмеялся/улыбнулась/нахмурился) — is the narrator, NOT the speaker. Only the actually-spoken words belong to the speaker.'
    : '';
  /* Cast-field guards for any non-English manuscript (validated on Russian +
     gemma4-e4b, 2026-06-19: without these the local model emits gender/age
     100% but `tone` 0% and writes role/description in mixed English/target
     language). Phrased "when you output a character" so it is a no-op for the
     stage-2 attribution pass (which lists sentences, not characters). Field
     NAMES + enum values stay English as the line above already mandates. */
  const castFields = ` When you output a character, ALWAYS include the \`tone\` object (integers 0–100 for warmth, pace, authority, emotion) estimated from how they speak — never omit it. Write the human-readable text — \`role\`, \`description\`, and each \`attributes\` tag, for every character INCLUDING the narrator — in ${where} (the manuscript's language), and always include a \`description\`.`;
  return `\n\nIMPORTANT: the manuscript text is in ${where}. Quote evidence VERBATIM from the manuscript (do not translate or transliterate it). Keep all JSON field names and enum values in English exactly as the schema shows.${castFields}${conventions}`;
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
    const key = `2-ch${chapterId}` as const;
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
    const systemInstruction = buildSystemInstruction(skill, call.language);

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
             short-circuit instead of round-tripping. */
          if (/free[_-]?tier|quotaValue":"\d{1,3}"/i.test(message)) {
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
        /* The stream finished with zero text. The usual cause on a `gemini-*`
           model is a content-filter block: the model emits a candidate carrying
           the stop reason (RECITATION on memorised/copyrighted source text, or
           SAFETY) but no text — or rejects the prompt outright with a
           promptFeedback.blockReason. Splitting the chapter won't help (the
           sub-bodies are still blocked), so we fail fast with a *plain* Error
           (no retry, no chunk-split) and NAME the reason so the operator can
           act. Reordered ahead of nothing — historically this branch threw a
           bare "empty response" and discarded the reason captured below. */
        const stopReason = finishReason ?? blockReason;
        const named =
          stopReason && stopReason !== 'FINISH_REASON_UNSPECIFIED' ? ` (reason=${stopReason})` : '';
        const hint =
          stopReason && stopReason !== 'FINISH_REASON_UNSPECIFIED'
            ? ' A content filter blocked the text — gemini-* models block copyrighted' +
              ' source via RECITATION. Switch GEMINI_MODEL to a gemma-* model or set' +
              ' ANALYZER=local (Ollama).'
            : '';
        throw new Error(`Gemini ${this.model} returned an empty response${named}.${hint}`);
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
   to be close, not exact. */
const LATIN_CHARS_PER_TOKEN = 4;
const CYRILLIC_CHARS_PER_TOKEN = 2.5;

export function estimateInputTokens(
  systemInstruction: string,
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
): number {
  let chars = systemInstruction.length;
  let cyrillic = 0;
  const countCyrillic = (s: string): number => {
    const m = s.match(/[Ѐ-ӿ]/g);
    return m ? m.length : 0;
  };
  cyrillic += countCyrillic(systemInstruction);
  for (const turn of contents) {
    for (const part of turn.parts) {
      chars += part.text.length;
      cyrillic += countCyrillic(part.text);
    }
  }
  const cyrillicFraction = chars > 0 ? cyrillic / chars : 0;
  const divisor =
    LATIN_CHARS_PER_TOKEN -
    cyrillicFraction * (LATIN_CHARS_PER_TOKEN - CYRILLIC_CHARS_PER_TOKEN);
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

export type ParseResult<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; kind: 'invalid-json'; detail: string }
  | { ok: false; kind: 'schema-validation'; detail: z.ZodIssue[] };

export function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  /* Repair pipeline. Each pass is a no-op on already-valid JSON, so we
     can try several layered combinations and accept the first that
     parses. Conservative passes (fence-strip, trailing-prose trim,
     structural-punctuation repair) run BEFORE the aggressive
     `repairUnescapedQuotes` walker — that walker is willing to insert
     `\"` mid-string when it sees a `"` not followed by a value-end
     token, which can wrongly corrupt a payload whose breakage is
     actually a missing comma between two string-valued properties
     (e.g. `{"a":"x" "b":"y"}` — the walker sees the close-quote of `x`
     as an unescaped inner quote because the next non-ws char is `"`,
     not `,`/`}`).

     Order of candidates tried:
     0. `stripped` — fence strip only.
     1. `trimTrailingProse(stripped)` — Ch44 shape.
     2. `repairStructuralPunctuation(...prev)` — Ch49 shape; missing
        comma or close brace.
     3. `repairUnescapedQuotes(stripped)` — ch8/ch10 dialogue-quote
        shape; aggressive walker.
     4. `trimTrailingProse(prev)` then `repairStructuralPunctuation(prev)`
        on top of the quote-fixed seed — combination cases.

     After all candidates fail, return `invalid-json` with the LATEST
     error message so the operator can see what the surviving issue
     actually is.

     `stripCodeFences` ALWAYS runs first because backticks confuse every
     downstream walker; it's deterministic and detects its own opt-out
     (no leading fence → byte-identical return). */
  const stripped = stripCodeFences(raw);

  /* Build the candidate list and dedupe so each parse is attempted at
     most once. */
  const trimmed = trimTrailingProse(stripped);
  const trimThenStruct = repairStructuralPunctuation(trimmed);
  const quoteFixed = repairUnescapedQuotes(stripped);
  const quoteThenTrim = trimTrailingProse(quoteFixed);
  const quoteThenTrimThenStruct = repairStructuralPunctuation(quoteThenTrim);

  const candidates: string[] = [
    stripped,
    trimmed,
    trimThenStruct,
    quoteFixed,
    quoteThenTrim,
    quoteThenTrimThenStruct,
  ];
  const seen = new Set<string>();
  let parsed: unknown;
  let winner: string | null = null;
  let lastErrorMessage = 'unknown parse error';
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    try {
      parsed = JSON.parse(c);
      winner = c;
      break;
    } catch (e) {
      lastErrorMessage = (e as Error).message;
    }
  }
  if (winner === null) {
    return { ok: false, kind: 'invalid-json', detail: lastErrorMessage };
  }
  const repaired = winner !== raw;

  const result = schema.safeParse(parsed);
  if (!result.success) {
    /* Constrained-decoding stray-key tolerance. Ollama's `format:<schema>`
       (and Gemini's responseSchema) enforce JSON *shape* but NOT
       additionalProperties:false, so a local model routinely stamps an extra
       key the strict schema doesn't want onto an otherwise-valid object — the
       real qwen3.5:9b per-chapter cast failure stamped a top-level `chapterId`
       and the whole chapter's roster was discarded. When EVERY issue is an
       unrecognized key, strip the offending keys at their reported paths and
       re-validate once. Genuine shape problems (missing required fields, wrong
       types) surface different issue codes and still hard-fail here. */
    const issues = result.error.issues;
    if (issues.length > 0 && issues.every((i) => i.code === 'unrecognized_keys')) {
      const cleaned = stripUnrecognizedKeys(parsed, issues);
      const reparse = schema.safeParse(cleaned);
      if (reparse.success) {
        return { ok: true, value: reparse.data, repaired: true };
      }
    }
    return { ok: false, kind: 'schema-validation', detail: issues };
  }
  return { ok: true, value: result.data, repaired };
}

/* Remove the keys Zod flagged as `unrecognized_keys` from a deep clone of the
   parsed object. Each `unrecognized_keys` issue carries the `path` to the
   object that owns the extra keys and the `keys` list itself; walk to that
   object and delete them. The clone keeps the caller's parsed value intact.
   Used only by parseAndValidate to salvage a payload whose sole fault is stray
   keys that constrained decoding failed to suppress. */
function stripUnrecognizedKeys(root: unknown, issues: z.ZodIssue[]): unknown {
  const clone = structuredClone(root);
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    let target: unknown = clone;
    for (const seg of issue.path) {
      if (target == null || typeof target !== 'object') break;
      target = (target as Record<PropertyKey, unknown>)[seg];
    }
    if (target != null && typeof target === 'object') {
      for (const key of issue.keys) {
        delete (target as Record<string, unknown>)[key];
      }
    }
  }
  return clone;
}

/* Strips a wrapping ```json ... ``` (or bare ``` ... ```) markdown fence
   if present. Returns the input unchanged if no leading fence is found,
   so this is byte-identical on the happy path. The match is anchored at
   the start/end of the trimmed text, which means backticks embedded inside
   string values can't false-positive. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return raw;
  /* Drop opening fence + optional language tag + optional newline.
     Handles ```json\n, ```JSON\n, ```\n, ``` (inline, no newline). */
  let body = trimmed.replace(/^```[a-zA-Z]*[ \t]*\n?/, '');
  /* Drop closing fence at the very end. */
  body = body.replace(/\n?[ \t]*```\s*$/, '');
  return body.trim();
}

/* Walks the text character by character. Tracks whether we're currently
   inside a JSON string value. When we hit a `"` inside a string, peek the
   next non-whitespace char: if it's `,` `}` `]` `:` or EOF the `"` is a
   real string close; otherwise treat it as an unescaped inner quote and
   replace with `\"`. Existing `\"` and other `\X` escape sequences are
   passed through verbatim.

   This is intentionally narrow: it handles the dialogue-quote pattern that
   accounts for ~all of our observed failures, and is a no-op on already-
   valid JSON (every real close quote is followed by `,`/`}`/`]`/`:`/EOF).
   It is NOT a general JSON repair — for unrelated structural breakage
   (missing braces, trailing commas, etc.) the caller's `invalid-json`
   retry path still fires. */
export function repairUnescapedQuotes(raw: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      i += 1;
      continue;
    }
    if (c === '\\') {
      /* Pass through the escape and its target byte unchanged. Covers `\"`,
         `\\`, `\n`, `\uXXXX` (the first two chars suffice — the four hex
         digits are normal string content from this walker's POV). */
      out += c;
      if (i + 1 < raw.length) {
        out += raw[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      /* Peek the next non-whitespace char to decide if this `"` is a real
         string close or an unescaped inner quote. */
      let j = i + 1;
      while (
        j < raw.length &&
        (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')
      ) {
        j += 1;
      }
      const next = j < raw.length ? raw[j] : '';
      if (next === ',' || next === '}' || next === ']' || next === ':' || next === '') {
        out += c;
        inString = false;
      } else {
        out += '\\"';
      }
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* Walks the text tracking brace/bracket depth, respecting JSON string
   state (and escapes). When the OUTERMOST balanced close character is
   found, slice up to and including it and return — any trailing prose
   the model emitted after the object closed is dropped.

   Real failure shape this handles: qwen3.5:4b occasionally completes a
   structurally valid JSON object on long chapters and then continues
   writing free-form prose after the closing `}` (e.g. "Note that this
   chapter…"). JSON.parse rejects the whole payload because of the
   trailing content. We can rescue that without round-tripping the model
   by trimming everything after the outer close.

   Returns the input unchanged when:
   - There is no opening `{` or `[`.
   - The outer container never closes (unbalanced depth at EOF) — in that
     case `repairStructuralPunctuation` is the right next pass, not this
     one.
   - The string is empty. */
export function trimTrailingProse(raw: string): string {
  if (!raw) return raw;
  let depth = 0;
  let inString = false;
  let started = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (inString) {
      if (c === '\\') {
        i += 1;
        continue;
      } /* skip escape target */
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') {
      depth += 1;
      started = true;
      continue;
    }
    if (c === '}' || c === ']') {
      depth -= 1;
      if (started && depth === 0) {
        /* Outermost close. Slice up to and including this position. */
        const trimmed = raw.slice(0, i + 1);
        return trimmed;
      }
    }
  }
  /* Never closed cleanly — leave it for repairStructuralPunctuation. */
  return raw;
}

/* Inserts at most `maxInserts` structural tokens (`,` between adjacent
   values, or trailing `}` / `]` to close unbalanced containers) so a
   payload broken only by a missing comma or missing close brace round-
   trips through JSON.parse.

   Heuristic, in order:
   1. **Missing comma** — walk the text; when a value-end position (close
      of string, number, `}`, `]`, or a `true`/`false`/`null` literal) is
      followed by whitespace and then a property-start token (`"`, `{`,
      `[`), insert a `,` at that boundary. We track JSON string state
      with escapes so spaces inside strings don't trigger.
   2. **Missing close braces/brackets at EOF** — after a single pass, if
      depth > 0 append the closers in LIFO order (stack of opens).

   Out of scope: unquoted identifiers, missing colons, extraneous commas,
   structural errors that JSON.parse can't pinpoint with a position. For
   anything outside the comma+close-brace window, this helper returns
   whatever it managed to produce (which still won't parse) so the
   caller's invalid-json branch fires.

   `maxInserts` bounds the budget so a hopelessly-broken payload can't
   loop the parser. Default 2 covers the documented realistic case (one
   missing comma + one missing close brace at EOF). A deeply-truncated
   payload — e.g. 3+ unclosed containers because the model was cut off
   mid-string — stays unparseable, which is correct: those should fail
   `invalid-json` so the retry policy drops the broken assistant turn
   and bumps temperature, instead of replaying a half-rescued skeleton
   that anchors the model to a wrong shape (see ollama.test.ts:352). */
export function repairStructuralPunctuation(raw: string, maxInserts = 2): string {
  if (!raw) return raw;
  let out = '';
  const openStack: Array<'}' | ']'> = [];
  let inString = false;
  let inserts = 0;
  let lastNonWsWasValueEnd = false;

  const isPropertyStart = (ch: string): boolean => ch === '"' || ch === '{' || ch === '[';

  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];

    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < raw.length) {
        out += raw[i + 1];
        i += 1;
        continue;
      }
      if (c === '"') {
        inString = false;
        lastNonWsWasValueEnd = true;
      }
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      out += c;
      continue;
    }

    /* Decide whether we need to splice a comma BEFORE writing `c`. */
    if (lastNonWsWasValueEnd && isPropertyStart(c) && inserts < maxInserts) {
      out += ',';
      inserts += 1;
      lastNonWsWasValueEnd = false;
    }

    if (c === '"') {
      out += c;
      inString = true;
      continue;
    }
    if (c === '{') {
      out += c;
      openStack.push('}');
      lastNonWsWasValueEnd = false;
      continue;
    }
    if (c === '[') {
      out += c;
      openStack.push(']');
      lastNonWsWasValueEnd = false;
      continue;
    }
    if (c === '}' || c === ']') {
      out += c;
      openStack.pop();
      lastNonWsWasValueEnd = true;
      continue;
    }
    if (c === ',' || c === ':') {
      out += c;
      lastNonWsWasValueEnd = false;
      continue;
    }
    /* Number / literal / unknown — append. Treat digits and
       alphanumeric runs as value-content; a value ends at the next
       structural break. */
    out += c;
    lastNonWsWasValueEnd = /[\d\w]/.test(c) || c === '.' || c === '-' || c === '+';
  }

  /* Append any unclosed containers in LIFO order, bounded by maxInserts. */
  while (openStack.length > 0 && inserts < maxInserts) {
    out += openStack.pop()!;
    inserts += 1;
  }

  return out;
}

export function buildRetryMessage(failure: Extract<ParseResult<unknown>, { ok: false }>): string {
  if (failure.kind === 'invalid-json') {
    return `Your previous response was not valid JSON: ${failure.detail}\n\nReturn ONLY a valid JSON object matching the schema. No prose, no markdown code fences.`;
  }
  return `Your previous response failed schema validation. Fix the following issues and resend the corrected JSON. Return ONLY the JSON object — no prose, no code fences.\n\n${JSON.stringify(failure.detail, null, 2)}`;
}

export function summariseDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  try {
    const s = JSON.stringify(detail);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return String(detail);
  }
}

export async function persistResponse(
  manuscriptId: string,
  key: HandoffKey,
  raw: string,
): Promise<void> {
  await writeFile(outboxPath(manuscriptId, key), raw, 'utf8');
}
