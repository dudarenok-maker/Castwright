/* Analyzer abstraction with two concrete implementations:
     - OllamaAnalyzer (local CUDA daemon on :11434, default)
     - GeminiAnalyzer (free-tier Google API)
   Dispatch is by `analysisEngine` in user-settings (cached; the `ANALYZER`
   env no longer selects the engine — see getResolvedAnalysisEngine). When
   the primary (Ollama or an OpenAI-compatible endpoint) is unreachable,
   FallbackAnalyzer hands the call, one hop, to the target chosen in Advanced
   Settings (analyzer.fallback.target, #3084 P30; off disables it). Every other
   error propagates and hard-fails — the rule, per plan 29: a misbehaving model
   must not silently burn another provider's quota. */

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
import { OpenAIAnalyzer } from './openai.js';
import {
  AnalysisAbortedError,
  AnalyzerUnreachableError,
  AnalyzerEndpointMissingError,
  AnalyzerTargetInputTooLargeError,
  TargetInputOverBudgetError,
  type TransportKind,
} from './errors.js';
import { getResolvedAnalysisEngine, getResolvedGeminiApiKey, getCachedUserSettings } from '../workspace/user-settings.js';
import { getResolvedOllamaUrl, getResolvedOllamaModel } from '../config/ollama-resolved.js';
import { configValue } from '../config/resolver.js';
import { inferEngineFromModelId, parseEndpointModelId, type AnalysisEngine } from './model-id.js';
import { resolveEndpointApiKey } from '../workspace/analyzer-endpoints.js';
import { resolveAnalyzerFallbackTarget } from './fallback-target.js';
import { assertAnalyzerTargetUsable } from './capabilities.js';
import { ollamaModelDigest } from './ollama-digest.js';
import { resolveCapacity, type EngineCapacity } from './capacity.js';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { resolveStage2ChunkCharBudget } from './stage2-chunk.js';
import { chapterChunkBudget, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS } from './chapter-chunker.js';

export type { StageChunkInfo, StageCall, Analyzer } from './types.js';
import type { Analyzer, StageCall } from './types.js';

export interface SelectAnalyzerOptions {
  /** Per-request override for the analyzer's model id. When engine is
      'local' this overrides the Ollama model tag; when engine is 'gemini'
      it overrides the Gemini model id. The UI typically only sends one
      shape, so the route layer is responsible for keeping override and
      engine in sync. */
  model?: string;
  /** #3084 P23 — where `model` came from, named by AnalyzerEndpointMissingError.
      selectAnalyzerForPhase sets it; any other caller passing `model` means a
      run pick. */
  modelSource?: 'env' | 'run-pick' | 'settings';
}

/** Resolved analyzer plus the metadata the route layer needs to label
    chunks ("Engine: Ollama (qwen3.5:9b)") and decide error messaging.
    Replaces the old bare-Analyzer return value. */
export interface AnalyzerSelection {
  analyzer: Analyzer;
  engine: AnalysisEngine;
  /** Model id actually being used by the primary analyzer. */
  model: string;
  /** The fallback target's model id when the primary is wrapped in FallbackAnalyzer
      (#3084 P30, analyzer.fallback.target). Null when there is no wrap. */
  fallbackModel: string | null;
}

/* Engine inference from a per-request model id lives in ./model-id.ts
   (shared case table with the frontend): `openai:<endpointId>::<model>` →
   openai, contains ':' → local (Ollama), else gemini. */

