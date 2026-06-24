/* Local Ollama analyzer. Mirrors GeminiAnalyzer's streaming + validation-retry
   shape (see gemini.ts) but talks to a local Ollama daemon over plain HTTP
   instead of the Google SDK.

   The key novelty is the error classification: only "couldn't connect" /
   "connection reset before first byte" failures translate into
   LocalUnreachableError, which is the *only* condition that triggers the
   FallbackAnalyzer in index.ts to retry against Gemini. Everything else —
   HTTP non-2xx, validation failures, mid-stream aborts — surfaces as a plain
   Error and hard-fails. The point: a misbehaving local model should not
   silently burn Gemini quota; if Ollama is up at all, we trust the error. */

import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { sampleAndRecordVram } from './model-vram-stats.js';
import { gpuSemaphore } from '../gpu/semaphore.js';
import { costForEngine } from '../tts/engine-vram-cost.js';
import { getResolvedOllamaUrl } from '../workspace/user-settings.js';
import { configValue } from '../config/resolver.js';
import type { Accelerator } from '../gpu/vram-state.js';
import { getLastKnownVram } from '../gpu/vram-state.js';
import { writeInbox, errorPath, rawAttemptPath, type HandoffKey } from '../handoff/protocol.js';
import {
  stage1Schema,
  stage1ChapterSchema,
  stage2ChapterSchema,
  emotionAnnotationSchema,
  scriptReviewSchema,
  stage1GrammarSchema,
  stage1ChapterGrammarSchema,
  type Stage1Output,
  type Stage1ChapterOutput,
  type Stage2ChapterOutput,
  type EmotionAnnotationOutput,
  type ScriptReviewOutput,
} from '../handoff/schemas.js';
import type { Analyzer, StageCall, StageChunkInfo } from './index.js';
import { AnalyzerTruncatedError } from './errors.js';
import {
  buildSystemInstruction,
  parseAndValidate,
  buildRetryMessage,
  summariseDetail,
  persistResponse,
  loadSkill,
  type SkillName,
} from './gemini.js';

/** Sentinel error class. The FallbackAnalyzer decorator in index.ts uses
    `err instanceof LocalUnreachableError` as the SOLE trigger for Gemini
    fallback. Any other error type propagates unchanged and hard-fails. */
export class LocalUnreachableError extends Error {
  readonly code = 'LOCAL_UNREACHABLE';
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LocalUnreachableError';
  }
}

/** Sentinel error for "the SSE client disconnected, drop work silently."
    The analysis route uses `err instanceof AnalysisAbortedError` to skip
    its own error-reporting path (the client is gone — there's no one to
    tell) and to NOT trigger the Gemini fallback decorator. */
export class AnalysisAbortedError extends Error {
  readonly code = 'ANALYSIS_ABORTED';
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisAbortedError';
  }
}

interface OllamaOptions {
  /** Base URL of the Ollama daemon (e.g. http://localhost:11434).
      Trailing slash already stripped by getResolvedOllamaUrl. */
  url: string;
  /** Model tag passed to /api/chat (e.g. `qwen3.5:9b`). */
  model: string;
}

/* Network-failure error codes that Node's undici fetch surfaces via
   `err.cause.code`. These are the "couldn't connect" cases that warrant
   fallback to Gemini. Anything else (HTTP 5xx, malformed body, validation
   failure) means the daemon is reachable but misbehaving — hard-fail. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'UND_ERR_SOCKET',
]);

/* Default sampling temperature for /api/chat. Low enough that the model
   sticks close to the schema and the system prompt's structural rules, but
   not zero — pure-greedy decoding makes the validation-retry loop a no-op
   because attempt 2 is just attempt 1 again.
   Read through the registry so the operator can tune without a rebuild;
   kept as an exported const for any importer that references the symbol
   directly (the value is evaluated at module load — use configValue for
   a live read). */
export const DEFAULT_TEMPERATURE = 0.2;
/* Retry temperature — kept for compat; use resolveOllamaTemperature() /
   resolveOllamaRetryTemperature() for live values. */
export const INVALID_JSON_RETRY_TEMPERATURE = 0.6;

/** Live-read first-attempt temperature (registry wins over the const). */
export function resolveOllamaTemperature(): number {
  return configValue<number>('analyzer.ollama.temperature');
}
/** Live-read invalid-JSON retry temperature (registry wins over the const). */
export function resolveOllamaRetryTemperature(): number {
  return configValue<number>('analyzer.ollama.retryTemperature');
}

