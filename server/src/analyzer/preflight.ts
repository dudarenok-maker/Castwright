/* #3084 W3 — pre-run checks (spec data flow step 1, P14). When a new job is created and
   before its first analyzer call, every model id the run will use must name an existing
   endpoint, a key still bound to that endpoint's origin, and no Test record that rejected
   the configured structured-output mode at the level the run sends. Env and per-run picks
   cannot be blocked at settings-save time, so this is where they fail — as
   analyzer-endpoint-missing / auth / analyzer-request-rejected. Each target is checked as
   the engine selection will build, so the check never passes a run selection then refuses. */
import { configValue } from '../config/resolver.js';
import { getResolvedAnalysisEngine, type UserSettings } from '../workspace/user-settings.js';
/* #3192 moved both resolvers into this leaf: env → Advanced Settings override → default. */
import { getResolvedOllamaModel, getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import { resolveEndpointApiKey } from '../workspace/analyzer-endpoints.js';
import { inferEngineFromModelId, parseEndpointModelId, type AnalysisEngine } from './model-id.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import { assertConfiguredCapabilitiesAllowed, capabilityRecordFor, defaultReasoningKey } from './capabilities.js';
import { resolvePhaseModelSelection, type AnalysisPhase } from './select-analyzer.js';
import type { StructuredOutputMode } from './runner/transport.js';
import { ollamaModelDigest } from './ollama-digest.js';

export interface PreflightTarget {
  modelId: string;
  source: 'env' | 'run-pick' | 'settings';
  /** The engine selection builds for this target: inferred from an explicit id
      (`selectAnalyzer({ model })`), the saved engine for the default (`selectAnalyzer({})`). */
  engine: AnalysisEngine;
}

function engineDefaultModelId(engine: AnalysisEngine, settings: UserSettings): string {
  if (engine === 'openai') return settings.defaultAnalysisModel;
  if (engine === 'gemini') return configValue<string>('analyzer.gemini.model');
  return getResolvedOllamaModel();
}

/** The run's per-run phase picks: the request's `phase0Model` / `phase1Model` (#3141 step 4), never persisted. */
export type RequestedPhaseModels = Partial<Record<AnalysisPhase, string>>;

/** Resolves each phase exactly as `selectAnalyzerForPhase` will (`resolvePhaseModelSelection`).
    A saved phase-model override is read from the settings cache through `resolveKnob`, so callers
    `await readUserSettings()` first and pass what it returned as `settings`. */
export function preflightTargets(
  phases: readonly AnalysisPhase[],
  requestedModel: string | undefined,
  settings: UserSettings,
  requestedPhaseModels: RequestedPhaseModels = {},
): PreflightTarget[] {
  return phases.map((phase) => {
    const resolved = resolvePhaseModelSelection({ phase, model: requestedModel, phaseModel: requestedPhaseModels[phase] });
    if (resolved.modelId === null) {
      const engine = getResolvedAnalysisEngine();
      return { modelId: engineDefaultModelId(engine, settings), source: 'settings', engine };
    }
    return {
      modelId: resolved.modelId,
      source: resolved.source,
      engine: inferEngineFromModelId(resolved.modelId),
    };
  });
}

/** A3 — the installed digest of every distinct Ollama target, so a record written for another build
    is discarded rather than refusing the run. The one await the checks need: callers resolve it
    before the synchronous check block. The analysis POSTs call it on the new-job path only, then
    re-check for a live job before the checks (#3004, P14). Gemini and endpoint targets have no
    digest and cost nothing. Never throws. */
export async function resolvePreflightDigests(
  targets: readonly PreflightTarget[],
  deps: { ollamaUrl?: () => string; modelDigest?: (url: string, model: string) => Promise<string | undefined> } = {},
): Promise<Map<string, string | undefined>> {
  const digestOf = deps.modelDigest ?? ollamaModelDigest;
  const models = [...new Set(targets.filter((t) => t.engine === 'local').map((t) => t.modelId))];
  const out = new Map<string, string | undefined>();
  if (models.length === 0) return out;
  const url = (deps.ollamaUrl ?? getResolvedOllamaUrl)();
  await Promise.all(models.map(async (model) => out.set(model, await digestOf(url, model).catch(() => undefined))));
  return out;
}

export function runAnalyzerPreflight(
  targets: readonly PreflightTarget[],
  settings: UserSettings,
  /** A3: from resolvePreflightDigests. Absent or missing a model → that record is kept (fail-open). */
  digests?: ReadonlyMap<string, string | undefined>,
): void {
  const seen = new Set<string>();
  for (const target of targets) {
    const key = `${target.engine}|${target.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (target.engine === 'openai') {
      const parsed = parseEndpointModelId(target.modelId);
      const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
      if (!parsed || !endpoint) throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? target.modelId, target.source);
      resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl); // throws AnalyzerKeyOriginError for a key bound to another host
      assertConfiguredCapabilitiesAllowed(
        capabilityRecordFor(settings, target.modelId, endpoint.baseUrl),
        { structuredOutput: endpoint.structuredOutput, reasoning: defaultReasoningKey('openai') },
        target.modelId,
      );
    } else if (target.engine === 'gemini') {
      assertConfiguredCapabilitiesAllowed(
        capabilityRecordFor(settings, target.modelId, 'gemini'),
        { structuredOutput: configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput'), reasoning: defaultReasoningKey('gemini') },
        target.modelId,
      );
    } else {
      assertConfiguredCapabilitiesAllowed(
        capabilityRecordFor(settings, target.modelId, getResolvedOllamaUrl(), digests?.get(target.modelId)),
        { structuredOutput: configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput'), reasoning: defaultReasoningKey('ollama') },
        target.modelId,
      );
    }
  }
}
