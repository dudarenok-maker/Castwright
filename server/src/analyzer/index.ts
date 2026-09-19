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
import { OllamaAnalyzer } from './ollama.js';
import { AnalysisAbortedError, AnalyzerUnreachableError } from './errors.js';
import {
  getResolvedAnalysisEngine,
  getResolvedGeminiApiKey,
  getResolvedAllowCloudFallback,
} from '../workspace/user-settings.js';
import { getResolvedOllamaUrl, getResolvedOllamaModel } from '../config/ollama-resolved.js';
import { configValue } from '../config/resolver.js';

export type { StageChunkInfo, StageCall, Analyzer } from './types.js';
import type { Analyzer, StageCall } from './types.js';

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
      const fallbackModel = configValue<string>('analyzer.gemini.model');
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
        'Set it in Admin → Model Manager → Gemini API key, ' +
        'or in server/.env for CI / power users.',
    );
  }
  const model = opts.model ?? configValue<string>('analyzer.gemini.model');
  return {
    analyzer: new GeminiAnalyzer({ apiKey, model }),
    engine: 'gemini',
    model,
    fallbackModel: null,
  };
}

/* Decorator that delegates to a primary analyzer and falls back to a secondary only when the primary throws AnalyzerUnreachableError (Ollama's LocalUnreachableError is one). Every
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
      if (err instanceof AnalyzerUnreachableError) {
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
      if (err instanceof AnalyzerUnreachableError) {
        /* Announce the switch so the route re-labels the pill with the effective
           Gemini model (mirrors runScriptReviewChapter) — otherwise the UI keeps
           naming the local model that isn't running. */
        call.onFallback?.({ reason: 'Ollama unreachable' });
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
      if (err instanceof AnalyzerUnreachableError) {
        /* Announce the switch so the route re-labels the pill (see runStage1Chapter). */
        call.onFallback?.({ reason: 'Ollama unreachable' });
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
      if (err instanceof AnalyzerUnreachableError) {
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
      if (err instanceof AnalyzerUnreachableError) {
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
      if (err instanceof AnalyzerUnreachableError) {
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
      if (err instanceof AnalyzerUnreachableError) {
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
      if (err instanceof AnalyzerUnreachableError) {
        return await this.fallback.runNonStoryClassification!(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }
}