/* Models we want Ollama to hold in VRAM between back-to-back analysis
   calls. Stage 1 → Stage 2 → next chapter happens on a tight loop, and
   reloading a multi-GB weight set between each one would dominate
   wall-clock time — the 9B otherwise unloads+reloads ~6.35 GB on every
   chapter section, which surfaces as a VRAM sawtooth and mid-stream
   "no response" stalls. The 4B (~3 GB), Llama-8B (~5 GB), and 9B
   (~6.6 GB) all fit resident on an 8 GB box alongside the KV cache at
   ANALYZER_NUM_CTX: the chunker caps each section to ~24k chars so the
   KV cache never reaches the 32k worst case (confirmed live — the 9B
   ran ~6.25 GB / 8 GB resident).

   The cross-engine handoff is the load-bearing assumption: a resident 9B
   CANNOT co-reside with Qwen TTS / XTTS, so we rely on the generation
   engine's auto-evict to drop a resident Ollama model before it loads.
   With that protection in place, keeping the 9B warm across the analysis
   loop is safe and removes the reload tax.

   NOTE: this does NOT hold for a LOCAL-MODEL SPLIT (a run that uses two
   different local models across phase0/phase1). Two large local models
   resident at once would exceed the 8 GB budget — that path must keep
   its non-resident eviction; do not naively add both to this set.
   Tune the allowlist in lockstep with src/lib/models.ts MODEL_OPTIONS.
   `gemma4-e4b-8gb` is the local alias for the Gemma 4 E4B edge model (~5 GB
   resident, fits 8 GB alongside the KV cache); both the bare name and the
   `:latest` form Ollama reports in /api/tags are listed so the exact-match
   lookup hits however the picker/env passes it. NOTE: this is a per-box local
   name — model-agnostic measured residency is the deferred #845 work. */
const RESIDENT_MODELS = new Set([
  'qwen3.5:4b',
  'qwen3.5:9b',
  'llama3.1:8b',
  'gemma4-e4b-8gb',
  'gemma4-e4b-8gb:latest',
]);

/* Models that are only safe to keep resident where the constraint is VRAM
   (GPU box). On a CPU-only machine the same model would pin ~6.4 GB of
   system RAM for 5 min with no eviction guard, so we unload immediately
   when the accelerator is 'cpu'. Small models (4B/8B) fit comfortably in
   either context and are NOT in this set. */
const RAM_HEAVY_MODELS = new Set(['qwen3.5:9b']);

/** Live-read the resident-model keep-alive window (registry wins; default '5m'). */
export function resolveAnalyzerKeepAlive(): string {
  return configValue<string>('analyzer.ollama.keepAlive');
}

/** Picks the `keep_alive` value for an Ollama /api/chat call:
    - models in RESIDENT_MODELS → ANALYZER_KEEP_ALIVE knob (default '5m', stay
                                  loaded for the analysis loop)
    - RAM_HEAVY_MODELS on CPU   → 0   (would pin ~6.4 GB in system RAM)
    - everything else            → 0   (unload immediately after the call,
                                        matching `keep_alive: 0` in Ollama's
                                        own unload pattern — see
                                        https://github.com/ollama/ollama/blob/main/docs/api.md#keep-alive).
    The `accelerator` parameter defaults to 'unknown', which is treated as
    GPU (the common case + the perf win), so existing 1-arg callers are
    unaffected. Cross-engine eviction before a TTS load is handled separately
    by withGpuLoad (gpu.safeCoexistMb), not here. */
export function keepAliveFor(model: string, accelerator: Accelerator = 'unknown'): string | number {
  if (!RESIDENT_MODELS.has(model)) return 0;
  if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;
  return resolveAnalyzerKeepAlive();
}

/* num_ctx the analyzer hands Ollama on every /api/chat call (see the
   structured-output runStage path below). Exported so the in-app Load
   button's warming probe can pass the same value — Ollama treats
   (model, num_ctx) as the cache key, so warming with default 2048 and
   then running with 16384 triggers a full model reload mid-request,
   which surfaces to the UI as "stream ended without a result event"
   while Ollama re-paged the model.
   Kept as static export for compat; call-sites inside this module use
   resolveAnalyzerNumCtx() / resolveAnalyzerNumGpu() for live values. */
export const ANALYZER_NUM_CTX = 32768;

