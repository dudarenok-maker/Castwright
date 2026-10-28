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
  /** The engine `model` belongs to, when the caller already knows it (a fallback target's
      `AnalyzerSelection.fallbackEngine`). Omitted, it is inferred from `model`, which misreads a
      tagless Ollama model as Gemini. */
  engine?: AnalysisEngine;
  /** #3084 P23 — where `model` came from, named by AnalyzerEndpointMissingError.
      selectAnalyzerForPhase sets it; any other caller passing `model` means a
      run pick. */
  modelSource?: 'env' | 'run-pick' | 'settings';
  /** #3084 wave 3d review pass 2 — the run's fallback switch. A job selects one analyzer per phase,
      so a switch one selection makes must be visible to the others routed to the same failed primary;
      the job creates ONE and passes it to each of its selections. Omitted, the selection has its own. */
  fallbackSwitch?: RunFallbackSwitch;
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
  /** The fallback target's own engine, as `withFallback` built it. Never infer it from `fallbackModel`:
      a tagless Ollama model ("llama3") reads as Gemini to the model-id rule. Null exactly when
      `fallbackModel` is. */
  fallbackEngine: AnalysisEngine | null;
}

/* Engine inference from a per-request model id lives in ./model-id.ts
   (shared case table with the frontend): `openai:<endpointId>::<model>` →
   openai, contains ':' → local (Ollama), else gemini. */

/** What a run's selections share once any of them has fallen back (the owner decision: sticky for the
    whole run). Keyed by the failed primary, so a different primary in the same run is not affected.
    Per run — never module-global: one job's switch must not reach another job. */
export class RunFallbackSwitch {
  private readonly reasons = new Map<string, string>();
  reasonFor(key: string): string | undefined {
    return this.reasons.get(key);
  }
  /** The first switch wins; a later trip of the same key keeps the first reason. */
  trip(key: string, reason: string): void {
    if (!this.reasons.has(key)) this.reasons.set(key, reason);
  }
}

/** The failed-primary identity a switch is keyed on: an endpoint model by its id; every Ollama
    selection together (one daemon, as fallbackSelectionFor already assumes). */
export function fallbackSwitchKey(primary: Pick<AnalyzerSelection, 'engine' | 'model'>): string {
  return primary.engine === 'local' ? 'local' : `${primary.engine}:${primary.model}`;
}

