/* #3084 P30 — where an unreachable Ollama or endpoint primary falls back to: one global target,
   chosen in Advanced Settings (analyzer.fallback.target). Selection lives in index.ts
   (fallbackSelectionFor); this module only resolves the value and checks a save. */
import { getKnob } from '../config/registry.js';
import { configValue, resolveKnob } from '../config/resolver.js';
import type { KnobValueState } from '../config/types.js';
import { getResolvedAllowCloudFallback, getResolvedGeminiApiKey } from '../workspace/user-settings.js';
import { getResolvedOllamaModel } from '../config/ollama-resolved.js';
import { parseEndpointModelId } from './model-id.js';

export type AnalyzerFallbackTarget = 'off' | 'local' | 'gemini' | string;

/** env → saved override → legacy (allowCloudFallback false → off) → default gemini. No write-migration. */
export function resolveAnalyzerFallbackTarget(): AnalyzerFallbackTarget {
  const state = resolveKnob(getKnob('analyzer.fallback.target')!);
  if (state.source !== 'default') return String(state.effective);
  /* An install that switched Model Manager's old "Cloud fallback" off stays strict-local. */
  if (!getResolvedAllowCloudFallback()) return 'off';
  return String(state.effective);
}

/** A save-time refusal, or null. Callers read saved settings from disk first. */
export function fallbackTargetSaveError(value: string, saved: { endpointIds: readonly string[]; geminiKey: boolean }): string | null {
  if (value === 'gemini' && !saved.geminiKey) {
    return 'analyzer.fallback.target: gemini needs a Gemini API key. Add one in Model Manager → Server configuration, or pick another target.';
  }
  const parsed = parseEndpointModelId(value);
  if (parsed && !saved.endpointIds.includes(parsed.endpointId)) {
    return `analyzer.fallback.target: no analyzer endpoint "${parsed.endpointId}" is saved. Add it in Model Manager → Analyzer endpoints, or pick another target.`;
  }
  return null;
}

/** The Advanced Settings value for this knob. resolveAll() builds values from resolveKnob, which
    knows nothing of the legacy step, so routes/config.ts swaps this knob's entry for this one. */
export function fallbackTargetValueState(base: KnobValueState): KnobValueState {
  const effective = resolveAnalyzerFallbackTarget();
  const localModel = getResolvedOllamaModel();
  return {
    ...base,
    effective,
    analyzerEngine: {
      localModel,
      optionLabels: {
        off: 'Off',
        local: `Local Ollama — ${localModel}`,
        gemini: getResolvedGeminiApiKey() ? `Gemini — ${configValue<string>('analyzer.gemini.model')}` : 'Gemini — no API key, fallback inactive',
      },
      ...(base.source === 'default' && effective === 'off'
        ? { sourceNote: 'Off because the old Model Manager "Cloud fallback" switch was turned off. Pick a target here to replace it.' }
        : {}),
    },
  };
}