export function selectAnalyzer(opts: SelectAnalyzerOptions = {}): AnalyzerSelection {
  const engine = opts.model ? inferEngineFromModelId(opts.model) : getResolvedAnalysisEngine();
  /* Plan 49 — read the Gemini API key via the resolver: env wins for CI /
     power users, then falls through to the UI-saved user-settings field.
     The previous `process.env.GEMINI_API_KEY` read missed the latter. */
  const apiKey = getResolvedGeminiApiKey() ?? '';

  if (engine === 'openai') {
    const settings = getCachedUserSettings();
    const modelId = opts.model ?? settings.defaultAnalysisModel;
    const parsed = parseEndpointModelId(modelId);
    const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
    /* Refused only when the endpoint is not saved. `modelSource` (3a) keeps an env-named id saying env.
       Without it, an explicit model is a run pick (3a's contract); only the saved default is settings (P23). */
    if (!parsed || !endpoint) {
      throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? modelId, opts.modelSource ?? (opts.model ? 'run-pick' : 'settings'));
    }
    const primary = new OpenAIAnalyzer({ endpoint, apiKey: resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl), model: parsed.model });
    return withFallback({ analyzer: primary, engine: 'openai', model: modelId, fallbackModel: null });
  }

  if (engine === 'local') {
    /* #3084 P23 — a saved endpoint default must fail the run with a code,
       not be swapped silently for getResolvedOllamaModel()'s Ollama default. */
    if (!opts.model) {
      const savedEndpoint = parseEndpointModelId(getCachedUserSettings().defaultAnalysisModel);
      if (savedEndpoint) throw new AnalyzerEndpointMissingError(savedEndpoint.endpointId, 'settings');
    }
    const ollamaUrl = getResolvedOllamaUrl();
    const ollamaModel = opts.model ?? getResolvedOllamaModel();
    return withFallback({ analyzer: new OllamaAnalyzer({ url: ollamaUrl, model: ollamaModel }), engine: 'local', model: ollamaModel, fallbackModel: null });
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

/* Human-readable name per transport, for the message that announces a fallback.
    Spelled out rather than capitalised from TransportKind so acronyms stay right
    ('openai' → 'OpenAI', not 'Openai'). */
const TRANSPORT_LABEL: Record<TransportKind, string> = {
  ollama: 'Ollama',
  gemini: 'Gemini',
  openai: 'OpenAI',
};

/* #3284 — the reason announced via `StageCall.onFallback` is derived from the
   error's own, required `transport`, not hard-coded to Ollama. The guard above
   each call site fires on ANY AnalyzerUnreachableError, and the route renders
   this string to the user (script-review.ts passes it through to the SSE
   `fallbackReason`), so a frozen "Ollama unreachable" would name a daemon that
   was never involved the moment a second transport lands. Wording is unchanged
   for the 'ollama' case.

   #3084 P30 — with `names` (every selectAnalyzer wrap passes them) the reason
   also names the primary and the target, extending the cause text rather than
   replacing it: an endpoint primary reads `OpenAI endpoint <name> · <model>
   unreachable — switched to <target>`, Ollama reads `Ollama unreachable
   (<model>) — switched to <target>`. Without names (a FallbackAnalyzer built
   directly) it is the bare `<Transport> unreachable`. */
export function fallbackReason(err: AnalyzerUnreachableError, names?: { primary: string; target: string }): string {
  if (!names) return `${TRANSPORT_LABEL[err.transport]} unreachable`;
  const cause =
    err.transport === 'openai'
      ? `${TRANSPORT_LABEL.openai} endpoint ${names.primary} unreachable`
      : `${TRANSPORT_LABEL[err.transport]} unreachable (${names.primary})`;
  return `${cause} — switched to ${names.target}`;
}

/* #3084 P30 — wrap a primary in the configured fallback target, one hop, only when there is one. */
function withFallback(primary: AnalyzerSelection): AnalyzerSelection {
  const target = fallbackSelectionFor(primary);
  if (!target) return primary;
  return {
    ...primary,
    analyzer: new FallbackAnalyzer(primary.analyzer, target.analyzer, fallbackNames(primary, target), targetInputGuard(target)),
    fallbackModel: target.model,
  };
}

export type FallbackPass = 'stage1' | 'stage2' | 'script-review' | 'emotion' | 'stage3' | 'escalation' | 'non-story' | 'stage1-book';
/** `body` is the call's `StageCall.inputBody`: the chunk its prompt carries, as the pass's chunker measured it. */
export type FallbackInputGuard = (pass: FallbackPass, prompt: string, body?: string) => void;

/* Callers that split on AnalyzerTruncatedError (stage1-chunk.ts, stage2-chunk.ts, script-review.ts). */
const SPLITTING_PASSES: ReadonlySet<FallbackPass> = new Set(['stage1', 'stage2', 'script-review']);

/* The budget the pass's chunker computes on this capacity: fraction × context at 2 chars/token, bounded
   by the pass's chunk ceiling and 3c.9's per-request cap (context family), or the body the per-request
   token cap leaves (request-cap family). A pass with no chunker uses the stage it resembles. */
function passBudgetChars(pass: FallbackPass, capacity: EngineCapacity, body: string): number {
  switch (pass) {
    case 'stage2':
    case 'escalation':
      return resolveStage2ChunkCharBudget(capacity, body);
    case 'script-review':
    case 'emotion':
    case 'stage3':
      return chapterChunkBudget(capacity, 0, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS);
    case 'stage1':
    case 'stage1-book':
    case 'non-story':
      return resolveStage1ChunkCharBudget(capacity, body);
  }
}

/* #3084 P30 — a chunk sized for the primary may be too big for the target. Measure it the way the
   chunker does, against that pass's budget on the target, and refuse it before the target runs: a body
   within that budget leaves the target room for the instructions and the answer. A splitting pass gets
   a TargetInputOverBudgetError (a truncation its runner splits, and turns back into the refusal when it
   cannot split further); any other pass gets the AnalyzerTargetInputTooLargeError naming the target and
   its limit (no HTTP status), through that caller's own failure handling. */
export function targetInputGuard(target: Pick<AnalyzerSelection, 'engine' | 'model'>): FallbackInputGuard {
  return (pass, prompt, body) => {
    const capacity = resolveCapacity({ engine: target.engine, model: target.model });
    /* The chunk as its chunker measured it; the whole prompt for a pass with no chunker. */
    const text = body ?? prompt;
    if (text.length <= passBudgetChars(pass, capacity, text)) return;
    const transport: TransportKind = target.engine === 'local' ? 'ollama' : target.engine;
    const requestCap = capacity.family === 'requestCap';
    const limitTokens = requestCap ? (capacity.perRequestInputCap ?? capacity.contextTokens) : capacity.contextTokens;
    const refusal = new AnalyzerTargetInputTooLargeError(transport, target.model, fallbackNames(target, target).target, limitTokens, requestCap ? 'requestCap' : 'context');
    if (SPLITTING_PASSES.has(pass)) throw new TargetInputOverBudgetError(refusal);
    throw refusal;
  };
}

/** The target selection a primary falls back to, or null: a Gemini primary, `off`, a keyless
    `gemini`, the primary itself, or an endpoint that is not saved (warns). Never wrapped. */
export function fallbackSelectionFor(primary: AnalyzerSelection): AnalyzerSelection | null {
  if (primary.engine === 'gemini') return null;
  const target = resolveAnalyzerFallbackTarget();
  if (target === 'off') return null;
  if (target === 'gemini') {
    const apiKey = getResolvedGeminiApiKey();
    if (!apiKey) return null;
    const model = configValue<string>('analyzer.gemini.model');
    return checkedTarget('gemini', model, () => new GeminiAnalyzer({ apiKey, model }));
  }
  if (target === 'local') {
    /* One daemon: an unreachable local primary means an unreachable local target, whatever the model. */
    if (primary.engine === 'local') return null;
    /* The model a `local` selection resolves to anywhere (config/ollama-resolved.ts, #3192): the saved Ollama
       tag, else OLLAMA_MODEL, else the Advanced Settings analyzer.ollama.model override, else the shipped default. */
    const model = getResolvedOllamaModel();
    const url = getResolvedOllamaUrl();
    return checkedTarget('local', model, () => new OllamaAnalyzer({ url, model }), () => ollamaModelDigest(url, model).catch(() => undefined));
  }
  if (primary.engine === 'openai' && primary.model === target) return null;
  const parsed = parseEndpointModelId(target);
  const endpoint = parsed ? getCachedUserSettings().analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
  if (!parsed || !endpoint) {
    console.warn(`[analyzer] fallback skipped: analyzer.fallback.target names analyzer endpoint "${parsed?.endpointId ?? target}", which is not saved`);
    return null;
  }
  return checkedTarget('openai', target, () =>
    new OpenAIAnalyzer({ endpoint, apiKey: resolveEndpointApiKey(getCachedUserSettings(), endpoint, endpoint.baseUrl), model: parsed.model }),
  );
}

/* P30 — the target's own checks run on its first call, never at selection, so a broken fallback
   cannot block a run whose primary works. One check and one build per selection. */
function checkedTarget(
  engine: AnalysisEngine,
  model: string,
  build: () => Analyzer,
  digest: () => Promise<string | undefined> = async () => undefined,
): AnalyzerSelection {
  let built: Promise<Analyzer> | undefined;
  const get = (): Promise<Analyzer> =>
    (built ??= (async () => {
      assertAnalyzerTargetUsable({ modelId: model, source: 'settings', engine }, getCachedUserSettings(), await digest());
      return build();
    })());
  const analyzer: Analyzer = {
    runStage1: async (...a) => (await get()).runStage1(...a),
    runStage1Chapter: async (...a) => (await get()).runStage1Chapter(...a),
    runStage2Chapter: async (...a) => (await get()).runStage2Chapter(...a),
    runEmotionChapter: async (...a) => (await get()).runEmotionChapter(...a),
    runScriptReviewChapter: async (...a) => (await get()).runScriptReviewChapter(...a),
    runStage3Chapter: async (...a) => (await get()).runStage3Chapter(...a),
    runAttributionEscalation: async (...a) => (await get()).runAttributionEscalation(...a),
    runNonStoryClassification: async (...a) => (await get()).runNonStoryClassification!(...a),
  };
  return { analyzer, engine, model, fallbackModel: null };
}

/** Names for the announcement: the primary's model (endpoint name · model for an endpoint) and
    the target with its engine. Reads endpoint names from saved settings; never a key. */
export function fallbackNames(
  primary: Pick<AnalyzerSelection, 'engine' | 'model'>,
  target: Pick<AnalyzerSelection, 'engine' | 'model'>,
): { primary: string; target: string } {
  const endpoint = (id: string) => {
    const parsed = parseEndpointModelId(id);
    const saved = getCachedUserSettings().analyzerEndpoints.find((e) => e.id === parsed?.endpointId);
    return { name: saved?.name ?? parsed?.endpointId ?? id, model: parsed?.model ?? id };
  };
  const p = endpoint(primary.model);
  const t = endpoint(target.model);
  return {
    primary: primary.engine === 'openai' ? `${p.name} · ${p.model}` : primary.model,
    target: target.engine === 'openai' ? `endpoint ${t.name} (${t.model})` : `${target.engine === 'gemini' ? 'Gemini' : 'Ollama'} (${target.model})`,
  };
}

/* Decorator that delegates to a primary analyzer and falls back, one hop, to the
   configured target only when the primary throws AnalyzerUnreachableError (#3084 P30;
   Ollama's LocalUnreachableError is one case of it). Every other error — HTTP failure,
   validation failure, schema mismatch — propagates unchanged. The rule (plan
   29): if the local daemon is *reachable* but misbehaving, surface the error so
   the operator can fix it. Don't silently consume Gemini quota on a flaky local
   stack. */
export class FallbackAnalyzer implements Analyzer {
  constructor(
    private readonly primary: Analyzer,
    private readonly fallback: Analyzer,
    private readonly names?: { primary: string; target: string },
    private readonly guard?: FallbackInputGuard,
  ) {}

  /* P30 — every switch is announced with both names; a target that is also unreachable fails
     naming both. Same instance rethrown, so its class, transport, cause and classification stay.
     Every method passes `check`; the guard decides what an over-budget prompt throws. */
  private async switchTo<T>(
    err: AnalyzerUnreachableError,
    call: StageCall,
    run: (fallback: Analyzer) => Promise<T>,
    check?: { pass: FallbackPass; prompt: string },
  ): Promise<T> {
    const reason = fallbackReason(err, this.names);
    call.onFallback?.({ reason });
    if (check) this.guard?.(check.pass, check.prompt, call.inputBody); // throws before the target runs when over its budget
    try {
      return await run(this.fallback);
    } catch (second) {
      if (second instanceof AnalyzerUnreachableError) second.message = `${reason}; the fallback is unreachable too: ${second.message}`;
      throw second;
    }
  }

  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    try {
      return await this.primary.runStage1(manuscriptId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof AnalyzerUnreachableError) {
        return await this.switchTo(err, call, (f) => f.runStage1(manuscriptId, promptMd, call), { pass: 'stage1-book', prompt: promptMd });
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
        return await this.switchTo(err, call, (f) => f.runStage1Chapter(manuscriptId, chapterId, promptMd, call), { pass: 'stage1', prompt: promptMd });
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
        return await this.switchTo(err, call, (f) => f.runStage2Chapter(manuscriptId, chapterId, promptMd, call), { pass: 'stage2', prompt: promptMd });
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
        return await this.switchTo(err, call, (f) => f.runEmotionChapter(manuscriptId, chapterId, promptMd, call), { pass: 'emotion', prompt: promptMd });
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
        return await this.switchTo(err, call, (f) => f.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call), {
          pass: 'script-review',
          prompt: promptMd,
        });
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
        return await this.switchTo(err, call, (f) => f.runStage3Chapter(manuscriptId, chapterId, promptMd, call), { pass: 'stage3', prompt: promptMd });
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
        return await this.switchTo(err, call, (f) => f.runAttributionEscalation(manuscriptId, chapterId, windowIndex, prompt, call), {
          pass: 'escalation',
          prompt,
        });
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
        return await this.switchTo(err, call, (f) => f.runNonStoryClassification!(manuscriptId, chapterId, promptMd, call), {
          pass: 'non-story',
          prompt: promptMd,
        });
      }
      throw err;
    }
  }
}
