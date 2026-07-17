/* Analyzer abstraction with two concrete implementations:
     - OllamaAnalyzer (local CUDA daemon on :11434, default)
     - GeminiAnalyzer (free-tier Google API)
   Dispatch is by `analysisEngine` in user-settings (cached; the `ANALYZER`
   env no longer selects the engine — see getResolvedAnalysisEngine). When
   engine is 'local', a Gemini API key is set, AND the opt-out cloud-fallback
   gate is on (default), the primary is wrapped in FallbackAnalyzer so the
   *single* failure mode of "Ollama unreachable" retries against Gemini. Every
   other error propagates and hard-fails — the rule, per plan 29: a misbehaving
   local model must not silently burn Gemini quota. */

import type {
  Stage1Output,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
  EmotionAnnotationOutput,
  ScriptReviewOutput,
  Stage3ChapterOutput,
  EscalationOutput,
  NonStoryClassificationOutput,
} from '../handoff/schemas.js';
import { GeminiAnalyzer } from './gemini.js';
import { OllamaAnalyzer, LocalUnreachableError, AnalysisAbortedError } from './ollama.js';
import type { RawEvalTiming } from './analyzer-eval-stats.js';
import {
  getResolvedAnalysisEngine,
  getResolvedOllamaUrl,
  getResolvedOllamaModel,
  getResolvedGeminiApiKey,
  getResolvedAllowCloudFallback,
} from '../workspace/user-settings.js';

export interface StageChunkInfo {
  /** Total bytes of model output received so far. */
  receivedBytes: number;
  /** Full assembled buffer so far — callers may peek (e.g. count
      `"name":` occurrences during stage 1) but should not mutate. */
  receivedText: string;
  /** ms since the previous chunk arrived (or since the request started
      for the first chunk). Big values warn that the model went quiet. */
  sinceLastChunkMs: number;
  /** ms since the request was sent. */
  elapsedMs: number;
}