export function selectAnalyzer(opts: SelectAnalyzerOptions = {}): AnalyzerSelection {
  const engine = opts.engine ?? (opts.model ? inferEngineFromModelId(opts.model) : getResolvedAnalysisEngine());
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
      throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? modelId, opts.modelSource ?? (opts.model ? 'run-pick' : 'settings'), parsed ? 'not-saved' : 'not-an-endpoint');
    }
    const primary = new OpenAIAnalyzer({ endpoint, apiKey: resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl), model: parsed.model });
    return withFallback({ analyzer: primary, engine: 'openai', model: modelId, fallbackModel: null, fallbackEngine: null }, opts.fallbackSwitch);
  }

  if (engine === 'local') {
    /* #3084 P23 — a saved endpoint default must fail the run with a code,
       not be swapped silently for getResolvedOllamaModel()'s Ollama default. */
    if (!opts.model) {
      const settings = getCachedUserSettings();
      const savedEndpoint = parseEndpointModelId(settings.defaultAnalysisModel);
      /* The refusal stands either way; its copy depends on whether the endpoint is saved. */
      if (savedEndpoint) {
        const saved = settings.analyzerEndpoints.some((e) => e.id === savedEndpoint.endpointId);
        throw new AnalyzerEndpointMissingError(savedEndpoint.endpointId, 'settings', saved ? 'engine-mismatch' : 'not-saved');
      }
    }
    const ollamaUrl = getResolvedOllamaUrl();
    const ollamaModel = opts.model ?? getResolvedOllamaModel();
    return withFallback({ analyzer: new OllamaAnalyzer({ url: ollamaUrl, model: ollamaModel }), engine: 'local', model: ollamaModel, fallbackModel: null, fallbackEngine: null }, opts.fallbackSwitch);
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
    fallbackEngine: null,
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
function withFallback(primary: AnalyzerSelection, runSwitch?: RunFallbackSwitch): AnalyzerSelection {
  const target = fallbackSelectionFor(primary);
  if (!target) return primary;
  return {
    ...primary,
    analyzer: new FallbackAnalyzer(primary.analyzer, target.analyzer, fallbackNames(primary, target), targetInputGuard(target), {
      switch: runSwitch ?? new RunFallbackSwitch(),
      key: fallbackSwitchKey(primary),
    }),
    fallbackModel: target.model,
    fallbackEngine: target.engine,
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
      assertAnalyzerTargetUsable({ modelId: model, source: 'settings', engine }, getCachedUserSettings(), await digest(), 'mid-run');
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
  return { analyzer, engine, model, fallbackModel: null, fallbackEngine: null };
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
  /* #3084 wave 3d review (owner decision) — the switch is STICKY for the RUN: after the first
     AnalyzerUnreachableError every later call, of this selection and of every other selection of the
     same run routed to the same failed primary (they share `run.switch`), goes straight to the target,
     so the job's relabel (engine, model), its chunk sizing for the target and its Ollama bookkeeping
     are all true, and a recovered primary never receives a chunk sized for the target. Never reset: a
     run that fell back finishes on the target (script review's shape). A FallbackAnalyzer built without
     `run` has a switch of its own (one selection). */
  private readonly run: { switch: RunFallbackSwitch; key: string };
  /* This instance has told ITS caller (call.onFallback) about the switch. A second selection that finds
     the run already switched announces once, so its own job state relabels; the marks are idempotent
     (markFallbackActive), so the target is not marked twice. */
  private announced = false;

  constructor(
    private readonly primary: Analyzer,
    private readonly fallback: Analyzer,
    private readonly names?: { primary: string; target: string },
    private readonly guard?: FallbackInputGuard,
    run?: { switch: RunFallbackSwitch; key: string },
  ) {
    this.run = run ?? { switch: new RunFallbackSwitch(), key: 'self' };
  }

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
    this.run.switch.trip(this.run.key, reason);
    this.announced = true;
    call.onFallback?.({ reason });
    return this.runOnTarget(reason, call, run, check);
  }

  private async runOnTarget<T>(
    reason: string,
    call: StageCall,
    run: (fallback: Analyzer) => Promise<T>,
    check?: { pass: FallbackPass; prompt: string },
  ): Promise<T> {
    if (check) this.guard?.(check.pass, check.prompt, call.inputBody); // throws before the target runs when over its budget
    try {
      return await run(this.fallback);
    } catch (second) {
      if (second instanceof AnalyzerUnreachableError) second.message = `${reason}; the fallback is unreachable too: ${second.message}`;
      throw second;
    }
  }

  /* One routing rule for all eight methods: the primary first until the run's first switch, the target
     alone after it (announced once per instance — the first announcement already relabelled the job). */
  private async route<T>(
    call: StageCall,
    check: { pass: FallbackPass; prompt: string },
    onPrimary: (primary: Analyzer) => Promise<T>,
    onTarget: (fallback: Analyzer) => Promise<T>,
  ): Promise<T> {
    const switched = this.run.switch.reasonFor(this.run.key);
    if (switched !== undefined) {
      if (!this.announced) {
        this.announced = true;
        call.onFallback?.({ reason: switched });
      }
      return this.runOnTarget(switched, call, onTarget, check);
    }
    try {
      return await onPrimary(this.primary);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof AnalyzerUnreachableError) return await this.switchTo(err, call, onTarget, check);
      throw err;
    }
  }

  runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    const run = (a: Analyzer) => a.runStage1(manuscriptId, promptMd, call);
    return this.route(call, { pass: 'stage1-book', prompt: promptMd }, run, run);
  }

  runStage1Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage1ChapterOutput> {
    const run = (a: Analyzer) => a.runStage1Chapter(manuscriptId, chapterId, promptMd, call);
    return this.route(call, { pass: 'stage1', prompt: promptMd }, run, run);
  }

  runStage2Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage2ChapterOutput> {
    const run = (a: Analyzer) => a.runStage2Chapter(manuscriptId, chapterId, promptMd, call);
    return this.route(call, { pass: 'stage2', prompt: promptMd }, run, run);
  }

  runEmotionChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<EmotionAnnotationOutput> {
    const run = (a: Analyzer) => a.runEmotionChapter(manuscriptId, chapterId, promptMd, call);
    return this.route(call, { pass: 'emotion', prompt: promptMd }, run, run);
  }

  runScriptReviewChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<ScriptReviewOutput> {
    const run = (a: Analyzer) => a.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call);
    return this.route(call, { pass: 'script-review', prompt: promptMd }, run, run);
  }

  runStage3Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage3ChapterOutput> {
    const run = (a: Analyzer) => a.runStage3Chapter(manuscriptId, chapterId, promptMd, call);
    return this.route(call, { pass: 'stage3', prompt: promptMd }, run, run);
  }

  runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null> {
    const run = (a: Analyzer) => a.runAttributionEscalation(manuscriptId, chapterId, windowIndex, prompt, call);
    return this.route(call, { pass: 'escalation', prompt }, run, run);
  }

  runNonStoryClassification(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<NonStoryClassificationOutput> {
    const run = (a: Analyzer) => a.runNonStoryClassification!(manuscriptId, chapterId, promptMd, call);
    return this.route(call, { pass: 'non-story', prompt: promptMd }, run, run);
  }
}