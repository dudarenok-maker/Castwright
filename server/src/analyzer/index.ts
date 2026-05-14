/* Analyzer abstraction with two concrete implementations:
     - OllamaAnalyzer (local CUDA daemon on :11434, default)
     - GeminiAnalyzer (free-tier Google API)
   Dispatch is by `analysisEngine` in user-settings (cached) → `ANALYZER`
   env → 'local'. When engine is 'local' AND a Gemini API key is set, the
   primary is wrapped in FallbackAnalyzer so the *single* failure mode of
   "Ollama unreachable" silently retries against Gemini. Every other error
   propagates and hard-fails — the rule, per plan 29: a misbehaving local
   model must not silently burn Gemini quota. */

import type { Stage1Output, Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import { GeminiAnalyzer } from './gemini.js';
import { OllamaAnalyzer, LocalUnreachableError } from './ollama.js';
import {
  getResolvedAnalysisEngine,
  getResolvedOllamaUrl,
  getResolvedOllamaModel,
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
}

export interface Analyzer {
  /* Legacy whole-book stage 1 — retained on the interface for any
     historical caller. The current route uses runStage1Chapter
     (Phase 0a) instead. */
  runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output>;
  /* Phase 0a — per-chapter cast detection. Each call returns the
     speaking characters that appear in ONE chapter (new + recurring).
     The route merges these into a running roster across the book. */
  runStage1Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage1ChapterOutput>;
  /* Per-chapter sentence attribution. Stays under model context windows
     and lets free-tier rate limits recover between calls. */
  runStage2Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage2ChapterOutput>;
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

export function selectAnalyzer(opts: SelectAnalyzerOptions = {}): AnalyzerSelection {
  const engine = getResolvedAnalysisEngine();
  const apiKey = process.env.GEMINI_API_KEY?.trim() || '';

  if (engine === 'local') {
    const ollamaUrl = getResolvedOllamaUrl();
    const ollamaModel = opts.model ?? getResolvedOllamaModel();
    const primary = new OllamaAnalyzer({ url: ollamaUrl, model: ollamaModel });

    if (apiKey) {
      const fallbackModel = process.env.GEMINI_MODEL ?? 'gemma-4-31b-it';
      const fallback = new GeminiAnalyzer({ apiKey, model: fallbackModel });
      return {
        analyzer: new FallbackAnalyzer(primary, fallback),
        engine: 'local',
        model: ollamaModel,
        fallbackModel,
      };
    }

    /* No fallback configured. Bare OllamaAnalyzer hard-fails with the
       LocalUnreachableError message, which the route layer surfaces to
       the UI verbatim. The user can either start the daemon or set
       GEMINI_API_KEY for fallback. */
    return { analyzer: primary, engine: 'local', model: ollamaModel, fallbackModel: null };
  }

  // engine === 'gemini'
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required when ANALYZER=gemini (set it in server/.env — see server/.env.example).');
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
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runStage2Chapter(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }
}