export interface StageCall {
  onWaiting?: (elapsedMs: number) => void;
  /** Fired per streamed chunk from the model. */
  onChunk?: (info: StageChunkInfo) => void;
  /** Fired once per Ollama chat() call with that call's decode timing. The
      analysis route accumulates these per pass (see withPassEval). Only the
      local Ollama analyzer fires it; Gemini never does. */
  onEvalTiming?: (t: RawEvalTiming) => void;
  /** Optional abort signal — when the caller (the analysis route) sees its
      SSE client disconnect, it aborts the controller so the analyzer can
      tear down the in-flight Ollama/Gemini request instead of running on
      as a zombie that holds the model busy for the next session. */
  signal?: AbortSignal;
  /** Fired when the limiter has to delay this request — RPM/TPM cap hit
      locally, or `retry-delay` honored after a 429. Only emitted when
      the wait exceeds ~1s so sub-second jitter doesn't spam the UI.
      The route layer converts these to SSE `throttle` events. */
  onThrottle?: (waitMs: number, reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after') => void;
  /** fs-2 — the book's BCP-47 language. When non-English, the analyzer
      prepends a language preamble to the system instruction so attribution
      handles the script's conventions (Cyrillic names, «…»/— dash dialogue,
      patronymics). Absent/`'en'` → no preamble (byte-identical to pre-fs-2).
      Flows verbatim through every `runStage*` of every analyzer
      implementation, so it never touches a method signature. */
  language?: string;
  /** Fired by FallbackAnalyzer when it switches from a LocalUnreachable
      primary to the fallback for this call. Route uses it to announce the
      switch. */
  onFallback?: (info: { reason: string }) => void;
}

export interface Analyzer {
  /* Legacy whole-book stage 1 — retained on the interface for any
     historical caller. The current route uses runStage1Chapter
     (Phase 0a) instead. */
  runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output>;
  /* Phase 0a — per-chapter cast detection. Each call returns the
     speaking characters that appear in ONE chapter (new + recurring).
     The route merges these into a running roster across the book. */
  runStage1Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage1ChapterOutput>;
  /* Per-chapter sentence attribution. Stays under model context windows
     and lets free-tier rate limits recover between calls. */
  runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput>;
  /* fs-33 — emotion-only backfill. Reads a chapter's already-attributed
     sentences and returns ONLY {sentenceId, emotion} for the sentences it
     assigns a delivery emotion. Never re-attributes (no characterId/text in
     the output schema), so existing cast/manual reassignments are untouched. */
  runEmotionChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<EmotionAnnotationOutput>;
  /* fs-58 — LLM script review pass. Reads a chapter's attributed sentences
     and returns a flat list of editing ops (strip_tag, split, extract_dialogue,
     merge, fix_emotion) with anchors and rationale. Client-side apply dispatches
     the ops through existing Redux manual-edit reducers. */
  runScriptReviewChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<ScriptReviewOutput>;
  /* fs-57 — instruct-annotation pass. Reads a chapter's already-attributed
     sentences and returns {sentenceId, text?, instruct?, vocalization?} for
     sentences that need a delivery direction or vocalization flag. Never
     re-attributes (no characterId in the output schema). */
  runStage3Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage3ChapterOutput>;
  /* srv-59 Task 9 — flagged-window attribution escalation. Unlike every
     other analyzer call, this is NOT schema-constrained decoding: the
     reply shape `{assignments:[…]}` doesn't fit the stage2 grammar, and an
     empty/RECITATION-blocked reply must be observable rather than thrown.
     Returns `null` for an empty/blocked/unparseable response — NEVER a
     throw for those cases; the caller (escalateFlaggedWindows, Task 9b)
     just skips the window. A genuinely unreachable local daemon (or a
     client abort) still throws, same as every other method here, so
     FallbackAnalyzer/the route's abort handling keep working unchanged. */
  runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null>;
  /* #1447 — chapter-level non-story classification (Signal 2). OPTIONAL so
     analyzers that don't implement it degrade to Signal-1-only. Returns
     { nonStory: true } when the chapter is a non-story foreword / critical
     essay about the book or its author rather than narrative fiction. */
  runNonStoryClassification?(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput>;
}

export interface SelectAnalyzerOptions {
  /** Per-request override for the analyzer's model id. When engine is
      'local' this overrides the Ollama model tag; when engine is 'gemini'
      it overrides the Gemini model id. The UI typically only sends one
      shape, so the route layer is responsible for keeping override and
      engine in sync. */
  model?: string;
}

/** Resolved analyzer plus the metadata the route layer needs to label
    chunks ("Engine: Ollama (qwen3.5:9b)") and decide error messaging.
    Replaces the old bare-Analyzer return value. */
export interface AnalyzerSelection {
  analyzer: Analyzer;
  engine: 'local' | 'gemini';
  /** Model id actually being used by the primary analyzer. */
  model: string;
  /** Resolved fallback model when local is wrapped in FallbackAnalyzer.
      Null when no fallback is configured (no GEMINI_API_KEY). */
  fallbackModel: string | null;
}

/* Ollama tags always contain ':' (e.g. `qwen3.5:9b`); Gemini ids never do
   (`gemma-4-31b-it`, `gemini-2.5-flash`). When the route layer passes a
   per-request `model` override, we infer the engine from its shape — that
   way the UI dropdown can offer both engines and the user's pick drives
   both engine and model in one event. Without an override, fall back to
   the user-settings/env-default engine. */
function inferEngineFromModelId(modelId: string): 'local' | 'gemini' {
  return modelId.includes(':') ? 'local' : 'gemini';
}

export function selectAnalyzer(opts: SelectAnalyzerOptions = {}): AnalyzerSelection {
  const engine = opts.model ? inferEngineFromModelId(opts.model) : getResolvedAnalysisEngine();
  /* Plan 49 — read the Gemini API key via the resolver: env wins for CI /
     power users, then falls through to the UI-saved user-settings field.
     The previous `process.env.GEMINI_API_KEY` read missed the latter. */
  const apiKey = getResolvedGeminiApiKey() ?? '';

  if (engine === 'local') {
    const ollamaUrl = getResolvedOllamaUrl();
    const ollamaModel = opts.model ?? getResolvedOllamaModel();
    const primary = new OllamaAnalyzer({ url: ollamaUrl, model: ollamaModel });

    /* Part 1 — wrap in the Gemini fallback only when a key is present AND
       the opt-out cloud-fallback gate is on (default). A strict-local user
       who turned the gate off gets a bare OllamaAnalyzer even with a key set
       (kept for Gemini TTS), so a local outage never routes analysis to the
       cloud — announced or otherwise. */
    if (apiKey && getResolvedAllowCloudFallback()) {
      const fallbackModel = process.env.GEMINI_MODEL ?? 'gemma-4-31b-it';
      const fallback = new GeminiAnalyzer({ apiKey, model: fallbackModel });
      return {
        analyzer: new FallbackAnalyzer(primary, fallback),
        engine: 'local',
        model: ollamaModel,
        fallbackModel,
      };
    }

    /* No fallback configured (no key, or the gate is off). Bare OllamaAnalyzer
       hard-fails with the LocalUnreachableError message, which the route layer
       surfaces to the UI verbatim. The user can start the daemon, add a
       GEMINI_API_KEY, or turn cloud fallback back on. */
    return { analyzer: primary, engine: 'local', model: ollamaModel, fallbackModel: null };
  }

  // engine === 'gemini'
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is required when analyzer engine is Gemini. ' +
        'Set it from Account → Server configuration → Gemini API key, ' +
        'or in server/.env for CI / power users.',
    );
  }
  const model = opts.model ?? process.env.GEMINI_MODEL ?? 'gemma-4-31b-it';
  return {
    analyzer: new GeminiAnalyzer({ apiKey, model }),
    engine: 'gemini',
    model,
    fallbackModel: null,
  };
}