/* Force Ollama to load every layer of the model onto the GPU. 999 is
   the standard idiom for "all layers" — it exceeds any model's actual
   layer count, so Ollama clamps to the real value (32 for llama3.1:8b,
   40 for qwen3.5:9b, etc.). Hard-coding to 999 means this knob is
   correct for every supported tag without a per-model lookup.
   Without this hint, Ollama makes its own auto-split decision based on
   a VRAM-headroom heuristic that turns out to be twitchy under
   pressure: at llama3.1:8b + num_ctx 16384, ollama ps reported
   "8.0 GB, 8%/92% CPU/GPU" — ~640 MB silently offloaded to system RAM,
   which dragged stage-2 wall-clock measurably. Combined with the
   daemon's OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0 env
   pair (see docs/local-llm.md "Pinning the analyzer to 100% GPU"),
   this pins the analyzer to GPU-only and produces a clean OOM if the
   budget is ever exceeded, instead of a silent slowdown the user can't
   diagnose from the UI. Exported for the in-app Load button to thread
   the same value (Ollama treats num_gpu as part of the load-time cache
   key the same way num_ctx is — mismatching values between /load and
   the first /api/chat call triggers a silent reload mid-stream). */
export const ANALYZER_NUM_GPU = 999;

/** Live-read num_ctx (registry wins over the const). */
export function resolveAnalyzerNumCtx(): number {
  return configValue<number>('analyzer.ollama.numCtx');
}
/** Live-read num_gpu (registry wins over the const). */
export function resolveAnalyzerNumGpu(): number {
  return configValue<number>('analyzer.ollama.numGpu');
}

/* Optional explicit output-token cap (`num_predict`). Unset → -1 (Ollama's
   "predict until the context window fills"), which on a huge stage-2 chapter
   silently truncates the JSON once input + output brush num_ctx. The
   `done_reason: 'length'` check in chat() turns any such truncation into a
   loud AnalyzerTruncatedError (#528); this knob lets an operator cap output
   sooner. Shares the env name with Gemini's maxOutputTokens knob's sibling. */
export function resolveNumPredict(): number {
  // 0 is pathological (a zero-token cap truncates all output); preserve the
  // historical behaviour where 0 is treated as "no explicit cap" (-1).
  const n = configValue<number>('analyzer.ollama.numPredict');
  return n === 0 ? -1 : n;
}

export class OllamaAnalyzer implements Analyzer {
  private readonly url: string;
  private readonly model: string;