/* Decorator that delegates to a primary analyzer and falls back to a
   secondary only when the primary throws LocalUnreachableError. Every
   other error — HTTP failure, validation failure, schema mismatch —
   propagates unchanged. The rule (plan 29): if the local daemon is
   *reachable* but misbehaving, surface the error so the operator can fix
   it. Don't silently consume Gemini quota on a flaky local stack. */
export class FallbackAnalyzer implements Analyzer {
  constructor(
    private readonly primary: Analyzer,
    private readonly fallback: Analyzer,
  ) {}

  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    try {
      return await this.primary.runStage1(manuscriptId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runStage1(manuscriptId, promptMd, call);
      }
      throw err;
    }
  }

  async runStage1Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage1ChapterOutput> {
    try {
      return await this.primary.runStage1Chapter(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runStage1Chapter(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }

  async runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput> {
    try {
      return await this.primary.runStage2Chapter(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runStage2Chapter(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }

  async runEmotionChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<EmotionAnnotationOutput> {
    try {
      return await this.primary.runEmotionChapter(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runEmotionChapter(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }

  async runScriptReviewChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<ScriptReviewOutput> {
    try {
      return await this.primary.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        call.onFallback?.({ reason: 'Ollama unreachable' });
        return await this.fallback.runScriptReviewChapter(
          manuscriptId,
          chapterId,
          promptMd,
          call,
        );
      }
      throw err;
    }
  }

  async runStage3Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage3ChapterOutput> {
    try {
      return await this.primary.runStage3Chapter(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runStage3Chapter(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }

  async runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null> {
    try {
      return await this.primary.runAttributionEscalation(manuscriptId, chapterId, windowIndex, prompt, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runAttributionEscalation(manuscriptId, chapterId, windowIndex, prompt, call);
      }
      throw err;
    }
  }

  async runNonStoryClassification(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput> {
    try {
      return await this.primary.runNonStoryClassification!(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runNonStoryClassification!(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }
}