  constructor(opts: OllamaOptions) {
    this.url = opts.url;
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

  async runScriptReviewChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<ScriptReviewOutput> {
    const key = `review-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 'script_review', promptMd, scriptReviewSchema, scriptReviewSchema, call);
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
    const systemInstruction = buildSystemInstruction(skill, call.language);
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

  /* Streamed chat against /api/chat. Mirrors GeminiAnalyzer.generate so the
     route-layer 45s silence watchdog (analysis.ts) keeps working unchanged —
     each NDJSON line fires onChunk with the assembled buffer.
     When the caller passes an AbortSignal, it's wired into both the initial
     fetch and the stream-read loop. If the signal fires we throw an
     AnalysisAbortedError so the route can distinguish "client went away,
     drop work silently" from a real model failure. */
  private async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    responseFormat: unknown,
    temperature: number,
    onChunk?: (info: StageChunkInfo) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const body = {
      model: this.model,
      messages,
      stream: true,
      /* Strict structured output via Ollama 0.5+ constrained decoding. The
         schema is derived from the per-stage Zod schema (see runStage); the
         sampler can only emit tokens that keep the output a valid prefix of
         a value matching this schema. This eliminates the "malformed JSON
         at byte N" failure mode on smaller models (qwen3.5:4b in
         particular) — the model literally cannot produce invalid JSON or
         extra fields. The existing validation-retry loop below still guards
         against semantic violations the schema can't express. */
      format: responseFormat,
      /* Per-model keep_alive — see keepAliveFor + RESIDENT_MODELS above.
         The 4B and Llama-8B stay resident across the analysis loop; the
         9B unloads immediately so its 6.6 GB doesn't squat on VRAM that
         XTTS needs after analysis. */
      keep_alive: keepAliveFor(this.model, getLastKnownVram().accelerator),
      /* Suppress qwen3.5's thinking tokens — they'd appear as
         `<think>…</think>` ahead of the JSON and break the parser. Ollama
         silently ignores this flag on non-thinking models. */
      think: false,
      options: {
        /* Caller-controlled temperature — DEFAULT_TEMPERATURE for the first
           attempt and schema-validation retries, INVALID_JSON_RETRY_TEMPERATURE
           for invalid-json retries. See runStage for the kind-aware branch. */
        temperature,
        /* 16K covers long chapters (~12–15K chars ≈ 3–4K tokens) plus the
           inlined response schema + skill system prompt without spilling.
           At 8K we observed silent hangs on 12K+ char chapters where the
           combined prompt brushed the context limit and Ollama's
           structured-output path stalled with no first byte. The 4B
           weights (~3 GB) leave enough headroom on an 8 GB box for the
           larger KV cache. */
        num_ctx: resolveAnalyzerNumCtx(),
        /* Pin every layer to GPU — see ANALYZER_NUM_GPU above for the
           full rationale (was: Ollama silently offloading ~8% of
           llama3.1:8b layers to CPU under 16K-context pressure). */
        num_gpu: resolveAnalyzerNumGpu(),
        /* Output-token cap — see resolveNumPredict above. -1 by default
           (predict until context fills); truncation is caught loudly via
           done_reason below regardless. */
        num_predict: resolveNumPredict(),
      },
    };

    /* Short-circuit if the caller has already aborted (e.g. the SSE client
       disconnected while a previous chapter was still running). Saves a
       wasted Ollama round-trip and lets the route loop bail immediately. */
    if (signal?.aborted) {
      throw new AnalysisAbortedError(
        `Ollama ${this.model} call aborted before fetch (client disconnected).`,
      );
    }

    /* GPU arbitration — acquire a slot before the fetch so two parallel
       Claude Code sessions don't fight over VRAM on an 8 GB GPU. The
       slot is held across the full streamed response (fetch + read
       loop) and released in the outer `finally` below; that covers
       abort paths, fetch-throws, non-2xx responses, and mid-stream
       errors equally well. The analyzer's VRAM weight (engine-vram-cost.ts)
       is large enough to serialise it against any TTS op — they already
       evict each other on the GPU. See server/src/gpu/semaphore.ts. */
    const releaseGpu = await gpuSemaphore.acquire(costForEngine('analyzer'));

    try {
      let response: Response;
      try {
        response = await fetch(`${this.url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) {
          throw new AnalysisAbortedError(
            `Ollama ${this.model} fetch aborted (client disconnected).`,
          );
        }
        throw classifyConnectError(err, this.url);
      }

      if (!response.ok) {
        /* Reachable but errored — hard-fail. Surface the body verbatim so
           operator can diagnose ("model not found", "invalid format", …). */
        const text = await response.text().catch(() => '');
        throw new Error(
          `Ollama ${this.url} returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
        );
      }

      if (!response.body) {
        throw new Error(`Ollama ${this.url} returned an empty body (no readable stream).`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = ''; // assembled assistant content
      let lineBuf = ''; // partial NDJSON line carried across reads
      let firstByteSeen = false;
      /* Ollama reports WHY it stopped on the final `done:true` line:
         'stop' (clean), 'length' (hit num_ctx/num_predict — truncated),
         'load'. Captured here, asserted after the stream drains (#528). */
      let doneReason: string | undefined;
      const start = Date.now();
      let lastChunkAt = start;

      try {
        for (;;) {
          if (signal?.aborted) {
            /* Caller (the route's req.on('close') handler) aborted while we
               were mid-stream. Tear down cleanly rather than burning more
               tokens on output the client will never see. */
            throw new AnalysisAbortedError(
              `Ollama ${this.model} stream aborted (client disconnected).`,
            );
          }
          let result: { done: boolean; value?: Uint8Array };
          try {
            result = await reader.read();
          } catch (err) {
            if (signal?.aborted) {
              throw new AnalysisAbortedError(
                `Ollama ${this.model} stream aborted (client disconnected).`,
              );
            }
            /* A connection drop mid-stream — daemon was up, then went away.
               If we've already seen bytes, this is a partial-stream failure
               (hard-fail). If we haven't, treat as unreachable. */
            if (!firstByteSeen) throw classifyConnectError(err, this.url);
            throw new Error(`Ollama ${this.url} stream interrupted: ${(err as Error).message}`);
          }
          if (result.done) break;
          firstByteSeen = true;
          lineBuf += decoder.decode(result.value ?? new Uint8Array(), { stream: true });

          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;

            let parsed: {
              message?: { content?: string };
              done?: boolean;
              done_reason?: string;
              error?: string;
            };
            try {
              parsed = JSON.parse(line);
            } catch {
              /* Skip a corrupted NDJSON line rather than abort the stream —
                 Ollama very occasionally emits keep-alive noise. If the whole
                 stream produces no content, the empty-buffer check below
                 will hard-fail. */
              continue;
            }

            if (parsed.error) {
              throw new Error(`Ollama ${this.url} stream error: ${parsed.error}`);
            }
            if (parsed.done && parsed.done_reason) doneReason = parsed.done_reason;

            const piece = parsed.message?.content;
            if (piece) {
              buf += piece;
              const now = Date.now();
              onChunk?.({
                receivedBytes: buf.length,
                receivedText: buf,
                sinceLastChunkMs: now - lastChunkAt,
                elapsedMs: now - start,
              });
              lastChunkAt = now;
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }

      if (!buf) {
        throw new Error(`Ollama ${this.model} returned an empty response.`);
      }
      /* Truncation gate (#528): the stream completed but Ollama stopped
         because it hit the context/output budget (`done_reason: 'length'`),
         not because the model finished. The buffered JSON is cut off
         mid-object; returning it hands a corrupt payload to parseAndValidate.
         Throw a classified error so the stage-2 chunker can split the
         chapter rather than retrying the same oversized prompt. */
      if (doneReason === 'length') {
        console.warn(
          `[ollama] output truncated done_reason=length bytes=${buf.length} model=${this.model}`,
        );
        throw new AnalyzerTruncatedError('ollama', 'length', buf.length);
      }
      // fs-45 v1: record this model's real GPU footprint while provably resident.
      // Env-gated (Global Constraints) so fetch-count tests can opt out; best-effort.
      if (process.env.CASTWRIGHT_VRAM_SAMPLE !== '0') {
        await sampleAndRecordVram(this.url, this.model, resolveAnalyzerNumCtx());
      }
      return buf;
    } finally {
      releaseGpu();
    }
  }
}

/** One-shot freeform Ollama call for persona generation. Unlike
    OllamaAnalyzer.chat() this sends NO response `format` (freeform text),
    does not stream, and is GPU-plan aware:
      - onCpu  → num_gpu:0 (system RAM only) AND skip the GPU semaphore
                 (a CPU call must not queue behind GPU synthesis).
      - !onCpu → acquire gpuSemaphore(costForEngine('analyzer')) around the fetch.
      - keepAlive is caller-controlled (resident window for a bulk pre-pass; 0
        for one-shot / CPU). */
export async function generatePersonaViaOllama(
  prompt: string,
  model: string,
  opts: { onCpu?: boolean; keepAlive?: string | number } = {},
): Promise<string> {
  const onCpu = opts.onCpu === true;
  const url = getResolvedOllamaUrl();
  const body = {
    model,
    messages: [{ role: 'user' as const, content: prompt }],
    stream: false,
    think: false,
    keep_alive: opts.keepAlive ?? 0,
    options: {
      temperature: resolveOllamaTemperature(),
      ...(onCpu ? { num_gpu: 0 } : {}),
    },
  };

  const release = onCpu ? null : await gpuSemaphore.acquire(costForEngine('analyzer'));
  try {
    let response: Response;
    try {
      response = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    release?.();
  }
}

/* Map a fetch / stream-read failure to either LocalUnreachableError (triggers
   fallback) or a plain Error (hard-fail). Undici surfaces connection-level
   errors as `TypeError: fetch failed` with `.cause` carrying the inner
   SystemError; we read `.cause.code` to discriminate. */
export function classifyConnectError(err: unknown, url: string): Error {
  const e = err as { cause?: { code?: string }; name?: string; code?: string; message?: string };
  const innerCode = e?.cause?.code ?? e?.code;
  if (innerCode && UNREACHABLE_CODES.has(innerCode)) {
    return new LocalUnreachableError(
      `Ollama at ${url} is unreachable (${innerCode}). Start the daemon or set ANALYZER=gemini.`,
      err,
    );
  }
  /* Bare "fetch failed" with no inner code on Node 20 is almost always a
     connection refusal at the OS layer (Windows surfaces it without a code
     in some configs). Treat as unreachable. */
  if (e?.name === 'TypeError' && /fetch failed/i.test(e?.message ?? '')) {
    return new LocalUnreachableError(
      `Ollama at ${url} is unreachable (fetch failed). Start the daemon or set ANALYZER=gemini.`,
      err,
    );
  }
  /* AbortError before first byte = the daemon never responded; treat as
     unreachable. Callers that abort mid-stream are handled by the inner
     read-loop catch which keys off `firstByteSeen`. */
  if (e?.name === 'AbortError') {
    return new LocalUnreachableError(
      `Ollama at ${url} aborted before first byte. Likely unreachable or hung.`,
      err,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
